# -*- coding: utf-8 -*-
"""小型の未テスト cog の純ロジックのテスト（監査 #9）。

- status_updater: truncate_text（Activity 名の長さ制限）
- allstats: _get_py_file_tree（.py ファイルツリー生成）
- cogs/ggrks.py: 検索キーワードの URL エンコード
"""
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from cogs.support import FIELD_VALUE_LIMIT, SystemStatsCog, _limit_field_value
from cogs.ggrks import GoogleSearch
from cogs.support import truncate_text


class TruncateTextTests(unittest.TestCase):
    def test_short_text_unchanged(self):
        self.assertEqual(truncate_text("abc"), "abc")

    def test_exactly_at_limit_unchanged(self):
        self.assertEqual(truncate_text("a" * 128), "a" * 128)

    def test_over_limit_gets_ellipsis_at_limit(self):
        out = truncate_text("a" * 200)
        self.assertEqual(len(out), 128)
        self.assertTrue(out.endswith("…"))

    def test_none_and_custom_limit(self):
        self.assertEqual(truncate_text(None), "")
        self.assertEqual(truncate_text("abcdef", limit=4), "abc…")


class PyFileTreeTests(unittest.TestCase):
    def _tree(self, root):
        cog = SystemStatsCog.__new__(SystemStatsCog)
        return cog._get_py_file_tree(Path(root))

    def test_tree_lists_py_files_and_dirs_with_py(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "main.py").write_text("x")
            (root / "note.txt").write_text("x")
            (root / "pkg").mkdir()
            (root / "pkg" / "mod.py").write_text("x")
            (root / "empty").mkdir()
            (root / "__pycache__").mkdir()
            (root / "__pycache__" / "cached.py").write_text("x")
            tree = self._tree(root)
        self.assertIn("main.py", tree)
        self.assertIn("pkg/", tree)
        self.assertIn("mod.py", tree)
        self.assertNotIn("note.txt", tree)
        self.assertNotIn("empty", tree)
        self.assertNotIn("__pycache__", tree)

    def test_no_py_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "a.txt").write_text("x")
            tree = self._tree(tmp)
        self.assertEqual(tree, "`.py` ファイルが見つかりません")


class LimitFieldValueTests(unittest.TestCase):
    def test_short_value_unchanged(self):
        self.assertEqual(_limit_field_value("abc"), "abc")

    def test_exactly_at_limit_unchanged(self):
        value = "a" * FIELD_VALUE_LIMIT
        self.assertEqual(_limit_field_value(value), value)

    def test_over_limit_is_truncated_to_limit(self):
        out = _limit_field_value("a" * 2000)
        self.assertEqual(len(out), FIELD_VALUE_LIMIT)
        self.assertTrue(out.endswith("…"))


class _FakeTyping:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class AllStatsEmbedTests(unittest.IsolatedAsyncioTestCase):
    """Cog が大量でも all_stats の全フィールドが上限以下になること (400エラー対策)。"""

    async def _run_all_stats(self, cog_names):
        bot = types.SimpleNamespace(
            cogs={name: object() for name in cog_names},
            guilds=[],
            latency=0.0,
        )
        cog = SystemStatsCog(bot)
        sent = []
        ctx = types.SimpleNamespace(
            typing=lambda: _FakeTyping(),
            author=types.SimpleNamespace(
                display_avatar=types.SimpleNamespace(url="https://example.com/a.png")
            ),
            send=AsyncMock(side_effect=lambda *a, **k: sent.append((a, k))),
        )
        await cog.all_stats.callback(cog, ctx)
        return sent[0][1]["embed"]

    async def test_many_cogs_fields_within_limit_and_remainder_shown(self):
        embed = await self._run_all_stats([f"cog_{i:03d}" for i in range(120)])
        for field in embed.fields:
            self.assertLessEqual(len(field.value), FIELD_VALUE_LIMIT, field.name)
        scale = next(f for f in embed.fields if f.name == "Discord接続規模")
        # 総数が分かり、入りきらなかった分が「…他N件」で明示される
        self.assertIn("(120件)", scale.value)
        self.assertRegex(scale.value, r"…他\d+件$")

    async def test_few_cogs_all_listed(self):
        embed = await self._run_all_stats(["alpha", "beta"])
        for field in embed.fields:
            self.assertLessEqual(len(field.value), FIELD_VALUE_LIMIT, field.name)
        scale = next(f for f in embed.fields if f.name == "Discord接続規模")
        self.assertIn("`alpha`", scale.value)
        self.assertIn("`beta`", scale.value)
        self.assertNotIn("他", scale.value)


class GgrksTests(unittest.IsolatedAsyncioTestCase):
    async def test_keyword_is_url_encoded(self):
        cog = GoogleSearch(types.SimpleNamespace())
        sent = []
        ctx = types.SimpleNamespace(
            send=AsyncMock(side_effect=lambda *a, **k: sent.append((a, k)))
        )
        await cog.ggrks.callback(cog, ctx, keyword="テスト 検索&more")
        embed = sent[0][1]["embed"]
        self.assertIn(
            "https://www.google.com/search?q=%E3%83%86%E3%82%B9%E3%83%88%20%E6%A4%9C%E7%B4%A2%26more",
            embed.description,
        )


if __name__ == "__main__":
    unittest.main()
