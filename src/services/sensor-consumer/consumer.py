"""
consumer.py — long-running SQS FIFO consumer for one sensor stream.

Each ECS Fargate task is dedicated to a single sensor (SENSOR_NAME env var)
and polls its own SQS queue. This gives:
  - Persistent warm connections to Valkey, Aurora (no cold starts)
  - In-memory caching of app_ids (avoids DB hit on every message)
  - Ordered processing guaranteed by SQS FIFO within the sensor's group
"""

import base64
import json
import os
import signal
import time
from datetime import datetime, timezone, timedelta

import boto3
import psycopg2
import redis

from pyv2xlib.SDSMDecoder import sdsm_decoder
from radius_broadcaster import WsClient, get_nearby_clients, broadcast_to_clients

# ---- configuration -------------------------------------------------------
SENSOR_NAME = os.environ['SENSOR_NAME']
QUEUE_URL   = os.environ['QUEUE_URL']

SDSM_BROADCAST_RADIUS_M = 100

DB_HOST       = os.environ.get('DB_HOST', '')
DB_PORT       = int(os.environ.get('DB_PORT', '5432'))
DB_NAME       = os.environ.get('DB_NAME', 'msight')
DB_SECRET_ARN = os.environ.get('DB_SECRET_ARN', '')

CACHE_HOST        = os.environ.get('CACHE_HOST', '')
CACHE_PORT        = int(os.environ.get('CACHE_PORT', '6379'))
CACHE_TLS_ENABLED = os.environ.get('CACHE_TLS_ENABLED', 'false').lower() == 'true'
AWS_REGION        = os.environ.get('AWS_REGION', 'us-east-1')

# App IDs in-memory cache — avoids a DB round-trip on every message.
_APP_IDS_CACHE_TTL = 30  # seconds

# ---- graceful shutdown ---------------------------------------------------
_shutdown = False

def _handle_signal(signum, frame):
    global _shutdown
    print(json.dumps({'event': 'shutdown_signal', 'sensor_name': SENSOR_NAME}))
    _shutdown = True

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)

# ---- module-level singletons ---------------------------------------------
_sqs_client   = None
_db_conn      = None
_secret_cache = None
_redis_client = None
_app_ids_cache: list | None = None
_app_ids_cache_ts: float = 0.0

# ---- pending merge buffer ------------------------------------------------
_pending_sdsm_ts: float | None = None
_pending_decoded: dict | None = None
_pending_msg: dict | None = None
_pending_capture_ts: float | None = None


def _get_sqs():
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = boto3.client('sqs', region_name=AWS_REGION)
    return _sqs_client


def _load_db_credentials():
    global _secret_cache
    if _secret_cache:
        return _secret_cache['username'], _secret_cache['password']
    sm = boto3.client('secretsmanager', region_name=AWS_REGION)
    result = sm.get_secret_value(SecretId=DB_SECRET_ARN)
    _secret_cache = json.loads(result['SecretString'])
    return _secret_cache['username'], _secret_cache['password']


def _get_db_conn():
    global _db_conn
    if _db_conn and not _db_conn.closed:
        try:
            _db_conn.cursor().execute('SELECT 1')
            return _db_conn
        except Exception:
            pass
    username, password = _load_db_credentials()
    _db_conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=username, password=password,
        sslmode='require', connect_timeout=5,
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
    """Cached — queries Aurora at most once every APP_IDS_CACHE_TTL seconds."""
    global _app_ids_cache, _app_ids_cache_ts
    now = time.monotonic()
    if _app_ids_cache is not None and now - _app_ids_cache_ts < _APP_IDS_CACHE_TTL:
        return _app_ids_cache
    conn = _get_db_conn()
    with conn.cursor() as cur:
        cur.execute('SELECT app_id FROM apps WHERE receive_sdsm = TRUE')
        _app_ids_cache = [row[0] for row in cur.fetchall()]
    _app_ids_cache_ts = now
    return _app_ids_cache


def _sdsm_ts_to_float(sdsm_ts: dict) -> float:
    """Convert sDSMTimeStamp dict to Unix float seconds."""
    offset_minutes = int(sdsm_ts.get('offset', 0))
    dt = datetime(
        year=int(sdsm_ts['year']),
        month=int(sdsm_ts['month']),
        day=int(sdsm_ts['day']),
        hour=int(sdsm_ts['hour']),
        minute=int(sdsm_ts['minute']),
        second=0,
        tzinfo=timezone(timedelta(minutes=offset_minutes)),
    )
    return dt.timestamp() + float(sdsm_ts['second'])


