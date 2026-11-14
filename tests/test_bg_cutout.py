# -*- coding: utf-8 -*-
"""背景透過・絵文字/スタンプ化（core/general/bg_cutout.py + bgcut/engine.py）のテスト。

エンジンのエンコード（上限内への段階劣化・320×320 化・GIF/APNG 化）と
入力ガードはモデル無しで確かめ、背景除去そのものは onnxruntime と
モデルがある環境でのみ実推論で確かめる（無い環境では skip）。
待ちフローは Discord に接続せず偽オブジェクトで確かめる。
"""
import asyncio
import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw  # noqa: E402

from core.general import bg_cutout  # noqa: E402
from core.general.bg_cutout import (  # noqa: E402
    BG_CUTOUT_MAX_INPUT_BYTES,
    BgCutoutMixin,
    BgCutoutFailed,
    _bgcut_image_attachment,
    bgcut_result_text,
)
from core.general.bgcut import engine  # noqa: E402


def _model_ready() -> bool:
    """onnxruntime が import でき、モデルファイルが既に存在する場合のみ True。

    テスト実行時にダウンロードは試みない（ネットワーク依存を避ける）。
    """
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return engine.model_path().exists()


MODEL_READY = _model_ready()


def _subject_rgba(size=(400, 300), bg_alpha=0):
    """中央に赤い円を持つ RGBA（背景は既定で透明）を作る。"""
    img = Image.new("RGBA", size, (0, 0, 0, bg_alpha))
    d = ImageDraw.Draw(img)
    w, h = size
    d.ellipse([w // 4, h // 6, 3 * w // 4, 5 * h // 6], fill=(200, 30, 30, 255))
    return img


def _opaque_photo(size=(800, 600)):
    """白背景＋赤い円の不透明な写真風画像。"""
    img = Image.new("RGB", size, (245, 245, 245))
    d = ImageDraw.Draw(img)
    w, h = size
    d.ellipse([w // 4, h // 6, 3 * w // 4, 5 * h // 6], fill=(200, 30, 30))
    return img


def _anim_frames(n=10, size=(200, 200)):
    frames = []
    for i in range(n):
        f = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(f).rectangle(
            [20 + i * 8, 70, 80 + i * 8, 130], fill=(30, 60, 200, 255))
        frames.append(f)
    return frames


class EncodeStillTest(unittest.TestCase):
    def test_emoji_png_within_limits_and_keeps_alpha(self):
        data, (w, h), _notes = engine.encode_still_emoji(_subject_rgba((800, 600)))
        self.assertLessEqual(len(data), engine.EMOJI_MAX_BYTES)
        self.assertLessEqual(max(w, h), 128)
        out = Image.open(io.BytesIO(data))
        out.load()
        self.assertEqual(out.size, (w, h))
        rgba = out.convert("RGBA")
        self.assertEqual(rgba.getpixel((1, 1))[3], 0)       # 背景は透明
        self.assertEqual(rgba.getpixel((w // 2, h // 2))[3], 255)  # 被写体は不透明

    def test_sticker_png_is_exactly_320_and_within_limits(self):
        data, size, _notes = engine.encode_still_sticker(_subject_rgba((500, 200)))
        self.assertEqual(size, (320, 320))
        self.assertLessEqual(len(data), engine.STICKER_MAX_BYTES)
        out = Image.open(io.BytesIO(data))
        out.load()
        self.assertEqual(out.size, (320, 320))
        rgba = out.convert("RGBA")
        self.assertEqual(rgba.getpixel((2, 2))[3], 0)
        self.assertEqual(rgba.getpixel((160, 160))[3], 255)  # 中央配置

    def test_sticker_does_not_distort(self):
        # 横長の被写体は上下に余白ができ、横幅いっぱいに引き伸ばされない。
        data, _size, _notes = engine.encode_still_sticker(_subject_rgba((640, 160)))
        rgba = Image.open(io.BytesIO(data)).convert("RGBA")
        # 上端中央は被写体ではなく透明（歪ませていれば赤が来る）
        self.assertEqual(rgba.getpixel((160, 4))[3], 0)
        self.assertEqual(rgba.getpixel((160, 160))[3], 255)


class EncodeAnimTest(unittest.TestCase):
    def test_emoji_gif_within_limits(self):
        frames = _anim_frames(10)
        data, size, n_out, _notes = engine.encode_anim_emoji(
            frames, [80] * 10, 0)
        self.assertLessEqual(len(data), engine.EMOJI_MAX_BYTES)
        self.assertLessEqual(max(size), 128)
        self.assertEqual(n_out, 10)
        out = Image.open(io.BytesIO(data))
        self.assertEqual(getattr(out, "n_frames", 1), 10)
        out.seek(0)
        self.assertEqual(out.convert("RGBA").getpixel((1, 1))[3], 0)

    def test_sticker_apng_within_limits_and_320(self):
        frames = _anim_frames(10)
        data, fmt, size, n_out, _notes = engine.encode_anim_sticker(
            frames, [80] * 10, 0)
        self.assertEqual(fmt, "APNG")
        self.assertEqual(size, (320, 320))
        self.assertLessEqual(len(data), engine.STICKER_MAX_BYTES)
        out = Image.open(io.BytesIO(data))
        self.assertEqual(getattr(out, "n_frames", 1), 10)
        out.seek(0)
        frame = out.convert("RGBA")
        self.assertEqual(frame.size, (320, 320))
        self.assertEqual(frame.getpixel((2, 2))[3], 0)

    def test_frame_sampling_sums_durations(self):
        frames = _anim_frames(engine.MAX_FRAMES + 30)
        sampled, durations, was_sampled = engine._sample_frames(
            frames, [50] * len(frames))
        self.assertTrue(was_sampled)
        self.assertLessEqual(len(sampled), engine.MAX_FRAMES)
        self.assertEqual(sum(durations), 50 * len(frames))


class GuardTest(unittest.TestCase):
    def test_oversize_input_rejected_before_processing(self):
        with self.assertRaises(engine.BgCutError):
            engine.load_image(b"x" * (engine.MAX_INPUT_BYTES + 1))

    def test_non_image_rejected(self):
        with self.assertRaises(engine.BgCutError):
            engine.load_image(b"this is not an image")

    def test_huge_pixel_count_rejected(self):
        img = Image.new("RGB", (9000, 9000), (10, 10, 10))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        data = buf.getvalue()
        if len(data) <= engine.MAX_INPUT_BYTES:  # 小さく圧縮された場合のみ検証
            with self.assertRaises(engine.BgCutError):
                engine.load_image(data)


@unittest.skipUnless(MODEL_READY, "onnxruntime/モデルが無い環境では除去テストを省略")
class RemoveBackgroundTest(unittest.TestCase):
    def test_solid_background_becomes_transparent(self):
        cut = engine.remove_background(_opaque_photo())
        self.assertEqual(cut.getpixel((2, 2))[3], 0)
        self.assertEqual(cut.getpixel((cut.width - 3, 2))[3], 0)
        self.assertGreater(cut.getpixel((cut.width // 2, cut.height // 2))[3], 200)

    def test_already_transparent_input_not_broken(self):
        src = _subject_rgba((400, 300), bg_alpha=0)
        cut = engine.remove_background(src)
        self.assertEqual(cut.getpixel((2, 2))[3], 0)
        self.assertGreater(cut.getpixel((200, 150))[3], 200)

    def test_process_bytes_still_emoji_end_to_end(self):
        buf = io.BytesIO()
        _opaque_photo().save(buf, "JPEG", quality=92)
        result = engine.process_bytes(buf.getvalue(), "emoji")
        self.assertEqual(result.out_format, "PNG")
        self.assertLessEqual(len(result.data), engine.EMOJI_MAX_BYTES)
        self.assertLessEqual(max(result.width, result.height), 128)
        out = Image.open(io.BytesIO(result.data))
        out.load()
        self.assertEqual(out.convert("RGBA").getpixel((1, 1))[3], 0)

    def test_process_bytes_animated_gif_end_to_end(self):
        frames = []
        for i in range(6):
            f = Image.new("RGB", (160, 160), (240, 240, 240))
            ImageDraw.Draw(f).rectangle([30 + i * 8, 55, 80 + i * 8, 105],
                                        fill=(30, 60, 200))
            frames.append(f)
        buf = io.BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:],
                       duration=90, loop=0)
        result = engine.process_bytes(buf.getvalue(), "sticker")
        self.assertEqual(result.out_format, "APNG")
        self.assertEqual((result.width, result.height), (320, 320))
        self.assertLessEqual(len(result.data), engine.STICKER_MAX_BYTES)
        self.assertEqual(result.frames_out, 6)


class UnavailableTest(unittest.TestCase):
    def test_missing_onnxruntime_gives_clear_unavailable(self):
        with patch.dict(sys.modules, {"onnxruntime": None}):
            engine._SESSION = None
            with self.assertRaises(engine.UnavailableError):
                engine._get_session()
        engine._SESSION = None


# --- 待ちフロー（meme / fastHTML テストと同じ偽オブジェクト方式） --------------

class _Att:
    def __init__(self, filename="image.png", size=100, data=b"PNGDATA",
                 content_type="image/png"):
        self.filename = filename
        self.size = size
        self.content_type = content_type
        self._data = data
        self.read_calls = 0

    async def read(self):
        self.read_calls += 1
        return self._data


class _FakeUser:
    def __init__(self, user_id):
        self.id = user_id


class _FakeChannel:
    def __init__(self, channel_id):
        self.id = channel_id


class _FakeMessage:
    def __init__(self, user_id, channel_id, attachments):
        self.author = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.attachments = attachments
        self.replies = []

    async def reply(self, *args, **kwargs):
        self.replies.append((args, kwargs))
        return MagicMock()


class _FakeInteraction:
    def __init__(self, user_id=42, channel_id=7):
        self.user = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.response = MagicMock()
        self.response.send_message = AsyncMock()
        self.response.edit_message = AsyncMock()
        self.edit_original_response = AsyncMock()


class _Harness(BgCutoutMixin):
    def __init__(self, bot):
        self.bot = bot
        self._bgcut_waits = {}
        self._bgcut_purposes = {}
        self._bgcut_last = {}
        self._bgcut_jobs = 0
        self._bgcut_sem = asyncio.Semaphore(1)
        self.spawned = []

    def _spawn(self, coro):
        self.spawned.append(coro)


_META = {
    "filename": "emoji.png", "format": "PNG", "width": 128, "height": 96,
    "out_bytes": 12_345, "in_bytes": 98_765, "in_width": 800, "in_height": 600,
    "in_format": "JPEG", "animated": False, "frames_in": 1, "frames_out": 1,
    "purpose": "emoji", "notes": [],
}


class FlowTest(unittest.IsolatedAsyncioTestCase):
    def _bot_returning(self, message, store=None):
        class Bot:
            async def wait_for(self, event, check=None):
                if store is not None:
                    store.append(check)
                assert check(message)
                return message

        return Bot()

    async def _start(self, harness, interaction):
        await harness._bgcut_start(interaction)
        self.assertEqual(len(harness.spawned), 1)
        view = interaction.response.send_message.call_args.kwargs["view"]
        return view

    async def _choose(self, harness, view, purpose="emoji"):
        choose_interaction = _FakeInteraction()
        await harness._bgcut_choose(
            choose_interaction, (7, 42), purpose, view)
        return choose_interaction

    async def test_full_flow_posts_result_file(self):
        message = _FakeMessage(42, 7, [_Att()])
        harness = _Harness(self._bot_returning(message))
        harness._bgcut_run_engine = AsyncMock(return_value=(_META, b"OUTDATA"))
        interaction = _FakeInteraction()
        view = await self._start(harness, interaction)
        await self._choose(harness, view)
        await harness.spawned[0]
        # 処理中 + 結果 の2回 reply する
        self.assertEqual(len(message.replies), 2)
        _args, kwargs = message.replies[1]
        self.assertIn("file", kwargs)
        self.assertEqual(kwargs["file"].filename, "emoji.png")
        text = message.replies[1][0][0]
        self.assertIn("絵文字用", text)
        self.assertIn("128×96", text)
        # 待ちセッションは掃除される
        self.assertEqual(harness._bgcut_waits, {})
        self.assertEqual(harness._bgcut_purposes, {})
        self.assertEqual(harness._bgcut_jobs, 0)

    async def test_check_rejects_other_users_and_unset_purpose(self):
        checks = []

        class Bot:
            async def wait_for(self, event, check=None):
                checks.append(check)
                await asyncio.sleep(60)

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        view = await self._start(harness, interaction)
        task = asyncio.create_task(harness.spawned[0])
        await asyncio.sleep(0.05)  # wait_for に check が渡るまで進める
        check = checks[0]
        own = _FakeMessage(42, 7, [_Att()])
        # 用途未選択のうちは本人の画像でも拾わない
        self.assertFalse(check(own))
        await self._choose(harness, view)
        self.assertTrue(check(own))
        # 他人の画像・別チャンネル・添付なしは拾わない
        self.assertFalse(check(_FakeMessage(99, 7, [_Att()])))
        self.assertFalse(check(_FakeMessage(42, 8, [_Att()])))
        self.assertFalse(check(_FakeMessage(42, 7, [])))
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_oversize_attachment_ends_with_message(self):
        message = _FakeMessage(42, 7, [_Att(size=BG_CUTOUT_MAX_INPUT_BYTES + 1)])
        harness = _Harness(self._bot_returning(message))
        harness._bgcut_run_engine = AsyncMock()
        interaction = _FakeInteraction()
        view = await self._start(harness, interaction)
        await self._choose(harness, view)
        await harness.spawned[0]
        self.assertEqual(len(message.replies), 1)
        self.assertIn("大きすぎます", message.replies[0][0][0])
        harness._bgcut_run_engine.assert_not_awaited()

    async def test_engine_failure_is_reported_not_silent(self):
        message = _FakeMessage(42, 7, [_Att()])
        harness = _Harness(self._bot_returning(message))
        harness._bgcut_run_engine = AsyncMock(
            side_effect=BgCutoutFailed("256KB以内に収められませんでした"))
        interaction = _FakeInteraction()
        view = await self._start(harness, interaction)
        await self._choose(harness, view)
        await harness.spawned[0]
        texts = [r[0][0] for r in message.replies if r[0]]
        self.assertTrue(any("収められませんでした" in t for t in texts))
        self.assertEqual(harness._bgcut_jobs, 0)

    async def test_timeout_edits_guide_message(self):
        class Bot:
            async def wait_for(self, event, check=None):
                await asyncio.sleep(60)

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        with patch.object(bg_cutout, "BG_CUTOUT_WAIT_TIMEOUT", 0.05):
            await self._start(harness, interaction)
            await harness.spawned[0]
        interaction.edit_original_response.assert_awaited()
        content = interaction.edit_original_response.call_args.kwargs["content"]
        self.assertIn("時間切れ", content)
        self.assertEqual(harness._bgcut_waits, {})

    async def test_second_start_rejected_while_waiting(self):
        harness = _Harness(MagicMock())
        harness._bgcut_waits[(7, 42)] = asyncio.Event()
        interaction = _FakeInteraction()
        await harness._bgcut_start(interaction)
        text = interaction.response.send_message.call_args.args[0]
        self.assertIn("待ち受け中です", text)
        self.assertEqual(harness.spawned, [])


class RegistryTest(unittest.TestCase):
    def test_action_registered_in_make_image_genre(self):
        from core.general.entry import GENERAL_ACTIONS

        values = [v for _label, v in GENERAL_ACTIONS["make_image"]]
        self.assertIn("bg_cutout", values)
        labels = dict((v, label) for label, v in GENERAL_ACTIONS["make_image"])
        self.assertEqual(labels["bg_cutout"], "背景透過・絵文字/スタンプ化")

    def test_registry_spec_is_ai_blocked(self):
        from core.general import action_registry

        registry = action_registry.default_registry()
        spec = registry.get("general:bg_cutout")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.risk, "blocked")
        self.assertNotIn("aitools", spec.surfaces)
        self.assertIn("general:bg_cutout", action_registry.AI_BLOCKED_IDS)

    def test_result_text_includes_purpose_and_sizes(self):
        text = bgcut_result_text(_META)
        self.assertIn("絵文字用", text)
        self.assertIn("800×600", text)
        self.assertIn("128×96", text)


class AttachmentPickTest(unittest.TestCase):
    def test_picks_image_by_content_type_or_extension(self):
        att = _Att(filename="x.bin", content_type="image/gif")
        self.assertIs(_bgcut_image_attachment(_FakeMessage(1, 2, [att])), att)
        att2 = _Att(filename="photo.WEBP", content_type=None)
        self.assertIs(_bgcut_image_attachment(_FakeMessage(1, 2, [att2])), att2)
        att3 = _Att(filename="doc.txt", content_type="text/plain")
        self.assertIsNone(_bgcut_image_attachment(_FakeMessage(1, 2, [att3])))
        self.assertIsNone(_bgcut_image_attachment(_FakeMessage(1, 2, [])))


if __name__ == "__main__":
    unittest.main()
