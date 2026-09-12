"""What the Valkey tier is worth, measured through the real handler.

The claim being tested is the one the RDS Proxy decision rests on: with a tier
shared between containers, the number of containers stops deciding the number
of database connections. One container fills the cache; every other container
that starts afterwards is served without touching Aurora at all.

The assertions are on statements reaching the database, because that number is
the cost — of connections, of ACU, and therefore of the proxy.

Standard library only, like its neighbours: psycopg2, redis, boto3 and the
V2X decoder are all stubbed before the handler is imported.
"""

from __future__ import annotations

import importlib
import json
import os
import pathlib
import sys
import types
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src" / "shared" / "python"))


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakePgError(Exception):
    """Stands in for psycopg2.Error."""


#: Every statement that reached the fake database.
QUERY_LOG: list[dict | None] = []


class _FakeCursor:
    def __init__(self) -> None:
        self._row: tuple | None = None

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def execute(self, _sql: str, params: dict | None = None) -> None:
        QUERY_LOG.append(params)
        names = (params or {}).get("names") or []
        self._row = (
            ["msight-demo"],
            [{"name": name, "lat": 42.0, "lon": -83.0} for name in names],
        )

    def fetchone(self) -> tuple | None:
        return self._row


#: Connections opened and closed, so a test can assert none is left held.
OPEN_CONNECTIONS = {"count": 0}


class _FakeConnection:
    autocommit = False

    def __init__(self) -> None:
        self.closed = 0
        OPEN_CONNECTIONS["count"] += 1

    def cursor(self) -> _FakeCursor:
        return _FakeCursor()

    def close(self) -> None:
        if not self.closed:
            self.closed = 1
            OPEN_CONNECTIONS["count"] -= 1


