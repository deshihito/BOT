import contextlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import import_bot_kv_json as importer


class _Cursor:
    def __init__(self, row=None, rowcount=1):
        self._row = row
        self.rowcount = rowcount

    def fetchone(self):
        return self._row


class _Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _Connection:
    def __init__(self):
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def transaction(self):
        return _Transaction()

    def execute(self, statement, params=None):
        text = str(statement)
        self.statements.append((text, params))
        if text.startswith("SELECT value"):
            return _Cursor(None)
        return _Cursor(rowcount=1)


class ImportBotKVTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.snapshot = Path(self.temp.name) / "bot_kv.json"
        self.snapshot.write_text(json.dumps({
            "guild_settings": {"123": {"enabled": True}},
            "__pending__": {
                "guild_settings": {
                    "456": {"value": {"enabled": False}},
                    "789": {"deleted": True},
                }
            },
        }), encoding="utf-8")

    def test_snapshot_parses_namespaces_and_pending_journal(self):
        normal, pending = importer.read_snapshot(self.snapshot)
        self.assertEqual(normal, [("guild_settings", "123", {"enabled": True})])
        self.assertEqual(pending, [
            ("guild_settings", "456", False, {"enabled": False}),
            ("guild_settings", "789", True, None),
        ])

    def test_refuses_non_local_database_target(self):
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://bot_api:secret@pooler.example.com:5432/postgres"}, clear=False):
            with self.assertRaisesRegex(SystemExit, "Refusing non-local target"):
                importer.local_dsn()

    def test_default_mode_sets_read_only_and_runs_no_dml(self):
        connection = _Connection()
        dsn = "postgresql://bot_api:secret@127.0.0.1:5432/botdb"
        with patch.dict(os.environ, {"DATABASE_URL": dsn}, clear=False), patch.object(importer.psycopg, "connect", return_value=connection):
            importer.reconcile(self.snapshot, apply=False)
        sql = [statement.lstrip().upper() for statement, _params in connection.statements]
        self.assertIn("SET TRANSACTION READ ONLY", sql)
        self.assertFalse(any(statement.startswith(("INSERT", "UPDATE", "DELETE")) for statement in sql))

    def test_apply_inserts_local_entries_then_applies_pending_state(self):
        connection = _Connection()
        dsn = "postgresql://bot_api:secret@127.0.0.1:5432/botdb"
        with patch.dict(os.environ, {"DATABASE_URL": dsn}, clear=False), patch.object(importer.psycopg, "connect", return_value=connection):
            importer.reconcile(self.snapshot, apply=True)
        dml = [statement for statement, _params in connection.statements if statement.lstrip().upper().startswith(("INSERT", "DELETE"))]
        self.assertEqual(len(dml), 3)
        self.assertEqual(sum("ON CONFLICT (namespace, key) DO NOTHING" in statement for statement in dml), 1)
        self.assertEqual(sum("DO UPDATE" in statement for statement in dml), 1)
        self.assertEqual(sum(statement.lstrip().upper().startswith("DELETE") for statement in dml), 1)


if __name__ == "__main__":
    unittest.main()
