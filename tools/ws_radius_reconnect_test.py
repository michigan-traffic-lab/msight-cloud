#!/usr/bin/env python3

"""WebSocket + radius broadcast smoke test.

This script verifies two delivery cycles for the same client identity:
1. Connect websocket, update location, send radius broadcast, receive message.
2. Close websocket, reconnect with the same app_id/client_id, repeat, and confirm
   the second broadcast also arrives.

Update the configuration values below before running.
"""

from __future__ import annotations

import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from websocket import WebSocket, create_connection


# Configuration
HTTP_BASE_URL = "https://7hmptbe8s3.execute-api.us-east-2.amazonaws.com"
APP_ID = "msight-demo"
CLIENT_ID = "python-ws-test"
APPEND_RUN_SUFFIX_TO_CLIENT_ID = True
LATITUDE = 42.2808
LONGITUDE = -83.7430
RADIUS_M = 1000
LIMIT = 500
HTTP_TIMEOUT_SECONDS = 10
BROADCAST_HTTP_TIMEOUT_SECONDS = 25
WEBSOCKET_CONNECT_TIMEOUT_SECONDS = 10
WEBSOCKET_MESSAGE_TIMEOUT_SECONDS = 15
RECONNECT_PAUSE_SECONDS = 2
POST_CONNECT_SETTLE_SECONDS = 1
POST_LOCATION_SETTLE_SECONDS = 1

# Update this payload freely for testing.
MESSAGE_TEMPLATE: dict[str, Any] = {
    "type": "debug-broadcast",
    "text": "hello nearby clients",
    "source": "python-ws-reconnect-test",
}

RUN_ID = str(int(time.time()))


LOCATION_UPDATE_URL = f"{HTTP_BASE_URL}/v1/clients/location/update"
SYSTEM_WS_URL = f"{HTTP_BASE_URL}/system/websocket-url"
RADIUS_BROADCAST_URL = f"{HTTP_BASE_URL}/v1/clients/notify/radius"


def iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def active_client_id() -> str:
    if APPEND_RUN_SUFFIX_TO_CLIENT_ID:
        return f"{CLIENT_ID}-{RUN_ID}"
    return CLIENT_ID


