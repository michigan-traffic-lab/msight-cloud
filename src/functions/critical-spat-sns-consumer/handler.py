"""Critical SPAT SNS consumer Lambda.

Subscribes to the SPaT SNS topic, decodes SPAT messages, applies an
is_critical() filter to suppress non-significant updates, looks up intersection
positions from the maps table, and broadcasts to WebSocket clients by invoking
radiusBroadcastLambda directly.

The is_critical() stub currently passes every message through. It will be
replaced with logic that checks for signal-phase changes or remaining-time
deltas > 1 s.
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
from msight_valkey_cache import ValkeyConfigCache

# ---- logging -------------------------------------------------------------
# SPaT arrives at roughly 10 Hz per sensor, so a log line per message dominated
# this account's CloudWatch bill (ingestion is billed per GB). Per-message
# detail is gated behind this flag; errors and conditions an operator would act
# on always print. Set DEBUG_LOGGING=true on the function to get the detail back
# for an investigation.
DEBUG_LOGGING = os.environ.get("DEBUG_LOGGING", "false").lower() == "true"

# Namespaces this function's Valkey keys. Set by the stack; defaulted so the
# module still imports under a test harness that sets no environment.
SERVICE_NAME  = os.environ.get("SERVICE_NAME", "critical-spat-sns-consumer")


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
    """Dial Aurora for one query. The caller closes it again immediately.

    Nothing is pooled here any more, and that is the point. A container used to
    keep this connection for its whole life; with configuration served from
    Valkey it now runs approximately zero queries, so the connection was open
    for minutes to carry nothing. Multiplied by the warm fleet that reached
    ~198 connections against a ceiling near 112 — which is what the RDS Proxy
    was paid $87 a month to absorb.

    Dialling per query costs a TLS handshake on a path that now runs about once
    per TTL for the entire fleet. The credentials are already cached in this
    module, so there is no Secrets Manager call behind it.

    Deliberately does NOT probe the connection first. The probe this replaces
    ran "SELECT 1" on every single call, which on a path that queried per
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


# ---- criticality filter --------------------------------------------------

_CRITICAL_SPAT_PREV_KEY_PREFIX = "msight:critical_spat:prev:"
_CRITICAL_SPAT_PREV_TTL_SECONDS = 300


# TimeMark in J2735 is in tenths of a second; 10 units = 1 second.
_TIMING_CHANGE_THRESHOLD_TENTHS = 10
# Only check timing shifts when the remaining phase time is within this window.
# Beyond this window only phase changes matter.
_TIMING_CHECK_WINDOW_TENTHS = 1200  # 2 minutes


def _remaining_tenths(intersection: dict, min_end_time: int) -> float | None:
    """Return remaining phase time in tenths of a second, or None if unavailable.

    moy is minute-of-year; timeStamp is milliseconds within the current minute.
    current time in tenths from the top of the hour:
        (moy % 60) * 600  +  timeStamp_ms / 100
    """
    moy = intersection.get("moy")
    timestamp_ms = intersection.get("timeStamp")
    if moy is None or timestamp_ms is None:
        return None
    current_tenths = (moy % 60) * 600 + timestamp_ms / 100
    return min_end_time - current_tenths


