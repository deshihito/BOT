"""チーム／クラン基盤 v1 のテスト（2026-11-06、残移植 Phase F）。

- 作成（名前の重複チェック・正規化）、参加・脱退・解散（リーダー権限）
- 所属は1人1クランまで
- 貢献ポイントは所属中だけ貯まり、クラン内ランキングに反映される
- 作成コストは wallet CAS で支払い、失敗時は引かれない
- 貢献フック（採掘）で実際にポイントが付く
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.game.clan import clan as clan_core
class StoreTest(unittest.TestCase):
    def _store(self, tmp):
        return clan_core.ClanStore(Path(tmp) / "clans.json")

    def test_create_join_leave_disband(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            clan = store.create("1", "アゴ騎士団")
            self.assertEqual(clan["leader"], "1")
            store.join("2", clan["id"])
            self.assertEqual(store.clan_of("2")["id"], clan["id"])
            # 1人1クランまで。
            with self.assertRaises(clan_core.ClanError):
                store.join("2", clan["id"])
            with self.assertRaises(clan_core.ClanError):
                store.create("2", "別のクラン")
            # リーダーは脱退できない。メンバーは脱退できる。
            with self.assertRaises(clan_core.ClanError):
                store.leave("1")
            store.leave("2")
            self.assertIsNone(store.clan_of("2"))
            # 解散はリーダーのみで、全員の所属が外れる。
            store.join("3", clan["id"])
            with self.assertRaises(clan_core.ClanError):
                store.disband("3")
            store.disband("1")
            self.assertIsNone(store.clan_of("1"))
            self.assertIsNone(store.clan_of("3"))
            self.assertEqual(store.list_clans(), [])

    def test_duplicate_name_rejected_with_normalization(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "Ago Clan")
            with self.assertRaises(clan_core.ClanError):
                store.create("2", "ＡＧＯ　ＣＬＡＮ")  # 全角・空白も正規化される
            with self.assertRaises(clan_core.ClanError):
                store.create("2", "x" * (clan_core.MAX_NAME_LENGTH + 1))

    def test_points_and_ranking(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            clan = store.create("1", "ポイント団")
            store.join("2", clan["id"])
            # 未所属には付かない。
            self.assertEqual(store.add_points("9", 100), 0)
            store.add_points("1", 30)
            store.add_points("2", 50)
            members = store.members(clan["id"])
            self.assertEqual([m["user_id"] for m in members], ["2", "1"])
            self.assertEqual(store.get(clan["id"])["total_points"], 80)
            store.flush()
            reloaded = clan_core.ClanStore(Path(tmp) / "clans.json")
            self.assertEqual(reloaded.clan_of("2")["total_points"], 80)


class _Wallet:
    def __init__(self, balances):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        insufficient = sys.modules["core.game.clan.cog"].wallet_module.INSUFFICIENT
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
    def __init__(self, wallet):
        self._wallet = wallet

    def get_cog(self, name):
        return self._wallet if name == "WalletCog" else None


class CogTest(unittest.TestCase):
    def _cog(self, tmp, wallet):
        from cogs.game import ClanCog

        return ClanCog(
            _Bot(wallet),
            store=clan_core.ClanStore(Path(tmp) / "clans.json"))

    def test_create_charges_cost(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 20000})
            cog = self._cog(tmp, wallet)
            message = asyncio.run(cog.create_clan(1, "出発団"))
            self.assertIn("作りました", message)
            self.assertEqual(
                wallet.balances["1"], 20000 - clan_core.CREATE_COST)
            # 二重作成は追加で引かれない。
            message = asyncio.run(cog.create_clan(1, "二つ目"))
            self.assertIn("すでに", message)
            self.assertEqual(
                wallet.balances["1"], 20000 - clan_core.CREATE_COST)

    def test_create_insufficient_funds(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 100})
            cog = self._cog(tmp, wallet)
            message = asyncio.run(cog.create_clan(1, "貧乏団"))
            self.assertIn("足りません", message)
            self.assertEqual(cog.store.list_clans(), [])

    def test_create_duplicate_name_no_charge(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 20000, "2": 20000})
            cog = self._cog(tmp, wallet)
            asyncio.run(cog.create_clan(1, "唯一団"))
            message = asyncio.run(cog.create_clan(2, "唯一団"))
            self.assertIn("すでにあります", message)
            self.assertEqual(wallet.balances["2"], 20000)


class ContributionHookTest(unittest.TestCase):
    def test_award_points_via_shared_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = clan_core.ClanStore(Path(tmp) / "clans.json")
            clan = store.create("1", "貢献団")
            original = clan_core._shared_store
            clan_core._shared_store = store
            try:
                clan_core.award_points("1", clan_core.POINTS_MINING)
                clan_core.award_points("9", clan_core.POINTS_MINING)  # 未所属は無視
            finally:
                clan_core._shared_store = original
            self.assertEqual(store.members(clan["id"])[0]["points"],
                             clan_core.POINTS_MINING)


if __name__ == "__main__":
    unittest.main()
