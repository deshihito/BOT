"""AGO WORLD BOX 経済ブリッジ（Bot 側ワーカー）のテスト。

kv / wallet / 原資ストア / 履歴記録は CirculationCog への注入と同じ
シームでフェイクに差し替える（実モジュールは discord / config を
import しないため、この環境でもそのまま検証できる）。
"""

from __future__ import annotations

import time
import unittest

from core.general.circulation import worldbox_economy as wb

ME = "611111111111111111"
OTHER = "622222222222222222"
NEW_USER_BALANCE = 10_000


class FakeKV:
    def __init__(self) -> None:
        self.store: dict[str, object] = {}
        self.fail_load = False
        self.set_calls = 0
        self.fail_set_call_numbers: set[int] = set()
        self.deleted: list[str] = []

    async def load_all(self):
        if self.fail_load:
            raise ConnectionError("down")
        return dict(self.store)

    async def load_one(self, key):
        return self.store.get(key)

    async def set(self, key, value):
        self.set_calls += 1
        if self.set_calls in self.fail_set_call_numbers:
            raise ConnectionError("down")
        self.store[key] = value

    async def delete(self, key):
        self.deleted.append(key)
        self.store.pop(key, None)


class FakeRPCError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class FakeWallet:
    INSUFFICIENT = object()

    def __init__(self) -> None:
        self.balances: dict[str, int] = {}
        self.change_calls: list[tuple[str, int]] = []
        self.none_on_positive = False
        self.none_on_positive_once = False
        self.transfer_mode = "ok"  # ok / rpc_down / rpc_42883 / boom

    async def _change_balance(self, user_id, delta, *, require_funds=False, create_with=None):
        self.change_calls.append((user_id, delta))
        if self.none_on_positive_once and delta > 0:
            self.none_on_positive_once = False
            return None
        if self.none_on_positive and delta > 0:
            return None
        if user_id not in self.balances:
            if require_funds:
                return self.INSUFFICIENT
            base = create_with if create_with is not None else 0
            self.balances[user_id] = base + delta
            return self.balances[user_id]
        new_value = self.balances[user_id] + delta
        if require_funds and new_value < 0:
            return self.INSUFFICIENT
        self.balances[user_id] = new_value
        return new_value

    async def _transfer_atomic(self, sender_id, receiver_id, amount):
        if self.transfer_mode == "rpc_down":
            raise FakeRPCError("RPC_NOT_ALLOWED")
        if self.transfer_mode == "rpc_42883":
            raise FakeRPCError("42883")
        if self.transfer_mode == "boom":
            raise RuntimeError("unexpected")
        if self.balances.get(sender_id, 0) < amount:
            raise RuntimeError("insufficient in rpc")
        self.balances[sender_id] -= amount
        self.balances[receiver_id] = self.balances.get(receiver_id, 0) + amount
        return self.balances[sender_id]


class FakeEconomyStore:
    def __init__(self, pool: int = 0, treasury: int = 0) -> None:
        self.pool = pool
        self.treasury = treasury
        self.pay_calls = 0

    def pay_house(self, amount: int):
        self.pay_calls += 1
        paid = min(amount, self.pool + self.treasury)
        from_pool = min(self.pool, paid)
        self.pool -= from_pool
        self.treasury -= paid - from_pool
        return {"paid": paid, "pool": from_pool, "treasury": paid - from_pool}

    def refund_house(self, breakdown) -> None:
        self.pool += int(breakdown.get("pool") or 0)
        self.treasury += int(breakdown.get("treasury") or 0)

    def add_loss(self, amount: int):
        pool_part = int(amount * 0.7)
        self.pool += pool_part
        self.treasury += amount - pool_part
        return {"pool": pool_part, "treasury": amount - pool_part}


class WorkerCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.kv = FakeKV()
        self.applied = FakeKV()
        self.metrics = FakeKV()
        self.wallet = FakeWallet()
        self.store = FakeEconomyStore()
        self.history: list[tuple[str, str, int, str]] = []
        self.wallet_available = True

        async def record(sender, receiver, amount, reason):
            self.history.append((sender, receiver, amount, reason))

        async def read_balance(user_id):
            return self.wallet.balances.get(user_id, 0)

        self.worker = wb.WorldBoxEconomyWorker(
            kv=self.kv,
            wallet_provider=lambda: self.wallet if self.wallet_available else None,
            economy_store=self.store,
            record_history=record,
            insufficient_marker=FakeWallet.INSUFFICIENT,
            new_user_balance=NEW_USER_BALANCE,
            balance_reader=read_balance,
            metrics_kv=self.metrics,
            applied_kv=self.applied,
        )
        self._seq = 0

    def add_op(self, **overrides):
        self._seq += 1
        op = {
            "id": f"op-{self._seq:04d}-test",
            "kind": "spend",
            "userKey": f"discord:{ME}",
            "discordId": ME,
            "amount": 100,
            "reason": "build_house",
            "status": "pending",
            "createdAt": 1_700_000_000_000 + self._seq,
        }
        op.update(overrides)
        self.kv.store[op["id"]] = op
        return op

    def record(self, op_id: str):
        return self.kv.store[op_id]


