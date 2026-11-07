"""ミュート（core/support/muted/cog.py）のテスト（ミュート解除ループと、再起動しても残る保存）。Supabase は偽物、ファイルは一時フォルダにだけ書く。"""

import asyncio
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.support.muted import cog as muted  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from tests.fake_kv_supabase import FakeKVSupabase, missing_table_error  # noqa: E402

NOW = datetime(2026, 10, 12, 3, 0, tzinfo=timezone.utc)


class FakeMember:
    def __init__(self, user_id, guild):
        self.id, self.guild, self.display_name = user_id, guild, f"user{user_id}"
        self.roles = []
        self.on_remove = None

    async def add_roles(self, role, **kwargs):
        self.roles.append(role)

    async def remove_roles(self, role, **kwargs):
        await asyncio.sleep(0)
        if self.on_remove:
            await self.on_remove()
        if role in self.roles:
            self.roles.remove(role)


class FakeGuild:
    def __init__(self, guild_id=1):
        self.id = guild_id
        self.role = types.SimpleNamespace(id=77, name="Muted")
        self.roles = [self.role]
        self.members = {}

    def member(self, user_id):
        m = self.members[user_id] = FakeMember(user_id, self)
        m.roles.append(self.role)
        return m

    def get_member(self, user_id):
        return self.members.get(user_id)


class FakeBot:
    def __init__(self, guilds=(), ready=True):
        self.guilds = {g.id: g for g in guilds}
        self.ready = ready
        self._never = asyncio.Event()

    def get_guild(self, guild_id):
        return self.guilds.get(guild_id)

    def is_ready(self):
        return self.ready

    async def wait_until_ready(self):
        await self._never.wait()  # テストではループを自動で回さない


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "bot_kv.json")
        self.db = FakeKVSupabase()
        self.guild = FakeGuild()
        self.bot = FakeBot([self.guild])
        self.cogs = []

    async def asyncTearDown(self):
        for cog in self.cogs:
            cog.cog_unload()

    def store(self, client="db"):
        return KVStore("muted", client=self.db if client == "db" else client, path=self.path)

    def cog(self, bot=None, client="db"):
        cog = muted.Muted(bot or self.bot, store=self.store(client))
        self.cogs.append(cog)
        return cog


class LoopTest(Base):
    async def test_mute_added_during_unmute_does_not_crash(self):
        cog = self.cog()
        a, b = self.guild.member(10), self.guild.member(11)
        cog.mute_tasks[(1, 10)] = NOW - timedelta(minutes=1)
        cog.mute_tasks[(1, 11)] = NOW - timedelta(minutes=1)

        async def mute_someone_else():  # remove_roles を待っている間に /muted が実行された
            cog.mute_tasks[(1, 99)] = NOW + timedelta(minutes=5)
        a.on_remove = mute_someone_else

        done = await cog.unmute_expired(NOW)  # 以前は RuntimeError: dictionary changed size during iteration
        self.assertEqual(sorted(done), [(1, 10), (1, 11)])
        self.assertEqual(list(cog.mute_tasks), [(1, 99)])
        self.assertNotIn(self.guild.role, a.roles)
        self.assertNotIn(self.guild.role, b.roles)

    async def test_one_failure_does_not_stop_others(self):
        cog = self.cog()
        a, _b = self.guild.member(10), self.guild.member(11)
        a.remove_roles = AsyncMock(side_effect=RuntimeError("boom"))
        cog.mute_tasks[(1, 10)] = NOW - timedelta(minutes=1)
        cog.mute_tasks[(1, 11)] = NOW - timedelta(minutes=1)
        with self.assertLogs("cogs.muted", level="ERROR"):
            done = await cog.unmute_expired(NOW)
        self.assertEqual(done, [(1, 11)])
        self.assertIn((1, 10), cog.mute_tasks)  # 次の確認でやり直す

    async def test_http_error_retries_later(self):
        cog = self.cog()
        a = self.guild.member(10)
        a.remove_roles = AsyncMock(side_effect=discord.HTTPException(types.SimpleNamespace(status=500, reason="x"), "x"))
        cog.mute_tasks[(1, 10)] = NOW - timedelta(minutes=1)
        with self.assertLogs("cogs.muted", level="WARNING"):
            self.assertEqual(await cog.unmute_expired(NOW), [])
        self.assertIn((1, 10), cog.mute_tasks)

    async def test_loop_body_never_raises(self):
        cog = self.cog()
        with patch.object(cog, "unmute_expired", AsyncMock(side_effect=RuntimeError("boom"))), \
                self.assertLogs("cogs.muted", level="ERROR"):
            await cog.check_mute_expiry.coro(cog)

    async def test_not_expired_kept_and_left_member_dropped(self):
        cog = self.cog()
        cog.mute_tasks[(1, 10)] = NOW + timedelta(minutes=1)
        cog.mute_tasks[(1, 12)] = NOW - timedelta(minutes=1)  # もうサーバーにいない
        self.assertEqual(await cog.unmute_expired(NOW), [(1, 12)])
        self.assertEqual(list(cog.mute_tasks), [(1, 10)])

    async def test_unknown_guild_kept_until_ready(self):
        bot = FakeBot([], ready=False)
        cog = self.cog(bot)
        cog.mute_tasks[(5, 10)] = NOW - timedelta(minutes=1)
        self.assertEqual(await cog.unmute_expired(NOW), [])
        bot.ready = True  # 準備ができても見えないサーバー = Bot が抜けた
        self.assertEqual(await cog.unmute_expired(NOW), [(5, 10)])