def _parse_dsrc_envelope(data_b64: str) -> dict:
    raw = base64.b64decode(data_b64).decode('utf-8')
    result = {}
    for line in raw.strip().splitlines():
        if '=' in line:
            k, _, v = line.partition('=')
            result[k.strip()] = v.strip()
    return result


def _broadcast_pending() -> None:
    """Broadcast the pending merged SDSM message, then clear the buffer."""
    global _pending_sdsm_ts, _pending_decoded, _pending_msg, _pending_capture_ts
    if _pending_decoded is None:
        return

    decoded    = _pending_decoded
    msg        = _pending_msg
    capture_ts = _pending_capture_ts

    _pending_sdsm_ts    = None
    _pending_decoded    = None
    _pending_msg        = None
    _pending_capture_ts = None

    ref_pos = decoded.get('refPos')
    if not ref_pos:
        print(json.dumps({'event': 'missing_ref_pos', 'sensor_name': SENSOR_NAME}))
        return

    app_ids = _get_sdsm_app_ids()
    r = _get_redis()

    clients_by_app: dict[str, list[WsClient]] = {}
    for app_id in app_ids:
        clients_by_app[app_id] = get_nearby_clients(
            r, app_id,
            lat=ref_pos['lat'], lon=ref_pos['long'],
            radius_m=SDSM_BROADCAST_RADIUS_M,
        )

    total_nearby = sum(len(v) for v in clients_by_app.values())
    print(json.dumps({
        'event': 'nearby_clients',
        'sensor_name': SENSOR_NAME,
        'capture_ts': capture_ts,
        'total_nearby': total_nearby,
        'per_app': {aid: len(c) for aid, c in clients_by_app.items()},
    }))

    if total_nearby == 0:
        return

    ws_message = {
        'type':               'sdsm',
        'sensor_name':        SENSOR_NAME,
        'device_name':        msg.get('device_name'),
        'capture_timestamp':  capture_ts,
        'creation_timestamp': msg.get('creation_timestamp'),
        'frame_id':           msg.get('frame_id'),
        'sdsm':               decoded,
    }

    for app_id, clients in clients_by_app.items():
        if not clients:
            continue
        result = broadcast_to_clients(r, app_id, clients, ws_message, AWS_REGION)
        print(json.dumps({
            'event': 'broadcast_done',
            'app_id': app_id,
            'sensor_name': SENSOR_NAME,
            'capture_ts': capture_ts,
            'delivered_count': result.delivered_count,
            'failed_count': result.failed_count,
            'gone_count': result.gone_count,
        }))


# ---- message processing --------------------------------------------------

