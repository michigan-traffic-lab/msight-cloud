#!/usr/bin/env python3
"""SNS round-trip latency test.

Publishes a special probe message to the sensor SNS topic, then polls
an ephemeral SQS queue subscribed to that topic and measures the time
until the same message arrives back.

Usage:
    python tools/sns_latency_test.py
    python tools/sns_latency_test.py --rounds 5
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from datetime import datetime, timezone

import boto3

# ---------------------------------------------------------------------------
# Hard-coded config — edit as needed
# ---------------------------------------------------------------------------
SNS_TOPIC_ARN = "arn:aws:sns:us-east-2:162092913718:msight-sensor-topic"
AWS_REGION    = "us-east-2"
PROBE_SENSOR  = "latency-probe"          # sentinel sensor_name so the consumer skips real processing
POLL_TIMEOUT  = 30                        # seconds to wait for the message before giving up
# ---------------------------------------------------------------------------


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_sqs_queue(sqs: object, probe_id: str) -> tuple[str, str]:
    """Create a temporary SQS queue and return (queue_url, queue_arn)."""
    queue_name = f"sns-latency-probe-{probe_id}"
    resp = sqs.create_queue(
        QueueName=queue_name,
        Attributes={
            "MessageRetentionPeriod": "300",  # 5 minutes — auto-purge
            "ReceiveMessageWaitTimeSeconds": "20",
        },
    )
    queue_url = resp["QueueUrl"]

    attr_resp = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=["QueueArn"],
    )
    queue_arn = attr_resp["Attributes"]["QueueArn"]
    return queue_url, queue_arn


def allow_sns_to_send(sqs: object, queue_url: str, queue_arn: str) -> None:
    """Attach a policy so SNS can deliver to this SQS queue."""
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": "sns.amazonaws.com"},
                "Action": "sqs:SendMessage",
                "Resource": queue_arn,
                "Condition": {
                    "ArnEquals": {"aws:SourceArn": SNS_TOPIC_ARN},
                },
            }
        ],
    }
    sqs.set_queue_attributes(
        QueueUrl=queue_url,
        Attributes={"Policy": json.dumps(policy)},
    )


def subscribe_queue(sns: object, queue_arn: str) -> str:
    """Subscribe the SQS queue to the SNS topic and return the subscription ARN."""
    resp = sns.subscribe(
        TopicArn=SNS_TOPIC_ARN,
        Protocol="sqs",
        Endpoint=queue_arn,
        Attributes={"RawMessageDelivery": "true"},
    )
    return resp["SubscriptionArn"]


def publish_probe(sns: object, probe_id: str) -> float:
    """Publish a probe message and return the local send timestamp in ms."""
    message = {
        "probe_id":          probe_id,
        "sensor_name":       PROBE_SENSOR,
        "capture_timestamp": time.time(),
        "sent_at":           iso_now(),
        "data":              "",          # empty — consumer will skip (no SDSM data)
    }
    sent_at_ms = time.monotonic() * 1000
    sns.publish(
        TopicArn=SNS_TOPIC_ARN,
        Message=json.dumps(message),
        MessageAttributes={
            "probe_id": {
                "DataType": "String",
                "StringValue": probe_id,
            }
        },
    )
    return sent_at_ms


def wait_for_probe(sqs: object, queue_url: str, probe_id: str, sent_at_ms: float) -> float | None:
    """Poll SQS until we see our probe message back. Returns round-trip ms or None on timeout."""
    deadline = time.monotonic() + POLL_TIMEOUT

    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        wait_secs = min(20, max(1, int(remaining)))

        resp = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=wait_secs,
            AttributeNames=["All"],
        )

        for msg in resp.get("Messages", []):
            received_at_ms = time.monotonic() * 1000

            try:
                body = json.loads(msg["Body"])
            except Exception:
                continue

            if body.get("probe_id") == probe_id:
                sqs.delete_message(
                    QueueUrl=queue_url,
                    ReceiptHandle=msg["ReceiptHandle"],
                )
                return received_at_ms - sent_at_ms

    return None


def cleanup(sqs: object, sns: object, queue_url: str, subscription_arn: str) -> None:
    try:
        sns.unsubscribe(SubscriptionArn=subscription_arn)
    except Exception as e:
        print(f"  Warning: could not unsubscribe: {e}")
    try:
        sqs.delete_queue(QueueUrl=queue_url)
    except Exception as e:
        print(f"  Warning: could not delete queue: {e}")


def run_round(sns: object, sqs: object, queue_url: str, round_num: int) -> float | None:
    probe_id = str(uuid.uuid4())
    print(f"  Round {round_num}: publishing probe {probe_id[:8]}…", end=" ", flush=True)
    sent_at_ms = publish_probe(sns, probe_id)
    latency = wait_for_probe(sqs, queue_url, probe_id, sent_at_ms)
    if latency is None:
        print(f"TIMEOUT after {POLL_TIMEOUT}s")
    else:
        print(f"{latency:.1f} ms")
    return latency


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure SNS round-trip latency.")
    parser.add_argument("--rounds", type=int, default=3, help="Number of probe rounds (default: 3)")
    args = parser.parse_args()

    sns = boto3.client("sns", region_name=AWS_REGION)
    sqs = boto3.client("sqs", region_name=AWS_REGION)

    probe_id = str(uuid.uuid4())[:8]

    print(f"SNS latency test — topic: {SNS_TOPIC_ARN}")
    print(f"Creating ephemeral SQS queue…")
    queue_url, queue_arn = create_sqs_queue(sqs, probe_id)
    print(f"  Queue: {queue_url}")

    allow_sns_to_send(sqs, queue_url, queue_arn)
    subscription_arn = subscribe_queue(sns, queue_arn)
    print(f"  Subscribed: {subscription_arn}")

    # Brief pause so the subscription is fully active before we publish
    time.sleep(1)

    print(f"\nRunning {args.rounds} round(s)…")
    results: list[float] = []
    try:
        for i in range(1, args.rounds + 1):
            result = run_round(sns, sqs, queue_url, i)
            if result is not None:
                results.append(result)
    finally:
        print("\nCleaning up queue and subscription…")
        cleanup(sqs, sns, queue_url, subscription_arn)

    if results:
        print(f"\nResults ({len(results)}/{args.rounds} successful):")
        print(f"  Min:  {min(results):.1f} ms")
        print(f"  Max:  {max(results):.1f} ms")
        print(f"  Avg:  {sum(results) / len(results):.1f} ms")
    else:
        print("\nAll rounds timed out — no latency data.")


if __name__ == "__main__":
    main()
