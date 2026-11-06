"""マネー系セーフティ修正（クラスタ3）の回帰テスト。

対象:
- E-2+E-6 claim_starter の prison チェックと flush 永続化
- B-2 公開マネーパネルに逮捕状態を出さない（本人へは ephemeral）
- B-8 PayModal 後の確認ステップ / E-8a WalletCog.pay の prison 再チェック
- E-1 アイテム売却・市場売却の flush-before-wallet
- E-5b 市場モーダルの NaN/inf 拒否
- E-5c アイテム購入の debit 後失敗時返金の戻り値確認
"""
from __future__ import annotations

import asyncio
import logging
import random
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import discord  # noqa: E402

from core.general import daily_bonus as daily_core  # noqa: E402
from core.general import starter as starter_core  # noqa: E402
from core.game import prison as prison_core  # noqa: E402
from core.general import items as items_core  # noqa: E402
from core.general import market as market_core  # noqa: E402
from cogs import wallet as wallet_module  # noqa: E402
from cogs.items import ItemsCog  # noqa: E402
from cogs.market import MarketCog, TradeModal  # noqa: E402
from cogs.money_panel import MoneyPanelCog, status_embed  # noqa: E402
from core.general.panel import PayConfirmView, PayModal  # noqa: E402
from core.support.messages import MARKET_INVALID_AMOUNT  # noqa: E402


# ---------------------------------------------------------------------------
# フェイク
# ---------------------------------------------------------------------------

class _FakeWallet:
    def __init__(self, balances=None):
        self.balances = dict(balances or {})

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                               create_with=None):
        uid = str(user_id)
        if uid not in self.balances:
            if require_funds:
                return wallet_module.INSUFFICIENT
            if create_with is None:
                return None
            self.balances[uid] = create_with
        if require_funds and self.balances[uid] + delta < 0:
            return wallet_module.INSUFFICIENT
        self.balances[uid] += delta
        return self.balances[uid]


class _FakeBot:
    def __init__(self, cogs=None, users=None):
        self._cogs = dict(cogs or {})
        self._users = dict(users or {})

    def get_cog(self, name):
        return self._cogs.get(name)

    async def fetch_user(self, user_id):
        user = self._users.get(int(user_id))
        if user is None:
            raise discord.HTTPException(
                mock.MagicMock(status=404), "unknown user")
        return user


class _FakeResponse:
    def __init__(self):
        self.sent = []
        self.edited = []
        self.deferred = False
        self.modal = None

    async def send_message(self, *args, **kwargs):
        self.sent.append((args, kwargs))

    async def edit_message(self, *args, **kwargs):
        self.edited.append((args, kwargs))

    async def defer(self, **kwargs):
        self.deferred = True

    async def send_modal(self, modal):
        self.modal = modal


class _FakeFollowup:
    def __init__(self):
        self.sent = []

    async def send(self, *args, **kwargs):
        self.sent.append((args, kwargs))


class _FakeMessage:
    def __init__(self):
        self.edits = []

    async def edit(self, **kwargs):
        self.edits.append(kwargs)


class _FakeInteraction:
    def __init__(self, user_id=1):
        self.user = SimpleNamespace(
            id=user_id, bot=False, mention=f"<@{user_id}>",
            display_name=f"user{user_id}")
        self.response = _FakeResponse()
        self.followup = _FakeFollowup()
        self.data = {}
        self._original = _FakeMessage()

    async def original_response(self):
        return self._original

    async def edit_original_response(self, **kwargs):
        self._original.edits.append(kwargs)


def _user(user_id, *, bot=False, name=None):
    return SimpleNamespace(
        id=user_id, bot=bot, display_name=name or f"user{user_id}",
        mention=f"<@{user_id}>")


def _button(view, label):
    for child in view.children:
        if isinstance(child, discord.ui.Button) and child.label == label:
            return child
    raise AssertionError(f"ボタンがありません: {label}")


