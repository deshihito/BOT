"""編成ガチャ＋キャラ収集のテスト（2026-11-06、残移植 Phase E）。

- キャストは人狼の HELP_ROLES 全30役職（名前・陣営・説明が一致）
- 抽選: 段階の重みで引け、10連は R 以上が1体確定
- かぶりはコインに自動変換され、所持数は増えない
- コレクションと編成（最大3体・所持のみ）の永続化
- 支払いは wallet CAS、残高不足は引けない、逮捕中は引けない
"""
from __future__ import annotations

import asyncio
import random
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.game import gacha as gacha_core
from core.game import prison as prison_core
from cogs import wallet as wallet_module


class CastTest(unittest.TestCase):
    def test_cast_matches_jinrou_help_roles(self):
        from core.game.jinrou.common import HELP_ROLES

        help_by_id = {row[4]: row for row in HELP_ROLES}
        self.assertEqual(len(gacha_core.CHARACTERS), 30)
        self.assertEqual(
            {c["id"] for c in gacha_core.CHARACTERS}, set(help_by_id))
        for character in gacha_core.CHARACTERS:
            row = help_by_id[character["id"]]
            self.assertEqual(character["name"], row[0], character["id"])
            self.assertEqual(character["faction"], row[1], character["id"])
            self.assertEqual(character["desc"], row[2], character["id"])
            self.assertIn(character["rarity"], gacha_core.RARITY_ORDER)

    def test_rarity_tiers_populated(self):
        counts = {
            rarity: len([c for c in gacha_core.CHARACTERS
                         if c["rarity"] == rarity])
            for rarity in gacha_core.RARITY_ORDER
        }
        self.assertEqual(counts, {"N": 8, "R": 10, "SR": 8, "SSR": 4})

    def test_key_characters_have_app_emoji(self):
        for char_id in ("werewolf", "seer", "medium", "knight", "madman"):
            self.assertTrue(
                gacha_core.CHARACTER_BY_ID[char_id]["emoji"], char_id)


class RollTest(unittest.TestCase):
    def test_ten_pull_guarantees_rare_or_better(self):
        for seed in range(50):
            rng = random.Random(seed)
            rolls = gacha_core.roll_characters(rng, gacha_core.TEN_COUNT)
            self.assertEqual(len(rolls), 10)
            self.assertTrue(
                any(c["rarity"] != "N" for c in rolls), f"seed={seed}")

    def test_single_pull_returns_one(self):
        rolls = gacha_core.roll_characters(random.Random(1), 1)
        self.assertEqual(len(rolls), 1)


class StoreTest(unittest.TestCase):
    def test_collection_and_party(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gacha.json"
            store = gacha_core.GachaStore(path)
            store.add("1", "werewolf")
            store.add("1", "werewolf")
            store.add("1", "seer")
            self.assertEqual(store.count_of("1", "werewolf"), 2)
            self.assertEqual(store.set_party("1", ["werewolf", "seer"]),
                             ["werewolf", "seer"])
            with self.assertRaises(ValueError):
                store.set_party("1", ["knight"])  # 未所持
            with self.assertRaises(ValueError):
                store.set_party("1", ["werewolf", "werewolf"])  # 重複
            store.record_pulls("1", 10)
            store.flush()
            reloaded = gacha_core.GachaStore(path)
            self.assertEqual(reloaded.owned("1"), {"werewolf": 2, "seer": 1})
            self.assertEqual(reloaded.party("1"), ["werewolf", "seer"])
            self.assertEqual(reloaded.total_pulls("1"), 10)


class _Wallet:
    def __init__(self, balances):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        insufficient = sys.modules["cogs.gacha"].wallet_module.INSUFFICIENT
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


class _FixedRandom(random.Random):
    """choices/choice を固定キャラに寄せる抽選スタブ。"""

    def __init__(self, char_id):
        super().__init__(0)
        self._char = gacha_core.CHARACTER_BY_ID[char_id]

    def choices(self, population, weights=None, k=1):
        return [self._char["rarity"]] * k

    def choice(self, seq):
        return self._char


class PullTest(unittest.TestCase):
    def _cog(self, tmp, wallet, rng):
        from cogs.gacha import GachaCog

        return GachaCog(
            _Bot(wallet),
            store=gacha_core.GachaStore(Path(tmp) / "gacha.json"),
            rng=rng)

    def test_pull_new_character(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, _FixedRandom("seer"))
            message = asyncio.run(cog.execute_pull(1, 1))
            self.assertIn("NEW!", message)
            self.assertEqual(cog.store.count_of("1", "seer"), 1)
            self.assertEqual(
                wallet.balances["1"], 10000 - gacha_core.SINGLE_PRICE)

    def test_duplicate_converts_to_coins(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, _FixedRandom("seer"))
            asyncio.run(cog.execute_pull(1, 1))
            message = asyncio.run(cog.execute_pull(1, 1))
            self.assertIn("かぶり", message)
            self.assertEqual(cog.store.count_of("1", "seer"), 1)
            self.assertEqual(
                wallet.balances["1"],
                10000 - 2 * gacha_core.SINGLE_PRICE
                + gacha_core.DUPLICATE_COINS["R"])

    def test_insufficient_funds(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 100})
            cog = self._cog(tmp, wallet, _FixedRandom("seer"))
            message = asyncio.run(cog.execute_pull(1, 1))
            self.assertIn("足りません", message)
            self.assertEqual(cog.store.owned("1"), {})

    def test_ten_pull_price_and_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, random.Random(42))
            message = asyncio.run(cog.execute_pull(1, gacha_core.TEN_COUNT))
            self.assertEqual(cog.store.total_pulls("1"), 10)
            owned_total = sum(cog.store.owned("1").values())
            dup_lines = message.count("かぶり")
            self.assertEqual(owned_total + dup_lines, 10)

    def test_pull_blocked_while_imprisoned(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, _FixedRandom("seer"))
            shared = prison_core.PrisonStore(Path(tmp) / "prison.json")
            shared.imprison("1", minutes=30)
            original = prison_core._shared_store
            prison_core._shared_store = shared
            try:
                message = asyncio.run(cog.execute_pull(1, 1))
            finally:
                prison_core._shared_store = original
            self.assertIn("逮捕中", message)
            self.assertEqual(wallet.balances["1"], 10000)


if __name__ == "__main__":
    unittest.main()
