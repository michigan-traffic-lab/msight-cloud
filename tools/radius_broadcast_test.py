#!/usr/bin/env python3

"""Simple test client for the radius broadcast API.

Update the configuration values below and run the script directly.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


# Configuration
API_URL = "https://7hmptbe8s3.execute-api.us-east-2.amazonaws.com/v1/clients/notify/radius"
APP_ID = "msight-demo"
# ORIGIN_LAT = 42.2808
# ORIGIN_LON = -83.7430
# ORIGIN_LAT = 37.421998
# ORIGIN_LON = -122.084000
ORIGIN_LAT = 42.302615
ORIGIN_LON = -83.704366

RADIUS_M = 1000
LIMIT = 500
REQUEST_TIMEOUT_SECONDS = 30
WARNING_MESSAGE_TEXT = "Pedestrian crossing ahead"


def iso_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_warning_message(timestamp: str) -> dict[str, Any]:
    return {
        "message_type": "msight_simple_warning",
        "message": WARNING_MESSAGE_TEXT,
        "timestamp": timestamp,
    }


def build_payload(event_id: str | None = None) -> dict[str, Any]:
    server_timestamp = iso_timestamp()
    payload: dict[str, Any] = {
        "app_id": APP_ID,
        "origin": {
            "lat": ORIGIN_LAT,
            "lon": ORIGIN_LON,
        },
        "radius_m": RADIUS_M,
        "limit": LIMIT,
        "server_timestamp": server_timestamp,
        "message": build_warning_message(server_timestamp),
    }
    if event_id is not None:
        payload["event_id"] = event_id
    return payload


def print_request_timing(round_trip_ms: float, *, stream: Any = sys.stdout) -> None:
    print(
        (
            "Request-to-confirm latency: "
            f"{round_trip_ms:.1f} ms "
            "(from starting the radius broadcast HTTP request until receiving the API response "
            "confirming warning send status)"
        ),
        file=stream,
    )


def send_radius_broadcast(event_id: str | None = None) -> int:
    payload = build_payload(event_id)
    encoded_body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=encoded_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    print("Sending radius broadcast request...")
    print(json.dumps(payload, indent=2))
    request_started_at = time.perf_counter()

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            response_text = response.read().decode("utf-8")
            round_trip_ms = (time.perf_counter() - request_started_at) * 1000
            print(f"\nHTTP {response.status}")
            print_request_timing(round_trip_ms)
            try:
                parsed = json.loads(response_text)
                print(json.dumps(parsed, indent=2))
            except json.JSONDecodeError:
                print(response_text)
            return 0
    except urllib.error.HTTPError as error:
        round_trip_ms = (time.perf_counter() - request_started_at) * 1000
        error_body = error.read().decode("utf-8", errors="replace")
        print(f"\nHTTP {error.code}", file=sys.stderr)
        print_request_timing(round_trip_ms, stream=sys.stderr)
        print(error_body, file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        round_trip_ms = (time.perf_counter() - request_started_at) * 1000
        print(f"\nRequest failed: {error}", file=sys.stderr)
        print_request_timing(round_trip_ms, stream=sys.stderr)
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send a radius broadcast request")
    parser.add_argument("--event-id", metavar="ID", help="event_id to include in the request (omit to let the server generate one)")
    args = parser.parse_args()
    raise SystemExit(send_radius_broadcast(args.event_id))