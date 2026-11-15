"""/vc コマンドの応答期限切れ（10062 Unknown interaction）フォールバックのテスト。

defer が期限切れで失敗しても、パネルを通常メッセージとしてチャンネルに出す。
Discord には接続しない。
"""

import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {"BOT_API_BASE_URL": "http://127.0.0.1:9", "BOT_API_KEY": "dummy"}.items():
    os.environ.setdefault(_name, _value)
sys.modules.setdefault("yt_dlp", types.ModuleType("yt_dlp"))

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

from core.vc import hub  # noqa: E402


class _Resp:
    status = 404
    reason = "Not Found"


def not_found(code):
    return discord.NotFound(_Resp(), {"message": "x", "code": code})


def make_interaction(defer_side_effect=None):
    interaction = types.SimpleNamespace(
        guild_id=None,  # 履歴スペック取得をスキップさせる
        user=types.SimpleNamespace(id=123),
        response=types.SimpleNamespace(
            defer=AsyncMock(side_effect=defer_side_effect),
        ),
        followup=types.SimpleNamespace(send=AsyncMock()),
        channel=types.SimpleNamespace(send=AsyncMock()),
    )
    return interaction


class VcPanelFallbackTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
        self.cog = hub.VoiceHub(bot)

    async def run_vc(self, interaction):
        with patch.object(hub, "VoicePanelView", MagicMock(return_value=MagicMock())), \
             patch.object(hub, "as_panel_v2", side_effect=lambda view: "PANEL"):
            await self.cog.vc.callback(self.cog, interaction)

    async def test_normal_path_uses_followup(self):
        interaction = make_interaction()
        await self.run_vc(interaction)
        interaction.followup.send.assert_awaited_once()
        self.assertEqual(interaction.followup.send.await_args.kwargs.get("view"), "PANEL")
        interaction.channel.send.assert_not_awaited()

    async def test_unknown_interaction_falls_back_to_channel_message(self):
        interaction = make_interaction(defer_side_effect=not_found(10062))
        with self.assertLogs("cogs.sio_voice", level="WARNING") as logs:
            await self.run_vc(interaction)
        self.assertTrue(any("期限切れ" in line for line in logs.output))
        interaction.channel.send.assert_awaited_once()
        self.assertEqual(interaction.channel.send.await_args.kwargs.get("view"), "PANEL")
        interaction.followup.send.assert_not_awaited()

    async def test_other_not_found_still_raises(self):
        interaction = make_interaction(defer_side_effect=not_found(10008))
        with self.assertRaises(discord.NotFound):
            await self.run_vc(interaction)
        interaction.channel.send.assert_not_awaited()
        interaction.followup.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
