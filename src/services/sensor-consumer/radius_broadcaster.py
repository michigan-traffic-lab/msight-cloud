"""
radius_broadcaster.py

Python equivalent of src/shared/radius-broadcaster.ts + ws-sender.ts.

Provides two public functions:
  - get_nearby_clients(redis_client, app_id, lat, lon, radius_m, limit)
      -> list[WsClient]   (each client has ws connection info resolved)

  - broadcast_to_clients(app_id, clients, message, aws_region, event_id=None)
      -> BroadcastResult

Keeping both operations separate lets the caller do an early-exit before
any state-mutating work (stale-check write) when there are no nearby clients.
"""

import asyncio
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

# ---- constants (mirror radius-broadcaster.ts) ----------------------------

_ZONE_ID       = "zone01"
_DEFAULT_LIMIT = 500
MAX_WORKERS     = 20  # for ThreadPoolExecutor in broadcast_to_clients()

# Module-level boto3 client cache — HTTP connections are kept alive and reused
# across consecutive broadcast cycles, matching TypeScript WsSender behaviour.
# endpoint (str) -> boto3 management api client
_apigw_clients: dict = {}

# ---- key builders --------------------------------------------------------

def _geo_clients_key(app_id: str) -> str:
    return f"msight:{_ZONE_ID}:{app_id}:geo:clients"


def _client_key(app_id: str, client_id: str) -> str:
    return f"msight:{_ZONE_ID}:{app_id}:client:{client_id}"


# ---- data types ----------------------------------------------------------

@dataclass
class WsClient:
    client_id:     str
    connection_id: str
    domain_name:   str
    stage:         str


@dataclass
class BroadcastResult:
    delivered_count: int = 0
    failed_count:    int = 0
    gone_count:      int = 0


# ---- public: find nearby clients -----------------------------------------

def get_nearby_clients(
    redis_client,
    app_id:   str,
    lat:      float,
    lon:      float,
    radius_m: float,
    limit:    int = _DEFAULT_LIMIT,
) -> list[WsClient]:
    """
    Returns WsClient records for every client within radius_m metres of
    (lat, lon) that has an active WebSocket connection registered in Valkey.

    Uses a single GEOSEARCH + pipelined HMGET — no per-client round trips.
    """
    geo_key = _geo_clients_key(app_id)

    nearby_ids: list[str] = redis_client.execute_command(
        "GEOSEARCH", geo_key,
        "FROMLONLAT", lon, lat,
        "BYRADIUS", radius_m, "m",
        "COUNT", limit,
        "ASC",
    )

    if not nearby_ids:
        return []

    # Batch-fetch WS connection info for all nearby clients in one pipeline.
    pipe = redis_client.pipeline(transaction=False)
    for client_id in nearby_ids:
        pipe.hmget(
            _client_key(app_id, client_id),
            "ws_connection_id", "ws_domain_name", "ws_stage",
        )
    field_batches: list[list] = pipe.execute()

    clients: list[WsClient] = []
    for client_id, fields in zip(nearby_ids, field_batches):
        if not fields or len(fields) < 3:
            continue
        connection_id, domain_name, stage = fields[0], fields[1], fields[2]
        if not connection_id or not domain_name or not stage:
            continue  # client has no active WS session
        clients.append(WsClient(
            client_id=client_id,
            connection_id=connection_id,
            domain_name=domain_name,
            stage=stage,
        ))

    return clients


# ---- internal: clear stale WS entry in Valkey ----------------------------

# Lua script: atomically check-and-delete so a reconnect that writes a new
# ws_connection_id between the read and the HDEL cannot be silently wiped.
_CLEAR_IF_SAME_SCRIPT = """
local current = redis.call('HGET', KEYS[1], 'ws_connection_id')
if current == ARGV[1] then
    redis.call('HDEL', KEYS[1],
        'ws_connection_id', 'ws_domain_name', 'ws_stage',
        'ws_connected_at', 'ws_status')
    return 1
end
return 0
"""

def _clear_ws_info_if_same_connection(
    redis_client,
    app_id:        str,
    client_id:     str,
    connection_id: str,
) -> None:
    """Atomically remove WS fields only if the stored connection_id still matches."""
    key = _client_key(app_id, client_id)
    redis_client.eval(_CLEAR_IF_SAME_SCRIPT, 1, key, connection_id)


# ---- internal: send to one client ----------------------------------------

def _send_one(
    apigw_clients: dict,            # endpoint -> boto3 client (shared, pre-built)
    item:          WsClient,
    payload_bytes: bytes,
    aws_region:    str,
) -> tuple[str, bool, bool]:
    """
    Returns (connection_id, delivered: bool, gone: bool).
    Caller is responsible for Valkey cleanup on gone=True.
    """
    endpoint = f"https://{item.domain_name}/{item.stage}"
    if endpoint not in apigw_clients:
        apigw_clients[endpoint] = boto3.client(
            "apigatewaymanagementapi",
            endpoint_url=endpoint,
            region_name=aws_region,
        )
    client = apigw_clients[endpoint]
    try:
        client.post_to_connection(
            ConnectionId=item.connection_id,
            Data=payload_bytes,
        )
        return (item.connection_id, True, False)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "GoneException":
            return (item.connection_id, False, True)
        return (item.connection_id, False, False)
    except Exception:
        return (item.connection_id, False, False)


# ---- public: broadcast to pre-fetched client list ------------------------

async def broadcast_to_clients(
    redis_client,
    app_id:     str,
    clients:    list[WsClient],
    message:    dict,
    aws_region: str,
    event_id:   Optional[str] = None,
) -> BroadcastResult:
    """
    Push *message* to every client in *clients* via API Gateway Management API.
    Gone connections are cleaned up in Valkey automatically.

    *clients* should come from get_nearby_clients() — no GEOSEARCH is repeated.
    """
    if not clients:
        return BroadcastResult()

    if event_id is None:
        event_id = str(uuid.uuid4())

    payload_bytes = json.dumps({
        "app_id":           app_id,
        "event_id":         event_id,
        "message":          message,
        "server_timestamp": datetime.now(timezone.utc).isoformat(),
    }).encode("utf-8")

    result = BroadcastResult()
    gone_items: list[WsClient] = []
    by_connection_id = {c.connection_id: c for c in clients}

    loop = asyncio.get_running_loop()
    # One thread per client so no client's timeout can queue another.
    # Pass the module-level cache so boto3 connections are reused across calls.
    with ThreadPoolExecutor(max_workers=min(len(clients), MAX_WORKERS)) as executor:
        send_results = await asyncio.gather(*[
            loop.run_in_executor(executor, _send_one, _apigw_clients, item, payload_bytes, aws_region)
            for item in clients
        ])

    for _conn_id, delivered, gone in send_results:
        if delivered:
            result.delivered_count += 1
        elif gone:
            result.gone_count += 1
            gone_items.append(by_connection_id[_conn_id])
        else:
            result.failed_count += 1

    # Clean up stale Valkey entries for gone connections.
    for item in gone_items:
        try:
            _clear_ws_info_if_same_connection(redis_client, app_id, item.client_id, item.connection_id)
        except Exception:
            pass

    return result
