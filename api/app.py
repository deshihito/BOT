"""Private, allowlisted HTTP API for the local PostgreSQL instance."""
from __future__ import annotations

import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Json, Jsonb
from psycopg_pool import ConnectionPool, PoolTimeout

log = logging.getLogger(__name__)

# Only application tables used by the BOT are exposed. System and auth schemas
# are never addressable through this API.
TABLES = frozenset({
    "bot_kv", "users", "transaction_history",
    "dungeon_maps", "dungeon_players", "dungeon_bases",
    "nation_guilds", "nation_tiles", "nation_players",
    "bump_rta_settings", "bump_rta_records", "bump_rta_worst_records", "bump_rta_events",
    "bump_rta_pending", "bump_rta_reminders", "jinrou_ratings",
    "fujo_users", "fujo_activities", "playlists", "user_music_playlists",
    "party_game_ranking", "party_game_monthly_ranking",
    "luna_ai_memories", "luna_ai_turns",
})

# Callers may invoke only these known public functions and named arguments.
RPC_ARGUMENTS = {
    "transfer_coins": frozenset({"p_sender_id", "p_receiver_id", "p_amount", "p_new_user_balance"}),
    "dungeon_apply_coins": frozenset({"p_user_id", "p_delta"}),
    "nation_found": frozenset({"p_guild_id", "p_user_id"}),
    "nation_adjust": frozenset({"p_user_id", "p_coins_delta", "p_hunger_delta"}),
    "record_bump_rta_best": frozenset({"p_guild_id", "p_user_id", "p_event_type", "p_elapsed_ms", "p_completed_at"}),
    "record_bump_rta_worst": frozenset({"p_guild_id", "p_user_id", "p_event_type", "p_elapsed_ms", "p_completed_at"}),
    "get_bump_rta_global_ranking": frozenset({"p_event_type", "p_limit"}),
    "get_bump_rta_global_slowest_ranking": frozenset({"p_event_type", "p_limit"}),
    "party_game_record_win": frozenset({"p_guild_id", "p_user_id", "p_game"}),
}
RPC_SCALAR_RESULTS = frozenset({"transfer_coins", "dungeon_apply_coins", "nation_adjust", "party_game_record_win"})

FILTER_OPERATORS = frozenset({"eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "contains", "is", "in"})
MAX_LIMIT = 10_000
DEFAULT_LIMIT = 1_000


class Filter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str
    op: str
    value: Any = None


class Ordering(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str
    desc: bool = False


class QueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    table: str
    action: Literal["select", "insert", "upsert", "update", "delete"] = "select"
    columns: str | list[str] = "*"
    filters: list[Filter] = Field(default_factory=list, max_length=32)
    order: list[Ordering] = Field(default_factory=list, max_length=8)
    values: Any = None
    on_conflict: str | None = None
    limit: int | None = Field(default=None, ge=0, le=MAX_LIMIT)
    offset: int = Field(default=0, ge=0)


class RPCRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    params: dict[str, Any] = Field(default_factory=dict)


def _unauthorized(authorization: str | None) -> None:
    expected = os.environ.get("BOT_API_KEY", "")
    provided = authorization or ""
    if not expected or not provided.startswith("Bearer ") or not hmac.compare_digest(provided[7:], expected):
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "Invalid API credentials"})


def _columns(conn: psycopg.Connection, table: str) -> dict[str, str]:
    if table not in TABLES:
        raise HTTPException(status_code=404, detail={"code": "TABLE_NOT_ALLOWED", "message": "Table is not available through this API"})
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name, udt_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position",
            (table,),
        )
        found = {row["column_name"]: row["udt_name"] for row in cur.fetchall()}
    if not found:
        raise HTTPException(status_code=404, detail={"code": "TABLE_NOT_FOUND", "message": f"Public table {table!r} does not exist"})
    return found


