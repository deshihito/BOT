# -*- coding: utf-8 -*-
"""リポジトリ配置の基底: パス解決の唯一の入口。

各モジュールが ``Path(__file__).resolve().parents[N]`` でリポジトリ
ルートやアセットを個別に計算するのをやめ、ここに集約する。モジュール
を別の階層へ移しても参照がずれないよう、ルートは「同梱フォント
(font.ttf) と assets/fonts/ の両方を持つ最下位の祖先」で解決する
(旧 core/support/data_paths.py / exp / miq / welcome に複製されていた
解決ロジックの統合先)。見つからない場合だけ、このファイルの配置
(core/ 直下) を前提にフォールバックする。

既定:
- 実行時データの保存先は ``data_path()`` (``<repo>/data/<name>``) だけ。
  旧保存先 (stray) の移行読み取りは core/support/data_paths.py が担う。
- 新規コードで ``parents[N]`` によるルート計算を書かない。
"""
from __future__ import annotations

from pathlib import Path


def repo_root() -> Path:
    """リポジトリルートを返す (パス解決の正)。"""
    here = Path(__file__).resolve()
    for anc in here.parents:
        if (anc / "font.ttf").is_file() and (anc / "assets" / "fonts").is_dir():
            return anc
    return here.parents[1]


REPO_ROOT = repo_root()

#: 実行時データの唯一の置き場 (git 管理外)。
DATA_DIR = REPO_ROOT / "data"

#: Python 側の画像・音声アセット (大文字が現行の正、jinrou 等が参照)。
ASSETS_DIR = REPO_ROOT / "Assets"

#: 共有バイナリアセット (フォント / HRTF / 空間音響データ)。
SHARED_ASSETS_DIR = REPO_ROOT / "assets"

#: 同梱フォント群。
FONTS_DIR = SHARED_ASSETS_DIR / "fonts"

#: リポジトリ直下の主フォント (盤面描画等の基盤)。
DEFAULT_FONT_PATH = REPO_ROOT / "font.ttf"


def data_path(filename: str) -> Path:
    """正規の保存先 ``<repo>/data/<filename>`` を返す。"""
    return DATA_DIR / filename


def asset_path(*parts: str) -> Path:
    """``Assets/`` 配下のアセットパスを返す。"""
    return ASSETS_DIR.joinpath(*parts)


def shared_asset_path(*parts: str) -> Path:
    """``assets/`` 配下の共有アセットパスを返す。"""
    return SHARED_ASSETS_DIR.joinpath(*parts)


def font_path(filename: str) -> Path:
    """``assets/fonts/<filename>`` の同梱フォントパスを返す。"""
    return FONTS_DIR / filename
