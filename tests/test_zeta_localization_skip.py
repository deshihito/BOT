"""ZetaModoki（AIロールプレイ）の本文が送信時翻訳で書き換わらないことの固定テスト。

背景: 送信時翻訳（core/support/localization/localization.py の断片置換）は静的UI文向けの仕組みで、
AI生成の動的本文にかけると英語設定サーバーで文章が崩れ、表示と会話履歴が
食い違う。!ai 本体は _reply_without_localization で対象外になっており、
ZetaModoki の Webhook 送信も同じ扱いにする。

- Webhook 送信 kwargs に _agobot_skip_localization が付くこと
- 会話履歴には生成された原文がそのまま保存されること
- フラグ付きペイロードは英語ロケールでも localize_kwargs で不変なこと
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support.localization import localization  # noqa: E402
from core.game.zeta.common import BotPersona  # noqa: E402
from cogs.zetamodoki import ZetaModoki  # noqa: E402


def _persona() -> BotPersona:
    return BotPersona(
        name="テストキャラ",
        persona="明るい性格",
        situation="カフェ",
        first_message="いらっしゃいませ！",
        icon_url="https://example.com/icon.png",
    )


class ZetaWebhookSkipTest(unittest.IsolatedAsyncioTestCase):
    async def test_webhook_send_skips_localization(self):
        cog = ZetaModoki(types.SimpleNamespace())
        cog.active_personas[555] = _persona()
        webhook = types.SimpleNamespace(send=AsyncMock(return_value=types.SimpleNamespace(id=1)))
        channel = types.SimpleNamespace(id=555)
        with patch.object(cog, "_get_or_create_webhook", new=AsyncMock(return_value=webhook)):
            sent = await cog._send_webhook_message(
                channel=channel,
                channel_id=555,
                content="今日は日本語で話します。設定を確認してください。",
                include_view=False,
            )
        self.assertEqual(len(sent), 1)
        kwargs = webhook.send.await_args.kwargs
        self.assertTrue(kwargs["_agobot_skip_localization"])
        self.assertEqual(kwargs["content"], "今日は日本語で話します。設定を確認してください。")


class ZetaHistoryOriginalTest(unittest.IsolatedAsyncioTestCase):
    async def test_history_keeps_generated_text_verbatim(self):
        cog = ZetaModoki(types.SimpleNamespace())
        cog.active_personas[777] = _persona()
        original = "（笑顔で）やあ！今日は良い天気だね。設定の話は後にしよう。"

        async def fake_stream(*_args, **_kwargs):
            yield original[:10]
            yield original[10:]

        with patch("cogs.zetamodoki.logfare.chat_stream", side_effect=lambda *a, **k: fake_stream()):
            reply = await cog._generate_response(777, "おはよう", requester_id=42)
        self.assertEqual(reply, original)
        history = cog.chat_histories[777]
        self.assertEqual(history[-1]["bot"], original)
        self.assertEqual(history[-1]["user"], "おはよう")


class TransportSkipTest(unittest.TestCase):
    def test_ai_text_payload_with_skip_flag_is_not_rewritten(self):
        sender = types.SimpleNamespace(guild=types.SimpleNamespace(id=77))
        store = types.SimpleNamespace(get=lambda guild_id, section: {"locale": "en"})
        payload = {
            "content": "今日は日本語で話します。設定を確認してください。",
            "_agobot_skip_localization": True,
        }
        with patch.object(
            localization,
            "_ENGLISH_PAIRS",
            [("日本語", "English"), ("設定", "Settings"), ("確認してください", "check")],
        ), patch.object(localization, "get_store", return_value=store):
            result = localization.localize_kwargs(sender, payload)
        self.assertEqual(result["content"], payload["content"])


if __name__ == "__main__":
    unittest.main()