class SharedValkey:
    """One Valkey, shared by every simulated container — as in production."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def get(self, key):
        return self.store.get(key)

    def mget(self, keys):
        return [self.store.get(key) for key in keys]

    def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)
        return len(keys)

    def pipeline(self):
        return _Pipeline(self)


class _Pipeline:
    def __init__(self, client: SharedValkey) -> None:
        self._client = client
        self._queued: list[tuple] = []

    def set(self, key, value, ex=None):
        self._queued.append((key, value))
        return self

    def execute(self):
        for key, value in self._queued:
            self._client.store[key] = value
        self._queued = []


VALKEY = SharedValkey()


def _install_driver_stubs() -> None:
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.Error = FakePgError
    psycopg2.connect = lambda **_kwargs: _FakeConnection()
    sys.modules["psycopg2"] = psycopg2

    redis_module = types.ModuleType("redis")
    redis_module.Redis = lambda **_kwargs: VALKEY
    sys.modules["redis"] = redis_module

    class _SecretsManager:
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


def fresh_container():
    """A newly started Lambda container: new module state, same Valkey.

    Reloading the module is what makes this test meaningful — the in-memory
    tier is module-level, so a container that has never run has an empty one
    and must be served by Valkey or by Aurora.
    """
    import handler  # noqa: PLC0415

    return importlib.reload(handler)


class SharedTierAcrossContainers(unittest.TestCase):
    def setUp(self) -> None:
        QUERY_LOG.clear()
        VALKEY.store.clear()

    def test_one_container_pays_for_the_whole_fleet(self):
        """The headline claim, and the reason the proxy can go.

        Fifty containers start, as they do after a deploy. Before the shared
        tier every one of them opened a connection and ran this statement;
        fifty connections against a ceiling of about 112 is half the database's
        capacity spent on one row of configuration.
        """
        first = fresh_container()
        first._load_config(["1037_Ellsworth"])
        self.assertEqual(len(QUERY_LOG), 1, "the first container must load it")

        for _ in range(49):
            container = fresh_container()
            app_ids, centers = container._load_config(["1037_Ellsworth"])
            # Served, and correct — not merely skipped.
            self.assertEqual(app_ids, ["msight-demo"])
            self.assertEqual(list(centers["1037_Ellsworth"]), [42.0, -83.0])

        self.assertEqual(
            len(QUERY_LOG), 1, "no container after the first may reach the database"
        )

    def test_a_container_never_re_reads_within_its_own_ttl(self):
        """The in-memory tier still does its job: Valkey is for cold
        containers, not for every message."""
        container = fresh_container()
        for _ in range(200):
            container._load_config(["1037_Ellsworth"])
        self.assertEqual(len(QUERY_LOG), 1)

    def test_a_new_intersection_costs_one_statement_for_the_fleet(self):
        first = fresh_container()
        first._load_config(["A"])
        QUERY_LOG.clear()

        # A sensor starts reporting a second intersection. One container
        # resolves it; the rest are served from Valkey.
        second = fresh_container()
        second._load_config(["A", "B"])
        self.assertEqual(len(QUERY_LOG), 1)
        # Only the genuinely new one is asked for. "A" is already in the
        # shared tier, so a cold container inherits it rather than putting it
        # back into a statement that would otherwise grow with every
        # intersection a sensor has ever named.
        self.assertEqual(QUERY_LOG[0]["names"], ["B"])

        QUERY_LOG.clear()
        for _ in range(10):
            fresh_container()._load_config(["A", "B"])
        self.assertEqual(len(QUERY_LOG), 0)

    def test_keys_are_written_under_the_platform_namespace(self):
        fresh_container()._load_config(["1037_Ellsworth"])

        self.assertIn("MSight:spat-sns-consumer:app_ids", VALKEY.store)
        self.assertIn(
            "MSight:spat-sns-consumer:map_centers:1037_Ellsworth", VALKEY.store
        )
        # And the payload carries its own refresh point, which is what lets a
        # reader serve a value while somebody else reloads it.
        payload = json.loads(VALKEY.store["MSight:spat-sns-consumer:app_ids"])
        self.assertEqual(payload["v"], ["msight-demo"])
        self.assertIn("r", payload)


class ConnectionsAreNotHeld(unittest.TestCase):
    """The property that makes running without an RDS Proxy safe.

    A container must hold a connection for the length of one query, not for the
    length of its life. Before this, the warm fleet reached ~198 connections
    against a ceiling near 112 — which is what the proxy was paid to absorb.
    """

    def setUp(self) -> None:
        QUERY_LOG.clear()
        VALKEY.store.clear()
        OPEN_CONNECTIONS["count"] = 0

    def test_nothing_is_left_open_after_a_query(self):
        container = fresh_container()
        container._load_config(["1037_Ellsworth"])

        self.assertEqual(len(QUERY_LOG), 1, "it really did query")
        self.assertEqual(OPEN_CONNECTIONS["count"], 0)

    def test_a_whole_fleet_holds_nothing_even_with_valkey_down(self):
        """The failure that would otherwise strand a proxy-less database.

        With Valkey unreachable every container falls through to Aurora, which
        is exactly the old behaviour — but now each one lets go again.
        """
        class Broken:
            def __getattr__(self, _name):
                def fail(*_args, **_kwargs):
                    raise RuntimeError("valkey unreachable")

                return fail

        sys.modules["redis"].Redis = lambda **_kwargs: Broken()
        try:
            for _ in range(50):
                fresh_container()._load_config(["1037_Ellsworth"])

            self.assertEqual(len(QUERY_LOG), 50, "every container had to ask")
            self.assertEqual(
                OPEN_CONNECTIONS["count"], 0, "and none of them kept the connection"
            )
        finally:
            sys.modules["redis"].Redis = lambda **_kwargs: VALKEY


class ValkeyUnavailable(unittest.TestCase):
    """The tier is an optimisation. Without it, behaviour is exactly as before."""

    def setUp(self) -> None:
        QUERY_LOG.clear()
        VALKEY.store.clear()

    def test_traffic_is_served_when_valkey_refuses_everything(self):
        class Broken:
            def __getattr__(self, _name):
                def fail(*_args, **_kwargs):
                    raise RuntimeError("valkey unreachable")

                return fail

        sys.modules["redis"].Redis = lambda **_kwargs: Broken()
        try:
            container = fresh_container()
            app_ids, centers = container._load_config(["1037_Ellsworth"])

            self.assertEqual(app_ids, ["msight-demo"])
            self.assertEqual(list(centers["1037_Ellsworth"]), [42.0, -83.0])
            # It fell through to Aurora, which is the pre-existing behaviour.
            self.assertEqual(len(QUERY_LOG), 1)
        finally:
            sys.modules["redis"].Redis = lambda **_kwargs: VALKEY


if __name__ == "__main__":
    unittest.main()
