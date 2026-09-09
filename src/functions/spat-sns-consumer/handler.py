"""SPAT SNS consumer Lambda.

Subscribes to the SPaT SNS topic, decodes SPAT messages, rate-limits to 2 Hz
per sensor (500 ms minimum gap between processed messages), looks up intersection
positions from the maps table, and broadcasts to WebSocket clients by invoking radiusBroadcastLambda directly.
"""

from __future__ import annotations

import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import psycopg2
import redis
from pyv2xlib.SPATDecoder import spat_decoder

from msight_config_cache import ConfigCache

# ---- logging -------------------------------------------------------------
# SPaT arrives at roughly 10 Hz per sensor, so a log line per message dominated
# this account's CloudWatch bill (ingestion is billed per GB). Per-message
# detail is gated behind this flag; errors and conditions an operator would act
# on always print. Set DEBUG_LOGGING=true on the function to get the detail back
# for an investigation.
DEBUG_LOGGING = os.environ.get("DEBUG_LOGGING", "false").lower() == "true"


def _debug(payload: dict) -> None:
    """Per-message detail. Silent unless DEBUG_LOGGING is on."""
    if DEBUG_LOGGING:
        print(json.dumps(payload))


# ---- configuration -------------------------------------------------------
RADIUS_BROADCAST_LAMBDA_NAME = os.environ.get("RADIUS_BROADCAST_LAMBDA_NAME", "")
SPAT_BROADCAST_RADIUS_M      = int(os.environ.get("SPAT_BROADCAST_RADIUS_M", "500"))

DB_HOST       = os.environ.get("DB_HOST", "")
DB_PORT       = int(os.environ.get("DB_PORT", "5432"))
DB_NAME       = os.environ.get("DB_NAME", "msight")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")

CACHE_HOST        = os.environ.get("CACHE_HOST", "")
CACHE_PORT        = int(os.environ.get("CACHE_PORT", "6379"))
CACHE_TLS_ENABLED = os.environ.get("CACHE_TLS_ENABLED", "false").lower() == "true"
AWS_REGION        = os.environ.get("AWS_REGION", "us-east-2")

# Rate limiter: pass at most 2 messages per second per sensor (500 ms gap).
_SPAT_TS_KEY_PREFIX  = "msight:spat:last_ts:"
_SPAT_TS_TTL_SECONDS = 300
_SPAT_MIN_INTERVAL_S = 0.5

# ---- module-level singletons (reused across warm invocations) ------------
_db_conn       = None
_secret_cache  = None
_redis_client  = None
_lambda_client = None


def _get_lambda_client():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda", region_name=AWS_REGION)
    return _lambda_client


def _load_db_credentials():
    global _secret_cache
    if _secret_cache:
        return _secret_cache["username"], _secret_cache["password"]
    sm     = boto3.client("secretsmanager", region_name=AWS_REGION)
    result = sm.get_secret_value(SecretId=DB_SECRET_ARN)
    _secret_cache = json.loads(result["SecretString"])
    return _secret_cache["username"], _secret_cache["password"]


def _reset_db_conn() -> None:
    """Drop the cached connection so the next call dials a new one."""
    global _db_conn
    if _db_conn is not None:
        try:
            _db_conn.close()
        except Exception:
            pass
        _db_conn = None


def _get_db_conn():
    """Return the container's connection, dialling one if it has none.

    Deliberately does NOT probe the connection first. The probe this replaces
    ran "SELECT 1" on every single call, which on a path that queries per
    message meant half of all queries reaching Aurora existed only to ask
    whether the connection still worked. Callers retry through
    _run_config_query() instead, so a dead connection costs one failed query
    rather than a permanent doubling of the query rate.
    """
    global _db_conn
    if _db_conn is not None and not _db_conn.closed:
        return _db_conn
    username, password = _load_db_credentials()
    _db_conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=username, password=password,
        sslmode="require", connect_timeout=5,
    )
    _db_conn.autocommit = True
    return _db_conn


