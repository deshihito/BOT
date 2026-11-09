# -*- coding: utf-8 -*-
"""boardNotify 検知の堅牢化テスト。

成功文が Embed の description 以外（フィールド / Components V2）にあっても
検知できること、Bot ID ゲートとフレーズ対の条件は維持されることを確かめる。
Discord には接続しない。
"""
from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("BOT_API_KEY", "test-key")
os.environ.setdefault("BOT_API_BASE_URL", "http://localhost:9")

import discord

from core.game.rta.common import (
    DICOALL_BOT_ID,
    SABACHA_BOT_ID,
    SHARKBOT_BOT_ID,
    TAKASUMI_BOT_ID,
)
from core.game.rta.detect import detect_event

MESSAGE_ID = (1767225600000 - 1420070400000) << 22  # 2026-01-01T00:00:00Z


def make_message(author_id, *, embeds=(), components=(), content=""):
    return SimpleNamespace(
        id=MESSAGE_ID,
        guild=SimpleNamespace(id=456),
        channel=SimpleNamespace(type=discord.ChannelType.text),
        author=SimpleNamespace(id=author_id, bot=True),
        application_id=author_id,
        webhook_id=None,
        interaction_metadata=SimpleNamespace(
            type=discord.InteractionType.application_command,
            user=SimpleNamespace(id=123),
        ),
        interaction=None,
        embeds=list(embeds),
        components=list(components),
        content=content,
        edited_at=None,
    )


def make_embed(*, description=None, fields=()):
    return SimpleNamespace(
        title=None, description=description, url=None, type=None,
        author=None, footer=None, provider=None, image=None,
        thumbnail=None, video=None,
        fields=[SimpleNamespace(name=n, value=v) for n, v in fields],
    )


def text_display(text):
    return SimpleNamespace(content=text)


def container(*children):
    return SimpleNamespace(children=list(children))


class RichContentDetectionTest(unittest.TestCase):
    def test_takasumi_via_components_v2(self):
        message = make_message(TAKASUMI_BOT_ID, components=[
            container(text_display("サーバーをUPしました！\n表示順位が更新されました")),
        ])
        event = detect_event(message)
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "takasumi")
        self.assertEqual(event[1], 123)

    def test_dicoall_phrases_in_fields(self):
        message = make_message(DICOALL_BOT_ID, embeds=[make_embed(fields=(
            ("結果", "🎉 サーバーがリストの最上段に更新されました！"),
            ("状態", "サーバーリストのトップに正常に表示されています。"),
        ))])
        event = detect_event(message)
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "dicoall")

    def test_sabacha_voted_in_component_text(self):
        message = make_message(SABACHA_BOT_ID, components=[
            text_display("投票ありがとうございました voted"),
        ])
        event = detect_event(message)
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "vote")

    def test_sharkbot_embed_description_still_detected(self):
        message = make_message(SHARKBOT_BOT_ID, embeds=[
            make_embed(description="サーバーをUpしました！ 2時間後に再度Upできます"),
        ])
        event = detect_event(message)
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "sharkbot")

    def test_wrong_bot_with_same_phrases_ignored(self):
        message = make_message(999, components=[
            text_display("サーバーをUPしました！ 表示順位が更新されました"),
        ])
        self.assertIsNone(detect_event(message))

    def test_partial_phrase_ignored(self):
        message = make_message(TAKASUMI_BOT_ID, components=[
            text_display("UPしました"),
        ])
        self.assertIsNone(detect_event(message))


if __name__ == "__main__":
    unittest.main()
