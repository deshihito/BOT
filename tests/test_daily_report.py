"""日報（オプトインDM）のテスト（2026-11-06、残移植 Phase B）。

- 購読はデフォルト OFF で、本人が ON にしたユーザーだけが対象
- 送信判定: JST 21:00 以降・本日未送信の購読者のみ
- レポート文は集計できた項目だけで組み立てる
- DM が閉じられているユーザーは静かにスキップし、当日分は試行済みに
  なる（毎分リトライしない）
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import discord

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.support.daily_report import store as report_core
from core.general.items import JST

T_2100 = datetime(2026, 11, 6, 21, 0, tzinfo=JST)
T_2059 = datetime(2026, 11, 6, 20, 59, tzinfo=JST)


class StoreTest(unittest.TestCase):
    def _store(self, tmp):
        return report_core.DailyReportStore(Path(tmp) / "daily_report.json")

    def test_default_off_and_toggle(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            self.assertFalse(store.is_opted_in("1"))
            self.assertTrue(store.toggle("1"))
            self.assertTrue(store.is_opted_in("1"))
            self.assertFalse(store.toggle("1"))

    def test_due_users_conditions(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.set_opt_in("1", True)
            store.set_opt_in("2", True)
            store.set_opt_in("3", False)
            # 21:00 前は誰も対象でない。
            self.assertEqual(store.due_users(T_2059), [])
            # 21:00 以降は購読中の全員。
            self.assertEqual(sorted(store.due_users(T_2100)), ["1", "2"])
            # 送信済みにしたら当日はもう対象でない。翌日は再び対象。
            store.mark_sent("1", T_2100)
            self.assertEqual(store.due_users(T_2100), ["2"])
            self.assertEqual(
                sorted(store.due_users(T_2100 + timedelta(days=1))), ["1", "2"])

    def test_persistence_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "daily_report.json"
            store = report_core.DailyReportStore(path)
            store.set_opt_in("1", True)
            store.mark_sent("1", T_2100)
            store.flush()
            reloaded = report_core.DailyReportStore(path)
            self.assertTrue(reloaded.is_opted_in("1"))
            self.assertEqual(reloaded.due_users(T_2100), [])


class ReportLinesTest(unittest.TestCase):
    def test_full_status(self):
        status = {
            "balance": 12345, "rate": 100.5, "tokens": 12.3,
            "items_total": 9, "items_kinds": 4, "boxes": 2,
            "machines": 1, "pending_cycles": 3, "commissions_ready": 1,
            "lottery_pool": 5000, "lottery_tickets": 2,
            "mining_session_left": 5, "prison_remaining": None,
        }
        text = "\n".join(report_core.build_report_lines(status, T_2100))
        self.assertIn("11/06 の日報", text)
        self.assertIn("12,345 AGO", text)
        self.assertIn("アゴトークン", text)
        self.assertIn("受け取り可能 **3 サイクル分**", text)
        self.assertIn("チケット **2 枚**", text)
        self.assertNotIn("逮捕中", text)

    def test_sparse_status_only_balance(self):
        text = "\n".join(
            report_core.build_report_lines({"balance": 10}, T_2100))
        self.assertIn("10 AGO", text)
        self.assertNotIn("アゴトークン", text)
        self.assertNotIn("宝くじ", text)


class _FakeUser:
    def __init__(self, user_id, *, forbidden=False):
        self.id = user_id
        self.forbidden = forbidden
        self.sent: list[str] = []

    async def send(self, text):
        if self.forbidden:
            raise discord.Forbidden(
                SimpleNamespace(status=403, reason="Forbidden"), "Cannot send")
        self.sent.append(text)


class _FakeBot:
    def __init__(self, users):
        self._users = users

    def get_cog(self, name):
        return None

    def get_user(self, user_id):
        return self._users.get(user_id)

    async def fetch_user(self, user_id):
        return self._users.get(user_id)


class SendTest(unittest.TestCase):
    def _cog(self, tmp, users):
        from cogs.daily_report import DailyReportCog

        store = report_core.DailyReportStore(Path(tmp) / "daily_report.json")
        cog = DailyReportCog(
            _FakeBot(users), store=store, balance_reader=lambda uid: 777)
        return cog, store

    def test_sends_only_to_opted_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            user1, user2 = _FakeUser(1), _FakeUser(2)
            cog, store = self._cog(tmp, {1: user1, 2: user2})
            store.set_opt_in("1", True)
            sent = asyncio.run(cog.send_due_reports(T_2100))
            self.assertEqual(sent, 1)
            self.assertEqual(len(user1.sent), 1)
            self.assertIn("777 AGO", user1.sent[0])
            self.assertEqual(user2.sent, [])
            # 同日2回目は送らない。
            sent = asyncio.run(cog.send_due_reports(T_2100))
            self.assertEqual(sent, 0)

    def test_forbidden_dm_skipped_quietly_and_marked(self):
        with tempfile.TemporaryDirectory() as tmp:
            user = _FakeUser(1, forbidden=True)
            cog, store = self._cog(tmp, {1: user})
            store.set_opt_in("1", True)
            sent = asyncio.run(cog.send_due_reports(T_2100))
            self.assertEqual(sent, 1)  # 例外で落ちず、試行済みになる
            self.assertEqual(store.due_users(T_2100), [])

    def test_before_send_hour_nothing_sent(self):
        with tempfile.TemporaryDirectory() as tmp:
            user = _FakeUser(1)
            cog, store = self._cog(tmp, {1: user})
            store.set_opt_in("1", True)
            sent = asyncio.run(cog.send_due_reports(T_2059))
            self.assertEqual(sent, 0)
            self.assertEqual(user.sent, [])


class RegistryTest(unittest.TestCase):
    def test_daily_report_action_registered_and_blocked_for_ai(self):
        from core.action_registry import default_registry

        spec = default_registry().by_id("general:daily_report")
        self.assertEqual(spec.genre, "money")
        self.assertEqual(spec.risk, "blocked")
        self.assertNotIn("aitools", spec.surfaces)
        self.assertNotIn("shortcut", spec.surfaces)


if __name__ == "__main__":
    unittest.main()
