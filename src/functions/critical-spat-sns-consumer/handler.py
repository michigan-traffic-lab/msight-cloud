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


def _get_db_conn():
    global _db_conn
    if _db_conn and not _db_conn.closed:
        try:
            _db_conn.cursor().execute("SELECT 1")
            return _db_conn
        except Exception:
            pass
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
            print(json.dumps({"event": "new_signal_group", "signalGroup": sg}))
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


# ---- database helpers ----------------------------------------------------

def _get_spat_app_ids() -> list:
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT app_id FROM apps WHERE receive_critical_spat = TRUE")
        return [row[0] for row in cur.fetchall()]


def _get_intersection_center(name: str):
    """Return (lat, lon) for the named map, or None if not found."""
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ST_Y(center::geometry), ST_X(center::geometry) FROM maps WHERE name = %s",
            (name,),
        )
        row = cur.fetchone()
        return (row[0], row[1]) if row else None


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
    print(json.dumps({"event": "handler_start", "record_count": len(records)}))

    for record in records:
        sns_record  = record.get("Sns", {})
        raw_message = sns_record.get("Message", "")
        message_id  = sns_record.get("MessageId", "unknown")

        print(json.dumps({"event": "sns_record", "message_id": message_id, "raw_preview": raw_message[:200]}))

        try:
            msg = json.loads(raw_message)
        except Exception:
            print(json.dumps({"event": "parse_error", "message_id": message_id}))
            continue

        sensor_name    = msg.get("sensor_name", "unknown")
        capture_ts_raw = msg.get("capture_timestamp")

        print(json.dumps({
            "event": "message_fields",
            "message_id": message_id,
            "sensor_name": sensor_name,
            "capture_timestamp": capture_ts_raw,
            "device_name": msg.get("device_name"),
            "has_data": bool(msg.get("data")),
        }))

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

        print(json.dumps({"event": "wsmp_decoded", "sensor_name": sensor_name, "hex_preview": hex_payload[:80]}))

        try:
            decoded = spat_decoder(hex_payload)
        except Exception as e:
            print(json.dumps({"event": "spat_decode_error", "sensor_name": sensor_name, "error": str(e), "hex_preview": hex_payload[:80]}))
            continue

        intersections = decoded.get("intersections", [])
        print(json.dumps({
            "event": "spat_decoded",
            "sensor_name": sensor_name,
            "capture_ts": capture_ts,
            "intersection_count": len(intersections),
        }))

        if not intersections:
            print(json.dumps({"event": "no_intersections", "sensor_name": sensor_name}))
            continue

        if not RADIUS_BROADCAST_LAMBDA_NAME:
            print(json.dumps({"event": "broadcast_lambda_not_configured", "sensor_name": sensor_name}))
            continue

        try:
            app_ids = _get_spat_app_ids()
            print(json.dumps({"event": "spat_app_ids", "sensor_name": sensor_name, "app_ids": app_ids, "count": len(app_ids)}))
        except Exception as e:
            print(json.dumps({"event": "db_query_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        if not app_ids:
            print(json.dumps({"event": "no_app_ids", "sensor_name": sensor_name}))
            continue

        for intersection in intersections:
            intersection_name = intersection.get("name")
            if not intersection_name:
                print(json.dumps({"event": "intersection_no_name", "sensor_name": sensor_name}))
                continue

            if not is_critical(sensor_name, intersection):
                print(json.dumps({"event": "not_critical", "sensor_name": sensor_name, "intersection_name": intersection_name}))
                continue

            try:
                pos = _get_intersection_center(intersection_name)
            except Exception as e:
                print(json.dumps({"event": "map_lookup_error", "intersection_name": intersection_name, "error": str(e)}))
                continue

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
                        print(json.dumps({
                            "event": "broadcast_done",
                            "app_id": app_id,
                            "intersection_name": intersection_name,
                            "delivered_count": r.get("delivered_count"),
                            "nearby_client_count": r.get("nearby_client_count"),
                        }))
                    except Exception as e:
                        print(json.dumps({"event": "broadcast_error", "app_id": app_id, "error": str(e)}))

    print(json.dumps({"event": "handler_done", "record_count": len(records)}))
