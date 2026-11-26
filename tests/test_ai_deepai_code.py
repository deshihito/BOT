"""DeepAI Code ルート (core/general/ai/ai_deepai_code.py) の単体テスト。

上流への実リクエストは行わず、転送層 (_request / _resolve_lane) を差し替えて
ヘッダ構築・レーン探査・整形・エラー変換・目録パースを検証する。
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from core.general.ai import ai_deepai_code

ROOT = Path(__file__).resolve().parents[1]
RAW_MACHINE_ID = "ABCD-1234 Machine"
EXPECTED_FINGERPRINT = hashlib.sha256(b"abcd-1234machine").hexdigest()

MODELS_PAYLOAD = {
    "data": [
        {"id": "glm-5.3-flash", "name": "GLM 5.3 Flash", "input": ["text", "image"],
         "theosPerRequest": "0", "premier": False},
        {"id": "claude-opus-5-5", "name": "Claude Opus 5.5", "input": ["text"],
         "theosPerRequest": "15", "premier": True},
        {"id": "gpt-6-astra", "name": "GPT-6 Astra", "input": ["text", "image"],
         "theosPerRequest": "50", "api": "openai-responses"},
        {"id": "bare-model", "input": ["text"], "theosPerRequest": "3"},
    ]
}


def load_cog(name):
    path = (ROOT / "core" / "general" / "ai" / "cog.py" if name == "ai"
            else ROOT / "cogs" / f"{name}.py")
    spec = importlib.util.spec_from_file_location(f"agobot_dc_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Typing:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class FakeResponse:
    def __init__(self, status, payload=None, headers=None):
        self.status = status
        self._payload = payload
        self.headers = headers or {}
        self.content_type = "application/json" if payload is not None else "text/html"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self):
        return self._payload

    async def read(self):
        return b""


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def request(self, method, url, *, headers=None, allow_redirects=True, **kwargs):
        self.calls.append({
            "method": method, "url": url, "headers": headers,
            "allow_redirects": allow_redirects, "kwargs": kwargs,
        })
        return self.response


class DeepAICodeUnitTest(unittest.TestCase):
    def setUp(self):
        ai_deepai_code._lane_version = None
        ai_deepai_code._models_cache = []
        env = patch.dict(os.environ, {"DEEPAI_API_KEY": "test-key-uuid"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DEEPAI_CODE_API_KEY", None)
        raw = patch.object(ai_deepai_code, "_raw_machine_id", return_value=RAW_MACHINE_ID)
        raw.start()
        self.addCleanup(raw.stop)

    def test_api_key_prefers_code_specific_env(self):
        with patch.dict(os.environ, {"DEEPAI_CODE_API_KEY": "code-key",
                                     "DEEPAI_API_KEY": "plain-key"}):
            self.assertEqual(ai_deepai_code.api_key(), "code-key")
        with patch.dict(os.environ, {"DEEPAI_API_KEY": "plain-key"}):
            os.environ.pop("DEEPAI_CODE_API_KEY", None)
            self.assertEqual(ai_deepai_code.api_key(), "plain-key")

    def test_headers_carry_key_lane_instance_and_hashed_machine(self):
        headers = ai_deepai_code.build_headers(lane="4")
        self.assertEqual(headers["Api-Key"], "test-key-uuid")
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["X-DeepAI-Code-Theos"], "4")
        self.assertTrue(re.fullmatch(r"[0-9a-f]{32}", headers["X-DeepAI-Code-Instance"]))
        self.assertEqual(headers["X-DeepAI-Code-Machine"], EXPECTED_FINGERPRINT)
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", headers["X-DeepAI-Code-Machine"]))
        self.assertEqual(headers["User-Agent"], ai_deepai_code.USER_AGENT)
        for value in headers.values():
            self.assertNotIn(RAW_MACHINE_ID, value)
            self.assertNotIn("ABCD-1234", value)

    def test_machine_fingerprint_is_sha256_of_normalized_id(self):
        self.assertEqual(ai_deepai_code.machine_fingerprint(), EXPECTED_FINGERPRINT)

    def test_ensure_system_message_prepends_only_when_missing(self):
        user_only = [{"role": "user", "content": "質問"}]
        shaped = ai_deepai_code.ensure_system_message(user_only)
        self.assertEqual(shaped[0]["role"], "system")
        self.assertEqual(shaped[1:], user_only)
        self.assertEqual(user_only, [{"role": "user", "content": "質問"}])

        with_system = [{"role": "system", "content": "既存"}, {"role": "user", "content": "質問"}]
        self.assertIs(ai_deepai_code.ensure_system_message(with_system), with_system)
        with_developer = [{"role": "developer", "content": "既存"}]
        self.assertIs(ai_deepai_code.ensure_system_message(with_developer), with_developer)
        self.assertEqual(ai_deepai_code.ensure_system_message([])[0]["role"], "system")

    def test_parse_models_keeps_only_free_and_excludes_responses(self):
        models = ai_deepai_code._parse_models(MODELS_PAYLOAD)
        ids = [model["id"] for model in models]
        # free (theosPerRequest "0") だけが残る。premier と Responses 専用は除外。
        self.assertEqual(ids, ["glm-5.3-flash"])
        self.assertNotIn("claude-opus-5-5", ids)
        self.assertNotIn("bare-model", ids)
        self.assertNotIn("gpt-6-astra", ids)
        model = models[0]
        self.assertTrue(model["free"])
        self.assertTrue(model["supports_images"])
        self.assertEqual(model["name"], "GLM 5.3 Flash")

    def test_parse_models_free_judgement_tolerates_value_shapes(self):
        payload = {"data": [
            {"id": "int-zero", "input": ["text"], "theosPerRequest": 0},
            {"id": "float-zero", "input": ["text"], "theosPerRequest": "0.0"},
            {"id": "paid", "input": ["text"], "theosPerRequest": "3"},
            {"id": "missing-cost", "input": ["text"]},
        ]}
        ids = [model["id"] for model in ai_deepai_code._parse_models(payload)]
        self.assertEqual(ids, ["float-zero", "int-zero"])
        self.assertTrue(ai_deepai_code._is_free("0"))
        self.assertTrue(ai_deepai_code._is_free(0))
        self.assertTrue(ai_deepai_code._is_free("0.0"))
        self.assertFalse(ai_deepai_code._is_free("15"))
        self.assertFalse(ai_deepai_code._is_free(None))
        self.assertFalse(ai_deepai_code._is_free("free"))

    def test_status_conversion(self):
        with self.assertRaises(ai_deepai_code.DeepAICodeAuthError):
            ai_deepai_code._raise_for_status(302, None, {})
        with self.assertRaises(ai_deepai_code.DeepAICodeAuthError):
            ai_deepai_code._raise_for_status(401, None, {})
        with self.assertRaises(ai_deepai_code.DeepAICodeBusy) as busy:
            ai_deepai_code._raise_for_status(409, None, {"Retry-After": "120"})
        self.assertEqual(busy.exception.retry_after, 30.0)
        with self.assertRaises(ai_deepai_code.DeepAICodeAuthError) as auth:
            ai_deepai_code._raise_for_status(403, {"error": "email_unverified"}, {})
        self.assertIn("メール", str(auth.exception))
        ai_deepai_code._raise_for_status(200, None, {})


class DeepAICodeAsyncTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        ai_deepai_code._lane_version = None
        ai_deepai_code._models_cache = []
        env = patch.dict(os.environ, {"DEEPAI_API_KEY": "test-key-uuid"}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DEEPAI_CODE_API_KEY", None)
        raw = patch.object(ai_deepai_code, "_raw_machine_id", return_value=RAW_MACHINE_ID)
        raw.start()
        self.addCleanup(raw.stop)

    async def test_no_key_returns_empty_everywhere(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(await ai_deepai_code.fetch_models(), [])
            self.assertEqual(await ai_deepai_code.model_choices(), [])
            self.assertIsNone(await ai_deepai_code.fetch_theos())
            with self.assertRaises(ai_deepai_code.DeepAICodeAuthError):
                await ai_deepai_code.chat("deepaicode::glm-5.3-flash",
                                          [{"role": "user", "content": "質問"}])

    async def test_request_disables_redirects_and_sends_headers(self):
        session = FakeSession(FakeResponse(200, {"data": []}))
        status, payload, _headers = await ai_deepai_code._request(
            session, "GET", "/deepai_code/models", lane="4")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"data": []})
        call = session.calls[0]
        self.assertFalse(call["allow_redirects"])
        self.assertEqual(call["headers"]["Api-Key"], "test-key-uuid")
        self.assertEqual(call["headers"]["X-DeepAI-Code-Machine"], EXPECTED_FINGERPRINT)
        self.assertTrue(call["url"].endswith("/deepai_code/models"))

    async def test_lane_probe_skips_426_and_caches(self):
        responses = [(426, None, {}), (200, {"data": []}, {})]
        request = AsyncMock(side_effect=responses)
        with patch.object(ai_deepai_code, "_request", request):
            lane = await ai_deepai_code._resolve_lane(FakeSession(FakeResponse(200)))
            self.assertEqual(lane, "5")
            self.assertEqual(request.await_count, 2)
            again = await ai_deepai_code._resolve_lane(FakeSession(FakeResponse(200)))
            self.assertEqual(again, "5")
            self.assertEqual(request.await_count, 2)

    async def test_fetch_models_and_choices_shape(self):
        request = AsyncMock(return_value=(200, MODELS_PAYLOAD, {}))
        with patch.object(ai_deepai_code, "_resolve_lane", new_callable=AsyncMock,
                          return_value="4"), \
             patch.object(ai_deepai_code, "_request", request):
            models = await ai_deepai_code.fetch_models()
            choices = await ai_deepai_code.model_choices()
        # 一覧に出るのは free モデルだけ（premier は除外される）。
        self.assertEqual([model["id"] for model in models], ["glm-5.3-flash"])
        self.assertEqual(choices, [{"id": "deepaicode::glm-5.3-flash",
                                    "name": "DeepAI Code · GLM 5.3 Flash"}])
        self.assertTrue(ai_deepai_code.supports_images("deepaicode::glm-5.3-flash"))
        self.assertFalse(ai_deepai_code.supports_images("deepaicode::claude-opus-5-5"))
        self.assertEqual(ai_deepai_code.supports_reasoning_efforts("deepaicode::glm-5.3-flash"), [])
        self.assertEqual(ai_deepai_code.model_name("deepaicode::glm-5.3-flash"), "GLM 5.3 Flash")

    async def test_chat_shapes_messages_and_returns_text(self):
        captured = {}

        async def fake_request(session, method, path, *, lane, **kwargs):
            captured.update({"method": method, "path": path, "lane": lane, **kwargs})
            return 200, {"choices": [{"message": {"content": "回答です"}}]}, {}

        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock,
                          return_value=ai_deepai_code._parse_models(MODELS_PAYLOAD)), \
             patch.object(ai_deepai_code, "_resolve_lane", new_callable=AsyncMock,
                          return_value="4"), \
             patch.object(ai_deepai_code, "_request", side_effect=fake_request):
            answer = await ai_deepai_code.chat(
                "deepaicode::glm-5.3-flash", [{"role": "user", "content": "質問"}])
        self.assertEqual(answer, "回答です")
        self.assertEqual(captured["path"], "/deepai_code/chat/completions")
        self.assertEqual(captured["json"]["model"], "glm-5.3-flash")
        self.assertEqual(captured["json"]["messages"][0]["role"], "system")
        self.assertEqual(captured["json"]["messages"][1]["content"], "質問")

    async def test_chat_reprobes_lane_on_426(self):
        responses = [(426, None, {}),
                     (200, {"choices": [{"message": {"content": "再試行OK"}}]}, {})]
        request = AsyncMock(side_effect=responses)
        resolve = AsyncMock(side_effect=["4", "5"])
        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock,
                          return_value=ai_deepai_code._parse_models(MODELS_PAYLOAD)), \
             patch.object(ai_deepai_code, "_resolve_lane", resolve), \
             patch.object(ai_deepai_code, "_request", request):
            answer = await ai_deepai_code.chat(
                "glm-5.3-flash",
                [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}])
        self.assertEqual(answer, "再試行OK")
        self.assertEqual(resolve.await_count, 2)
        self.assertEqual(request.await_count, 2)

    async def test_chat_blocks_premier_model_without_upstream_call(self):
        request = AsyncMock()
        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock,
                          return_value=ai_deepai_code._parse_models(MODELS_PAYLOAD)), \
             patch.object(ai_deepai_code, "_request", request):
            with self.assertRaises(ai_deepai_code.DeepAICodeModelNotAllowedError) as raised:
                await ai_deepai_code.chat(
                    "deepaicode::claude-opus-5-5", [{"role": "user", "content": "質問"}])
        self.assertIn("free", str(raised.exception))
        request.assert_not_called()

    async def test_chat_blocks_model_flagged_not_free_in_cache(self):
        ai_deepai_code._models_cache = [{
            "id": "claude-opus-5-5", "name": "Claude Opus 5.5",
            "free": False, "supports_images": False,
        }]
        request = AsyncMock()
        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock) as fetch, \
             patch.object(ai_deepai_code, "_request", request):
            with self.assertRaises(ai_deepai_code.DeepAICodeModelNotAllowedError):
                await ai_deepai_code.chat(
                    "deepaicode::claude-opus-5-5", [{"role": "user", "content": "質問"}])
        fetch.assert_not_called()
        request.assert_not_called()

    async def test_chat_blocks_unknown_model_and_empty_catalog(self):
        request = AsyncMock()
        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock,
                          return_value=ai_deepai_code._parse_models(MODELS_PAYLOAD)), \
             patch.object(ai_deepai_code, "_request", request):
            with self.assertRaises(ai_deepai_code.DeepAICodeModelNotAllowedError):
                await ai_deepai_code.chat(
                    "deepaicode::no-such-model", [{"role": "user", "content": "質問"}])
        with patch.object(ai_deepai_code, "fetch_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(ai_deepai_code, "_request", request):
            with self.assertRaises(ai_deepai_code.DeepAICodeError):
                await ai_deepai_code.chat(
                    "deepaicode::glm-5.3-flash", [{"role": "user", "content": "質問"}])
        request.assert_not_called()

    async def test_ai_command_routes_to_deepai_code(self):
        ai = load_cog("ai")
        ctx = SimpleNamespace(author=SimpleNamespace(id=123),
                              message=SimpleNamespace(reference=None, attachments=[]),
                              typing=lambda: Typing(), reply=AsyncMock())
        with patch.object(ai.ai_preferences, "get_model", return_value="deepaicode::glm-5.3-flash"), \
             patch.object(ai.logfare, "api_key", return_value=None), \
             patch.object(ai.ai_deepai_code, "chat", new_callable=AsyncMock,
                          return_value="DeepAI Codeの回答") as chat:
            await ai.AICog.ai.callback(ai.AICog(None), ctx, prompt="質問")
        # 履歴判定 (ask_plain) + 本回答の2回。
        self.assertEqual(chat.await_count, 2)
        embed = ctx.reply.await_args.kwargs["embed"]
        self.assertEqual(embed.description, "DeepAI Codeの回答")
        self.assertIn("DeepAI Code", embed.footer.text)

    async def test_ai_command_rejects_premier_deepai_code_model(self):
        ai = load_cog("ai")
        ctx = SimpleNamespace(author=SimpleNamespace(id=123),
                              message=SimpleNamespace(reference=None, attachments=[]),
                              typing=lambda: Typing(), reply=AsyncMock())
        error = ai_deepai_code.DeepAICodeModelNotAllowedError(
            "モデル `claude-opus-5-5` は AGO では使えません。"
            "DeepAI Code は free ティア（Theos を消費しない）モデルだけ利用できます。"
        )
        with patch.object(ai.ai_preferences, "get_model",
                          return_value="deepaicode::claude-opus-5-5"), \
             patch.object(ai.logfare, "api_key", return_value=None), \
             patch.object(ai.ai_deepai_code, "chat", new_callable=AsyncMock,
                          side_effect=error):
            await ai.AICog.ai.callback(ai.AICog(None), ctx, prompt="質問")
        message = ctx.reply.await_args.args[0]
        self.assertIn("使えません", message)
        self.assertIn("free ティア", message)

    async def test_general_picker_includes_deepai_code_models(self):
        general = load_cog("general")
        with patch.object(general.ai_preferences, "ensure_loaded", new_callable=AsyncMock), \
             patch.object(general.ai_preferences, "get_model", return_value=None), \
             patch.object(general.ai_provider_router, "enabled", return_value=False), \
             patch.object(general.logfare, "fetch_free_chat_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(general.ai_provider_router, "fetch_kiosapi_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(general.ai_provider_router, "fetch_apinex_free_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(general.ai_provider_router, "fetch_numes_models", new_callable=AsyncMock,
                          return_value=[]), \
             patch.object(general.ai_deepai_code, "model_choices", new_callable=AsyncMock,
                          return_value=[{"id": "deepaicode::glm-5.3-flash",
                                         "name": "DeepAI Code · GLM 5.3 Flash"}]), \
             patch.object(general.ai_omnirush, "model_choices", return_value=[]):
            view = await general.AIDefaultView.create(123)
        self.assertEqual(view.select.model_ids, {"deepaicode::glm-5.3-flash"})


if __name__ == "__main__":
    unittest.main()
