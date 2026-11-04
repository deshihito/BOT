# -*- coding: utf-8 -*-
"""アクションレジストリ: AGO BOT の全機能（アクション）定義の単一の真実。

コマンド一本化（/general /vc /game /support /help のパネル方式）では、機能の
定義が入口ごとに二重管理されていた（パネル用リスト、SHORTCUT_ROOTS、
AI tools の BLOCKED_ACTIONS など）。そのため「機能を足してもショートカットや
AI tools の候補に自動で増えない」というズレが起きていた。

このモジュールがアクション定義の唯一の置き場所になる:

- 各ルートの登録は、既存の正リスト（GENERAL_ACTIONS / SUPPORT_ACTIONS /
  GAME_ORDER など）から導出するビルダ関数で行う。手書きの複写は増やさない。
- ``build_shortcut_roots()`` が SHORTCUT_ROOTS と同形状の辞書を生成する。
- AI tools の候補は ``surfaces`` に "aitools" を含み ``risk != "blocked"``
  なアクションだけにする（core/ai_tools_router.action_candidates）。

risk の意味（このモジュールでの定義）:
- "safe": AI tools の代理実行可
- "confirm": 将来、確認を挟めば AI 実行可（現時点では未使用）
- "blocked": AI tools の代理実行対象外。パネル／ショートカットは surfaces で決まる

surfaces は入口ごとの可否（"panel" / "shortcut" / "aitools" / "palette"）が正。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

PARAM_TYPES = frozenset({
    "text", "int", "number", "bool", "choice",
    "member", "user", "channel", "role", "duration",
})
SURFACE_NAMES = frozenset({"panel", "shortcut", "aitools", "palette"})
RISK_LEVELS = frozenset({"safe", "confirm", "blocked"})

ROOT_ORDER = ("general", "vc", "game", "support", "help")
ROOT_LABELS = {
    "general": "/general",
    "vc": "/vc",
    "game": "/game",
    "support": "/support",
    "help": "/help",
}

ALL_SURFACES = frozenset({"panel", "shortcut", "aitools", "palette"})

# AI tools の代理実行対象外（旧 core/ai_tools_router.BLOCKED_ACTIONS と同じ集合）。
# 引数や確認モーダルを要する処理、権限操作、削除・送金系、記録開始系は明示操作に限定する。
# vc:changer_start は従来 SHORTCUT_ROOTS に無かったが、dispatch は引数なしで実行可能
# （パネルからも直接実行される）ためショートカット候補には加える。ただし開始系の
# ため record_start 等と同様に AI tools からは除外する。
AI_BLOCKED_IDS = frozenset({
    "general:pay", "general:fujo_register", "general:fujo_freeze", "general:fujo_panic_disable",
    "general:shortcut_manage", "general:aitools", "general:ai_default",
    "general:image_default", "general:reasoning_default",
    # MIQ設定は個人の設定パネルで /general から ephemeral で開くもの。AI 経由だと
    # 公開送信されてしまうため対象外（PR #373 の BLOCKED_ACTIONS 追加を継承）。
    "general:miq_settings",
    "support:clear", "support:role_bulk", "support:muted", "support:ticket", "support:honeypot",
    "support:whisper", "support:binjou", "support:message_log", "support:moderation_log",
    "support:bumprta_on", "support:bumprta_off",
    "vc:record_start", "vc:echo_start", "vc:transcribe_start", "vc:karaoke_start",
    "vc:global_start", "vc:match_start",
    "vc:changer_start",
})

# /support のうち今回新たにショートカット候補へ加わる設定・モデレーション系パネル。
# ショートカットには全件入れるが、AI tools の代理実行範囲はこのPRでは広げない
# （設定・モデレーション系は明示操作に限定する従来方針の踏襲）。
# 読み取り専用の状態確認である sokunuke_status のみ AI tools 候補にも入れる。
SUPPORT_AI_EXCLUDED_VALUES = frozenset({
    "sticky", "giveaway", "auth_panel", "role_panel", "language", "auto_react",
    "sns_notify", "quest_notify", "levelup_notify", "voice_trigger",
    "sokunuke_on", "sokunuke_off", "sokunuke_vc_on", "sokunuke_vc_off",
})


@dataclass(frozen=True)
class ParamSpec:
    """アクションの引数1件の型付き定義。生成時に整合性を検証する。"""

    name: str
    label: str
    type: str
    required: bool = False
    default: Any = None
    choices: tuple = ()
    min_value: float | None = None
    max_value: float | None = None
    help: str = ""

    def __post_init__(self) -> None:
        if self.type not in PARAM_TYPES:
            raise ValueError(f"ParamSpec {self.name!r}: 未知の型 {self.type!r}")
        values = [value for _label, value in self.choices] if self.choices else []
        if len(values) != len(set(values)):
            raise ValueError(f"ParamSpec {self.name!r}: choices の値が重複しています")
        if self.type == "choice" and not self.choices:
            raise ValueError(f"ParamSpec {self.name!r}: choice 型には choices が必要です")
        if self.choices and self.type != "choice":
            raise ValueError(f"ParamSpec {self.name!r}: choices は choice 型でのみ使えます")
        if self.min_value is not None and self.max_value is not None and self.min_value > self.max_value:
            raise ValueError(f"ParamSpec {self.name!r}: min_value が max_value を上回っています")
        if self.default is not None:
            if self.type == "choice" and self.default not in values:
                raise ValueError(f"ParamSpec {self.name!r}: 既定値が choices に含まれていません")
            if self.type in {"int", "number", "duration"}:
                if self.min_value is not None and self.default < self.min_value:
                    raise ValueError(f"ParamSpec {self.name!r}: 既定値が min_value 未満です")
                if self.max_value is not None and self.default > self.max_value:
                    raise ValueError(f"ParamSpec {self.name!r}: 既定値が max_value を超えています")


@dataclass(frozen=True)
class ActionSpec:
    """アクション（機能）1件の定義。id は "{root}:{value}" で固定する。"""

    id: str
    root: str
    value: str
    label: str
    genre: str
    genre_label: str
    description: str = ""
    keywords: tuple = ()
    params: tuple[ParamSpec, ...] = ()
    permission: str | None = None
    risk: str = "safe"
    surfaces: frozenset = ALL_SURFACES
    executor: str = ""

    def __post_init__(self) -> None:
        if self.id != f"{self.root}:{self.value}":
            raise ValueError(f"ActionSpec: id {self.id!r} が root:value と一致しません")
        if self.risk not in RISK_LEVELS:
            raise ValueError(f"ActionSpec {self.id!r}: 未知の risk {self.risk!r}")
        unknown = set(self.surfaces) - SURFACE_NAMES
        if unknown:
            raise ValueError(f"ActionSpec {self.id!r}: 未知の surfaces {sorted(unknown)}")
        if not self.surfaces:
            raise ValueError(f"ActionSpec {self.id!r}: surfaces が空です")
        names = [param.name for param in self.params]
        if len(names) != len(set(names)):
            raise ValueError(f"ActionSpec {self.id!r}: params の名前が重複しています")


def make_action(root: str, value: str, label: str, genre: str, genre_label: str, **kwargs) -> ActionSpec:
    """id を root:value から組み立て、AI 代理実行対象外なら surfaces/risk を落とす。"""
    action_id = f"{root}:{value}"
    if action_id in AI_BLOCKED_IDS:
        kwargs.setdefault("risk", "blocked")
        surfaces = set(kwargs.get("surfaces", ALL_SURFACES))
        surfaces.discard("aitools")
        kwargs["surfaces"] = frozenset(surfaces)
    return ActionSpec(
        id=action_id, root=root, value=value, label=label,
        genre=genre, genre_label=genre_label, **kwargs,
    )


class ActionRegistry:
    """ActionSpec の集約。id の重複登録はエラーにする（黙って上書きしない）。"""

    def __init__(self, specs: Iterable[ActionSpec] = ()) -> None:
        self._by_id: dict[str, ActionSpec] = {}
        self.register_many(specs)

    def register(self, spec: ActionSpec) -> ActionSpec:
        if spec.id in self._by_id:
            raise ValueError(f"アクション id が重複しています: {spec.id}")
        self._by_id[spec.id] = spec
        return spec

    def register_many(self, specs: Iterable[ActionSpec]) -> None:
        for spec in specs:
            self.register(spec)

    def all(self) -> tuple[ActionSpec, ...]:
        return tuple(self._by_id.values())

    def __len__(self) -> int:
        return len(self._by_id)

    def __contains__(self, action_id: str) -> bool:
        return action_id in self._by_id

    def by_id(self, action_id: str) -> ActionSpec:
        return self._by_id[action_id]

    def get(self, action_id: str, default: ActionSpec | None = None) -> ActionSpec | None:
        return self._by_id.get(action_id, default)

    def by_root(self, root: str) -> tuple[ActionSpec, ...]:
        return tuple(spec for spec in self._by_id.values() if spec.root == root)

    def for_surface(self, surface: str) -> tuple[ActionSpec, ...]:
        return tuple(spec for spec in self._by_id.values() if surface in spec.surfaces)


# ---------------------------------------------------------------------------
# ルート別ビルダ（既存の正リストから導出する）
# ---------------------------------------------------------------------------

def build_general_actions(general_actions: dict, general_genres: dict) -> list[ActionSpec]:
    """cogs/general.py の GENERAL_ACTIONS / GENERAL_GENRES から導出する。"""
    specs: list[ActionSpec] = []
    for genre, items in general_actions.items():
        genre_label, genre_desc = general_genres[genre]
        for label, value in items:
            kwargs: dict[str, Any] = {"description": genre_desc}
            if value == "shortcut_manage":
                # ショートカット管理そのものは従来どおりショートカット候補に入れない。
                kwargs["surfaces"] = frozenset({"panel"})
            specs.append(make_action("general", value, label, genre, genre_label, **kwargs))
    return specs


# /vc のショートカット対象アクションの正リスト。
# 従来 cogs/general.py の SHORTCUT_ROOTS に手書きされていた複写をここへ移した。
# changer_start は dispatch_voice_action が引数なしで実行でき（_changer_impl は
# pitch 等が None なら既定値で開始する）、パネルからも直接実行されるため追加した。
VC_SHORTCUT_ACTIONS: tuple[tuple[str, str], ...] = (
    ("VC参加", "join"), ("VC退出", "leave"), ("VC状態", "status"),
    ("音楽操作パネル", "music_panel"), ("録音開始", "record_start"), ("録音停止", "record_stop"),
    ("やまびこ開始", "echo_start"), ("やまびこ停止", "echo_stop"),
    ("文字起こし開始", "transcribe_start"), ("文字起こし停止", "transcribe_stop"),
    ("カラオケ開始", "karaoke_start"), ("カラオケ停止", "karaoke_stop"),
    ("ランダム通話開始", "match_start"), ("ランダム通話終了", "match_stop"),
    ("グローバルVC開始", "global_start"), ("グローバルVC終了", "global_stop"),
    # AI toolsからは入力フォームを開かずに完結する操作だけを公開する。
    ("録音状態", "record_status"), ("録音音程解析", "record_pitch"),
    ("やまびこ状態", "echo_status"), ("カラオケ採点", "karaoke_score"),
    ("ボイスチェンジャー開始", "changer_start"), ("ボイスチェンジャー停止", "changer_stop"),
    ("ボイスチェンジャー状態", "changer_status"),
    ("グローバルVCルーム一覧", "gvc_room_list"), ("グロチャ接続解除", "gvc_chat_disconnect"),
    ("読み上げ停止", "tts_stop"), ("音声トリガー一覧・削除", "trigger_panel"),
)


def build_vc_actions() -> list[ActionSpec]:
    return [
        make_action("vc", value, label, "vc", ROOT_LABELS["vc"])
        for label, value in VC_SHORTCUT_ACTIONS
    ]


def build_game_actions(game_order: list, game_guides: dict) -> list[ActionSpec]:
    """core/game_guides.py の GAME_ORDER / GAME_GUIDES から導出する（従来方式の踏襲）。"""
    return [
        make_action(
            "game", f"game:{game}", "ゲーム開始: " + game_guides[game]["name"],
            "game", ROOT_LABELS["game"],
        )
        for game in game_order
    ]


def build_support_actions(support_actions: list, actions_by_genre: dict, support_genres: dict) -> list[ActionSpec]:
    """cogs/support.py の SUPPORT_ACTIONS（全件）から導出する。ジャンルは
    SUPPORT_ACTIONS_BY_GENRE の逆引き、ラベルは SUPPORT_GENRES から取る。"""
    genre_by_value = {
        value: genre
        for genre, items in actions_by_genre.items()
        for _label, value in items
    }
    specs: list[ActionSpec] = []
    for choice in support_actions:
        value = choice.value
        genre = genre_by_value.get(value, "")
        genre_label, genre_desc = support_genres.get(genre, ("", ""))
        kwargs: dict[str, Any] = {"description": genre_desc}
        if value in SUPPORT_AI_EXCLUDED_VALUES:
            # 設定・モデレーション系パネルは明示操作に限定する（AI 代理実行範囲を広げない）。
            kwargs["surfaces"] = frozenset({"panel", "shortcut", "palette"})
        specs.append(make_action("support", value, choice.name, genre, genre_label, **kwargs))
    return specs


def build_help_actions() -> list[ActionSpec]:
    return [make_action("help", "overview", "ヘルプを表示", "help", ROOT_LABELS["help"])]


def default_action_specs() -> list[ActionSpec]:
    """全ルート分の ActionSpec を既存の正リストから組み立てる。

    cog モジュールへの import は循環回避のため関数内（遅延）で行う。
    cogs.general のモジュール初期化中に呼ばれる場合でも、GENERAL_ACTIONS 等は
    SHORTCUT_ROOTS の定義より前に定義されているため参照できる。
    """
    from cogs.general import GENERAL_ACTIONS, GENERAL_GENRES
    from cogs.support import SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES
    from core.game_guides import GAME_GUIDES, GAME_ORDER

    specs: list[ActionSpec] = []
    specs += build_general_actions(GENERAL_ACTIONS, GENERAL_GENRES)
    specs += build_vc_actions()
    specs += build_game_actions(GAME_ORDER, GAME_GUIDES)
    specs += build_support_actions(SUPPORT_ACTIONS, SUPPORT_ACTIONS_BY_GENRE, SUPPORT_GENRES)
    specs += build_help_actions()
    return specs


_default_registry: ActionRegistry | None = None


def default_registry() -> ActionRegistry:
    """全ルートを集約した既定レジストリ（初回だけ構築してキャッシュする）。"""
    global _default_registry
    if _default_registry is None:
        _default_registry = ActionRegistry(default_action_specs())
    return _default_registry


def build_shortcut_roots(specs: Iterable[ActionSpec] | None = None) -> dict[str, tuple[str, list]]:
    """SHORTCUT_ROOTS と同形状（root -> (表示名, [(label, value), ...])）を生成する。"""
    if specs is None:
        specs = default_registry().all()
    by_root: dict[str, list] = {root: [] for root in ROOT_ORDER}
    for spec in specs:
        if "shortcut" in spec.surfaces and spec.root in by_root:
            by_root[spec.root].append((spec.label, spec.value))
    return {root: (ROOT_LABELS[root], by_root[root]) for root in ROOT_ORDER}