class TestParseOp(unittest.TestCase):
    def test_accepts_dict_and_json_string(self):
        raw = {
            "id": "op-1", "kind": "earn", "userKey": f"discord:{ME}",
            "discordId": ME, "amount": 10, "reason": "harvest",
            "status": "pending", "createdAt": 5,
        }
        self.assertEqual(wb.parse_op(raw)["kind"], "earn")
        import json

        self.assertEqual(wb.parse_op(json.dumps(raw))["amount"], 10)

    def test_rejects_broken_values(self):
        base = {
            "id": "op-1", "kind": "spend", "userKey": "x",
            "discordId": ME, "amount": 10, "reason": "r",
            "status": "pending", "createdAt": 5,
        }
        for patch in [
            {"amount": True}, {"amount": 0}, {"amount": 1_000_001},
            {"amount": 1.5}, {"kind": "gift"}, {"discordId": "abc"},
            {"reason": ""}, {"reason": "x" * 41}, {"createdAt": "now"},
        ]:
            self.assertIsNone(wb.parse_op({**base, **patch}), patch)
        self.assertIsNone(wb.parse_op("壊れた"))
        self.assertIsNone(wb.parse_op(None))
        # 自分宛て送金は解釈の段階で落ちる
        transfer = {**base, "kind": "transfer", "toDiscordId": ME}
        self.assertIsNone(wb.parse_op(transfer))
        # steal は奪い元が必須で、自分自身は不可
        self.assertIsNone(wb.parse_op({**base, "kind": "steal"}))
        self.assertIsNone(wb.parse_op({**base, "kind": "steal", "fromDiscordId": ME}))
        steal = wb.parse_op({**base, "kind": "steal", "fromDiscordId": OTHER})
        self.assertEqual(steal["fromDiscordId"], OTHER)


class TestSpend(WorkerCase):
    async def test_spend_success(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 700)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 300)
        self.assertIn("appliedAt", record)
        self.assertNotIn("claim", record)
        self.assertEqual(self.history, [(ME, "WORLD_BOX", 300, "build_house")])

    async def test_spend_insufficient_funds(self):
        self.wallet.balances[ME] = 100
        op = self.add_op(amount=300)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "insufficient_funds")
        self.assertEqual(self.wallet.balances[ME], 100)
        self.assertEqual(self.history, [])

    async def test_idempotent_rerun(self):
        self.wallet.balances[ME] = 1000
        self.add_op(amount=300)
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(len(self.wallet.change_calls), 1)
        self.assertEqual(self.wallet.balances[ME], 700)


class TestEarn(WorkerCase):
    async def test_earn_full_payout(self):
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=800, reason="harvest")
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 800)
        # 新規ユーザーは初期残高つきで作られ、その上に払われる
        self.assertEqual(self.wallet.balances[ME], NEW_USER_BALANCE + 800)
        self.assertEqual(self.store.pool, 4200)
        self.assertEqual(self.history, [("WORLD_BOX", ME, 800, "harvest")])

    async def test_earn_capped_by_bankroll(self):
        self.store.pool = 100
        self.store.treasury = 50
        op = self.add_op(kind="earn", amount=800, reason="arena_prize")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 150)
        self.assertEqual(self.wallet.balances[ME], NEW_USER_BALANCE + 150)
        self.assertEqual((self.store.pool, self.store.treasury), (0, 0))

    async def test_earn_zero_bankroll_records_zero(self):
        op = self.add_op(kind="earn", amount=800, reason="harvest")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 0)
        self.assertEqual(self.wallet.change_calls, [])
        self.assertEqual(self.history, [])

    async def test_earn_credit_failure_refunds_house(self):
        self.store.pool = 5000
        self.wallet.none_on_positive = True
        op = self.add_op(kind="earn", amount=800, reason="harvest")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "credit_failed")
        self.assertEqual(self.store.pool, 5000, "原資は refund_house で戻る")
        self.assertEqual(self.history, [])

    async def test_earn_reason_whitelist(self):
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=800, reason="cheat")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "invalid_reason")
        self.assertEqual(self.store.pay_calls, 0)

    async def test_earn_shop_sale_reason(self):
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=120, reason="shop_sale")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 120)

    async def test_earn_arena_pvp_prize_reason(self):
        # 闘技場PvP の賞金（バッチ7c）: ホワイトリストに無いと invalid_reason で落ちる
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=240, reason="arena_pvp_prize")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 240)

    async def test_earn_arena_tournament_prize_reason(self):
        # 闘技場大会の優勝賞金（バッチ7c）: 参加費の総額を優勝者が受け取る
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=1600, reason="arena_tournament_prize")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 1600)

    async def test_earn_arena_tournament_refund_reason(self):
        # 闘技場大会の不成立時の返金（バッチ7c）: 参加費を返す
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=200, reason="arena_tournament_refund")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 200)

    async def test_earn_casino_tournament_prize_reason(self):
        # カジノ大会の賞金（バッチ7c）: 純益上位への配分
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=800, reason="casino_tournament_prize")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 800)

    async def test_earn_casino_tournament_refund_reason(self):
        # カジノ大会の不成立時の返金（バッチ7c）: 参加費を返す
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=200, reason="casino_tournament_refund")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 200)

    async def test_earn_work_reason_rejected(self):
        # 労働は廃止（2026-11-16）: earn の許可リストから外れたため適用しない
        self.store.pool = 5000
        op = self.add_op(kind="earn", amount=120, reason="work")
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "invalid_reason")
        self.assertEqual(self.store.pay_calls, 0)


