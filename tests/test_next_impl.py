# -*- coding: utf-8 -*-
"""次期仕様 S0〜S6（2026-11-06）の固定テスト。

見るもの:
- S0: 分布計算の純関数と確定式の候補値（読み取り専用ツールの核）
- S1: 国庫の週次還流（ゼロサム・二重還流なし）と宝くじブースト
- S2: クランレベルの導出・定員・累計貢献（脱退で減らない）・実績
- S3: 編成ボーナス（レアリティ点と採掘の追加抽選、プール払い）
- S4: マネーパネルの「次の1手」と状態行、カテゴリの役割語
- S6-1: デイリーボーナス（日次・1回だけ・宝箱抽選・巻き戻し）
- S6-2: ガチャ天井（90回で SSR 確定・リセット・残り表示）
- S6-3: bj_duel（エスクロー・勝敗・引き分け・中断の双方返金）
- S6-4: 効果アイテム5種（お祓い棒・悪魔的な報酬・落盤対策・
  直下掘り・プリズンマイナー）
- S6-5: クラン拡張（招待コード・改名・追放/脱退 CD・クランボーナス）
- S6-6: 総合資産ランキングの合算
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.general import action_registry
from core.game.clan import clan as clan_core
from core.game.gacha import gacha as gacha_core
from core.general.money_panel import daily_bonus as daily_core, starter as starter_core
from core.game import lottery as lottery_core
from core.game.gambling import gambling as gambling_core
from core.game import mining as mining_core
from core.game.game import prison as prison_core
from core.general.circulation import economy_pool as economy_core
from core.general.items import items as items_core
from core.general.wallet.cog import compute_asset_ranking
from cogs import general as wallet_module
from cogs.general import CirculationCog
from cogs.game import ClanCog
from cogs.game import collection_embed
from cogs.game import GamblingCog
from cogs.general import CATEGORIES, MoneyPanelCog, status_embed
from tools import coin_distribution

T0 = datetime(2026, 1, 1, 9, 0, tzinfo=items_core.JST)


class _StubRng:
    """randint/random/uniform/choice/choices を決め打ちする rng スタブ。"""

    def __init__(self, ints=(), floats=(), uniform_value=None):
        self._ints = list(ints)
        self._floats = list(floats)
        self._uniform_value = uniform_value

    def randint(self, a, b):
        return self._ints.pop(0) if self._ints else a

    def random(self):
        return self._floats.pop(0) if self._floats else 0.99

    def uniform(self, a, b):
        return self._uniform_value if self._uniform_value is not None else a

    def choice(self, seq):
        return seq[0]

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        return [population[0]] * k


class _FakeWallet:
    def __init__(self, balances=None, fail_credit=False):
        self.balances = dict(balances or {})
        self.fail_credit = fail_credit

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        if delta > 0 and self.fail_credit:
            return None
        if user_id not in self.balances:
            if create_with is None:
                return None
            self.balances[user_id] = create_with
        if require_funds and self.balances[user_id] + delta < 0:
            return wallet_module.INSUFFICIENT
        self.balances[user_id] += delta
        return self.balances[user_id]


class _FakeBot:
    def __init__(self, cogs=None):
        self._cogs = dict(cogs or {})

    def get_cog(self, name):
        return self._cogs.get(name)


def _circulation_cog(tmp, wallet, bot_cogs=None, **stores):
    bot = _FakeBot({"WalletCog": wallet, **(bot_cogs or {})})
    cog = CirculationCog(
        bot,
        mining_store=stores.get("mining_store") or mining_core.MiningStore(
            Path(tmp) / "mining.json", rng=stores.get("mining_rng", random.Random(42))),
        lottery_store=stores.get("lottery_store") or lottery_core.LotteryStore(
            Path(tmp) / "lottery.json", rng=random.Random(42)),
        item_store=stores.get("item_store") or items_core.ItemStore(
            Path(tmp) / "items.json", rng=random.Random(42)),
        balance_reader=lambda uid: wallet.balances.get(uid, 0),
        economy_store=stores.get("economy_store") or economy_core.EconomyPoolStore(
            Path(tmp) / "economy.json"),
        prison_store=stores.get("prison_store") or prison_core.PrisonStore(
            Path(tmp) / "prison.json"),
    )
    return cog


# ---------------------------------------------------------------------------
# S0
# ---------------------------------------------------------------------------

class CoinDistributionTest(unittest.TestCase):
    def test_compute_distribution(self):
        dist = coin_distribution.compute_distribution(
            [0, 0, 100, 200, 300, 400, 500, 600, 700, 10_000])
        self.assertEqual(dist["users"], 10)
        self.assertEqual(dist["total"], 12_800)
        self.assertAlmostEqual(dist["zero_ratio"], 0.2)
        self.assertEqual(dist["median"], 300)
        self.assertEqual(dist["p90"], 700)
        self.assertEqual(dist["max"], 10_000)
        self.assertAlmostEqual(dist["top10_share"], 1.0)

    def test_compute_distribution_empty(self):
        dist = coin_distribution.compute_distribution([])
        self.assertEqual(dist["users"], 0)
        self.assertEqual(dist["total"], 0)
        self.assertEqual(dist["max"], 0)

    def test_suggest_constants_follows_formulas(self):
        dist = coin_distribution.compute_distribution([100] * 90 + [50_000] * 10)
        suggestions = coin_distribution.suggest_constants(dist, 3)
        # 総残高 509,000 → 10% は 50,900 で上限 1,000,000 より小さい。
        self.assertEqual(suggestions["pool_seed_ago_cap"], 50_900)
        self.assertEqual(suggestions["starter_coins_guide"], 4_400)
        low, high = suggestions["clan_create_cost_range"]
        self.assertEqual(low, int(dist["p90"] * 0.20))
        self.assertEqual(high, int(dist["p90"] * 0.30))

    def test_token_balances_read_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "market.json"
            path.write_text(json.dumps(
                {"balances": {"1": 12.5, "2": 0, "3": "x"}}), encoding="utf-8")
            self.assertEqual(
                coin_distribution.fetch_token_balances(path), {"1": 12.5})
            self.assertEqual(
                coin_distribution.fetch_token_balances(Path(tmp) / "none.json"),
                {})


# ---------------------------------------------------------------------------
# S1
# ---------------------------------------------------------------------------

class TreasuryOutletTest(unittest.TestCase):
    def _store(self, tmp):
        return economy_core.EconomyPoolStore(Path(tmp) / "economy.json")

    def test_first_call_only_initializes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_loss(100_000)  # 国庫 30,000
            self.assertEqual(store.maybe_weekly_release(T0), 0)
            self.assertEqual(store.treasury_balance(), 30_000)
            self.assertEqual(store.pool_balance(), 70_000)

    def test_weekly_release_is_zero_sum_and_not_doubled(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_loss(100_000)
            store.maybe_weekly_release(T0)
            released = store.maybe_weekly_release(T0 + timedelta(days=7))
            self.assertEqual(released, 6_000)  # 国庫 30,000 の 20%
            self.assertEqual(store.treasury_balance(), 24_000)
            self.assertEqual(store.pool_balance(), 76_000)
            self.assertEqual(store.snapshot()["total_released"], 6_000)
            # 同じ週に2回は走らない。
            self.assertEqual(
                store.maybe_weekly_release(T0 + timedelta(days=8)), 0)
            self.assertEqual(store.treasury_balance(), 24_000)

    def test_release_state_survives_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_loss(100_000)
            store.maybe_weekly_release(T0)
            store.flush()
            loaded = self._store(tmp)
            self.assertEqual(
                loaded.snapshot()["last_release_date"], "2026-01-01")
            self.assertEqual(
                loaded.maybe_weekly_release(T0 + timedelta(days=3)), 0)

    def test_lottery_boost_threshold_and_take(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.add_loss(100_000)  # 国庫 30,000（閾値未満）
            self.assertEqual(store.lottery_boost_amount(T0), 0)
            self.assertEqual(store.take_lottery_boost(), 0)
            # 国庫を閾値超えまで積む: 追加の損失 2,000,000 → 国庫 +600,000。
            store.add_loss(2_000_000)
            self.assertEqual(store.treasury_balance(), 630_000)
            boost = store.lottery_boost_amount(T0)
            self.assertEqual(boost, 65_000)  # 超過 130,000 の 50%
            self.assertEqual(store.treasury_balance(), 565_000)
            self.assertEqual(store.take_lottery_boost(), 65_000)
            self.assertEqual(store.take_lottery_boost(), 0)
            self.assertEqual(store.snapshot()["total_boosted"], 65_000)

    def test_lottery_add_to_pool_records_boost(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = lottery_core.LotteryStore(
                Path(tmp) / "lottery.json", rng=random.Random(1))
            pool = store.add_to_pool(5_000, now=T0)
            self.assertEqual(pool, 5_000)
            current = store.current_round(T0)
            self.assertEqual(current["pool"], 5_000)
            self.assertEqual(current["boost"], 5_000)
            self.assertEqual(store.add_to_pool(0, now=T0), 0)

    def test_circulation_applies_outlets_on_settle(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog = _circulation_cog(tmp, wallet)
            cog.economy_store.add_loss(2_000_000)  # 国庫 600,000
            cog.economy_store.maybe_weekly_release(T0)  # 基準日だけ記録
            asyncio.run(cog.settle_lottery(now=T0 + timedelta(days=1)))
            # 週次還流はまだ（7日未経過）。ブースト 50,000 が宝くじへ。
            current = cog.lottery_store.current_round(T0 + timedelta(days=1))
            self.assertEqual(current["boost"], 50_000)
            self.assertEqual(cog.economy_store.treasury_balance(), 550_000)


# ---------------------------------------------------------------------------
# S2 + S6-5（クラン）
# ---------------------------------------------------------------------------

class ClanLevelTest(unittest.TestCase):
    def test_level_table(self):
        self.assertEqual(clan_core.level_for(0), 1)
        self.assertEqual(clan_core.level_for(499), 1)
        self.assertEqual(clan_core.level_for(500), 2)
        self.assertEqual(clan_core.level_for(2_000), 3)
        self.assertEqual(clan_core.level_for(5_000), 4)
        self.assertEqual(clan_core.level_for(12_000), 5)
        self.assertEqual(clan_core.member_cap_for(0), 10)
        self.assertEqual(clan_core.member_cap_for(12_000), 50)
        self.assertIsNone(clan_core.next_level_requirement(12_000))
        self.assertEqual(clan_core.next_level_requirement(0), 500)

    def _store(self, tmp):
        return clan_core.ClanStore(Path(tmp) / "clans.json")

    def test_cumulative_points_survive_leave(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "テスト", now=T0)
            store.join("2", "1", now=T0)
            store.add_points("2", 600, "mining")
            clan = store.get("1")
            self.assertEqual(clan["total_points"], 600)
            self.assertEqual(clan["level"], 2)
            self.assertEqual(clan["stats"]["mining"], 1)
            store.leave("2", now=T0)
            clan = store.get("1")
            # 累計は減らない（レベルも落ちない）。
            self.assertEqual(clan["total_points"], 600)
            self.assertEqual(clan["level"], 2)

    def test_member_cap_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "テスト", now=T0)
            for uid in range(2, 11):  # リーダー＋9人で定員10
                store.join(str(uid), "1", now=T0)
            with self.assertRaises(clan_core.ClanError):
                store.join("11", "1", now=T0)

    def test_level_up_pending_and_mark(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "テスト", now=T0)
            self.assertIsNone(store.pending_level_up("1"))
            store.add_points("1", 500)
            self.assertEqual(store.pending_level_up("1"), 2)
            store.mark_level_announced("1")
            self.assertIsNone(store.pending_level_up("1"))

    def test_invite_code_flow(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            clan = store.create("1", "テスト", now=T0)
            code = clan["invite_code"]
            self.assertTrue(code)
            joined = store.join_by_code("2", code, now=T0)
            self.assertEqual(joined["id"], "1")
            with self.assertRaises(clan_core.ClanError):
                store.join_by_code("3", "WRONG-CODE", now=T0)
            new_code = store.regenerate_invite_code("1")
            self.assertNotEqual(new_code, code)
            with self.assertRaises(clan_core.ClanError):
                store.join_by_code("3", code, now=T0)
            store.join_by_code("3", new_code, now=T0)

    def test_rename_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "テスト", now=T0)
            store.create("9", "別クラン", now=T0)
            store.join("2", "1", now=T0)
            with self.assertRaises(clan_core.ClanError):
                store.rename("2", "新名前")  # リーダー以外は不可
            with self.assertRaises(clan_core.ClanError):
                store.rename("1", "別クラン")  # 重複不可
            renamed = store.rename("1", "テスト")  # 自分の名前は可
            self.assertEqual(renamed["name"], "テスト")
            renamed = store.rename("1", "新テスト")
            self.assertEqual(renamed["name"], "新テスト")

    def test_rejoin_cooldowns(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store.create("1", "テスト", now=T0)
            store.create("9", "別クラン", now=T0)
            store.join("2", "1", now=T0)
            store.join("3", "1", now=T0)
            # 追放: 3日は再参加不可。
            store.kick("1", "2", now=T0)
            with self.assertRaises(clan_core.ClanError):
                store.join("2", "2", now=T0 + timedelta(days=2))
            store.join("2", "2", now=T0 + timedelta(days=3))
            # 脱退: 5日は再参加不可。
            store.leave("3", now=T0)
            with self.assertRaises(clan_core.ClanError):
                store.join("3", "2", now=T0 + timedelta(days=4))
            store.join("3", "2", now=T0 + timedelta(days=5))

    def test_bonus_claim_once_per_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            self.assertTrue(store.try_claim_bonus("1", now=T0))
            self.assertFalse(store.try_claim_bonus("1", now=T0))
            self.assertTrue(
                store.try_claim_bonus("1", now=T0 + timedelta(days=1)))
            store.unclaim_bonus("1")
            self.assertTrue(
                store.try_claim_bonus("1", now=T0 + timedelta(days=1)))


class ClanBonusCogTest(unittest.TestCase):
    def test_claim_clan_bonus_grants_box_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = clan_core.ClanStore(Path(tmp) / "clans.json")
            store.create("1", "テスト", now=T0)
            item_store = items_core.ItemStore(Path(tmp) / "items.json")
            bot = _FakeBot({"ItemsCog": SimpleNamespace(store=item_store)})
            cog = ClanCog(bot, store=store)
            message = asyncio.run(cog.claim_clan_bonus(1))
            self.assertIn("宝箱×1", message)
            self.assertEqual(item_store.count("1", "treasure_box"), 1)
            message = asyncio.run(cog.claim_clan_bonus(1))
            self.assertIn("受け取り済み", message)
            self.assertEqual(item_store.count("1", "treasure_box"), 1)


# ---------------------------------------------------------------------------
# S3（編成ボーナス）
# ---------------------------------------------------------------------------

class PartyBonusTest(unittest.TestCase):
    def test_party_power_of(self):
        ssr = [c["id"] for c in gacha_core.CHARACTERS if c["rarity"] == "SSR"]
        normal = [c["id"] for c in gacha_core.CHARACTERS if c["rarity"] == "N"]
        self.assertEqual(gacha_core.party_power_of(ssr[:3]), 12)
        self.assertEqual(gacha_core.party_power_of(normal[:2]), 2)
        self.assertEqual(gacha_core.party_power_of([]), 0)
        self.assertEqual(gacha_core.party_power_of(["not-a-character"]), 0)

    def _gacha_store(self, tmp, rarities):
        store = gacha_core.GachaStore(Path(tmp) / "gacha.json")
        pools = {
            rarity: [c["id"] for c in gacha_core.CHARACTERS
                     if c["rarity"] == rarity]
            for rarity in set(rarities)
        }
        party = []
        for rarity in rarities:
            char_id = pools[rarity].pop(0)
            store.add("1", char_id)
            party.append(char_id)
        store.set_party("1", party)
        return store

    def test_mining_party_bonus_pays_from_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            gacha_store = self._gacha_store(tmp, ["SSR", "SSR", "SSR"])
            bot_cogs = {"GachaCog": SimpleNamespace(store=gacha_store)}
            cog = _circulation_cog(
                tmp, wallet, bot_cogs,
                mining_rng=_StubRng(ints=[5, 300, 200], floats=[0.99] * 4))
            cog._rng = _StubRng(floats=[0.1])  # 12点×2%=24% に当選
            cog.economy_store.add_loss(100_000)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("編成ボーナスで追加でもう1回掘れた", message)
            # 本掘り300＋追加200がプールから払われている。
            self.assertEqual(
                wallet.balances["1"], wallet_module.NEW_USER_BALANCE + 500)
            self.assertEqual(cog.economy_store.pool_balance(), 70_000 - 500)

    def test_mining_without_party_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog = _circulation_cog(
                tmp, wallet, {},
                mining_rng=_StubRng(ints=[5, 300], floats=[0.99, 0.99]))
            cog.economy_store.add_loss(100_000)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertNotIn("編成ボーナス", message)
            self.assertEqual(
                wallet.balances["1"], wallet_module.NEW_USER_BALANCE + 300)


# ---------------------------------------------------------------------------
# S6-1（デイリーボーナス）
# ---------------------------------------------------------------------------

class DailyBonusTest(unittest.TestCase):
    def test_store_claim_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = daily_core.DailyBonusStore(Path(tmp) / "daily.json")
            self.assertFalse(store.claimed_today("1", T0))
            self.assertTrue(store.try_claim("1", now=T0))
            self.assertTrue(store.claimed_today("1", T0))
            self.assertFalse(store.try_claim("1", now=T0))
            self.assertTrue(store.try_claim("1", now=T0 + timedelta(days=1)))
            store.unclaim("1")
            self.assertTrue(store.try_claim("1", now=T0 + timedelta(days=1)))

    def _panel_cog(self, tmp, wallet, *, rng=None, prison_store=None):
        item_store = items_core.ItemStore(Path(tmp) / "items.json")
        cogs = {"WalletCog": wallet,
                "ItemsCog": SimpleNamespace(store=item_store)}
        if prison_store is not None:
            cogs["CirculationCog"] = SimpleNamespace(
                prison_store=prison_store)
        bot = _FakeBot(cogs)
        cog = MoneyPanelCog(
            bot,
            balance_reader=lambda uid: wallet.balances.get(uid, 0),
            starter_store=starter_core.StarterStore(Path(tmp) / "starter.json"),
            daily_store=daily_core.DailyBonusStore(Path(tmp) / "daily.json"),
            rng=rng or _StubRng(floats=[0.99]))
        return cog, item_store

    def test_claim_grants_coins_and_box_by_chance(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100})
            cog, item_store = self._panel_cog(
                tmp, wallet, rng=_StubRng(floats=[0.1]))  # 宝箱に当選
            message = asyncio.run(cog.claim_daily_bonus(1))
            self.assertIn(f"{daily_core.DAILY_BONUS_COINS:,} AGO", message)
            self.assertIn("宝箱×1", message)
            self.assertEqual(wallet.balances["1"], 100 + daily_core.DAILY_BONUS_COINS)
            self.assertEqual(item_store.count("1", "treasure_box"), 1)
            message = asyncio.run(cog.claim_daily_bonus(1))
            self.assertIn("受け取り済み", message)
            self.assertEqual(wallet.balances["1"], 100 + daily_core.DAILY_BONUS_COINS)

    def test_claim_blocked_while_imprisoned(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100})
            prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            prison_store.imprison("1", minutes=30)
            cog, _items = self._panel_cog(
                tmp, wallet, prison_store=prison_store)
            message = asyncio.run(cog.claim_daily_bonus(1))
            self.assertIn("逮捕", message)
            self.assertEqual(wallet.balances["1"], 100)


# ---------------------------------------------------------------------------
# S6-2（ガチャ天井）
# ---------------------------------------------------------------------------

class _GachaStubRng:
    """rarity を固定して返す rng（_BY_RARITY の先頭キャラを返す）。"""

    def __init__(self, rarity="N"):
        self.rarity = rarity

    def choices(self, population, weights=None, *, cum_weights=None, k=1):
        return [self.rarity] * k

    def choice(self, seq):
        return seq[0]


class PityTest(unittest.TestCase):
    def test_pity_forces_ssr_at_limit(self):
        rolls, pity = gacha_core.roll_pulls(
            _GachaStubRng("N"), 1, gacha_core.PITY_LIMIT - 1)
        self.assertEqual(rolls[0]["rarity"], "SSR")
        self.assertEqual(pity, 0)

    def test_pity_counts_up_without_ssr(self):
        _rolls, pity = gacha_core.roll_pulls(_GachaStubRng("N"), 10, 0)
        self.assertEqual(pity, 10)
        _rolls, pity = gacha_core.roll_pulls(_GachaStubRng("N"), 10, 85)
        # 90回目で天井が発動してリセットされる。
        self.assertEqual(pity, 5)

    def test_natural_ssr_resets_pity(self):
        rolls, pity = gacha_core.roll_pulls(_GachaStubRng("SSR"), 3, 40)
        self.assertTrue(all(r["rarity"] == "SSR" for r in rolls))
        self.assertEqual(pity, 0)  # SSR が出るたびにリセットされる

    def test_store_pity_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gacha.json"
            store = gacha_core.GachaStore(path)
            store.set_pity("1", 42)
            store.flush()
            loaded = gacha_core.GachaStore(path)
            self.assertEqual(loaded.pity("1"), 42)

    def test_collection_shows_pity_remaining(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gacha_core.GachaStore(Path(tmp) / "gacha.json")
            store.set_pity("1", 1)
            cog = SimpleNamespace(store=store)
            embed = collection_embed(cog, 1)
            self.assertIn("天井まで あと89回", embed.description or "")


# ---------------------------------------------------------------------------
# S6-3（bj_duel）
# ---------------------------------------------------------------------------

class DuelCoreTest(unittest.TestCase):
    def _store(self, tmp, rng=None):
        return gambling_core.GamblingStore(
            Path(tmp) / "gambling.json", rng=rng or _StubRng())

    def test_min_bet_and_self_join_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            with self.assertRaises(items_core.ItemError):
                store.create_duel("1", gambling_core.DUEL_MIN_BET - 1)
            store.create_duel("1", 500)
            with self.assertRaises(items_core.ItemError):
                store.join_duel("1", "1")

    def test_stand_off_picks_higher_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            # 配札: creator 10,9=19 / challenger 10,6=16。
            store = self._store(tmp, rng=_StubRng())
            store._rng = _CardRng([10, 9, 10, 6])
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            self.assertFalse(store.duel_stand("1")["finished"])
            result = store.duel_stand("2")
            self.assertTrue(result["finished"])
            self.assertEqual(result["winner"], "1")
            self.assertIsNone(store.duel_of("1"))

    def test_bust_loses_immediately(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store._rng = _CardRng([10, 9, 10, 6, 5])
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            result = store.duel_hit("1")  # 19+5=24 バースト
            self.assertTrue(result["finished"])
            self.assertEqual(result["winner"], "2")
            self.assertEqual(result["bust"], "1")

    def test_draw_when_totals_equal(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store._rng = _CardRng([10, 8, 9, 9])
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            store.duel_stand("1")
            result = store.duel_stand("2")
            self.assertTrue(result["draw"])
            self.assertIsNone(result["winner"])

    def test_cancel_and_orphan_refunds_cover_both_sides(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            store._rng = _CardRng([10, 9, 10, 6])
            store.create_duel("1", 500)
            result = store.cancel_duel("1")
            self.assertEqual(
                result["refunds"], [{"user_id": "1", "amount": 500}])
            store.create_duel("1", 500)
            store.join_duel("1", "2")
            refunds = store.orphaned_refunds()
            duel_refunds = [r for r in refunds if r["kind"] == "bj_duel"]
            self.assertEqual(
                sorted(r["user_id"] for r in duel_refunds), ["1", "2"])
            self.assertTrue(all(r["amount"] == 500 for r in duel_refunds))


class _CardRng(_StubRng):
    """choice でカード列を決め打ちする rng。"""

    def __init__(self, cards):
        super().__init__()
        self._cards = list(cards)

    def choice(self, seq):
        return self._cards.pop(0) if self._cards else seq[0]


class DuelCogTest(unittest.TestCase):
    def _cog(self, tmp, wallet, cards):
        store = gambling_core.GamblingStore(
            Path(tmp) / "gambling.json", rng=_CardRng(cards))
        economy = economy_core.EconomyPoolStore(Path(tmp) / "economy.json")
        bot = _FakeBot({"WalletCog": wallet})
        cog = GamblingCog(bot, store=store,
                          balance_reader=lambda uid: wallet.balances.get(uid, 0),
                          economy_store=economy)
        return cog

    def test_full_flow_winner_takes_pot(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog = self._cog(tmp, wallet, [10, 9, 10, 6])
            message = asyncio.run(cog.execute_duel_create(1, 500))
            self.assertIn("対決を作成", message)
            self.assertEqual(wallet.balances["1"], 9_500)
            message = asyncio.run(cog.execute_duel_join(2, "1"))
            self.assertIn("対決開始", message)
            self.assertEqual(wallet.balances["2"], 9_500)
            asyncio.run(cog.execute_duel_stand(1))
            message = asyncio.run(cog.execute_duel_stand(2))
            self.assertIn("勝ち", message)
            # 勝者はポット 1,000 を総取り（手数料なし）。
            self.assertEqual(wallet.balances["1"], 10_500)
            self.assertEqual(wallet.balances["2"], 9_500)

    def test_draw_refunds_both(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000, "2": 10_000})
            cog = self._cog(tmp, wallet, [10, 8, 9, 9])
            asyncio.run(cog.execute_duel_create(1, 500))
            asyncio.run(cog.execute_duel_join(2, "1"))
            asyncio.run(cog.execute_duel_stand(1))
            message = asyncio.run(cog.execute_duel_stand(2))
            self.assertIn("引き分け", message)
            self.assertEqual(wallet.balances["1"], 10_000)
            self.assertEqual(wallet.balances["2"], 10_000)

    def test_cancel_refunds_creator(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10_000})
            cog = self._cog(tmp, wallet, [])
            asyncio.run(cog.execute_duel_create(1, 500))
            message = asyncio.run(cog.cancel_duel_for(1))
            self.assertIn("返金", message)
            self.assertEqual(wallet.balances["1"], 10_000)


# ---------------------------------------------------------------------------
# S6-4（効果アイテム5種）
# ---------------------------------------------------------------------------

class NewItemsTest(unittest.TestCase):
    def test_definitions_and_handlers(self):
        for item_id, price in (("oharai_bou", 2000), ("devil_reward", 5000),
                               ("anti_cavein", 1500), ("direct_dig", 2000),
                               ("prison_miner", 3000)):
            self.assertIn(item_id, items_core.ITEM_DEFS)
            self.assertEqual(items_core.ITEM_DEFS[item_id]["price"], price)
        for effect in (items_core.SIX_SUPPRESS_EFFECT,
                       items_core.MINING_NO_FAIL_EFFECT,
                       items_core.DIRECT_DIG_EFFECT):
            self.assertIn(effect, items_core.EFFECT_HANDLERS)
        self.assertLess(
            items_core.box_expected_value(), items_core.BOX_PRICE)

    def test_six_suppression_halves_weight(self):
        weights = gambling_core._reel_weights(False)
        suppressed = gambling_core._reel_weights(
            False, six_suppressed=True,
            six_multiplier=items_core.SIX_SUPPRESS_MULTIPLIER)
        self.assertEqual(suppressed[6], weights[6] // 2)
        self.assertEqual(suppressed[7], weights[7])

    def test_slot_spin_accepts_suppression_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = gambling_core.GamblingStore(
                Path(tmp) / "gambling.json", rng=random.Random(7))
            store.start_slot("1", 10)
            result = store.spin_slot("1", six_suppressed=True)
            self.assertIn("reels", result)

    def test_mining_no_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining_core.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[3, 300, 300], floats=[0.0, 0.99, 0.0, 0.99]))
            store.start_session("1", now=T0)
            failed = store.dig("1", 10_000, now=T0)
            self.assertTrue(failed["failed"])
            store2 = mining_core.MiningStore(
                Path(tmp) / "mining2.json",
                rng=_StubRng(ints=[3, 300], floats=[0.0, 0.99]))
            store2.start_session("1", now=T0)
            result = store2.dig("1", 10_000, now=T0, no_fail=True)
            self.assertFalse(result["failed"])
            self.assertEqual(result["coins"], 300)

    def test_mining_direct_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = mining_core.MiningStore(
                Path(tmp) / "mining.json",
                rng=_StubRng(ints=[2, 100], floats=[0.99, 0.10],
                             uniform_value=0.10))
            store.start_session("1", now=T0, direct=True)
            self.assertTrue(store.status("1", T0)["direct"])
            result = store.dig("1", 10_000, now=T0)
            self.assertTrue(result["direct"])
            self.assertTrue(result["jackpot"])
            # 大量採掘の上乗せは 1.5 倍: 10,000 × 0.10 × 1.5 = 1,500。
            self.assertEqual(result["extra"], 1_500)
            store.dig("1", 10_000, now=T0)
            self.assertFalse(store.status("1", T0)["direct"])

    def test_prison_miner_is_the_only_prison_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            prison_store.imprison("1", minutes=30, now=T0)
            item_store = items_core.ItemStore(Path(tmp) / "items.json")
            cog = _circulation_cog(
                tmp, wallet, {},
                mining_rng=_StubRng(ints=[3, 300], floats=[0.99, 0.99]),
                item_store=item_store, prison_store=prison_store)
            cog.economy_store.add_loss(100_000)
            # 所持なしでは通常どおりブロックされる。
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("逮捕", message)
            # 所持していれば1枚消費して採掘できる。
            item_store.add("1", items_core.PRISON_MINER_ITEM, 1)
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("採掘しました", message)
            self.assertEqual(item_store.count("1", items_core.PRISON_MINER_ITEM), 0)
            # 使い切ったら再びブロックされる（例外は消費型）。
            message = asyncio.run(cog.execute_mining(1, now=T0))
            self.assertIn("逮捕", message)

    def test_devil_reward_pays_double_on_lucky_roll(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 0})
            item_store = items_core.ItemStore(Path(tmp) / "items.json")
            item_store.add("1", items_core.DEVIL_REWARD_ITEM, 1)
            economy = economy_core.EconomyPoolStore(Path(tmp) / "economy.json")
            bot = _FakeBot({"WalletCog": wallet})
            cog = GamblingCog(
                bot,
                store=gambling_core.GamblingStore(Path(tmp) / "gambling.json"),
                balance_reader=lambda uid: wallet.balances.get(uid, 0),
                item_store=item_store, economy_store=economy)
            cog._rng = _StubRng(floats=[0.9])  # 発動しない
            self.assertEqual(
                asyncio.run(cog._try_devil_reward("1", 1_000)), 0)
            self.assertEqual(item_store.count("1", items_core.DEVIL_REWARD_ITEM), 1)
            cog._rng = _StubRng(floats=[0.1])  # 発動する
            self.assertEqual(
                asyncio.run(cog._try_devil_reward("1", 1_000)), 2_000)
            self.assertEqual(item_store.count("1", items_core.DEVIL_REWARD_ITEM), 0)
            self.assertEqual(wallet.balances["1"], 2_000)


# ---------------------------------------------------------------------------
# S4（マネーパネル）
# ---------------------------------------------------------------------------

class MoneyPanelNextStepTest(unittest.TestCase):
    def _status(self, **overrides):
        status = {"balance": 100_000}
        status.update(overrides)
        return status

    def test_category_labels_carry_roles(self):
        labels = dict(CATEGORIES)
        self.assertEqual(labels["market"], "市場（交換）")
        self.assertEqual(labels["craft"], "合成・工房（生産）")

    def test_next_step_priority(self):
        # B-2: 逮捕中でも公開パネルに逮捕情報は出さない（「次の1手」行も
        # 「状態」フィールドも出さない。本人への通知は ephemeral 経路）。
        embed = status_embed(self._status(
            prison_remaining=600.0, workshop_ready=True,
            starter_claimed=False, daily_claimed=False))
        self.assertIsNone(embed.description)
        fields = {field.name: field.value for field in embed.fields}
        self.assertNotIn("状態", fields)
        for value in fields.values():
            self.assertNotIn("逮捕中", value)
        embed = status_embed(self._status(
            workshop_ready=True, starter_claimed=False,
            daily_claimed=False))
        self.assertIn("工房で受け取り", embed.description)
        embed = status_embed(self._status(
            starter_claimed=False, daily_claimed=False))
        self.assertIn("スターター", embed.description)
        embed = status_embed(self._status(
            starter_claimed=True, daily_claimed=False))
        self.assertIn("今日のボーナス", embed.description)
        embed = status_embed(self._status(
            starter_claimed=True, daily_claimed=True))
        self.assertIsNone(embed.description)
        embed = status_embed(self._status(
            balance=10, starter_claimed=True, daily_claimed=True))
        self.assertIn("採掘と宝くじ", embed.description)

    def test_active_effects_field(self):
        embed = status_embed(self._status(
            active_effect_details=[
                {"name": "落盤対策", "remaining": 1800.0}]))
        fields = {field.name: field.value for field in embed.fields}
        self.assertIn("発動中の効果", fields)
        self.assertIn("落盤対策", fields["発動中の効果"])
        self.assertIn("約30分", fields["発動中の効果"])

    def test_party_count_field(self):
        embed = status_embed(self._status(party_count=3))
        fields = {field.name: field.value for field in embed.fields}
        self.assertEqual(fields["編成"], "**3 体**")


# ---------------------------------------------------------------------------
# S6-6（総合資産ランキング）
# ---------------------------------------------------------------------------

class AssetRankingTest(unittest.TestCase):
    def test_combines_balance_and_token_value(self):
        ranking = compute_asset_ranking(
            {"1": 100, "2": 50}, {"2": 10.0, "3": 5.0}, 100.0)
        self.assertEqual(
            [row["user_id"] for row in ranking], ["2", "3", "1"])
        self.assertEqual(ranking[0]["total"], 1_050)
        self.assertEqual(ranking[0]["token_value"], 1_000)
        self.assertEqual(ranking[1]["total"], 500)

    def test_limit_and_empty(self):
        self.assertEqual(compute_asset_ranking({}, {}, 100.0), [])
        ranking = compute_asset_ranking(
            {str(i): i for i in range(20)}, {}, 1.0, limit=5)
        self.assertEqual(len(ranking), 5)
        self.assertEqual(ranking[0]["total"], 19)


# ---------------------------------------------------------------------------
# 配線（レジストリ・入口）
# ---------------------------------------------------------------------------

class WiringTest(unittest.TestCase):
    def test_actions_registered(self):
        from core.general.common import GENERAL_ACTIONS, MONEY_PRISON_BLOCKED_VALUES
        money_values = [v for _label, v in GENERAL_ACTIONS["money"]]
        rta_values = [v for _label, v in GENERAL_ACTIONS["rta"]]
        self.assertIn("bj_duel", money_values)
        self.assertIn("asset_leaderboard", rta_values)
        self.assertIn("bj_duel", MONEY_PRISON_BLOCKED_VALUES)
        registry = action_registry.default_registry()
        self.assertIsNotNone(registry.get("general:bj_duel"))
        self.assertIsNotNone(registry.get("general:asset_leaderboard"))
        self.assertIn("general:bj_duel", action_registry.AI_BLOCKED_IDS)

    def test_rankings_view_has_asset_target(self):
        from cogs.general import RankingsView
        values = [v for _label, v in RankingsView.TARGETS]
        self.assertIn("asset_leaderboard", values)


if __name__ == "__main__":
    unittest.main()
