"""!ai の会話履歴読み込み: 件数上限50件と、判定パースの堅牢化を確認する。"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from core.general.ai import ai_context
from core.general.ai import cog as ai_cog


class ParseOptionsHistoryTest(unittest.TestCase):
    def test_history_count_is_clamped_to_50(self):
        options = ai_context.parse_options("質問 --history=80")
        self.assertEqual(options.history, 50)
        self.assertEqual(options.prompt, "質問")

    def test_history_50_is_accepted(self):
        self.assertEqual(ai_context.parse_options("質問 --history=50").history, 50)

    def test_history_without_count_uses_default(self):
        self.assertEqual(ai_context.parse_options("質問 --history").history, 10)

    def test_caps_match_between_modules(self):
        self.assertEqual(ai_context.MAX_HISTORY, 50)
        self.assertEqual(ai_cog.HISTORY_AUTO_MAX, 50)


class ParseHistoryDecisionTest(unittest.TestCase):
    def parse(self, text: str) -> int:
        return ai_cog._parse_history_decision(text)

    def test_plain_json(self):
        self.assertEqual(self.parse('{"history": true, "count": 30}'), 30)

    def test_not_needed(self):
        self.assertEqual(self.parse('{"history": false}'), 0)
        self.assertEqual(self.parse('{"history": false, "count": 10}'), 0)

    def test_missing_count_uses_default(self):
        self.assertEqual(self.parse('{"history": true}'), ai_cog.HISTORY_AUTO_DEFAULT)

    def test_count_is_clamped_to_50(self):
        self.assertEqual(self.parse('{"history": true, "count": 999}'), 50)

    def test_code_fence_and_prose_are_tolerated(self):
        text = "判定しました。\n```json\n{\"history\": true, \"count\": 12}\n```\n以上です。"
        self.assertEqual(self.parse(text), 12)

    def test_first_complete_object_wins(self):
        # 後ろに別の {...} があっても、最初の完結したオブジェクトで判定する。
        text = '{"history": true, "count": 7} 参考: {"count": 40}'
        self.assertEqual(self.parse(text), 7)

    def test_string_bool_and_count(self):
        # Gemma系が出しがちな文字列表記でも拾う。
        self.assertEqual(self.parse('{"history": "true", "count": "15"}'), 15)
        self.assertEqual(self.parse('{"history": "false", "count": 15}'), 0)

    def test_broken_json_is_salvaged(self):
        # 末尾カンマ等で厳密パースできない場合もキーと値から救済する。
        self.assertEqual(self.parse('{"history": true, "count": 25,}'), 25)
        self.assertEqual(self.parse('{"history": true}'), ai_cog.HISTORY_AUTO_DEFAULT)

    def test_no_json_returns_zero(self):
        self.assertEqual(self.parse("履歴は不要です。"), 0)
        self.assertEqual(self.parse(""), 0)

    def test_prose_affirmative_is_salvaged(self):
        # JSON でなく日本語の散文で肯定が返っても拾う (件数はデフォルト)。
        self.assertEqual(self.parse("履歴が必要です。"), ai_cog.HISTORY_AUTO_DEFAULT)
        self.assertEqual(self.parse("この会話の履歴は必要です"), ai_cog.HISTORY_AUTO_DEFAULT)

    def test_prose_negative_returns_zero(self):
        self.assertEqual(self.parse("必要ありません。"), 0)
        self.assertEqual(self.parse("履歴はいりません"), 0)
        self.assertEqual(self.parse("履歴は必要ないです"), 0)


class JudgeHistoryTest(unittest.IsolatedAsyncioTestCase):
    async def test_keyword_hint_skips_model(self):
        # 典型的な言い回しはモデルへ聞かずに即決する。
        async def ask(messages):
            raise AssertionError("モデルを呼んではいけない")

        count = await ai_cog._judge_history(ask, "さっきの話の続きを教えて")
        self.assertEqual(count, ai_cog.HISTORY_AUTO_DEFAULT)
        count = await ai_cog._judge_history(ask, "このチャンネルの会話を要約して")
        self.assertEqual(count, ai_cog.HISTORY_AUTO_DEFAULT)

    async def test_model_json_decision(self):
        async def ask(messages):
            return '{"history": true, "count": 20}'

        count = await ai_cog._judge_history(ask, "日本の首都はどこですか？")
        self.assertEqual(count, 20)

    async def test_model_prose_decision(self):
        async def ask(messages):
            return "履歴が必要です"

        count = await ai_cog._judge_history(ask, "日本の首都はどこですか？")
        self.assertEqual(count, ai_cog.HISTORY_AUTO_DEFAULT)

    async def test_model_failure_returns_zero(self):
        async def ask(messages):
            raise TimeoutError("too slow")

        count = await ai_cog._judge_history(ask, "日本の首都はどこですか？")
        self.assertEqual(count, 0)


def _message(index: int, text: str = "こんにちは"):
    return SimpleNamespace(
        created_at=datetime(2026, 11, 7, 12, 0, tzinfo=timezone.utc) + timedelta(minutes=index),
        author=SimpleNamespace(display_name=f"user{index}", bot=False),
        clean_content=text,
        embeds=[],
        attachments=[],
    )


class _FakeChannel:
    def __init__(self, messages):
        self._messages = messages

    async def history(self, *, limit, before=None):
        count = 0
        for message in reversed(self._messages):
            if count >= limit:
                return
            yield message
            count += 1


class CollectHistoryTest(unittest.IsolatedAsyncioTestCase):
    def _ctx(self, messages):
        return SimpleNamespace(
            guild=None,
            channel=_FakeChannel(messages),
            message=SimpleNamespace(id=999_999),
        )

    async def test_collects_up_to_50(self):
        messages = [_message(i) for i in range(60)]
        lines = await ai_context.collect_history(self._ctx(messages), 50)
        self.assertEqual(len(lines), 50)
        # 古い順に並ぶ（先頭が最も古い残存メッセージ）
        self.assertIn("user10", lines[0])

    async def test_char_budget_still_applies(self):
        messages = [_message(i, text="あ" * 600) for i in range(50)]
        lines = await ai_context.collect_history(self._ctx(messages), 50)
        self.assertLess(len(lines), 50)
        self.assertLessEqual(sum(len(line) for line in lines), ai_context.MAX_HISTORY_CHARS)


if __name__ == "__main__":
    unittest.main()
