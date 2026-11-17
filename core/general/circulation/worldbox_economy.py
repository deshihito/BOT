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
- gamble: カジノの1プレイ（amount = ベット、payout = 確定配当の総額）。
  ベットを引き落としてから配当を払う原子的な適用で、引き落としが
  できなければ配当も払わない。配当の利益分（payout - ベット）は
  pay_house でバンクロールから確保できた分だけ払い（Plan A、
  Discord 側ギャンブルと同じ決済）、負け（payout = 0）のベットは
  add_loss で還流する（70% プール / 30% 国庫）。実際に払った総額を
  appliedAmount に記録する。prepaid = true のときはベットが spend
  オプで先払い済みなので引き落としを省き、配当の払いと負けの還流
  だけを行う（セッション型カジノの精算）。

冪等性: status が "pending" のものだけを拾い、適用前に claim
（トークン + 時刻）を書き込んで再読込で自分の claim か確認してから
適用する。二重適用はしない。claim が古い（＝適用前に死んだ）オプは
再び拾える。失敗は status=failed + error コードとして記録し、
ループ自体は決して落とさない。接続エラーは警告1行（traceback なし）。

さらに適用台帳（bot_kv 名前空間 ``worldbox_economy_applied``、
キー = オプID）で「財布への適用そのもの」を冪等化する。適用前に
``applying`` を書き、適用が終わったら ``applied`` + 適用額を書く。
結果の書き戻しが失敗して同じオプが再処理されても、台帳が
``applied`` なら適用をスキップして結果だけ書き直す。台帳が
``applying`` のまま（適用の成否が曖昧）なら再適用せず
failed=apply_uncertain として安全側に倒す。残高不足等の確定失敗は
台帳も ``failed`` で終端化し、再処理で apply_uncertain に化けない
ようにする。台帳は終端オプの間引きのタイミングで一緒に消す。

このモジュールは discord / config / economy_helpers を import しない。
kv・wallet・原資ストア・履歴記録は CirculationCog から差し込む
（テストはフェイクで差し替える）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

NAMESPACE = "worldbox_economy"
#: 計測（日次経済集計）の保存先名前空間（バッチ9a）
METRICS_NAMESPACE = "worldbox_metrics_econ"
#: 適用台帳の保存先名前空間（B1: 財布への適用そのものの冪等化）。
#: キー = オプID、値 = {"status": "applying"|"applied"|"failed",
#: "appliedAmount": int, "metricRecorded": bool, "error": str, "at": ms}
APPLIED_NAMESPACE = "worldbox_economy_applied"


def apply_metric(record: Any, op: dict[str, Any], applied: int, bankroll: Optional[int]) -> dict[str, Any]:
    """日次経済集計に1オプぶんを足す（純粋関数）。

    earn は理由別に実適用額、spend も理由別。gamble はベットを
    casino_bet、配当を casino_payout として分けて数える。
    transfer / steal は内部移動なので数えない。
    """
    out: dict[str, Any] = {"earn": {}, "spend": {}, "bankroll": None}
    if isinstance(record, dict):
        if isinstance(record.get("bankroll"), (int, float)):
            out["bankroll"] = int(record["bankroll"])
        if isinstance(record.get("earn"), dict):
            out["earn"] = {str(k): int(v) for k, v in record["earn"].items() if isinstance(v, (int, float))}
        if isinstance(record.get("spend"), dict):
            out["spend"] = {str(k): int(v) for k, v in record["spend"].items() if isinstance(v, (int, float))}
    kind = op.get("kind")
    reason = str(op.get("reason") or "unknown")
    if kind == "earn":
        out["earn"][reason] = out["earn"].get(reason, 0) + int(applied)
    elif kind == "spend":
        out["spend"][reason] = out["spend"].get(reason, 0) + int(applied)
    elif kind == "gamble":
        out["spend"]["casino_bet"] = out["spend"].get("casino_bet", 0) + int(op.get("amount") or 0)
        out["earn"]["casino_payout"] = out["earn"].get("casino_payout", 0) + int(applied)
    if bankroll is not None:
        out["bankroll"] = int(bankroll)
    return out
