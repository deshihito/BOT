# -*- coding: utf-8 -*-
"""カラオケ（core/vc/karaoke/entry.py）のテスト（監査 #9）。

Vosk／opus／Discord 接続なしで検証できる部分:
48k→16k リサンプル、歌詞の正規化（clean_text）、採点計算、_karaoke_impl の振り分け。
"""
import threading
import types
import unittest
from unittest.mock import AsyncMock

import numpy as np

from cogs.vc import KaraokeCog, clean_text, resample_48k_to_16k


class ResampleTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(resample_48k_to_16k(b""), b"")

    def test_downsample_ratio_and_mono_mix(self):
        # 9 フレーム (L=3000, R=1000) → モノラル 2000 を 3 つおきに → 3 サンプル
        frames = np.tile(np.array([3000, 1000], dtype=np.int16), 9)
        out = np.frombuffer(resample_48k_to_16k(frames.tobytes()), dtype=np.int16)
        self.assertEqual(len(out), 3)
        self.assertTrue(np.all(out == 2000))

    def test_left_only_signal(self):
        frames = np.zeros((6, 2), dtype=np.int16)
        frames[:, 0] = 900
        out = np.frombuffer(resample_48k_to_16k(frames.tobytes()), dtype=np.int16)
        self.assertEqual(len(out), 2)
        self.assertTrue(np.all(out == 450))


class CleanTextTests(unittest.TestCase):
    def test_removes_spaces_and_punctuation(self):
        self.assertEqual(clean_text(" あ い、う。え!お? "), "あいうえお")

    def test_keeps_alnum_and_cjk(self):
        self.assertEqual(clean_text("abc 123 歌詞テスト"), "abc123歌詞テスト")

    def test_removes_emoji_and_symbols(self):
        self.assertEqual(clean_text("🎤カラオケ♪最高"), "カラオケ最高")

    def test_empty(self):
        self.assertEqual(clean_text(""), "")
        self.assertEqual(clean_text("！？…"), "")


def _view_text(view):
    """Components V2 ビューから TextDisplay のテキストを集める（テスト用）。"""
    out = []

    def walk(item):
        content = getattr(item, "content", None)
        if isinstance(content, str):
            out.append(content)
        for child in getattr(item, "children", None) or []:
            walk(child)

    for top in getattr(view, "children", []):
        walk(top)
    return "\n".join(out)


class _FakeResponder:
    def __init__(self, guild_id=1):
        self.guild = types.SimpleNamespace(id=guild_id)
        self.user = types.SimpleNamespace(id=9, voice=None)
        self.channel = types.SimpleNamespace(id=3)
        self.sent = []

    async def send(self, embed=None, ephemeral=False, **kwargs):
        if embed is None and kwargs.get("view") is not None:
            # V2 化された返信は、検証用にテキスト化して description として持つ
            embed = types.SimpleNamespace(description=_view_text(kwargs["view"]))
        self.sent.append((embed, ephemeral, kwargs))

    async def defer(self):
        pass


def _cog(sessions=None):
    cog = KaraokeCog.__new__(KaraokeCog)
    cog.bot = types.SimpleNamespace()
    cog.sessions = sessions if sessions is not None else {}
    cog.voice_sessions = types.SimpleNamespace(release=AsyncMock(return_value=True))
    cog.vosk_model = None
    return cog


def _fake_sink(user_buffers):
    return types.SimpleNamespace(_lock=threading.Lock(), user_buffers=user_buffers)


class KaraokeImplDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_without_session_warns(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._karaoke_impl(r, "stop")
        self.assertIn("実行されていません", r.sent[0][0].description)
        self.assertTrue(r.sent[0][1])

    async def test_unknown_action_shows_help(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._karaoke_impl(r, "help")
        self.assertIn("カラオケ機能の使い方", r.sent[0][0].description)

    async def test_start_without_lyrics_warns(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._karaoke_impl(r, "start", target_lyrics=None)
        self.assertIn("お題の歌詞", r.sent[0][0].description)
        r2 = _FakeResponder()
        await cog._karaoke_impl(r2, "start", target_lyrics="   ")
        self.assertIn("お題の歌詞", r2.sent[0][0].description)

    async def test_score_without_session_warns(self):
        cog = _cog()
        r = _FakeResponder()
        await cog._karaoke_impl(r, "score")
        self.assertIn("実行されていません", r.sent[0][0].description)


class ScoreTests(unittest.IsolatedAsyncioTestCase):
    async def _score(self, target_lyrics, user_buffers):
        session = {"sink": _fake_sink(user_buffers), "vc": object(),
                   "target_lyrics": target_lyrics, "start_time": 0.0}
        cog = _cog({1: session})
        r = _FakeResponder()
        await cog._score(r)
        # 返信は Components V2 化されているため、表示テキストで検証する
        return r.sent[0][0].description

    async def test_perfect_score(self):
        text = await self._score("あいうえお", {
            11: {"display_name": "歌手", "history": ["あい", "うえお"]},
        })
        self.assertIn("歌手", text)
        self.assertIn("100.0 点", text)
        self.assertIn("PERFECT", text)

    async def test_partial_score_uses_cleaned_text(self):
        # お題に空白・記号が混ざっていても正規化してから比較する
        text = await self._score("あい うえお!", {
            11: {"display_name": "歌手", "history": ["あいうえお"]},
        })
        self.assertIn("100.0 点", text)

    async def test_low_score_comment(self):
        text = await self._score("あいうえおかきくけこ", {
            11: {"display_name": "歌手", "history": ["さしすせそ"]},
        })
        self.assertIn("KEEP TRYING", text)

    async def test_no_singing_yet(self):
        text = await self._score("あいうえお", {
            11: {"display_name": "歌手", "history": []},
        })
        self.assertIn("まだ歌声が検知されていません！", text)
        self.assertNotIn("歌手", text)

    async def test_users_without_history_are_skipped(self):
        text = await self._score("あいうえお", {
            11: {"display_name": "無言", "history": []},
            12: {"display_name": "歌手", "history": ["あいうえお"]},
        })
        self.assertIn("歌手", text)
        self.assertIn("100.0 点", text)
        self.assertNotIn("無言", text)


if __name__ == "__main__":
    unittest.main()
