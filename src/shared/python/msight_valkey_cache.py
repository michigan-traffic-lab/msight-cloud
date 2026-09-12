"""Configuration cached in Valkey, shared by every container of a function.

Why this exists
---------------
`msight_config_cache` removed most of the database round trips from the SPaT
path by caching configuration *per container*. What it cannot remove is the
first read of every container: with the feed at roughly 10 Hz per sensor,
Lambda keeps enough containers warm that the fleet still reaches Aurora once per
TTL *per container*, and — more expensively — each container holds a connection
open for the whole of its life to make that one query a minute. Observed: ~198
client connections against a database ceiling of about 112 at the 0.5 ACU
floor, which is why an RDS Proxy sits in front of it at $87/month.

This is the second tier. One container's read fills a value that every other
container can use, so the fleet touches Aurora about once per TTL in total
rather than once per TTL each. Valkey is already connected on this path for the
rate limiter, so it costs no new connection and no new infrastructure.

The three things that make a shared cache different
---------------------------------------------------
1. **Stampede.** A per-container cache can scatter its refreshes with jitter
   because each container holds its own copy. A shared key expires *once*, for
   everybody, and every container misses in the same instant — which is the
   spike the caching was meant to remove, concentrated. So a value is never
   simply evicted: it carries its own refresh point, the Valkey TTL is much
   longer, and exactly one container is let through to reload it while the rest
   keep serving what is already there.

2. **Serving while refreshing.** Because the value outlives its refresh point,
   a reader past that point has something to return. Refresh is therefore never
   on the critical path of a message: the winner reloads, everyone else carries
   on with a value that is at most one TTL old.

3. **Valkey failing must not stop traffic.** Every operation here degrades to
   "cache miss" on any error, so a cache outage costs round trips rather than
   messages. The caller keeps its own in-memory tier and its Aurora path, and
   both still work with this tier removed entirely.

Key naming
----------
`MSight:<service>:<cache>` for a single value, `MSight:<service>:<cache>:<member>`
for a keyed one, where `<service>` is the function's own SERVICE_NAME. The
prefix keeps one function's configuration out of another's — the two SPaT
consumers read the same tables through different filters, and a shared key
would hand each the other's answer.
"""

from __future__ import annotations

import json
import time

#: Everything this platform writes to Valkey sits under one root.
NAMESPACE = "MSight"

#: How much longer than its refresh point a value survives in Valkey.
#:
#: This is the window in which a value can still be served while somebody
#: reloads it, and the window in which an Aurora outage costs freshness instead
#: of traffic. Ten times the TTL: long enough to ride out a failover, short
#: enough that nothing is served from a configuration nobody has confirmed for
#: a quarter of an hour at a one-minute TTL.
DEFAULT_HARD_TTL_MULTIPLIER = 10

#: How often one container may report the same kind of cache failure.
#:
#: Not politeness — cost. This path runs at roughly 40 messages a second per
#: function, and a Valkey outage makes *every* operation on *every* message
#: fail. Reporting each one would turn a degraded cache into thousands of log
#: lines a second, which on CloudWatch is a larger bill than the database this
#: cache exists to protect. One line per operation per minute says the same
#: thing.
DEFAULT_REPORT_EVERY_S = 60.0

#: How long one container may hold the right to refresh a value.
#:
#: Short, because it is only insurance against a stampede: if the winner dies
#: mid-reload the lock has to expire soon enough that the next reader retries
#: rather than serving an ageing value until its hard TTL runs out.
DEFAULT_LOCK_S = 10.0