class TestTransfer(WorkerCase):
    def add_transfer(self, amount: int = 400):
        return self.add_op(kind="transfer", amount=amount, reason="transfer", toDiscordId=OTHER)

    async def test_transfer_via_rpc(self):
        self.wallet.balances[ME] = 1000
        op = self.add_transfer()
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 400)
        self.assertEqual(self.wallet.balances[ME], 600)
        self.assertEqual(self.wallet.balances[OTHER], 400)
        self.assertEqual(self.history, [(ME, OTHER, 400, "transfer")])

    async def test_transfer_rpc_unavailable_falls_back(self):
        for mode in ("rpc_down", "rpc_42883"):
            self.setUp()
            self.wallet.transfer_mode = mode
            self.wallet.balances[ME] = 1000
            op = self.add_transfer()
            await self.worker.poll_once()
            self.assertEqual(self.record(op["id"])["status"], "done", mode)
            # 受け手が新規なら WalletCog.pay と同じく初期残高 + 送金額になる
            self.assertEqual(self.wallet.balances[OTHER], NEW_USER_BALANCE + 400, mode)

    async def test_transfer_insufficient_in_fallback(self):
        self.wallet.transfer_mode = "rpc_down"
        self.wallet.balances[ME] = 100
        op = self.add_transfer()
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "insufficient_funds")
        self.assertNotIn(OTHER, self.wallet.balances)
        self.assertEqual(self.history, [])

    async def test_transfer_rpc_error_fails_without_moving(self):
        self.wallet.transfer_mode = "boom"
        self.wallet.balances[ME] = 1000
        op = self.add_transfer()
        await self.worker.poll_once()
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "transfer_failed")
        self.assertEqual(self.wallet.balances[ME], 1000)
        self.assertNotIn(OTHER, self.wallet.balances)


class TestSteal(WorkerCase):
    def add_steal(self, amount: int = 50):
        # discordId = 実行者（受け手）、fromDiscordId = 被害者
        return self.add_op(kind="steal", amount=amount, reason="steal", fromDiscordId=OTHER)

    async def test_steal_is_disabled_and_moves_nothing(self):
        # steal は一旦廃止（2026-11-16）: キューに残ったオプは金を動かさず
        # failed(steal_disabled) で終端化される
        self.wallet.balances[OTHER] = 400
        self.wallet.balances[ME] = 100
        op = self.add_steal(50)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "steal_disabled")
        self.assertEqual(self.wallet.balances[OTHER], 400)
        self.assertEqual(self.wallet.balances[ME], 100)
        self.assertEqual(self.wallet.change_calls, [])
        self.assertEqual(self.history, [])


