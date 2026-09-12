"""Tests for the Valkey tier that lets the SPaT path drop the RDS Proxy.

Runnable with the standard library alone — `npm run test:python`. Valkey is a
dictionary here; nothing touches a network.

What is worth testing is not that a cache caches. It is the three properties
that make a *shared* cache different from the per-container one beside it, each
of which fails in a way that would be invisible until it was expensive:

  * One container per refresh reaches the database, not all of them. A shared
    key expires once for everybody, so without single flight the fleet arrives
    at Aurora together — the exact spike the cache exists to remove.
  * A value past its refresh point is still served. If it were not, refresh
    would sit on the critical path of live SPaT messages.
  * Valkey failing costs round trips, never messages.
"""

from __future__ import annotations

import json
import pathlib
import sys
import time
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src" / "shared" / "python"))

from msight_valkey_cache import NAMESPACE, ValkeyConfigCache  # noqa: E402


class FakeRedis:
    """Enough of the client for this module: get, mget, set, delete, pipeline.

    TTLs are recorded rather than enforced — every test that cares about expiry
    drives it explicitly, which is more honest than sleeping.
    """

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttls: dict[str, int] = {}
        self.calls: list[str] = []
        self.fail_on: set[str] = set()

    def _maybe_fail(self, op: str) -> None:
        self.calls.append(op)
        if op in self.fail_on:
            raise RuntimeError(f"valkey down: {op}")

    def get(self, key):
        self._maybe_fail("get")
        return self.store.get(key)

    def mget(self, keys):
        self._maybe_fail("mget")
        return [self.store.get(key) for key in keys]

    def set(self, key, value, ex=None, nx=False):
        self._maybe_fail("set")
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.ttls[key] = ex
        return True

    def delete(self, *keys):
        self._maybe_fail("delete")
        for key in keys:
            self.store.pop(key, None)
        return len(keys)

    def pipeline(self):
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, client: FakeRedis) -> None:
        self._client = client
        self._queued: list[tuple] = []

    def set(self, key, value, ex=None):
        self._queued.append((key, value, ex))
        return self

    def execute(self):
        self._client._maybe_fail("pipeline")
        for key, value, ex in self._queued:
            self._client.store[key] = value
            if ex is not None:
                self._client.ttls[key] = ex
        self._queued = []


def cache_for(client: FakeRedis, *, ttl_s: float = 60.0, service: str = "spat-sns-consumer"):
    return ValkeyConfigCache(service, lambda: client, ttl_s=ttl_s)


def age(client: FakeRedis, key: str, seconds: float) -> None:
    """Move one entry's refresh point into the past, without sleeping."""
    payload = json.loads(client.store[key])
    payload["r"] = time.time() - seconds
    client.store[key] = json.dumps(payload)


class KeyNaming(unittest.TestCase):
    def test_keys_are_namespaced_by_platform_and_function(self):
        cache = cache_for(FakeRedis())
        self.assertEqual(cache.key("app_ids"), "MSight:spat-sns-consumer:app_ids")
        self.assertEqual(
            cache.key("map_centers", "1037_Ellsworth"),
            "MSight:spat-sns-consumer:map_centers:1037_Ellsworth",
        )

    def test_the_two_consumers_cannot_read_each_others_answers(self):
        """Load-bearing: they query the same tables through different filters.

        `receive_spat` and `receive_critical_spat` are different columns. A
        shared key would hand each consumer the other's app list, and the
        symptom — some apps receiving a stream they never subscribed to —
        would look like a database bug.
        """
        client = FakeRedis()
        spat = cache_for(client, service="spat-sns-consumer")
        critical = cache_for(client, service="critical-spat-sns-consumer")

        spat.write_one("app_ids", ["app-a"])
        critical.write_one("app_ids", ["app-b"])

        self.assertEqual(spat.read_one("app_ids"), ("fresh", ["app-a"]))
        self.assertEqual(critical.read_one("app_ids"), ("fresh", ["app-b"]))

    def test_everything_sits_under_one_root(self):
        cache = cache_for(FakeRedis())
        self.assertTrue(cache.key("anything").startswith(f"{NAMESPACE}:"))


