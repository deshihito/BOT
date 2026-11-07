# -*- coding: utf-8 -*-
"""アイテム基盤（定義・インベントリ・ショップ・宝箱）の単一の置き場。

パンBot 資産移植 Phase 2。原典の「アイテム辞書＋所持 {count, expires}＋
期限切れの自動削除＋宝箱のドロップテーブル分離」という構造を採るが、
中身（名前・説明・価格）は AGO 用に新規作成し、効果が未実装のアイテムは
作らない（原典で説明が「実装中」のままだった11種の轍を踏まない）。

設計の要点:
- 所持はユーザー単位・全ギルド共通。保存は core/general/market.py と同じ流儀:
  専用 JSON（既定 data/items.json、環境変数 ITEMS_DATA_PATH で変更可）に、
  メモリ主体＋バッチフラッシュ＋原子差し替え。市場とはファイルを分ける。
- AGO コインの増減そのものはここでは行わない（cogs/wallet.py の安全な
  残高更新経路に委ねる）。ここで扱うのは所持・効果・抽選までで、購入／売却／
  宝箱コインの実移動は呼び出し側（cogs/items.py）が wallet 経由で行う。
- 効果は2層に分ける:
  1. 能動効果（使うと発動）: EFFECT_HANDLERS に「効果ID → ハンドラ」を登録
     する方式。ハンドラは (store, user_id, item_def, now) を受け取り、
     発動結果の文言を返す。Phase 3 の合成・既存ゲームはこちらに登録する。
  2. 受動効果（発動中かどうかを他システムが引く）: has_effect(user_id, 効果ID)。
     市場手数料の割引（FEE_DISCOUNT_EFFECT）が最初の接続例で、cogs/market.py
     が売買時に引いて手数料率を決める。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import random
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from core.support import data_paths

logger = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))

# ---------------------------------------------------------------------------
# 経済定数（Phase 2 の暫定値。価格の絶対値は AGO のコイン分布の実測後に調整する）
# ---------------------------------------------------------------------------

#: コインの単位表記（cogs/wallet.py と同じ）。
COIN_NAME = "AGO"

#: 手数料パスの効果IDと割引率（有効期間中、市場手数料がこの倍率になる）。
FEE_DISCOUNT_EFFECT = "fee_discount"
FEE_DISCOUNT_MULTIPLIER = 0.5

#: 効果アイテム拡充（2026-11-06）の効果IDと倍率。いずれも「使うと
#: 期間発動」する受動効果で、消費側が has_effect を引いて効かせる。
#: 接続先は各定数のコメントと cogs 側の解決部を参照。
#: 採掘ドリンク: 採掘1回ごとに通常テーブルを追加でもう1回引ける。
MINING_BOOST_EFFECT = "mining_boost"
#: 合成触媒: 合成・委託のレア結果の重み倍率（委託の倍率と乗算し、
#: 合計は core/general/craft.py の RARE_BOOST_CAP でキャップ）。
CRAFT_CATALYST_EFFECT = "craft_catalyst"
CRAFT_CATALYST_MULTIPLIER = 1.5
#: 防犯チャーム: 自分を対象とする steal が自動で失敗する。
STEAL_GUARD_EFFECT = "steal_guard"
#: 没収ガード: スロットの全額没収を1回だけペナルティ相当に変換する。
CONFISCATION_GUARD_EFFECT = "confiscation_guard"
#: 加速オイル: 工房の生産決済で経過時間がこの倍率で数えられる。
WORKSHOP_HASTE_EFFECT = "workshop_haste"
WORKSHOP_HASTE_MULTIPLIER = 2.0
#: 優待パス: 市場の1回取引上限のプール比（手数料パスとは別効果）。
TRADE_VIP_EFFECT = "trade_vip"
TRADE_VIP_CAP_RATIO = 0.02
#: 大怪盗: 使うと期間中、steal の成功率と奪える額が上がる。
THIEF_EFFECT = "master_thief"
THIEF_RATE_BONUS = 0.30
THIEF_AMOUNT_MULTIPLIER = 2.0

#: 効果アイテム第2弾（次期仕様 S6-4）の効果IDと倍率。
#: お祓い棒: 有効期間中、スロットで「6」の出目が出にくくなる
#: （core/game/gambling/gambling.py の spin_slot が重み倍率で受ける）。
SIX_SUPPRESS_EFFECT = "six_suppress"
SIX_SUPPRESS_MULTIPLIER = 0.5
#: 落盤対策: 有効期間中、採掘の空振り（失敗）が無効になる
#: （core/game/mining.py の dig が no_fail で受ける）。
MINING_NO_FAIL_EFFECT = "mining_no_fail"
#: 直下掘り: 使うと、次の採掘セッション1回だけ特殊ダイスになる
#: 窓が開く（消費側の circulation が開始時に効果を読み、セッションへ
#: フラグを立てて効果を消費する）。duration はその保持ウィンドウ。
DIRECT_DIG_EFFECT = "direct_dig"
#: 悪魔的な報酬／プリズンマイナー（所持で効く特殊アイテム群。効果の
#: 実体は gambling cog の没収処理と circulation の採掘入口）。
DEVIL_REWARD_ITEM = "devil_reward"
PRISON_MINER_ITEM = "prison_miner"
#: 悪魔的な報酬: 全額没収が発生したときに限ってこの確率で没収額の
#: この倍率が戻る（1回で消滅。没収ガードが先に発動した場合は不発）。
DEVIL_REWARD_RATE = 0.25
DEVIL_REWARD_MULTIPLIER = 2

#: steal 攻防アイテムのアイテムID（所持で効く／steal 時に消費される
#: 特殊アイテム群。効果の実体は cogs/circulation.py の steal 判定）。
MUD_HAT_ITEM = "mud_hat"
DAI_MUD_HAT_ITEM = "dai_mud_hat"
BATON_ITEM = "baton"
DAI_BATON_ITEM = "dai_baton"
MASTER_THIEF_ITEM = "master_thief"

#: 泥帽系の成功時上乗せ率（対象残高に対する一様乱数の範囲）と成功率補正。
MUD_HAT_BONUS_MIN_RATE = 0.10
MUD_HAT_BONUS_MAX_RATE = 1.00
DAI_MUD_HAT_BONUS_MIN_RATE = 0.30
DAI_MUD_HAT_BONUS_MAX_RATE = 1.50
DAI_MUD_HAT_RATE_BONUS = 0.20
#: 警棒の撃退率（大警棒は常時撃退）。
BATON_REPEL_RATE = 0.50

#: 宝箱1個の価格（ショップ購入）。
BOX_PRICE = 1000

FLUSH_EVERY_EVENTS = 20
FLUSH_INTERVAL_SECONDS = 60.0

# ---------------------------------------------------------------------------
# アイテム定義（宣言的辞書）
#
# id / name / desc / price / duration_hours / kind / purchasable / sell_price
# - price: ショップ購入価格（購入不可アイテムは Phase 3 の合成・工房での
#   価値の目安として持つ。いずれも暫定値・実測後に調整）
# - duration_hours: 「使う」と発動して効果が続く時間。None は時間効果なし
# - kind: material（素材）/ collectible（換金コレクション）/
#   consumable（消費）/ box（宝箱）
# - purchasable: ショップで買えるか（上位素材・レアは False = 合成・宝箱でのみ）
# - sell_price: 売却額。全アイテム共通で price の 1/2（切り捨て）。
#   個別設定はせず、ITEM_DEFS の直後で一律に代入する
# - effect: 能動効果の効果ID（EFFECT_HANDLERS に実体があるものだけ）
# - box_drop: 宝箱の抽選候補に入れてよいか（BOX_NEVER_DROP と二重に守る）
# ---------------------------------------------------------------------------

ITEM_DEFS: dict[str, dict[str, Any]] = {
    "scrap": {
        "name": "スクラップ",
        "desc": "最下位の素材。合成の材料。",
        "price": 50,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "metal_piece": {
        "name": "金属片",
        "desc": "合成の材料になる金属素材。",
        "price": 400,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "circuit_piece": {
        "name": "回路片",
        "desc": "合成の材料になる電子部品。",
        "price": 1200,
        "duration_hours": None,
        "kind": "material",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "reinforced_alloy": {
        "name": "強化合金",
        "desc": "上位素材。合成でのみ作れる。",
        "price": 5000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": True,
    },
    "mystery_crystal": {
        "name": "謎の結晶",
        "desc": "レア素材。宝箱や合成で手に入る。",
        "price": 20000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": True,
    },
    "alloy_plate": {
        "name": "合金プレート",
        "desc": "中間素材。合成で作る。",
        "price": 2500,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "circuit_board": {
        "name": "電子基板",
        "desc": "中間素材。合成で作る。",
        "price": 3500,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "precision_parts": {
        "name": "精密部品",
        "desc": "上位素材。合成で作る。",
        "price": 6000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "reinforced_frame": {
        "name": "強化フレーム",
        "desc": "上位素材。合成で作る。",
        "price": 9000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "ago_core": {
        "name": "アゴコア",
        "desc": "合成チェーンの最終素材。売却額が高い。",
        "price": 100000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "gold_scrap": {
        "name": "金のスクラップ",
        "desc": "換金用コレクション。",
        "price": 10000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "silver_scrap": {
        "name": "銀のスクラップ",
        "desc": "換金用コレクション。",
        "price": 2000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": False,
        "effect": None,
        "box_drop": True,
    },
    "platinum_scrap": {
        "name": "プラチナスクラップ",
        "desc": "換金用コレクション。滅多に出ない。",
        "price": 50000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": False,
        "effect": None,
        "box_drop": True,
    },
    "computing_unit": {
        "name": "演算ユニット",
        "desc": "上位素材。合成で作る。",
        "price": 12000,
        "duration_hours": None,
        "kind": "material",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "enhanced_ago_core": {
        "name": "強化アゴコア",
        "desc": "アゴコアの上位。売却額が最も高い。",
        "price": 300000,
        "duration_hours": None,
        "kind": "collectible",
        "purchasable": False,
        "effect": None,
        "box_drop": False,
    },
    "mining_drink": {
        "name": "採掘ドリンク",
        "desc": "使うと1時間、採掘で追加でもう1回掘れる。",
        "price": 500,
        "duration_hours": 1,
        "kind": "consumable",
        "purchasable": True,
        "effect": MINING_BOOST_EFFECT,
        "box_drop": True,
    },
    "craft_catalyst": {
        "name": "合成触媒",
        "desc": "使うと2時間、合成でレアな結果が出やすくなる。",
        "price": 1500,
        "duration_hours": 2,
        "kind": "consumable",
        "purchasable": True,
        "effect": CRAFT_CATALYST_EFFECT,
        "box_drop": True,
    },
    "steal_charm": {
        "name": "防犯チャーム",
        "desc": "使うと24時間、自分への盗みが自動で失敗する。",
        "price": 2000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "effect": STEAL_GUARD_EFFECT,
        "box_drop": False,
    },
    "confiscation_guard": {
        "name": "没収ガード",
        "desc": "使うと24時間、スロットの全額没収を1回だけ防ぐ。",
        "price": 5000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "effect": CONFISCATION_GUARD_EFFECT,
        "box_drop": False,
    },
    "workshop_oil": {
        "name": "加速オイル",
        "desc": "使うと4時間、工房の生産が速く貯まる。",
        "price": 2000,
        "duration_hours": 4,
        "kind": "consumable",
        "purchasable": True,
        "effect": WORKSHOP_HASTE_EFFECT,
        "box_drop": True,
    },
    "trade_vip": {
        "name": "優待パス",
        "desc": "使うと24時間、市場の取引上限が広がる。",
        "price": 4000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "effect": TRADE_VIP_EFFECT,
        "box_drop": False,
    },
    "fee_pass": {
        "name": "手数料パス",
        "desc": "使うと24時間、市場の売買手数料が半額になる。",
        "price": 3000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "effect": FEE_DISCOUNT_EFFECT,
        "box_drop": True,
    },
    "mud_hat": {
        "name": "泥帽",
        "desc": "持って盗むと成功時に大きく上乗せして奪える。失敗すると逮捕される。盗み1回で消滅。",
        "price": 8000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "dai_mud_hat": {
        "name": "大泥帽",
        "desc": "泥帽の上位。成功時の上乗せと成功率がさらに上がる。失敗時の逮捕も長い。盗み1回で消滅。",
        "price": 80000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": False,
    },
    "baton": {
        "name": "警棒",
        "desc": "持っていると、盗みに来た相手を撃退して逮捕できることがある。発動で消滅。",
        "price": 5000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": True,
    },
    "dai_baton": {
        "name": "大警棒",
        "desc": "警棒の上位。盗みに来た相手を必ず撃退し、長く逮捕する。発動で消滅。",
        "price": 100000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": False,
    },
    "master_thief": {
        "name": "大怪盗",
        "desc": "使うと12時間、盗みの成功率と奪える額が上がる。",
        "price": 50000,
        "duration_hours": 12,
        "kind": "consumable",
        "purchasable": True,
        "effect": THIEF_EFFECT,
        "box_drop": False,
    },
    "oharai_bou": {
        "name": "お祓い棒",
        "desc": "使うと1時間、スロットで不穏な数字が出にくくなる。",
        "price": 2000,
        "duration_hours": 1,
        "kind": "consumable",
        "purchasable": True,
        "effect": SIX_SUPPRESS_EFFECT,
        "box_drop": True,
    },
    "devil_reward": {
        "name": "悪魔的な報酬",
        "desc": "持っていると、全額没収のときに一度だけ思いがけない見返りがあるかもしれない。",
        "price": 5000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": False,
    },
    "anti_cavein": {
        "name": "落盤対策",
        "desc": "使うと1時間、採掘で空振りしなくなる。",
        "price": 1500,
        "duration_hours": 1,
        "kind": "consumable",
        "purchasable": True,
        "effect": MINING_NO_FAIL_EFFECT,
        "box_drop": True,
    },
    "direct_dig": {
        "name": "直下掘り",
        "desc": "次の採掘1回だけ真下へ一気に掘る。大きく当たるか、大きく外すか。",
        "price": 2000,
        "duration_hours": 24,
        "kind": "consumable",
        "purchasable": True,
        "effect": DIRECT_DIG_EFFECT,
        "box_drop": False,
    },
    "prison_miner": {
        "name": "プリズンマイナー",
        "desc": "逮捕中でも採掘だけはできる不思議な許可証。採掘1回ごとに1枚使う。",
        "price": 3000,
        "duration_hours": None,
        "kind": "consumable",
        "purchasable": True,
        "effect": None,
        "box_drop": False,
    },
    "treasure_box": {
        "name": "宝箱",
        "desc": "開けるとコインや素材が出る。",
        "price": BOX_PRICE,
        "duration_hours": None,
        "kind": "box",
        "purchasable": True,
        "effect": None,
        "box_drop": False,
    },
}

# 売却額は全アイテム共通で購入価格の 1/2（切り捨て）に統一する
# （2026-11-06 ユーザー指示「基本買う額の二分の一で良い」）。
# 従来コレクション系だけにあった個別 buyback は廃止した。
for _definition in ITEM_DEFS.values():
    _definition["sell_price"] = int(_definition["price"]) // 2
del _definition

# ---------------------------------------------------------------------------
# 宝箱ドロップ（宣言的テーブル。原典 BOX_DROP_RATES / BOX_NEVER_DROP の分離を採用）
#
# 1個あたりの抽選は各行が独立。コインは常時出る行として置く。
# 期待値（価格換算）は宝箱価格 1000 AGO を下回るよう抑えてある
# （拡充後の正確な値は box_expected_value() で算出し、テストで
# 価格未満であることを固定する）＝開け続けて増えない。
# ---------------------------------------------------------------------------

#: 宝箱から絶対に出ないアイテム（定義側 box_drop=False と二重の防御）。
BOX_NEVER_DROP = frozenset({"treasure_box"})

#: kind="coins" の行は item ではなくコイン（min〜max の一様分布）。
#: 2026-11-06 の拡充分（銀・プラチナのスクラップ、効果アイテム3種）を
#: 含めても期待値は価格 1000 AGO を下回る（box_expected_value() で検証）。
BOX_DROPS: tuple[dict[str, Any], ...] = (
    {"kind": "coins", "chance": 1.0, "min": 30, "max": 300},
    {"kind": "item", "item": "scrap", "chance": 0.35, "min": 1, "max": 3},
    {"kind": "item", "item": "metal_piece", "chance": 0.15, "min": 1, "max": 1},
    {"kind": "item", "item": "circuit_piece", "chance": 0.06, "min": 1, "max": 1},
    {"kind": "item", "item": "fee_pass", "chance": 0.04, "min": 1, "max": 1},
    {"kind": "item", "item": "gold_scrap", "chance": 0.02, "min": 1, "max": 1},
    {"kind": "item", "item": "reinforced_alloy", "chance": 0.015, "min": 1, "max": 1},
    {"kind": "item", "item": "mystery_crystal", "chance": 0.003, "min": 1, "max": 1},
    {"kind": "item", "item": "silver_scrap", "chance": 0.01, "min": 1, "max": 1},
    {"kind": "item", "item": "platinum_scrap", "chance": 0.0005, "min": 1, "max": 1},
    {"kind": "item", "item": "mining_drink", "chance": 0.02, "min": 1, "max": 1},
    {"kind": "item", "item": "craft_catalyst", "chance": 0.015, "min": 1, "max": 1},
    {"kind": "item", "item": "workshop_oil", "chance": 0.01, "min": 1, "max": 1},
    {"kind": "item", "item": "baton", "chance": 0.01, "min": 1, "max": 1},
    {"kind": "item", "item": "mud_hat", "chance": 0.005, "min": 1, "max": 1},
    {"kind": "item", "item": "oharai_bou", "chance": 0.01, "min": 1, "max": 1},
    {"kind": "item", "item": "anti_cavein", "chance": 0.01, "min": 1, "max": 1},
)


def box_expected_value() -> float:
    """宝箱1個の期待値（AGO 換算）。コインは額面、アイテムは売却価格→購入価格の順で評価。"""
    total = 0.0
    for row in BOX_DROPS:
        if row["kind"] == "coins":
            total += row["chance"] * (row["min"] + row["max"]) / 2
        else:
            item = ITEM_DEFS[row["item"]]
            value = item["sell_price"] if item["sell_price"] is not None else item["price"]
            total += row["chance"] * (row["min"] + row["max"]) / 2 * value
    return total


def item_def(item_id: str) -> dict[str, Any] | None:
    return ITEM_DEFS.get(item_id)


def resolve_item_id(text: str) -> str | None:
    """アイテムIDまたは名前からIDを引く（モーダル入力用）。"""
    text = (text or "").strip()
    if text in ITEM_DEFS:
        return text
    for item_id, definition in ITEM_DEFS.items():
        if definition["name"] == text:
            return item_id
    return None


class ItemError(Exception):
    """アイテム操作が成立しない理由（ユーザ向け文言をそのまま持つ）。"""


_DEFAULT_PATH = data_paths.data_path("items.json")
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/data/items.json)。移行読み取り専用で、書き込みは行わない。
_STRAY_PATH = data_paths.stray_path(__file__, "items.json")


def default_path() -> Path:
    return Path(os.environ.get("ITEMS_DATA_PATH") or _DEFAULT_PATH)


def _empty_state() -> dict[str, Any]:
    return {"users": {}, "effects": {}}


def _clean_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    users = raw.get("users")
    if isinstance(users, dict):
        for uid, entries in users.items():
            if not isinstance(entries, dict):
                continue
            cleaned = {}
            for item_id, entry in entries.items():
                if item_id not in ITEM_DEFS or not isinstance(entry, dict):
                    continue
                count = entry.get("count")
                if not isinstance(count, (int, float)) or int(count) <= 0:
                    continue
                expires = entry.get("expires")
                cleaned[item_id] = {
                    "count": int(count),
                    "expires": expires if isinstance(expires, str) else None,
                }
            if cleaned:
                state["users"][str(uid)] = cleaned
    effects = raw.get("effects")
    if isinstance(effects, dict):
        for uid, user_effects in effects.items():
            if not isinstance(user_effects, dict):
                continue
            cleaned = {
                str(k): v for k, v in user_effects.items() if isinstance(v, str)
            }
            if cleaned:
                state["effects"][str(uid)] = cleaned
    return state


# ---------------------------------------------------------------------------
# 能動効果ハンドラ（Phase 3・既存ゲームからの接続口）
#
# ハンドラは (store, user_id, item_def, now) を受け取り、発動結果の文言を返す。
# アイテムの消費（count の減算）は use_item 側が先に行う。時間効果は
# item_def["duration_hours"] から store が自動で期限を記録するので、
# ハンドラは「効果IDごとの追加処理」だけを書けばよい。
# ---------------------------------------------------------------------------

EffectHandler = Callable[["ItemStore", str, dict[str, Any], datetime], str]
EFFECT_HANDLERS: dict[str, EffectHandler] = {}


def register_effect(effect_id: str) -> Callable[[EffectHandler], EffectHandler]:
    def decorator(func: EffectHandler) -> EffectHandler:
        EFFECT_HANDLERS[effect_id] = func
        return func

    return decorator


@register_effect(FEE_DISCOUNT_EFFECT)
def _fee_discount_handler(store: "ItemStore", user_id: str, definition: dict[str, Any],
                          now: datetime) -> str:
    hours = definition.get("duration_hours") or 0
    return f"{definition['name']}を使いました。{hours}時間、市場の売買手数料が半額になります。"


def _timed_effect_handler(verb: str) -> EffectHandler:
    """期間発動型の受動効果に共通の発動文言ハンドラを作る。"""
    def handler(store: "ItemStore", user_id: str, definition: dict[str, Any],
                now: datetime) -> str:
        hours = definition.get("duration_hours") or 0
        return f"{definition['name']}を使いました。{hours}時間、{verb}。"

    return handler


register_effect(MINING_BOOST_EFFECT)(
    _timed_effect_handler("採掘で追加でもう一掘りできます"))
register_effect(CRAFT_CATALYST_EFFECT)(
    _timed_effect_handler("合成でレアな結果が出やすくなります"))
register_effect(STEAL_GUARD_EFFECT)(
    _timed_effect_handler("盗みから自分のコインを守れます"))
register_effect(CONFISCATION_GUARD_EFFECT)(
    _timed_effect_handler("スロットの全額没収を1回だけ防げます"))
register_effect(WORKSHOP_HASTE_EFFECT)(
    _timed_effect_handler("工房の加工機の生産が速く進みます"))
register_effect(TRADE_VIP_EFFECT)(
    _timed_effect_handler("市場で一度に取引できる上限が広がります"))
register_effect(THIEF_EFFECT)(
    _timed_effect_handler("盗みの成功率と奪える額が上がります"))
register_effect(SIX_SUPPRESS_EFFECT)(
    _timed_effect_handler("スロットで不穏な数字が出にくくなります"))
register_effect(MINING_NO_FAIL_EFFECT)(
    _timed_effect_handler("採掘で空振りしなくなります"))
register_effect(DIRECT_DIG_EFFECT)(
    _timed_effect_handler("次の採掘1回だけ真下へ一気に掘れます"))


class ItemStore:
    """所持・効果・宝箱抽選と JSON 保存（同期 API、メモリ主体）。

    コインの実移動は行わない。購入／売却／宝箱コインの受け渡しは
    呼び出し側（cogs/items.py）が wallet の安全な経路で行い、失敗したら
    rollback_* でこちらの変更を巻き戻す（core/general/market.py と同じ組み立て）。
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
        raw = self._read_raw()
        if raw is None:
            return _empty_state()
        return _clean_state(raw)

    def _read_raw(self) -> Any:
        # 既定パスのときだけ、旧保存先 (パスずれ期間の core/data/) から
        # 移行読み取りする (旧パス主・正規パスはユーザー単位で補完)。
        # 環境変数や明示パスで保存先が指定されている場合は移行しない。
        if self._path == _DEFAULT_PATH:
            return data_paths.load_migrated(self._path, _STRAY_PATH, fill=True)
        return data_paths.read_json(self._path)

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
            logger.exception("items: 状態の保存に失敗しました path=%s", self._path)

    def _mark_dirty(self) -> None:
        self._dirty += 1
        if self._dirty >= self._flush_every or (
            time.monotonic() - self._last_flush >= self._flush_interval
        ):
            self.flush()

    def maybe_flush(self) -> None:
        if self._dirty and time.monotonic() - self._last_flush >= self._flush_interval:
            self.flush()

    # ------------------------------------------------------------------ 所持
    def _purge_user_locked(self, user_id: str, now: datetime) -> None:
        """期限切れの所持と効果を参照時に落とす（lazy 削除）。"""
        entries = self._state["users"].get(user_id)
        if entries:
            for item_id in list(entries):
                expires = entries[item_id].get("expires")
                if expires:
                    try:
                        expired = datetime.fromisoformat(expires) <= now
                    except ValueError:
                        expired = True
                    if expired:
                        del entries[item_id]
            if not entries:
                self._state["users"].pop(user_id, None)
        effects = self._state["effects"].get(user_id)
        if effects:
            for effect_id in list(effects):
                try:
                    expired = datetime.fromisoformat(effects[effect_id]) <= now
                except ValueError:
                    expired = True
                if expired:
                    del effects[effect_id]
            if not effects:
                self._state["effects"].pop(user_id, None)

    def count(self, user_id: str, item_id: str, now: datetime | None = None) -> int:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entry = self._state["users"].get(str(user_id), {}).get(item_id)
            return int(entry["count"]) if entry else 0

    def inventory(self, user_id: str, now: datetime | None = None) -> dict[str, int]:
        """所持一覧 {item_id: count}（期限切れは落とした後の状態）。"""
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            return {
                item_id: int(entry["count"])
                for item_id, entry in self._state["users"].get(str(user_id), {}).items()
            }

    def add(self, user_id: str, item_id: str, amount: int = 1, *,
            expires_at: datetime | None = None, now: datetime | None = None) -> int:
        """所持を増やす。expires_at は将来の消費期限つき配布用（Phase 3 向け）。"""
        if item_id not in ITEM_DEFS:
            raise ItemError("そのアイテムは存在しません。")
        if amount <= 0:
            raise ItemError("数量を正しく入力してください。")
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entries = self._state["users"].setdefault(str(user_id), {})
            entry = entries.setdefault(item_id, {"count": 0, "expires": None})
            entry["count"] += amount
            if expires_at is not None:
                entry["expires"] = expires_at.astimezone(JST).isoformat()
            self._mark_dirty()
            return int(entry["count"])

    def remove(self, user_id: str, item_id: str, amount: int = 1,
               now: datetime | None = None) -> int:
        """所持を減らす（使い切り・消費）。不足したら ItemError で何も変えない。"""
        if item_id not in ITEM_DEFS:
            raise ItemError("そのアイテムは存在しません。")
        if amount <= 0:
            raise ItemError("数量を正しく入力してください。")
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            entries = self._state["users"].get(str(user_id), {})
            entry = entries.get(item_id)
            if entry is None or int(entry["count"]) < amount:
                raise ItemError(f"{ITEM_DEFS[item_id]['name']}が不足しています。")
            entry["count"] -= amount
            remaining = int(entry["count"])
            if remaining <= 0:
                del entries[item_id]
                if not entries:
                    self._state["users"].pop(str(user_id), None)
            self._mark_dirty()
            return remaining

    # ------------------------------------------------------------------ 効果
    def effect_expires(self, user_id: str, effect_id: str,
                       now: datetime | None = None) -> datetime | None:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            raw = self._state["effects"].get(str(user_id), {}).get(effect_id)
            if not raw:
                return None
            try:
                return datetime.fromisoformat(raw)
            except ValueError:
                return None

    def has_effect(self, user_id: str, effect_id: str, now: datetime | None = None) -> bool:
        return self.effect_expires(user_id, effect_id, now) is not None

    def consume_effect(self, user_id: str, effect_id: str,
                       now: datetime | None = None) -> bool:
        """発動中の効果を1回分として消費する（没収ガード等の使い切り型用）。

        効果が生きていれば消して True、無ければ（期限切れ含む）何も
        変えず False を返す。判定と消費をロック内で原子的に行う。
        """
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            effects = self._state["effects"].get(str(user_id), {})
            if effect_id not in effects:
                return False
            del effects[effect_id]
            if not effects:
                self._state["effects"].pop(str(user_id), None)
            self._mark_dirty()
            return True

    def active_effects(self, user_id: str, now: datetime | None = None) -> dict[str, datetime]:
        now = now or datetime.now(JST)
        with self._lock:
            self._purge_user_locked(str(user_id), now)
            result = {}
            for effect_id, raw in self._state["effects"].get(str(user_id), {}).items():
                try:
                    result[effect_id] = datetime.fromisoformat(raw)
                except ValueError:
                    continue
            return result

    def _activate_effect_locked(self, user_id: str, effect_id: str,
                                duration_hours: float, now: datetime) -> None:
        expires = now + timedelta(hours=duration_hours)
        current = self._state["effects"].get(user_id, {}).get(effect_id)
        if current:
            try:
                # 既に発動中なら残り時間に積み増す（原典の expires 上書き回避に相当）。
                expires = max(expires, datetime.fromisoformat(current) + timedelta(hours=duration_hours))
            except ValueError:
                pass
        self._state["effects"].setdefault(user_id, {})[effect_id] = expires.astimezone(JST).isoformat()

    def use_item(self, user_id: str, item_id: str, now: datetime | None = None) -> str:
        """アイテムを1個使って能動効果を発動する。発動結果の文言を返す。"""
        now = now or datetime.now(JST)
        definition = ITEM_DEFS.get(item_id)
        if definition is None:
            raise ItemError("そのアイテムは存在しません。")
        effect_id = definition.get("effect")
        handler = EFFECT_HANDLERS.get(effect_id) if effect_id else None
        if handler is None:
            raise ItemError(f"{definition['name']}は使う効果がありません。")
        with self._lock:
            # remove は RLock で再入する。消費に失敗したら効果は付けない。
            self.remove(user_id, item_id, 1, now)
            duration = definition.get("duration_hours")
            if duration:
                self._activate_effect_locked(str(user_id), effect_id, float(duration), now)
            message = handler(self, str(user_id), definition, now)
            self._mark_dirty()
            return message

    def rollback_use(self, user_id: str, item_id: str, now: datetime | None = None) -> None:
        """use_item の巻き戻し（効果の期限は元に戻さず、アイテムだけ返す簡易版）。"""
        self.add(user_id, item_id, 1, now=now)

    # ------------------------------------------------------------------ 宝箱
    def roll_box(self, rng: random.Random | None = None) -> dict[str, Any]:
        """宝箱1個の抽選結果 {"coins": int, "items": {item_id: count}}（状態は変えない）。"""
        rng = rng or self._rng
        coins = 0
        items: dict[str, int] = {}
        for row in BOX_DROPS:
            if rng.random() >= row["chance"]:
                continue
            amount = rng.randint(row["min"], row["max"])
            if row["kind"] == "coins":
                coins += amount
            else:
                item_id = row["item"]
                # 除外リストと定義フラグのどちらかで止まっていたら出さない。
                if item_id in BOX_NEVER_DROP or not ITEM_DEFS[item_id].get("box_drop", True):
                    continue
                items[item_id] = items.get(item_id, 0) + amount
        return {"coins": coins, "items": items}

    def open_boxes(self, user_id: str, amount: int | None = None,
                   now: datetime | None = None) -> dict[str, Any]:
        """宝箱を amount 個（None = 全て）開ける。集約結果を返す。

        コインの実付与は呼び出し側が行う。失敗時は rollback_open で巻き戻す。
        """
        now = now or datetime.now(JST)
        with self._lock:
            held = self.count(user_id, "treasure_box", now)
            if held <= 0:
                raise ItemError("宝箱を持っていません。")
            opening = held if amount is None else min(amount, held)
            if opening <= 0:
                raise ItemError("数量を正しく入力してください。")
            self.remove(user_id, "treasure_box", opening, now)
            coins = 0
            items: dict[str, int] = {}
            for _ in range(opening):
                rolled = self.roll_box()
                coins += rolled["coins"]
                for item_id, count in rolled["items"].items():
                    items[item_id] = items.get(item_id, 0) + count
            for item_id, count in items.items():
                self.add(user_id, item_id, count, now=now)
            self._mark_dirty()
            return {"opened": opening, "coins": coins, "items": items}

    def rollback_open(self, user_id: str, result: dict[str, Any],
                      now: datetime | None = None) -> None:
        """open_boxes の巻き戻し（コイン付与に失敗したとき用）。"""
        now = now or datetime.now(JST)
        with self._lock:
            for item_id, count in result.get("items", {}).items():
                try:
                    self.remove(user_id, item_id, count, now)
                except ItemError:
                    logger.exception("items: 宝箱の巻き戻しで所持が合いません user=%s item=%s",
                                     user_id, item_id)
            self.add(user_id, "treasure_box", int(result.get("opened", 0)), now=now)