def _panel_cog(tmp, wallet, *, prison_store=None):
    item_store = items_core.ItemStore(Path(tmp) / "items.json")
    cogs = {"WalletCog": wallet,
            "ItemsCog": SimpleNamespace(store=item_store)}
    if prison_store is not None:
        cogs["CirculationCog"] = SimpleNamespace(prison_store=prison_store)
    bot = _FakeBot(cogs)
    cog = MoneyPanelCog(
        bot,
        balance_reader=lambda uid: wallet.balances.get(uid, 10),
        starter_store=starter_core.StarterStore(Path(tmp) / "starter.json"),
        daily_store=daily_core.DailyBonusStore(Path(tmp) / "daily.json"))
    return cog, item_store


# ---------------------------------------------------------------------------
# E-2 + E-6: claim_starter
# ---------------------------------------------------------------------------

class ClaimStarterSafetyTest(unittest.TestCase):
    def test_blocked_while_imprisoned_and_claim_not_consumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 10})
            prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            prison_store.imprison("1", minutes=30)
            cog, _items = _panel_cog(tmp, wallet, prison_store=prison_store)
            message = asyncio.run(cog.claim_starter(1))
            self.assertIn("逮捕", message)
            self.assertEqual(wallet.balances["1"], 10)
            # チェック→claim の順序なので受け取り済みになっていない。
            self.assertFalse(cog.starter_store.has_claimed("1"))
            # 釈放後は通常どおり受け取れる。
            prison_store.release("1")
            message = asyncio.run(cog.claim_starter(1))
            self.assertIn("受け取りました", message)

    def test_flush_makes_claim_survive_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _items = _panel_cog(tmp, wallet)
            message = asyncio.run(cog.claim_starter(1))
            self.assertIn("受け取りました", message)
            balance_after = wallet.balances["1"]
            # 再起動相当: ストアを同パスから読み直しても受け取り済み。
            reloaded = starter_core.StarterStore(Path(tmp) / "starter.json")
            self.assertTrue(reloaded.has_claimed("1"))
            cog2, _ = _panel_cog(tmp, wallet)
            cog2.starter_store = reloaded
            message = asyncio.run(cog2.claim_starter(1))
            self.assertIn("受け取り済み", message)
            self.assertEqual(wallet.balances["1"], balance_after)

    def test_cog_unload_flushes_starter_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({})
            cog, _items = _panel_cog(tmp, wallet)
            # バッチフラッシュ閾値未満の dirty を直接作る。
            self.assertTrue(cog.starter_store.try_claim("9"))
            before = starter_core.StarterStore(Path(tmp) / "starter.json")
            self.assertFalse(before.has_claimed("9"))
            asyncio.run(cog.cog_unload())
            after = starter_core.StarterStore(Path(tmp) / "starter.json")
            self.assertTrue(after.has_claimed("9"))


# ---------------------------------------------------------------------------
# B-2: 公開パネルに逮捕状態を出さない
# ---------------------------------------------------------------------------

