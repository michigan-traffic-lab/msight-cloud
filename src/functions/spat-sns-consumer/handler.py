"""SPAT SNS consumer Lambda.

Subscribes to the SPaT SNS topic, decodes SPAT messages, rate-limits to 2 Hz
per sensor (500 ms minimum gap between processed messages), looks up intersection
positions from the maps table, and broadcasts to WebSocket clients by invoking radiusBroadcastLambda directly.
"""

from __future__ import annotations

import base64
import json
import os
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


# ---- database helpers ----------------------------------------------------

def _get_spat_app_ids() -> list:
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT app_id FROM apps WHERE receive_spat = TRUE")
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


# ---- broadcast -----------------------------------------------------------


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

        # Rate limit: pass at most 2 Hz per sensor
        try:
            passed = _should_pass(sensor_name, capture_ts)
            print(json.dumps({"event": "rate_check", "sensor_name": sensor_name, "capture_ts": capture_ts, "passed": passed}))
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

        for intersection in intersections:
            intersection_name = intersection.get("name")
            if not intersection_name:
                print(json.dumps({"event": "intersection_no_name", "sensor_name": sensor_name}))
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
                "type":               "spat",
                "sensor_name":        sensor_name,
                "device_name":        msg.get("device_name"),
                "capture_timestamp":  capture_ts,
                "creation_timestamp": msg.get("creation_timestamp"),
                "intersection_name":  intersection_name,
                "spat":               intersection,
            }

            for app_id in app_ids:
                try:
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
                    r = json.loads(raw)
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