class ReadingAndWriting(unittest.TestCase):
    def test_a_stored_value_reads_back_fresh(self):
        client = FakeRedis()
        cache = cache_for(client)
        cache.write_one("app_ids", ["a", "b"])
        self.assertEqual(cache.read_one("app_ids"), ("fresh", ["a", "b"]))

    def test_nothing_stored_reads_as_missing(self):
        self.assertEqual(cache_for(FakeRedis()).read_one("app_ids"), ("missing", None))

    def test_read_many_splits_into_fresh_stale_and_missing(self):
        client = FakeRedis()
        cache = cache_for(client, ttl_s=60)
        cache.write_many("map_centers", {"a": (1.0, 2.0), "b": (3.0, 4.0)})
        age(client, cache.key("map_centers", "b"), 5)

        fresh, stale, missing = cache.read_many("map_centers", ["a", "b", "c"])

        self.assertEqual(list(fresh), ["a"])
        self.assertEqual(list(stale), ["b"])
        self.assertEqual(missing, ["c"])

    def test_a_cached_absence_is_a_value(self):
        """An intersection that does not exist is named on every message from
        that sensor. Caching the miss is the whole point; treating it as
        'nothing cached' would query for a row known not to exist, for ever."""
        client = FakeRedis()
        cache = cache_for(client)
        cache.write_many("map_centers", {"nowhere": None})

        fresh, stale, missing = cache.read_many("map_centers", ["nowhere"])
        self.assertEqual(missing, [])
        self.assertEqual(fresh, {"nowhere": None})

    def test_values_outlive_their_refresh_point(self):
        """The Valkey TTL is much longer than the refresh point deliberately:
        that gap is what there is to serve while somebody reloads."""
        client = FakeRedis()
        cache = cache_for(client, ttl_s=60)
        cache.write_one("app_ids", ["a"])
        self.assertGreater(client.ttls[cache.key("app_ids")], 60)

    def test_a_corrupt_entry_reads_as_absent(self):
        client = FakeRedis()
        cache = cache_for(client)
        client.store[cache.key("app_ids")] = "not json"
        self.assertEqual(cache.read_one("app_ids"), ("missing", None))


class SingleFlight(unittest.TestCase):
    def test_exactly_one_container_is_let_through(self):
        """The property the whole design rests on.

        Twenty containers find the same aged key in the same instant. Without
        this, twenty connections open on Aurora at once — which at the 0.5 ACU
        floor is a fifth of the entire connection ceiling, for one row.
        """
        client = FakeRedis()
        caches = [cache_for(client) for _ in range(20)]
        caches[0].write_one("app_ids", ["a"])
        age(client, caches[0].key("app_ids"), 5)

        winners = [cache for cache in caches if cache.claim_refresh("app_ids")]
        self.assertEqual(len(winners), 1)

    def test_losers_still_have_something_to_serve(self):
        client = FakeRedis()
        cache = cache_for(client)
        cache.write_one("app_ids", ["a"])
        age(client, cache.key("app_ids"), 5)

        state, value = cache.read_one("app_ids")
        self.assertEqual(state, "stale")
        self.assertEqual(value, ["a"])

    def test_a_released_claim_lets_the_next_container_retry_at_once(self):
        """A failed reload must not also freeze the value for everyone else
        until the lock ages out."""
        client = FakeRedis()
        first, second = cache_for(client), cache_for(client)

        self.assertTrue(first.claim_refresh("app_ids"))
        self.assertFalse(second.claim_refresh("app_ids"))

        first.release_refresh("app_ids")
        self.assertTrue(second.claim_refresh("app_ids"))

    def test_the_claim_expires_on_its_own(self):
        client = FakeRedis()
        cache = cache_for(client)
        cache.claim_refresh("app_ids")
        # Short, because it is only insurance: a container that dies mid-reload
        # must not hold the value hostage for a whole TTL.
        self.assertLessEqual(client.ttls["MSight:spat-sns-consumer:app_ids:refresh-lock"], 30)


