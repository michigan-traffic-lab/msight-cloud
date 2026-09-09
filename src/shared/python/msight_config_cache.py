"""Per-container configuration cache with a randomised refresh point.

Why this exists
---------------
The SPaT hot path needs two pieces of *configuration* per message: which apps
want SPaT, and where each intersection is. Both change only when a human edits
a row. Queried once per message at roughly 10 Hz per sensor across many
concurrent Lambda containers, they held Aurora at ~118 connections with
capacity pinned near its 2 ACU ceiling and average query latency above one
second. Aurora Serverless bills per ACU-hour, so that query volume *was* most
of the database bill.

Caching the two lookups per container is the fix, but a plain fixed-TTL cache
brings two failure modes of its own, and handling them is this module's whole
job:

  * Synchronised expiry. Containers that cache at the same moment with the same
    TTL expire at the same moment, so the load the cache was meant to spread
    arrives as a spike every TTL seconds. On Aurora Serverless a spike is
    precisely what triggers a scale-up, and scale-up is what costs money — so a
    synchronised cache can leave the bill almost unchanged.

  * A container pinned to an old value. If a container could decide to keep
    reusing what it has, it might never go back to the database, and an edit to
    `apps` or `maps` would never reach it.

Both are solved by drawing a *refresh point* at random, once, when a value is
stored: somewhere inside `ttl_s * [1 - jitter, 1 + jitter]`. No two containers
agree on when to refresh, so refreshes scatter across the window instead of
arriving together; and because the point is always finite and always in the
past eventually, no container can pin a value indefinitely.

Why the refresh point is drawn once, not rolled per read
--------------------------------------------------------
The obvious alternative — on each read, refresh with some probability — is
wrong here, and the reason is worth recording. Its refresh rate scales with the
*read* rate, and this path reads about ten times a second per sensor. Any
probability high enough to matter under light traffic refreshes almost
immediately under real traffic, which is the behaviour being paid to avoid.
Drawing the point once per stored value makes the refresh interval a property
of the data's age rather than of how often it happens to be read.

Staleness is the price, and `ttl_s` is the bound: an edit takes up to
`ttl_s * (1 + jitter)` to become visible in every container.

Serving stale on failure
------------------------
Past its refresh point a value must be reloaded before it can be used. If that
reload fails, `stale()` offers the old value so a database blip degrades
freshness instead of dropping live traffic. That grace is itself bounded by
`max_stale_s`; beyond it `stale()` returns nothing and the caller must fail,
which is what stops a long outage from broadcasting badly wrong data.
"""

from __future__ import annotations

import random
import time


class ConfigCache:
    """A keyed cache whose entries each pick their own refresh moment.

    The API is deliberately split into "is this usable as-is" (`fresh`) and
    "store this" (`put`) rather than the usual `get(key, loader)`. That is what
    lets a caller collect every key it is missing and satisfy them all in a
    single database round trip — see `_load_config` in the SPaT consumers. A
    loader-per-key API forces one round trip per key, which is the cost this
    module exists to remove.
    """

    __slots__ = ("_ttl_s", "_jitter", "_max_stale_s", "_entries")

    def __init__(
        self,
        ttl_s: float,
        *,
        jitter: float = 0.25,
        max_stale_s: float | None = None,
    ) -> None:
        if ttl_s <= 0:
            raise ValueError("ttl_s must be positive")
        if not 0.0 <= jitter < 1.0:
            raise ValueError("jitter must be in [0, 1)")

        self._ttl_s = float(ttl_s)
        self._jitter = float(jitter)
        # Default grace on database failure is one extra TTL: long enough to
        # ride out a failover, short enough that nobody is acting on very old
        # configuration without knowing it.
        self._max_stale_s = float(max_stale_s) if max_stale_s is not None else float(ttl_s)
        # key -> (value, refresh_at, give_up_at)
        self._entries: dict[str, tuple[object, float, float]] = {}

    # ---- internals -------------------------------------------------------

    def _draw_refresh_at(self, now: float) -> float:
        """Pick this entry's refresh moment, uniform over the jitter window."""
        low = self._ttl_s * (1.0 - self._jitter)
        high = self._ttl_s * (1.0 + self._jitter)
        return now + random.uniform(low, high)

    # ---- reads -----------------------------------------------------------

    def fresh(self, key: str) -> tuple[bool, object]:
        """Return (True, value) if `key` needs no database round trip.

        (False, None) means the caller must reload it — either nothing is
        cached or the entry has reached its refresh point.
        """
        entry = self._entries.get(key)
        if entry is None:
            return False, None

        value, refresh_at, _ = entry
        if time.monotonic() < refresh_at:
            return True, value
        return False, None

    def stale(self, key: str) -> tuple[bool, object]:
        """Return (True, value) for a past-refresh entry still inside its grace.

        Only for use when a reload has just failed. Returns (False, None) once
        `max_stale_s` has elapsed past the refresh point, so an extended outage
        surfaces as an error rather than as silently ancient configuration.
        """
        entry = self._entries.get(key)
        if entry is None:
            return False, None

        value, _, give_up_at = entry
        if time.monotonic() < give_up_at:
            return True, value
        return False, None

    # ---- writes ----------------------------------------------------------

    def put(self, key: str, value: object) -> None:
        """Store `value`, drawing a fresh random refresh point for it."""
        now = time.monotonic()
        refresh_at = self._draw_refresh_at(now)
        self._entries[key] = (value, refresh_at, refresh_at + self._max_stale_s)

    def put_many(self, items: dict[str, object]) -> None:
        """Store several values, each with its own independent refresh point."""
        for key, value in items.items():
            self.put(key, value)

    def missing(self, keys) -> list[str]:
        """Return the subset of `keys` that `fresh()` cannot serve.

        Order-preserving and de-duplicated, so the result can go straight into
        one `= ANY(...)` query.
        """
        seen: set[str] = set()
        out: list[str] = []
        for key in keys:
            if key in seen:
                continue
            seen.add(key)
            if not self.fresh(key)[0]:
                out.append(key)
        return out

    # ---- introspection ---------------------------------------------------

    def stats(self) -> dict:
        """Counts for a log line: how many entries are held, how many usable."""
        now = time.monotonic()
        fresh_count = sum(1 for (_, refresh_at, _) in self._entries.values() if now < refresh_at)
        return {
            "entries": len(self._entries),
            "fresh": fresh_count,
            "ttl_s": self._ttl_s,
            "jitter": self._jitter,
        }