#: 送受金の相手方として履歴に残すシステムID
WORLDBOX_ID = "WORLD_BOX"
#: earn の理由ホワイトリスト（Web 側 economy-bridge.ts の EARN_REASONS と同じ集合）
EARN_REASONS = frozenset({"harvest", "guild_shop_sale", "arena_prize", "arena_pvp_prize", "arena_pvp_fee_refund", "arena_tournament_prize", "arena_tournament_refund", "casino_tournament_prize", "casino_tournament_refund", "shop_sale", "guild_request_reward", "guild_request_refund", "ruins_complete", "dungeon_clear"})
#: gamble の理由ホワイトリスト（Web 側 economy-bridge.ts の GAMBLE_REASONS と同じ集合）
GAMBLE_REASONS = frozenset({
    "casino_slot", "casino_roulette", "casino_dice",
    "casino_slot7", "casino_blackjack", "casino_double",
    "horse_racing",
})
OP_KINDS = frozenset({"spend", "earn", "transfer", "steal", "gamble"})
AMOUNT_MIN = 1
AMOUNT_MAX = 1_000_000
#: gamble の配当上限（Web 側 GAMBLE_PAYOUT_MAX と同じ値）
PAYOUT_MAX = 300_000_000
REASON_MAX = 40
#: ポーリング間隔（秒）: 適応ポーリングの上限（idle 時の最大間隔）。
#: 固定 5 秒時代は、オプが積まれてから拾われるまで平均 2.5 秒 / 最悪
#: 5 秒かかり、カジノの先払い→精算ではワーカー周期が2周分積み重なって
#: 体感の反映が最大で十数秒になっていた。現在は AdaptiveEconomyLoop が
#: 処理がある間は短間隔、idle が続けばこの値まで backoff する。
#: pending だけを絞って読むようになり idle 時の読み取りが軽くなった
#: ため、上限は 1 秒に縮めた（最初の1件の拾い遅れが体感の主因だった）。
POLL_SECONDS = 1.0
#: 全件読み（壊れたレコードの終端化＋終端オプの間引き）を行う間隔（ms）
FULL_SCAN_INTERVAL_MS = 600_000
#: 終端オプ（done/failed）を名前空間に残す上限（新しい順）。
#: 履歴表示は直近20件/人しか読まないが、無制限に残すと relay の watch
#: （名前空間リスト）や全件読みが件数に比例して遅くなる。
PRUNE_KEEP_TERMINAL = 1000
#: 計測をまとめて書き出す単位（件数 / 秒）。オプごとの読み書きは
#: 適用本体と同じだけ往復を増やすため、メモリに貯めて一括で書く。
METRIC_FLUSH_OPS = 20
METRIC_FLUSH_SECONDS = 10.0
#: 処理がある間（直前のバッチで1件以上終端化したとき）の間隔（秒）。
#: 先払いの直後に積まれる精算オプ等を早く拾うための値。
POLL_BUSY_SECONDS = 0.4
#: 1回のポーリングで処理する上限
MAX_BATCH = 100
#: claim がこの秒数を超えたら放棄されたものとして再処理可にする
CLAIM_STALE_SECONDS = 90.0
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
    if kind == "gamble":
        payout = value.get("payout")
        if isinstance(payout, bool) or not isinstance(payout, int):
            return None
        if not 0 <= payout <= PAYOUT_MAX:
            return None
        op["payout"] = payout
        if value.get("prepaid") is True:
            op["prepaid"] = True
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
    - kv: KVStore 互換（load_all / load_one / set の async メソッド。
      load_matching があれば pending の絞り込み読みに、delete があれば
      終端オプの間引きに使う）
    - wallet_provider: WalletCog を返す callable（None なら今回は何もしない）
    - economy_store: EconomyPoolStore 互換（pay_house / refund_house）
    - record_history: (sender_id, receiver_id, amount, reason) の async callable
    - insufficient_marker: WalletCog の INSUFFICIENT センチネル
      （値そのもの、または返す callable）
    - new_user_balance: 新規ユーザーの初期残高（値、または返す callable）
    - balance_reader: (user_id) -> 残高 の async callable（steal の
      被害者残高を読むため。CirculationCog._balance を渡す）
    - applied_kv: 適用台帳（APPLIED_NAMESPACE）の KVStore 互換
      （load_one / set の async メソッド。delete があれば終端オプの
      台帳も一緒に間引く）。None なら台帳なしの従来動作。
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
        metrics_kv: Any = None,
        applied_kv: Any = None,
    ) -> None:
        self._kv = kv
        self._wallet_provider = wallet_provider
        self._economy_store = economy_store
        self._record_history = record_history
        self._insufficient_marker = insufficient_marker
        self._new_user_balance = new_user_balance
        self._balance_reader = balance_reader
        self._metrics_kv = metrics_kv
        self._applied_kv = applied_kv
        self._remote_down = False
        self._wallet_down = False
        self._applied_down = False
        self._metric_buffer: list[tuple[dict[str, Any], int]] = []
        self._metric_last_flush = time.monotonic()
        self._last_full_scan_ms = 0

    def _marker(self) -> Any:
        marker = self._insufficient_marker
        return marker() if callable(marker) else marker

    def _initial_balance(self) -> int:
        value = self._new_user_balance
        return int(value() if callable(value) else value)

    async def poll_once(self) -> int:
        """pending オプを1バッチ適用する。適用（終端化）した件数を返す。

        kv の読み取りに失敗したら 0 を返して次回に回す（例外は外へ出さない）。

        通常回は pending だけを絞って読む。名前空間には終端オプが貯まり
        続けるため、全件読みは件数に比例して遅くなる。FULL_SCAN_INTERVAL_MS
        ごとの回だけ全件読みにし、絞り込みでは拾えない壊れたレコードの
        終端化（select_pending が候補に含める）と終端オプの間引きを行う。
        """
        now = _now_ms()
        full_scan = now - self._last_full_scan_ms >= FULL_SCAN_INTERVAL_MS
        try:
            if full_scan:
                records = await self._kv.load_all()
            else:
                loader = getattr(self._kv, "load_matching", None)
                if loader is not None:
                    records = await loader({"status": "pending"})
                else:
                    records = await self._kv.load_all()
        except Exception:
            if not self._remote_down:
                logger.warning("worldbox economy: bot_kv の読み取りに失敗しました（次回再試行）")
            self._remote_down = True
            return 0
        if self._remote_down:
            logger.info("worldbox economy: bot_kv への接続が回復しました")
            self._remote_down = False
        if not isinstance(records, dict):
            return 0
        if not records:
            if full_scan:
                self._last_full_scan_ms = now
            return 0
        # wallet が未読込だと例外が飛ぶ実装もある。ここで例外を外へ出すと
        # tasks.loop ごと止まって経済処理が無言で死ぬため、kv 読み取りと
        # 同じく「今回は見送り + 遷移時に1行だけ警告」で吸収する。
        try:
            wallet = self._wallet_provider()
        except Exception:
            wallet = None
        if wallet is None:
            if not self._wallet_down:
                logger.warning("worldbox economy: WalletCog が使えません（次回再試行）")
            self._wallet_down = True
            return 0
        if self._wallet_down:
            logger.info("worldbox economy: WalletCog への接続が回復しました")
            self._wallet_down = False
        handled = 0
        for key, raw in select_pending(records, _now_ms()):
            try:
                if await self._process_one(wallet, key, raw):
                    handled += 1
            except Exception:
                logger.exception("worldbox economy: オプ処理で予期しない例外（key=%s）", key)
        await self._flush_metrics(force=False)
        if full_scan:
            self._last_full_scan_ms = now
            await self._prune_terminal(records)
        return handled

    async def _prune_terminal(self, records: Any) -> None:
        """終端オプを新しい順に PRUNE_KEEP_TERMINAL 件だけ残して消す。

        records は処理前のスナップショットなので、この回に終端化した
        オプは次回の全件読みで対象になる。間引きはベストエフォート。
        適用台帳も同じタイミングで消す（終端オプの台帳は二度と読ま
        れないため、全件消して台帳の肥大化を防ぐ）。
        """
        delete = getattr(self._kv, "delete", None)
        if delete is None or not isinstance(records, dict):
            return
        applied_delete = (
            getattr(self._applied_kv, "delete", None)
            if self._applied_kv is not None
            else None
        )
        terminal: list[tuple[int, str]] = []
        for key, raw in records.items():
            value = raw
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except (ValueError, TypeError):
                    continue
            if not isinstance(value, dict) or value.get("status") not in ("done", "failed"):
                continue
            applied_at = value.get("appliedAt")
            sort_key = (
                int(applied_at)
                if isinstance(applied_at, (int, float)) and not isinstance(applied_at, bool)
                else 0
            )
            terminal.append((sort_key, key))
        terminal.sort(reverse=True)
        for _, key in terminal[PRUNE_KEEP_TERMINAL:]:
            try:
                await delete(key)
            except Exception:
                logger.warning("worldbox economy: 終端オプの間引きに失敗しました（key=%s）", key)
        if applied_delete is not None:
            for _, key in terminal:
                try:
                    await applied_delete(key)
                except Exception:
                    logger.warning("worldbox economy: 適用台帳の間引きに失敗しました（key=%s）", key)

    @staticmethod
    def _parse_applied(raw: Any) -> Optional[dict[str, Any]]:
        """台帳エントリを解釈する。無い場合は None を返す。

        壊れているエントリは applying 扱いにする（成否が曖昧＝再適用
        せず apply_uncertain へ倒す。壊れた台帳を「無かったこと」に
        して再適用するのが一番危ないため）。
        """
        if raw is None:
            return None
        value = raw
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                return {"status": "applying"}
        if not isinstance(value, dict):
            return {"status": "applying"}
        status = value.get("status")
        if status not in ("applying", "applied", "failed"):
            return {"status": "applying"}
        entry: dict[str, Any] = {"status": status}
        if status == "applied":
            amount = value.get("appliedAmount")
            entry["appliedAmount"] = (
                amount if isinstance(amount, int) and not isinstance(amount, bool) else 0
            )
            entry["metricRecorded"] = value.get("metricRecorded") is True
        if status == "failed":
            error = value.get("error")
            entry["error"] = error if isinstance(error, str) and error else "apply_failed"
        return entry

    async def _save_applied(self, op_id: str, entry: dict[str, Any]) -> bool:
        """台帳へ1件書く。台帳なし（applied_kv 未設定）なら True。

        書き込みに失敗したら False を返す（applying の書き込み失敗は
        適用の抑止に使う。それ以外はベストエフォートで呼び出し側は
        戻り値を無視してよい）。
        """
        if self._applied_kv is None:
            return True
        try:
            await self._applied_kv.set(op_id, entry)
        except Exception:
            logger.warning("worldbox economy: 適用台帳の書き込みに失敗しました（id=%s）", op_id)
            return False
        return True

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
        # 適用台帳: 財布への適用そのものの冪等化。台帳が読めなければ
        # 適用に進まず False を返す（claim 失効後の再試行に回す）。
        ledger: Optional[dict[str, Any]] = None
        if self._applied_kv is not None:
            try:
                ledger = self._parse_applied(await self._applied_kv.load_one(op["id"]))
            except Exception:
                if not self._applied_down:
                    logger.warning("worldbox economy: 適用台帳の読み取りに失敗しました（id=%s）", op["id"])
                self._applied_down = True
                return False
            if self._applied_down:
                logger.info("worldbox economy: 適用台帳への接続が回復しました")
                self._applied_down = False
        if ledger is not None:
            status = ledger["status"]
            if status == "applied":
                # 適用済み: 財布は触らず、結果だけ書き直す。計測は
                # metricRecorded が False のときだけ足す（二重加算しない）。
                applied = int(ledger.get("appliedAmount") or 0)
                await self._write_result(key, claimed, status="done", applied_amount=applied)
                if not ledger.get("metricRecorded"):
                    await self._record_metric(op, applied)
                    await self._save_applied(
                        op["id"],
                        {"status": "applied", "appliedAmount": applied, "metricRecorded": True, "at": _now_ms()},
                    )
                return True
            if status == "failed":
                # 確定失敗: 再適用せず、記録済みのエラーで終端化し直す。
                await self._write_result(key, claimed, status="failed", error=str(ledger.get("error") or "apply_failed"))
                return True
            # applying のみ: 適用の成否が曖昧。再適用せず安全側に倒す。
            logger.critical(
                "worldbox economy: 適用台帳が applying のままのオプを再処理します（id=%s）。"
                "二重適用を避けるため failed=apply_uncertain とします",
                op["id"],
            )
            await self._write_result(key, claimed, status="failed", error="apply_uncertain")
            return True
        # 台帳なし: applying を書いてから適用する。台帳に書けなければ
        # 適用しない（claim 失効後に再試行し、そのとき台帳から始める）。
        if not await self._save_applied(op["id"], {"status": "applying", "at": _now_ms()}):
            return False
        try:
            applied = await self._apply(wallet, op)
        except _OpFailed as exc:
            # 確定失敗は台帳も failed で終端化する（再処理で
            # apply_uncertain に化けないようにする）。
            await self._save_applied(op["id"], {"status": "failed", "error": exc.code, "at": _now_ms()})
            await self._write_result(key, claimed, status="failed", error=exc.code)
            return True
        except Exception:
            logger.exception("worldbox economy: オプ適用で予期しない例外（id=%s）", op["id"])
            # 台帳は applying のまま残す（成否が曖昧）。結果の書き戻し
            # まで失敗していたら再処理で apply_uncertain になる。
            await self._write_result(key, claimed, status="failed", error="apply_failed")
            return True
        await self._record_metric(op, applied)
        await self._save_applied(
            op["id"],
            {"status": "applied", "appliedAmount": applied, "metricRecorded": True, "at": _now_ms()},
        )
        await self._write_result(key, claimed, status="done", applied_amount=applied)
        return True

    async def _record_metric(self, op: dict[str, Any], applied: int) -> None:
        """日次経済集計への加算をバッファに積む（書き出しは _flush_metrics）。

        計測はベストエフォート: 失敗しても経済の適用は止めない。オプごとに
        読み書きすると適用本体と同じだけ往復が増えるため、まとめて書く。
        """
        if self._metrics_kv is None:
            return
        self._metric_buffer.append((op, applied))
        await self._flush_metrics(force=False)

    async def _flush_metrics(self, *, force: bool) -> None:
        """貯まった計測を1回の読み書きで書き出す。

        METRIC_FLUSH_OPS 件たまるか METRIC_FLUSH_SECONDS 秒たったら書く
        （force=True は無条件）。書き出しに失敗した分は捨てる（計測は
        ベストエフォートで、再送のために適用を遅らせない）。
        """
        if self._metrics_kv is None or not self._metric_buffer:
            return
        now = time.monotonic()
        if (
            not force
            and len(self._metric_buffer) < METRIC_FLUSH_OPS
            and now - self._metric_last_flush < METRIC_FLUSH_SECONDS
        ):
            return
        batch = self._metric_buffer
        self._metric_buffer = []
        self._metric_last_flush = now
        try:
            from datetime import datetime, timezone

            date = datetime.now(timezone.utc).date().isoformat()
            bankroll: Optional[int] = None
            try:
                snap = self._economy_store.snapshot()
                bankroll = int(snap.get("pool", 0)) + int(snap.get("treasury", 0))
            except Exception:
                bankroll = None
            current = await self._metrics_kv.load_one(date)
            if isinstance(current, str):
                try:
                    current = json.loads(current)
                except (ValueError, TypeError):
                    current = None
            for op, applied in batch:
                current = apply_metric(current, op, applied, bankroll)
            await self._metrics_kv.set(date, current)
        except Exception:
            logger.warning("worldbox economy: 計測の記録に失敗しました（次回再試行）")

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
        if kind == "gamble":
            return await self._apply_gamble(wallet, op)
        return await self._apply_transfer(wallet, op)

    async def _apply_gamble(self, wallet: Any, op: dict[str, Any]) -> int:
        """カジノの1プレイを原子的に適用する。戻り値は実際に払った配当。

        ベットを引き落とせなければ配当は払わない（failed）。負けは
        ベットを還流して 0。当たりはベット分（自分の金）＋ pay_house で
        確保できた利益分だけを払う。入金に失敗したら確保した原資を
        戻し、ベットも返金して failed（どちらも中途半端に残さない）。
        """
        if op["reason"] not in GAMBLE_REASONS:
            raise _OpFailed("invalid_reason")
        user = op["discordId"]
        bet = op["amount"]
        payout = op["payout"]
        prepaid = op.get("prepaid") is True
        if not prepaid:
            debit = await wallet._change_balance(user, -bet, require_funds=True)
            if debit is self._marker():
                raise _OpFailed("insufficient_funds")
            if debit is None:
                raise _OpFailed("balance_update_failed")
            await self._record_history(user, WORLDBOX_ID, bet, op["reason"])
        if payout <= 0:
            try:
                self._economy_store.add_loss(bet)
            except Exception:
                logger.exception("worldbox economy: gamble の還流に失敗（id=%s）", op["id"])
            return 0
        if prepaid and payout < bet:
            # 先払い精算の部分返し: 戻らなかった分は負けとして還流する。
            try:
                self._economy_store.add_loss(bet - payout)
            except Exception:
                logger.exception("worldbox economy: gamble の還流に失敗（id=%s）", op["id"])
        profit = max(0, payout - bet)
        breakdown: Any = None
        house_paid = 0
        if profit > 0:
            try:
                breakdown = self._economy_store.pay_house(profit)
            except Exception:
                breakdown = None
            if isinstance(breakdown, dict):
                try:
                    house_paid = max(0, int(breakdown.get("paid") or 0))
                except (TypeError, ValueError):
                    house_paid = 0
        credit_amount = min(payout, bet) + house_paid
        credited = await wallet._change_balance(
            user, credit_amount, create_with=self._initial_balance(),
        )
        if credited is None or credited is self._marker():
            if breakdown is not None:
                try:
                    self._economy_store.refund_house(breakdown)
                except Exception:
                    logger.exception("worldbox economy: refund_house に失敗（id=%s）", op["id"])
            if not prepaid:
                refund = await wallet._change_balance(user, bet)
                if refund is None:
                    logger.critical(
                        "worldbox economy: gamble のベット返金に失敗しました（user=%s bet=%s）",
                        user, bet,
                    )
            raise _OpFailed("credit_failed")
        await self._record_history(WORLDBOX_ID, user, credit_amount, op["reason"])
        return credit_amount

    async def _apply_steal(self, wallet: Any, op: dict[str, Any]) -> int:
        """steal は一旦廃止（2026-11-16 ユーザー指示）。

        Web 側も新規オプを作らないが、既にキューに残っている steal オプが
        金を動かさずに終端化されるよう、ここでも即座に failed にする。
        （旧実装は git 履歴に残る。）
        """
        raise _OpFailed("steal_disabled")

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