def http_json_request(
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout_seconds: int = HTTP_TIMEOUT_SECONDS,
    request_name: str = "request",
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            response_text = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {url}: {error_body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"{request_name} to {url} failed: {error}") from error
    except (TimeoutError, socket.timeout) as error:
        raise RuntimeError(
            f"{request_name} to {url} timed out after {timeout_seconds}s"
        ) from error

    try:
        return json.loads(response_text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Non-JSON response from {url}: {response_text}") from error


def fetch_websocket_base_url() -> str:
    response = http_json_request(SYSTEM_WS_URL, request_name="system websocket URL request")
    websocket_url = response.get("websocket_url")
    if not isinstance(websocket_url, str) or not websocket_url:
        raise RuntimeError(f"Invalid websocket_url in system response: {response}")
    return websocket_url


def connect_websocket() -> WebSocket:
    websocket_base_url = fetch_websocket_base_url()
    client_id = active_client_id()
    connect_url = (
        f"{websocket_base_url}?app_id={urllib.parse.quote(APP_ID)}"
        f"&client_id={urllib.parse.quote(client_id)}"
    )
    print(f"Connecting websocket: {connect_url}")
    websocket = create_connection(connect_url, timeout=WEBSOCKET_CONNECT_TIMEOUT_SECONDS)
    if POST_CONNECT_SETTLE_SECONDS > 0:
        print(f"Waiting {POST_CONNECT_SETTLE_SECONDS}s for websocket registration to settle...")
        time.sleep(POST_CONNECT_SETTLE_SECONDS)
    return websocket


def send_location_update() -> dict[str, Any]:
    client_id = active_client_id()
    payload = {
        "app_id": APP_ID,
        "client_id": client_id,
        "timestamp": iso_timestamp(),
        "location": {
            "lat": LATITUDE,
            "lon": LONGITUDE,
            "source": "manual",
        },
    }
    print("Sending location update...")
    print(json.dumps(payload, indent=2))
    return http_json_request(
        LOCATION_UPDATE_URL,
        payload,
        request_name="location update request",
    )


def send_radius_broadcast(test_label: str) -> dict[str, Any]:
    client_id = active_client_id()
    client_sent_at = iso_timestamp()
    payload = {
        "app_id": APP_ID,
        "origin": {
            "lat": LATITUDE,
            "lon": LONGITUDE,
        },
        "radius_m": RADIUS_M,
        "limit": LIMIT,
        "message": {
            **MESSAGE_TEMPLATE,
            "test_label": test_label,
            "client_id": client_id,
            "sent_at": client_sent_at,
            "_debug_meta": {
                "message_id": f"{test_label}-{RUN_ID}",
                "client_sent_at": client_sent_at,
                "run_id": RUN_ID,
            },
        },
    }
    print("Sending radius broadcast...")
    print(json.dumps(payload, indent=2))
    return http_json_request(
        RADIUS_BROADCAST_URL,
        payload,
        timeout_seconds=BROADCAST_HTTP_TIMEOUT_SECONDS,
        request_name="radius broadcast request",
    )


def receive_matching_message(ws: WebSocket, expected_test_label: str) -> dict[str, Any]:
    ws.settimeout(WEBSOCKET_MESSAGE_TIMEOUT_SECONDS)
    deadline = time.monotonic() + WEBSOCKET_MESSAGE_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        raw_message = ws.recv()
        print(f"WebSocket raw message: {raw_message}")

        try:
            parsed = json.loads(raw_message)
        except json.JSONDecodeError:
            continue

        message = parsed.get("message") if isinstance(parsed, dict) else None
        if not isinstance(message, dict):
            continue

        if message.get("test_label") == expected_test_label:
            return parsed

    raise RuntimeError(
        f"Timed out waiting for websocket message with test_label={expected_test_label!r}"
    )


def run_delivery_cycle(test_label: str) -> None:
    ws = connect_websocket()
    try:
        send_location_update_response = send_location_update()
        print("Location update response:")
        print(json.dumps(send_location_update_response, indent=2))

        if POST_LOCATION_SETTLE_SECONDS > 0:
            print(f"Waiting {POST_LOCATION_SETTLE_SECONDS}s for location state to settle...")
            time.sleep(POST_LOCATION_SETTLE_SECONDS)

        broadcast_response = send_radius_broadcast(test_label)
        print("Broadcast response:")
        print(json.dumps(broadcast_response, indent=2))

        delivered_count = broadcast_response.get("delivered_count")
        if isinstance(delivered_count, int) and delivered_count < 1:
            raise RuntimeError(
                "Broadcast response reported no deliveries. "
                f"Full response: {json.dumps(broadcast_response)}"
            )

        matched_message = receive_matching_message(ws, test_label)
        print("Matched websocket message:")
        print(json.dumps(matched_message, indent=2))
    finally:
        try:
            ws.close()
        except Exception:
            pass


def run_test() -> int:
    print(f"Using client_id={active_client_id()}")
    print("=== Cycle 1: initial websocket connect ===")
    run_delivery_cycle("cycle-1")

    print(f"\nSleeping {RECONNECT_PAUSE_SECONDS}s before reconnect test...")
    time.sleep(RECONNECT_PAUSE_SECONDS)

    print("\n=== Cycle 2: reconnect same client identity ===")
    run_delivery_cycle("cycle-2")

    print("\nSuccess: websocket connect, radius broadcast, and reconnect path all worked.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run_test())
    except Exception as error:
        print(f"\nTest failed: {error}", file=sys.stderr)
        raise SystemExit(1)