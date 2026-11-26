"""同じモデルを複数の OpenAI 互換 API へ順に送る契約テスト。"""
from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch

from aiohttp import web

from core.general.ai import ai_provider_router as router
class AiProviderRouterTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []

        async def first(request):
            self.calls.append(("first", request.headers.get("Authorization"), await request.json()))
            return web.Response(status=429, headers={"Retry-After": "60"})

        async def second(request):
            self.calls.append(("second", request.headers.get("Authorization"), await request.json()))
            return web.json_response({"choices": [{"message": {"content": "回答"}}]})

        async def logfare_limited(request):
            self.calls.append(("logfare", request.headers.get("Authorization"), await request.json()))
            return web.Response(status=429, headers={"Retry-After": "120"}, text="private upstream response")

        async def kios_models(request):
            self.calls.append(("kios-models", request.headers.get("Authorization"), None))
            return web.json_response({"object": "list", "data": [
                {"id": "gpt-example", "owned_by": "openai"},
                {"id": "claude-example", "owned_by": "anthropic"},
            ]})

        async def apinex_models(request):
            self.calls.append(("apinex-models", request.headers.get("Authorization"), None))
            return web.json_response({"object": "list", "data": [
                {"id": "free/deepseek-v4-flash", "owned_by": "DeepSeek"},
                {"id": "free/muse-spark-1.3", "owned_by": "Muse"},
                {"id": "gpt-6-sol", "owned_by": "GPT"},
            ]})

        async def numes_models(request):
            self.calls.append(("numes-models", request.headers.get("Authorization"), None))
            zero = {"prompt": "0", "completion": "0", "request": "0",
                    "image": "0", "audio": "0"}
            return web.json_response({"object": "list", "data": [
                {"id": "zeta/example-chat", "owned_by": "zeta",
                 "pricing": {**zero, "prompt": "0.001", "completion": "0.002"}},
                {"id": "alpha/example-chat", "owned_by": "alpha", "pricing": zero},
                {"id": "beta/request-charged", "owned_by": "beta",
                 "pricing": {**zero, "request": "0.01"}},
                {"id": "gamma/no-pricing", "owned_by": "gamma"},
                {"id": 123, "owned_by": "invalid"},
                {"id": "  ", "owned_by": "blank"},
                "not-a-dict",
            ]})

        app = web.Application()
        app.router.add_post("/first/v1/chat/completions", first)
        app.router.add_post("/second/v1/chat/completions", second)
        app.router.add_post("/logfare/v1/chat/completions", logfare_limited)
        app.router.add_get("/kios/v1/models", kios_models)
        app.router.add_post("/kios/v1/chat/completions", second)
        app.router.add_get("/apinex/v1/models", apinex_models)
        app.router.add_post("/apinex/v1/chat/completions", second)
        app.router.add_get("/numes/api/v1/models", numes_models)
        app.router.add_post("/numes/api/v1/chat/completions", second)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.logfare_url = f"http://127.0.0.1:{port}/logfare/v1"
        self.env = patch.dict(os.environ, {
            "AI_PROVIDER_ORDER": "first,second",
            "AI_ROUTED_MODEL": "same-model",
            "AI_FIRST_BASE_URL": f"http://127.0.0.1:{port}/first/v1",
            "AI_FIRST_API_KEY": "key-1",
            "AI_SECOND_BASE_URL": f"http://127.0.0.1:{port}/second/v1",
            "AI_SECOND_API_KEY": "key-2",
        })
        self.env.start()
        router._cooldown_until.clear()

    async def asyncTearDown(self):
        self.env.stop()
        router._cooldown_until.clear()
        await self.runner.cleanup()

    async def test_rate_limit_switches_to_same_model_and_cools_down(self):
        messages = [{"role": "user", "content": "質問"}]
        answer = await router.chat(messages)
        self.assertEqual((answer.text, answer.provider, answer.model),
                         ("回答", "second", "same-model"))
        self.assertEqual([call[0] for call in self.calls], ["first", "second"])
        self.assertEqual([call[2]["model"] for call in self.calls],
                         ["same-model", "same-model"])
        self.assertEqual([call[1] for call in self.calls], ["Bearer key-1", "Bearer key-2"])

        await router.chat(messages)
        self.assertEqual([call[0] for call in self.calls], ["first", "second", "second"])

    async def test_logfare_rate_limit_cools_down_and_logs_safe_status(self):
        messages = [{"role": "user", "content": "質問"}]
        with patch.dict(os.environ, {"AI_PROVIDER_ORDER": "logfare,second", "LOGFARE_API_KEY": "secret-key"}), \
             patch.object(router.logfare, "BASE_URL", self.logfare_url), \
             self.assertLogs(router.logger, level="WARNING") as logs:
            first = await router.chat(messages)
            second = await router.chat(messages)
        self.assertEqual((first.provider, second.provider), ("second", "second"))
        self.assertEqual([call[0] for call in self.calls], ["logfare", "second", "second"])
        self.assertGreater(router._cooldown_until["logfare"], time.monotonic() + 100)
        self.assertIn("provider=logfare status=429", logs.output[0])
        self.assertNotIn("secret-key", "\n".join(logs.output))
        self.assertNotIn("質問", "\n".join(logs.output))
        self.assertNotIn("private upstream response", "\n".join(logs.output))

    async def test_provider_http_error_logs_status_without_request_data(self):
        messages = [{"role": "user", "content": "private prompt"}]
        original_call = router._call

        async def fail_first(route, supplied_messages, max_tokens):
            if route.name == "first":
                raise router.ProviderHTTPError(401)
            return await original_call(route, supplied_messages, max_tokens)

        with patch.object(router, "_call", side_effect=fail_first), \
             self.assertLogs(router.logger, level="WARNING") as logs:
            answer = await router.chat(messages)
        self.assertEqual(answer.provider, "second")
        self.assertIn("provider=first status=401", logs.output[0])
        self.assertNotIn("key-1", "\n".join(logs.output))
        self.assertNotIn("private prompt", "\n".join(logs.output))

    async def test_kiosapi_catalog_and_selected_model(self):
        base = self.logfare_url.removesuffix("/logfare/v1") + "/kios/v1"
        with patch.dict(os.environ, {
            "AI_KIOSAPI_BASE_URL": base,
            "AI_KIOSAPI_API_KEY": "kios-secret",
        }):
            models = await router.fetch_kiosapi_models()
            answer = await router.chat_with_model(
                "kiosapi", "claude-example", [{"role": "user", "content": "質問"}]
            )
        self.assertEqual([model["id"] for model in models], ["claude-example", "gpt-example"])
        self.assertEqual((answer.text, answer.provider, answer.model),
                         ("回答", "kiosapi", "claude-example"))
        self.assertEqual([item[0] for item in self.calls], ["kios-models", "second"])
        self.assertEqual(self.calls[0][1], "Bearer kios-secret")
        self.assertEqual(self.calls[1][2]["model"], "claude-example")

    async def test_apinex_free_catalog_and_reasoning_filter(self):
        base = self.logfare_url.removesuffix("/logfare/v1") + "/apinex/v1"
        with patch.dict(os.environ, {
            "AI_APINEX_BASE_URL": base,
            "AI_APINEX_API_KEY": "apinex-secret",
            "AI_KIOSAPI_BASE_URL": base,
            "AI_KIOSAPI_API_KEY": "kios-secret",
        }):
            models = await router.fetch_apinex_free_models()
            supported = await router.chat_with_model(
                "apinex", "free/deepseek-v4-flash", [{"role": "user", "content": "質問"}],
                reasoning_effort="medium",
            )
            unsupported = await router.chat_with_model(
                "apinex", "free/muse-spark-1.3", [{"role": "user", "content": "質問"}],
                reasoning_effort="high",
            )
            other_provider = await router.chat_with_model(
                "kiosapi", "claude-example", [{"role": "user", "content": "質問"}],
                reasoning_effort="high",
            )
        self.assertEqual([model["id"] for model in models],
                         ["free/deepseek-v4-flash", "free/muse-spark-1.3"])
        self.assertEqual(supported.provider, "apinex")
        self.assertEqual(unsupported.provider, "apinex")
        self.assertEqual(other_provider.provider, "kiosapi")
        payloads = [call[2] for call in self.calls if call[0] == "second"]
        self.assertEqual(payloads[0].get("reasoning_effort"), "medium")
        self.assertNotIn("reasoning_effort", payloads[1])
        self.assertNotIn("reasoning_effort", payloads[2])
        self.assertEqual(router.supported_reasoning_efforts("apinex", "free/glm-5.3"),
                         ["low", "medium", "high"])
        self.assertEqual(router.supported_reasoning_efforts("apinex", "free/muse-spark-1.3"), [])

    async def test_numes_catalog_and_selected_model(self):
        base = self.logfare_url.removesuffix("/logfare/v1") + "/numes/api/v1"
        # キー未設定では一覧は空（モデル選択画面に Numes は出ない）。
        self.assertEqual(await router.fetch_numes_models(), [])
        with patch.dict(os.environ, {
            "AI_NUMES_BASE_URL": base,
            "NUMES_API_KEY": "numes-secret",
        }):
            models = await router.fetch_numes_models()
            answer = await router.chat_with_model(
                "numes", "alpha/example-chat", [{"role": "user", "content": "質問"}],
                reasoning_effort="high",
            )
        # pricing が全て 0 の free モデルだけを返し、有料・価格不明・不正な id は除く。
        self.assertEqual([model["id"] for model in models], ["alpha/example-chat"])
        self.assertEqual((answer.text, answer.provider, answer.model),
                         ("回答", "numes", "alpha/example-chat"))
        # 呼び出しは 一覧取得 → 実行ガードの一覧確認 → チャット本体。
        self.assertEqual([item[0] for item in self.calls],
                         ["numes-models", "numes-models", "second"])
        self.assertEqual(self.calls[0][1], "Bearer numes-secret")
        payload = next(call[2] for call in self.calls if call[0] == "second")
        self.assertEqual(payload["model"], "alpha/example-chat")
        # Numes には思考強度や予約フィールドを送らない。
        self.assertNotIn("reasoning_effort", payload)
        self.assertEqual(router.BASE_URLS["numes"], "https://api.numes.ai/api/v1")
        self.assertEqual(router.supported_reasoning_efforts("numes", "alpha/example-chat"), [])

    def test_numes_is_free_judgement(self):
        zero = {"prompt": "0", "completion": "0.00", "request": "0",
                "image": "0", "audio": "0"}
        self.assertTrue(router._numes_is_free({"pricing": zero}))
        self.assertTrue(router._numes_is_free(
            {"pricing": {"prompt": "0", "completion": "0"}}))
        self.assertFalse(router._numes_is_free(
            {"pricing": {**zero, "input_cache_write": "0.5"}}))
        self.assertFalse(router._numes_is_free(
            {"pricing": {**zero, "prompt": "0.000001"}}))
        self.assertFalse(router._numes_is_free({"pricing": {"prompt": "0"}}))
        self.assertFalse(router._numes_is_free({"pricing": None}))
        self.assertFalse(router._numes_is_free({}))
        self.assertFalse(router._numes_is_free(
            {"pricing": {**zero, "prompt": "not-a-number"}}))

    async def test_numes_paid_model_is_blocked_at_execution(self):
        base = self.logfare_url.removesuffix("/logfare/v1") + "/numes/api/v1"
        with patch.dict(os.environ, {
            "AI_NUMES_BASE_URL": base,
            "NUMES_API_KEY": "numes-secret",
        }):
            with self.assertRaises(router.ModelNotAllowedError) as raised:
                await router.chat_with_model(
                    "numes", "zeta/example-chat", [{"role": "user", "content": "質問"}]
                )
        self.assertIn("free", str(raised.exception))
        # 上流のチャット本体へは送られていない（目録確認だけ）。
        self.assertEqual([item[0] for item in self.calls], ["numes-models"])

    async def test_apinex_non_free_model_is_blocked_at_execution(self):
        base = self.logfare_url.removesuffix("/logfare/v1") + "/apinex/v1"
        with patch.dict(os.environ, {
            "AI_APINEX_BASE_URL": base,
            "AI_APINEX_API_KEY": "apinex-secret",
        }):
            with self.assertRaises(router.ModelNotAllowedError) as raised:
                await router.chat_with_model(
                    "apinex", "gpt-6-sol", [{"role": "user", "content": "質問"}]
                )
        self.assertIn("Free", str(raised.exception))
        self.assertEqual(self.calls, [])
