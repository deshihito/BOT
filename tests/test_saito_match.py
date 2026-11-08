# -*- coding: utf-8 -*-
"""ランダム通話の拡張（開始カード・メンバー画像・チャット中継・再生音タップ）のテスト。

Discord / 外部ネットワークに接続せず、偽オブジェクトで確かめる。
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("BOT_API_KEY", "test-key")
os.environ.setdefault("BOT_API_BASE_URL", "http://localhost:9")

from PIL import Image

from core.vc import saito
from core.vc.match_image import render_match_card
from core.vc.voice_media import FRAME_BYTES, SharedAudioSource


def _icon_bytes(color=(200, 60, 60)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buf, format="PNG")
    return buf.getvalue()


class CardRenderTest(unittest.TestCase):
    def test_card_with_icons(self):
        png = render_match_card(
            "サーバーA", "サーバーB", _icon_bytes(), _icon_bytes((60, 60, 200)),
            members_a=3, members_b=5)
        self.assertTrue(png.startswith(b"\x89PNG"))
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.size, (920, 400))

    def test_card_without_icons_uses_placeholder(self):
        png = render_match_card("アイコン無し鯖", "相手のサーバー", None, None)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_card_with_decorative_and_long_names(self):
        png = render_match_card("𝐎𝐨𝐨のサーバー" + "あ" * 40, "𝕥𝕒𝕕𝕒の部屋",
                                None, None, members_a=1, members_b=2)
        self.assertTrue(png.startswith(b"\x89PNG"))


class RelayFormatTest(unittest.TestCase):
    def test_basic(self):
        text = saito.format_match_relay("たろう", "A鯖", "こんにちは", [])
        self.assertEqual(text, "**たろう**（A鯖）\nこんにちは")

    def test_attachments_appended(self):
        text = saito.format_match_relay("たろう", "A鯖", "", ["https://example.com/a.png"])
        self.assertIn("https://example.com/a.png", text)

    def test_truncated_to_2000(self):
        text = saito.format_match_relay("t", "g", "x" * 5000, [])
        self.assertLessEqual(len(text), 2000)


class _FakeSource:
    def __init__(self, frame: bytes):
        self.frame = frame

    def read(self) -> bytes:
        return self.frame

    def is_opus(self) -> bool:
        return False

    def cleanup(self) -> None:
        pass


class MixerTapTest(unittest.TestCase):
    def test_tap_receives_mix_excluding_match_source(self):
        mixer = SharedAudioSource()
        music_frame = b"\x10\x00" * (FRAME_BYTES // 2)
        match_frame = b"\x7f\x00" * (FRAME_BYTES // 2)
        mixer.add("music", _FakeSource(music_frame))
        mixer.add("match", _FakeSource(match_frame))
        received = []
        mixer.add_tap("match", received.append, exclude_key="match")
        mixer.read()
        self.assertEqual(len(received), 1)
        # match（無音プレースホルダ相当）を含まない、音楽だけのミックスが届く
        self.assertEqual(received[0], music_frame)

    def test_tap_not_called_when_only_excluded_source(self):
        mixer = SharedAudioSource()
        mixer.add("match", _FakeSource(b"\x01\x00" * (FRAME_BYTES // 2)))
        received = []
        mixer.add_tap("match", received.append, exclude_key="match")
        mixer.read()
        self.assertEqual(received, [])

    def test_remove_tap(self):
        mixer = SharedAudioSource()
        mixer.add("music", _FakeSource(b"\x10\x00" * (FRAME_BYTES // 2)))
        received = []
        mixer.add_tap("match", received.append, exclude_key="match")
        self.assertTrue(mixer.remove_tap("match"))
        mixer.read()
        self.assertEqual(received, [])


class _FakeTextChannel:
    def __init__(self, channel_id):
        self.id = channel_id
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append(content)
        return None


class _FakeManager:
    def __init__(self, sessions):
        self._sessions = sessions

    def get(self, guild_id):
        return self._sessions.get(guild_id)


def _make_cog(channels):
    bot = types.SimpleNamespace(
        user=types.SimpleNamespace(id=999),
        loop=None,
        get_channel=lambda cid: channels.get(cid),
    )
    bot.add_listener = lambda fn, name=None: None
    cog = saito.SaitoRelay(bot)
    return cog


class ChatRelayTest(unittest.IsolatedAsyncioTestCase):
    async def test_message_forwarded_to_peer_channel(self):
        dest = _FakeTextChannel(200)
        cog = _make_cog({200: dest})
        cog.chat_links[100] = 200
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, display_name="たろう"),
            channel=types.SimpleNamespace(id=100),
            guild=types.SimpleNamespace(name="A鯖"),
            content="やっほー", attachments=[])
        await cog._relay_chat_message(message)
        self.assertEqual(dest.sent, ["**たろう**（A鯖）\nやっほー"])

    async def test_bot_message_not_forwarded(self):
        dest = _FakeTextChannel(200)
        cog = _make_cog({200: dest})
        cog.chat_links[100] = 200
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=True, display_name="AGOBOT"),
            channel=types.SimpleNamespace(id=100),
            guild=types.SimpleNamespace(name="A鯖"),
            content="中継文", attachments=[])
        await cog._relay_chat_message(message)
        self.assertEqual(dest.sent, [])

    async def test_unlinked_channel_not_forwarded(self):
        dest = _FakeTextChannel(200)
        cog = _make_cog({200: dest})
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(bot=False, display_name="たろう"),
            channel=types.SimpleNamespace(id=300),
            guild=types.SimpleNamespace(name="A鯖"),
            content="hello", attachments=[])
        await cog._relay_chat_message(message)
        self.assertEqual(dest.sent, [])


def _fake_member(user_id, name, display=None, bot=False):
    return types.SimpleNamespace(
        id=user_id, name=name, display_name=display or name, bot=bot)


class MembersPngTest(unittest.IsolatedAsyncioTestCase):
    async def test_members_png_and_call_end(self):
        voice_a = types.SimpleNamespace(
            members=[_fake_member(1, "alice"), _fake_member(2, "bob")],
            guild=types.SimpleNamespace(name="A鯖"))
        voice_b = types.SimpleNamespace(
            members=[_fake_member(3, "carol")],
            guild=types.SimpleNamespace(name="B鯖"))
        channels = {900: voice_a, 901: voice_b}
        cog = _make_cog(channels)
        cog.voice_sessions = _FakeManager({
            10: types.SimpleNamespace(channel_id=900),
            20: types.SimpleNamespace(channel_id=901),
        })
        cog.peers[10] = 20
        cog.peers[20] = 10
        png = await cog._members_png(10, 20)
        self.assertTrue(png.startswith(b"\x89PNG"))
        # 通話が終わったら None
        cog.peers.clear()
        self.assertIsNone(await cog._members_png(10, 20))


if __name__ == "__main__":
    unittest.main()
