# -*- coding: utf-8 -*-
"""セーフティ修正クラスタ5 (その他コードバグ/権限/共通) の回帰テスト。

対象: A-2 ローカライズカタログパス / B-1 !all_stats ゲート /
A-5 RecordingSink.snapshot 二重定義 / A-6 アトミック書き込み /
A-7 server_setup のチャンネル列挙切り詰め / main.py ローダのログ /
B-3 音楽の VC 参加チェック / B-4 ロールショップ多層防御 /
B-6 抽選 ManageView / E-7 poker・janken の逮捕ブロック /
E-9 AI tools の risk 再検証と候補除外 / E-12・E-13 RNG の SystemRandom 化 /
E-5c 返金失敗の握り潰し解消 / E-16 GamePanelView の共通クールダウン。
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # game_fakes 等のテスト用部品

from core.support import localization


# ---------------------------------------------------------------------------
# A-2: ローカライズカタログが実際に読み込まれること
# ---------------------------------------------------------------------------
class LocalizationCatalogTest(unittest.TestCase):
    def test_key_catalogs_are_loaded(self):
        # リポジトリ直下 locales/ の en/ja は 0 件であってはならない。
        self.assertTrue(localization._KEY_CATALOGS["en"])
        self.assertTrue(localization._KEY_CATALOGS["ja"])
        self.assertEqual(
            localization.text("language_settings_title", "en"),
            "Language settings")

    def test_english_pairs_are_loaded_and_translate(self):
        # core/locales/ja_to_en.json (5,000件超) が読み込まれていること。
        self.assertGreater(len(localization._ENGLISH_PAIRS), 1000)
        self.assertEqual(localization.translate_text("言語設定", "en"),
                         "Language Settings")
        self.assertNotEqual(
            localization.translate_text(
                "このサーバーで AGOBOT が使用する言語を選択します。"
                "設定はサーバー全体で共有されます。", "en"),
            "このサーバーで AGOBOT が使用する言語を選択します。"
            "設定はサーバー全体で共有されます。")


# ---------------------------------------------------------------------------
# B-1: !all_stats の権限ゲート
# ---------------------------------------------------------------------------
class AllStatsGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_allowed_user_ids_check(self):
        from core.support.allstats.cog import (
            ALLOWED_USER_IDS, SystemStatsCog, is_all_stats_allowed)

        allowed = types.SimpleNamespace(
            author=types.SimpleNamespace(id=next(iter(ALLOWED_USER_IDS))))
        denied = types.SimpleNamespace(
            author=types.SimpleNamespace(id=999999999999999999))
        self.assertTrue(await is_all_stats_allowed(allowed))
        self.assertFalse(await is_all_stats_allowed(denied))
        # コマンド自体にチェックが登録されていること (実運用の invoke 経路)。
        self.assertIn(is_all_stats_allowed, SystemStatsCog.all_stats.checks)


# ---------------------------------------------------------------------------
# A-5: RecordingSink.snapshot は有効な (後者の) 実装だけが残ること
# ---------------------------------------------------------------------------
class SinkSnapshotTest(unittest.TestCase):
    def test_single_snapshot_definition_with_labels_and_padding(self):
        source = (Path(__file__).resolve().parent.parent
                  / "core/vc/rec/sink.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("def snapshot"), 1)

        from core.vc.rec.sink import RecordingSink

        sink = object.__new__(RecordingSink)
        sink._lock = threading.Lock()
        sink.buffers = {1: b"12345678", 2: b"abcd"}
        sink.labels = {1: "one", 2: "two"}
        result = sink.snapshot()
        # ラベル変換され、短い方は最長に合わせてゼロ埋めされる (後者の実装)。
        self.assertEqual(result["one"], b"12345678")
        self.assertEqual(result["two"], b"abcd\x00\x00\x00\x00")


# ---------------------------------------------------------------------------
# A-6: アトミック書き込み (tmp → replace) と読み込み失敗時の上書き防止
# ---------------------------------------------------------------------------
class AtomicSaveTest(unittest.TestCase):
    def test_voice_trigger_save_is_atomic(self):
        from core.vc.trigger import VoiceTriggerCog

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "meta.json"
            cog = object.__new__(VoiceTriggerCog)
            cog.triggers = {42: {"word": {"ecdc": "x.ecdc"}}}
            cog._meta_path = lambda guild_id: target
            cog._save(42)
            self.assertEqual(
                json.loads(target.read_text(encoding="utf-8")),
                {"word": {"ecdc": "x.ecdc"}})
            self.assertFalse((Path(tmp) / "meta.json.tmp").exists())

    def test_globalchat_save_is_atomic(self):
        from core.support.globalchat.cog import GlobalChatCog

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "global_channels.json"
            cog = object.__new__(GlobalChatCog)
            cog.save_file = str(target)
            cog.active_channels = {11, 22}
            cog.save_channels()
            self.assertEqual(
                set(json.loads(target.read_text(encoding="utf-8"))), {11, 22})
            self.assertFalse(Path(f"{target}.tmp").exists())

    def test_globalchat_load_failure_never_overwrites(self):
        from core.support.globalchat.cog import GlobalChatCog

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "global_channels.json"
            target.write_text("{壊れたJSON", encoding="utf-8")
            cog = object.__new__(GlobalChatCog)
            cog.save_file = str(target)
            cog.active_channels = cog.load_channels()
            self.assertEqual(cog.active_channels, set())
            self.assertTrue(cog._load_failed)
            cog.save_channels()
            # 壊れた元ファイルが空で上書きされていないこと。
            self.assertEqual(target.read_text(encoding="utf-8"), "{壊れたJSON")


# ---------------------------------------------------------------------------
# A-7: server_setup のチャンネル列挙は 1024 字に収まること
# ---------------------------------------------------------------------------
class ServerSetupChannelListTest(unittest.TestCase):
    def test_many_channels_are_truncated_with_remainder(self):
        from core.support.server_setup.cog import channel_list_text

        ids = [100000000000000000 + i for i in range(200)]
        text = channel_list_text(ids)
        self.assertLessEqual(len(text), 1024)
        self.assertRegex(text, r"…他\d+件$")

    def test_few_channels_and_empty(self):
        from core.support.server_setup.cog import channel_list_text

        self.assertEqual(channel_list_text([123, 456]), "<#123> <#456>")
        self.assertEqual(channel_list_text([]), "なし")


# ---------------------------------------------------------------------------
# 観察: main.py の Cog ローダが logger.error (traceback 付き) を残すこと
# ---------------------------------------------------------------------------
class MainLoaderLoggingTest(unittest.TestCase):
    def test_load_failure_is_logged_with_traceback(self):
        source = (Path(__file__).resolve().parent.parent
                  / "main.py").read_text(encoding="utf-8")
        self.assertIn("Cog の読み込みに失敗しました", source)
        self.assertIn("exc_info=True", source)


# ---------------------------------------------------------------------------
# B-3: 音楽操作の VC 参加チェック (純関数ヘルパー + 入口)
# ---------------------------------------------------------------------------
def _vc(member_ids):
    channel = types.SimpleNamespace(
        id=900, members=[types.SimpleNamespace(id=i) for i in member_ids])
    return types.SimpleNamespace(channel=channel)


class MusicVoiceCheckTest(unittest.TestCase):
    def test_pure_helper(self):
        from core.vc.music.common import is_same_voice_channel

        user = types.SimpleNamespace(id=1)
        self.assertTrue(is_same_voice_channel(user, _vc([1, 2])))
        self.assertFalse(is_same_voice_channel(user, _vc([2, 3])))
        self.assertFalse(is_same_voice_channel(user, None))
        self.assertFalse(is_same_voice_channel(None, _vc([1])))
        self.assertFalse(is_same_voice_channel(
            user, types.SimpleNamespace(channel=None)))

    def test_pure_helper_fallback_to_own_voice_state(self):
        from core.vc.music.common import is_same_voice_channel

        vc = types.SimpleNamespace(
            channel=types.SimpleNamespace(id=900, members=None))
        inside = types.SimpleNamespace(
            id=1, voice=types.SimpleNamespace(
                channel=types.SimpleNamespace(id=900)))
        outside = types.SimpleNamespace(
            id=2, voice=types.SimpleNamespace(
                channel=types.SimpleNamespace(id=901)))
        self.assertTrue(is_same_voice_channel(inside, vc))
        self.assertFalse(is_same_voice_channel(outside, vc))


class _MusicCog:
    """PlaybackMixin の入口だけを駆動する最小のフェイク cog。"""

    def __init__(self, state):
        from core.vc.music.playback import PlaybackMixin
        self._impl = PlaybackMixin.__new__(PlaybackMixin)
        self._impl.get_state = lambda guild_id: state
        self._impl.update_panel = AsyncMock()
        self._impl._save_music_snapshot = lambda guild_id: None
        self.state = state


class MusicImplGateTest(unittest.IsolatedAsyncioTestCase):
    def _interaction(self, user_id, vc):
        guild = types.SimpleNamespace(id=10, voice_client=vc)
        return types.SimpleNamespace(
            guild=guild, guild_id=10,
            user=types.SimpleNamespace(id=user_id),
            response=types.SimpleNamespace(
                send_message=AsyncMock(), is_done=lambda: False))

    async def test_skip_denied_for_non_member_and_allowed_for_member(self):
        from core.vc.music.playback import PlaybackMixin

        state = {"is_paused": True, "current_track": ("u", "t", 10, None, False),
                 "elapsed_offset": 0, "start_time": 0}
        cog = _MusicCog(state)
        vc = _vc([2])

        outsider = self._interaction(1, vc)
        await cog._impl._skip_impl(outsider)
        sent = outsider.response.send_message.await_args
        self.assertIn("ボイスチャンネルに参加", sent.kwargs["embed"].description)
        self.assertIsNotNone(state["current_track"])  # 状態は変わっていない

        member = self._interaction(2, vc)
        await cog._impl._skip_impl(member)
        sent = member.response.send_message.await_args
        self.assertIn("スキップしました", sent.kwargs["embed"].description)
        self.assertIsNone(state["current_track"])

    async def test_stop_denied_for_non_member(self):
        import queue as queue_module

        from core.support.legacy import Responder

        state = {"current_track": ("u", "t", 10, None, False),
                 "elapsed_offset": 0, "is_paused": False,
                 "queue": queue_module.Queue()}
        state["queue"].put(("u2", "t2", None, True))
        cog = _MusicCog(state)
        vc = _vc([2])
        guild = types.SimpleNamespace(id=10, voice_client=vc)
        sent = []

        async def send(**kwargs):
            sent.append(kwargs)

        ctx = types.SimpleNamespace(
            guild=guild, author=types.SimpleNamespace(id=1), send=send)
        await cog._impl._stop_impl(Responder(ctx))
        self.assertEqual(state["queue"].qsize(), 1)  # クリアされていない
        self.assertIn("ボイスチャンネルに参加",
                      sent[0]["embed"].description)


# ---------------------------------------------------------------------------
# B-4: ロールショップのメソッド側権限検証 + サブ View の所有者チェック
# ---------------------------------------------------------------------------
class RoleShopDefenseTest(unittest.IsolatedAsyncioTestCase):
    def _setup_cog(self, tmp):
        from tests.test_role_shop import _Guild, _Role, _Wallet, _cog

        guild = _Guild()
        role = guild.add_role(_Role(10, "VIP", 5))
        wallet = _Wallet({"1": 5000})
        cog = _cog(tmp, wallet, guild)
        return cog, guild, role

    async def test_register_denied_without_manage_roles(self):
        from tests.test_role_shop import _Member

        with tempfile.TemporaryDirectory() as tmp:
            cog, guild, role = self._setup_cog(tmp)
            plain = _Member(7, manage_roles=False)
            message = await cog.register_product(
                guild, role, 1000, 30, operator=plain)
            self.assertIn("ロール管理", message)
            snapshot = await cog.snapshot(guild, 7)
            self.assertEqual(snapshot["products"], [])

            admin = _Member(8, manage_roles=True)
            message = await cog.register_product(
                guild, role, 1000, 30, operator=admin)
            self.assertIn("登録しました", message)

            message = await cog.unregister_product(
                guild, role.id, operator=plain)
            self.assertIn("ロール管理", message)
            snapshot = await cog.snapshot(guild, 8)
            self.assertEqual(len(snapshot["products"]), 1)
            message = await cog.unregister_product(
                guild, role.id, operator=admin)
            self.assertIn("削除しました", message)

    async def test_sub_views_restrict_to_opener(self):
        from cogs.role_shop import DeleteProductView, RegisterRoleView

        with tempfile.TemporaryDirectory() as tmp:
            cog, guild, role = self._setup_cog(tmp)
            register_view = RegisterRoleView(cog, guild, 42)
            owner = types.SimpleNamespace(
                user=types.SimpleNamespace(id=42),
                response=types.SimpleNamespace(send_message=AsyncMock()))
            other = types.SimpleNamespace(
                user=types.SimpleNamespace(id=43),
                response=types.SimpleNamespace(send_message=AsyncMock()))
            self.assertTrue(await register_view.interaction_check(owner))
            self.assertFalse(await register_view.interaction_check(other))

            delete_view = DeleteProductView(
                cog, guild, [{"name": "VIP", "role_id": 10}], 42)
            self.assertTrue(await delete_view.interaction_check(owner))
            self.assertFalse(await delete_view.interaction_check(other))


# ---------------------------------------------------------------------------
# B-6: 抽選 ManageView の主催者チェック
# ---------------------------------------------------------------------------
class GiveawayManageViewTest(unittest.IsolatedAsyncioTestCase):
    async def test_host_admin_and_others(self):
        from core.game.giveaway.cog import ManageView, RUNNING

        view = ManageView(object(), 123, RUNNING, host_id=10)

        def interaction(user_id, manage_guild=False):
            return types.SimpleNamespace(
                user=types.SimpleNamespace(
                    id=user_id,
                    guild_permissions=types.SimpleNamespace(
                        manage_guild=manage_guild)),
                response=types.SimpleNamespace(send_message=AsyncMock()))

        self.assertTrue(await view.interaction_check(interaction(10)))
        self.assertTrue(await view.interaction_check(
            interaction(99, manage_guild=True)))
        self.assertFalse(await view.interaction_check(interaction(99)))


# ---------------------------------------------------------------------------
# E-7: poker / janken の逮捕ブロック
# ---------------------------------------------------------------------------
def _block_only(*blocked_ids):
    blocked = {str(i) for i in blocked_ids}

    def fake_block(user_id, now=None, store=None):
        if str(user_id) in blocked:
            return "🚔 逮捕中です（釈放まであと約30分）。マネー系の操作はできません。"
        return None

    return fake_block


class PokerPrisonTest(unittest.IsolatedAsyncioTestCase):
    def _make(self, tmp):
        from tests.test_poker_table import FakeWallet, user

        from cogs import poker

        wallet = FakeWallet({1: 1000, 2: 1000})
        bot = types.SimpleNamespace(
            get_cog=lambda name: wallet if name == "WalletCog" else None)
        cog = poker.Poker(bot)
        cog.custody = poker.ChipCustodyStore(Path(tmp) / "chips.json")
        cog._record_history = AsyncMock()
        table = poker.PokerTable(555, 66, 1)
        table.players = {1: user(1), 2: user(2)}
        table.phase = "buyin"
        return cog, wallet, table, user

    async def test_buy_in_and_cash_out_blocked_while_imprisoned(self):
        from core.game.game import prison as prison_core
        with tempfile.TemporaryDirectory() as tmp:
            cog, wallet, table, user = self._make(tmp)
            with patch.object(prison_core, "block_message", _block_only(1)):
                ok, message = await cog.buy_in(table, user(1), 500)
                self.assertFalse(ok)
                self.assertIn("逮捕中", message)
                self.assertEqual(wallet.balances["1"], 1000)
                self.assertNotIn(1, table.stacks)

                # 他人は通常どおり買える。
                ok, _ = await cog.buy_in(table, user(2), 500)
                self.assertTrue(ok)

                # 逮捕中の精算は拒否され、チップと台帳は残る。
                table.stacks[1] = 500
                cog.custody.set(table.channel_id, 1, 500)
                self.assertFalse(await cog.cash_out(table, 1))
                self.assertEqual(table.stacks[1], 500)
                self.assertEqual(
                    cog.custody.entries(), {555: {1: 500, 2: 500}})


class JankenPrisonTest(unittest.IsolatedAsyncioTestCase):
    async def test_start_recruit_with_wager_blocked(self):
        from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember

        from core.game.game import prison as prison_core
        from cogs import janken as j

        guild = FakeGuild(77)
        channel = FakeChannel(700, guild)
        host = FakeMember(1, guild)
        cog = j.Janken(types.SimpleNamespace())
        with patch.object(prison_core, "block_message", _block_only(1)):
            interaction = FakeInteraction(host, channel)
            await cog.start_recruit(interaction, wager=100)
        self.assertIn("逮捕中", interaction.texts()[0])
        self.assertEqual(cog.games, {})

    async def test_join_with_wager_blocked(self):
        from game_fakes import FakeChannel, FakeGuild, FakeInteraction, FakeMember

        from core.game.game import prison as prison_core
        from cogs import janken as j

        guild = FakeGuild(77)
        channel = FakeChannel(700, guild)
        host = FakeMember(1, guild)
        other = FakeMember(2, guild)
        cog = j.Janken(types.SimpleNamespace())
        game = j.JankenGame(channel.id, guild.id, host.id)
        game.wager = 100
        game.players[host.id] = host
        view = j.JoinView(cog, game)
        with patch.object(prison_core, "block_message", _block_only(2)):
            from game_fakes import press
            interaction = FakeInteraction(other, channel)
            await press(view, "join", interaction)
        self.assertIn("逮捕中", interaction.texts()[0])
        self.assertNotIn(2, game.players)

    async def test_collect_wagers_precheck_blocks_all_debits(self):
        from core.game.game import prison as prison_core
        from cogs import janken as j

        wallet = types.SimpleNamespace(
            _change_balance=AsyncMock(return_value=1000))
        bot = types.SimpleNamespace(
            get_cog=lambda name: wallet if name == "WalletCog" else None)
        cog = j.Janken(bot)
        game = j.JankenGame(700, 77, 1)
        game.wager = 50
        game.players = {1: types.SimpleNamespace(id=1),
                        2: types.SimpleNamespace(id=2)}
        with patch.object(prison_core, "block_message", _block_only(2)):
            self.assertFalse(await cog._collect_wagers(game))
        wallet._change_balance.assert_not_awaited()


# ---------------------------------------------------------------------------
# E-9: AI tools の risk 再検証と候補除外
# ---------------------------------------------------------------------------
class AIToolsRiskTest(unittest.IsolatedAsyncioTestCase):
    def test_candidates_exclude_message_shortcut_blocked(self):
        from core.general import action_registry
        from core.general.ai_tools import ai_tools_router
        candidates = ai_tools_router.action_candidates()
        for action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            self.assertNotIn(action_id, candidates)
        self.assertIn("vc:join", candidates)

    async def test_invoke_action_rejects_blocked_and_display_actions(self):
        from core.general.ai_tools import ai_tools_router
        bot = types.SimpleNamespace(get_cog=lambda name: None)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(id=45))
        for item in ({"root": "general", "value": "pay"},
                     {"root": "general", "value": "status"},
                     {"root": "general", "value": "money_panel"}):
            with self.assertRaises(ai_tools_router.AIToolsDecisionError):
                await ai_tools_router.invoke_action(bot, message, item)

    async def test_invoke_action_still_passes_safe_actions(self):
        from core.general.ai_tools import ai_tools_router
        dispatcher = types.SimpleNamespace(execute_shortcut=AsyncMock())
        bot = types.SimpleNamespace(get_cog=lambda name: dispatcher)
        message = types.SimpleNamespace(
            author=types.SimpleNamespace(id=45))
        item = {"root": "vc", "value": "join", "label": "VC参加", "genre": "VC"}
        result = await ai_tools_router.invoke_action(bot, message, item)
        self.assertEqual(result, {})
        dispatcher.execute_shortcut.assert_awaited_once()


# ---------------------------------------------------------------------------
# E-12 / E-13: RNG の SystemRandom 化 (注入された RNG は壊さない)
# ---------------------------------------------------------------------------
class SystemRandomTest(unittest.TestCase):
    def test_poker_and_wordwolf_use_system_random(self):
        from core.game.poker.cog import _SHUFFLE_RNG
        from core.game.wordwolf.cog import _RNG as wordwolf_rng

        self.assertIsInstance(_SHUFFLE_RNG, random.SystemRandom)
        self.assertIsInstance(wordwolf_rng, random.SystemRandom)

    def test_lottery_default_rng_is_system_random_but_injection_kept(self):
        from core.game.lottery import LotteryStore

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "lottery.json"
            self.assertIsInstance(
                LotteryStore(path)._rng, random.SystemRandom)
            injected = random.Random(42)
            self.assertIs(LotteryStore(path, rng=injected)._rng, injected)

    def test_gacha_default_rng_is_system_random_but_injection_kept(self):
        from cogs.gacha import GachaCog
        from core.game.gacha import gacha as gacha_core
        with tempfile.TemporaryDirectory() as tmp:
            store = gacha_core.GachaStore(Path(tmp) / "gacha.json")
            bot = types.SimpleNamespace(get_cog=lambda name: None)
            cog = GachaCog(bot, store=store)
            self.assertIsInstance(cog._rng, random.SystemRandom)
            injected = random.Random(7)
            cog = GachaCog(bot, store=store, rng=injected)
            self.assertIs(cog._rng, injected)


# ---------------------------------------------------------------------------
# E-5c: 返金・変換の失敗を握り潰さない
# ---------------------------------------------------------------------------
class _CreditFailWallet:
    """debit は成功するが credit (正の delta) は None を返すウォレット。"""

    def __init__(self, balances):
        self.balances = dict(balances)
        self.fail_credit = True

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        from cogs import wallet as wallet_module

        uid = str(user_id)
        if delta > 0 and self.fail_credit:
            return None
        current = self.balances.get(uid)
        if current is None:
            if require_funds:
                return wallet_module.INSUFFICIENT
            if create_with is None:
                return None
            current = create_with
        new_balance = current + delta
        if require_funds and new_balance < 0:
            return wallet_module.INSUFFICIENT
        self.balances[uid] = new_balance
        return new_balance


class RefundFailureTest(unittest.TestCase):
    def test_workshop_buy_machine_refund_failure_is_reported(self):
        from core.general.workshop import workshop as workshop_core
        from core.general.items import items as items_core
        from cogs.workshop import WorkshopCog

        with tempfile.TemporaryDirectory() as tmp:
            price = workshop_core.MACHINE_TIERS["small"]["price"]
            wallet = _CreditFailWallet({"1": price + 500})
            bot = types.SimpleNamespace(
                get_cog=lambda name: wallet if name == "WalletCog" else None)
            cog = WorkshopCog(
                bot,
                workshop_store=workshop_core.WorkshopStore(
                    Path(tmp) / "workshop.json", rng=random.Random(42)),
                item_store=items_core.ItemStore(
                    Path(tmp) / "items.json", rng=random.Random(42)))

            def fail_add(uid, tier_id):
                raise items_core.ItemError("追加できませんでした。")

            cog.workshop_store.add_machine = fail_add
            with self.assertLogs("cogs.workshop", level="CRITICAL"):
                message = asyncio.run(cog.execute_buy_machine(1, "small"))
            self.assertIn("返金に失敗しました", message)
            self.assertIn("運営に連絡", message)

    def test_clan_create_refund_failure_is_reported(self):
        from core.game.clan import clan as clan_core
        from cogs.clan import ClanCog

        with tempfile.TemporaryDirectory() as tmp:
            wallet = _CreditFailWallet({"1": 20000})
            bot = types.SimpleNamespace(
                get_cog=lambda name: wallet if name == "WalletCog" else None)
            cog = ClanCog(
                bot, store=clan_core.ClanStore(Path(tmp) / "clans.json"))

            def fail_create(uid, name):
                raise clan_core.ClanError("作成できませんでした。")

            cog.store.create = fail_create
            with self.assertLogs("cogs.clan", level="CRITICAL"):
                message = asyncio.run(cog.create_clan(1, "失敗団"))
            self.assertIn("返金に失敗しました", message)
            self.assertIn("運営に連絡", message)


class GachaCreditFailureTest(unittest.TestCase):
    def _cog(self, tmp, wallet, rng):
        from tests.test_gacha import _Bot

        from cogs.gacha import GachaCog
        from core.game.gacha import gacha as gacha_core
        return GachaCog(
            _Bot(wallet),
            store=gacha_core.GachaStore(Path(tmp) / "gacha.json"),
            rng=rng)

    def test_duplicate_credit_failure_is_not_shown_as_success(self):
        from tests.test_gacha import _FixedRandom, _Wallet

        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, _FixedRandom("seer"))
            asyncio.run(cog.execute_pull(1, 1))  # 1回目: 新規入手
            # 変換コインの credit (正の delta) だけ失敗させる。
            original = wallet._change_balance

            async def flaky(user_id, delta, **kwargs):
                if delta > 0:
                    return None
                return await original(user_id, delta, **kwargs)

            wallet._change_balance = flaky
            with self.assertLogs("cogs.gacha", level="CRITICAL"):
                message = asyncio.run(cog.execute_pull(1, 1))
            self.assertIn("かぶり", message)
            self.assertIn("付与に失敗しました", message)
            self.assertIn("運営に連絡", message)

    def test_exception_after_debit_refunds(self):
        from tests.test_gacha import _Wallet

        class ExplodingRandom(random.Random):
            def choices(self, population, weights=None, k=1):
                raise RuntimeError("boom")

        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10000})
            cog = self._cog(tmp, wallet, ExplodingRandom())
            message = asyncio.run(cog.execute_pull(1, 1))
            self.assertIn("返金しました", message)
            self.assertEqual(wallet.balances["1"], 10000)


# ---------------------------------------------------------------------------
# E-16: GamePanelView の共通クールダウン (部分実施)
# ---------------------------------------------------------------------------
class PanelCooldownTest(unittest.IsolatedAsyncioTestCase):
    def test_pure_cooldown_helper(self):
        from core.game.game.game_v2 import InteractionCooldown

        cooldown = InteractionCooldown(window=1.0)
        self.assertTrue(cooldown.check(1, now=100.0))
        self.assertFalse(cooldown.check(1, now=100.5))
        self.assertTrue(cooldown.check(2, now=100.5))   # ユーザー単位
        self.assertTrue(cooldown.check(1, now=101.0))   # 窓を過ぎれば通る
        self.assertAlmostEqual(cooldown.remaining(1, now=101.5), 0.5)

    async def test_game_panel_view_enforces_cooldown(self):
        from core.game.game.game_v2 import GamePanelView

        panel = GamePanelView("t", "b")

        def interaction(user_id):
            return types.SimpleNamespace(
                user=types.SimpleNamespace(id=user_id),
                response=types.SimpleNamespace(send_message=AsyncMock()))

        self.assertTrue(await panel.interaction_check(interaction(1)))
        self.assertFalse(await panel.interaction_check(interaction(1)))
        self.assertTrue(await panel.interaction_check(interaction(2)))

    async def test_board_entry_panel_chains_super_check(self):
        from core.game.minesweeper.cog import DifficultyPanel

        owner = types.SimpleNamespace(id=1)
        panel = DifficultyPanel(None, owner)

        def interaction(user_id):
            return types.SimpleNamespace(
                user=types.SimpleNamespace(id=user_id),
                response=types.SimpleNamespace(send_message=AsyncMock()))

        self.assertFalse(await panel.interaction_check(interaction(2)))
        self.assertTrue(await panel.interaction_check(interaction(1)))
        # 所有者でも連打はクールダウンで止まる。
        self.assertFalse(await panel.interaction_check(interaction(1)))


if __name__ == "__main__":
    unittest.main()