class PersistenceTest(Base):
    def interaction(self, user_perms=None):
        perms = user_perms or discord.Permissions(manage_roles=True, administrator=True)
        user = types.SimpleNamespace(guild_permissions=perms, roles=[])
        response = types.SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock())
        return types.SimpleNamespace(guild_id=1, guild=self.guild, user=user, response=response)

    async def mute_via_command(self, cog, user_id=10, minutes=5):
        target = self.guild.member(user_id)
        target.roles.clear()
        with patch.object(cog, "get_or_create_muted_role", AsyncMock(return_value=(self.guild.role, False))):
            await cog.muted_setting.callback(cog, self.interaction(), target=target, minutes=minutes)
        return target

    async def test_saved_to_supabase_and_survive_restart(self):
        cog = self.cog()
        target = await self.mute_via_command(cog)
        await cog.muted_setting.callback(cog, self.interaction(), admin_role=types.SimpleNamespace(id=555, mention="@mod"))
        saved = self.db.value("muted", "1")
        self.assertEqual(saved["admin_role_id"], 555)
        self.assertEqual(list(saved["mutes"]), ["10"])

        os.remove(self.path)  # ラズパイの更新でローカルのファイルが消えても
        restarted = self.cog()
        self.assertEqual(restarted.mute_tasks, {})
        await restarted.load_remote()  # Bot の準備ができたら Supabase から読み直す
        self.assertEqual(restarted.admin_roles, {1: 555})
        expire = restarted.mute_tasks[(1, 10)]
        self.assertEqual(expire, cog.mute_tasks[(1, 10)])
        self.assertIsNotNone(expire.tzinfo)

        # 期限が来たら解除されて、保存からも消える（管理ロールは残る）
        self.assertEqual(await restarted.unmute_expired(expire + timedelta(seconds=1)), [(1, 10)])
        self.assertNotIn(self.guild.role, target.roles)
        self.assertEqual(self.db.value("muted", "1"), {"admin_role_id": 555})

    async def test_last_entry_removed_deletes_row(self):
        cog = self.cog()
        await self.mute_via_command(cog)
        await cog.unmute_expired(NOW + timedelta(days=1))
        self.assertIsNone(self.db.value("muted", "1"))

    async def test_expired_while_offline_unmuted_on_first_check(self):
        member = self.guild.member(10)
        await self.store().set("1", {"mutes": {"10": (NOW - timedelta(hours=3)).isoformat()}})
        os.remove(self.path)
        cog = self.cog()
        await cog.load_remote()
        self.assertEqual(await cog.unmute_expired(NOW), [(1, 10)])
        self.assertNotIn(self.guild.role, member.roles)

    async def test_missing_table_falls_back_to_local_file(self):
        self.db.error = missing_table_error()
        cog = self.cog()
        with self.assertLogs("core.support.storage", level="WARNING"):
            await self.mute_via_command(cog)
            await cog.load_remote()
        self.assertIn((1, 10), cog.mute_tasks)
        restarted = self.cog()  # ローカルの控えから戻る
        self.assertIn((1, 10), restarted.mute_tasks)

    async def test_local_only_data_pushed_to_supabase(self):
        await self.store(client=None).set("1", {"admin_role_id": 7})  # テーブルを作る前に保存されていた分
        cog = self.cog()
        await cog.load_remote()
        self.assertEqual(cog.admin_roles, {1: 7})
        self.assertEqual(self.db.value("muted", "1"), {"admin_role_id": 7})

    async def test_broken_data_is_skipped(self):
        await self.store().set("1", {"mutes": {"10": "not-a-date", "11": NOW.isoformat()}, "admin_role_id": "x"})
        cog = self.cog()
        with self.assertLogs("cogs.muted", level="WARNING"):
            await cog.load_remote()
        self.assertEqual(list(cog.mute_tasks), [(1, 11)])
        self.assertEqual(cog.admin_roles, {})

    async def test_load_remote_runs_in_before_loop(self):
        cog = self.cog()
        cog.bot.wait_until_ready = AsyncMock()
        with patch.object(cog, "load_remote", AsyncMock()) as load:
            await cog.before_check_mute_expiry()
        load.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