class ValkeyConfigCache:
    """A shared, keyed cache with stale-while-revalidate and single flight.

    The API mirrors `ConfigCache` — read many, write many — for the same reason
    it does there: the caller satisfies every miss in one database statement,
    and an API that loaded one key at a time would force one statement per key.
    """

    __slots__ = (
        "_service",
        "_redis_factory",
        "_ttl_s",
        "_hard_ttl_s",
        "_lock_s",
        "_on_error",
        "_report_every_s",
        "_reported_at",
    )

    def __init__(
        self,
        service_name: str,
        redis_factory,
        *,
        ttl_s: float,
        hard_ttl_s: float | None = None,
        lock_s: float = DEFAULT_LOCK_S,
        on_error=None,
        report_every_s: float = DEFAULT_REPORT_EVERY_S,
    ) -> None:
        if not service_name:
            raise ValueError("service_name is required: it namespaces the keys")
        if ttl_s <= 0:
            raise ValueError("ttl_s must be positive")

        self._service = service_name
        # A factory rather than a client, so this module never owns the
        # connection: the caller already has one for the rate limiter and its
        # reconnect logic stays in one place.
        self._redis_factory = redis_factory
        self._ttl_s = float(ttl_s)
        self._hard_ttl_s = (
            float(hard_ttl_s) if hard_ttl_s is not None else float(ttl_s) * DEFAULT_HARD_TTL_MULTIPLIER
        )
        self._lock_s = float(lock_s)
        # Errors are reported, never raised: this tier is an optimisation and
        # must not be able to stop a message.
        self._on_error = on_error
        self._report_every_s = float(report_every_s)
        self._reported_at: dict[str, float] = {}

    # ---- keys ------------------------------------------------------------

    def key(self, cache_name: str, member: str | None = None) -> str:
        """`MSight:<service>:<cache>` or `MSight:<service>:<cache>:<member>`."""
        base = f"{NAMESPACE}:{self._service}:{cache_name}"
        return base if member is None else f"{base}:{member}"

    def _lock_key(self, cache_name: str) -> str:
        return f"{NAMESPACE}:{self._service}:{cache_name}:refresh-lock"

    # ---- internals -------------------------------------------------------

    def _report(self, operation: str, error: Exception) -> None:
        """Report at most one failure per operation per window.

        Throttled per operation rather than globally so a single broken call
        cannot mask a different one that starts failing beside it.
        """
        if self._on_error is None:
            return
        now = time.monotonic()
        last = self._reported_at.get(operation)
        if last is not None and now - last < self._report_every_s:
            return
        self._reported_at[operation] = now
        self._on_error(operation, error)

    def _encode(self, value) -> str:
        # The refresh point travels with the value, so a reader can tell
        # "usable" from "usable but somebody should reload it" without a second
        # key and without trusting its own clock against the writer's TTL.
        return json.dumps({"v": value, "r": time.time() + self._ttl_s}, separators=(",", ":"))

    @staticmethod
    def _decode(raw):
        """Return (found, value, refresh_at). A malformed entry reads as absent."""
        if raw is None:
            return False, None, 0.0
        try:
            payload = json.loads(raw)
            return True, payload["v"], float(payload["r"])
        except (ValueError, TypeError, KeyError):
            return False, None, 0.0

    # ---- reads -----------------------------------------------------------

    def read_many(self, cache_name: str, members):
        """Split `members` into what Valkey can serve and what it cannot.

        Returns `(fresh, stale, missing)`:

          * `fresh`   — value is present and inside its refresh window.
          * `stale`   — value is present but due a reload. Usable now; somebody
                        should refresh it, which `claim_refresh` decides.
          * `missing` — nothing cached, so only the database can answer.

        `None` is a value like any other here: an intersection that does not
        exist is worth caching precisely because every message names it.
        """
        members = list(members)
        if not members:
            return {}, {}, []

        try:
            client = self._redis_factory()
            raw_values = client.mget([self.key(cache_name, member) for member in members])
        except Exception as error:  # noqa: BLE001 - a cache miss, not a failure
            self._report("mget", error)
            return {}, {}, members

        now = time.time()
        fresh: dict = {}
        stale: dict = {}
        missing: list = []

        for member, raw in zip(members, raw_values):
            found, value, refresh_at = self._decode(raw)
            if not found:
                missing.append(member)
            elif now < refresh_at:
                fresh[member] = value
            else:
                stale[member] = value

        return fresh, stale, missing

    def read_one(self, cache_name: str):
        """The single-value form. Returns `(state, value)`.

        `state` is 'fresh', 'stale' or 'missing' — three outcomes rather than a
        boolean, because the caller treats them differently: fresh is used,
        stale is used *and* triggers a reload, missing must be loaded before
        anything can be answered.
        """
        try:
            client = self._redis_factory()
            raw = client.get(self.key(cache_name))
        except Exception as error:  # noqa: BLE001
            self._report("get", error)
            return "missing", None

        found, value, refresh_at = self._decode(raw)
        if not found:
            return "missing", None
        return ("fresh" if time.time() < refresh_at else "stale"), value

    # ---- writes ----------------------------------------------------------

    def write_many(self, cache_name: str, items: dict) -> None:
        """Store several values, each with the same refresh point and TTL."""
        if not items:
            return
        try:
            client = self._redis_factory()
            pipe = client.pipeline()
            for member, value in items.items():
                pipe.set(self.key(cache_name, member), self._encode(value), ex=int(self._hard_ttl_s))
            pipe.execute()
        except Exception as error:  # noqa: BLE001
            self._report("set_many", error)

    def write_one(self, cache_name: str, value) -> None:
        try:
            client = self._redis_factory()
            client.set(self.key(cache_name), self._encode(value), ex=int(self._hard_ttl_s))
        except Exception as error:  # noqa: BLE001
            self._report("set", error)

    # ---- single flight ---------------------------------------------------

    def claim_refresh(self, cache_name: str) -> bool:
        """Win the right to reload this cache, or decline.

        `SET NX EX` is the whole mechanism: the first container to ask gets
        True and goes to Aurora, every other container gets False and serves
        what it already has. Without it, a value reaching its refresh point
        sends the entire fleet to the database at once — the stampede that a
        shared cache creates and a per-container one cannot.

        Fails open. If Valkey cannot answer, the caller reloads: duplicated
        work is the right failure here, and a silent refusal would freeze the
        configuration at whatever it last was.
        """
        try:
            client = self._redis_factory()
            return bool(client.set(self._lock_key(cache_name), "1", nx=True, ex=int(self._lock_s)))
        except Exception as error:  # noqa: BLE001
            self._report("claim", error)
            return True

    def release_refresh(self, cache_name: str) -> None:
        """Drop the claim early, so a failed reload can be retried at once."""
        try:
            self._redis_factory().delete(self._lock_key(cache_name))
        except Exception as error:  # noqa: BLE001
            self._report("release", error)

    # ---- invalidation ----------------------------------------------------

    def invalidate(self, cache_name: str, members=None) -> None:
        """Drop cached values so the next read reloads them.

        Nothing calls this on the hot path. It exists for the console: an edit
        to `apps` or `maps` can delete the key and be visible everywhere in a
        round trip instead of a TTL.
        """
        try:
            client = self._redis_factory()
            if members is None:
                client.delete(self.key(cache_name))
            else:
                keys = [self.key(cache_name, member) for member in members]
                if keys:
                    client.delete(*keys)
        except Exception as error:  # noqa: BLE001
            self._report("invalidate", error)