def next_poll_delay(handled: int, previous: float) -> float:
    """次のポーリングまでの間隔を決める（適応ポーリングの純粋関数）。

    - バッチ上限まで処理した（pending がまだ残っている可能性が高い）
      ときは間隔ゼロで即座に次バッチを回す。
    - 1件以上処理したら、続けて積まれるオプ（カジノの精算オプ等）を
      早く拾うため短間隔（POLL_BUSY_SECONDS）にする。
    - 何も無ければ前回間隔を倍々にし、上限 POLL_SECONDS まで backoff
      する（idle 時の読み取りコストは固定 5 秒時代と変わらない）。
    """
    if handled >= MAX_BATCH:
        return 0.0
    if handled > 0:
        return POLL_BUSY_SECONDS
    return min(POLL_SECONDS, max(POLL_BUSY_SECONDS, previous * 2))


class AdaptiveEconomyLoop:
    """poll_once を適応間隔で回し続ける自前ループ（tasks.loop の置換）。

    tasks.loop は固定間隔しか持てないため、間隔を動的に変えるには
    自前の asyncio タスクが要る。cog.py からは従来の tasks.loop と
    同じ is_running / start / cancel で扱える（起動は cog_load、
    停止は cog_unload、開始前の待機は before コールバック）。

    poll_once は例外を吸収する設計だが、万一例外が漏れてもここで
    吸収してログに残し、ループ自体は決して止めない（S2 の無言死
    防止: tasks.loop は本体の例外で停止しうる）。
    """

    def __init__(
        self,
        worker: "WorldBoxEconomyWorker",
        *,
        before: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> None:
        self._worker = worker
        self._before = before
        self._task: Optional[asyncio.Task] = None

    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if self.is_running():
            return
        self._task = asyncio.get_running_loop().create_task(self._run())

    def cancel(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        if self._before is not None:
            await self._before()
        delay = POLL_BUSY_SECONDS
        while True:
            try:
                handled = await self._worker.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "worldbox economy: ポーリングで予期しない例外（ループは継続します）"
                )
                handled = 0
            delay = next_poll_delay(handled, delay)
            await asyncio.sleep(delay)
