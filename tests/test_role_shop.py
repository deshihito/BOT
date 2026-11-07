"""有期限ロールショップ（ギルド管理者設定型）のテスト（2026-11-06、Phase C）。

- 商品登録の検証（価格・期間・上限件数）と GuildSettings への保存
- Bot の権限・ロール階層が不足する場合は登録/購入の前に弾く
- 購入: wallet CAS で支払い、即時付与、期限は再購入で延長
- 期限切れはスイープで剥奪され、記録も消える
- 逮捕中のユーザーは購入できない
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.support import guild_settings
from core.game.game import prison as prison_core
from core.general.role_shop import role_shop as shop_core
from core.general.items.items import JST
from core.support.storage import KVStore
from cogs import general as wallet_module

T0 = datetime(2026, 11, 6, 12, 0, tzinfo=JST)
GID = 555


class _Role:
    def __init__(self, role_id, name, position):
        self.id = role_id
        self.name = name
        self.position = position


class _Member:
    def __init__(self, user_id, *, manage_roles=False):
        self.id = user_id
        self.roles: list[_Role] = []
        self.guild_permissions = SimpleNamespace(manage_roles=manage_roles)
        self.added: list[_Role] = []
        self.removed: list[_Role] = []

    async def add_roles(self, role, reason=None):
        self.roles.append(role)
        self.added.append(role)

    async def remove_roles(self, role, reason=None):
        self.roles.remove(role)
        self.removed.append(role)


class _Guild:
    def __init__(self, guild_id=GID, *, bot_manage_roles=True, bot_top=100):
        self.id = guild_id
        self._roles: dict[int, _Role] = {}
        self._members: dict[int, _Member] = {}
        top = _Role(999, "BOT", bot_top)
        self.me = SimpleNamespace(
            guild_permissions=SimpleNamespace(manage_roles=bot_manage_roles),
            top_role=top)

    def add_role(self, role):
        self._roles[role.id] = role
        return role

    def add_member(self, member):
        self._members[member.id] = member
        return member

    def get_role(self, role_id):
        return self._roles.get(role_id)

    def get_member(self, user_id):
        return self._members.get(user_id)

    async def fetch_member(self, user_id):
        member = self._members.get(user_id)
        if member is None:
            raise ValueError("unknown member")
        return member


class _Wallet:
    def __init__(self, balances):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        # cog ロード経路によって wallet のモジュール同一性が崩れる
        # ことがあるため、センチネルは role_shop が見ている実体から引く。
        insufficient = sys.modules["core.general.role_shop.cog"].wallet_module.INSUFFICIENT
        uid = str(user_id)
        current = self.balances.get(uid)
        if current is None:
            if require_funds:
                return insufficient
            if create_with is None:
                return None
            current = create_with
        new_balance = current + delta
        if require_funds and new_balance < 0:
            return insufficient
        self.balances[uid] = new_balance
        return new_balance


class _Bot:
    def __init__(self, wallet, guild):
        self._wallet = wallet
        self._guild = guild

    def get_cog(self, name):
        return self._wallet if name == "WalletCog" else None

    def get_guild(self, guild_id):
        return self._guild if guild_id == self._guild.id else None


def _settings(tmp):
    return guild_settings.GuildSettings(
        KVStore("guild_settings", client=None,
                path=os.path.join(tmp, "kv.json")))


def _cog(tmp, wallet, guild):
    from cogs.general import RoleShopCog

    return RoleShopCog(
        _Bot(wallet, guild),
        store=shop_core.RoleShopStore(Path(tmp) / "role_shop.json"),
        settings=_settings(tmp))


class ProductHelpersTest(unittest.TestCase):
    def test_validation(self):
        with self.assertRaises(shop_core.RoleShopError):
            shop_core.with_product({}, 1, 0, 30)
        with self.assertRaises(shop_core.RoleShopError):
            shop_core.with_product({}, 1, 100, 0)
        with self.assertRaises(shop_core.RoleShopError):
            shop_core.with_product({}, 1, 100, 366)

    def test_cap_and_update(self):
        section: dict = {}
        for role_id in range(1, shop_core.MAX_ITEMS_PER_GUILD + 1):
            section = shop_core.with_product(section, role_id, 100, 30)
        with self.assertRaises(shop_core.RoleShopError):
            shop_core.with_product(section, 999, 100, 30)
        # 既存商品の更新は上限にかからない。
        section = shop_core.with_product(section, 1, 200, 7)
        self.assertEqual(shop_core.find_product(section, 1)["price"], 200)
        section = shop_core.without_product(section, 1)
        self.assertIsNone(shop_core.find_product(section, 1))
        self.assertEqual(len(shop_core.products(section)), 9)


class GrantStoreTest(unittest.TestCase):
    def test_grant_extend_expire(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = shop_core.RoleShopStore(Path(tmp) / "role_shop.json")
            until = store.grant(GID, 1, 10, 30, T0)
            self.assertEqual(until, T0 + timedelta(days=30))
            # 再購入は現在の期限から延長される。
            until = store.grant(GID, 1, 10, 30, T0 + timedelta(days=1))
            self.assertEqual(until, T0 + timedelta(days=60))
            self.assertEqual(store.expired(T0 + timedelta(days=59)), [])
            self.assertEqual(
                store.expired(T0 + timedelta(days=60)), [(GID, 1, 10)])
            self.assertIsNone(store.active_until(GID, 1, 10, T0 + timedelta(days=61)))
            self.assertEqual(store.expired(T0 + timedelta(days=61)), [])


class RegisterAndBuyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # 購入時の逮捕チェックは共有 prison ストアを見るため、他テストの
        # 状態に干渉されないよう一時ストアへ差し替える。
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.prison_store = prison_core.PrisonStore(
            Path(self._tmp.name) / "prison.json")
        original = prison_core._shared_store
        prison_core._shared_store = self.prison_store
        self.addCleanup(
            setattr, prison_core, "_shared_store", original)

    async def test_register_checks_bot_power(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild(bot_manage_roles=False)
            role = guild.add_role(_Role(10, "VIP", 5))
            cog = _cog(tmp, _Wallet({}), guild)
            message = await cog.register_product(guild, role, 1000, 30)
            self.assertIn("権限がありません", message)

    async def test_register_checks_hierarchy(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild(bot_top=100)
            role = guild.add_role(_Role(10, "VIP", 150))
            cog = _cog(tmp, _Wallet({}), guild)
            message = await cog.register_product(guild, role, 1000, 30)
            self.assertIn("扱えません", message)

    async def test_register_and_buy_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild()
            role = guild.add_role(_Role(10, "VIP", 5))
            member = guild.add_member(_Member(1))
            wallet = _Wallet({"1": 5000})
            cog = _cog(tmp, wallet, guild)
            message = await cog.register_product(guild, role, 1000, 30)
            self.assertIn("登録しました", message)
            snapshot = await cog.snapshot(guild, 1)
            self.assertEqual(len(snapshot["products"]), 1)

            message = await cog.buy(guild, member, 10, now=T0)
            self.assertIn("購入しました", message)
            self.assertEqual(wallet.balances["1"], 4000)
            self.assertIn(role, member.roles)
            until = cog.store.active_until(GID, 1, 10, T0)
            self.assertEqual(until, T0 + timedelta(days=30))
            # 再購入で延長され、残高も引かれる。
            message = await cog.buy(guild, member, 10, now=T0)
            self.assertIn("購入しました", message)
            self.assertEqual(
                cog.store.active_until(GID, 1, 10, T0), T0 + timedelta(days=60))
            self.assertEqual(wallet.balances["1"], 3000)

    async def test_buy_insufficient_funds(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild()
            role = guild.add_role(_Role(10, "VIP", 5))
            member = guild.add_member(_Member(1))
            cog = _cog(tmp, _Wallet({"1": 100}), guild)
            await cog.register_product(guild, role, 1000, 30)
            message = await cog.buy(guild, member, 10, now=T0)
            self.assertIn("足りません", message)
            self.assertEqual(member.roles, [])
            self.assertIsNone(cog.store.active_until(GID, 1, 10, T0))

    async def test_buy_blocked_while_imprisoned(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild()
            role = guild.add_role(_Role(10, "VIP", 5))
            member = guild.add_member(_Member(1))
            wallet = _Wallet({"1": 5000})
            cog = _cog(tmp, wallet, guild)
            await cog.register_product(guild, role, 1000, 30)
            self.prison_store.imprison("1", minutes=30, now=T0)
            message = await cog.buy(guild, member, 10, now=T0)
            self.assertIn("逮捕中", message)
            self.assertEqual(wallet.balances["1"], 5000)
            self.assertEqual(member.roles, [])


class SweepTest(unittest.IsolatedAsyncioTestCase):
    async def test_sweep_removes_expired_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild()
            role = guild.add_role(_Role(10, "VIP", 5))
            member = guild.add_member(_Member(1))
            member.roles.append(role)
            cog = _cog(tmp, _Wallet({}), guild)
            cog.store.grant(GID, 1, 10, 30, T0)
            cog.store.grant(GID, 1, 11, 30, T0)  # 存在しないロール分も掃除される
            processed = await cog.sweep_expired(T0 + timedelta(days=31))
            self.assertEqual(processed, 2)
            self.assertEqual(member.roles, [])
            self.assertEqual(member.removed, [role])
            self.assertEqual(cog.store.expired(T0 + timedelta(days=31)), [])

    async def test_sweep_keeps_active_grants(self):
        with tempfile.TemporaryDirectory() as tmp:
            guild = _Guild()
            role = guild.add_role(_Role(10, "VIP", 5))
            member = guild.add_member(_Member(1))
            member.roles.append(role)
            cog = _cog(tmp, _Wallet({}), guild)
            cog.store.grant(GID, 1, 10, 30, T0)
            processed = await cog.sweep_expired(T0 + timedelta(days=10))
            self.assertEqual(processed, 0)
            self.assertEqual(member.roles, [role])


if __name__ == "__main__":
    unittest.main()