def _primary_key(conn: psycopg.Connection, table: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc "
            "JOIN information_schema.key_column_usage kcu "
            "ON tc.constraint_catalog = kcu.constraint_catalog "
            "AND tc.constraint_schema = kcu.constraint_schema "
            "AND tc.constraint_name = kcu.constraint_name "
            "AND tc.table_name = kcu.table_name "
            "WHERE tc.table_schema = 'public' AND tc.table_name = %s "
            "AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position",
            (table,),
        )
        return [row["column_name"] for row in cur.fetchall()]


def _identifier(name: str, columns: dict[str, str]) -> sql.Identifier:
    if name not in columns:
        raise HTTPException(status_code=400, detail={"code": "INVALID_COLUMN", "message": f"Unknown column {name!r}"})
    return sql.Identifier(name)


def _adapt(value: Any, column: str, types: dict[str, str]) -> Any:
    if types.get(column) == "jsonb":
        return Jsonb(value)
    if types.get(column) == "json":
        return Json(value)
    return value


def _where(request: QueryRequest, types: dict[str, str]) -> tuple[sql.Composable, list[Any]]:
    clauses: list[sql.Composable] = []
    params: list[Any] = []
    operators = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "like": "LIKE", "ilike": "ILIKE"}
    for item in request.filters:
        if item.op not in FILTER_OPERATORS:
            raise HTTPException(status_code=400, detail={"code": "INVALID_OPERATOR", "message": f"Unsupported filter operator {item.op!r}"})
        col = _identifier(item.column, types)
        if item.op == "is":
            value = item.value
            normalized = value.lower() if isinstance(value, str) else value
            if normalized in (None, "null"):
                clauses.append(sql.SQL("{} IS NULL").format(col))
            elif normalized in (True, "true"):
                clauses.append(sql.SQL("{} IS TRUE").format(col))
            elif normalized in (False, "false"):
                clauses.append(sql.SQL("{} IS FALSE").format(col))
            else:
                raise HTTPException(status_code=400, detail={"code": "INVALID_FILTER", "message": "is accepts only null/true/false"})
        elif item.op in {"eq", "neq"} and item.value is None:
            clauses.append(sql.SQL("{} IS {}NULL").format(col, sql.SQL("NOT ") if item.op == "neq" else sql.SQL("")))
        elif item.op == "in":
            if not isinstance(item.value, list):
                raise HTTPException(status_code=400, detail={"code": "INVALID_FILTER", "message": "in requires an array"})
            if not item.value:
                clauses.append(sql.SQL("FALSE"))
            else:
                placeholders = sql.SQL(", ").join(sql.Placeholder() for _ in item.value)
                clauses.append(sql.SQL("{} IN ({})").format(col, placeholders))
                params.extend(_adapt(value, item.column, types) for value in item.value)
        elif item.op == "contains":
            clauses.append(sql.SQL("{} @> %s").format(col))
            params.append(_adapt(item.value, item.column, types))
        else:
            clauses.append(sql.SQL("{} {} %s").format(col, sql.SQL(operators[item.op])))
            params.append(_adapt(item.value, item.column, types))
    if not clauses:
        return sql.SQL(""), params
    return sql.SQL(" WHERE ") + sql.SQL(" AND ").join(clauses), params


def _selected_columns(value: str | list[str], types: dict[str, str]) -> sql.Composable:
    if value == "*" or value == ["*"]:
        return sql.SQL("*")
    names = value.split(",") if isinstance(value, str) else value
    names = [name.strip() for name in names]
    if not names or any(not name for name in names):
        raise HTTPException(status_code=400, detail={"code": "INVALID_COLUMNS", "message": "Invalid select columns"})
    return sql.SQL(", ").join(_identifier(name, types) for name in names)


