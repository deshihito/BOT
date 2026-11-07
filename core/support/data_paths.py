# -*- coding: utf-8 -*-
"""data/ 保存先のパス解決と、保存先ずれ期間のデータの移行読み取り。

core 再編成 (#505–#514 系) で各ストアモジュールが1階層深い場所へ移動した
際、`Path(__file__).resolve().parent.parent / "data" / ...` の計算がそのまま
コピーされ、保存先が本来の ``<repo>/data/`` ではなく ``<repo>/core/data/``
(zetamodoki_custom は ``<repo>/core/game/data/``) を指していた。その期間の
書き込みはすべて旧パス (stray) 側に行われているため、旧パス側が最新かつ
正のデータであり、正規パス側には再編前の古いスナップショットが残って
いる可能性がある。

各ストアはこのモジュールの ``load_migrated`` を初回読み込みに使い、

- 書き込みは常に正規パス (``default_path``) だけに行う
- 読み取りは旧パスを主とし、正規パスは不足分の補完にだけ使う
- 旧パスファイルは削除しない (読み取り専用の移行元として残置する)
- 環境変数で保存先が指定されている場合は移行処理を働かせない
  (呼び出し側が「保存先 = 既定パス」のときだけ移行読み取りを行う)

という形で移行する (PR #525 の EXP / MIQ と同じ方式)。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def repo_root() -> Path:
    """リポジトリルートを返す。

    同梱フォント (font.ttf) と assets/fonts/ の両方を持つ最下位の祖先を
    ルートとみなす (core/general/exp/exp.py の _repo_root と同じ解決)。
    見つからなければこのファイルの配置 (core/support/ 直下) を前提に返す。
    """
    here = Path(__file__).resolve()
    for anc in here.parents:
        if (anc / "font.ttf").is_file() and (anc / "assets" / "fonts").is_dir():
            return anc
    return here.parents[2]


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


def fill_merge(canonical: Any, stray: Any) -> Any:
    """dict 型ストアのマージ: 旧パス (stray) を主、正規パスは補完のみ。

    トップレベルはキー単位で stray 優先・不足キーを canonical から補う。
    値が両方とも dict のキーは1階層だけ同じ規則でマージする (セクション
    → ユーザー単位のストアで、ユーザー単位のエントリは stray 側を丸ごと
    採用する)。dict でない値は stray 側を採用する。
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
    """正規パスと旧パスを移行読み取りし、生データ (未整形) を返す。

    - 旧パスに読めるデータが無ければ、正規パスの内容をそのまま返す
      (従来動作と同一)。
    - ``fill=True`` (dict 型ストア): 旧パス主・正規パス補完でマージする。
    - ``fill=False`` (スナップショット型ストア): 旧パスのファイル全体を
      正とし、正規パスは旧パスにデータが無い場合にだけ使う。
    - どちらにも読めるデータが無ければ None。
    """
    stray_raw = read_json(stray) if Path(stray) != Path(path) else None
    if stray_raw is None:
        return read_json(path)
    canonical_raw = read_json(path)
    if canonical_raw is None or not fill:
        return stray_raw
    return fill_merge(canonical_raw, stray_raw)
