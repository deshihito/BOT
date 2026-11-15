"""AGO WORLD BOX の経済ブリッジ（Bot 側ワーカー）。

Web は残高を直接触らない。Web が bot_kv の名前空間 ``worldbox_economy``
（キー = オプID）に積んだ経済オプを、このワーカーが既存の経済機構で
適用して結果を同じレコードへ書き戻す
（設計: ago-coin-connection-design.md 案B）。

- spend: wallet から require_funds で引き落とす。残高不足は failed。
- earn: EconomyPoolStore.pay_house で原資（プール→国庫、バンクロール上限）
  を確保できた分だけ wallet へ入金する。部分払い・ゼロ払いも done として
  実際に動いた額（appliedAmount）を記録する。入金に失敗したら
  refund_house で原資を戻して failed（新規発行はしない）。
- transfer: WalletCog._transfer_atomic（transfer_coins RPC）で送金し、
  RPC が使えない環境では WalletCog.pay と同じ二段フォールバック。
- steal: fromDiscordId（被害者）→ discordId（実行者）の移転。Web 側で
  検証・抽選・額の算出まで済んでいるため、ここでは被害者の現在残高を
  上限に min(amount, 残高) だけを二段フォールバックで移し、実際に
  動いた額を appliedAmount に記録する（残高0なら done で 0）。

冪等性: status が "pending" のものだけを拾い、適用前に claim
（トークン + 時刻）を書き込んで再読込で自分の claim か確認してから
適用する。二重適用はしない。claim が古い（＝適用前に死んだ）オプは
再び拾える。失敗は status=failed + error コードとして記録し、
ループ自体は決して落とさない。接続エラーは警告1行（traceback なし）。

このモジュールは discord / config / economy_helpers を import しない。
kv・wallet・原資ストア・履歴記録は CirculationCog から差し込む
（テストはフェイクで差し替える）。
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

NAMESPACE = "worldbox_economy"
#: 送受金の相手方として履歴に残すシステムID
WORLDBOX_ID = "WORLD_BOX"
#: earn の理由ホワイトリスト（Web 側 economy-bridge.ts の EARN_REASONS と同じ集合）
EARN_REASONS = frozenset({"harvest", "guild_shop_sale", "arena_prize", "shop_sale", "work"})
OP_KINDS = frozenset({"spend", "earn", "transfer", "steal"})
AMOUNT_MIN = 1
AMOUNT_MAX = 1_000_000
REASON_MAX = 40
#: ポーリング間隔（秒。bg_cutout の 30 秒に合わせる）
POLL_SECONDS = 30.0
#: 1回のポーリングで処理する上限
MAX_BATCH = 25
#: claim がこの秒数を超えたら放棄されたものとして再処理可にする
CLAIM_STALE_SECONDS = 300.0
#: transfer_coins RPC が使えないことを示すエラーコード（WalletCog.pay と同じ判定）
RPC_FALLBACK_CODES = frozenset({"RPC_NOT_ALLOWED", "42883"})


def _now_ms() -> int:
    return int(time.time() * 1000)


def _is_discord_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.isdigit()
        and 5 <= len(value) <= 25
    )


def parse_op(raw: Any) -> Optional[dict[str, Any]]:
    """保存値をオプとして解釈する。dict でも JSON 文字列でも受ける。

    必須フィールドが壊れていれば None（呼び出し側で invalid_op として
    終端化する）。適用に必要な値だけを正規化して返す。
    """
    value = raw
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if not isinstance(value, dict):
        return None
    op_id = value.get("id")
    kind = value.get("kind")
    discord_id = value.get("discordId")
    amount = value.get("amount")
    reason = value.get("reason")
    created_at = value.get("createdAt")
    if not isinstance(op_id, str) or not op_id:
        return None
    if kind not in OP_KINDS:
        return None
    if not _is_discord_id(discord_id):
        return None
    if isinstance(amount, bool) or not isinstance(amount, int):
        return None
    if not AMOUNT_MIN <= amount <= AMOUNT_MAX:
        return None
    if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= REASON_MAX:
        return None
    if isinstance(created_at, bool) or not isinstance(created_at, (int, float)):
        return None
    op: dict[str, Any] = {
        "id": op_id,
        "kind": kind,
        "userKey": value.get("userKey") if isinstance(value.get("userKey"), str) else "",
        "discordId": discord_id,
        "amount": amount,
        "reason": reason.strip(),
        "status": value.get("status"),
        "createdAt": int(created_at),
    }
    if kind == "transfer":
        to_id = value.get("toDiscordId")
        if not _is_discord_id(to_id) or to_id == discord_id:
            return None
        op["toDiscordId"] = to_id
    if kind == "steal":
        from_id = value.get("fromDiscordId")
        if not _is_discord_id(from_id) or from_id == discord_id:
            return None
        op["fromDiscordId"] = from_id
    return op


def select_pending(records: dict[str, Any], now_ms: int, limit: int = MAX_BATCH) -> list[tuple[str, Any]]:
    """適用候補（pending で claim が無い/古いもの）を古い順に limit 件返す。

    戻り値は (キー, 生の保存値)。解釈できない pending は呼び出し側で
    invalid_op として終端化するために生のまま含める。
    """
    candidates: list[tuple[str, Any, int]] = []
    for key, raw in records.items():
        value = raw
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                value = None
        if not isinstance(value, dict):
            # この名前空間の値はすべてオプのはずで、解釈できない値は
            # invalid_op として終端化する候補に入れる（滞留させない）
            candidates.append((key, raw, 0))
            continue
        if value.get("status") != "pending":
            continue
        claim = value.get("claim")
        if isinstance(claim, dict):
            claimed_at = claim.get("at")
            if isinstance(claimed_at, (int, float)) and now_ms - int(claimed_at) < CLAIM_STALE_SECONDS * 1000:
                continue
        created = value.get("createdAt")
        sort_key = int(created) if isinstance(created, (int, float)) and not isinstance(created, bool) else 0
        candidates.append((key, raw, sort_key))
    candidates.sort(key=lambda item: (item[2], item[0]))
    return [(key, raw) for key, raw, _ in candidates[:limit]]


class _OpFailed(Exception):
    """オプを failed として記録するための内部例外（error コード付き）。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class WorldBoxEconomyWorker:
    """bot_kv の経済オプを適用するワーカー。

    seams:
    - kv: KVStore 互換（load_all / load_one / set の async メソッド）
    - wallet_provider: WalletCog を返す callable（None なら今回は何もしない）
    - economy_store: EconomyPoolStore 互換（pay_house / refund_house）
    - record_history: (sender_id, receiver_id, amount, reason) の async callable
    - insufficient_marker: WalletCog の INSUFFICIENT センチネル
      （値そのもの、または返す callable）
    - new_user_balance: 新規ユーザーの初期残高（値、または返す callable）
    - balance_reader: (user_id) -> 残高 の async callable（steal の
      被害者残高を読むため。CirculationCog._balance を渡す）
    """

    def __init__(
        self,
        *,
        kv: Any,
        wallet_provider: Callable[[], Any],
        economy_store: Any,
        record_history: Callable[[str, str, int, str], Awaitable[None]],
        insufficient_marker: Any,
        new_user_balance: Any,
        balance_reader: Optional[Callable[[str], Awaitable[int]]] = None,
    ) -> None:
        self._kv = kv
        self._wallet_provider = wallet_provider
        self._economy_store = economy_store
        self._record_history = record_history
        self._insufficient_marker = insufficient_marker
        self._new_user_balance = new_user_balance
        self._balance_reader = balance_reader
        self._remote_down = False

    def _marker(self) -> Any:
        marker = self._insufficient_marker
        return marker() if callable(marker) else marker

    def _initial_balance(self) -> int:
        value = self._new_user_balance
        return int(value() if callable(value) else value)

    async def poll_once(self) -> int:
        """pending オプを1バッチ適用する。適用（終端化）した件数を返す。

        kv の読み取りに失敗したら 0 を返して次回に回す（例外は外へ出さない）。
        """
        try:
            records = await self._kv.load_all()
        except Exception:
            if not self._remote_down:
                logger.warning("worldbox economy: bot_kv の読み取りに失敗しました（次回再試行）")
            self._remote_down = True
            return 0
        if self._remote_down:
            logger.info("worldbox economy: bot_kv への接続が回復しました")
            self._remote_down = False
        if not isinstance(records, dict) or not records:
            return 0
        wallet = self._wallet_provider()
        if wallet is None:
            return 0
        handled = 0
        for key, raw in select_pending(records, _now_ms()):
            try:
                if await self._process_one(wallet, key, raw):
                    handled += 1
            except Exception:
                logger.exception("worldbox economy: オプ処理で予期しない例外（key=%s）", key)
        return handled

    async def _process_one(self, wallet: Any, key: str, raw: Any) -> bool:
        op = parse_op(raw)
        if op is None:
            await self._write_result(key, raw, status="failed", error="invalid_op")
            return True
        # claim: 自分のトークンを書き込み、再読込で勝ちを確認してから適用する
        token = uuid.uuid4().hex
        claimed = self._merged_record(raw, op)
        claimed["claim"] = {"token": token, "at": _now_ms()}
        try:
            await self._kv.set(key, claimed)
            current = await self._kv.load_one(key)
        except Exception:
            if not self._remote_down:
                logger.warning("worldbox economy: claim の書き込みに失敗しました（key=%s）", key)
            return False
        current_op = parse_op(current)
        claim = current.get("claim") if isinstance(current, dict) else None
        if (
            current_op is None
            or current_op.get("status") != "pending"
            or not isinstance(claim, dict)
            or claim.get("token") != token
        ):
            return False  # 他のワーカーが先に claim した / 状態が変わった
        try:
            applied = await self._apply(wallet, op)
        except _OpFailed as exc:
            await self._write_result(key, claimed, status="failed", error=exc.code)
            return True
        except Exception:
            logger.exception("worldbox economy: オプ適用で予期しない例外（id=%s）", op["id"])
            await self._write_result(key, claimed, status="failed", error="apply_failed")
            return True
        await self._write_result(key, claimed, status="done", applied_amount=applied)
        return True

    @staticmethod
    def _merged_record(raw: Any, op: dict[str, Any]) -> dict[str, Any]:
        """元のレコード（未知フィールド含む）に正規化済みフィールドを重ねる。"""
        base: dict[str, Any] = {}
        if isinstance(raw, dict):
            base.update(raw)
        elif isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except (ValueError, TypeError):
                parsed = None
            if isinstance(parsed, dict):
                base.update(parsed)
        base.update(op)
        base["status"] = "pending"
        return base

    async def _write_result(
        self,
        key: str,
        base: Any,
        *,
        status: str,
        error: Optional[str] = None,
        applied_amount: Optional[int] = None,
    ) -> None:
        record: dict[str, Any] = {}
        if isinstance(base, dict):
            record.update(base)
        record.pop("claim", None)
        record["status"] = status
        record["appliedAt"] = _now_ms()
        if error is not None:
            record["error"] = error
        if applied_amount is not None:
            record["appliedAmount"] = applied_amount
        try:
            await self._kv.set(key, record)
        except Exception:
            logger.warning("worldbox economy: 結果の書き戻しに失敗しました（key=%s, status=%s）", key, status)

    # ---- 種類ごとの適用。戻り値は実際に動いた額 ----

    async def _apply(self, wallet: Any, op: dict[str, Any]) -> int:
        kind = op["kind"]
        if kind == "spend":
            return await self._apply_spend(wallet, op)
        if kind == "earn":
            return await self._apply_earn(wallet, op)
        if kind == "steal":
            return await self._apply_steal(wallet, op)
        return await self._apply_transfer(wallet, op)

    async def _apply_steal(self, wallet: Any, op: dict[str, Any]) -> int:
        """被害者 → 実行者へ、被害者の現在残高を上限に移す。

        Web 側で検証・抽選・額の算出まで済んでいる。検証時点から残高が
        減っていたら移せる分だけ移す（二段フォールバックのみを使う:
        RPC は要求額ちょうどの移転しかできず、min の意味論に合わない）。
        """
        if self._balance_reader is None:
            raise _OpFailed("balance_unavailable")
        victim = op["fromDiscordId"]
        actor = op["discordId"]
        amount = op["amount"]
        applied = 0
        for _ in range(2):
            try:
                balance = int(await self._balance_reader(victim))
            except Exception:
                raise _OpFailed("balance_unavailable")
            applied = max(0, min(amount, balance))
            if applied <= 0:
                return 0
            debit = await wallet._change_balance(victim, -applied, require_funds=True)
            if debit is self._marker():
                continue  # 読んだ後に残高が動いた。読み直して1回だけ再試行
            if debit is None:
                raise _OpFailed("transfer_failed")
            break
        else:
            return 0  # 再試行しても引き落とせない = 移せる分が無い
        credit = await wallet._change_balance(
            actor, applied, create_with=self._initial_balance(),
        )
        if credit is None or credit is self._marker():
            refund = await wallet._change_balance(victim, applied)
            if refund is None:
                logger.critical(
                    "worldbox economy: steal の返金に失敗しました（victim=%s amount=%s）",
                    victim, applied,
                )
            raise _OpFailed("transfer_failed")
        await self._record_history(victim, actor, applied, op["reason"])
        return applied

    async def _apply_spend(self, wallet: Any, op: dict[str, Any]) -> int:
        result = await wallet._change_balance(
            op["discordId"], -op["amount"], require_funds=True,
        )
        if result is self._marker():
            raise _OpFailed("insufficient_funds")
        if result is None:
            raise _OpFailed("balance_update_failed")
        await self._record_history(op["discordId"], WORLDBOX_ID, op["amount"], op["reason"])
        return op["amount"]

    async def _apply_earn(self, wallet: Any, op: dict[str, Any]) -> int:
        if op["reason"] not in EARN_REASONS:
            raise _OpFailed("invalid_reason")
        try:
            breakdown = self._economy_store.pay_house(op["amount"])
        except Exception:
            raise _OpFailed("pay_house_failed")
        paid = 0
        if isinstance(breakdown, dict):
            try:
                paid = max(0, int(breakdown.get("paid") or 0))
            except (TypeError, ValueError):
                paid = 0
        if paid > 0:
            credited = await wallet._change_balance(
                op["discordId"], paid, create_with=self._initial_balance(),
            )
            if credited is None or credited is self._marker():
                # 入金できなかった分は原資へ戻す（発行しない）
                try:
                    self._economy_store.refund_house(breakdown)
                except Exception:
                    logger.exception("worldbox economy: refund_house に失敗（id=%s）", op["id"])
                raise _OpFailed("credit_failed")
            await self._record_history(WORLDBOX_ID, op["discordId"], paid, op["reason"])
        return paid

    async def _apply_transfer(self, wallet: Any, op: dict[str, Any]) -> int:
        sender = op["discordId"]
        receiver = op["toDiscordId"]
        amount = op["amount"]
        try:
            balance = await wallet._transfer_atomic(sender, receiver, amount)
        except Exception as exc:
            if getattr(exc, "code", None) not in RPC_FALLBACK_CODES:
                raise _OpFailed("transfer_failed")
            balance = None  # RPC が使えない環境: 二段フォールバックへ
        if balance is None:
            await self._transfer_legacy(wallet, sender, receiver, amount)
        await self._record_history(sender, receiver, amount, op["reason"])
        return amount

    async def _transfer_legacy(self, wallet: Any, sender: str, receiver: str, amount: int) -> None:
        """WalletCog.pay と同じ二段フォールバック（引き落とし→入金→失敗時返金）。"""
        debit = await wallet._change_balance(sender, -amount, require_funds=True)
        if debit is self._marker():
            raise _OpFailed("insufficient_funds")
        if debit is None:
            raise _OpFailed("transfer_failed")
        credit = await wallet._change_balance(
            receiver, amount, create_with=self._initial_balance(),
        )
        if credit is None or credit is self._marker():
            refund = await wallet._change_balance(sender, amount)
            if refund is None:
                logger.critical(
                    "worldbox economy: 送金の返金に失敗しました（sender=%s amount=%s）",
                    sender, amount,
                )
            raise _OpFailed("transfer_failed")