def _execute_query(conn: psycopg.Connection, request: QueryRequest) -> list[dict[str, Any]]:
    types = _columns(conn, request.table)
    table = sql.Identifier("public", request.table)
    where, params = _where(request, types)
    action = request.action

    with conn.cursor(row_factory=dict_row) as cur:
        if action == "select":
            statement = sql.SQL("SELECT {} FROM {}{}").format(_selected_columns(request.columns, types), table, where)
            if request.order:
                orders = []
                for item in request.order:
                    orders.append(sql.SQL("{} {}").format(_identifier(item.column, types), sql.SQL("DESC" if item.desc else "ASC")))
                statement += sql.SQL(" ORDER BY ") + sql.SQL(", ").join(orders)
            statement += sql.SQL(" LIMIT %s OFFSET %s")
            cur.execute(statement, [*params, request.limit if request.limit is not None else DEFAULT_LIMIT, request.offset])
            return list(cur.fetchall())

        if action in {"update", "delete"} and not request.filters:
            raise HTTPException(status_code=400, detail={"code": "FILTER_REQUIRED", "message": "update/delete require at least one filter"})

        if action == "delete":
            cur.execute(sql.SQL("DELETE FROM {}{} RETURNING *").format(table, where), params)
            return list(cur.fetchall())

        if action == "update":
            if not isinstance(request.values, dict) or not request.values:
                raise HTTPException(status_code=400, detail={"code": "INVALID_VALUES", "message": "update requires a non-empty object"})
            assignments = []
            write_params = []
            for name, value in request.values.items():
                assignments.append(sql.SQL("{} = %s").format(_identifier(name, types)))
                write_params.append(_adapt(value, name, types))
            cur.execute(sql.SQL("UPDATE {} SET {}{} RETURNING *").format(table, sql.SQL(", ").join(assignments), where), [*write_params, *params])
            return list(cur.fetchall())

        records = request.values if isinstance(request.values, list) else [request.values]
        if not records or any(not isinstance(record, dict) or not record for record in records):
            raise HTTPException(status_code=400, detail={"code": "INVALID_VALUES", "message": "insert/upsert requires an object or non-empty array of objects"})
        names = list(records[0])
        if any(set(record) != set(names) for record in records):
            raise HTTPException(status_code=400, detail={"code": "INVALID_VALUES", "message": "All rows must have the same columns"})
        identifiers = [_identifier(name, types) for name in names]
        placeholders = sql.SQL(", ").join(sql.Placeholder() for _ in names)
        row_sql = sql.SQL("({})").format(placeholders)
        values_sql = sql.SQL(", ").join(row_sql for _ in records)
        insert_params = [_adapt(record[name], name, types) for record in records for name in names]
        statement = sql.SQL("INSERT INTO {} ({}) VALUES {}").format(table, sql.SQL(", ").join(identifiers), values_sql)
        if action == "upsert":
            conflicts = [name.strip() for name in (request.on_conflict or "").split(",") if name.strip()]
            if not conflicts:
                conflicts = _primary_key(conn, request.table)
            if not conflicts:
                raise HTTPException(status_code=400, detail={"code": "CONFLICT_REQUIRED", "message": "upsert requires on_conflict or a primary key"})
            conflict_ids = [_identifier(name, types) for name in conflicts]
            updates = [name for name in names if name not in conflicts]
            if updates:
                set_sql = sql.SQL(", ").join(
                    sql.SQL("{} = EXCLUDED.{}").format(_identifier(name, types), _identifier(name, types)) for name in updates
                )
                statement += sql.SQL(" ON CONFLICT ({}) DO UPDATE SET {}").format(sql.SQL(", ").join(conflict_ids), set_sql)
            else:
                statement += sql.SQL(" ON CONFLICT ({}) DO NOTHING").format(sql.SQL(", ").join(conflict_ids))
        elif action != "insert":
            raise HTTPException(status_code=400, detail={"code": "INVALID_ACTION", "message": "Unsupported action"})
        statement += sql.SQL(" RETURNING *")
        cur.execute(statement, insert_params)
        return list(cur.fetchall())