class TestGamble(WorkerCase):
    def gamble_op(self, **overrides):
        base = {"kind": "gamble", "amount": 100, "reason": "casino_slot", "payout": 0}
        base.update(overrides)
        return self.add_op(**base)

    async def test_gamble_loss_recycles_bet(self):
        self.wallet.balances[ME] = 1000
        op = self.gamble_op(payout=0)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 0)
        self.assertEqual(self.wallet.balances[ME], 900)
        # 負けたベットは還流する（70% プール / 30% 国庫）
        self.assertEqual(self.store.pool, 70)
        self.assertEqual(self.store.treasury, 30)
        self.assertEqual(self.history, [(ME, wb.WORLDBOX_ID, 100, "casino_slot")])

    async def test_gamble_win_pays_profit_from_bankroll(self):
        self.wallet.balances[ME] = 1000
        self.store.pool = 1000
        op = self.gamble_op(payout=350)  # 利益 250 はバンクロールから
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 350)
        self.assertEqual(self.wallet.balances[ME], 1000 - 100 + 350)
        self.assertEqual(self.store.pool, 1000 - 250)

    async def test_gamble_win_capped_by_bankroll(self):
        self.wallet.balances[ME] = 1000
        self.store.pool = 40  # 利益 250 に対して原資 40 しかない
        op = self.gamble_op(payout=350)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        # ベット分 100 は戻り、利益は確保できた 40 だけ
        self.assertEqual(record["appliedAmount"], 140)
        self.assertEqual(self.wallet.balances[ME], 1000 - 100 + 140)

    async def test_gamble_insufficient_funds_pays_nothing(self):
        self.wallet.balances[ME] = 50
        self.store.pool = 1000
        op = self.gamble_op(payout=30000)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "insufficient_funds")
        self.assertEqual(self.wallet.balances[ME], 50)
        self.assertEqual(self.store.pool, 1000)
        self.assertEqual(self.history, [])

    async def test_gamble_reason_whitelist(self):
        self.wallet.balances[ME] = 1000
        op = self.gamble_op(reason="cheat", payout=0)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "invalid_reason")
        self.assertEqual(self.wallet.balances[ME], 1000)

    async def test_gamble_missing_payout_is_invalid_op(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(kind="gamble", amount=100, reason="casino_slot")
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "invalid_op")
        self.assertEqual(self.wallet.balances[ME], 1000)

    async def test_gamble_credit_failure_refunds_bet_and_house(self):
        self.wallet.balances[ME] = 1000
        self.store.pool = 1000
        self.wallet.none_on_positive_once = True  # 配当の入金だけが失敗する
        op = self.gamble_op(payout=350)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "credit_failed")
        # ベットは返金され、原資も戻る（発行も喪失もしない）
        self.assertEqual(self.wallet.balances[ME], 1000)
        self.assertEqual(self.store.pool, 1000)


class TestGamblePrepaid(WorkerCase):
    """セッション型カジノの精算（prepaid）: ベットは spend で先払い済み。"""

    def gamble_op(self, **overrides):
        base = {"kind": "gamble", "amount": 100, "reason": "casino_double",
                "payout": 0, "prepaid": True}
        base.update(overrides)
        return self.add_op(**base)

    async def test_prepaid_loss_recycles_without_debit(self):
        self.wallet.balances[ME] = 900  # 先払いで 100 引かれた後
        op = self.gamble_op(payout=0)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 0)
        # 二重に引かず、ベットは還流する
        self.assertEqual(self.wallet.balances[ME], 900)
        self.assertEqual(self.store.pool, 70)
        self.assertEqual(self.store.treasury, 30)
        self.assertEqual(self.history, [])

    async def test_prepaid_win_pays_stake_and_profit(self):
        self.wallet.balances[ME] = 900
        self.store.pool = 1000
        op = self.gamble_op(payout=250)  # 利益 150 はバンクロールから
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 250)
        self.assertEqual(self.wallet.balances[ME], 900 + 250)
        self.assertEqual(self.store.pool, 1000 - 150)

    async def test_prepaid_partial_return_recycles_difference(self):
        self.wallet.balances[ME] = 900
        op = self.gamble_op(amount=100, payout=30, reason="casino_slot7")
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 30)
        self.assertEqual(self.wallet.balances[ME], 930)
        # 戻らなかった 70 は負けとして還流（70% プール / 30% 国庫）
        self.assertEqual(self.store.pool, 49)
        self.assertEqual(self.store.treasury, 21)

    async def test_prepaid_new_reasons_accepted(self):
        self.wallet.balances[ME] = 1000
        for reason in ("casino_dice", "casino_slot7", "casino_blackjack", "casino_double"):
            op = self.gamble_op(reason=reason, payout=0)
            self.assertEqual(await self.worker.poll_once(), 1)
            self.assertEqual(self.record(op["id"])["status"], "done", reason)

    async def test_prepaid_credit_failure_does_not_refund_bet(self):
        self.wallet.balances[ME] = 900
        self.store.pool = 1000
        self.wallet.none_on_positive_once = True
        op = self.gamble_op(payout=250)
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.record(op["id"])
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "credit_failed")
        # 先払い済みのベットはこのオプでは返金しない（原資だけ戻る）
        self.assertEqual(self.wallet.balances[ME], 900)
        self.assertEqual(self.store.pool, 1000)


