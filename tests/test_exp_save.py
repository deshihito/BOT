# -*- coding: utf-8 -*-
"""EXP の保存条件のテスト (監査 #3: 実際に変わったときだけ保存する)。

- VC tick: 付与ゼロの周期では _exp_save を呼ばない / 付与があれば呼ぶ
- VC 入退室: 付与も計測フラグの変化も無い退室では保存しない
"""
import os
import tempfile
import time
import types
import unittest
from unittest.mock import AsyncMock, patch

import cogs.general as general_module
from cogs.general import GeneralCog
from core import guild_settings
from core.storage import KVStore


def _user(**overrides):
    user = {
        "chat_exp": 0,
        "vc_exp": 0,
        "last_chat_grant": 0.0,
        "vc_accum_sec": 0.0,
        "vc_last_tick": 0.0,
    }
    user.update(overrides)
    return user


class _FakeChannel:
    def __init__(self, voice_states=None):
        self.voice_states = voice_states or {}


class _FakeGuild:
    def __init__(self, guild_id=1, channels=()):
        self.id = guild_id
        self.voice_channels = list(channels)
        self.stage_channels = []

    def get_member(self, user_id):
        return types.SimpleNamespace(bot=False, id=user_id)


def _make_cog(guilds=()):
    cog = GeneralCog(types.SimpleNamespace(guilds=list(guilds)))
    cog._notify_level_rewards = AsyncMock()
    cog._spawn = lambda coro: coro.close()
    return cog


class ExpVcTickSaveTests(unittest.IsolatedAsyncioTestCase):
    async def _run_tick(self, data, guild):
        cog = _make_cog([guild])
        save = AsyncMock(return_value=True)
        with (
            patch.object(general_module, "_exp_load", AsyncMock(return_value=data)),
            patch.object(general_module, "_exp_save", save),
        ):
            await cog.exp_vc_tick()
        return save

    async def test_tick_without_grant_does_not_save(self):
        now = time.time()
        # 60秒経過しただけでは 300秒の付与間隔に届かない
        user = _user(vc_last_tick=now - 60)
        data = {"1": {"42": user}}
        guild = _FakeGuild(1, [_FakeChannel({42: object()})])

        save = await self._run_tick(data, guild)

        save.assert_not_awaited()
        # 進行 (accum) はメモリ上に保持され、次の付与時にまとめて保存される
        self.assertGreater(user["vc_accum_sec"], 0.0)
        self.assertEqual(user["vc_exp"], 0)

    async def test_tick_with_grant_saves(self):
        now = time.time()
        # accum 280 + 経過 60秒 で 300秒に到達し、付与が起きる
        user = _user(vc_last_tick=now - 60, vc_accum_sec=280.0)
        data = {"1": {"42": user}}
        guild = _FakeGuild(1, [_FakeChannel({42: object()})])

        save = await self._run_tick(data, guild)

        save.assert_awaited_once()
        self.assertEqual(user["vc_exp"], general_module.VC_EXP_PER_GRANT)

    async def test_tick_with_nobody_in_vc_does_not_save(self):
        data = {"1": {"42": _user()}}
        guild = _FakeGuild(1, [_FakeChannel()])

        save = await self._run_tick(data, guild)

        save.assert_not_awaited()

    async def test_tick_clears_stale_measurement_and_saves(self):
        now = time.time()
        # VC にいないのに計測中フラグが残っているユーザは止める (実変更なので保存)
        user = _user(vc_last_tick=now - 60)
        data = {"1": {"42": user}}
        guild = _FakeGuild(1, [_FakeChannel()])

        save = await self._run_tick(data, guild)

        save.assert_awaited_once()
        self.assertEqual(user["vc_last_tick"], 0.0)


