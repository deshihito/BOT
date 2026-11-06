"""新規ユーザーのスターター（初期体験の階段）のテスト（2026-11-06、Phase D）。

- 受け取りは1回だけ（二重付与しない）、状態は永続化される
- 付与に失敗したら受け取り済みにしない（再試行できる）
- マネーパネル: 未受け取りのときだけボタンが出る
- 残高が少ないときだけ概要に短い導線が1行出る
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.general import starter as starter_core
from cogs import wallet as wallet_module


class StoreTest(unittest.TestCase):
    def test_try_claim_once_and_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "starter.json"
            store = starter_core.StarterStore(path)
            self.assertFalse(store.has_claimed("1"))
            self.assertTrue(store.try_claim("1"))
            self.assertFalse(store.try_claim("1"))
            store.flush()
            reloaded = starter_core.StarterStore(path)
            self.assertTrue(reloaded.has_claimed("1"))

    def test_unclaim_allows_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = starter_core.StarterStore(Path(tmp) / "starter.json")
            self.assertTrue(store.try_claim("1"))
            store.unclaim("1")
            self.assertTrue(store.try_claim("1"))


class _Wallet:
    def __init__(self, balances):
        self.balances = dict(balances)

    async def _change_balance(self, user_id, delta, *, require_funds=False,
                              create_with=None):
        uid = str(user_id)
        current = self.balances.get(uid)
        if current is None:
            if require_funds:
                return wallet_module.INSUFFICIENT
            if create_with is None:
                return None
            current = create_with
        self.balances[uid] = current + delta
        return self.balances[uid]


class _ItemStore:
    def __init__(self):
        self.added: list[tuple[str, str, int]] = []

    def add(self, user_id, item_id, amount=1):
        self.added.append((str(user_id), item_id, amount))


class _Bot:
    def __init__(self, wallet, items_cog):
        self._wallet = wallet
        self._items = items_cog

    def get_cog(self, name):
        if name == "WalletCog":
            return self._wallet
        if name == "ItemsCog":
            return self._items
        return None


class ClaimTest(unittest.TestCase):
    def _cog(self, tmp, wallet):
        from cogs.money_panel import MoneyPanelCog

        items_cog = SimpleNamespace(store=_ItemStore())
        cog = MoneyPanelCog(
            _Bot(wallet, items_cog),
            balance_reader=lambda uid: wallet.balances.get(uid, 10),
            starter_store=starter_core.StarterStore(Path(tmp) / "starter.json"))
        return cog, items_cog

    def test_claim_grants_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({})
            cog, items_cog = self._cog(tmp, wallet)
            message = asyncio.run(cog.claim_starter(1))
            self.assertIn("受け取りました", message)
            self.assertEqual(
                wallet.balances["1"],
                wallet_module.NEW_USER_BALANCE + starter_core.STARTER_COINS)
            self.assertEqual(
                items_cog.store.added,
                [("1", "scrap", starter_core.STARTER_SCRAPS)])
            # 2回目は付与しない。
            message = asyncio.run(cog.claim_starter(1))
            self.assertIn("受け取り済み", message)
            self.assertEqual(
                wallet.balances["1"],
                wallet_module.NEW_USER_BALANCE + starter_core.STARTER_COINS)
            self.assertEqual(len(items_cog.store.added), 1)

    def test_collect_status_reports_claimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            wallet = _Wallet({"1": 10})
            cog, _items = self._cog(tmp, wallet)
            status = asyncio.run(cog.collect_status(1))
            self.assertIs(status["starter_claimed"], False)
            asyncio.run(cog.claim_starter(1))
            status = asyncio.run(cog.collect_status(1))
            self.assertIs(status["starter_claimed"], True)


class PanelTest(unittest.TestCase):
    def test_button_only_when_unclaimed(self):
        from cogs.money_panel import MoneyPanelView

        view = MoneyPanelView(SimpleNamespace(), 1)
        labels = [getattr(c, "label", None) for c in view.children]
        self.assertNotIn("スターターを受け取る", labels)
        view._starter = True
        view.refresh()
        labels = [getattr(c, "label", None) for c in view.children]
        self.assertIn("スターターを受け取る", labels)

    def test_guide_line_only_for_low_balance(self):
        from cogs.money_panel import status_embed

        embed = status_embed({"balance": 10})
        self.assertIn("採掘と宝くじ", embed.description or "")
        embed = status_embed({"balance": 5000})
        self.assertIsNone(embed.description)


if __name__ == "__main__":
    unittest.main()