def _get_redis():
    global _redis_client
    if _redis_client:
        try:
            _redis_client.ping()
            return _redis_client
        except Exception:
            pass
    _redis_client = redis.Redis(
        host=CACHE_HOST, port=CACHE_PORT,
        ssl=CACHE_TLS_ENABLED,
        ssl_cert_reqs='none' if CACHE_TLS_ENABLED else None,
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
    )
    return _redis_client


# ---- rate limiter --------------------------------------------------------

def _should_pass(sensor_name: str, capture_ts: float) -> bool:
    """Return True if at least 500 ms has elapsed since the last passed message."""
    r   = _get_redis()
    key = _SPAT_TS_KEY_PREFIX + sensor_name
    lua = """
local prev = redis.call('GET', KEYS[1])
if prev and (tonumber(ARGV[1]) - tonumber(prev)) < tonumber(ARGV[2]) then
    return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
"""
    return r.eval(lua, 1, key, capture_ts, _SPAT_MIN_INTERVAL_S, _SPAT_TS_TTL_SECONDS) == 1


# ---- database access -----------------------------------------------------
#
# Two lookups feed this path: which apps want SPaT, and where an intersection
# is. Both are configuration — they change when someone edits a row, which is
# to say almost never — and both were being queried on EVERY message. SPaT
# arrives at roughly 10 Hz per sensor and Lambda runs many containers at once,
# so that was tens of queries a second, each on a connection of its own:
# Aurora sat at ~118 connections, average query latency above one second, and
# capacity pinned near its 2 ACU ceiling. Aurora Serverless bills per ACU-hour,
# so the query volume was the bill. With the SPaT feed switched off the same
# cluster idles at its 0.5 ACU floor, which is the size of the prize.
#
# Two changes bring the round trips down, and they are independent:
#
#   1. Cache both lookups per container, with a refresh point drawn at random
#      per entry so containers do not all return to the database in the same
#      instant. msight_config_cache explains why that randomisation matters
#      more than it looks like it should.
#
#   2. When the cache does need filling, fill all of it in ONE statement. A
#      message naming three intersections used to cost four queries (one for
#      the app list, one per intersection) plus a "SELECT 1" liveness probe
#      before each — nine round trips. It now costs one.
#
# On transactions: wrapping these reads in one would make them *more*
# expensive, not less. BEGIN and COMMIT are two extra round trips around a read
# that is already atomic as a single statement, which is why the connection
# stays in autocommit. Fewer round trips comes from putting both lookups in one
# statement, not from grouping several statements together.

CONFIG_TTL_S  = float(os.environ.get("CONFIG_CACHE_TTL_SECONDS", "60"))
CONFIG_JITTER = float(os.environ.get("CONFIG_CACHE_JITTER", "0.25"))

# The app list is one value, so it lives under a fixed key.
_APPS_KEY = "spat_app_ids"

_apps_cache    = ConfigCache(ttl_s=CONFIG_TTL_S, jitter=CONFIG_JITTER)
_centers_cache = ConfigCache(ttl_s=CONFIG_TTL_S, jitter=CONFIG_JITTER)

# One statement, both results. The ::text[] cast is what makes an empty name
# list work: Postgres cannot infer the element type of an empty array literal.
_CONFIG_SQL = """
SELECT
  (SELECT coalesce(json_agg(app_id), '[]'::json)
     FROM apps
    WHERE receive_spat = TRUE)                              AS app_ids,
  (SELECT coalesce(json_agg(json_build_object(
                     'name', name,
                     'lat',  ST_Y(center::geometry),
                     'lon',  ST_X(center::geometry))), '[]'::json)
     FROM maps
    WHERE name = ANY(%(names)s::text[]))                    AS centers
"""


def _run_config_query(names: list[str]) -> tuple:
    """Fetch the app list and the named centres in a single round trip."""
    last_error: Exception | None = None

    for _attempt in (1, 2):
        conn = _get_db_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(_CONFIG_SQL, {"names": names})
                return cur.fetchone()
        except psycopg2.Error as error:
            # A pooled connection can be closed underneath us by the RDS Proxy
            # or by a failover. Reconnecting and retrying once here is what
            # lets _get_db_conn() drop its liveness probe: the old code ran
            # "SELECT 1" before every query, doubling the query count on the
            # busiest path in the system to detect a rare condition that the
            # real query reports anyway.
            last_error = error
            _reset_db_conn()

    raise last_error if last_error else RuntimeError("config query failed")