class TestQueueBehavior(WorkerCase):
    async def test_invalid_ops_are_tombstoned_and_queue_drains(self):
        self.kv.store["garbage"] = "読めない値"
        self.kv.store["broken"] = {"id": "broken", "status": "pending"}
        self.wallet.balances[ME] = 1000
        good = self.add_op(amount=50)
        self.assertEqual(await self.worker.poll_once(), 3)
        self.assertEqual(self.kv.store["garbage"]["status"], "failed")
        self.assertEqual(self.kv.store["garbage"]["error"], "invalid_op")
        self.assertEqual(self.kv.store["broken"]["status"], "failed")
        self.assertEqual(self.record(good["id"])["status"], "done")

    async def test_non_pending_records_are_untouched(self):
        done = self.add_op(status="done")
        failed = self.add_op(status="failed")
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.record(done["id"])["status"], "done")
        self.assertEqual(self.record(failed["id"])["status"], "failed")
        self.assertEqual(self.wallet.change_calls, [])

    async def test_kv_failure_returns_zero_and_recovers(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=10)
        self.kv.fail_load = True
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.record(op["id"])["status"], "pending")
        self.kv.fail_load = False
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.record(op["id"])["status"], "done")

    async def test_wallet_missing_leaves_ops_pending(self):
        self.wallet_available = False
        op = self.add_op()
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.record(op["id"])["status"], "pending")

    async def test_wallet_provider_raising_is_absorbed(self):
        # wallet 取得が例外を投げる実装でも poll_once は落とさない
        # （例外が外に出ると tasks.loop ごと止まり、経済処理が無言で死ぬ）
        def boom():
            raise RuntimeError("WalletCog not loaded")

        self.worker._wallet_provider = boom
        op = self.add_op()
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.record(op["id"])["status"], "pending")
        self.worker._wallet_provider = lambda: self.wallet
        self.wallet.balances[ME] = 1000
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.record(op["id"])["status"], "done")

    async def test_batch_is_bounded(self):
        self.wallet.balances[ME] = 10_000_000
        for _ in range(wb.MAX_BATCH + 3):
            self.add_op(amount=1)
        self.assertEqual(await self.worker.poll_once(), wb.MAX_BATCH)
        self.assertEqual(await self.worker.poll_once(), 3)

    async def test_fresh_claim_blocks_and_stale_claim_reclaims(self):
        now_ms = int(time.time() * 1000)
        fresh = self.add_op()
        fresh["claim"] = {"token": "someone-else", "at": now_ms}
        self.wallet.balances[ME] = 1000
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.record(fresh["id"])["status"], "pending")
        fresh["claim"] = {"token": "someone-else", "at": now_ms - int(wb.CLAIM_STALE_SECONDS * 1000) - 1000}
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.record(fresh["id"])["status"], "done")


