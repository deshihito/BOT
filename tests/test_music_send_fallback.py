# -*- coding: utf-8 -*-
"""音楽の送信ヘルパー（PlaybackMixin._send_message）の失効トークン対策。

保持した古い Interaction はトークン失効（15分）で 401 になるため、
チャンネルへ直接送るフォールバックを検証する。
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.modules.setdefault("yt_dlp", types.ModuleType("yt_dlp"))

import discord  # noqa: E402
from core.vc.music.playback import PlaybackMixin  # noqa: E402


def make_mixin() -> PlaybackMixin:
    return object.__new__(PlaybackMixin)


class FakeInteraction(discord.Interaction):
    """属性だけを持つ Interaction（isinstance 判定を通すため）。"""

    def __init__(self, *, created_at, channel, followup_send):
        # created_at は id（スノーフレーク）から算出される読み取り専用
        # プロパティなので、時刻は id 側に埋め込む。
        self.id = discord.utils.time_snowflake(created_at)
        self.channel = channel
        self.response = types.SimpleNamespace(is_done=lambda: True)
        self.followup = types.SimpleNamespace(send=followup_send)


def make_interaction(*, age_minutes: float = 0, followup_send=None):
    channel = types.SimpleNamespace(send=AsyncMock())
    interaction = object.__new__(FakeInteraction)
    FakeInteraction.__init__(
        interaction,
        created_at=discord.utils.utcnow() - timedelta(minutes=age_minutes),
        channel=channel,
        followup_send=followup_send or AsyncMock())
    return interaction, channel


def http_error(status: int) -> discord.HTTPException:
    response = types.SimpleNamespace(status=status, reason="error")
    return discord.HTTPException(response, {"message": "boom", "code": 50027})


class SendMessageFallbackTest(unittest.IsolatedAsyncioTestCase):
    async def test_expired_interaction_sends_via_channel(self):
        interaction, channel = make_interaction(age_minutes=20)
        await make_mixin()._send_message(interaction, text="now playing")
        channel.send.assert_awaited_once()
        interaction.followup.send.assert_not_awaited()

    async def test_401_falls_back_to_channel(self):
        interaction, channel = make_interaction(
            followup_send=AsyncMock(side_effect=http_error(401)))
        await make_mixin()._send_message(interaction, text="now playing")
        channel.send.assert_awaited_once()

    async def test_fresh_interaction_uses_followup(self):
        interaction, channel = make_interaction()
        await make_mixin()._send_message(interaction, text="now playing")
        interaction.followup.send.assert_awaited_once()
        channel.send.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
