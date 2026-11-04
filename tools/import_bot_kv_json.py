#!/usr/bin/env python3
"""Safely reconcile a local bot_kv.json snapshot with the local botdb.

Default mode is read-only. Normal JSON entries are inserted only when their
(namespace, key) is absent in PostgreSQL. The durable __pending__ journal is
then applied last: pending values overwrite their key and pending deletes remove
it, matching KVStore's latest intended local state. Values are never printed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb


INSERT_MISSING = (
    "INSERT INTO public.bot_kv (namespace, key, value, updated_at) "
    "VALUES (%s, %s, %s, now()) "
    "ON CONFLICT (namespace, key) DO NOTHING"
)
UPSERT_PENDING = (
    "INSERT INTO public.bot_kv (namespace, key, value, updated_at) "
    "VALUES (%s, %s, %s, now()) "
    "ON CONFLICT (namespace, key) DO UPDATE "
    "SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"
)


def read_snapshot(path: Path) -> tuple[list[tuple[str, str, Any]], list[tuple[str, str, bool, Any]]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read valid JSON snapshot: {path}") from exc
    if not isinstance(document, dict):
        raise SystemExit("Snapshot root must be a JSON object")

    normal: list[tuple[str, str, Any]] = []
    for namespace, records in document.items():
        if namespace == "__pending__":
            continue
        if not isinstance(records, dict):
            raise SystemExit(f"Namespace {namespace!r} must contain a JSON object")
        normal.extend((str(namespace), str(key), value) for key, value in records.items())

    pending_ops: list[tuple[str, str, bool, Any]] = []
    pending_root = document.get("__pending__", {})
    if not isinstance(pending_root, dict):
        raise SystemExit("__pending__ must contain a JSON object")
    for namespace, records in pending_root.items():
        if not isinstance(records, dict):
            raise SystemExit(f"Pending namespace {namespace!r} must contain a JSON object")
        for key, item in records.items():
            if not isinstance(item, dict):
                raise SystemExit(f"Pending item {namespace!r}/{key!r} must contain a JSON object")
            if item.get("deleted") is True:
                pending_ops.append((str(namespace), str(key), True, None))
            elif "value" in item:
                pending_ops.append((str(namespace), str(key), False, item["value"]))
            else:
                raise SystemExit(f"Pending item {namespace!r}/{key!r} has no value or delete marker")
    return normal, pending_ops


def local_dsn() -> str:
    dsn = os.environ.get("DATABASE_URL", "").strip()
    if not dsn:
        from dotenv import dotenv_values
        env_file = Path(os.environ.get("BOT_API_ENV_FILE", "/etc/bot-postgres-api.env"))
        dsn = str(dotenv_values(env_file).get("DATABASE_URL") or "").strip()
    if not dsn:
        raise SystemExit("Set DATABASE_URL to the local PostgreSQL botdb connection; the value is never printed")
    info = conninfo_to_dict(dsn)
    database = info.get("dbname") or info.get("database")
    host = info.get("host", "")
    if database != "botdb" or host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Refusing non-local target: DATABASE_URL must point to botdb on localhost")
    return dsn


def reconcile(path: Path, *, apply: bool) -> None:
    normal, pending = read_snapshot(path)
    dsn = local_dsn()
    missing = 0
    divergent = 0
    inserted = 0
    overwritten = 0
    deleted = 0

    with psycopg.connect(dsn) as conn:
        with conn.transaction():
            if not apply:
                conn.execute("SET TRANSACTION READ ONLY")
            for namespace, key, value in normal:
                row = conn.execute(
                    "SELECT value FROM public.bot_kv WHERE namespace = %s AND key = %s",
                    (namespace, key),
                ).fetchone()
                if row is None:
                    missing += 1
                    if apply:
                        cur = conn.execute(INSERT_MISSING, (namespace, key, Jsonb(value)))
                        inserted += cur.rowcount
                elif row[0] != value:
                    divergent += 1

            pending_values = 0
            pending_deletes = 0
            for namespace, key, is_deleted, value in pending:
                if is_deleted:
                    pending_deletes += 1
                    if apply:
                        cur = conn.execute(
                            "DELETE FROM public.bot_kv WHERE namespace = %s AND key = %s",
                            (namespace, key),
                        )
                        deleted += cur.rowcount
                else:
                    pending_values += 1
                    if apply:
                        cur = conn.execute(UPSERT_PENDING, (namespace, key, Jsonb(value)))
                        overwritten += cur.rowcount

    mode = "APPLIED" if apply else "DRY RUN (no database changes)"
    print(f"{mode}: local entries={len(normal)}, missing from DB={missing}, differing existing values={divergent}")
    print(f"Pending journal: value upserts={pending_values}, deletes={pending_deletes}")
    if apply:
        print(f"Changed rows: inserted missing={inserted}, pending values upserted={overwritten}, pending deletes applied={deleted}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--file",
        type=Path,
        default=Path(os.environ.get("BOT_KV_FILE", str(Path.home() / "BOT" / "bot_kv.json"))).expanduser(),
        help="bot_kv.json snapshot (default: BOT_KV_FILE or ~/BOT/bot_kv.json)",
    )
    parser.add_argument("--apply", action="store_true", help="apply missing local entries and pending journal operations")
    args = parser.parse_args()
    reconcile(args.file, apply=args.apply)


if __name__ == "__main__":
    main()
