"""Tests for the Aurora round-trip reductions on the SPaT hot path.

Runnable with the standard library alone — `npm run test:python`, or
`python -m unittest discover -s test/python`. The AWS and PostgreSQL drivers are
stubbed, so nothing here touches a network.

Two things are under test:

  * ConfigCache, in src/shared/python — that its refresh points really are
    spread out (a cache that expires in lockstep does not solve the problem it
    was added for) and that an entry can never be reused forever.

  * The spat-sns-consumer handler's own _load_config, which is where the
    round-trip count is actually decided. The assertions are on the number of
    statements that reach the database, because that number is the cost.
"""

from __future__ import annotations

import os
import pathlib
import statistics
import sys
import time
import types
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src" / "shared" / "python"))

from msight_config_cache import ConfigCache  # noqa: E402


# ---------------------------------------------------------------------------
# Fake drivers, installed before the handler is imported.
# ---------------------------------------------------------------------------

class FakePgError(Exception):
    """Stands in for psycopg2.Error."""


#: Every statement that reached the fake database, as (sql, params).
QUERY_LOG: list[tuple[str, dict | None]] = []
#: How many upcoming execute() calls should fail, simulating a dropped socket.
FAILURES_PENDING = {"count": 0}


class _FakeCursor:
    def __init__(self) -> None:
        self._row: tuple | None = None

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def execute(self, sql: str, params: dict | None = None) -> None:
        if FAILURES_PENDING["count"] > 0:
            FAILURES_PENDING["count"] -= 1
            raise FakePgError("server closed the connection unexpectedly")

        QUERY_LOG.append((" ".join(sql.split()), params))
        names = (params or {}).get("names") or []
        self._row = (
            ["msight-demo"],
            [
                {"name": name, "lat": 42.0, "lon": -83.0}
                for name in names
                if name != "unknown-intersection"
            ],
        )

    def fetchone(self) -> tuple | None:
        return self._row


class _FakeConnection:
    closed = 0
    autocommit = False

    def cursor(self) -> _FakeCursor:
        return _FakeCursor()

    def close(self) -> None:
        pass


def _install_driver_stubs() -> None:
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.Error = FakePgError
    psycopg2.connect = lambda **_kwargs: _FakeConnection()
    sys.modules["psycopg2"] = psycopg2

    redis_module = types.ModuleType("redis")
    redis_module.Redis = lambda **_kwargs: None
    sys.modules["redis"] = redis_module

    class _SecretsManager:
        # SecretId matches the casing boto3 itself uses.
        def get_secret_value(self, SecretId):  # noqa: N803
            return {"SecretString": '{"username": "u", "password": "p"}'}

    boto3 = types.ModuleType("boto3")
    boto3.client = lambda _name, **_kwargs: _SecretsManager()
    sys.modules["boto3"] = boto3

    pyv2xlib = types.ModuleType("pyv2xlib")
    pyv2xlib.__path__ = []
    decoder = types.ModuleType("pyv2xlib.SPATDecoder")
    decoder.spat_decoder = lambda _hex: {}
    sys.modules["pyv2xlib"] = pyv2xlib
    sys.modules["pyv2xlib.SPATDecoder"] = decoder


_install_driver_stubs()
os.environ.setdefault("CONFIG_CACHE_TTL_SECONDS", "60")
sys.path.insert(0, str(REPO_ROOT / "src" / "functions" / "spat-sns-consumer"))
import handler  # noqa: E402


# ---------------------------------------------------------------------------


class ConfigCacheTest(unittest.TestCase):
    def test_value_is_usable_immediately_after_put(self):
        cache = ConfigCache(ttl_s=60)
        cache.put("apps", ["a"])
        self.assertEqual(cache.fresh("apps"), (True, ["a"]))

    def test_unknown_key_is_not_fresh(self):
        self.assertEqual(ConfigCache(ttl_s=60).fresh("nope"), (False, None))

    def test_missing_is_ordered_and_deduplicated(self):
        cache = ConfigCache(ttl_s=60)
        cache.put("a", 1)
        self.assertEqual(cache.missing(["a", "b", "c", "b"]), ["b", "c"])

    def test_refresh_points_are_spread_across_the_jitter_window(self):
        """The whole point: independent containers must not expire together.

        Each cache here stands for one Lambda container that cached at the same
        instant as all the others. What matters is that they do not agree on
        when to go back to Aurora.
        """
        ttl, jitter = 60.0, 0.25
        offsets = []
        for _ in range(2000):
            cache = ConfigCache(ttl_s=ttl, jitter=jitter)
            cache.put("k", 1)
            offsets.append(cache._entries["k"][1] - time.monotonic())

        self.assertGreater(min(offsets), ttl * (1 - jitter) - 0.5)
        self.assertLess(max(offsets), ttl * (1 + jitter) + 0.5)
        # Genuinely spread out, not clustered at one end.
        self.assertGreater(max(offsets) - min(offsets), ttl * jitter)
        self.assertAlmostEqual(statistics.mean(offsets), ttl, delta=ttl * 0.05)

    def test_entries_put_together_still_refresh_apart(self):
        cache = ConfigCache(ttl_s=60)
        cache.put("x", 1)
        cache.put("y", 2)
        self.assertNotEqual(cache._entries["x"][1], cache._entries["y"][1])

    def test_an_entry_always_stops_being_fresh(self):
        """No container can pin an old value indefinitely."""
        cache = ConfigCache(ttl_s=0.05, jitter=0.0)
        cache.put("k", "old")
        self.assertTrue(cache.fresh("k")[0])
        time.sleep(0.08)
        self.assertEqual(cache.fresh("k"), (False, None))

    def test_stale_serves_inside_the_grace_then_gives_up(self):
        cache = ConfigCache(ttl_s=0.05, jitter=0.0, max_stale_s=0.10)
        cache.put("k", "old")
        time.sleep(0.08)
        self.assertFalse(cache.fresh("k")[0])
        self.assertEqual(cache.stale("k"), (True, "old"))
        time.sleep(0.12)
        self.assertEqual(cache.stale("k"), (False, None))

    def test_rejects_nonsense_settings(self):
        for kwargs in (
            {"ttl_s": 0},
            {"ttl_s": -1},
            {"ttl_s": 10, "jitter": 1.0},
            {"ttl_s": 10, "jitter": -0.1},
        ):
            with self.subTest(**kwargs), self.assertRaises(ValueError):
                ConfigCache(**kwargs)


