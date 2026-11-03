"""Small retry helper for transient Supabase/PostgREST failures."""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar


T = TypeVar("T")
TRANSIENT_CODES = frozenset({"PGRST002"})
DEFAULT_DELAYS = (0.5, 1.0, 2.0)


def is_transient_error(exc: BaseException) -> bool:
    """Return whether PostgREST is asking the client to retry the request."""
    code = getattr(exc, "code", None)
    if code in TRANSIENT_CODES:
        return True
    # Keep this compatible with APIError-like exceptions used by older clients
    # and the lightweight fakes in the test suite.
    if isinstance(exc.args[0] if exc.args else None, dict):
        return exc.args[0].get("code") in TRANSIENT_CODES
    return False


def run_with_retry(
    operation: Callable[[], T],
    *,
    delays: tuple[float, ...] = DEFAULT_DELAYS,
) -> T:
    """Run a synchronous Supabase operation, retrying only PGRST002 failures.

    The callable is deliberately invoked again for each attempt so callers can
    rebuild a fresh PostgREST request builder rather than reusing a failed one.
    This function is intended to run in a worker thread.
    """
    for attempt in range(len(delays) + 1):
        try:
            return operation()
        except Exception as exc:
            if not is_transient_error(exc) or attempt == len(delays):
                raise
            time.sleep(delays[attempt])
    raise AssertionError("unreachable")
