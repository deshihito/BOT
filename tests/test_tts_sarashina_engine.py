"""読み上げの Sarashina エンジン追加のテスト。

- TTSSettings の後方互換読み込み（旧形式 JSON に新フィールドが無くても壊れない）
- エンジン別の合成経路（Sarashina は原則1リクエスト・逐次、VOICEVOX は従来どおり）
- Sarashina の声の名前解決（完全一致優先・部分一致・曖昧はエラー）

実 API は叩かない（モックのみ）。
"""
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import core.vc.tts as tts_module
from core.vc.tts import (
    TTSCog,
    TTSSettings,
    TTSSettingsModal,
    resolve_sarashina_voice,
    split_tts_text,
)


def _cog(settings_path: Path):
    cog = object.__new__(TTSCog)
    cog.settings = {}
    cog.read_channels = {}
    cog.queues = {}
    cog.workers = {}
    cog._speakers = ["話者A", "話者B", "話者C", "テスト話者"]
    cog._session = None
    return cog


class SettingsPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "tts_settings.json"
        self._patch = patch.object(tts_module, "TTS_SETTINGS_PATH", self.path)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self.tmp.cleanup()

    def test_legacy_json_without_new_fields_loads_with_defaults(self):
        self.path.write_text(
            json.dumps({"7": {"speaker": 2, "pitch": 1.5, "speed": 0.8}}),
            encoding="utf-8",
        )
        cog = _cog(self.path)
        cog._load_settings()
        cfg = cog.settings[7]
        self.assertEqual(cfg.speaker, 2)
        self.assertEqual(cfg.pitch, 1.5)
        self.assertEqual(cfg.speed, 0.8)
        self.assertEqual(cfg.engine, "voicevox")
        self.assertEqual(cfg.sarashina_voice, "aiku")

    def test_new_fields_roundtrip(self):
        cog = _cog(self.path)
        cog.settings[9] = TTSSettings(engine="sarashina", sarashina_voice="haruka")
        cog._save_settings()
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(raw["9"]["engine"], "sarashina")
        self.assertEqual(raw["9"]["sarashina_voice"], "haruka")
        cog2 = _cog(self.path)
        cog2._load_settings()
        self.assertEqual(cog2.settings[9].engine, "sarashina")
        self.assertEqual(cog2.settings[9].sarashina_voice, "haruka")

    def test_invalid_saved_values_fall_back(self):
        self.path.write_text(
            json.dumps({"7": {"engine": "unknown-engine", "sarashina_voice": "no-such"}}),
            encoding="utf-8",
        )
        cog = _cog(self.path)
        cog._load_settings()
        self.assertEqual(cog.settings[7].engine, "voicevox")
        self.assertEqual(cog.settings[7].sarashina_voice, "aiku")


class ResolveSarashinaVoiceTests(unittest.TestCase):
    def test_exact_match(self):
        self.assertEqual(resolve_sarashina_voice("haruka"), "haruka")

    def test_unique_partial_match(self):
        self.assertEqual(resolve_sarashina_voice("haruk"), "haruka")

    def test_ambiguous_partial_match_is_error(self):
        with self.assertRaises(ValueError):
            resolve_sarashina_voice("aik")  # aiku と aika の両方に一致

    def test_no_match_is_error(self):
        with self.assertRaises(ValueError):
            resolve_sarashina_voice("zzz")


class ApplyConfigTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "tts_settings.json"
        self._patch = patch.object(tts_module, "TTS_SETTINGS_PATH", self.path)
        self._patch.start()
        self.cog = _cog(self.path)

    def tearDown(self):
        self._patch.stop()
        self.tmp.cleanup()

    async def test_apply_sarashina_engine(self):
        text = await self.cog._apply_config(
            7, None, None, None, engine="sarashina", sarashina_voice="haruka")
        cfg = self.cog.settings[7]
        self.assertEqual(cfg.engine, "sarashina")
        self.assertEqual(cfg.sarashina_voice, "haruka")
        self.assertIn("Sarashina", text)
        self.assertIn("haruka", text)

    async def test_apply_invalid_engine(self):
        with self.assertRaises(ValueError):
            await self.cog._apply_config(7, None, None, None, engine="bogus")

    async def test_voicevox_message_unchanged(self):
        text = await self.cog._apply_config(7, None, None, None)
        self.assertIn("読み上げ設定", text)
        self.assertIn("テスト話者", text)
        self.assertIn("話者:", text)


class SynthesizeDispatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cog = _cog(Path("unused.json"))

    async def test_sarashina_single_sequential_request(self):
        text = "あ" * 250  # 上限300字以内なので1チャンク＝1リクエストになる
        with patch.object(
            tts_module.sarashina_ai, "synthesize_speech",
            new=AsyncMock(return_value=b"wav-bytes"),
        ) as synth:
            cfg = TTSSettings(engine="sarashina", sarashina_voice="aiku")
            paths = await self.cog._synthesize_all(text, cfg)
        self.assertEqual(synth.await_count, 1)
        args, kwargs = synth.await_args
        self.assertEqual(args[0], text)
        self.assertEqual(kwargs["voice"], "aiku")
        # 話速の意味を VOICEVOX と揃えるためネイティブ speed は 1.0 固定。
        self.assertEqual(kwargs["speed"], 1.0)
        self.assertEqual(len(paths), 1)
        try:
            self.assertEqual(Path(paths[0]).read_bytes(), b"wav-bytes")
            self.assertTrue(paths[0].endswith(".wav"))
        finally:
            for p in paths:
                os.unlink(p)

    async def test_sarashina_error_becomes_tts_error_and_cleans_up(self):
        from core.general.ai.sarashina import SarashinaHTTPError
        with patch.object(
            tts_module.sarashina_ai, "synthesize_speech",
            new=AsyncMock(side_effect=SarashinaHTTPError(429, "60")),
        ):
            cfg = TTSSettings(engine="sarashina", sarashina_voice="aiku")
            with self.assertRaises(tts_module.TTSError):
                await self.cog._synthesize_all("テスト", cfg)

    async def test_voicevox_uses_existing_chunked_parallel_path(self):
        text = "あ。" * 60  # 120字 → 100字分割で2チャンク
        self.assertEqual(len(split_tts_text(text)), 2)
        self.cog._synthesize = AsyncMock(return_value="/tmp/fake_tts.mp3")
        cfg = TTSSettings(engine="voicevox", speaker=3)
        paths = await self.cog._synthesize_all(text, cfg)
        self.assertEqual(self.cog._synthesize.await_count, 2)
        self.assertEqual(paths, ["/tmp/fake_tts.mp3", "/tmp/fake_tts.mp3"])
        # 話者は従来どおり speaker ID で渡る。
        for call in self.cog._synthesize.await_args_list:
            self.assertEqual(call.args[1], 3)


class ModalTests(unittest.TestCase):
    def test_modal_defaults_reflect_sarashina_settings(self):
        cog = _cog(Path("unused.json"))
        cog.settings[7] = TTSSettings(engine="sarashina", sarashina_voice="haruka")
        modal = TTSSettingsModal(cog, 7)
        self.assertEqual(modal.engine.default, "sarashina")
        self.assertEqual(modal.sarashina_voice.default, "haruka")
        self.assertEqual(modal.speaker.default, "3")


if __name__ == "__main__":
    unittest.main()
