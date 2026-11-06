# -*- coding: utf-8 -*-
"""ギャンブル系（スロット／ダブルアップ／ブラックジャック／ダイス）の単一の置き場。

パンBot 資産移植の追加フェーズ。原典（単一ファイル main.py）のギャンブルは
「見えない内部状態で中毒性を作る」設計が核で、今回はユーザーの指示により
内部状態ごと原典に近い仕様で移植する:

- slot7: 7リール、1回 SLOT_BET 固定・回数分を先払い。内部状態として
  確変 ``kakuhen``（残り回数）、6の出現カウンタ ``six_counter``、
  連敗 ``lose_streak`` / 連勝 ``win_streak`` をユーザー単位で永続化する
- double: 原典 DoubleView の GO / CASHOUT。内部モード ``internal_mode``
  （NORMAL / HELL / CHARGE / FEVER）で勝率が変わる（FEVER 0.75、他 0.60）。
  internal_mode・連敗・連勝は slot7 と共有の内部状態
- blackjack: 原典 BlackjackView の対NPC戦（ヒット／スタンド）
- dice: 原典の数字当てベット（既存 cogs/dice.py の NdM 表記ローラーは
  賭けなしのユーティリティで、こちらとは別物）

原典との差分（AGO 側の都合で変えた点）:
- 通貨はチップではなく AGO コインに一本化（Phase 1 の決定で賭け専用
  チップは導入しない）。slot7 は原典がコイン建ての blackjack / double と
  同じくコインで回す
- 原典のアイテム連動（お祓い棒／悪魔的な報酬／神がかり／安牌なギャンブル／
  やっぱナシ）は、対応するアイテムが AGO 側に無いため持ち込まない
- 原典の global_pool / economy_coin への還流は AGO には無いため行わない
  （配当は wallet から直接出し入れする）
- セッション（先払い済みスロット、先行ベット済みの double / blackjack）は
  このストアに永続化し、Bot 再起動時は未完了セッションのベットを
  ``pop_orphaned_sessions`` で返金対象として取り出す（cogs/gambling.py が
  起動後に返金を実行する。core/game/game_restore.py の「スナップショットが
  あれば常に reconcile する」流儀）

このモジュールが持つのは定数・内部状態・セッション・抽選と判定まで。
コインの実移動は呼び出し側が wallet の安全な経路（_change_balance の
CAS）で行い、transaction_history に gamble_slot / gamble_double /
gamble_blackjack / gamble_dice の理由コードを残す。保存は
core/steal.py と同じ流儀: 専用 JSON（既定 data/gambling.json、
環境変数 GAMBLING_DATA_PATH で変更可）にメモリ主体＋バッチフラッシュ
＋原子差し替え。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from pathlib import Path
from typing import Any

from core.general.items import ItemError

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 経済定数（原典準拠を基本に、額面だけ AGO コインへ読み替えた暫定値。
# AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

# --- slot7 ---
#: 1スピンあたりのベット（AGO）。原典は1,000チップ固定。
SLOT_BET = 1000
#: 1セッションで指定できるスピン回数の範囲（原典どおり 10〜1000）。
SLOT_MIN_SPINS = 10
SLOT_MAX_SPINS = 1000
#: 揃った個数 → 基本倍率（原典 bm）。報酬は int(SLOT_BET × 倍率)。
SLOT_BASE_MULTIPLIERS = {2: 1.1, 3: 6, 4: 25, 5: 120, 6: 500, 7: 2000}
#: 天井: スピン開始時点で連敗がこれ以上なら基本倍率でなく天井報酬を出す。
SLOT_PITY_STREAK = 3
#: 天井報酬の倍率（原典 BET×50）。
SLOT_PITY_MULTIPLIER = 50
#: 最多数字が7のときの倍率（原典 ×5）。
SLOT_SEVEN_BONUS = 5
#: 7が3つ以上揃うと確変に突入し、この回数が付与される（原典 7）。
SLOT_KAKUHEN_SPINS = 7
#: 確変中の報酬倍率（原典 ×3）。
SLOT_KAKUHEN_MULTIPLIER = 3
#: 確変中に7が7つ揃うと超JACKPOT（原典 BET×100000、倍率・天井より優先）。
SLOT_SUPER_JACKPOT_MULTIPLIER = 100000
#: 確変外で6が揃った（5つ未満）ときのペナルティ（原典 -BET×9）。
SLOT_SIX_PENALTY_MULTIPLIER = 9
#: リールの重み。数字6は通常 SLOT_WEIGHT_SIX_NORMAL / 確変中は
#: SLOT_WEIGHT_SIX_KAKUHEN、数字7は SLOT_WEIGHT_SEVEN、他は SLOT_WEIGHT_OTHER。
SLOT_WEIGHT_SIX_NORMAL = 16
SLOT_WEIGHT_SIX_KAKUHEN = 14
SLOT_WEIGHT_SEVEN = 5
SLOT_WEIGHT_OTHER = 8
#: 確変外スピンで six_counter × この確率を引くとカウンタがリセットされ、
#: FORCE_SIX_PROBABILITY の確率で「先頭5リールが6」になる（原典どおり）。
SIX_COUNTER_RATE = 0.01
FORCE_SIX_PROBABILITY = 0.5

# --- double ---
#: ダブルアップの最低ベット（AGO）。原典は1以上。
DOUBLE_MIN_BET = 1
#: GO 成功ごとの倍率の伸び（原典 ×1.9）。
DOUBLE_MULTIPLIER_STEP = 1.9
#: 勝率。FEVER のときだけ上がる（原典 get_internal_rate）。
DOUBLE_RATE_NORMAL = 0.60
DOUBLE_RATE_FEVER = 0.75
#: internal_mode の遷移閾値（原典どおり）。連敗3で HELL、6で CHARGE。
DOUBLE_HELL_LOSE_STREAK = 3
DOUBLE_CHARGE_LOSE_STREAK = 6
#: FEVER 中に連勝がこれに達すると NORMAL に戻る。
DOUBLE_FEVER_EXIT_WIN_STREAK = 3
#: キャッシュアウト額がこれを超えると HELL に落とされる（原典 500超）。
DOUBLE_HELL_PAYOUT_THRESHOLD = 500

# --- blackjack ---
#: ブラックジャックの最低ベット（AGO）。原典は10以上。
BLACKJACK_MIN_BET = 10
#: 山札の値と重み（原典 draw_card: 1〜9 と 10×4 の13枚から一様抽選）。
CARD_VALUES = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10)
#: ディーラーがヒットを続ける上限（原典: 合計17未満で引く）。
DEALER_STAND_TOTAL = 17

# --- bj_duel（次期仕様 S6-3） ---
#: ブラックジャック対決の最低ベット（AGO、暫定。原典はチップ建て）。
DUEL_MIN_BET = 500
#: transaction_history の理由コード（勝者の受け取り）。
DUEL_HISTORY_REASON = "gamble_bj_duel"

# --- dice ---
#: ダイスの最低ベット（AGO）。原典は10チップ。
DICE_MIN_BET = 10
#: 当て幅 max の範囲（原典 5〜10000）。賞金は bet × max（原典どおり）。
DICE_MIN_MAX = 5
DICE_MAX_MAX = 10000

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

INTERNAL_MODES = ("NORMAL", "HELL", "CHARGE", "FEVER")

SESSION_KINDS = ("slot", "double", "blackjack")


def calc_total(hand: list[int]) -> int:
    """手札の合計（原典 calc_total: 21超なら11を1に読み替える）。

    原典の draw_card は11を出さないため通常は素の合計だが、原典の
    読み替えロジック自体はそのまま持ってくる。
    """
    cards = list(hand)
    total = sum(cards)
    while total > 21 and 11 in cards:
        cards[cards.index(11)] = 1
        total = sum(cards)
    return total


def _reel_weights(kakuhen: bool, six_suppressed: bool = False,
                   six_multiplier: float = 0.5) -> list[int]:
    """数字0〜9のリール重み（原典 wl）。

    six_suppressed（お祓い棒 S6-4）が真なら「6」の重みを倍率で下げる
    （最小1）。倍率は items 側の定数を呼び出し側が渡す。
    """
    six = SLOT_WEIGHT_SIX_KAKUHEN if kakuhen else SLOT_WEIGHT_SIX_NORMAL
    if six_suppressed:
        six = max(1, int(six * six_multiplier))
    return [SLOT_WEIGHT_OTHER] * 6 + [six, SLOT_WEIGHT_SEVEN] + [SLOT_WEIGHT_OTHER] * 2


def _empty_user() -> dict[str, Any]:
    return {
        "kakuhen": 0,
        "six_counter": 0,
        "lose_streak": 0,
        "win_streak": 0,
        "internal_mode": "NORMAL",
    }


def _clean_user(raw: Any) -> dict[str, Any]:
    user = _empty_user()
    if not isinstance(raw, dict):
        return user
    for key in ("kakuhen", "six_counter", "lose_streak", "win_streak"):
        value = raw.get(key)
        if isinstance(value, int) and value > 0:
            user[key] = value
    mode = raw.get("internal_mode")
    if mode in INTERNAL_MODES:
        user["internal_mode"] = mode
    return user


def _clean_session(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    if kind == "slot":
        remaining = raw.get("remaining")
        total = raw.get("total")
        if isinstance(remaining, int) and remaining > 0 and isinstance(total, int):
            return {"kind": "slot", "remaining": remaining, "total": total}
        return None
    if kind == "double":
        bet = raw.get("bet")
        multiplier = raw.get("multiplier")
        streak = raw.get("streak")
        if (isinstance(bet, int) and bet > 0
                and isinstance(multiplier, (int, float)) and multiplier >= 1.0
                and isinstance(streak, int) and streak >= 0):
            return {"kind": "double", "bet": bet,
                    "multiplier": float(multiplier), "streak": streak}
        return None
    if kind == "blackjack":
        bet = raw.get("bet")
        player = raw.get("player")
        dealer = raw.get("dealer")
        if (isinstance(bet, int) and bet > 0
                and isinstance(player, list) and len(player) >= 2
                and all(isinstance(c, int) for c in player)
                and isinstance(dealer, list) and len(dealer) >= 2
                and all(isinstance(c, int) for c in dealer)):
            return {"kind": "blackjack", "bet": bet,
                    "player": list(player), "dealer": list(dealer)}
        return None
    return None


def _clean_duel(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    bet = raw.get("bet")
    creator = raw.get("creator")
    if not (isinstance(bet, int) and bet > 0 and creator):
        return None
    challenger = raw.get("challenger")
    hands_raw = raw.get("hands")
    hands: dict[str, list[int]] = {}
    if isinstance(hands_raw, dict):
        for uid, cards in hands_raw.items():
            if isinstance(cards, list) and all(isinstance(c, int) for c in cards):
                hands[str(uid)] = list(cards)
    stood_raw = raw.get("stood")
    stood = [str(u) for u in stood_raw] if isinstance(stood_raw, list) else []
    created = raw.get("created_at")
    return {
        "bet": int(bet),
        "creator": str(creator),
        "challenger": str(challenger) if challenger else None,
        "hands": hands,
        "stood": stood,
        "state": "playing" if challenger else "waiting",
        "created_at": float(created) if isinstance(created, (int, float)) else 0.0,
    }


def _empty_state() -> dict[str, Any]:
    return {"users": {}, "sessions": {}, "duels": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entry in users.items():
            state["users"][str(uid)] = _clean_user(entry)
    sessions = raw.get("sessions")
    if isinstance(sessions, dict):
        for uid, entry in sessions.items():
            cleaned = _clean_session(entry)
            if cleaned is not None:
                state["sessions"][str(uid)] = cleaned
    duels = raw.get("duels")
    if isinstance(duels, dict):
        for key, entry in duels.items():
            cleaned = _clean_duel(entry)
            if cleaned is not None:
                state["duels"][str(key)] = cleaned
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "gambling.json"


def default_path() -> Path:
    return Path(os.environ.get("GAMBLING_DATA_PATH") or _DEFAULT_PATH)


class GamblingStore:
    """ギャンブルの内部状態・セッションと JSON 保存、抽選と判定。

    セッションはユーザーごとに1つまで（slot / double / blackjack の
    いずれか）。ベットは呼び出し側が開始前に wallet から差し引いた
    前提で、ここでは状態遷移と結果の計算だけを行う。
    """

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        rng: random.Random | None = None,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
        self._rng = rng if rng is not None else random.Random()
        self._flush_every = max(1, int(flush_every))
        self._flush_interval = float(flush_interval)
        self._lock = threading.RLock()
        self._dirty = 0
        self._last_flush = time.monotonic()
        self._state = self._load()

    # ------------------------------------------------------------------ 保存
    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return _empty_state()
        return _clean_state(raw)

    def flush(self) -> None:
        with self._lock:
            payload = copy.deepcopy(self._state)
            self._dirty = 0
            self._last_flush = time.monotonic()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except Exception:
            logger.exception("gambling: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 状態参照
    def _user_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(str(user_id), _empty_user())

    def user_state(self, user_id: str) -> dict[str, Any]:
        """内部状態の表示用コピー。"""
        with self._lock:
            return dict(self._user_locked(str(user_id)))

    def session(self, user_id: str) -> dict[str, Any] | None:
        with self._lock:
            session = self._state["sessions"].get(str(user_id))
            return copy.deepcopy(session) if session is not None else None

    def internal_rate(self, user_id: str) -> float:
        """double の勝率（原典 get_internal_rate: FEVER のときだけ 0.75）。"""
        with self._lock:
            mode = self._user_locked(str(user_id))["internal_mode"]
        return DOUBLE_RATE_FEVER if mode == "FEVER" else DOUBLE_RATE_NORMAL

    def orphaned_refunds(self) -> list[dict[str, Any]]:
        """未完了セッションの返金対象を取り出す（取り出した分は消える）。

        Bot 再起動で View が失われたセッションは続行できないため、
        エスクロー済みベットを返金するのが安全な reconcile になる。
        slot は未消化スピン分（remaining × SLOT_BET）、double /
        blackjack はベット全額が対象。
        """
        refunds: list[dict[str, Any]] = []
        with self._lock:
            for uid, session in list(self._state["sessions"].items()):
                if session["kind"] == "slot":
                    amount = int(session["remaining"]) * SLOT_BET
                else:
                    amount = int(session["bet"])
                if amount > 0:
                    refunds.append({
                        "user_id": uid, "kind": session["kind"], "amount": amount})
                del self._state["sessions"][uid]
            # bj_duel（S6-3）: 募集中は作成者へ、対戦中は双方へ全額返金。
            for key, duel in list(self._state["duels"].items()):
                bet = int(duel["bet"])
                refunds.append({
                    "user_id": duel["creator"], "kind": "bj_duel",
                    "amount": bet})
                if duel.get("challenger"):
                    refunds.append({
                        "user_id": duel["challenger"], "kind": "bj_duel",
                        "amount": bet})
                del self._state["duels"][key]
            if refunds:
                self._mark_dirty()
        return refunds

    # ------------------------------------------------------------------ slot7
    def start_slot(self, user_id: str, spins: int) -> dict[str, Any]:
        """スロットセッションを開始する（ベットは呼び出し側が支払い済み）。"""
        if not SLOT_MIN_SPINS <= int(spins) <= SLOT_MAX_SPINS:
            raise ItemError(
                f"回数は{SLOT_MIN_SPINS}〜{SLOT_MAX_SPINS}回で指定してください。")
        uid = str(user_id)
        with self._lock:
            if uid in self._state["sessions"]:
                raise ItemError("進行中のゲームがあります。先にそちらを終えてください。")
            session = {"kind": "slot", "remaining": int(spins), "total": int(spins)}
            self._state["sessions"][uid] = session
            self._mark_dirty()
            return dict(session)

    def spin_slot(self, user_id: str, *, six_suppressed: bool = False,
                  six_multiplier: float = 0.5) -> dict[str, Any]:
        """1スピン回して結果を返す。原典 Slot7View.spin の状態遷移を再現する。

        返り値の ``reward`` はこのスピンで確定したコイン増減（負数あり）。
        ``confiscate`` が真のときは 66666 イベントで、呼び出し側が
        残高を全額没収する（reward は0）。six_suppressed はお祓い棒
        （S6-4）の効果で、cog が items の効果状態を引いて渡す。
        """
        uid = str(user_id)
        with self._lock:
            session = self._state["sessions"].get(uid)
            if session is None or session["kind"] != "slot":
                raise ItemError("スロットのセッションがありません。")
            st = self._user_locked(uid)
            kakuhen_active = st["kakuhen"] > 0
            streak = int(st["lose_streak"])
            if kakuhen_active:
                st["six_counter"] = int(st["six_counter"]) + 1
            force_six = False
            if not kakuhen_active:
                counter = int(st["six_counter"])
                if self._rng.random() < counter * SIX_COUNTER_RATE:
                    st["six_counter"] = 0
                    force_six = self._rng.random() < FORCE_SIX_PROBABILITY
            weights = _reel_weights(kakuhen_active, six_suppressed, six_multiplier)
            if force_six:
                reels = [6] * 5 + self._rng.choices(range(10), k=2)
            else:
                reels = self._rng.choices(range(10), weights=weights, k=7)
            counts: dict[int, int] = {}
            for digit in reels:
                counts[digit] = counts.get(digit, 0) + 1
            max_match = max(counts.values())
            # 原典は max(counts, key=counts.get)。同数のタイブレークは
            # 最初に現れた数字を採る（原典の set 順序依存を決定的にした）。
            matched = next(d for d in reels if counts[d] == max_match)
            events: list[str] = []
            reward = 0
            confiscate = False
            if streak >= SLOT_PITY_STREAK:
                reward = SLOT_BET * SLOT_PITY_MULTIPLIER
                st["lose_streak"] = 0
                events.append("pity")
            elif max_match >= 2:
                reward = int(SLOT_BET * SLOT_BASE_MULTIPLIERS[max_match])
                if matched == 7:
                    reward *= SLOT_SEVEN_BONUS
                    events.append("seven_bonus")
                    if max_match >= 3:
                        st["kakuhen"] = SLOT_KAKUHEN_SPINS
                        events.append("kakuhen_start")
                elif matched == 6 and not kakuhen_active:
                    if max_match >= 5:
                        confiscate = True
                        reward = 0
                        events.append("six_confiscate")
                    else:
                        reward = -int(SLOT_BET * SLOT_SIX_PENALTY_MULTIPLIER)
                        events.append("six_penalty")
                if kakuhen_active:
                    if max_match >= 3 and matched == 6:
                        st["kakuhen"] = int(st["kakuhen"]) - 1
                        events.append("kakuhen_decrease")
                    else:
                        reward = int(reward * SLOT_KAKUHEN_MULTIPLIER)
                        events.append("kakuhen_multiplier")
                    if counts.get(7, 0) >= 2:
                        st["kakuhen"] = int(st["kakuhen"]) + 1
                        events.append("kakuhen_extend")
                    if reels == [7] * 7:
                        reward = SLOT_BET * SLOT_SUPER_JACKPOT_MULTIPLIER
                        confiscate = False
                        events.append("super_jackpot")
                st["lose_streak"] = 0
            else:
                st["lose_streak"] = streak + 1
            if kakuhen_active:
                st["kakuhen"] = int(st["kakuhen"]) - 1
                if st["kakuhen"] <= 0:
                    st["kakuhen"] = 0
                    events.append("kakuhen_end")
            session["remaining"] = int(session["remaining"]) - 1
            finished = int(session["remaining"]) <= 0
            if finished:
                del self._state["sessions"][uid]
            self._mark_dirty()
            return {
                "reels": reels,
                "max_match": max_match,
                "matched_number": matched,
                "reward": reward,
                "confiscate": confiscate,
                "events": events,
                "kakuhen": int(st["kakuhen"]),
                "remaining": 0 if finished else int(session["remaining"]),
                "total": int(session["total"]),
                "finished": finished,
            }

    # ------------------------------------------------------------------ double
    def start_double(self, user_id: str, bet: int) -> dict[str, Any]:
        """ダブルアップを開始する（ベットは呼び出し側が支払い済み）。"""
        if int(bet) < DOUBLE_MIN_BET:
            raise ItemError(f"ベットは{DOUBLE_MIN_BET} AGO以上で指定してください。")
        uid = str(user_id)
        with self._lock:
            if uid in self._state["sessions"]:
                raise ItemError("進行中のゲームがあります。先にそちらを終えてください。")
            session = {"kind": "double", "bet": int(bet),
                       "multiplier": 1.0, "streak": 0}
            self._state["sessions"][uid] = session
            self._mark_dirty()
            return dict(session)

    def double_go(self, user_id: str) -> dict[str, Any]:
        """GO を1回引く。原典 DoubleView.go_button の状態遷移を再現する。"""
        uid = str(user_id)
        with self._lock:
            session = self._state["sessions"].get(uid)
            if session is None or session["kind"] != "double":
                raise ItemError("ダブルアップのセッションがありません。")
            st = self._user_locked(uid)
            rate = (DOUBLE_RATE_FEVER if st["internal_mode"] == "FEVER"
                    else DOUBLE_RATE_NORMAL)
            win = self._rng.random() < rate
            if win:
                session["streak"] = int(session["streak"]) + 1
                session["multiplier"] = float(session["multiplier"]) * DOUBLE_MULTIPLIER_STEP
                st["win_streak"] = int(st["win_streak"]) + 1
                st["lose_streak"] = 0
                if st["internal_mode"] == "CHARGE":
                    st["internal_mode"] = "FEVER"
                if (st["internal_mode"] == "FEVER"
                        and int(st["win_streak"]) >= DOUBLE_FEVER_EXIT_WIN_STREAK):
                    st["internal_mode"] = "NORMAL"
                    st["win_streak"] = 0
                finished = False
            else:
                st["lose_streak"] = int(st["lose_streak"]) + 1
                st["win_streak"] = 0
                if int(st["lose_streak"]) >= DOUBLE_CHARGE_LOSE_STREAK:
                    st["internal_mode"] = "CHARGE"
                elif int(st["lose_streak"]) >= DOUBLE_HELL_LOSE_STREAK:
                    st["internal_mode"] = "HELL"
                del self._state["sessions"][uid]
                finished = True
            self._mark_dirty()
            return {
                "win": win,
                "bet": int(session["bet"]),
                "multiplier": float(session["multiplier"]),
                "streak": int(session["streak"]),
                "current_value": int(int(session["bet"]) * float(session["multiplier"])),
                "finished": finished,
            }

    def double_cashout(self, user_id: str) -> dict[str, Any]:
        """現在の倍率で確定する。原典 DoubleView.cashout_button を再現する。"""
        uid = str(user_id)
        with self._lock:
            session = self._state["sessions"].get(uid)
            if session is None or session["kind"] != "double":
                raise ItemError("ダブルアップのセッションがありません。")
            payout = int(int(session["bet"]) * float(session["multiplier"]))
            st = self._user_locked(uid)
            if payout > DOUBLE_HELL_PAYOUT_THRESHOLD:
                st["internal_mode"] = "HELL"
            del self._state["sessions"][uid]
            self._mark_dirty()
            return {"bet": int(session["bet"]), "payout": payout}

    # ------------------------------------------------------------------ blackjack
    def _draw_card(self) -> int:
        return self._rng.choice(CARD_VALUES)

    def start_blackjack(self, user_id: str, bet: int) -> dict[str, Any]:
        """ブラックジャックを開始する（ベットは呼び出し側が支払い済み）。"""
        if int(bet) < BLACKJACK_MIN_BET:
            raise ItemError(f"ベットは{BLACKJACK_MIN_BET} AGO以上で指定してください。")
        uid = str(user_id)
        with self._lock:
            if uid in self._state["sessions"]:
                raise ItemError("進行中のゲームがあります。先にそちらを終えてください。")
            session = {
                "kind": "blackjack", "bet": int(bet),
                "player": [self._draw_card(), self._draw_card()],
                "dealer": [self._draw_card(), self._draw_card()],
            }
            self._state["sessions"][uid] = session
            self._mark_dirty()
            return copy.deepcopy(session)

    def blackjack_hit(self, user_id: str) -> dict[str, Any]:
        """ヒット。バーストしたらセッション終了（配当0）。"""
        uid = str(user_id)
        with self._lock:
            session = self._state["sessions"].get(uid)
            if session is None or session["kind"] != "blackjack":
                raise ItemError("ブラックジャックのセッションがありません。")
            session["player"].append(self._draw_card())
            total = calc_total(session["player"])
            bust = total > 21
            if bust:
                del self._state["sessions"][uid]
            self._mark_dirty()
            return {
                "player": list(session["player"]),
                "dealer_first": session["dealer"][0],
                "total": total,
                "bust": bust,
                "bet": int(session["bet"]),
                "payout": 0,
            }

    def blackjack_stand(self, user_id: str) -> dict[str, Any]:
        """スタンド。ディーラーは17未満で引き続け、原典の配当で決着する。"""
        uid = str(user_id)
        with self._lock:
            session = self._state["sessions"].get(uid)
            if session is None or session["kind"] != "blackjack":
                raise ItemError("ブラックジャックのセッションがありません。")
            dealer = list(session["dealer"])
            while calc_total(dealer) < DEALER_STAND_TOTAL:
                dealer.append(self._draw_card())
            player_total = calc_total(session["player"])
            dealer_total = calc_total(dealer)
            bet = int(session["bet"])
            if dealer_total > 21 or player_total > dealer_total:
                outcome, payout = "win", bet * 2
            elif player_total < dealer_total:
                outcome, payout = "lose", 0
            else:
                outcome, payout = "push", bet
            del self._state["sessions"][uid]
            self._mark_dirty()
            return {
                "player": list(session["player"]),
                "dealer": dealer,
                "player_total": player_total,
                "dealer_total": dealer_total,
                "outcome": outcome,
                "bet": bet,
                "payout": payout,
            }

    # ------------------------------------------------------------------ bj_duel（S6-3）
    def _duel_snapshot(self, key: str, duel: dict[str, Any]) -> dict[str, Any]:
        snapshot = copy.deepcopy(duel)
        snapshot["id"] = key
        snapshot["totals"] = {
            uid: calc_total(hand) for uid, hand in duel["hands"].items()}
        return snapshot

    def duel_of(self, user_id: str) -> dict[str, Any] | None:
        """ユーザーが参加している対決（募集中の作成分を含む）を返す。"""
        uid = str(user_id)
        with self._lock:
            for key, duel in self._state["duels"].items():
                if duel["creator"] == uid or duel.get("challenger") == uid:
                    return self._duel_snapshot(key, duel)
            return None

    def open_duels(self) -> list[dict[str, Any]]:
        """参加者を募集中の対決一覧。"""
        with self._lock:
            return [
                self._duel_snapshot(key, duel)
                for key, duel in self._state["duels"].items()
                if duel["state"] == "waiting"
            ]

    def create_duel(self, user_id: str, bet: int) -> dict[str, Any]:
        """対決を作成する（ベットは呼び出し側がエスクロー済み）。

        対決は個人セッションとは別枠だが、同時に対決は1つまで。
        """
        if int(bet) < DUEL_MIN_BET:
            raise ItemError(f"ベットは{DUEL_MIN_BET} AGO以上で指定してください。")
        uid = str(user_id)
        with self._lock:
            if self.duel_of(uid) is not None:
                raise ItemError("すでに参加中の対決があります。")
            duel = {
                "bet": int(bet), "creator": uid, "challenger": None,
                "hands": {}, "stood": [], "state": "waiting",
                "created_at": time.time(),
            }
            self._state["duels"][uid] = duel
            self._mark_dirty()
            return self._duel_snapshot(uid, duel)

    def join_duel(self, creator_id: str, challenger_id: str) -> dict[str, Any]:
        """対決に参加する（ベットは呼び出し側がエスクロー済み）。

        参加が確定した時点で両者へ2枚ずつ配る。
        """
        creator = str(creator_id)
        challenger = str(challenger_id)
        with self._lock:
            duel = self._state["duels"].get(creator)
            if duel is None or duel["state"] != "waiting":
                raise ItemError("その対決はもう始まっています。")
            if challenger == creator:
                raise ItemError("自分の対決には参加できません。")
            if self.duel_of(challenger) is not None:
                raise ItemError("すでに参加中の対決があります。")
            duel["challenger"] = challenger
            duel["state"] = "playing"
            duel["hands"] = {
                creator: [self._draw_card(), self._draw_card()],
                challenger: [self._draw_card(), self._draw_card()],
            }
            self._mark_dirty()
            return self._duel_snapshot(creator, duel)

    def _finish_duel_locked(self, key: str, duel: dict[str, Any],
                            winner: str | None) -> dict[str, Any]:
        totals = {uid: calc_total(hand) for uid, hand in duel["hands"].items()}
        result = {
            "finished": True,
            "winner": winner,
            "draw": winner is None,
            "bet": int(duel["bet"]),
            "creator": duel["creator"],
            "challenger": duel.get("challenger"),
            "hands": copy.deepcopy(duel["hands"]),
            "totals": totals,
        }
        del self._state["duels"][key]
        self._mark_dirty()
        return result

    def _duel_for_action_locked(self, user_id: str) -> tuple[str, dict[str, Any]]:
        uid = str(user_id)
        for key, duel in self._state["duels"].items():
            if duel["creator"] == uid or duel.get("challenger") == uid:
                if duel["state"] != "playing":
                    raise ItemError("対決はまだ始まっていません。")
                return key, duel
        raise ItemError("参加中の対決がありません。")

    def _settle_if_both_stood_locked(self, key: str,
                                     duel: dict[str, Any]) -> dict[str, Any] | None:
        players = [duel["creator"], duel.get("challenger")]
        if not all(p in duel["stood"] for p in players if p):
            return None
        totals = {uid: calc_total(hand) for uid, hand in duel["hands"].items()}
        creator_total = totals[duel["creator"]]
        challenger_total = totals[duel["challenger"]]
        if creator_total == challenger_total:
            winner = None
        elif creator_total > challenger_total:
            winner = duel["creator"]
        else:
            winner = duel["challenger"]
        return self._finish_duel_locked(key, duel, winner)

    def duel_hit(self, user_id: str) -> dict[str, Any]:
        """ヒット。バーストしたら相手の勝ちで即決着。21 は自動スタンド。"""
        uid = str(user_id)
        with self._lock:
            key, duel = self._duel_for_action_locked(uid)
            if uid in duel["stood"]:
                raise ItemError("すでにスタンドしています。")
            duel["hands"][uid].append(self._draw_card())
            total = calc_total(duel["hands"][uid])
            if total > 21:
                opponent = (duel["challenger"] if uid == duel["creator"]
                            else duel["creator"])
                result = self._finish_duel_locked(key, duel, opponent)
                result["bust"] = uid
                return result
            if total == 21 and uid not in duel["stood"]:
                duel["stood"].append(uid)
            self._mark_dirty()
            settled = self._settle_if_both_stood_locked(key, duel)
            if settled is not None:
                return settled
            snapshot = self._duel_snapshot(key, duel)
            snapshot["finished"] = False
            return snapshot

    def duel_stand(self, user_id: str) -> dict[str, Any]:
        """スタンド。両者がスタンドしたら合計の大きい方の勝ち。"""
        uid = str(user_id)
        with self._lock:
            key, duel = self._duel_for_action_locked(uid)
            if uid not in duel["stood"]:
                duel["stood"].append(uid)
            self._mark_dirty()
            settled = self._settle_if_both_stood_locked(key, duel)
            if settled is not None:
                return settled
            snapshot = self._duel_snapshot(key, duel)
            snapshot["finished"] = False
            return snapshot

    def cancel_duel(self, user_id: str) -> dict[str, Any]:
        """対決を取り消し、返金対象を返す。

        募集中は作成者だけが取り消せる。対戦中の中断（タイムアウト等）
        は参加者どちらからでも可で、双方へ全額返金する（S6-3）。
        """
        uid = str(user_id)
        with self._lock:
            for key, duel in list(self._state["duels"].items()):
                if duel["creator"] != uid and duel.get("challenger") != uid:
                    continue
                if duel["state"] == "waiting" and duel["creator"] != uid:
                    raise ItemError("取り消せるのは作成者だけです。")
                bet = int(duel["bet"])
                refunds = [{"user_id": duel["creator"], "amount": bet}]
                if duel.get("challenger"):
                    refunds.append(
                        {"user_id": duel["challenger"], "amount": bet})
                del self._state["duels"][key]
                self._mark_dirty()
                return {"cancelled": True, "refunds": refunds}
        raise ItemError("参加中の対決がありません。")

    # ------------------------------------------------------------------ dice
    def play_dice(self, max_value: int, number: int) -> dict[str, Any]:
        """数字当ての抽選（原典 dice: 当たれば bet × max が賞金）。

        状態は持たない。ベットの支払いと賞金の払いは呼び出し側が行う。
        """
        if not DICE_MIN_MAX <= int(max_value) <= DICE_MAX_MAX:
            raise ItemError(
                f"範囲は{DICE_MIN_MAX}〜{DICE_MAX_MAX}で指定してください。")
        if not 1 <= int(number) <= int(max_value):
            raise ItemError("予想は範囲内の数字で指定してください。")
        rolled = self._rng.randint(1, int(max_value))
        return {"rolled": rolled, "hit": rolled == int(number)}