class ExpVoiceStateSaveTests(unittest.IsolatedAsyncioTestCase):
    async def _run_update(self, data, user_id=42, before_ch=None, after_ch=None):
        cog = _make_cog()
        save = AsyncMock(return_value=True)
        member = types.SimpleNamespace(
            bot=False, id=user_id, guild=types.SimpleNamespace(id=1),
        )
        before = types.SimpleNamespace(channel=before_ch)
        after = types.SimpleNamespace(channel=after_ch)
        with (
            patch.object(general_module, "_exp_load", AsyncMock(return_value=data)),
            patch.object(general_module, "_exp_save", save),
        ):
            await cog.on_voice_state_update(member, before, after)
        return save

    async def test_join_saves_measurement_start(self):
        user = _user()
        data = {"1": {"42": user}}

        save = await self._run_update(data, after_ch=object())

        save.assert_awaited_once()
        self.assertGreater(user["vc_last_tick"], 0.0)

    async def test_leave_with_grant_saves(self):
        now = time.time()
        user = _user(vc_last_tick=now - 120, vc_accum_sec=200.0)
        data = {"1": {"42": user}}

        save = await self._run_update(data, before_ch=object())

        save.assert_awaited_once()
        self.assertEqual(user["vc_exp"], general_module.VC_EXP_PER_GRANT)
        self.assertEqual(user["vc_last_tick"], 0.0)

    async def test_leave_without_grant_still_saves_measurement_stop(self):
        now = time.time()
        user = _user(vc_last_tick=now - 60)
        data = {"1": {"42": user}}

        save = await self._run_update(data, before_ch=object())

        # 付与は無いが、計測中フラグを下ろす実変更があるので保存する
        save.assert_awaited_once()
        self.assertEqual(user["vc_exp"], 0)
        self.assertEqual(user["vc_last_tick"], 0.0)

    async def test_leave_without_any_change_does_not_save(self):
        # 計測が始まっていない (vc_last_tick=0) 状態での退室イベントは
        # 付与もフラグ変化も無いので保存しない
        user = _user()
        data = {"1": {"42": user}}

        save = await self._run_update(data, before_ch=object())

        save.assert_not_awaited()
        self.assertEqual(user["vc_last_tick"], 0.0)


class StoreFetchGuildSettingsTests(unittest.TestCase):
    """_store_fetch が GuildSettings 実物の旧EXPを読めること。

    GuildSettings.get は (guild_id, section) の2引数必須なので、従来の
    get(key) 1引数呼び出しでは毎起動 TypeError → WARNING になっていた。
    """

    def _make_store(self, data):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = guild_settings.GuildSettings(
            KVStore("guild_settings", client=None, path=os.path.join(tmp.name, "kv.json"))
        )
        store._data = data
        return store

    def test_top_level_exp_entry_is_returned(self):
        legacy = {"1": {"42": {"chat_exp": 5, "vc_exp": 0}}}
        store = self._make_store({"exp": legacy})
        self.assertEqual(general_module._store_fetch(store, "exp"), legacy)

    def test_per_guild_exp_sections_are_aggregated(self):
        store = self._make_store({
            "1": {"exp": {"42": {"chat_exp": 5}}, "auth": {"role_id": 1}},
            "2": {"exp": {"7": {"chat_exp": 9}}},
            "3": {"auth": {"role_id": 2}},
        })
        result = general_module._store_fetch(store, "exp")
        self.assertEqual(result, {
            "1": {"42": {"chat_exp": 5}},
            "2": {"7": {"chat_exp": 9}},
        })

    def test_no_legacy_data_returns_none_without_warning(self):
        store = self._make_store({"1": {"auth": {"role_id": 1}}})
        with self.assertNoLogs("cogs.general", level="WARNING"):
            result = general_module._store_fetch(store, "exp")
        self.assertIsNone(result)

    def test_empty_store_returns_none_without_warning(self):
        store = self._make_store({})
        with self.assertNoLogs("cogs.general", level="WARNING"):
            result = general_module._store_fetch(store, "exp")
        self.assertIsNone(result)


class StoreFetchCompatTests(unittest.TestCase):
    """_store_fetch の dict-like ストア互換と、シグネチャ不一致時の静かな None。"""

    def test_dict_like_store_get_is_used(self):
        store = types.SimpleNamespace(get=lambda key: {"1": {"42": {}}})
        self.assertEqual(
            general_module._store_fetch(store, "exp"), {"1": {"42": {}}}
        )

    def test_two_arg_get_store_returns_none_without_warning(self):
        class TwoArgStore:
            def get(self, guild_id, section):
                raise AssertionError("呼ばれるべきではない形で呼ばれた")

        with self.assertNoLogs("cogs.general", level="WARNING"):
            result = general_module._store_fetch(TwoArgStore(), "exp")
        self.assertIsNone(result)

    def test_store_without_get_returns_none(self):
        self.assertIsNone(general_module._store_fetch(object(), "exp"))


if __name__ == "__main__":
    unittest.main()
