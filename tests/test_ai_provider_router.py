"""同じモデルを複数の OpenAI 互換 API へ順に送る契約テスト。"""
from __future__ import annotations

import os
import time
import unittest
from unittest.mock import patch

from aiohttp import web

from core import ai_provider_router as router


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

        app = web.Application()
        app.router.add_post("/first/v1/chat/completions", first)
        app.router.add_post("/second/v1/chat/completions", second)
        app.router.add_post("/logfare/v1/chat/completions", logfare_limited)
        app.router.add_get("/kios/v1/models", kios_models)
        app.router.add_post("/kios/v1/chat/completions", second)
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
        with patch.dict(os.environ, {"AI_PROVIDER_ORDER": "logfare,second"}), \
             patch.object(router.logfare, "api_key", return_value="secret-key"), \
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
