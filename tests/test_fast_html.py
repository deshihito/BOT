# -*- coding: utf-8 -*-
"""fastHTML（Bot 側: core/general/fast_html.py）のテスト。

サーバーは実体を保存せず、Discord CDN の添付 URL を BOT_API_KEY で
HMAC 署名したトークンに包むだけ。その生成・検証ラウンドトリップ、
改竄検知、メモリ内発行制限、待ちフローの分岐、無効化ボタンの挙動を、
Discord / 外部ネットワークに接続せず偽オブジェクトで確かめる。
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("BOT_API_KEY", "test-key")

from core.general import fast_html
from core.general.fast_html import (
    FAST_HTML_MAX_ACTIVE_PER_USER,
    FAST_HTML_MAX_BYTES,
    FAST_HTML_TTL_SECONDS,
    FastHtmlMixin,
    FastHtmlResultView,
    _fast_html_attachment,
    create_fast_html_token,
    fast_html_attachment_error,
    fast_html_cdn_url_ok,
    fast_html_public_url,
)

CDN_URL = (
    "https://cdn.discordapp.com/attachments/"
    "1234567890123456789/1234567890123456789/page.html"
    "?ex=6735abcd1234ef56&is=67345abc1234ef56&hm=" + "a" * 64
)
MEDIA_URL = (
    "https://media.discordapp.net/attachments/"
    "1234567890123456789/1234567890123456789/page.html?ex=6735abcd&is=67345abc&hm="
    + "b" * 64
)


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _verify_token(token: str, key: bytes):
    """仕様どおりにトークンを検証し payload を返す（検証は Web 側の責務だが、
    Bot の生成が仕様と一致することの確認用にここでも実装する）。"""
    version, payload_b64, sig_b64 = token.split(".")
    if version != "v1":
        raise ValueError("bad version")
    expected = hmac.new(
        key, f"{version}.{payload_b64}".encode("ascii"), hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
        raise ValueError("bad signature")
    return json.loads(_b64url_decode(payload_b64))


class _Att:
    def __init__(self, filename="page.html", size=100, url=CDN_URL):
        self.filename = filename
        self.size = size
        self.url = url
        self.read_calls = 0

    async def read(self):
        self.read_calls += 1
        return b"<html></html>"


class _Msg:
    def __init__(self, attachments):
        self.attachments = attachments


class AttachmentTest(unittest.TestCase):
    def test_picks_html_and_htm_case_insensitive(self):
        att = _Att("PAGE.HTML")
        self.assertIs(_fast_html_attachment(_Msg([_Att("a.png"), att])), att)
        att2 = _Att("x.htm")
        self.assertIs(_fast_html_attachment(_Msg([att2])), att2)

    def test_skips_non_html(self):
        self.assertIsNone(_fast_html_attachment(_Msg([_Att("a.png")])))
        self.assertIsNone(_fast_html_attachment(_Msg([])))

    def test_size_limit_precheck(self):
        self.assertIsNone(fast_html_attachment_error(_Att(size=FAST_HTML_MAX_BYTES)))
        error = fast_html_attachment_error(_Att(size=FAST_HTML_MAX_BYTES + 1))
        self.assertIn("大きすぎます", error)

    def test_public_url(self):
        self.assertEqual(
            fast_html_public_url("abc123"), "https://fast.agobot.app/fast/abc123",
        )

    def test_cdn_url_allowlist(self):
        self.assertTrue(fast_html_cdn_url_ok(CDN_URL))
        self.assertTrue(fast_html_cdn_url_ok(MEDIA_URL))
        self.assertFalse(fast_html_cdn_url_ok("https://example.com/attachments/1/2/a.html"))
        self.assertFalse(fast_html_cdn_url_ok("http://cdn.discordapp.com/attachments/1/2/a.html"))
        self.assertFalse(fast_html_cdn_url_ok("https://cdn.discordapp.com/other/1/2/a.html"))
        self.assertFalse(fast_html_cdn_url_ok(""))
        self.assertFalse(fast_html_cdn_url_ok(None))


class _PinnedKey:
    """BOT_API_KEY を固定する（他テストモジュールが import 時に環境変数を
    書き換えるため、setdefault では署名鍵がずれる）。"""

    def setUp(self):
        self._env = patch.dict(os.environ, {"BOT_API_KEY": "test-key"})
        self._env.start()
        self.addCleanup(self._env.stop)


class TokenTest(_PinnedKey, unittest.TestCase):
    def test_roundtrip(self):
        created = create_fast_html_token(CDN_URL, now=1_800_000_000)
        self.assertIsNotNone(created)
        token, expires_at = created
        self.assertEqual(expires_at, 1_800_000_000 + FAST_HTML_TTL_SECONDS)
        payload = _verify_token(token, b"test-key")
        self.assertEqual(payload, {"u": CDN_URL, "exp": expires_at})

    def test_tampered_payload_detected(self):
        token, _ = create_fast_html_token(CDN_URL, now=1_800_000_000)
        version, _payload_b64, sig_b64 = token.split(".")
        forged_payload = base64.urlsafe_b64encode(
            json.dumps({"u": CDN_URL, "exp": 9_999_999_999}).encode(),
        ).rstrip(b"=").decode()
        forged = f"{version}.{forged_payload}.{sig_b64}"
        with self.assertRaises(ValueError):
            _verify_token(forged, b"test-key")

    def test_wrong_key_detected(self):
        token, _ = create_fast_html_token(CDN_URL, now=1_800_000_000)
        with self.assertRaises(ValueError):
            _verify_token(token, b"another-key")

    def test_expired_token_has_past_exp(self):
        past = time.time() - FAST_HTML_TTL_SECONDS - 60
        token, expires_at = create_fast_html_token(CDN_URL, now=past)
        self.assertLess(expires_at, time.time())
        payload = _verify_token(token, b"test-key")
        self.assertLess(payload["exp"], time.time())

    def test_missing_key_returns_none(self):
        with patch.dict(os.environ, {"BOT_API_KEY": ""}):
            self.assertIsNone(create_fast_html_token(CDN_URL))

    def test_url_length_within_discord_button_limit(self):
        # 現実的な最長級の CDN URL（19桁ID×2、100文字ファイル名、署名パラメータ付き）
        longest = (
            "https://cdn.discordapp.com/attachments/"
            "1234567890123456789/1234567890123456789/"
            + "a" * 96 + ".html"
            + "?ex=6735abcd1234ef56aa&is=67345abc1234ef56aa&hm=" + "f" * 64
        )
        token, _ = create_fast_html_token(longest, now=1_800_000_000)
        self.assertLessEqual(len(fast_html_public_url(token)), 512)


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
        self.delete = AsyncMock()

    async def reply(self, *args, **kwargs):
        self.replies.append((args, kwargs))
        return MagicMock()


class _FakeInteraction:
    def __init__(self, user_id=42, channel_id=7):
        self.user = _FakeUser(user_id)
        self.channel = _FakeChannel(channel_id)
        self.response = MagicMock()
        self.response.send_message = AsyncMock()
        self.edit_original_response = AsyncMock()


class _Harness(FastHtmlMixin):
    def __init__(self, bot):
        self.bot = bot
        self._fast_html_waits = {}
        self._fast_html_last_issue = {}
        self._fast_html_active = {}
        self.spawned = []

    def _spawn(self, coro):
        self.spawned.append(coro)


class FlowTest(_PinnedKey, unittest.IsolatedAsyncioTestCase):
    async def _run(self, harness, interaction):
        await harness._fast_html_start(interaction)
        self.assertEqual(len(harness.spawned), 1)
        await harness.spawned[0]

    def _bot_returning(self, message):
        class Bot:
            async def wait_for(self, event, check=None):
                assert check(message)
                return message

        return Bot()

    async def test_success_posts_result_with_view(self):
        att = _Att()
        message = _FakeMessage(42, 7, [att])
        harness = _Harness(self._bot_returning(message))
        interaction = _FakeInteraction()
        await self._run(harness, interaction)
        # 実体はダウンロードしない
        self.assertEqual(att.read_calls, 0)
        self.assertEqual(len(message.replies), 1)
        _args, kwargs = message.replies[0]
        view = kwargs["view"]
        self.assertIsInstance(view, FastHtmlResultView)
        self.assertTrue(view.token.startswith("v1."))
        # 無効化のために元の投稿メッセージへの参照を保持する
        self.assertIs(view.source_message, message)
        payload = _verify_token(view.token, b"test-key")
        self.assertEqual(payload["u"], CDN_URL)
        embed = kwargs["embed"]
        self.assertEqual(embed.fields[0].value, "page.html")
        self.assertIn("有効期限", embed.fields[1].name)
        # 発行がメモリ内カウンタに記録される
        self.assertEqual(len(harness._fast_html_active[42]), 1)
        # 待ちセッションは掃除される
        self.assertEqual(harness._fast_html_waits, {})

    async def test_non_cdn_url_rejected_with_generic_error(self):
        att = _Att(url="https://example.com/attachments/1/2/page.html")
        message = _FakeMessage(42, 7, [att])
        harness = _Harness(self._bot_returning(message))
        interaction = _FakeInteraction()
        await self._run(harness, interaction)
        self.assertEqual(att.read_calls, 0)
        self.assertIn("発行できませんでした", message.replies[0][0][0])
        self.assertEqual(harness._fast_html_active.get(42, []), [])

    async def test_active_limit_blocks_fourth_issue(self):
        att = _Att()
        message = _FakeMessage(42, 7, [att])
        harness = _Harness(self._bot_returning(message))
        now = time.time()
        harness._fast_html_active[42] = [now] * FAST_HTML_MAX_ACTIVE_PER_USER
        interaction = _FakeInteraction()
        await self._run(harness, interaction)
        self.assertIn("同時に公開できるのは", message.replies[0][0][0])
        self.assertEqual(len(harness._fast_html_active[42]), FAST_HTML_MAX_ACTIVE_PER_USER)

    async def test_expired_issues_do_not_count_toward_limit(self):
        att = _Att()
        message = _FakeMessage(42, 7, [att])
        harness = _Harness(self._bot_returning(message))
        old = time.time() - FAST_HTML_TTL_SECONDS - 1
        harness._fast_html_active[42] = [old] * FAST_HTML_MAX_ACTIVE_PER_USER
        interaction = _FakeInteraction()
        await self._run(harness, interaction)
        _args, kwargs = message.replies[0]
        self.assertIsInstance(kwargs["view"], FastHtmlResultView)
        # 期限切れ分は prune され、新規発行だけが残る
        self.assertEqual(len(harness._fast_html_active[42]), 1)

    async def test_oversize_attachment_ends_with_message(self):
        att = _Att(size=FAST_HTML_MAX_BYTES + 1)
        message = _FakeMessage(42, 7, [att])
        harness = _Harness(self._bot_returning(message))
        interaction = _FakeInteraction()
        await self._run(harness, interaction)
        self.assertIn("大きすぎます", message.replies[0][0][0])
        self.assertEqual(harness._fast_html_active.get(42, []), [])

    async def test_timeout_edits_guide_message(self):
        class Bot:
            async def wait_for(self, event, check=None):
                await asyncio.sleep(60)

        harness = _Harness(Bot())
        interaction = _FakeInteraction()
        with patch.object(fast_html, "FAST_HTML_WAIT_TIMEOUT", 0.05):
            await self._run(harness, interaction)
        interaction.edit_original_response.assert_awaited()
        content = interaction.edit_original_response.call_args.kwargs["content"]
        self.assertIn("時間切れ", content)

    async def test_second_start_rejected_while_waiting(self):
        harness = _Harness(MagicMock())
        harness._fast_html_waits[(7, 42)] = asyncio.Event()
        interaction = _FakeInteraction()
        interaction.response.send_message = AsyncMock()
        await harness._fast_html_start(interaction)
        text = interaction.response.send_message.call_args.args[0]
        self.assertIn("待ち中", text)
        self.assertEqual(harness.spawned, [])


def _find_button(view, name):
    """game_fakes と同じ流儀で、メソッド名から View のボタンを探す。"""
    for child in view.children:
        callback = getattr(child, "callback", None)
        func = getattr(callback, "callback", None) or getattr(callback, "func", None) or callback
        if getattr(func, "__name__", None) == name or getattr(
            getattr(callback, "__func__", None), "__name__", None,
        ) == name:
            return child
    raise LookupError(name)


class _ButtonInteraction:
    def __init__(self, user_id):
        self.user = _FakeUser(user_id)
        self.response = MagicMock()
        self.response.send_message = AsyncMock()
        self.response.edit_message = AsyncMock()


class ResultViewDeleteTest(_PinnedKey, unittest.IsolatedAsyncioTestCase):
    def _view(self, source_message):
        token, _ = create_fast_html_token(CDN_URL, now=1_800_000_000)
        return FastHtmlResultView(MagicMock(), token, 42, source_message=source_message)

    async def test_owner_invalidate_edits_result_and_deletes_source(self):
        source = _FakeMessage(42, 7, [])
        view = self._view(source)
        interaction = _ButtonInteraction(42)
        await _find_button(view, "delete").callback(interaction)
        interaction.response.edit_message.assert_awaited_once()
        content = interaction.response.edit_message.call_args.kwargs["content"]
        self.assertIn("このリンクは無効化されました", content)
        source.delete.assert_awaited_once()

    async def test_source_delete_failure_does_not_raise(self):
        source = _FakeMessage(42, 7, [])
        source.delete = AsyncMock(side_effect=Exception("Missing Permissions"))
        view = self._view(source)
        interaction = _ButtonInteraction(42)
        await _find_button(view, "delete").callback(interaction)
        interaction.response.edit_message.assert_awaited_once()
        source.delete.assert_awaited_once()

    async def test_non_owner_cannot_invalidate(self):
        source = _FakeMessage(42, 7, [])
        view = self._view(source)
        interaction = _ButtonInteraction(999)
        await _find_button(view, "delete").callback(interaction)
        interaction.response.send_message.assert_awaited_once()
        self.assertTrue(interaction.response.send_message.call_args.kwargs["ephemeral"])
        interaction.response.edit_message.assert_not_awaited()
        source.delete.assert_not_awaited()


class RegistryTest(unittest.TestCase):
    def test_genre_and_actions_registered(self):
        from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES

        self.assertIn("make_image", GENERAL_GENRES)
        values = [value for _label, value in GENERAL_ACTIONS["make_image"]]
        self.assertIn("fast_html", values)

    def test_fast_html_blocked_for_ai(self):
        from core.general import action_registry
        from core.general.ai_tools import ai_tools_router

        spec = action_registry.default_registry().get("general:fast_html")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.risk, "blocked")
        candidates = ai_tools_router.action_candidates()
        ids = {
            c["id"] if isinstance(c, dict) else getattr(c, "id", str(c))
            for c in candidates
        }
        self.assertNotIn("general:fast_html", ids)
        self.assertIn("general:fast_html", ai_tools_router.BLOCKED_ACTIONS)


if __name__ == "__main__":
    unittest.main()
