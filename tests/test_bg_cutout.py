# -*- coding: utf-8 -*-
"""背景透過・絵文字/スタンプ化（core/general/bg_cutout.py）のテスト。

移行後のフロー: パネルで用途選択 → 署名付き一時リンク発行（発行者だけに
エフェメラルで提示）→ ブラウザ側で処理 → 結果が bot_kv 経由で戻り、
Bot が発行元チャンネルへ公開投稿する。ここでは Discord に接続せず
偽オブジェクトで、トークンの署名・検証、発行フロー、結果ポーリングの
計画と投稿を確かめる。ブラウザ側の処理仕様（寸法・サイズ上限・GIF）は
web/tests/bgcut.test.mjs 側で確かめる。
"""
import asyncio
import base64
import io
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general import bg_cutout  # noqa: E402
from core.general.bg_cutout import (  # noqa: E402
    BG_CUTOUT_RESULTS_NAMESPACE,
    BG_CUTOUT_TTL_SECONDS,
    BgCutoutMixin,
    bgcut_result_post_plan,
    bgcut_result_text,
    create_bgcut_token,
    verify_bgcut_token,
)

_TEST_KEY = "test-bot-api-key"


def _with_key():
    return patch.dict(os.environ, {"BOT_API_KEY": _TEST_KEY})


# --- トークン ---------------------------------------------------------------