def _has_significant_change(cached: dict, incoming: dict) -> bool:
    """Return True if a phase change or > 1-second timing shift is detected.

    Timing shifts are only checked when the remaining phase time is within
    _TIMING_CHECK_WINDOW_TENTHS (30 s). Beyond that window, only phase
    changes are considered significant.
    """
    if not cached:
        return True

    cached_by_sg = {}
    for state in cached.get("states", []):
        sg = state.get("signalGroup")
        sts = state.get("state-time-speed") or []
        if sg is not None and sts:
            cached_by_sg[sg] = sts[0]

    for state in incoming.get("states", []):
        sg = state.get("signalGroup")
        sts = state.get("state-time-speed") or []
        if sg is None or not sts:
            continue
        incoming_sts = sts[0]

        cached_sts = cached_by_sg.get(sg)
        if cached_sts is None:
            _debug({"event": "new_signal_group", "signalGroup": sg})
            return True

        if cached_sts.get("eventState") != incoming_sts.get("eventState"):
            print(json.dumps({
                "event": "phase_change",
                "signalGroup": sg,
                "from": cached_sts.get("eventState"),
                "to": incoming_sts.get("eventState"),
            }))
            return True

        cached_min = (cached_sts.get("timing") or {}).get("minEndTime")
        incoming_min = (incoming_sts.get("timing") or {}).get("minEndTime")
        if cached_min is not None and incoming_min is not None:
            remaining = _remaining_tenths(incoming, incoming_min)
            within_window = (
                remaining is None  # can't compute — check anyway to be safe
                or 0 < remaining <= _TIMING_CHECK_WINDOW_TENTHS
            )
            if within_window:
                delta = incoming_min - cached_min
                if abs(delta) > _TIMING_CHANGE_THRESHOLD_TENTHS:
                    print(json.dumps({
                        "event": "timing_shift",
                        "signalGroup": sg,
                        "remaining_tenths": remaining,
                        "cached_minEndTime": cached_min,
                        "incoming_minEndTime": incoming_min,
                        "delta_tenths": delta,
                    }))
                    return True

    return False


def is_critical(sensor_name: str, intersection: dict) -> bool:
    """Return True if this intersection update should be forwarded to clients.

    Fetches the previous intersection state for this sensor+intersection from
    Redis, delegates to _has_significant_change(), and on a positive result
    writes the new state back to cache.
    """
    intersection_name = intersection.get("name", "unknown")
    cache_key = _CRITICAL_SPAT_PREV_KEY_PREFIX + sensor_name + ":" + intersection_name

    r = _get_redis()
    try:
        raw = r.get(cache_key)
        cached = json.loads(raw) if raw else {}
    except Exception as e:
        print(json.dumps({"event": "cache_read_error", "cache_key": cache_key, "error": str(e)}))
        cached = {}

    if not _has_significant_change(cached, intersection):
        return False

    try:
        r.set(cache_key, json.dumps(intersection), ex=_CRITICAL_SPAT_PREV_TTL_SECONDS)
    except Exception as e:
        print(json.dumps({"event": "cache_write_error", "cache_key": cache_key, "error": str(e)}))

    return True


# ---- database access -----------------------------------------------------
#
# Two lookups feed this path: which apps want critical SPaT, and where an intersection
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
# This consumer also asks for configuration LATER than it used to. is_critical()
# suppresses the large majority of messages, and the old code fetched the app
# list before running that filter, so it queried Aurora for messages it was
# about to throw away. Nothing here is called until at least one intersection
# has passed, which means most messages now reach the database not at all.
#
# On transactions: wrapping these reads in one would make them *more*
# expensive, not less. BEGIN and COMMIT are two extra round trips around a read
# that is already atomic as a single statement, which is why the connection
# stays in autocommit. Fewer round trips comes from putting both lookups in one
# statement, not from grouping several statements together.

CONFIG_TTL_S  = float(os.environ.get("CONFIG_CACHE_TTL_SECONDS", "60"))
CONFIG_JITTER = float(os.environ.get("CONFIG_CACHE_JITTER", "0.25"))

# The app list is one value, so it lives under a fixed key.
_APPS_KEY = "critical_spat_app_ids"

# Tier 1: this container's own memory. Microseconds, no network, and the
# reason the steady state costs nothing at all.
_apps_cache    = ConfigCache(ttl_s=CONFIG_TTL_S, jitter=CONFIG_JITTER)
_centers_cache = ConfigCache(ttl_s=CONFIG_TTL_S, jitter=CONFIG_JITTER)