class MoneyPanelPrisonDisplayTest(unittest.TestCase):
    def test_status_embed_omits_prison_keeps_balance(self):
        embed = status_embed({
            "balance": 12345, "prison_remaining": 600.0,
            "starter_claimed": True, "daily_claimed": True})
        field_names = [f.name for f in embed.fields]
        self.assertNotIn("状態", field_names)
        self.assertIn("AGOコイン", field_names)
        fields = {f.name: f.value for f in embed.fields}
        self.assertIn("12,345", fields["AGOコイン"])
        all_text = (embed.description or "") + "".join(
            f"{f.name}{f.value}" for f in embed.fields)
        self.assertNotIn("逮捕", all_text)
        self.assertNotIn("釈放まで", all_text)

    def test_show_panel_notifies_prison_only_ephemerally(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100})
            prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            prison_store.imprison("1", minutes=30)
            cog, _items = _panel_cog(tmp, wallet, prison_store=prison_store)
            interaction = _FakeInteraction(user_id=1)
            asyncio.run(cog.show_panel(interaction))
            # 公開送信は view のみで、followup の ephemeral だけが逮捕通知。
            self.assertEqual(len(interaction.response.sent), 1)
            _args, kwargs = interaction.response.sent[0]
            self.assertNotIn("ephemeral", kwargs)
            self.assertEqual(len(interaction.followup.sent), 1)
            f_args, f_kwargs = interaction.followup.sent[0]
            self.assertTrue(f_kwargs.get("ephemeral"))
            self.assertIn("逮捕中", f_args[0])

    def test_show_panel_no_ephemeral_when_not_imprisoned(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _FakeWallet({"1": 100})
            prison_store = prison_core.PrisonStore(Path(tmp) / "prison.json")
            cog, _items = _panel_cog(tmp, wallet, prison_store=prison_store)
            interaction = _FakeInteraction(user_id=1)
            asyncio.run(cog.show_panel(interaction))
            self.assertEqual(interaction.followup.sent, [])


# ---------------------------------------------------------------------------
# E-8a: WalletCog.pay の prison 再チェック
# ---------------------------------------------------------------------------

class PayPrisonRecheckTest(unittest.TestCase):
    def _cog(self):
        bot = _FakeBot({})
        return wallet_module.WalletCog(bot)

    def test_pay_blocked_while_imprisoned(self):
        cog = self._cog()
        interaction = _FakeInteraction(user_id=1)
        receiver = _user(2)
        with mock.patch.object(
                prison_core, "block_message",
                return_value="🚔 逮捕中です（釈放まであと約30分）。マネー系の操作はできません。") as block, \
                mock.patch.object(
                    cog, "_transfer_atomic",
                    new=mock.AsyncMock(return_value=70)) as transfer:
            asyncio.run(cog.pay(interaction, receiver, 100))
        block.assert_called_once()
        transfer.assert_not_called()
        self.assertEqual(len(interaction.response.sent), 1)
        args, kwargs = interaction.response.sent[0]
        self.assertIn("逮捕中", args[0])
        self.assertTrue(kwargs.get("ephemeral"))
        self.assertFalse(interaction.response.deferred)

    def test_pay_proceeds_when_not_imprisoned(self):
        cog = self._cog()
        interaction = _FakeInteraction(user_id=1)
        receiver = _user(2)
        with mock.patch.object(
                prison_core, "block_message", return_value=None), \
                mock.patch.object(
                    cog, "_transfer_atomic",
                    new=mock.AsyncMock(return_value=70)) as transfer:
            asyncio.run(cog.pay(interaction, receiver, 100))
        transfer.assert_called_once_with("1", "2", 100)
        self.assertTrue(interaction.response.deferred)
        self.assertEqual(len(interaction.followup.sent), 2)


# ---------------------------------------------------------------------------
# B-8: PayModal → 確認ビュー → pay
# ---------------------------------------------------------------------------

class _RecordingWalletCog:
    def __init__(self):
        self.pay_calls = []

    async def pay(self, interaction, receiver, amount):
        self.pay_calls.append((interaction, receiver, amount))


class PayConfirmFlowTest(unittest.TestCase):
    def _setup(self):
        wallet = _RecordingWalletCog()
        receiver = _user(2, name="受取太郎")
        bot = _FakeBot({"WalletCog": wallet}, users={2: receiver})
        general = SimpleNamespace(bot=bot)
        return wallet, receiver, general

    def test_modal_submit_shows_confirm_without_paying(self):
        wallet, receiver, general = self._setup()
        modal = PayModal(general)
        modal.receiver_id._value = "2"
        modal.amount._value = "500"
        interaction = _FakeInteraction(user_id=1)
        asyncio.run(modal.on_submit(interaction))
        # 確認なしでは送金されない。
        self.assertEqual(wallet.pay_calls, [])
        self.assertEqual(len(interaction.response.sent), 1)
        args, kwargs = interaction.response.sent[0]
        self.assertTrue(kwargs.get("ephemeral"))
        self.assertIn("受取太郎", args[0])
        self.assertIn("500 AGO", args[0])
        view = kwargs.get("view")
        self.assertIsInstance(view, PayConfirmView)

    def test_confirm_button_executes_pay(self):
        wallet, receiver, general = self._setup()
        view = PayConfirmView(general, 1, receiver, 500)
        # 本人以外は押せない。
        other = _FakeInteraction(user_id=99)
        self.assertFalse(asyncio.run(view.interaction_check(other)))
        interaction = _FakeInteraction(user_id=1)
        self.assertTrue(asyncio.run(view.interaction_check(interaction)))
        asyncio.run(_button(view, "送金する").callback(interaction))
        self.assertEqual(len(wallet.pay_calls), 1)
        _inter, got_receiver, got_amount = wallet.pay_calls[0]
        self.assertIs(got_receiver, receiver)
        self.assertEqual(got_amount, 500)

    def test_cancel_does_not_pay(self):
        wallet, receiver, general = self._setup()
        view = PayConfirmView(general, 1, receiver, 500)
        interaction = _FakeInteraction(user_id=1)
        asyncio.run(_button(view, "キャンセル").callback(interaction))
        self.assertEqual(wallet.pay_calls, [])
        self.assertEqual(len(interaction.response.edited), 1)
        self.assertIn("キャンセル", interaction.response.edited[0][1].get(
            "content", interaction.response.edited[0][0][0] if interaction.response.edited[0][0] else ""))

    def test_timeout_does_not_pay_and_disables(self):
        wallet, receiver, general = self._setup()
        view = PayConfirmView(general, 1, receiver, 500)
        message = _FakeMessage()
        view.message = message
        asyncio.run(view.on_timeout())
        self.assertEqual(wallet.pay_calls, [])
        self.assertEqual(len(message.edits), 1)
        self.assertTrue(all(child.disabled for child in view.children))


# ---------------------------------------------------------------------------
# E-1: flush-before-wallet（売却）
# ---------------------------------------------------------------------------

class FlushBeforeWalletTest(unittest.TestCase):
    def test_item_sell_flushes_before_credit(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = []
            store = items_core.ItemStore(Path(tmp) / "items.json")
            store.add("1", "scrap", 3)
            orig_flush = store.flush

            def tracked_flush():
                events.append("flush")
                orig_flush()
            store.flush = tracked_flush

            wallet = _FakeWallet({"1": 0})
            orig_change = wallet._change_balance

            async def tracked_change(*a, **kw):
                events.append("credit")
                return await orig_change(*a, **kw)
            wallet._change_balance = tracked_change
            bot = _FakeBot({"WalletCog": wallet})
            cog = ItemsCog(bot, store=store)
            message = asyncio.run(cog.execute_sell(1, "scrap", 1))
            self.assertIn("売りました", message)
            self.assertEqual(events, ["flush", "credit"])
            # 永続化されているので読み直してもアイテムは戻らない。
            reloaded = items_core.ItemStore(Path(tmp) / "items.json")
            self.assertEqual(reloaded.count("1", "scrap"), 2)

    def test_market_sell_flushes_before_credit(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = []
            store = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            store.apply_buy("1", 1000)
            store.flush()
            orig_flush = store.flush

            def tracked_flush():
                events.append("flush")
                orig_flush()
            store.flush = tracked_flush

            wallet = _FakeWallet({"1": 0})
            orig_change = wallet._change_balance

            async def tracked_change(*a, **kw):
                events.append("credit")
                return await orig_change(*a, **kw)
            wallet._change_balance = tracked_change
            bot = _FakeBot({"WalletCog": wallet})
            cog = MarketCog(bot, store=store)
            tokens = store.token_balance("1")
            message = asyncio.run(cog.execute_sell(1, tokens))
            self.assertIn("売りました", message)
            self.assertEqual(events, ["flush", "credit"])
            reloaded = market_core.MarketStore(
                Path(tmp) / "market.json", rng=random.Random(42))
            self.assertEqual(reloaded.token_balance("1"), 0.0)


# ---------------------------------------------------------------------------
# E-5b: 市場モーダルの NaN/inf
# ---------------------------------------------------------------------------

class TradeModalFiniteTest(unittest.TestCase):
    def _modal(self, side, raw):
        cog = SimpleNamespace(
            execute_buy=mock.AsyncMock(return_value="bought"),
            execute_sell=mock.AsyncMock(return_value="sold"))
        modal = TradeModal(cog, side)
        modal.amount._value = raw
        return modal, cog

    def test_nan_and_inf_rejected_without_state_change(self):
        for raw in ("nan", "inf", "-inf", "NaN", "Infinity"):
            for side in ("buy", "sell"):
                with self.subTest(raw=raw, side=side):
                    modal, cog = self._modal(side, raw)
                    interaction = _FakeInteraction(user_id=1)
                    asyncio.run(modal.on_submit(interaction))
                    self.assertEqual(len(interaction.response.sent), 1)
                    args, kwargs = interaction.response.sent[0]
                    self.assertEqual(args[0], MARKET_INVALID_AMOUNT)
                    self.assertTrue(kwargs.get("ephemeral"))
                    self.assertFalse(interaction.response.deferred)
                    cog.execute_buy.assert_not_called()
                    cog.execute_sell.assert_not_called()

    def test_finite_value_still_trades(self):
        modal, cog = self._modal("buy", "100")
        interaction = _FakeInteraction(user_id=1)
        asyncio.run(modal.on_submit(interaction))
        cog.execute_buy.assert_called_once_with(1, 100)


# ---------------------------------------------------------------------------
# E-5c: アイテム購入の返金失敗
# ---------------------------------------------------------------------------

class ItemBuyRefundFailureTest(unittest.TestCase):
    def test_refund_none_reports_critical_and_contact(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items_core.ItemStore(Path(tmp) / "items.json")
            calls = {"n": 0}

            class _Wallet:
                async def _change_balance(self, user_id, delta, *,
                                           require_funds=False,
                                           create_with=None):
                    calls["n"] += 1
                    if delta < 0:
                        return 1000 + delta  # debit 成功
                    return None  # 返金は CAS 枯渇で失敗

            bot = _FakeBot({"WalletCog": _Wallet()})
            cog = ItemsCog(bot, store=store)
            with mock.patch.object(
                    store, "add",
                    side_effect=items_core.ItemError("追加できませんでした。")):
                with self.assertLogs(level="CRITICAL") as logs:
                    message = asyncio.run(cog.execute_buy(1, "scrap", 1))
            self.assertIn("返金", message)
            self.assertIn("運営へ連絡", message)
            self.assertTrue(any("返金に失敗" in line for line in logs.output))

    def test_refund_success_keeps_original_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = items_core.ItemStore(Path(tmp) / "items.json")

            class _Wallet:
                async def _change_balance(self, user_id, delta, *,
                                           require_funds=False,
                                           create_with=None):
                    return 1000 + delta if delta < 0 else 1000

            bot = _FakeBot({"WalletCog": _Wallet()})
            cog = ItemsCog(bot, store=store)
            with mock.patch.object(
                    store, "add",
                    side_effect=items_core.ItemError("追加できませんでした。")):
                message = asyncio.run(cog.execute_buy(1, "scrap", 1))
            self.assertIn("追加できませんでした", message)
            self.assertNotIn("運営へ連絡", message)


if __name__ == "__main__":
    unittest.main()
