# -*- coding: utf-8 -*-
"""経済リセット（インフレ対策A案のデプロイ後に1回だけ行う初期化、owner 用）。

A案（ギャンブル配当のバンクロール原資化）のデプロイ確認後に、Bot を
止めた状態で実行する。やること:

- users テーブル（config.db_api）の全行を balance=RESET_BALANCE / debt=0 に
- data/economy_pool.json を pool=RESET_POOL / treasury=0 / 累計カウンタ全0 /
  last_release_date=実行日 に
- data/gambling.json の sessions と duels を空に（進行中ベットは残高
  リセット自体が精算に代わるため返金せず破棄する。users 側の内部状態は保持）

コイン以外の資産（トークン保有・アイテム等）は触らない。

使い方（Bot の設置ディレクトリで、Bot と同じ環境変数・.env を読める状態で）:

    python -m tools.economy_reset            # dry-run（既定、書き込みなし）
    python -m tools.economy_reset --apply    # バックアップを取って適用
    python -m tools.economy_reset --restore <backup-dir>  # バックアップから復元

--apply は冪等: 既にリセット後の状態なら何も書かずにその旨を表示する。
バックアップは --backup-dir で指定でき、既定は
~/BOT-backups/economy-reset-<日時>/ に users.json（全行）/
economy_pool.json / gambling.json / meta.json を保存する。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: リセット後の全ユーザー残高（ユーザー指示 2026-11-14）。
RESET_BALANCE = 10_000

#: リセット後の採掘プール残高（国庫・累計カウンタは0）。
RESET_POOL = 100_000

PAGE_SIZE = 1000

_POOL_RESET_KEYS = (
    "treasury", "total_recycled", "total_paid", "total_released",
    "total_boosted", "lottery_boost_pending", "total_house_paid",
)


# ---------------------------------------------------------------------------
# 純関数（状態の組み立て）
# ---------------------------------------------------------------------------

def reset_pool_state(today: str) -> dict[str, Any]:
    """リセット後の economy_pool.json の中身（全キーを明示する）。"""
    state: dict[str, Any] = {"pool": RESET_POOL}
    for key in _POOL_RESET_KEYS:
        state[key] = 0
    state["last_release_date"] = today
    return state


def clear_gambling_sessions(raw: Any) -> dict[str, Any]:
    """gambling.json から sessions と duels だけを空にする（他は保持）。"""
    state = dict(raw) if isinstance(raw, dict) else {}
    state["sessions"] = {}
    state["duels"] = {}
    return state


def summarize_users(rows: list[dict[str, Any]]) -> dict[str, int]:
    """users の行リストから件数と総残高を集計する。"""
    return {
        "users": len(rows),
        "total_balance": sum(int(row.get("balance") or 0) for row in rows),
        "total_debt": sum(int(row.get("debt") or 0) for row in rows),
    }


def is_reset_state(rows: list[dict[str, Any]], pool_raw: Any) -> bool:
    """既にリセット後の状態かどうか（二重実行ガード）。"""
    if not isinstance(pool_raw, dict):
        return False
    if int(pool_raw.get("pool") or 0) != RESET_POOL:
        return False
    if any(int(pool_raw.get(key) or 0) != 0 for key in _POOL_RESET_KEYS):
        return False
    return all(
        int(row.get("balance") or 0) == RESET_BALANCE
        and int(row.get("debt") or 0) == 0
        for row in rows)


# ---------------------------------------------------------------------------
# users テーブルへのアクセス（本番は config.db_api、テストはフェイクを注入）
# ---------------------------------------------------------------------------

class UsersIO(Protocol):
    """users テーブルの読み書きの最小インターフェース。"""

    def fetch_all(self) -> list[dict[str, Any]]:
        """全行を user_id / balance / debt で返す。"""
        ...

    def set_balance(self, user_id: str, balance: int, debt: int) -> None:
        """1行の balance / debt を更新する（行が無ければ作らない）。"""
        ...


class DbApiUsersIO:
    """config.db_api の users テーブル経由の UsersIO（既存コードの流儀）。"""

    def __init__(self, db: Any):
        self._db = db

    def fetch_all(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            response = (self._db.table("users")
                        .select("user_id, balance, debt")
                        .range(offset, offset + PAGE_SIZE - 1).execute())
            page = response.data or []
            for row in page:
                rows.append({
                    "user_id": str(row.get("user_id")),
                    "balance": int(row.get("balance") or 0),
                    "debt": int(row.get("debt") or 0),
                })
            if len(page) < PAGE_SIZE:
                return rows
            offset += PAGE_SIZE

    def set_balance(self, user_id: str, balance: int, debt: int) -> None:
        (self._db.table("users")
         .update({"balance": int(balance), "debt": int(debt)})
         .eq("user_id", user_id).execute())


def build_users_io() -> UsersIO:
    import config

    return DbApiUsersIO(config.db_api)


# ---------------------------------------------------------------------------
# ファイル読み書き
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# 本体（dry-run / apply / restore）
# ---------------------------------------------------------------------------

def describe_current(users_io: UsersIO, data_dir: Path) -> dict[str, Any]:
    """現在の状態の要約（読み取りのみ）。"""
    rows = users_io.fetch_all()
    pool_raw = _read_json(data_dir / "economy_pool.json")
    summary: dict[str, Any] = {"rows": rows, **summarize_users(rows)}
    summary["pool"] = (
        int(pool_raw.get("pool") or 0) if isinstance(pool_raw, dict) else None)
    summary["treasury"] = (
        int(pool_raw.get("treasury") or 0) if isinstance(pool_raw, dict) else None)
    summary["already_reset"] = is_reset_state(rows, pool_raw)
    return summary


def apply_reset(users_io: UsersIO, data_dir: Path, backup_dir: Path,
                *, today: str) -> dict[str, Any]:
    """バックアップを作成してからリセットを適用し、適用後サマリを返す。

    既にリセット後の状態なら何も書かず、already_reset=True を返す（冪等）。
    """
    rows = users_io.fetch_all()
    pool_path = data_dir / "economy_pool.json"
    gambling_path = data_dir / "gambling.json"
    pool_raw = _read_json(pool_path)
    if is_reset_state(rows, pool_raw):
        return {"already_reset": True, **summarize_users(rows),
                "pool": RESET_POOL}

    # 1. バックアップ（users 全行＋対象 JSON の現物）。
    backup_dir.mkdir(parents=True, exist_ok=True)
    _write_json(backup_dir / "users.json", rows)
    for name in ("economy_pool.json", "gambling.json"):
        source = data_dir / name
        if source.exists():
            (backup_dir / name).write_bytes(source.read_bytes())
    _write_json(backup_dir / "meta.json", {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "users": len(rows),
        "reset_balance": RESET_BALANCE,
        "reset_pool": RESET_POOL,
    })

    # 2. users 全行を一律にする（Bot 停止中が前提なので競合はない）。
    for row in rows:
        users_io.set_balance(str(row["user_id"]), RESET_BALANCE, 0)

    # 3. プール/国庫と 4. ギャンブルセッションを書き換える。
    _write_json(pool_path, reset_pool_state(today))
    gambling_raw = _read_json(gambling_path)
    if isinstance(gambling_raw, dict):
        _write_json(gambling_path, clear_gambling_sessions(gambling_raw))

    after = users_io.fetch_all()
    return {"already_reset": False, "backup_dir": str(backup_dir),
            **summarize_users(after), "pool": RESET_POOL, "treasury": 0}


def restore_backup(users_io: UsersIO, data_dir: Path,
                   backup_dir: Path) -> dict[str, Any]:
    """バックアップから users と JSON 群を復元し、復元後サマリを返す。"""
    rows = _read_json(backup_dir / "users.json")
    if not isinstance(rows, list):
        raise ValueError(f"バックアップの users.json が読めません: {backup_dir}")
    for row in rows:
        users_io.set_balance(
            str(row["user_id"]), int(row.get("balance") or 0),
            int(row.get("debt") or 0))
    for name in ("economy_pool.json", "gambling.json"):
        source = backup_dir / name
        if source.exists():
            target = data_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
    after = users_io.fetch_all()
    pool_raw = _read_json(data_dir / "economy_pool.json")
    return {**summarize_users(after),
            "pool": (int(pool_raw.get("pool") or 0)
                     if isinstance(pool_raw, dict) else None)}


def _print_summary(title: str, summary: dict[str, Any]) -> None:
    print(f"=== {title} ===")
    print(f"ユーザー数: {summary['users']:,}")
    print(f"総残高: {summary['total_balance']:,} AGO"
          f" / 総 debt: {summary['total_debt']:,}")
    if summary.get("pool") is not None:
        print(f"採掘プール: {summary['pool']:,} AGO"
              f" / 国庫: {summary.get('treasury')} AGO")


def main(argv: list[str] | None = None, *, users_io: UsersIO | None = None,
         data_dir: Path | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="経済リセット（全員一律残高＋プール初期化、owner 用）")
    parser.add_argument("--apply", action="store_true",
                        help="バックアップを取って実際に書き込む（既定は dry-run）")
    parser.add_argument("--restore", type=Path, default=None,
                        metavar="BACKUP_DIR",
                        help="指定したバックアップから復元する")
    parser.add_argument("--backup-dir", type=Path, default=None,
                        help="--apply 時のバックアップ保存先")
    parser.add_argument("--data-dir", type=Path, default=None,
                        help="economy_pool.json / gambling.json のある場所")
    args = parser.parse_args(argv)

    if args.apply and args.restore is not None:
        parser.error("--apply と --restore は同時に指定できません")

    io = users_io or build_users_io()
    data = data_dir or args.data_dir or (ROOT / "data")

    if args.restore is not None:
        summary = restore_backup(io, data, args.restore)
        _print_summary("復元後の状態", summary)
        return 0

    current = describe_current(io, data)
    _print_summary("現在の状態", current)
    if not args.apply:
        print()
        print(f"dry-run: 書き込みは行いません。--apply で全 {current['users']:,} 人を "
              f"balance={RESET_BALANCE:,} / debt=0 にし、プールを "
              f"{RESET_POOL:,}（国庫0）にします。")
        return 0
    if current["already_reset"]:
        print("既にリセット後の状態です（冪等ガード）。何も書きませんでした。")
        return 0

    backup_dir = args.backup_dir or (
        Path.home() / "BOT-backups"
        / f"economy-reset-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    result = apply_reset(
        io, data, backup_dir, today=date.today().isoformat())
    print()
    print(f"バックアップ: {result['backup_dir']}")
    _print_summary("リセット後の状態", result)
    expected = result["users"] * RESET_BALANCE
    if result["total_balance"] != expected:
        print(f"警告: 総残高 {result['total_balance']:,} が期待値 "
              f"{expected:,} と一致しません")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
