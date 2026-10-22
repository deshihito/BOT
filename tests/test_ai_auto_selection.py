"""Discord の !ai と /general が自動切替モデルを扱うことを確認する。"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]


def load_cog(name):
    # この PC には無関係な site-packages/cogs があるため、ファイルを直接ロードする。
    spec = importlib.util.spec_from_file_location(f"agobot_{name}", ROOT / "cogs" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Typing:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class AiAutoSelectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_ai_uses_router_without_logfare_key(self):
        ai = load_cog("ai")
        ctx = SimpleNamespace(author=SimpleNamespace(id=123), typing=lambda: Typing(),
                              reply=AsyncMock())
        answer = ai.ai_provider_router.Answer("回答", "second", "same-model")
        with patch.object(ai.ai_preferences, "get_model", return_value="ai/auto"), \
             patch.object(ai.ai_provider_router, "enabled", return_value=True), \
             patch.object(ai.ai_provider_router, "chat", new_callable=AsyncMock,
                          return_value=answer) as chat, \
             patch.object(ai.logfare, "api_key", return_value=None), \
             patch.object(ai.logfare, "resolve_model", new_callable=AsyncMock) as resolve:
            await ai.AICog.ai.callback(ai.AICog(None), ctx, prompt="質問")
        chat.assert_awaited_once()
        resolve.assert_not_awaited()
        embed = ctx.reply.await_args.kwargs["embed"]
        self.assertEqual(embed.description, "回答")
        self.assertIn("same-model", embed.footer.text)
        self.assertIn("second", embed.footer.text)

    async def test_ai_keeps_logfare_default_when_auto_is_configured(self):
        ai = load_cog("ai")
        ctx = SimpleNamespace(author=SimpleNamespace(id=123), typing=lambda: Typing(),
                              reply=AsyncMock())
        with patch.object(ai.ai_preferences, "get_model", return_value=None), \
             patch.object(ai.ai_provider_router, "enabled", return_value=True), \
             patch.object(ai.ai_provider_router, "chat", new_callable=AsyncMock) as routed, \
             patch.object(ai.logfare, "api_key", return_value="key"), \
             patch.object(ai.logfare, "configured_default_model", return_value="logfare-model"), \
             patch.object(ai.logfare, "resolve_model", new_callable=AsyncMock,
                          return_value=("logfare-model", True)), \
             patch.object(ai.logfare, "fetch_free_chat_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(ai.logfare, "chat", new_callable=AsyncMock,
                          return_value="回答") as logfare_chat:
            await ai.AICog.ai.callback(ai.AICog(None), ctx, prompt="質問")
        routed.assert_not_awaited()
        logfare_chat.assert_awaited_once()

    async def test_general_picker_has_one_auto_model(self):
        general = load_cog("general")
        with patch.object(general.ai_preferences, "ensure_loaded", new_callable=AsyncMock), \
             patch.object(general.ai_preferences, "get_model", return_value=None), \
             patch.object(general.ai_provider_router, "enabled", return_value=True), \
             patch.object(general.ai_provider_router, "logical_model", return_value="same-model"), \
             patch.object(general.logfare, "configured_default_model", return_value="logfare/auto"), \
             patch.object(general.logfare, "fetch_free_chat_models", new_callable=AsyncMock,
                          return_value=[{"id": "logfare/auto"}]):
            view = await general.AIDefaultView.create(123)
        self.assertEqual(view.select.model_ids, {"ai/auto", "logfare/auto"})
        self.assertTrue(any(option.default and option.value == "logfare/auto"
                            for option in view.select.options))
