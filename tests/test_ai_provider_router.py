"""同じモデルを複数の OpenAI 互換 API へ順に送る契約テスト。"""
from __future__ import annotations

import os
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

        app = web.Application()
        app.router.add_post("/first/v1/chat/completions", first)
        app.router.add_post("/second/v1/chat/completions", second)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
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
