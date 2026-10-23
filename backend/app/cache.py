"""Kleiner TTL-Cache für Abfragen an Dashboard und Hermes: Single-Flight, veraltete Antwort bei Fehlern.

- Gleichzeitige Abfragen mit demselben Schlüssel teilen sich eine Anfrage (Single-Flight).
- Frisch (< ttl): aus dem Speicher. Abgelaufen: neu laden; schlägt das fehl und ist der Stand jünger als `stale_max`,
  kommt der alte Stand mit `stale=True` zurück (stale-if-error), sonst der Fehler.
- Die Anfrage läuft als eigene Task: bricht ein Wartender ab (Zeitlimit), läuft sie weiter und füllt den Cache.
"""
from __future__ import annotations

import asyncio
import copy
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .adapters import UpstreamError


class TtlCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._data: dict[Any, tuple[float, Any]] = {}
        self._flights: dict[Any, asyncio.Task] = {}
        self._gen = 0  # zählt Invalidierungen: eine Antwort, die davor gestartet wurde, darf nicht mehr gespeichert werden

    async def get(self, key: Any, ttl: float, load: Callable[[], Awaitable[Any]], *, stale_max: float = 0.0) -> tuple[Any, bool]:
        """Gibt (Wert, veraltet) zurück. Der Wert ist eine Kopie: Aufrufer dürfen ihn verändern."""
        hit = self._data.get(key)
        now = self._clock()
        if hit and now - hit[0] < ttl:
            return copy.deepcopy(hit[1]), False
        flight = self._flights.get(key)
        if flight is None:
            flight = self._flights[key] = asyncio.ensure_future(self._fill(key, load, self._gen))
        try:
            return copy.deepcopy(await asyncio.shield(flight)), False
        except UpstreamError:
            if hit and now - hit[0] < stale_max:
                return copy.deepcopy(hit[1]), True
            raise

    async def _fill(self, key: Any, load: Callable[[], Awaitable[Any]], gen: int) -> Any:
        try:
            value = await load()
            if gen == self._gen:
                self._data[key] = (self._clock(), value)
            return value
        finally:
            self._flights.pop(key, None)

    def invalidate(self, match: Callable[[Any], bool] = lambda _k: True) -> None:
        self._gen += 1
        for k in [k for k in self._data if match(k)]:
            del self._data[k]
        for k in [k for k in self._flights if match(k)]:
            self._flights.pop(k)  # laufende Anfrage läuft aus, ihr Ergebnis wird wegen `_gen` nicht mehr gespeichert