def _execute_rpc(conn: psycopg.Connection, request: RPCRequest) -> Any:
    allowed = RPC_ARGUMENTS.get(request.name)
    if allowed is None:
        raise HTTPException(status_code=404, detail={"code": "RPC_NOT_ALLOWED", "message": "Function is not available through this API"})
    if not request.params or not set(request.params).issubset(allowed):
        raise HTTPException(status_code=400, detail={"code": "INVALID_RPC_PARAMS", "message": "Invalid function arguments"})
    args = list(request.params.items())
    named_args = sql.SQL(", ").join(sql.SQL("{} => %s").format(sql.Identifier(name)) for name, _ in args)
    statement = sql.SQL("SELECT * FROM {}.{}({})").format(sql.Identifier("public"), sql.Identifier(request.name), named_args)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(statement, [value for _, value in args])
        if cur.description is None:
            return None
        rows = list(cur.fetchall())
        if request.name in RPC_SCALAR_RESULTS:
            return next(iter(rows[0].values())) if rows else None
        return rows


@asynccontextmanager
async def lifespan(app: FastAPI):
    dsn = os.environ.get("DATABASE_URL", "").strip()
    api_key = os.environ.get("BOT_API_KEY", "").strip()
    if not dsn or not api_key:
        raise RuntimeError("DATABASE_URL and BOT_API_KEY must be configured")
    pool = ConnectionPool(
        conninfo=dsn,
        min_size=int(os.environ.get("DB_POOL_MIN_SIZE", "1")),
        max_size=int(os.environ.get("DB_POOL_MAX_SIZE", "8")),
        timeout=float(os.environ.get("DB_POOL_TIMEOUT", "5")),
        kwargs={"row_factory": dict_row},
        open=False,
    )
    pool.open(wait=True)
    app.state.pool = pool
    try:
        yield
    finally:
        pool.close()


app = FastAPI(title="BOT PostgreSQL API", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def _pool(request: Request) -> ConnectionPool:
    pool = getattr(request.app.state, "pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail={"code": "API_NOT_READY", "message": "Database API is not ready"})
    return pool


def _database_error(exc: psycopg.Error) -> HTTPException:
    state = getattr(exc, "sqlstate", None) or "DATABASE_ERROR"
    diagnostic = getattr(exc, "diag", None)
    message = getattr(diagnostic, "message_primary", None) or "Database operation failed"
    log.warning("Database request failed (%s): %s", state, message)
    return HTTPException(status_code=400 if state.startswith("22") or state.startswith("23") or state == "P0001" else 500,
                         detail={"code": state, "message": message})


@app.get("/healthz")
def healthz(request: Request):
    pool = _pool(request)
    try:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")
    except Exception as exc:
        log.warning("health check failed: %s", exc)
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return {"status": "ok"}


@app.post("/v1/query")
def query(request: Request, body: QueryRequest, authorization: str | None = Header(default=None)):
    _unauthorized(authorization)
    pool = _pool(request)
    try:
        with pool.connection() as conn:
            with conn.transaction():
                data = _execute_query(conn, body)
        return {"data": data}
    except HTTPException:
        raise
    except PoolTimeout as exc:
        raise HTTPException(status_code=503, detail={"code": "API_UNAVAILABLE", "message": "Database connection pool is busy; query was not started"}) from exc
    except psycopg.Error as exc:
        raise _database_error(exc) from exc

@app.post("/v1/rpc")
def rpc(request: Request, body: RPCRequest, authorization: str | None = Header(default=None)):
    _unauthorized(authorization)
    pool = _pool(request)
    try:
        with pool.connection() as conn:
            with conn.transaction():
                data = _execute_rpc(conn, body)
        return {"data": data}
    except HTTPException:
        raise
    except PoolTimeout as exc:
        raise HTTPException(status_code=503, detail={"code": "API_UNAVAILABLE", "message": "Database connection pool is busy; query was not started"}) from exc
    except psycopg.Error as exc:
        raise _database_error(exc) from exc