class SpatConfigLoadTest(unittest.TestCase):
    """Assertions on how many statements reach Aurora, because that is the bill."""

    def setUp(self):
        QUERY_LOG.clear()
        FAILURES_PENDING["count"] = 0
        handler._apps_cache._entries.clear()
        handler._centers_cache._entries.clear()

    def test_cold_cache_costs_one_round_trip_for_the_whole_message(self):
        """Three intersections used to be four queries plus four probes."""
        app_ids, centers = handler._load_config(["A", "B", "C"])

        self.assertEqual(len(QUERY_LOG), 1)
        self.assertEqual(app_ids, ["msight-demo"])
        self.assertEqual(
            centers,
            {"A": (42.0, -83.0), "B": (42.0, -83.0), "C": (42.0, -83.0)},
        )

    def test_warm_cache_costs_nothing(self):
        handler._load_config(["A", "B", "C"])
        queries_after_warmup = len(QUERY_LOG)

        for _ in range(50):
            app_ids, centers = handler._load_config(["A", "B", "C"])

        self.assertEqual(len(QUERY_LOG), queries_after_warmup)
        self.assertEqual(app_ids, ["msight-demo"])
        self.assertEqual(centers["A"], (42.0, -83.0))

    def test_only_the_unknown_intersection_is_queried_for(self):
        handler._load_config(["A", "B", "C"])
        queries_before = len(QUERY_LOG)

        _app_ids, centers = handler._load_config(["A", "B", "C", "D"])

        self.assertEqual(len(QUERY_LOG) - queries_before, 1)
        self.assertEqual(QUERY_LOG[-1][1]["names"], ["D"])
        self.assertEqual(centers["D"], (42.0, -83.0))

    def test_an_intersection_with_no_map_row_is_not_queried_again(self):
        _app_ids, centers = handler._load_config(["unknown-intersection"])
        self.assertEqual(centers, {"unknown-intersection": None})

        queries_before = len(QUERY_LOG)
        for _ in range(20):
            handler._load_config(["unknown-intersection"])
        self.assertEqual(len(QUERY_LOG), queries_before)

    def test_a_dropped_connection_is_retried_once(self):
        FAILURES_PENDING["count"] = 1

        app_ids, _centers = handler._load_config(["A"])

        self.assertEqual(app_ids, ["msight-demo"])
        self.assertEqual(len(QUERY_LOG), 1)

    def test_database_failure_serves_stale_config_rather_than_dropping_traffic(self):
        handler._load_config(["A"])
        # Force both entries past their refresh point but inside the grace.
        now = time.monotonic()
        handler._apps_cache._entries["spat_app_ids"] = (["msight-demo"], now - 1, now + 100)
        handler._centers_cache._entries["A"] = ((42.0, -83.0), now - 1, now + 100)
        FAILURES_PENDING["count"] = 99

        app_ids, centers = handler._load_config(["A"])

        self.assertEqual(app_ids, ["msight-demo"])
        self.assertEqual(centers["A"], (42.0, -83.0))

    def test_once_the_grace_is_spent_it_raises_instead_of_serving_ancient_config(self):
        long_ago = time.monotonic() - 1000
        handler._apps_cache._entries["spat_app_ids"] = (["old-app"], long_ago, long_ago)
        FAILURES_PENDING["count"] = 99

        with self.assertRaises(FakePgError):
            handler._load_config(["A"])

    def test_the_config_query_asks_for_both_lookups_at_once(self):
        handler._load_config(["A"])
        sql = QUERY_LOG[-1][0]
        # One statement, both lookups — this is what makes it a single round trip.
        self.assertIn("FROM apps", sql)
        self.assertIn("FROM maps", sql)
        self.assertEqual(sql.count("SELECT"), 3)  # outer + two subselects


if __name__ == "__main__":
    unittest.main(verbosity=2)
