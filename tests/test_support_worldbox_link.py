"""WORLD BOX連携の /support 追加（worldbox_link）のテスト。

- レジストリ登録（support:worldbox_link、notices ジャンル、AI 代理実行なし）
- 連携レコードの構築/解釈が Web（parseUnionChatSettings /
  storeUnionChatSettings）と Bot ワーカー（worldbox_discord）の
  両方の解釈と一致すること（同一レコードの読み書きの担保）
- 状態表示フィールドの組み立てと、パネルの保存が同じレコードへ書くこと
"""
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general import action_registry  # noqa: E402
from core.general.circulation import worldbox_discord as wd  # noqa: E402
from core.support.common import SUPPORT_ACTIONS_BY_GENRE  # noqa: E402
from core.support.worldbox import link as wl  # noqa: E402
from core.support.worldbox import link_panel as lp  # noqa: E402
from cogs.support import SUPPORT_ACTIONS, SupportCog  # noqa: E402

GID = "111111111111111111"
CID = "222222222222222222"
NOW_MS = 1_763_000_000_000


class RegistryTest(unittest.TestCase):
    def test_action_registered_in_notices_genre(self):
        values = [value for _label, value in SUPPORT_ACTIONS_BY_GENRE["notices"]]
        self.assertIn("worldbox_link", values)
        self.assertIn("worldbox_link", [c.value for c in SUPPORT_ACTIONS])
        labels = {c.value: c.name for c in SUPPORT_ACTIONS}
        self.assertEqual(labels["worldbox_link"], "WORLD BOX連携")

    def test_registry_spec(self):
        spec = action_registry.default_registry().by_id("support:worldbox_link")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.genre, "notices")
        # 設定の状態変更系なので AI 代理実行には出さない（globalchat と同扱い）。
        self.assertNotIn("aitools", spec.surfaces)

    def test_permission_is_manage_guild(self):
        self.assertEqual(
            SupportCog.SUPPORT_REQUIRED_PERMISSIONS.get("worldbox_link"), "manage_guild")


class RecordFormatTest(unittest.TestCase):
    def test_build_record_shape_matches_web_store(self):
        record = wl.build_union_settings_record("channel", CID, NOW_MS)
        data = json.loads(record)
        # Web の storeUnionChatSettings が書くキー集合・型と一致すること。
        self.assertEqual(set(data), {"mode", "channelId", "updatedAt"})
        self.assertEqual(data["mode"], "channel")
        self.assertEqual(data["channelId"], CID)
        self.assertEqual(data["updatedAt"], NOW_MS)

    def test_build_record_events_flag(self):
        self.assertTrue(wl.parse_union_events(wl.build_union_settings_record("channel", CID, NOW_MS)))
        muted = wl.build_union_settings_record("channel", CID, NOW_MS, events=False)
        self.assertFalse(wl.parse_union_events(muted))
        self.assertEqual(json.loads(muted)["events"], False)

    def test_build_record_global_and_none_have_null_channel(self):
        for mode in ("global", "none"):
            data = json.loads(wl.build_union_settings_record(mode, CID, NOW_MS))
            self.assertEqual(data["mode"], mode)
            self.assertIsNone(data["channelId"])

    def test_build_record_channel_requires_valid_id(self):
        with self.assertRaises(ValueError):
            wl.build_union_settings_record("channel", None, NOW_MS)
        with self.assertRaises(ValueError):
            wl.build_union_settings_record("channel", "123", NOW_MS)
        with self.assertRaises(ValueError):
            wl.build_union_settings_record("bogus", None, NOW_MS)

    def test_round_trip_through_both_parsers(self):
        # /support が書いたレコードを、こちらの解釈と Bot ワーカー
        # （受信リレーの宛先解決）の解釈の両方で同じ結果になること。
        for mode, channel_id in (("channel", CID), ("global", None), ("none", None)):
            record = wl.build_union_settings_record(mode, channel_id, NOW_MS)
            self.assertEqual(wl.parse_union_link(record), (mode, channel_id))
            self.assertEqual(wd.parse_union_link(record), (mode, channel_id))

    def test_parse_web_written_record(self):
        # Web が書いたレコード（JSON 文字列 / dict の両形）を読めること。
        web_record = json.dumps({"mode": "channel", "channelId": CID, "updatedAt": 42})
        self.assertEqual(wl.parse_union_link(web_record), ("channel", CID))
        self.assertEqual(
            wl.parse_union_link({"mode": "global", "channelId": None, "updatedAt": 42}),
            ("global", None))

    def test_parse_legacy_and_broken_records(self):
        self.assertEqual(wl.parse_union_link({"chatChannelId": CID}), ("channel", CID))
        self.assertEqual(wl.parse_union_link({"chatChannelId": ""}), ("none", None))
        self.assertEqual(wl.parse_union_link({"mode": "channel", "channelId": "x"}),
                         ("none", None))
        self.assertEqual(wl.parse_union_link(None), ("none", None))
        self.assertEqual(wl.parse_union_link("not json"), ("none", None))
        self.assertEqual(wl.parse_union_link(12345), ("none", None))

    def test_parse_nation_guild_ids(self):
        raw = json.dumps({"nations": {GID: {"name": "国"}, "abc": {}}, "members": {}})
        self.assertEqual(wl.parse_nation_guild_ids(raw), {GID})
        self.assertEqual(wl.parse_nation_guild_ids(None), set())
        self.assertEqual(wl.parse_nation_guild_ids({"nations": []}), set())

    def test_global_reuse_channel_id(self):
        self.assertEqual(wl.global_reuse_channel_id([10, 55, 77], {55}), 55)
        self.assertEqual(wl.global_reuse_channel_id([10], {"55"}), None)
        self.assertEqual(wl.global_reuse_channel_id([55], {"55", "77"}), 55)
        self.assertIsNone(wl.global_reuse_channel_id([], {55}))
        self.assertIsNone(wl.global_reuse_channel_id([55], None))