class TestAppliedLedger(unittest.IsolatedAsyncioTestCase):
    """適用台帳（worldbox_economy_applied）の冪等化を検証する。

    (a) 結果の書き戻し失敗 → 再処理で二重適用しない
    (b) applied 済み → 結果だけ復旧する（計測も二重加算しない）
    (c) applying のみ → apply_uncertain で安全側に倒す
    (d) 確定失敗の台帳 → 記録済みエラーで終端化し直す
    """

    def setUp(self) -> None:
        self.kv = FakeKV()
        self.applied = FakeKV()
        self.metrics = FakeKV()
        self.wallet = FakeWallet()
        self.store = FakeEconomyStore()
        self.history: list[tuple[str, str, int, str]] = []

        async def record(sender, receiver, amount, reason):
            self.history.append((sender, receiver, amount, reason))

        self._record = record

        async def read_balance(user_id):
            return self.wallet.balances.get(user_id, 0)

        self.worker = wb.WorldBoxEconomyWorker(
            kv=self.kv,
            wallet_provider=lambda: self.wallet,
            economy_store=self.store,
            record_history=record,
            insufficient_marker=FakeWallet.INSUFFICIENT,
            new_user_balance=NEW_USER_BALANCE,
            balance_reader=read_balance,
            metrics_kv=self.metrics,
            applied_kv=self.applied,
        )
        self._seq = 0

    def add_op(self, **overrides):
        self._seq += 1
        op = {
            "id": f"op-{self._seq:04d}-ledger",
            "kind": "spend",
            "userKey": f"discord:{ME}",
            "discordId": ME,
            "amount": 300,
            "reason": "build_house",
            "status": "pending",
            "createdAt": 1_700_000_000_000 + self._seq,
        }
        op.update(overrides)
        self.kv.store[op["id"]] = op
        return op

    def _age_claim(self, op_id: str) -> None:
        record = self.kv.store[op_id]
        record["claim"]["at"] -= int(wb.CLAIM_STALE_SECONDS * 1000) + 1000

    async def test_result_write_failure_does_not_double_apply(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        # 経済 kv への set は claim（1回目）→ 結果の書き戻し（2回目）の順。
        # 書き戻しだけ落とす。
        self.kv.fail_set_call_numbers = {2}
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 700)
        self.assertEqual(self.kv.store[op["id"]]["status"], "pending")
        self.assertEqual(self.applied.store[op["id"]]["status"], "applied")
        self.assertEqual(self.applied.store[op["id"]]["appliedAmount"], 300)
        self.kv.fail_set_call_numbers = set()
        self._age_claim(op["id"])
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 700, "二重適用してはいけない")
        self.assertEqual(len(self.wallet.change_calls), 1)
        record = self.kv.store[op["id"]]
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 300)
        self.assertEqual(len(self.worker._metric_buffer), 1, "計測も二重加算しない")

    async def test_applied_ledger_restores_done_without_reapplying(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.applied.store[op["id"]] = {
            "status": "applied", "appliedAmount": 300,
            "metricRecorded": False, "at": 1,
        }
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 1000)
        self.assertEqual(self.wallet.change_calls, [])
        record = self.kv.store[op["id"]]
        self.assertEqual(record["status"], "done")
        self.assertEqual(record["appliedAmount"], 300)
        self.assertEqual(len(self.worker._metric_buffer), 1)
        self.assertIs(self.applied.store[op["id"]]["metricRecorded"], True)

    async def test_applied_ledger_with_metric_recorded_skips_metric(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.applied.store[op["id"]] = {
            "status": "applied", "appliedAmount": 300,
            "metricRecorded": True, "at": 1,
        }
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.change_calls, [])
        self.assertEqual(self.kv.store[op["id"]]["status"], "done")
        self.assertEqual(len(self.worker._metric_buffer), 0)

    async def test_applying_only_becomes_apply_uncertain(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.applied.store[op["id"]] = {"status": "applying", "at": 1}
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 1000)
        self.assertEqual(self.wallet.change_calls, [])
        record = self.kv.store[op["id"]]
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "apply_uncertain")

    async def test_failed_ledger_rewrites_failed_without_reapplying(self):
        self.wallet.balances[ME] = 100
        op = self.add_op(amount=300)
        self.applied.store[op["id"]] = {
            "status": "failed", "error": "insufficient_funds", "at": 1,
        }
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 100)
        self.assertEqual(self.wallet.change_calls, [])
        record = self.kv.store[op["id"]]
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "insufficient_funds")

    async def test_normal_flow_writes_applied_ledger(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.assertEqual(await self.worker.poll_once(), 1)
        entry = self.applied.store[op["id"]]
        self.assertEqual(entry["status"], "applied")
        self.assertEqual(entry["appliedAmount"], 300)
        self.assertIs(entry["metricRecorded"], True)
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.wallet.balances[ME], 700)
        self.assertEqual(len(self.wallet.change_calls), 1)

    async def test_failed_op_writes_failed_ledger(self):
        self.wallet.balances[ME] = 100
        op = self.add_op(amount=300)
        self.assertEqual(await self.worker.poll_once(), 1)
        entry = self.applied.store[op["id"]]
        self.assertEqual(entry["status"], "failed")
        self.assertEqual(entry["error"], "insufficient_funds")
        # 残高不足の判定自体は _change_balance の呼び出し1回で済んでいる
        self.assertEqual(len(self.wallet.change_calls), 1)
        # 結果の書き戻しが失敗して再処理されても apply_uncertain にならない
        # （_write_result は claim を落とすので、pending に戻すだけで再処理される）
        self.kv.store[op["id"]]["status"] = "pending"
        self.assertEqual(await self.worker.poll_once(), 1)
        record = self.kv.store[op["id"]]
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error"], "insufficient_funds")
        self.assertEqual(len(self.wallet.change_calls), 1, "再処理で財布に触ってはいけない")

    async def test_applying_write_failure_blocks_apply(self):
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.applied.fail_set_call_numbers = {1}
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertEqual(self.wallet.balances[ME], 1000)
        self.assertEqual(self.wallet.change_calls, [])
        self.assertEqual(self.kv.store[op["id"]]["status"], "pending")
        self.applied.fail_set_call_numbers = set()
        self._age_claim(op["id"])
        self.assertEqual(await self.worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 700)
        self.assertEqual(self.kv.store[op["id"]]["status"], "done")

    async def test_terminal_ops_prune_their_ledger(self):
        op_id = "op-done-ledger"
        self.kv.store[op_id] = {"id": op_id, "status": "done", "appliedAt": 100}
        self.applied.store[op_id] = {
            "status": "applied", "appliedAmount": 300,
            "metricRecorded": True, "at": 1,
        }
        self.worker._last_full_scan_ms = 0
        self.assertEqual(await self.worker.poll_once(), 0)
        self.assertNotIn(op_id, self.applied.store)
        self.assertIn(op_id, self.kv.store)

    async def test_worker_without_applied_kv_keeps_old_behavior(self):
        worker = wb.WorldBoxEconomyWorker(
            kv=self.kv,
            wallet_provider=lambda: self.wallet,
            economy_store=self.store,
            record_history=self._record,
            insufficient_marker=FakeWallet.INSUFFICIENT,
            new_user_balance=NEW_USER_BALANCE,
            metrics_kv=self.metrics,
        )
        self.wallet.balances[ME] = 1000
        op = self.add_op(amount=300)
        self.assertEqual(await worker.poll_once(), 1)
        self.assertEqual(self.wallet.balances[ME], 700)
        self.assertEqual(self.kv.store[op["id"]]["status"], "done")
        self.assertEqual(self.applied.store, {})


