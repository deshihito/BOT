"""レベルアップカードのテーマと、ユーザーごとのカード設定。

テーマは render_levelup_card (cogs/general.py) の配色パレット。
ユーザー設定は ai_preferences と同じ KVStore 方式で永続化する。
"""
from __future__ import annotations

from typing import Any

from core.support.storage import KVStore

_store = KVStore("levelup_card_prefs")

# key -> (表示名, パレット)。パレットは RGB タプル。
THEMES: dict[str, dict[str, Any]] = {
    "default": {
        "label": "デフォルト",
        "bg": (255, 255, 255), "ink": (44, 52, 74), "mute": (150, 156, 170),
        "line": (228, 232, 240), "accent": (59, 91, 255), "ring": (127, 178, 201),
    },
    "ocean": {
        "label": "オーシャン",
        "bg": (233, 240, 255), "ink": (35, 48, 84), "mute": (120, 134, 168),
        "line": (203, 219, 250), "accent": (37, 99, 235), "ring": (96, 165, 250),
    },
    "sakura": {
        "label": "サクラ",
        "bg": (255, 241, 246), "ink": (84, 40, 62), "mute": (178, 130, 152),
        "line": (251, 207, 232), "accent": (236, 72, 153), "ring": (249, 168, 212),
    },
    "forest": {
        "label": "フォレスト",
        "bg": (238, 250, 242), "ink": (36, 64, 48), "mute": (128, 160, 140),
        "line": (204, 238, 216), "accent": (22, 163, 74), "ring": (134, 239, 172),
    },
    "sunset": {
        "label": "サンセット",
        "bg": (255, 246, 232), "ink": (84, 52, 32), "mute": (176, 142, 110),
        "line": (250, 224, 186), "accent": (234, 88, 12), "ring": (253, 186, 116),
    },
    "midnight": {
        "label": "ミッドナイト",
        "bg": (32, 36, 48), "ink": (238, 241, 248), "mute": (150, 158, 176),
        "line": (62, 70, 90), "accent": (129, 160, 255), "ring": (96, 118, 178),
    },
}
DEFAULT_THEME = "default"


def palette(theme: str | None) -> dict[str, Any]:
    return THEMES.get(theme or "") or THEMES[DEFAULT_THEME]


def theme_label(theme: str | None) -> str:
    return palette(theme)["label"]


def next_theme(current: str | None) -> str:
    keys = list(THEMES)
    if current not in keys:
        return keys[1] if len(keys) > 1 else DEFAULT_THEME
    return keys[(keys.index(current) + 1) % len(keys)]


def get_theme(user_id: int) -> str:
    value = _store.load_local().get(str(user_id))
    if isinstance(value, dict):
        theme = value.get("theme")
        if theme in THEMES:
            return theme
    return DEFAULT_THEME


async def set_theme(user_id: int, theme: str) -> str:
    if theme not in THEMES:
        theme = DEFAULT_THEME
    if theme == DEFAULT_THEME:
        await _store.delete(str(user_id))
    else:
        await _store.set(str(user_id), {"theme": theme})
    return theme


def set_store_for_tests(store) -> None:
    global _store
    _store = store
