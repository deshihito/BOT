# -*- coding: utf-8 -*-
"""編成ガチャ＋キャラ収集の単一の置き場。

原典（パンBot）の編成ガチャは characters.json 前提で、そのファイルは
未共有かつ中身は他社IPのため使えない。ユーザー指示（2026-11-06）に
より、キャストは AGO BOT の人狼（core/game/jinrou/common.py の HELP_ROLES）
に出てくるアゴキャラ／役職をそのまま使う。全30役職を収録し、
レアリティは役職の格・希少さに寄せて付けた（上位職・発展職・陣営の
要は高レア）。名前・陣営・説明は HELP_ROLES と一致させる（テストで
突き合わせる）。

仕組み（AGO 側の設計）:
- レアリティ4段階（N/R/SR/SSR）。抽選は段階の重み → 段階内一様
- 10連は R 以上が1体確定
- かぶりはレアリティ別のコインへ自動変換する
- 編成は所持キャラから最大3体（お気に入り表示用）

保存は data/gacha.json（環境変数 GACHA_DATA_PATH で変更可）に
メモリ主体＋バッチフラッシュ＋原子差し替え。コインの支払いと
変換の付与は cogs/gacha.py が wallet の CAS 経路で行う。
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

from core.support import emojis

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 価格・変換（暫定値。コイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: 単発の価格（AGO）。確定式（仕様 S0）: 中央値ユーザーの1日の想定
#: 獲得の0.5〜1日分。実測（tools/coin_distribution.py）後に確定する。
SINGLE_PRICE = 500

#: 10連の価格（AGO）。
TEN_PRICE = 4500
TEN_COUNT = 10

#: 編成できる最大数。
PARTY_MAX = 3

#: かぶりの自動変換額（AGO、レアリティ別）。
DUPLICATE_COINS = {"N": 50, "R": 150, "SR": 500, "SSR": 2000}

#: レアリティ段階の抽選重み（段階内は一様）。
RARITY_WEIGHTS = {"N": 50, "R": 35, "SR": 12, "SSR": 3}
RARITY_ORDER = ("N", "R", "SR", "SSR")

#: 編成ボーナス（次期仕様 S3）: レアリティ点。編成中の合計 P に対して
#: P × PARTY_BONUS_RATE_PER_POINT の確率で採掘に追加抽選が付く。
RARITY_POINTS = {"N": 1, "R": 2, "SR": 3, "SSR": 4}
PARTY_BONUS_RATE_PER_POINT = 0.02

#: 天井（次期仕様 S6-2）: SSR が出ていない累計回数がこの回数に届いた
#: 抽選は SSR が確定する。カウンタは SSR 排出で 0 に戻る。
PITY_LIMIT = 90

#: transaction_history の理由コード。
HISTORY_REASON = "gacha"
HISTORY_REASON_DUP = "gacha_dup"

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

# ---------------------------------------------------------------------------
# キャスト（人狼 HELP_ROLES の全30役職。id は HELP_ROLES のスラッグ）
# ---------------------------------------------------------------------------

_EMOJI_BY_ID = {
    "villager": emojis.AGOMUNI,
    "seer": emojis.URANAI,
    "medium": emojis.REIBAI,
    "great-medium": emojis.REIBAI,
    "knight": emojis.KISHI,
    "nyurou": emojis.NYUROU,
    "baker": emojis.PANYA,
    "maasai": emojis.MASAI,
    "werewolf": emojis.JINROU,
    "big-wolf": emojis.JINROU,
    "madman": emojis.KYOJIN,
    "fanatic": emojis.KYOJIN,
    "hage": emojis.HAGE,
    "menhera": emojis.MENHERA,
    "yandere": emojis.MENHERA,
    "agomuni-cannon": emojis.AGOMUNIMUNI,
}

# (id, 名前, 陣営, 説明, レアリティ) — 名前・陣営・説明は HELP_ROLES と同じ。
_CAST = [
    ("villager", "一般通過あごむに", "村人陣営", "空気。", "N"),
    ("tough-muni", "タフむに", "村人陣営", "殺された時に最後の一撃で相手を道連れにする根性の一般通過。", "N"),
    ("nyurou", "入狼", "村人陣営", "人狼のような名前の村人。占われると黒判定が出る不幸なやつ。", "N"),
    ("baker", "パン屋", "村人陣営", "生きていれば朝にパンを配る。飯を食え。", "N"),
    ("marble-breaker", "ビー玉ブレイカー", "村人陣営", "占い師の判定が30%の確率でひっくり返る。", "N"),
    ("netizen", "ネット民", "村人陣営", "一般の役職と違い夜に発言でき昼に発言できない。", "N"),
    ("aho", "アホ", "村人陣営", "役職効果はなく村人陣営。占うと白判定となる。表示上はメンヘラ、ハゲ、狂人のいずれかに偽装されている。", "N"),
    ("slave", "奴隷", "村人陣営", "貴族とセットで発生。貴族が死ぬと代わりに死ぬ。貴族が誰か分かる。", "N"),
    ("seer", "占い師", "村人陣営", "毎晩1人を占える。安物のビー玉を使って白か黒かを見抜く。", "R"),
    ("medium", "霊媒師", "村人陣営", "昨日追放された者が白か黒か分かる。占い師とは商売敵なので中が悪い。", "R"),
    ("knight", "騎士", "村人陣営", "毎晩1人をつまようじで守る。自分は守れない不器用なやつ。", "R"),
    ("maasai", "マサイ族", "村人陣営", "夜に1人を観察する。もし対象が人狼なら襲撃を50%で回避する準備を整える。真偽は誰にもわからない。", "R"),
    ("madman", "狂人", "人狼陣営", "人狼の味方をする人間。人狼が誰かは知らないが、とにかく場を乱す。", "R"),
    ("hage", "ハゲ", "第三者陣営", "追放されたら勝利。髪の毛が観測できないバグのせいで目立ちすぎる。", "R"),
    ("noble", "貴族", "村人陣営", "奴隷とセットで発生。死亡判定を自動的に奴隷に肩代わりさせることができる（奴隷が存在する場合）。奴隷が誰か分かる。", "R"),
    ("lovers", "リア充", "村人陣営", "2人1組で存在し、お互いが誰かを知っている。片方が死ぬともう片方も道連れになる。実は片方が不倫しているが見た目が同じにしか見えないのでどちらかかは分からない", "R"),
    ("chairman", "議長", "村人陣営", "会議中に『スキップ』で議論を即終了→通常投票へ。ゲーム中一回だけ『強制投票』と発言すると議長専用の投票箱が設置され、議長が直接追放対象を選べる。", "R"),
    ("party-person", "陽キャ", "村人陣営", "毎晩1人をℳ𝓎𝒽ℴ𝓂ℯに連れ込む。相手が人狼/デカ狼なら陽キャが死ぬ。相手がメンヘラなら2人ともリア充に変化。それ以外は酔い潰してそのプレイヤーの夜のアクションをキャンセルする。", "R"),
    ("great-medium", "大霊媒師", "村人陣営", "霊媒師の上位職。追放者の白黒を自動通知に加え、夜に死者ならば誰でも調べられ役職まで判明する。", "SR"),
    ("trapper", "罠師", "村人陣営", "騎士の上位職。対象を守るだけでなく、狼が守った対象を襲撃した場合にその狼を返り討ちにする。", "SR"),
    ("big-wolf", "デカ狼", "人狼陣営", "占い師を賄賂で黙らせる人狼。占い師に白判定を出させる。霊媒師には黒と出る。", "SR"),
    ("fanatic", "狂信者", "人狼陣営", "人狼とデカ狼が誰かを知っている熱狂的なファン。人狼陣営の参謀。", "SR"),
    ("musician", "ミュージシャン", "村人陣営", "陽キャの発展職。ゲーム中1度だけ夜にパーティを開催してランダムに4人を招待できる。招待者は殺されなくなり夜のアクションもキャンセル。ただし人狼/デカ狼が混じっていた場合30%で招待者の中の非狼陣営が1人死亡。", "SR"),
    ("wankoro", "ワンころ", "第三者陣営", "最初に飼い主を決める。飼い主が死ぬかいない場合は野良化して人狼になる。占うと黒判定が出る。", "SR"),
    ("bat-muni", "コウモリむに", "第三者陣営", "ハゲの上位職。ただし最後まで生き残れば追加勝利できる。", "SR"),
    ("mokumoku", "もくもく", "第三者陣営", "ビー玉ブレイカーの発展職。3フェーズ全員の役職構成が非公開になる。死ぬと即時に役職構成が公開される。夜の行動ログももくもくになる", "SR"),
    ("werewolf", "人狼", "人狼陣営", "村人を食べる。仲間同士は誰が人狼か知っている。", "SSR"),
    ("menhera", "メンヘラ", "第三者陣営", "自分に関与した（占う、守る、食べる）者を物理的に消去する。占うと黒判定が出る。", "SSR"),
    ("yandere", "ヤンデレ", "人狼陣営", "メンヘラの発展職、人狼1人をランダムに選びその人狼に夜干渉した人間を殺す。", "SSR"),
    ("agomuni-cannon", "あごむに破道砲", "第三者陣営", "自爆して対象を道連れにする。さらにもう1人も誤発で巻き込む。（※3日目の夜以降に使用可能）", "SSR"),
]

CHARACTERS: tuple[dict[str, Any], ...] = tuple(
    {
        "id": char_id,
        "name": name,
        "faction": faction,
        "desc": desc,
        "rarity": rarity,
        "emoji": _EMOJI_BY_ID.get(char_id, ""),
    }
    for char_id, name, faction, desc, rarity in _CAST
)
CHARACTER_BY_ID = {c["id"]: c for c in CHARACTERS}
_BY_RARITY: dict[str, list[dict[str, Any]]] = {
    rarity: [c for c in CHARACTERS if c["rarity"] == rarity]
    for rarity in RARITY_ORDER
}


def _roll_one(rng: random.Random) -> dict[str, Any]:
    rarities = list(RARITY_WEIGHTS)
    weights = [RARITY_WEIGHTS[r] for r in rarities]
    rarity = rng.choices(rarities, weights=weights, k=1)[0]
    return rng.choice(_BY_RARITY[rarity])


def roll_characters(rng: random.Random, count: int) -> list[dict[str, Any]]:
    """count 体を抽選する。10連（TEN_COUNT）のときは R 以上を1体保証する。"""
    results = [_roll_one(rng) for _ in range(max(0, int(count)))]
    if count == TEN_COUNT and results and all(
            c["rarity"] == "N" for c in results):
        pool = _BY_RARITY["R"] + _BY_RARITY["SR"] + _BY_RARITY["SSR"]
        results[-1] = rng.choice(pool)
    return results


def roll_pulls(rng: random.Random, count: int,
               pity: int) -> tuple[list[dict[str, Any]], int]:
    """天井つきで count 体を抽選し、(結果, 新しい天井カウンタ) を返す。

    カウンタは「SSR が出ていない累計回数」。次の抽選でカウンタが
    PITY_LIMIT に届く場合はその抽選が SSR 確定になり、カウンタは
    0 に戻る。通常抽選で SSR が出た場合も 0 に戻る。10連の R 以上
    保証（全て N のとき最後を差し替え）が SSR になった場合も同様に
    リセットする（差し替えは最後の1枠なので、それ以降の枠は無い）。
    """
    pity = max(0, int(pity))
    results: list[dict[str, Any]] = []
    for _ in range(max(0, int(count))):
        if pity + 1 >= PITY_LIMIT:
            results.append(rng.choice(_BY_RARITY["SSR"]))
            pity = 0
            continue
        character = _roll_one(rng)
        results.append(character)
        pity = 0 if character["rarity"] == "SSR" else pity + 1
    if count == TEN_COUNT and results and all(
            c["rarity"] == "N" for c in results):
        pool = _BY_RARITY["R"] + _BY_RARITY["SR"] + _BY_RARITY["SSR"]
        results[-1] = rng.choice(pool)
        if results[-1]["rarity"] == "SSR":
            pity = 0
    return results, pity


def party_power_of(party_ids: list[str]) -> int:
    """編成中キャラのレアリティ点合計（編成ボーナス S3 の P）。"""
    total = 0
    for char_id in party_ids:
        character = CHARACTER_BY_ID.get(str(char_id))
        if character is not None:
            total += RARITY_POINTS.get(character["rarity"], 0)
    return total


def character_line(character: dict[str, Any]) -> str:
    """結果・コレクション表示用の1行。"""
    emoji = f"{character['emoji']} " if character.get("emoji") else ""
    return f"{emoji}**{character['name']}**（{character['rarity']}／{character['faction']}）"


# ---------------------------------------------------------------------------
# コレクション保存
# ---------------------------------------------------------------------------

def _empty_state() -> dict[str, Any]:
    return {"users": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entry in users.items():
            if not isinstance(entry, dict):
                continue
            owned_raw = entry.get("owned")
            owned = {}
            if isinstance(owned_raw, dict):
                for char_id, count in owned_raw.items():
                    if char_id in CHARACTER_BY_ID and isinstance(count, int) and count > 0:
                        owned[str(char_id)] = count
            party_raw = entry.get("party")
            party = [
                str(char_id) for char_id in party_raw
                if isinstance(party_raw, list) and str(char_id) in owned
            ][:PARTY_MAX] if isinstance(party_raw, list) else []
            pulls = entry.get("total_pulls")
            pity = entry.get("pity")
            state["users"][str(uid)] = {
                "owned": owned,
                "party": party,
                "total_pulls": int(pulls) if isinstance(pulls, int) and pulls > 0 else 0,
                "pity": int(pity) if isinstance(pity, int) and pity > 0 else 0,
            }
    return state


_DEFAULT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "gacha.json"


def default_path() -> Path:
    return Path(os.environ.get("GACHA_DATA_PATH") or _DEFAULT_PATH)


class GachaStore:
    """コレクション（所持数・編成・累計回数）と JSON 保存。"""

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        flush_every: int = FLUSH_EVERY_EVENTS,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
    ):
        self._path = Path(path) if path is not None else default_path()
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
            logger.exception("gacha: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 状態
    def _entry_locked(self, user_id: str) -> dict[str, Any]:
        return self._state["users"].setdefault(
            str(user_id), {"owned": {}, "party": [], "total_pulls": 0, "pity": 0})

    def owned(self, user_id: str) -> dict[str, int]:
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return dict(entry.get("owned") or {})

    def count_of(self, user_id: str, character_id: str) -> int:
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return int((entry.get("owned") or {}).get(str(character_id), 0))

    def add(self, user_id: str, character_id: str) -> int:
        """1体追加し、追加後の所持数を返す。"""
        with self._lock:
            entry = self._entry_locked(user_id)
            entry["owned"][str(character_id)] = (
                int(entry["owned"].get(str(character_id), 0)) + 1)
            self._mark_dirty()
            return entry["owned"][str(character_id)]

    def record_pulls(self, user_id: str, count: int) -> None:
        with self._lock:
            entry = self._entry_locked(user_id)
            entry["total_pulls"] = int(entry["total_pulls"]) + int(count)
            self._mark_dirty()

    def total_pulls(self, user_id: str) -> int:
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return int(entry.get("total_pulls") or 0)

    # ------------------------------------------------------------------ 天井（S6-2）
    def pity(self, user_id: str) -> int:
        """SSR が出ていない累計回数。"""
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return int(entry.get("pity") or 0)

    def set_pity(self, user_id: str, value: int) -> None:
        with self._lock:
            entry = self._entry_locked(user_id)
            entry["pity"] = max(0, int(value))
            self._mark_dirty()

    # ------------------------------------------------------------------ 編成ボーナス（S3）
    def party_power(self, user_id: str) -> int:
        """編成中キャラのレアリティ点合計 P（編成ボーナス用）。"""
        return party_power_of(self.party(user_id))

    def party(self, user_id: str) -> list[str]:
        with self._lock:
            entry = self._state["users"].get(str(user_id)) or {}
            return list(entry.get("party") or [])

    def set_party(self, user_id: str, character_ids: list[str]) -> list[str]:
        """編成を設定する。所持していないキャラ・重複・上限超過は ValueError。"""
        ids = [str(c) for c in character_ids]
        if len(ids) > PARTY_MAX:
            raise ValueError(f"編成は{PARTY_MAX}体までです。")
        if len(ids) != len(set(ids)):
            raise ValueError("編成に重複があります。")
        with self._lock:
            entry = self._entry_locked(user_id)
            for char_id in ids:
                if int(entry["owned"].get(char_id, 0)) <= 0:
                    raise ValueError("所持していないキャラは編成できません。")
            entry["party"] = ids
            self._mark_dirty()
            return list(ids)
