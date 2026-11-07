"""Retry only API responses known to have failed before SQL execution."""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")
TRANSIENT_CODES = frozenset({"API_UNAVAILABLE"})
DEFAULT_DELAYS = (0.5, 1.0, 2.0)


def is_transient_error(exc: BaseException) -> bool:
    """True only for an explicit pre-execution API-unavailable response."""
    return getattr(exc, "code", None) in TRANSIENT_CODES


def run_with_retry(operation: Callable[[], T], *, delays: tuple[float, ...] = DEFAULT_DELAYS) -> T:
    """Retry a fresh request only when the API guarantees SQL was not started."""
    for attempt in range(len(delays) + 1):
        try:
            return operation()
        except Exception as exc:
            if not is_transient_error(exc) or attempt == len(delays):
                raise
            time.sleep(delays[attempt])
    raise AssertionError("unreachable")