class TokenTest(unittest.TestCase):
    def test_create_and_verify_roundtrip(self):
        with _with_key():
            created = create_bgcut_token(
                user_id=42, purpose="sticker", guild_id=100, channel_id=7,
                now=1_700_000_000, job_id="job123")
            self.assertIsNotNone(created)
            token, expires_at = created
            self.assertEqual(expires_at, 1_700_000_000 + BG_CUTOUT_TTL_SECONDS)
            self.assertTrue(token.startswith("v1."))
            self.assertEqual(len(token.split(".")), 3)
            payload = verify_bgcut_token(token, now=1_700_000_100)
            self.assertEqual(payload, {
                "u": 42, "p": "sticker", "g": 100, "c": 7,
                "j": "job123", "exp": expires_at,
            })

    def test_job_id_is_random_when_omitted(self):
        with _with_key():
            t1, _ = create_bgcut_token(
                user_id=1, purpose="emoji", guild_id=2, channel_id=3,
                now=1_700_000_000)
            t2, _ = create_bgcut_token(
                user_id=1, purpose="emoji", guild_id=2, channel_id=3,
                now=1_700_000_000)
            self.assertNotEqual(t1, t2)

    def test_expired_token_rejected(self):
        with _with_key():
            token, expires_at = create_bgcut_token(
                user_id=1, purpose="emoji", guild_id=2, channel_id=3,
                now=1_700_000_000)
            self.assertIsNone(verify_bgcut_token(token, now=expires_at))
            self.assertIsNone(verify_bgcut_token(token, now=expires_at + 1))

    def test_tampered_token_rejected(self):
        with _with_key():
            token, _ = create_bgcut_token(
                user_id=1, purpose="emoji", guild_id=2, channel_id=3,
                now=1_700_000_000)
            head, payload, sig = token.split(".")
            forged_payload = bg_cutout._b64url_encode(b'{"u":999,"exp":9999999999}')
            self.assertIsNone(verify_bgcut_token(
                f"{head}.{forged_payload}.{sig}", now=1_700_000_100))
            self.assertIsNone(verify_bgcut_token(
                f"{head}.{payload}.AAAA", now=1_700_000_100))
            self.assertIsNone(verify_bgcut_token("not-a-token"))
            self.assertIsNone(verify_bgcut_token("v2." + payload + "." + sig))

    def test_missing_key_disables_issuance(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(create_bgcut_token(
                user_id=1, purpose="emoji", guild_id=2, channel_id=3))
            self.assertIsNone(verify_bgcut_token("v1.x.y"))

    def test_signature_matches_fast_html_scheme(self):
        # Web 側 (web/lib/bgcut-token.ts) と同じ規則: 署名対象は "v1.<payload>"
        import hashlib
        import hmac as hmac_mod

        with _with_key():
            token, _ = create_bgcut_token(
                user_id=5, purpose="emoji", guild_id=6, channel_id=7,
                now=1_700_000_000, job_id="j")
        version, payload_b64, sig_b64 = token.split(".")
        expected = hmac_mod.new(
            _TEST_KEY.encode(), f"{version}.{payload_b64}".encode(),
            hashlib.sha256).digest()
        self.assertEqual(
            sig_b64,
            base64.urlsafe_b64encode(expected).rstrip(b"=").decode())


# --- 発行フロー -------------------------------------------------------------

class _FakeUser:
    def __init__(self, user_id, name="tester"):
        self.id = user_id
        self.display_name = name


class _FakeChannel:
    def __init__(self, channel_id):
        self.id = channel_id
        self.sent = []

    async def send(self, *args, **kwargs):
        self.sent.append((args, kwargs))
        return MagicMock()


class _FakeInteraction:
    def __init__(self, user_id=42, channel_id=7, guild_id=100):
        self.user = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.guild_id = guild_id
        self.response = MagicMock()
        self.response.send_message = AsyncMock()
        self.response.edit_message = AsyncMock()
        self.followup = MagicMock()
        self.followup.send = AsyncMock()


class _Harness(BgCutoutMixin):
    def __init__(self, bot=None):
        self.bot = bot
        self._bgcut_last_issue = {}


class FlowTest(unittest.IsolatedAsyncioTestCase):
    async def test_start_shows_purpose_panel_publicly(self):
        harness = _Harness()
        interaction = _FakeInteraction()
        await harness._bgcut_start(interaction)
        args, kwargs = interaction.response.send_message.call_args
        self.assertIn("ブラウザ", args[0])
        self.assertFalse(kwargs.get("ephemeral", False))
        view = kwargs["view"]
        self.assertEqual(view.user_id, 42)

    async def test_choose_issues_link_ephemerally_and_edits_panel(self):
        harness = _Harness()
        interaction = _FakeInteraction()
        view = bg_cutout.BgCutoutStartView(harness, 42)
        with _with_key():
            await harness._bgcut_choose(interaction, "sticker", view)
        # パネル（公開）はリンクを含まない文面に編集される
        _args, ekwargs = interaction.response.edit_message.call_args
        self.assertIn("発行しました", ekwargs["content"])
        self.assertNotIn("agobot.app/bgcut/", ekwargs["content"])
        self.assertIsNone(ekwargs["view"])
        # リンクはエフェメラル followup でだけ渡る
        _fargs, fkwargs = interaction.followup.send.call_args
        self.assertTrue(fkwargs["ephemeral"])
        content = fkwargs["content"] if "content" in fkwargs else _fargs[0]
        self.assertIn("https://agobot.app/bgcut/v1.", content)
        token = content.split("`")[1].rsplit("/", 1)[-1]
        with _with_key():
            payload = verify_bgcut_token(token)
        self.assertEqual(payload["u"], 42)
        self.assertEqual(payload["p"], "sticker")
        self.assertEqual(payload["g"], 100)
        self.assertEqual(payload["c"], 7)
        # リンクボタン View にも同じ URL が入る
        link_view = fkwargs["view"]
        self.assertEqual(link_view.children[0].url,
                         f"https://agobot.app/bgcut/{token}")
        # クールダウンが記録される
        self.assertIn(42, harness._bgcut_last_issue)

    async def test_choose_without_key_reports_unavailable(self):
        harness = _Harness()
        interaction = _FakeInteraction()
        view = bg_cutout.BgCutoutStartView(harness, 42)
        with patch.dict(os.environ, {}, clear=True):
            await harness._bgcut_choose(interaction, "emoji", view)
        _fargs, fkwargs = interaction.followup.send.call_args
        self.assertTrue(fkwargs["ephemeral"])
        content = fkwargs["content"] if "content" in fkwargs else _fargs[0]
        self.assertIn("未設定", content)

    async def test_start_cooldown_blocks_reissue(self):
        harness = _Harness()
        harness._bgcut_last_issue[42] = time.monotonic()
        interaction = _FakeInteraction()
        await harness._bgcut_start(interaction)
        _args, kwargs = interaction.response.send_message.call_args
        self.assertTrue(kwargs["ephemeral"])
        self.assertIn("待ってから", _args[0])


# --- 結果ポーリング -----------------------------------------------------------

_NOW = 1_700_100_000.0


def _record(**overrides):
    record = {
        "status": "pending",
        "user_id": 42,
        "guild_id": 100,
        "channel_id": 7,
        "purpose": "emoji",
        "filename": "emoji.png",
        "format": "PNG",
        "width": 128,
        "height": 96,
        "out_bytes": 1000,
        "in_bytes": 5000,
        "in_width": 800,
        "in_height": 600,
        "notes": [],
        "data_b64": base64.b64encode(b"PNGDATA").decode(),
        "created_at": _NOW - 60,
    }
    record.update(overrides)
    return record


class _FakeKv:
    def __init__(self, records):
        self.records = dict(records)
        self.deleted = []

    async def load_all(self):
        return dict(self.records)

    async def delete(self, key):
        self.deleted.append(key)
        self.records.pop(key, None)


class PostPlanTest(unittest.TestCase):
    def test_valid_pending_records_become_posts_in_order(self):
        records = {
            "b": _record(created_at=_NOW - 10),
            "a": _record(created_at=_NOW - 50),
        }
        posts, discards = bgcut_result_post_plan(records, now=_NOW)
        self.assertEqual([k for k, _r in posts], ["a", "b"])
        self.assertEqual(discards, [])

    def test_expired_and_malformed_records_are_discarded(self):
        records = {
            "old": _record(created_at=_NOW - bg_cutout.BG_CUTOUT_RESULT_TTL_SECONDS - 1),
            "bad": _record(data_b64=""),
            "done": _record(status="posted"),
            "junk": "not-a-dict",
            "ok": _record(),
        }
        posts, discards = bgcut_result_post_plan(records, now=_NOW)
        self.assertEqual([k for k, _r in posts], ["ok"])
        self.assertEqual(sorted(discards), ["bad", "done", "junk", "old"])


class _FakeBot:
    def __init__(self, channel):
        self._channel = channel

    def get_channel(self, channel_id):
        return self._channel if channel_id == self._channel.id else None

    async def fetch_channel(self, channel_id):
        raise RuntimeError("not found")


class PollerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.channel = _FakeChannel(7)
        self.harness = _Harness(_FakeBot(self.channel))

    def _install_kv(self, records):
        kv = _FakeKv(records)
        bg_cutout.set_kv_factory(lambda namespace: kv)
        self.assertEqual(
            bg_cutout.BG_CUTOUT_RESULTS_NAMESPACE, "bgcut_results")
        return kv

    def tearDown(self):
        bg_cutout.set_kv_factory(None)

    async def test_posts_result_and_deletes_record(self):
        kv = self._install_kv({"job1": _record()})
        await self.harness._bgcut_post_pending_results(now=_NOW)
        self.assertEqual(len(self.channel.sent), 1)
        _args, kwargs = self.channel.sent[0]
        self.assertIn("<@42>", kwargs["content"])
        self.assertIn("背景透過が完了しました", kwargs["content"])
        self.assertIn("絵文字用", kwargs["content"])
        file = kwargs["file"]
        self.assertEqual(file.filename, "emoji.png")
        self.assertEqual(file.fp.read(), b"PNGDATA")
        self.assertEqual(kv.deleted, ["job1"])
        self.assertEqual(kv.records, {})

    async def test_broken_base64_record_is_dropped_without_posting(self):
        kv = self._install_kv({"job1": _record(data_b64="!!!")})
        await self.harness._bgcut_post_pending_results(now=_NOW)
        self.assertEqual(self.channel.sent, [])
        self.assertEqual(kv.deleted, ["job1"])

    async def test_send_failure_keeps_record_for_retry(self):
        async def failing_send(*args, **kwargs):
            raise RuntimeError("discord down")

        self.channel.send = failing_send
        kv = self._install_kv({"job1": _record()})
        await self.harness._bgcut_post_pending_results(now=_NOW)
        self.assertEqual(kv.deleted, [])
        self.assertIn("job1", kv.records)


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
        text = bgcut_result_text(_record())
        self.assertIn("絵文字用", text)
        self.assertIn("800×600", text)
        self.assertIn("128×96", text)


if __name__ == "__main__":
    unittest.main()
