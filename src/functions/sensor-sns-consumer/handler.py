import base64
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import psycopg2
import redis

from pyv2xlib.SDSMDecoder import sdsm_decoder

# ---- configuration -------------------------------------------------------
RADIUS_BROADCAST_LAMBDA_NAME = os.environ.get("RADIUS_BROADCAST_LAMBDA_NAME", "")
SDSM_BROADCAST_RADIUS_M      = 100

DB_HOST       = os.environ.get("DB_HOST", "")
DB_PORT       = int(os.environ.get("DB_PORT", "5432"))
DB_NAME       = os.environ.get("DB_NAME", "msight")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")

CACHE_HOST        = os.environ.get("CACHE_HOST", "")
CACHE_PORT        = int(os.environ.get("CACHE_PORT", "6379"))
CACHE_TLS_ENABLED = os.environ.get("CACHE_TLS_ENABLED", "false").lower() == "true"
AWS_REGION        = os.environ.get("AWS_REGION", "us-east-2")

# Valkey key: stores the latest capture_timestamp seen per sensor_name.
# TTL of 5 minutes 鈥?after a sensor goes silent the key expires automatically.
_SENSOR_TS_KEY_PREFIX  = "msight:sensor:last_capture_ts:"
_SENSOR_TS_TTL_SECONDS = 300

# ---- module-level singletons (reused across warm invocations) ------------
_db_conn      = None
_secret_cache = None
_redis_client = None
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


def _get_sdsm_app_ids() -> list:
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT app_id FROM apps WHERE receive_sdsm = TRUE")
        return [row[0] for row in cur.fetchall()]


def _is_stale(sensor_name: str, capture_ts: float) -> bool:
    """
    Returns True if capture_ts is not newer than the last seen timestamp.
    Uses a Lua script for atomic get-and-set-if-newer in Valkey.
    """
    r   = _get_redis()
    key = _SENSOR_TS_KEY_PREFIX + sensor_name
    lua = """
local prev = redis.call('GET', KEYS[1])
if prev and tonumber(prev) >= tonumber(ARGV[1]) then
    return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
"""
    result = r.eval(lua, 1, key, capture_ts, _SENSOR_TS_TTL_SECONDS)
    return result == 0  # 0 = stale/duplicate


# ---- helpers --------------------------------------------------------------

def _parse_dsrc_envelope(data_b64: str) -> dict:
    raw    = base64.b64decode(data_b64).decode("utf-8")
    result = {}
    for line in raw.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip()
    return result


def _broadcast_one(app_id: str, ws_message: dict, ref_pos: dict) -> dict:
    """Invoke radiusBroadcastLambda directly via the Lambda VPC endpoint."""
    payload_body = json.dumps({
        "app_id":   app_id,
        "origin":   {"lat": ref_pos["lat"], "lon": ref_pos["long"]},
        "radius_m": SDSM_BROADCAST_RADIUS_M,
        "message":  ws_message,
    })
    # Construct a minimal API Gateway v2 event that radiusBroadcastLambda expects.
    apigw_event = {
        "version": "2.0",
        "rawPath": "/v1/clients/notify/radius",
        "body": payload_body,
        "requestContext": {
            "http": {"method": "POST", "path": "/v1/clients/notify/radius"},
        },
    }
    print(json.dumps({
        "event": "broadcast_invoke",
        "app_id": app_id,
        "lat": ref_pos["lat"],
        "lon": ref_pos["long"],
        "radius_m": SDSM_BROADCAST_RADIUS_M,
        "sensor_name": ws_message.get("sensor_name"),
        "capture_timestamp": ws_message.get("capture_timestamp"),
    }))
    resp = _get_lambda_client().invoke(
        FunctionName=RADIUS_BROADCAST_LAMBDA_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps(apigw_event).encode("utf-8"),
    )
    raw_payload = resp["Payload"].read().decode("utf-8")

    if resp.get("FunctionError"):
        raise RuntimeError(f"radiusBroadcastLambda function error: {raw_payload}")

    result = json.loads(raw_payload)
    status_code = result.get("statusCode", 0)
    body = json.loads(result.get("body", "{}"))

    print(json.dumps({
        "event": "broadcast_result",
        "app_id": app_id,
        "http_status": status_code,
        "delivered_count": body.get("delivered_count"),
        "failed_count": body.get("failed_count"),
        "nearby_client_count": body.get("nearby_client_count"),
        "websocket_candidate_count": body.get("websocket_candidate_count"),
        "body": body,
    }))

    if status_code != 200:
        raise RuntimeError(
            f"radiusBroadcastLambda returned HTTP {status_code}: {body.get('error')} — {body.get('message')}"
        )

    return {"app_id": app_id, **body}