def process_message(body: str) -> None:
    """Process one SQS message body. Raises on unrecoverable error."""
    global _pending_sdsm_ts, _pending_decoded, _pending_msg, _pending_capture_ts

    # Step 1: parse JSON
    try:
        msg = json.loads(body)
    except Exception as e:
        print(json.dumps({'event': 'parse_error', 'sensor_name': SENSOR_NAME, 'error': str(e)}))
        return  # malformed — don't retry

    capture_ts_raw = msg.get('capture_timestamp')
    try:
        capture_ts = float(capture_ts_raw)
    except (TypeError, ValueError):
        print(json.dumps({'event': 'invalid_timestamp', 'sensor_name': SENSOR_NAME, 'capture_timestamp': str(capture_ts_raw)}))
        return

    # Step 2: decode DSRC envelope + ASN.1 SDSM
    data_b64 = msg.get('data')
    if not data_b64:
        print(json.dumps({'event': 'missing_data', 'sensor_name': SENSOR_NAME}))
        return

    envelope = _parse_dsrc_envelope(data_b64)
    msg_type    = envelope.get('Type', '')
    hex_payload = envelope.get('Payload', '')

    if msg_type != 'SDSM' or not hex_payload:
        print(json.dumps({'event': 'unsupported_type', 'sensor_name': SENSOR_NAME, 'msg_type': msg_type}))
        return

    decoded = sdsm_decoder(hex_payload)

    # Step 3: extract and convert sDSMTimeStamp
    sdsm_ts_dict = decoded.get('sDSMTimeStamp')
    if not sdsm_ts_dict:
        print(json.dumps({'event': 'missing_sdsm_timestamp', 'sensor_name': SENSOR_NAME}))
        return

    try:
        sdsm_ts = _sdsm_ts_to_float(sdsm_ts_dict)
    except Exception as e:
        print(json.dumps({'event': 'invalid_sdsm_timestamp', 'sensor_name': SENSOR_NAME, 'error': str(e)}))
        return

    # Step 4: merge / flush / drop based on sDSMTimeStamp proximity (5 ms window)
    if _pending_sdsm_ts is None:
        # Nothing buffered yet — store as pending
        _pending_sdsm_ts    = sdsm_ts
        _pending_decoded    = decoded
        _pending_msg        = msg
        _pending_capture_ts = capture_ts
        print(json.dumps({'event': 'sdsm_buffered', 'sensor_name': SENSOR_NAME, 'sdsm_ts': sdsm_ts}))
        return

    diff = sdsm_ts - _pending_sdsm_ts

    if abs(diff) <= 0.005:
        # Fragment of the same transmission — merge objects, keep the larger timestamp
        merged_objects = list(_pending_decoded.get('objects', []))
        merged_objects.extend(decoded.get('objects', []))
        if diff > 0:
            # Incoming is newer: adopt its header fields but keep merged objects
            _pending_decoded    = {**decoded, 'objects': merged_objects}
            _pending_sdsm_ts    = sdsm_ts
            _pending_msg        = msg
            _pending_capture_ts = capture_ts
        else:
            _pending_decoded = {**_pending_decoded, 'objects': merged_objects}
        print(json.dumps({
            'event': 'sdsm_merged',
            'sensor_name': SENSOR_NAME,
            'sdsm_ts': sdsm_ts,
            'pending_ts': _pending_sdsm_ts,
            'total_objects': len(merged_objects),
        }))
        return

    if diff < -0.005:
        # Incoming is stale (older than pending by >5 ms) — drop it
        print(json.dumps({'event': 'sdsm_stale_drop', 'sensor_name': SENSOR_NAME,
                          'sdsm_ts': sdsm_ts, 'pending_ts': _pending_sdsm_ts}))
        return

    # Incoming is significantly newer (diff > 5 ms): flush pending, buffer the new message
    print(json.dumps({'event': 'sdsm_flush', 'sensor_name': SENSOR_NAME,
                      'pending_ts': _pending_sdsm_ts, 'new_ts': sdsm_ts}))
    _broadcast_pending()
    _pending_sdsm_ts    = sdsm_ts
    _pending_decoded    = decoded
    _pending_msg        = msg
    _pending_capture_ts = capture_ts


# ---- main polling loop ---------------------------------------------------

def main():
    print(json.dumps({'event': 'consumer_start', 'sensor_name': SENSOR_NAME, 'queue_url': QUEUE_URL}))

    sqs = _get_sqs()

    while not _shutdown:
        try:
            resp = sqs.receive_message(
                QueueUrl=QUEUE_URL,
                MaxNumberOfMessages=10,
                WaitTimeSeconds=20,          # long-poll — no busy-wait
                AttributeNames=['MessageGroupId'],
                MessageAttributeNames=['All'],
            )
        except Exception as e:
            print(json.dumps({'event': 'poll_error', 'sensor_name': SENSOR_NAME, 'error': str(e)}))
            time.sleep(5)
            continue

        messages = resp.get('Messages', [])
        if not messages:
            continue

        print(json.dumps({'event': 'poll_received', 'sensor_name': SENSOR_NAME, 'count': len(messages)}))

        to_delete = []
        for msg in messages:
            try:
                process_message(msg['Body'])
                # Collect receipt handles for successful/benign-skip messages
                to_delete.append({'Id': msg['MessageId'], 'ReceiptHandle': msg['ReceiptHandle']})
            except Exception as e:
                # Do NOT add to batch — let visibility timeout expire so SQS retries.
                print(json.dumps({'event': 'process_error', 'sensor_name': SENSOR_NAME, 'error': str(e)}))

        if to_delete:
            # delete_message_batch accepts up to 10 entries (matches MaxNumberOfMessages)
            sqs.delete_message_batch(QueueUrl=QUEUE_URL, Entries=to_delete)

    _broadcast_pending()
    print(json.dumps({'event': 'consumer_shutdown', 'sensor_name': SENSOR_NAME}))


if __name__ == '__main__':
    main()
