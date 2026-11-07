"""グローバルVC グロチャ（テキスト連携）の永続化テスト。Discord には接続しない。

- core/vc/globalvc/textlink.py: 連携の保存（作成/削除の節目）→ 再読み込みで状態が一致
- 復旧時、消えたチャンネル/ルームへのリンクが掃除され、掃除後の状態が保存し直される
- ストアが壊れていても復旧処理が例外なく終わり、機能が起動できる
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

import discord  # noqa: E402

from core.vc import voice_restore  # noqa: E402
from core.vc.globalvc import entry as gvc  # noqa: E402
from core.vc.globalvc import textlink  # noqa: E402


WEBHOOK_URL = "https://discord.com/api/webhooks/999/token-abc"


class FakeWebhook:
    def __init__(self, webhook_id=999, url=WEBHOOK_URL):
        self.id = webhook_id
        self.url = url
        self.deleted = False

    async def delete(self, reason=None):
        self.deleted = True


def fake_channel(channel_id, guild_id):
    return types.SimpleNamespace(
        id=channel_id,
        guild=types.SimpleNamespace(id=guild_id, name=f"guild{guild_id}"),
        name=f"ch{channel_id}",
    )


def make_bot(channels=None):
    channels = channels or {}
    return types.SimpleNamespace(get_channel=lambda channel_id: channels.get(channel_id))


class TextLinkTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "voice_restore.json"
        self.store = voice_restore.reset_store(self.path)
        self.saved_rooms = dict(gvc.ROOMS)
        self.saved_links = {k: list(v) for k, v in textlink.ROOM_TEXT_LINKS.items()}
        self.saved_c2r = dict(textlink.CHANNEL_TO_ROOM)
        gvc.ROOMS.clear()
        textlink.ROOM_TEXT_LINKS.clear()
        textlink.CHANNEL_TO_ROOM.clear()

    def tearDown(self):
        gvc.ROOMS.clear()
        gvc.ROOMS.update(self.saved_rooms)
        textlink.ROOM_TEXT_LINKS.clear()
        textlink.ROOM_TEXT_LINKS.update(self.saved_links)
        textlink.CHANNEL_TO_ROOM.clear()
        textlink.CHANNEL_TO_ROOM.update(self.saved_c2r)
        voice_restore.reset_store()
        self.tmp.cleanup()

    def add_room(self, name="room1"):
        gvc.ROOMS[name] = gvc.RoomConfig(name=name, owner_id=110, owner_guild_id=10)

    def add_link(self, room_name="room1", guild_id=10, channel_id=500):
        webhook = FakeWebhook()
        link = textlink.TextLink(guild_id=guild_id, channel_id=channel_id, webhook=webhook)
        textlink.ROOM_TEXT_LINKS.setdefault(room_name, []).append(link)
        textlink.CHANNEL_TO_ROOM[channel_id] = room_name
        return link


# ---------------------------------------------------------------- 保存
class TextLinkPersistTest(TextLinkTestCase):
    def test_persist_writes_section(self):
        self.add_room()
        self.add_link()
        self.add_link(guild_id=20, channel_id=600)
        textlink._persist_text_links()
        section = self.store.section("gvc_text_links")
        self.assertEqual(set(section), {"room1"})
        links = section["room1"]["links"]
        self.assertEqual(len(links), 2)
        self.assertEqual(links[0], {
            "guild_id": 10, "channel_id": 500,
            "webhook_id": 999, "webhook_url": WEBHOOK_URL,
        })
        # ファイルから読み直しても一致する
        reloaded = voice_restore.VoiceRestoreStore(self.path)
        self.assertEqual(reloaded.section("gvc_text_links"), section)

    def test_persist_empty_links_writes_empty_section(self):
        self.add_room()
        textlink._persist_text_links()
        self.assertEqual(self.store.section("gvc_text_links"), {})


# ---------------------------------------------------------------- 復旧
class TextLinkRestoreTest(TextLinkTestCase, unittest.IsolatedAsyncioTestCase):
    def patch_from_url(self):
        return mock.patch.object(
            discord.Webhook, "from_url",
            side_effect=lambda url, client=None: FakeWebhook(999, url),
        )

    async def test_create_save_reload_roundtrip(self):
        self.add_room()
        self.add_link()
        textlink._persist_text_links()
        # 再起動を模す: インメモリ状態を落としてから復旧する
        textlink.ROOM_TEXT_LINKS.clear()
        textlink.CHANNEL_TO_ROOM.clear()

        bot = make_bot({500: fake_channel(500, 10)})
        with self.patch_from_url():
            await textlink._restore_text_links(bot)

        links = textlink.ROOM_TEXT_LINKS.get("room1", [])
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].guild_id, 10)
        self.assertEqual(links[0].channel_id, 500)
        self.assertEqual(links[0].webhook.url, WEBHOOK_URL)
        self.assertEqual(textlink.CHANNEL_TO_ROOM, {500: "room1"})

    async def test_restore_cleans_dead_channel_and_room(self):
        self.add_room()
        self.add_link()                                    # 正常なリンク
        self.add_link(guild_id=30, channel_id=700)         # チャンネルが見えない
        textlink.ROOM_TEXT_LINKS["gone_room"] = [
            textlink.TextLink(guild_id=40, channel_id=800, webhook=FakeWebhook())
        ]
        textlink.CHANNEL_TO_ROOM[800] = "gone_room"        # ルーム自体が無い
        textlink._persist_text_links()
        textlink.ROOM_TEXT_LINKS.clear()
        textlink.CHANNEL_TO_ROOM.clear()

        bot = make_bot({500: fake_channel(500, 10)})       # 700 は見えない
        with self.patch_from_url():
            await textlink._restore_text_links(bot)

        self.assertEqual([l.channel_id for l in textlink.ROOM_TEXT_LINKS.get("room1", [])], [500])
        self.assertNotIn("gone_room", textlink.ROOM_TEXT_LINKS)
        self.assertEqual(textlink.CHANNEL_TO_ROOM, {500: "room1"})
        # 掃除後の状態が保存し直されている
        section = self.store.section("gvc_text_links")
        self.assertEqual(set(section), {"room1"})
        self.assertEqual([l["channel_id"] for l in section["room1"]["links"]], [500])

    async def test_restore_without_saved_section_is_noop(self):
        bot = make_bot()
        await textlink._restore_text_links(bot)
        self.assertEqual(textlink.ROOM_TEXT_LINKS, {})
        self.assertEqual(textlink.CHANNEL_TO_ROOM, {})

    async def test_corrupt_store_does_not_break_restore(self):
        self.path.write_text("{ broken json", encoding="utf-8")
        voice_restore.reset_store(self.path)  # 壊れたファイルは退避され空で始まる
        bot = make_bot({500: fake_channel(500, 10)})
        await textlink._restore_text_links(bot)  # 例外なく終わる
        self.assertEqual(textlink.ROOM_TEXT_LINKS, {})
        self.assertEqual(textlink.CHANNEL_TO_ROOM, {})

    async def test_remove_text_link_persists(self):
        self.add_room()
        link = self.add_link()
        textlink._persist_text_links()
        self.assertNotEqual(self.store.section("gvc_text_links"), {})

        room_name = await textlink._remove_text_link(500)
        self.assertEqual(room_name, "room1")
        self.assertTrue(link.webhook.deleted)
        self.assertEqual(textlink.ROOM_TEXT_LINKS, {})
        self.assertEqual(textlink.CHANNEL_TO_ROOM, {})
        self.assertEqual(self.store.section("gvc_text_links"), {})


if __name__ == "__main__":
    unittest.main()