class TestParseApplied(unittest.TestCase):
    def test_none_is_absent(self):
        self.assertIsNone(wb.WorldBoxEconomyWorker._parse_applied(None))

    def test_applied_entry_is_normalized(self):
        entry = wb.WorldBoxEconomyWorker._parse_applied(
            {"status": "applied", "appliedAmount": 300, "metricRecorded": True}
        )
        self.assertEqual(entry, {"status": "applied", "appliedAmount": 300, "metricRecorded": True})

    def test_broken_entry_is_applying(self):
        parse = wb.WorldBoxEconomyWorker._parse_applied
        self.assertEqual(parse("読めない値"), {"status": "applying"})
        self.assertEqual(parse({"status": "weird"}), {"status": "applying"})
        self.assertEqual(parse({"status": "applied", "appliedAmount": "300"}),
                         {"status": "applied", "appliedAmount": 0, "metricRecorded": False})


class TestNextPollDelay(unittest.TestCase):
    def test_full_batch_repolls_immediately(self):
        self.assertEqual(wb.next_poll_delay(wb.MAX_BATCH, 5.0), 0.0)
        self.assertEqual(wb.next_poll_delay(wb.MAX_BATCH + 1, 0.4), 0.0)

    def test_busy_when_anything_handled(self):
        self.assertEqual(wb.next_poll_delay(1, 5.0), wb.POLL_BUSY_SECONDS)
        self.assertEqual(wb.next_poll_delay(3, 0.1), wb.POLL_BUSY_SECONDS)

    def test_idle_backs_off_exponentially_to_cap(self):
        delay = wb.POLL_BUSY_SECONDS
        seen = []
        for _ in range(6):
            delay = wb.next_poll_delay(0, delay)
            seen.append(delay)
        self.assertEqual(seen[0], wb.POLL_BUSY_SECONDS * 2)
        self.assertTrue(all(b >= a for a, b in zip(seen, seen[1:])))
        self.assertEqual(seen[-1], wb.POLL_SECONDS)
        self.assertEqual(wb.next_poll_delay(0, wb.POLL_SECONDS), wb.POLL_SECONDS)


class TestAdaptiveEconomyLoop(unittest.IsolatedAsyncioTestCase):
    async def test_loop_survives_poll_exceptions_and_cancels(self):
        import asyncio

        calls = {"n": 0}

        class FlakyWorker:
            async def poll_once(self):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("boom")
                return 0

        loop = wb.AdaptiveEconomyLoop(FlakyWorker())
        self.assertFalse(loop.is_running())
        loop.start()
        loop.start()  # 二重起動は無視される
        self.assertTrue(loop.is_running())
        # 例外を吸収して2回目以降も回り続ける（無言死しない）
        for _ in range(100):
            if calls["n"] >= 3:
                break
            await asyncio.sleep(0.05)
        self.assertGreaterEqual(calls["n"], 3)
        self.assertTrue(loop.is_running())
        loop.cancel()
        self.assertFalse(loop.is_running())
        await asyncio.sleep(0.05)

    async def test_loop_waits_for_before_callback(self):
        import asyncio

        ready = asyncio.Event()
        polled = asyncio.Event()

        class Worker:
            async def poll_once(self):
                polled.set()
                return 0

        async def before():
            await ready.wait()

        loop = wb.AdaptiveEconomyLoop(Worker(), before=before)
        loop.start()
        await asyncio.sleep(0.05)
        self.assertFalse(polled.is_set())
        ready.set()
        await asyncio.wait_for(polled.wait(), timeout=2)
        loop.cancel()


if __name__ == "__main__":
    unittest.main()


def test_apply_metric_aggregates_by_reason():
    from core.general.circulation.worldbox_economy import apply_metric

    rec = apply_metric(None, {"kind": "earn", "reason": "shop_sale"}, 120, 5000)
    assert rec == {"earn": {"shop_sale": 120}, "spend": {}, "bankroll": 5000}
    rec = apply_metric(rec, {"kind": "earn", "reason": "shop_sale"}, 30, 4800)
    rec = apply_metric(rec, {"kind": "spend", "reason": "arena_entry"}, 50, 4800)
    rec = apply_metric(rec, {"kind": "gamble", "reason": "casino_slot", "amount": 200}, 450, None)
    rec = apply_metric(rec, {"kind": "transfer", "reason": "gift"}, 999, None)
    assert rec["earn"]["shop_sale"] == 150
    assert rec["spend"]["arena_entry"] == 50
    assert rec["spend"]["casino_bet"] == 200
    assert rec["earn"]["casino_payout"] == 450
    assert "gift" not in rec["earn"] and "gift" not in rec["spend"]
    assert rec["bankroll"] == 4800  # None では更新しない


