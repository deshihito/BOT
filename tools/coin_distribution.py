# -*- coding: utf-8 -*-
"""コイン分布の実測（次期仕様 S0、owner 用・読み取り専用）。

経済系の絶対価格（プールシード、スターター額、ガチャ価格、クラン
作成費など暫定値）を確定させるための実測ツール。DB の users テーブル
（残高）と data/market.json（トークン保有）を読み取るだけで、
書き込みは一切しない。

使い方（Bot の設置ディレクトリで、Bot と同じ環境変数・.env を読める
状態で実行する）:

    python -m tools.coin_distribution
    python -m tools.coin_distribution --market-json /path/to/data/market.json

出力は分布の要約（総ユーザー数、残高0の割合、中央値、平均、
p75/p90/p99、最大値、上位10人のシェア）と、仕様書 S0 の確定式に
当てはめた候補値。候補値はあくまで式の適用結果で、定数の確定は
この出力を確認してから別途行う（このツールは定数を変更しない）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PAGE_SIZE = 1000


def _percentile(sorted_values: list[int], pct: float) -> int:
    """ソート済みリストのパーセンタイル（線形補間なし、最近傍）。"""
    if not sorted_values:
        return 0
    index = min(
        len(sorted_values) - 1,
        max(0, math.ceil(pct / 100.0 * len(sorted_values)) - 1))
    return int(sorted_values[index])


def compute_distribution(values: list[int]) -> dict[str, Any]:
    """残高リストから分布の要約を計算する（純関数）。"""
    ordered = sorted(int(v) for v in values)
    count = len(ordered)
    total = sum(ordered)
    zero_count = sum(1 for v in ordered if v <= 0)
    top10 = sum(ordered[-10:]) if count else 0
    return {
        "users": count,
        "total": total,
        "zero_ratio": (zero_count / count) if count else 0.0,
        "median": _percentile(ordered, 50),
        "mean": (total / count) if count else 0.0,
        "p75": _percentile(ordered, 75),
        "p90": _percentile(ordered, 90),
        "p99": _percentile(ordered, 99),
        "max": ordered[-1] if ordered else 0,
        "top10_share": (top10 / total) if total else 0.0,
    }


def suggest_constants(balance_dist: dict[str, Any],
                      token_holders: int) -> dict[str, Any]:
    """仕様書 S0 の確定式を分布へ当てた候補値を返す。

    - POOL_SEED_AGO: 現行 1,000,000 を上限に、総残高の 10% 以下
    - スターター額: 小型加工機の価格（現行 1,400）+ 3,000 が目安
    - ガチャ単発: 中央値ユーザーの「1日の想定獲得」の 0.5〜1 日分。
      1日の想定獲得は未実測のため、ここでは中央値そのものを上限の
      目安として併記するに留める（日次獲得の実測は別途必要）
    - クラン作成費: p90 の 20〜30%
    """
    total = int(balance_dist.get("total") or 0)
    p90 = int(balance_dist.get("p90") or 0)
    return {
        "pool_seed_ago_cap": min(1_000_000, total // 10),
        "starter_coins_guide": 1_400 + 3_000,
        "clan_create_cost_range": (int(p90 * 0.20), int(p90 * 0.30)),
        "token_holders": int(token_holders),
        "note": ("ガチャ単発の確定には中央値ユーザーの日次獲得額の実測が"
                 "別途必要（このツールでは残高分布のみを測る）。"),
    }


def fetch_balances() -> list[int]:
    """users テーブルから全残高をページングで読み取る（読み取り専用）。"""
    import config

    balances: list[int] = []
    offset = 0
    while True:
        response = (config.db_api.table("users").select("balance")
                    .range(offset, offset + PAGE_SIZE - 1).execute())
        rows = response.data or []
        for row in rows:
            balances.append(int(row.get("balance") or 0))
        if len(rows) < PAGE_SIZE:
            return balances
        offset += PAGE_SIZE


def fetch_token_balances(market_json: Path) -> dict[str, float]:
    """data/market.json からトークン保有を読む（読み取り専用）。"""
    try:
        raw = json.loads(market_json.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    balances = raw.get("balances") if isinstance(raw, dict) else None
    if not isinstance(balances, dict):
        return {}
    return {
        str(uid): float(amount)
        for uid, amount in balances.items()
        if isinstance(amount, (int, float)) and amount > 0
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="コイン分布の実測（読み取り専用）")
    parser.add_argument(
        "--market-json", type=Path,
        default=ROOT / "data" / "market.json",
        help="トークン保有を読む market.json のパス")
    args = parser.parse_args(argv)

    balances = fetch_balances()
    dist = compute_distribution(balances)
    tokens = fetch_token_balances(args.market_json)
    token_values = [int(amount) for amount in tokens.values()]
    token_dist = compute_distribution(token_values)
    suggestions = suggest_constants(dist, len(tokens))

    print("=== コイン残高の分布 ===")
    print(f"総ユーザー数: {dist['users']:,}")
    print(f"総残高: {dist['total']:,} AGO")
    print(f"残高0の割合: {dist['zero_ratio']:.1%}")
    print(f"中央値: {dist['median']:,} / 平均: {dist['mean']:,.0f}")
    print(f"p75: {dist['p75']:,} / p90: {dist['p90']:,} / "
          f"p99: {dist['p99']:,} / 最大: {dist['max']:,}")
    print(f"上位10人のシェア: {dist['top10_share']:.1%}")
    print()
    print("=== トークン保有の分布 ===")
    print(f"保有者数: {token_dist['users']:,}")
    if token_dist["users"]:
        print(f"中央値: {token_dist['median']:,} AGA / 最大: {token_dist['max']:,} AGA")
    print()
    print("=== S0 確定式による候補値（定数はまだ変更しない） ===")
    print(f"POOL_SEED_AGO の上限: {suggestions['pool_seed_ago_cap']:,} AGO"
          "（現行 1,000,000）")
    print(f"スターター額の目安: {suggestions['starter_coins_guide']:,} AGO"
          "（現行 3,000）")
    low, high = suggestions["clan_create_cost_range"]
    print(f"クラン作成費の範囲: {low:,}〜{high:,} AGO（現行 10,000）")
    print(f"備考: {suggestions['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
