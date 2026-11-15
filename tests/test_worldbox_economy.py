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

    async def load_all(self):
        if self.fail_load:
            raise ConnectionError("down")
        return dict(self.store)

    async def load_one(self, key):
        return self.store.get(key)

    async def set(self, key, value):
        self.store[key] = value


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

    async def test_earn_shop_sale_and_work_reasons(self):
        self.store.pool = 5000
        for reason in ("shop_sale", "work"):
            self.setUp()
            self.store.pool = 5000
            op = self.add_op(kind="earn", amount=120, reason=reason)
            await self.worker.poll_once()
            record = self.record(op["id"])
            self.assertEqual(record["status"], "done", reason)
            self.assertEqual(record["appliedAmount"], 120, reason)


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


if __name__ == "__main__":
    unittest.main()