def _load_config(intersection_names: list[str]) -> tuple[list, dict]:
    """Return (app_ids, {intersection_name: (lat, lon) | None}) for a message.

    Costs no round trips while the cache is warm and exactly one when anything
    in it has reached its refresh point.
    """
    apps_fresh, cached_app_ids = _apps_cache.fresh(_APPS_KEY)
    app_ids = list(cached_app_ids or []) if apps_fresh else []
    missing = _centers_cache.missing(intersection_names)

    if not apps_fresh or missing:
        try:
            row = _run_config_query(missing)

            # The app list rides along on every query whether or not it was the
            # reason for one. It is free — same statement, same round trip, a
            # one-row table — and refreshing it here means a container busy
            # enough to keep meeting new intersections almost never has to go
            # to the database for the app list on its own account.
            app_ids = list(row[0] or [])
            _apps_cache.put(_APPS_KEY, app_ids)

            found = {
                entry["name"]: (entry["lat"], entry["lon"])
                for entry in (row[1] or [])
            }
            # Misses are cached as None too. An unknown intersection name
            # arrives on every message from that sensor, and querying for a row
            # that does not exist costs exactly as much as one that does.
            _centers_cache.put_many({name: found.get(name) for name in missing})

        except Exception as error:
            print(json.dumps({
                "event": "config_query_failed",
                "error": str(error),
                "missing_centers": missing,
                "had_fresh_app_ids": apps_fresh,
            }))
            if not apps_fresh:
                # Prefer briefly stale configuration over dropping live SPaT.
                # ConfigCache bounds how long that can go on; once the grace is
                # spent there is nothing to serve and the message is skipped.
                stale_ok, stale_app_ids = _apps_cache.stale(_APPS_KEY)
                if not stale_ok:
                    raise
                app_ids = list(stale_app_ids or [])

    centers: dict = {}
    for name in intersection_names:
        ok, value = _centers_cache.fresh(name)
        if not ok:
            ok, value = _centers_cache.stale(name)
        centers[name] = value if ok else None

    return app_ids, centers


# ---- WSMP / UPER extraction ---------------------------------------------

_WSMP_PREFIX_LEN = 6


def _uper_hex_from_wsmp(data_b64: str) -> str:
    """Strip the WSMP header and return the J2735 UPER payload as a hex string."""
    raw = base64.b64decode(data_b64)
    idx = _WSMP_PREFIX_LEN
    first = raw[idx]
    uper_start = idx + 1 if first < 0x80 else idx + 1 + (first & 0x7F)
    return raw[uper_start:].hex()


# ---- broadcast -----------------------------------------------------------


# ---- Lambda entry point --------------------------------------------------

