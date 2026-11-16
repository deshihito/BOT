# -*- coding: utf-8 -*-
"""data/ 保存先のパス解決と、保存先ずれ期間のデータの移行読み取り。

core 再編成 (#505–#514 系) で各ストアモジュールが1階層深い場所へ移動した
際、`Path(__file__).resolve().parent.parent / "data" / ...` の計算がそのまま
コピーされ、保存先が本来の ``<repo>/data/`` ではなく ``<repo>/core/data/``
(zetamodoki_custom は ``<repo>/core/game/data/``) を指していた。その期間の
書き込みは旧パス (stray) 側に行われている。

移行読み取りの意味論 (2026-11-16 変更):

- 書き込みは常に正規パス (``default_path``) だけに行う
- 読み取りは正規パスを正とする。stray は「正規ファイルが存在しない
  (読めない) ときだけ」初回移行として読む
- 正規ファイルが存在する場合は stray があっても無視し、警告ログを出す
  (同じ stray についてプロセス内で1回だけ)。無視される stray は
  退避・削除して構わない
- 環境変数で保存先が指定されている場合は移行処理を働かせない
  (呼び出し側が「保存先 = 既定パス」のときだけ移行読み取りを行う)

旧意味論 (stray 優先・マージ) は、移行完了後も起動のたびに stray を
読み続けるため、正規パス側で行ったリセット等の変更が凍結した stray の
値で毎起動巻き戻される事故 (2026-11-14 の経済リセット巻き戻し) を
起こした。そのため「初回移行のみ」に改めた (PR #525 の MIQ と同じ方式)。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from core.paths import repo_root as _shared_repo_root

logger = logging.getLogger(__name__)


def repo_root() -> Path:
    """リポジトリルートを返す (解決の正は core/paths.py)。"""
    return _shared_repo_root()


_REPO_ROOT = repo_root()


def data_path(filename: str) -> Path:
    """正規の保存先 ``<repo>/data/<filename>`` を返す。"""
    return _REPO_ROOT / "data" / filename


def stray_path(module_file: str | Path, filename: str) -> Path:
    """再編前の計算で指していた旧保存先を返す (移行読み取り専用)。

    再編前の各モジュールは ``Path(__file__).resolve().parent.parent / "data"
    / filename`` で保存先を計算していた。モジュールが1階層深くなった現行
    レイアウトで同じ計算をすると、旧保存先 (core/data/ 等) が再現できる。
    """
    return Path(module_file).resolve().parent.parent / "data" / filename


def read_json(path: Path) -> Any | None:
    """JSON ファイルを読む。無い・壊れている・読めない場合は None。"""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


# 警告済み stray の集合 (プロセス内で同じ stray への警告は1回だけ)。
_warned_strays: set[str] = set()


def note_stray_ignored(stray: Path, canonical: Path | None = None) -> None:
    """正規ファイルが存在するため stray を無視したことを警告する。

    同じ stray についてはプロセス内で1回だけ警告する。独自の読み取り
    実装を持つストア (lottery / usage_stats 等) からも使う共通入口。
    """
    key = str(Path(stray))
    if key in _warned_strays:
        return
    _warned_strays.add(key)
    logger.warning(
        "data_paths: 旧保存先 %s にデータが残っていますが、正規保存先 %s "
        "が存在するため無視します (stray は正規ファイルが無い場合の"
        "初回移行にだけ使います)。旧ファイルは退避・削除できます",
        stray, canonical,
    )


def fill_merge(canonical: Any, stray: Any) -> Any:
    """dict 型ストアのマージ: 旧パス (stray) を主、正規パスは補完のみ。

    旧意味論のマージ規則の記録として残すヘルパーで、現在の
    ``load_migrated`` はマージを行わない (正規パスが正、stray は
    正規ファイルが無い場合にだけ丸ごと読む)。
    """
    if not isinstance(canonical, dict) or not isinstance(stray, dict):
        return stray
    merged: dict = dict(canonical)
    for key, stray_value in stray.items():
        canonical_value = merged.get(key)
        if isinstance(canonical_value, dict) and isinstance(stray_value, dict):
            inner = dict(canonical_value)
            inner.update(stray_value)
            merged[key] = inner
        else:
            merged[key] = stray_value
    return merged


def load_migrated(path: Path, stray: Path, *, fill: bool) -> Any | None:
    """正規パスを正として読み取り、生データ (未整形) を返す。

    - 正規パスに読めるデータがあれば、それを返す。stray にもデータが
      ある場合は stray を無視し、警告ログを出す (1回だけ)。
    - 正規パスに読めるデータが無く、stray に読めるデータがあれば、
      初回移行として stray の内容を返す (次回 flush で正規パスへ
      書き出され、以降 stray は無視される)。
    - どちらにも読めるデータが無ければ None。

    ``fill`` は旧意味論 (fill=True: stray 主のマージ / fill=False:
    stray 全体優先) の引数で、呼び出し側の互換のため残しているが、
    現在の意味論では使わない。
    """
    canonical_raw = read_json(path)
    if canonical_raw is not None:
        if Path(stray) != Path(path) and read_json(stray) is not None:
            note_stray_ignored(stray, path)
        return canonical_raw
    if Path(stray) != Path(path):
        return read_json(stray)
    return None
