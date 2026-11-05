# -*- coding: utf-8 -*-
"""EXP の保存条件のテスト (監査 #3: 実際に変わったときだけ保存する)。

- VC tick: 付与ゼロの周期では _exp_save を呼ばない / 付与があれば呼ぶ
- VC 入退室: 付与も計測フラグの変化も無い退室では保存しない
"""
import time
import types
import unittest
from unittest.mock import AsyncMock, patch

import cogs.general as general_module
from cogs.general import GeneralCog


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


if __name__ == "__main__":
    unittest.main()