class StatusFieldsTest(unittest.TestCase):
    def fields(self, **overrides):
        base = dict(mode="none", channel_id=None, channel_name=None,
                    global_channel_name=None, has_nation=True,
                    missing_bot_permissions=[])
        base.update(overrides)
        return dict(wl.build_link_status_fields(**base))

    def test_none_state(self):
        self.assertEqual(self.fields()["状態"], "未連携")

    def test_channel_state_with_name(self):
        fields = self.fields(mode="channel", channel_id=CID, channel_name="わーるど")
        self.assertIn("専用チャンネル連携中", fields["状態"])
        self.assertIn("#わーるど", fields["状態"])

    def test_channel_state_missing_channel(self):
        fields = self.fields(mode="channel", channel_id=CID, channel_name=None)
        self.assertIn("見つかりません", fields["状態"])

    def test_global_state(self):
        fields = self.fields(mode="global", global_channel_name="ぐろーばる")
        self.assertIn("グローバルチャット流用中", fields["状態"])
        self.assertIn("#ぐろーばる", fields["状態"])
        fields = self.fields(mode="global", global_channel_name=None)
        self.assertIn("見つかりません", fields["状態"])

    def test_no_nation_note(self):
        self.assertIn("WORLD BOX の国", self.fields(has_nation=False))
        self.assertNotIn("WORLD BOX の国", self.fields(has_nation=True))

    def test_missing_permissions_field(self):
        fields = self.fields(mode="channel", channel_id=CID, channel_name="x",
                             missing_bot_permissions=["メッセージを送信"])
        self.assertIn("メッセージを送信", fields["Bot の権限"])


class FakeKV:
    def __init__(self, records=None):
        self.records = dict(records or {})

    async def load_one(self, key):
        return self.records.get(key)

    async def set(self, key, value):
        self.records[key] = value


def _gc_cog(channels=()):
    return types.SimpleNamespace(active_channels=set(channels), save_channels=MagicMock())


def _guild(channel_ids=(222222222222222222, 444444444444444444)):
    guild = types.SimpleNamespace(id=int(GID), name="テストサーバー")
    channels = {}
    for cid in channel_ids:
        ch = types.SimpleNamespace(id=cid, name=f"ch{cid}", guild=guild)
        ch.permissions_for = lambda me: types.SimpleNamespace(
            view_channel=True, send_messages=True)
        channels[cid] = ch
    guild.get_channel = lambda cid: channels.get(cid)
    guild.me = types.SimpleNamespace(id=999)
    guild.channels = channels
    return guild


