"""core/support/usage_stats/usage_stats.py（管理者向け総量カウンタ）と !usage_stats の登録テスト。

個人単位の履歴（action_usage）とは別集計で、ここで見るのは総量だけ:
加算・割合・トップN・日別ローテーション・保存/読み戻し・リセット。
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.help.help import command_meta
from core.support.usage_stats import usage_stats
def make_store(tmpdir, **kwargs):
    return usage_stats.UsageStatsStore(Path(tmpdir) / "usage_stats.json", **kwargs)


class UsageStatsStoreTest(unittest.TestCase):
    def test_record_command_and_action_counts(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            store.record_command("!logs")
            store.record_command("!logs")
            store.record_command("/vc")
            store.record_action("general:miq")
            data = store.snapshot()
            self.assertEqual(data["commands"], {"!logs": 2, "/vc": 1})
            self.assertEqual(data["actions"], {"general:miq": 1})
            today = datetime.now(usage_stats.JST).date().isoformat()
            self.assertEqual(data["daily"][today], {"commands": 3, "actions": 1})
            self.assertTrue(data["started_at"])

    def test_daily_rotation_keeps_last_7_days(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            base = datetime(2026, 11, 1, 12, 0, tzinfo=usage_stats.JST)
            for offset in range(10):
                store.record_command("!logs", now=base + timedelta(days=offset))
            daily = store.snapshot()["daily"]
            self.assertEqual(len(daily), usage_stats.DAILY_KEEP_DAYS)
            self.assertNotIn("2026-11-01", daily)
            self.assertIn("2026-11-10", daily)
            # 件数自体は日別ローテーションで消えない（総量は保持する）。
            self.assertEqual(store.snapshot()["commands"]["!logs"], 10)

    def test_flush_writes_only_at_threshold_and_roundtrips(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "usage_stats.json"
            store = usage_stats.UsageStatsStore(path, flush_every=3, flush_interval=3600)
            store.record_command("!logs")
            store.record_command("!logs")
            self.assertFalse(path.exists(), "閾値未満ではファイルに書かない")
            store.record_command("!logs")
            self.assertTrue(path.exists(), "閾値到達でフラッシュする")
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["commands"], {"!logs": 3})

            loaded = usage_stats.UsageStatsStore(path)
            self.assertEqual(loaded.snapshot()["commands"], {"!logs": 3})
            self.assertEqual(loaded.snapshot()["started_at"], store.snapshot()["started_at"])

    def test_explicit_flush_and_reset(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "usage_stats.json"
            store = usage_stats.UsageStatsStore(path, flush_every=1000)
            store.record_action("vc:music_panel")
            store.flush()
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["actions"], {"vc:music_panel": 1})

            later = datetime(2026, 12, 24, 0, 0, tzinfo=usage_stats.JST)
            store.reset(now=later)
            data = store.snapshot()
            self.assertEqual(data["commands"], {})
            self.assertEqual(data["actions"], {})
            self.assertEqual(data["daily"], {})
            self.assertTrue(data["started_at"].startswith("2026-12-24"))
            # リセットは即座に保存される。
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["actions"], {})

    def test_broken_file_falls_back_to_empty(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "usage_stats.json"
            path.write_text("{not json", encoding="utf-8")
            store = usage_stats.UsageStatsStore(path)
            self.assertEqual(store.snapshot()["commands"], {})


class UsageStatsHelpersTest(unittest.TestCase):
    def test_top_items_order_and_tiebreak(self):
        counts = {"b": 5, "a": 5, "c": 9, "d": 1}
        self.assertEqual(usage_stats.top_items(counts, 3), [("c", 9), ("a", 5), ("b", 5)])
        self.assertEqual(len(usage_stats.top_items({str(i): i for i in range(20)})), 10)

    def test_share_percent(self):
        self.assertEqual(usage_stats.share_percent(1, 4), 25.0)
        self.assertEqual(usage_stats.share_percent(3, 0), 0.0)

    def test_format_top_lines(self):
        text = usage_stats.format_top_lines({"!logs": 3, "/vc": 1})
        self.assertIn("1. `!logs` — 3回 (75.0%)", text)
        self.assertIn("2. `/vc` — 1回 (25.0%)", text)
        labeled = usage_stats.format_top_lines(
            {"general:miq": 2}, label_for=lambda key: "引用画像" if key == "general:miq" else None
        )
        self.assertIn("`general:miq`（引用画像） — 2回 (100.0%)", labeled)
        self.assertEqual(usage_stats.format_top_lines({}), "（まだ記録がありません）")


class UsageStatsSafelyTest(unittest.TestCase):
    def test_safely_wrappers_never_raise(self):
        broken = mock.Mock()
        broken.record_command.side_effect = RuntimeError("boom")
        broken.record_action.side_effect = RuntimeError("boom")
        broken.flush.side_effect = RuntimeError("boom")
        broken.reset.side_effect = RuntimeError("boom")
        with mock.patch.object(usage_stats, "_default_store", broken):
            usage_stats.record_command_safely("!logs")
            usage_stats.record_action_safely("general:miq")
            usage_stats.flush_safely()
            usage_stats.reset_safely()


class UsageStatsRegistrationTest(unittest.TestCase):
    def test_command_meta_registration(self):
        entry = command_meta.COMMAND_META["!usage_stats"]
        self.assertEqual(entry["category"], "admin")
        self.assertTrue(entry["hidden"])
        self.assertIn("bot_admin", entry["permissions"])
        self.assertEqual(entry["usage"], "!usage_stats [reset]")

    def test_cog_command_registered(self):
        # cog を Bot に載せると usage_stats / ustats がプレフィックスコマンドとして登録される。
        from discord.ext import commands as ext_commands

        from cogs.support import UsageStatsCog

        async def build():
            bot = ext_commands.Bot(command_prefix="!", intents=__import__("discord").Intents.none())
            await bot.add_cog(UsageStatsCog(bot))
            return bot

        bot = asyncio.run(build())
        cmd = bot.get_command("usage_stats")
        self.assertIsNotNone(cmd)
        self.assertEqual(cmd.aliases, ["ustats"])
        self.assertIs(bot.get_command("ustats"), cmd)


if __name__ == "__main__":
    unittest.main()