# Tier 2: Valkey, shared by every container of this function.
#
# What tier 1 cannot do is help a container that has just started, and Lambda
# keeps enough of those coming that the fleet still reached Aurora once per TTL
# per container — each holding a connection open for its whole life to ask one
# question a minute. This turns that into roughly one question per TTL for the
# entire fleet, which is what makes the connection count small enough to drop
# the RDS Proxy in front of Aurora.
#
# Named after SERVICE_NAME so the two SPaT consumers cannot read each other's
# answers: they query the same two tables through different filters, and a
# shared key would quietly hand each the other's app list.
_shared_cache = ValkeyConfigCache(
    SERVICE_NAME,
    _get_redis,
    ttl_s=CONFIG_TTL_S,
    on_error=lambda operation, error: print(json.dumps({
        "event": "shared_cache_degraded",
        "operation": operation,
        "error": str(error),
    })),
)

#: Cache names. These become `MSight:<SERVICE_NAME>:<name>` in Valkey.
_APPS_CACHE    = "app_ids"
_CENTERS_CACHE = "map_centers"

# One statement, both results. The ::text[] cast is what makes an empty name
# list work: Postgres cannot infer the element type of an empty array literal.
_CONFIG_SQL = """
SELECT
  (SELECT coalesce(json_agg(app_id), '[]'::json)
     FROM apps
    WHERE receive_critical_spat = TRUE)                     AS app_ids,
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
            # A connection can be closed underneath us by a failover. Retrying
            # once here is what lets _get_db_conn() drop its liveness probe:
            # the old code ran "SELECT 1" before every query, doubling the
            # query count on the busiest path in the system to detect a rare
            # condition that the real query reports anyway.
            last_error = error
        finally:
            # Closed on the way out, whether the query worked or not.
            #
            # This is what makes the connection count independent of how many
            # containers are warm, and therefore what makes running without an
            # RDS Proxy safe: a container holds a connection for the length of
            # one query rather than for the length of its life. It also means a
            # Valkey outage — which sends every container back here — costs a
            # burst of brief connections instead of a permanent ~198 against a
            # ceiling near 112.
            _reset_db_conn()

    raise last_error if last_error else RuntimeError("config query failed")


def _load_config(intersection_names: list[str]) -> tuple[list, dict]:
    """Return (app_ids, {intersection_name: (lat, lon) | None}) for a message.

    Three tiers, cheapest first:

      1. This container's memory. Costs nothing and answers almost always.
      2. Valkey, shared by every container of this function. Costs one round
         trip on a local network and answers whenever any container has asked
         recently — which is what a freshly started container needs, and what
         the per-container tier can never provide.
      3. Aurora. One statement, and only for what neither tier above holds.

    The point of tier 2 is the connection count, not the latency. Every warm
    container used to reach Aurora once per TTL and hold a connection open for
    its whole life to do it; the fleet peaked near 200 connections against a
    ceiling of about 112 at the 0.5 ACU floor. With tier 2 in front, exactly one
    container per TTL goes to the database for the whole fleet.
    """
    apps_fresh, cached_app_ids = _apps_cache.fresh(_APPS_KEY)
    app_ids = list(cached_app_ids or []) if apps_fresh else []
    missing = _centers_cache.missing(intersection_names)

    if not apps_fresh or missing:
        # ---- tier 2: what the fleet already knows ------------------------
        #
        # A stale value is used rather than discarded, and only the container
        # that wins `claim_refresh` goes on to the database. Without that,
        # every container would miss in the same instant the shared key aged
        # out — the stampede a shared cache creates and a per-container one
        # cannot.
        must_query_apps = not apps_fresh
        if must_query_apps:
            state, shared_app_ids = _shared_cache.read_one(_APPS_CACHE)
            if state == "fresh":
                app_ids = list(shared_app_ids or [])
                _apps_cache.put(_APPS_KEY, app_ids)
                must_query_apps = False
            elif state == "stale":
                app_ids = list(shared_app_ids or [])
                _apps_cache.put(_APPS_KEY, app_ids)
                # Serve it now; reload only if this container is the one
                # elected to do so.
                must_query_apps = _shared_cache.claim_refresh(_APPS_CACHE)

        still_missing = missing
        if missing:
            fresh_centers, stale_centers, absent = _shared_cache.read_many(
                _CENTERS_CACHE, missing
            )
            for name, value in fresh_centers.items():
                _centers_cache.put(name, value)
            for name, value in stale_centers.items():
                _centers_cache.put(name, value)

            # Anything genuinely unknown must be queried. A stale centre is
            # worth refreshing too, but not at the cost of a query per
            # container — so it joins the statement only for the winner.
            still_missing = list(absent)
            if stale_centers and not still_missing:
                if _shared_cache.claim_refresh(_CENTERS_CACHE):
                    still_missing = list(stale_centers.keys())
            elif stale_centers:
                still_missing.extend(stale_centers.keys())

        # ---- tier 3: the database ----------------------------------------
        if must_query_apps or still_missing:
            try:
                row = _run_config_query(still_missing)

                # The app list rides along on every query whether or not it was
                # the reason for one. It is free — same statement, same round
                # trip, a one-row table — and refreshing it here means a
                # container busy enough to keep meeting new intersections
                # almost never has to go to the database for the app list on
                # its own account.
                app_ids = list(row[0] or [])
                _apps_cache.put(_APPS_KEY, app_ids)
                _shared_cache.write_one(_APPS_CACHE, app_ids)

                found = {
                    entry["name"]: (entry["lat"], entry["lon"])
                    for entry in (row[1] or [])
                }
                # Misses are cached as None too. An unknown intersection name
                # arrives on every message from that sensor, and querying for a
                # row that does not exist costs exactly as much as one that
                # does.
                resolved = {name: found.get(name) for name in still_missing}
                _centers_cache.put_many(resolved)
                _shared_cache.write_many(_CENTERS_CACHE, resolved)

            except Exception as error:
                print(json.dumps({
                    "event": "config_query_failed",
                    "error": str(error),
                    "missing_centers": still_missing,
                    "had_fresh_app_ids": apps_fresh,
                }))
                # Let the next container try immediately rather than waiting
                # out the claim: a failed reload should not also freeze the
                # value for everybody else.
                _shared_cache.release_refresh(_APPS_CACHE)
                _shared_cache.release_refresh(_CENTERS_CACHE)

                if not app_ids:
                    # Prefer briefly stale configuration over dropping live
                    # SPaT. ConfigCache bounds how long that can go on; once
                    # the grace is spent there is nothing to serve and the
                    # message is skipped.
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

        # Apply the criticality filter BEFORE touching Aurora. Most messages are
        # suppressed here, and the configuration they would have needed is
        # configuration nobody was going to use.
        critical_intersections = []
        for intersection in intersections:
            intersection_name = intersection.get("name")
            if not intersection_name:
                print(json.dumps({"event": "intersection_no_name", "sensor_name": sensor_name}))
                continue

            if not is_critical(sensor_name, intersection):
                _debug({"event": "not_critical", "sensor_name": sensor_name, "intersection_name": intersection_name})
                continue

            critical_intersections.append(intersection)

        if not critical_intersections:
            continue

        # One call covers the app list and every intersection centre that
        # survived the filter: no round trips on a warm cache, one otherwise.
        try:
            app_ids, centers = _load_config(
                [i["name"] for i in critical_intersections]
            )
            _debug({"event": "spat_app_ids", "sensor_name": sensor_name, "app_ids": app_ids, "count": len(app_ids)})
        except Exception as e:
            print(json.dumps({"event": "db_query_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        if not app_ids:
            print(json.dumps({"event": "no_app_ids", "sensor_name": sensor_name}))
            continue

        for intersection in critical_intersections:
            intersection_name = intersection["name"]

            pos = centers.get(intersection_name)
            if pos is None:
                print(json.dumps({"event": "map_not_found", "intersection_name": intersection_name}))
                continue

            lat, lon = pos

            ws_message = {
                "type":               "critical_spat",
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