def _interaction(can_manage=True):
    return types.SimpleNamespace(
        user=types.SimpleNamespace(
            guild_permissions=types.SimpleNamespace(
                manage_guild=can_manage, administrator=False)),
        response=types.SimpleNamespace(
            is_done=lambda: False, edit_message=AsyncMock(), send_message=AsyncMock()),
        guild_id=int(GID),
    )


class ViewTest(unittest.IsolatedAsyncioTestCase):
    def _view(self, *, settings=None, nations=None, gc_channels=()):
        gc = _gc_cog(gc_channels)
        guild = _guild()
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_cog=lambda name: gc))
        settings_store = FakeKV(settings)
        nations_store = FakeKV(nations)
        view = lp.WorldBoxLinkSettingsView(cog, guild, settings_store, nations_store)
        return view, settings_store, guild

    async def test_load_state_reads_game_written_record(self):
        # ゲーム内（Web）で設定済みのレコードがそのまま表示されること。
        record = json.dumps({"mode": "channel", "channelId": CID, "updatedAt": 1})
        view, _store, _guild_obj = self._view(
            settings={GID: record},
            nations={"nations": json.dumps({"nations": {GID: {}}})})
        await view.load_state()
        self.assertEqual(view.mode, "channel")
        self.assertEqual(view.channel_id, CID)
        values = [f.value for f in view.embed().fields]
        self.assertTrue(any("専用チャンネル連携中" in v for v in values))

    async def test_channel_select_saves_channel_record(self):
        view, store, guild = self._view()
        await view.load_state()
        select = next(item for item in view.children
                      if isinstance(item, lp.WorldBoxLinkChannelSelect))
        select._values = [guild.channels[222222222222222222]]
        await select.callback(_interaction())
        mode, channel_id = wl.parse_union_link(store.records[GID])
        self.assertEqual((mode, channel_id), ("channel", CID))
        # Bot ワーカーの解釈でも同じ宛先になること。
        self.assertEqual(wd.parse_union_link(store.records[GID]), ("channel", CID))

    async def test_use_global_saves_global_record(self):
        view, store, _guild_obj = self._view(gc_channels=(444444444444444444,))
        await view.load_state()
        await view.on_use_global(_interaction())
        self.assertEqual(wl.parse_union_link(store.records[GID]), ("global", None))

    async def test_use_global_unavailable_without_globalchat_channel(self):
        view, store, _guild_obj = self._view()
        await view.load_state()
        button = next(item for item in view.children
                      if getattr(item, "label", "") == "グローバルチャットを流用")
        self.assertTrue(button.disabled)
        interaction = _interaction()
        await view.on_use_global(interaction)
        self.assertNotIn(GID, store.records)
        interaction.response.send_message.assert_awaited()

    async def test_unlink_saves_none_record(self):
        record = json.dumps({"mode": "channel", "channelId": CID, "updatedAt": 1})
        view, store, _guild_obj = self._view(settings={GID: record})
        await view.load_state()
        await view.on_unlink(_interaction())
        self.assertEqual(wl.parse_union_link(store.records[GID]), ("none", None))

    async def test_save_requires_manage_permission(self):
        view, store, _guild_obj = self._view()
        await view.load_state()
        interaction = _interaction(can_manage=False)
        await view.save_link(interaction, "none", None, "notice")
        self.assertNotIn(GID, store.records)
        interaction.response.send_message.assert_awaited()


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_routes_to_worldbox_link_settings(self):
        cog = object.__new__(SupportCog)
        cog.bot = types.SimpleNamespace()
        cog.show_worldbox_link_settings = AsyncMock()
        interaction = types.SimpleNamespace(guild_id=10, user=types.SimpleNamespace(id=7))
        with patch("cogs.support.action_usage.record_safely_in_background"), \
                patch("cogs.support.usage_stats.record_action_safely"), \
                patch.object(SupportCog, "check_support_permission", AsyncMock(return_value=True)):
            await cog.dispatch(interaction, "worldbox_link")
        cog.show_worldbox_link_settings.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
