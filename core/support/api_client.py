"""Authenticated client for the project's self-hosted PostgreSQL API.

The small table/RPC builder intentionally preserves the call shape used by the
Discord cogs, but sends requests only to our own ``/v1`` API. It does not import
or depend on Supabase libraries or PostgREST.
"""
from __future__ import annotations

import datetime as _datetime
import decimal
import json
import os
import threading
import uuid
from dataclasses import dataclass
from typing import Any

import requests

#: BOT_API_BASE_URL / BOT_API_KEY が未設定で API を使えないときの文（利用側 cog と共用）。
API_NOT_CONFIGURED_MESSAGE = "BOT_API_BASE_URL または BOT_API_KEY が設定されていません"


@dataclass
class APIResponse:
    data: Any


class APIError(RuntimeError):
    def __init__(self, message: str, *, code: str = "API_ERROR", status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


#: APIError.code used when the self-hosted DB API could not be reached at all
#: (connection refused, DNS failure, timeout, ...), as opposed to the API
#: answering with an error.
API_CONNECTION_ERROR_CODE = "API_CONNECTION_ERROR"


def is_connection_error(exc: BaseException) -> bool:
    """True when *exc* means the DB API was unreachable.

    The API service is restarted by the deploy automation whenever ``api/``
    changes, so a brief connection failure is expected and self-healing:
    periodic workers log it as a one-line warning (no traceback) and simply
    retry on their next cycle, while every other failure keeps the usual
    error log with a traceback.
    """
    return isinstance(exc, APIError) and exc.code == API_CONNECTION_ERROR_CODE


def _json_default(value: Any) -> Any:
    if isinstance(value, (_datetime.datetime, _datetime.date, _datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


class _Query:
    def __init__(self, client: "APIClient", table: str):
        self.client = client
        self.payload: dict[str, Any] = {"table": table, "action": "select", "columns": "*", "filters": [], "order": []}

    def select(self, columns: str = "*", **_kwargs: Any) -> "_Query":
        self.payload["columns"] = columns
        return self

    def insert(self, values: Any, **_kwargs: Any) -> "_Query":
        self.payload.update(action="insert", values=values)
        return self

    def upsert(self, values: Any, *, on_conflict: str | None = None, **_kwargs: Any) -> "_Query":
        self.payload.update(action="upsert", values=values, on_conflict=on_conflict)
        return self

    def update(self, values: dict[str, Any], **_kwargs: Any) -> "_Query":
        self.payload.update(action="update", values=values)
        return self

    def delete(self, **_kwargs: Any) -> "_Query":
        self.payload["action"] = "delete"
        return self

    def _filter(self, column: str, operator: str, value: Any) -> "_Query":
        self.payload["filters"].append({"column": column, "op": operator, "value": value})
        return self

    def eq(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "eq", value)

    def neq(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "neq", value)

    def gt(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "gt", value)

    def gte(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "gte", value)

    def lt(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "lt", value)

    def lte(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "lte", value)

    def like(self, column: str, value: str) -> "_Query":
        return self._filter(column, "like", value)

    def ilike(self, column: str, value: str) -> "_Query":
        return self._filter(column, "ilike", value)

    def contains(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "contains", value)

    def is_(self, column: str, value: Any) -> "_Query":
        return self._filter(column, "is", value)

    def in_(self, column: str, values: list[Any] | tuple[Any, ...]) -> "_Query":
        return self._filter(column, "in", list(values))

    def order(self, column: str, *, desc: bool = False, **_kwargs: Any) -> "_Query":
        self.payload["order"].append({"column": column, "desc": bool(desc)})
        return self

    def limit(self, count: int, **_kwargs: Any) -> "_Query":
        self.payload["limit"] = int(count)
        return self

    def range(self, start: int, end: int, **_kwargs: Any) -> "_Query":
        start, end = int(start), int(end)
        if start < 0 or end < start:
            raise ValueError("range must have start >= 0 and end >= start")
        self.payload["offset"] = start
        self.payload["limit"] = end - start + 1
        return self

    def execute(self) -> APIResponse:
        return self.client._execute("/v1/query", self.payload)


class _RPC:
    def __init__(self, client: "APIClient", name: str, params: dict[str, Any] | None):
        self.client = client
        self.name = name
        self.params = params or {}

    def execute(self) -> APIResponse:
        return self.client._execute("/v1/rpc", {"name": self.name, "params": self.params})


class APIClient:
    def __init__(self, base_url: str, api_key: str, *, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def table(self, name: str) -> _Query:
        return _Query(self, name)

    def rpc(self, name: str, params: dict[str, Any] | None = None) -> _RPC:
        return _RPC(self, name, params)

    def _execute(self, path: str, payload: dict[str, Any]) -> APIResponse:
        try:
            response = requests.post(
                f"{self.base_url}{path}",
                data=json.dumps(payload, ensure_ascii=False, default=_json_default),
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            # A timeout may occur after PostgreSQL committed, so never mark an
            # ambiguous transport failure as safe for automatic write retries.
            raise APIError("自前DB APIに接続できません", code=API_CONNECTION_ERROR_CODE) from exc

        try:
            body = response.json()
        except ValueError:
            body = {}
        if not response.ok:
            detail = body.get("detail", {}) if isinstance(body, dict) else {}
            if isinstance(detail, str):
                message, code = detail, "API_ERROR"
            elif isinstance(detail, dict):
                message = str(detail.get("message", "DB API request failed"))
                code = str(detail.get("code", "API_ERROR"))
            else:
                message, code = "DB API request failed", "API_ERROR"
            raise APIError(message, code=code, status_code=response.status_code)
        data = body.get("data", []) if isinstance(body, dict) else []
        return APIResponse(data=data)


_lock = threading.Lock()
_client: APIClient | None = None
_client_ready = False


def create_client_from_env(env: dict[str, str] | None = None) -> APIClient | None:
    env = os.environ if env is None else env
    base_url = (env.get("BOT_API_BASE_URL") or "").strip()
    api_key = (env.get("BOT_API_KEY") or "").strip()
    if not base_url or not api_key:
        return None
    timeout = float(env.get("BOT_API_TIMEOUT", "10"))
    return APIClient(base_url, api_key, timeout=timeout)


def get_client() -> APIClient | None:
    global _client, _client_ready
    with _lock:
        if not _client_ready:
            _client = create_client_from_env()
            _client_ready = True
        return _client


def _reset_for_tests() -> None:
    global _client, _client_ready
    with _lock:
        _client, _client_ready = None, False
