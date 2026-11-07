# -*- coding: utf-8 -*-
"""ログビューア（core/support/log_viewer/cog.py、!logs）のテスト（監査 #9）。

bot.log_buffer のフェイクで、行数指定・重要度フィルタ・エラー分岐を固定する。
"""
import types
import unittest
from unittest.mock import AsyncMock

from cogs.support import LogViewer

LOGS = [
    "[INFO] 起動しました",
    "[ERROR] 何か壊れた",
    "[INFO] 処理中",
    "[WARNING] 注意",
    "[ERROR] また壊れた",
]


def _make_cog(logs=LOGS, with_buffer=True):
    if with_buffer:
        bot = types.SimpleNamespace(log_buffer=types.SimpleNamespace(logs=list(logs)))
    else:
        bot = types.SimpleNamespace()
    cog = LogViewer(bot)
    sent = []

    async def _send(*args, **kwargs):
        sent.append((args, kwargs))

    ctx = types.SimpleNamespace(send=_send)
    return cog, ctx, sent


class LogsCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_buffer_reports_error(self):
        cog, ctx, sent = _make_cog(with_buffer=False)
        await cog.logs.callback(cog, ctx)
        self.assertIn("log_buffer", sent[0][0][0])

    async def test_empty_buffer(self):
        cog, ctx, sent = _make_cog(logs=[])
        await cog.logs.callback(cog, ctx)
        self.assertIn("取得できるログはありません", sent[0][0][0])

    async def test_nonpositive_line_count_rejected(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 0)
        self.assertIn("1 以上", sent[0][0][0])

    async def test_invalid_level_rejected(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 30, "BOGUS")
        self.assertIn("無効な重要度", sent[0][0][0])

    async def test_latest_lines_selected(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 2)
        content = sent[0][0][0]
        self.assertIn("最新 2 件 / 保持 5 件", content)
        self.assertIn("[WARNING] 注意", content)
        self.assertIn("[ERROR] また壊れた", content)
        self.assertNotIn("起動しました", content)

    async def test_level_filter_is_case_insensitive(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 30, "error")
        content = sent[0][0][0]
        self.assertIn("重要度: ERROR", content)
        self.assertIn("保持 2 件", content)
        self.assertIn("何か壊れた", content)
        self.assertNotIn("[INFO]", content)

    async def test_level_with_no_matches(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 30, "CRITICAL")
        self.assertIn("見つかりませんでした", sent[0][0][0])

    async def test_code_fence_is_escaped(self):
        cog, ctx, sent = _make_cog(logs=["[INFO] ``` 埋め込み"])
        await cog.logs.callback(cog, ctx, 30)
        content = sent[0][0][0]
        # ログ本文中の ``` は全角化され、外側のフェンスだけが ``` になる
        self.assertIn("｀｀｀", content)
        self.assertEqual(content.count("```"), 2)

    async def test_all_logs_file_attached(self):
        cog, ctx, sent = _make_cog()
        await cog.logs.callback(cog, ctx, 2)
        kwargs = sent[0][1]
        attached = kwargs.get("file")
        self.assertIsNotNone(attached)
        self.assertTrue(attached.filename.startswith("all_logs_"))


if __name__ == "__main__":
    unittest.main()