class ValkeyFailing(unittest.TestCase):
    """Every path degrades to "the database answers", never to "no answer"."""

    def test_a_read_failure_reads_as_a_miss(self):
        client = FakeRedis()
        client.fail_on = {"get", "mget"}
        cache = cache_for(client)

        self.assertEqual(cache.read_one("app_ids"), ("missing", None))
        self.assertEqual(cache.read_many("map_centers", ["a"]), ({}, {}, ["a"]))

    def test_a_write_failure_is_swallowed(self):
        client = FakeRedis()
        client.fail_on = {"set", "pipeline"}
        cache = cache_for(client)

        cache.write_one("app_ids", ["a"])
        cache.write_many("map_centers", {"a": (1.0, 2.0)})

    def test_a_claim_fails_open(self):
        """Duplicated work is the right failure. Refusing every claim would
        freeze the configuration at whatever it last was, for ever."""
        client = FakeRedis()
        client.fail_on = {"set"}
        self.assertTrue(cache_for(client).claim_refresh("app_ids"))

    def test_repeated_failures_are_reported_once_per_window(self):
        """At 40 messages a second, reporting every failure would turn a degraded
        cache into a CloudWatch bill larger than the database it protects."""
        client = FakeRedis()
        client.fail_on = {"get"}
        seen: list[str] = []
        cache = ValkeyConfigCache(
            "spat-sns-consumer",
            lambda: client,
            ttl_s=60,
            on_error=lambda operation, _error: seen.append(operation),
        )

        for _ in range(500):
            cache.read_one("app_ids")

        self.assertEqual(len(seen), 1)
        # Every call still went through: throttling the report must not
        # throttle the work.
        self.assertEqual(client.calls.count("get"), 500)

    def test_each_operation_reports_on_its_own(self):
        """A single noisy failure must not mask a different one starting
        beside it."""
        client = FakeRedis()
        client.fail_on = {"get", "mget"}
        seen: list[str] = []
        cache = ValkeyConfigCache(
            "spat-sns-consumer",
            lambda: client,
            ttl_s=60,
            on_error=lambda operation, _error: seen.append(operation),
        )

        cache.read_one("app_ids")
        cache.read_one("app_ids")
        cache.read_many("map_centers", ["a"])

        self.assertEqual(sorted(seen), ["get", "mget"])

    def test_failures_are_reported_not_raised(self):
        client = FakeRedis()
        client.fail_on = {"get"}
        seen: list[str] = []
        cache = ValkeyConfigCache(
            "spat-sns-consumer",
            lambda: client,
            ttl_s=60,
            on_error=lambda operation, _error: seen.append(operation),
        )

        cache.read_one("app_ids")
        self.assertEqual(seen, ["get"])


class Invalidation(unittest.TestCase):
    def test_dropping_a_key_forces_the_next_read_to_reload(self):
        """For the console: an edit to `apps` or `maps` can be visible in a
        round trip instead of a TTL."""
        client = FakeRedis()
        cache = cache_for(client)
        cache.write_one("app_ids", ["a"])

        cache.invalidate("app_ids")
        self.assertEqual(cache.read_one("app_ids"), ("missing", None))

    def test_members_can_be_dropped_individually(self):
        client = FakeRedis()
        cache = cache_for(client)
        cache.write_many("map_centers", {"a": (1.0, 2.0), "b": (3.0, 4.0)})

        cache.invalidate("map_centers", ["a"])
        fresh, _stale, missing = cache.read_many("map_centers", ["a", "b"])
        self.assertEqual(missing, ["a"])
        self.assertEqual(list(fresh), ["b"])


if __name__ == "__main__":
    unittest.main()