def test_wbstate_lines_format():
    from core.support.worldbox.state import build_state_lines

    lines = build_state_lines(
        user_id="123",
        balance=1500,
        profile={
            "hp": 80, "hunger": 55, "role": "blade",
            "mastery": {"blade": {"xp": 90}},
            "items": {"wood": 5, "iron_sword": 1, "stone": 3},
        },
        presence={"space": "world", "x": 10.5, "y": -3.2},
        save=None,
        nation_name="テスト国",
        nation_role="king",
    )
    text = "\n".join(lines)
    assert "1,500" in text
    assert "HP 80" in text and "剣士" in text and "ランク 3" in text
    assert "計 9 個" in text
    assert "world" in text
    assert "テスト国" in text
    empty = build_state_lines(
        user_id="999", balance=None, profile=None, presence=None,
        save=None, nation_name=None, nation_role=None,
    )
    assert "未プレイ" in "\n".join(empty)


class MatchingKV(FakeKV):
    """load_matching / delete を持つ KV（本番の remote_only ストア相当）。"""

    def __init__(self) -> None:
        super().__init__()
        self.matching_calls = 0
        self.load_all_calls = 0
        self.deleted: list[str] = []

    async def load_all(self):
        self.load_all_calls += 1
        return await super().load_all()

    async def load_matching(self, match):
        self.matching_calls += 1
        return {
            k: v for k, v in self.store.items()
            if isinstance(v, dict) and all(v.get(kk) == vv for kk, vv in match.items())
        }

    async def delete(self, key):
        self.deleted.append(key)
        self.store.pop(key, None)


class CountingMetricsKV(FakeKV):
    def __init__(self) -> None:
        super().__init__()
        self.set_calls = 0

    async def set(self, key, value):
        # super().set は set_calls も数えるため、ここでは直接書く
        # （計測 kv の set 回数だけを数える）。
        self.set_calls += 1
        self.store[key] = value


class TestPendingFastPath(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.kv = MatchingKV()
        self.wallet = FakeWallet()
        self.wallet.balances[ME] = 100_000
        self.store = FakeEconomyStore(pool=100_000, treasury=0)
        self.history: list = []
        self.metrics = CountingMetricsKV()

        async def record(sender, receiver, amount, reason):
            self.history.append((sender, receiver, amount, reason))

        self.worker = wb.WorldBoxEconomyWorker(
            kv=self.kv,
            wallet_provider=lambda: self.wallet,
            economy_store=self.store,
            record_history=record,
            insufficient_marker=FakeWallet.INSUFFICIENT,
            new_user_balance=NEW_USER_BALANCE,
            metrics_kv=self.metrics,
        )
        self._seq = 0

    def add_op(self, **overrides):
        self._seq += 1
        op = {
            "id": f"op-{self._seq:04d}-fast",
            "kind": "spend",
            "userKey": f"discord:{ME}",
            "discordId": ME,
            "amount": 100,
            "reason": "build_house",
            "status": "pending",
            "createdAt": 1_700_000_000_000 + self._seq,
        }
        op.update(overrides)
        self.kv.store[op["id"]] = op
        return op

    async def test_poll_uses_matching_not_full_scan(self):
        op = self.add_op()
        for i in range(50):
            self.kv.store[f"old-{i}"] = {
                "id": f"old-{i}", "status": "done", "appliedAt": i,
            }
        # 直前に全件読みが済んだ状態にして、通常回の経路を検証する
        self.worker._last_full_scan_ms = wb._now_ms()
        handled = await self.worker.poll_once()
        self.assertEqual(handled, 1)
        self.assertEqual(self.kv.matching_calls, 1)
        self.assertEqual(self.kv.load_all_calls, 0)
        self.assertEqual(self.kv.store[op["id"]]["status"], "done")
        self.assertEqual(self.wallet.balances[ME], 100_000 - 100)

    async def test_full_scan_prunes_terminal_ops(self):
        keep = wb.PRUNE_KEEP_TERMINAL
        wb.PRUNE_KEEP_TERMINAL = 2
        try:
            for i in range(5):
                self.kv.store[f"term-{i}"] = {
                    "id": f"term-{i}", "status": "done", "appliedAt": 100 + i,
                }
            op = self.add_op()
            handled = await self.worker.poll_once()
        finally:
            wb.PRUNE_KEEP_TERMINAL = keep
        self.assertEqual(handled, 1)
        # 新しい2件（appliedAt 104, 103）だけ残し、古い3件を消す
        self.assertEqual(sorted(self.kv.deleted), ["term-0", "term-1", "term-2"])
        self.assertIn("term-3", self.kv.store)
        self.assertIn("term-4", self.kv.store)
        self.assertEqual(self.kv.store[op["id"]]["status"], "done")

    async def test_metrics_are_batched_until_flush(self):
        for _ in range(3):
            self.add_op()
        self.worker._last_full_scan_ms = wb._now_ms()
        handled = await self.worker.poll_once()
        self.assertEqual(handled, 3)
        # 3件では書き出さない（20件 or 10秒のどちらかまでバッファ）
        self.assertEqual(self.metrics.set_calls, 0)
        await self.worker._flush_metrics(force=True)
        self.assertEqual(self.metrics.set_calls, 1)
        (record,) = list(self.metrics.store.values())
        self.assertEqual(record["spend"]["build_house"], 300)