def _broadcast_all(app_ids: list, ws_message: dict, ref_pos: dict) -> None:
    if not app_ids:
        print(json.dumps({"event": "broadcast_skip", "reason": "no apps with receive_sdsm=true"}))
        return
    print(json.dumps({"event": "broadcast_all_start", "app_ids": app_ids, "app_count": len(app_ids)}))
    with ThreadPoolExecutor(max_workers=len(app_ids)) as executor:
        futures = {
            executor.submit(_broadcast_one, aid, ws_message, ref_pos): aid
            for aid in app_ids
        }
        for future in as_completed(futures):
            app_id = futures[future]
            try:
                r = future.result()
                print(json.dumps({
                    "event": "broadcast_app_done",
                    "app_id": app_id,
                    "delivered_count": r.get("delivered_count"),
                    "nearby_client_count": r.get("nearby_client_count"),
                }))
            except Exception as e:
                print(json.dumps({"event": "broadcast_app_error", "app_id": app_id, "error": str(e)}))


# ---- Lambda entry point ---------------------------------------------------

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
            print(json.dumps({"event": "parse_error", "message_id": message_id, "raw": raw_message[:200]}))
            continue

        sensor_name    = msg.get("sensor_name", "unknown")
        capture_ts_raw = msg.get("capture_timestamp")

        print(json.dumps({
            "event": "message_fields",
            "message_id": message_id,
            "sensor_name": sensor_name,
            "capture_timestamp": capture_ts_raw,
            "device_name": msg.get("device_name"),
            "frame_id": msg.get("frame_id"),
            "has_data": bool(msg.get("data")),
            "keys": list(msg.keys()),
        }))

        try:
            capture_ts = float(capture_ts_raw)
        except (TypeError, ValueError):
            print(json.dumps({"event": "invalid_timestamp", "sensor_name": sensor_name, "capture_timestamp": str(capture_ts_raw)}))
            continue

        # Ordering guard: drop messages that arrive out-of-order via SNS
        try:
            stale = _is_stale(sensor_name, capture_ts)
            print(json.dumps({"event": "stale_check", "sensor_name": sensor_name, "capture_ts": capture_ts, "is_stale": stale}))
            if stale:
                continue
        except Exception as e:
            print(json.dumps({"event": "stale_check_error", "sensor_name": sensor_name, "error": str(e)}))

        data_b64 = msg.get("data")
        if not data_b64:
            print(json.dumps({"event": "missing_data", "sensor_name": sensor_name}))
            continue

        try:
            envelope = _parse_dsrc_envelope(data_b64)
        except Exception as e:
            print(json.dumps({"event": "envelope_decode_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        msg_type    = envelope.get("Type", "")
        hex_payload = envelope.get("Payload", "")

        print(json.dumps({"event": "envelope_parsed", "sensor_name": sensor_name, "msg_type": msg_type, "has_payload": bool(hex_payload), "envelope_keys": list(envelope.keys())}))

        if msg_type != "SDSM" or not hex_payload:
            print(json.dumps({"event": "unsupported_type", "sensor_name": sensor_name, "msg_type": msg_type}))
            continue

        try:
            decoded = sdsm_decoder(hex_payload)
        except Exception as e:
            print(json.dumps({"event": "sdsm_decode_error", "sensor_name": sensor_name, "error": str(e), "hex_preview": hex_payload[:80]}))
            continue

        ref_pos = decoded.get("refPos")
        print(json.dumps({
            "event": "sdsm_decoded",
            "sensor_name": sensor_name,
            "capture_ts": capture_ts,
            "object_count": len(decoded.get("objects", [])),
            "ref_pos": ref_pos,
        }))

        if not ref_pos:
            print(json.dumps({"event": "missing_ref_pos", "sensor_name": sensor_name}))
            continue

        if not RADIUS_BROADCAST_LAMBDA_NAME:
            print(json.dumps({"event": "broadcast_lambda_not_configured", "sensor_name": sensor_name}))
            continue

        ws_message = {
            "type":               "sdsm",
            "sensor_name":        sensor_name,
            "device_name":        msg.get("device_name"),
            "capture_timestamp":  capture_ts,
            "creation_timestamp": msg.get("creation_timestamp"),
            "frame_id":           msg.get("frame_id"),
            "sdsm":               decoded,
        }

        try:
            app_ids = _get_sdsm_app_ids()
            print(json.dumps({"event": "sdsm_app_ids", "sensor_name": sensor_name, "app_ids": app_ids, "count": len(app_ids)}))
        except Exception as e:
            print(json.dumps({"event": "db_query_error", "sensor_name": sensor_name, "error": str(e)}))
            continue

        _broadcast_all(app_ids, ws_message, ref_pos)

    print(json.dumps({"event": "handler_done", "record_count": len(records)}))
    return {"statusCode": 200}