def handler(event, context):
    records = event.get("Records", [])
    _debug({"event": "handler_start", "record_count": len(records)})

    for record in records:
        sns_record  = record.get("Sns", {})
        raw_message = sns_record.get("Message", "")
        message_id  = sns_record.get("MessageId", "unknown")

        _debug({"event": "sns_record", "message_id": message_id, "raw_preview": raw_message[:200]})

        try:
            msg = json.loads(raw_message)
        except Exception:
            print(json.dumps({"event": "parse_error", "message_id": message_id}))
            continue

        sensor_name    = msg.get("sensor_name", "unknown")
        capture_ts_raw = msg.get("capture_timestamp")

        _debug({
            "event": "message_fields",
            "message_id": message_id,
            "sensor_name": sensor_name,
            "capture_timestamp": capture_ts_raw,
            "device_name": msg.get("device_name"),
            "has_data": bool(msg.get("data")),
        })

        try:
            capture_ts = float(capture_ts_raw)
        except (TypeError, ValueError):
            print(json.dumps({"event": "invalid_timestamp", "sensor_name": sensor_name, "capture_timestamp": str(capture_ts_raw)}))
            continue

        # Rate limit: pass at most 2 Hz per sensor
        try:
            passed = _should_pass(sensor_name, capture_ts)
            _debug({"event": "rate_check", "sensor_name": sensor_name, "capture_ts": capture_ts, "passed": passed})
            if not passed:
                continue
        except Exception as e:
            print(json.dumps({"event": "rate_check_error", "sensor_name": sensor_name, "error": str(e)}))

        data_b64 = msg.get("data")
        if not data_b64:
            print(json.dumps({"event": "missing_data", "sensor_name": sensor_name}))
            continue

        try:
            hex_payload = _uper_hex_from_wsmp(data_b64)
        except Exception as e:
            print(json.dumps({"event": "wsmp_decode_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        _debug({"event": "wsmp_decoded", "sensor_name": sensor_name, "hex_preview": hex_payload[:80]})

        try:
            decoded = spat_decoder(hex_payload)
        except Exception as e:
            print(json.dumps({"event": "spat_decode_error", "sensor_name": sensor_name, "error": str(e), "hex_preview": hex_payload[:80]}))
            continue

        intersections = decoded.get("intersections", [])
        _debug({
            "event": "spat_decoded",
            "sensor_name": sensor_name,
            "capture_ts": capture_ts,
            "intersection_count": len(intersections),
        })

        if not intersections:
            print(json.dumps({"event": "no_intersections", "sensor_name": sensor_name}))
            continue

        if not RADIUS_BROADCAST_LAMBDA_NAME:
            print(json.dumps({"event": "broadcast_lambda_not_configured", "sensor_name": sensor_name}))
            continue

        named_intersections = []
        for intersection in intersections:
            if intersection.get("name"):
                named_intersections.append(intersection)
            else:
                print(json.dumps({"event": "intersection_no_name", "sensor_name": sensor_name}))

        if not named_intersections:
            continue

        # One call covers the app list and every intersection centre this
        # message needs: no round trips on a warm cache, one otherwise.
        try:
            app_ids, centers = _load_config(
                [i["name"] for i in named_intersections]
            )
            _debug({"event": "spat_app_ids", "sensor_name": sensor_name, "app_ids": app_ids, "count": len(app_ids)})
        except Exception as e:
            print(json.dumps({"event": "db_query_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        if not app_ids:
            print(json.dumps({"event": "no_app_ids", "sensor_name": sensor_name}))
            continue

        for intersection in named_intersections:
            intersection_name = intersection["name"]

            pos = centers.get(intersection_name)
            if pos is None:
                print(json.dumps({"event": "map_not_found", "intersection_name": intersection_name}))
                continue

            lat, lon = pos

            ws_message = {
                "type":               "spat",
                "sensor_name":        sensor_name,
                "device_name":        msg.get("device_name"),
                "capture_timestamp":  capture_ts,
                "creation_timestamp": msg.get("creation_timestamp"),
                "intersection_name":  intersection_name,
                "spat":               intersection,
            }

            def _invoke(app_id):
                    payload = {
                        "app_id":   app_id,
                        "origin":   {"lat": lat, "lon": lon},
                        "radius_m": SPAT_BROADCAST_RADIUS_M,
                        "message":  ws_message,
                    }
                    resp = _get_lambda_client().invoke(
                        FunctionName=RADIUS_BROADCAST_LAMBDA_NAME,
                        InvocationType="RequestResponse",
                        Payload=json.dumps(payload).encode("utf-8"),
                    )
                    raw = resp["Payload"].read().decode("utf-8")
                    if resp.get("FunctionError"):
                        raise RuntimeError(raw)
                    return json.loads(raw)

            with ThreadPoolExecutor(max_workers=len(app_ids)) as executor:
                futures = {executor.submit(_invoke, aid): aid for aid in app_ids}
                for future in as_completed(futures):
                    app_id = futures[future]
                    try:
                        r = future.result()
                        _debug({
                            "event": "broadcast_done",
                            "app_id": app_id,
                            "intersection_name": intersection_name,
                            "delivered_count": r.get("delivered_count"),
                            "nearby_client_count": r.get("nearby_client_count"),
                        })
                    except Exception as e:
                        print(json.dumps({"event": "broadcast_error", "app_id": app_id, "error": str(e)}))

    _debug({"event": "handler_done", "record_count": len(records)})
