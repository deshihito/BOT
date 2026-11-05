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
- "confirm": AI tools の候補に入るが、実行前に確認ビューを挟む（AI_CONFIRM_IDS が対象）
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
# 権限操作、削除・送金系、個人設定の変更、録音・文字起こし開始（プライバシー）は
# 明示操作に限定する。
# vc:changer_start は従来 SHORTCUT_ROOTS に無かったが、dispatch は引数なしで実行可能
# （パネルからも直接実行される）ためショートカット候補には加える。AI tools からは
# 下の AI_CONFIRM_IDS のとおり確認ビュー付きでのみ実行可とする。
AI_BLOCKED_IDS = frozenset({
    "general:pay", "general:token_buy", "general:token_sell",
    "general:item_buy", "general:item_use", "general:box_open",
    "general:machine_buy", "general:workshop_claim", "general:craft",
    "general:mining", "general:lottery_buy", "general:steal",
    "general:fujo_register", "general:fujo_freeze", "general:fujo_panic_disable",
    "general:shortcut_manage", "general:aitools", "general:ai_default",
    "general:image_default", "general:reasoning_default",
    # MIQ設定は個人の設定パネルで /general から ephemeral で開くもの。AI 経由だと
    # 公開送信されてしまうため対象外（PR #373 の BLOCKED_ACTIONS 追加を継承）。
    "general:miq_settings",
    # meme作成はモーダル入力＋画像投稿待ちの対話フローで、画像生成系を
    # AI の代理実行に広げない方針のため対象外。
    "general:meme_create",
    "support:clear", "support:role_bulk", "support:muted", "support:ticket", "support:honeypot",
    "support:whisper", "support:binjou", "support:message_log", "support:moderation_log",
    "vc:record_start", "vc:transcribe_start",
})

# AI tools で「確認ビュー付きなら代理実行可」（risk="confirm"）とする集合（D-3 決定）。
# 可逆な通知トグルと、目に見えて停止で戻せる VC 開始系だけを対象にする。
# surfaces は落とさない（"aitools" を含んだまま候補に残り、実行前に
# cogs/ai_tools の確認ビューを必ず経由する）。
AI_CONFIRM_IDS = frozenset({
    "support:bumprta_on", "support:bumprta_off",
    "vc:echo_start", "vc:karaoke_start", "vc:global_start", "vc:match_start",
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


def validate_params(spec: ActionSpec, params: dict | None) -> dict[str, Any]:
    """保存された params を ActionSpec の ParamSpec で検証し、検証済みの dict を返す。

    未知のキー・型違い・範囲外・choices 外があれば ValueError。
    未指定のキーは検証しない（プリセットは部分指定が前提で、未設定分は
    実行側の既定値に任せる。required は「実行に必要」という表示・案内用）。
    """
    if not params:
        return {}
    if not isinstance(params, dict):
        raise ValueError("params は辞書で指定してください。")
    by_name = {param.name: param for param in spec.params}
    cleaned: dict[str, Any] = {}
    for name, value in params.items():
        param = by_name.get(name)
        if param is None:
            raise ValueError(f"{spec.label}: 未知のパラメータです: {name}")
        cleaned[name] = _validate_param_value(param, value)
    return cleaned


def _validate_param_value(param: ParamSpec, value: Any) -> Any:
    label = param.label or param.name
    if param.type == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"{label}: オン/オフで指定してください。")
        return value
    if param.type == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{label}: 整数で指定してください。")
        _check_param_range(param, value)
        return value
    if param.type in {"number", "duration"}:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{label}: 数値で指定してください。")
        _check_param_range(param, value)
        return float(value)
    if param.type == "choice":
        values = [choice_value for _choice_label, choice_value in param.choices]
        if value not in values:
            raise ValueError(f"{label}: 選択肢の中から指定してください。")
        return value
    if param.type == "text":
        if not isinstance(value, str):
            raise ValueError(f"{label}: 文字列で指定してください。")
        return value
    # member / user / channel / role は Discord の ID（整数）だけを受け付ける。
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label}: ID（整数）で指定してください。")
    return value


def _check_param_range(param: ParamSpec, value: float) -> None:
    label = param.label or param.name
    if param.min_value is not None and value < param.min_value:
        raise ValueError(f"{label}: {param.min_value} 以上で指定してください。")
    if param.max_value is not None and value > param.max_value:
        raise ValueError(f"{label}: {param.max_value} 以下で指定してください。")


def make_action(root: str, value: str, label: str, genre: str, genre_label: str, **kwargs) -> ActionSpec:
    """id を root:value から組み立て、AI tools 向けの risk を単一の定義から付ける。

    blocked は surfaces から "aitools" も落とす。confirm は surfaces を
    変えず risk だけを "confirm" にする（候補に残り、実行前に確認を挟む）。
    """
    action_id = f"{root}:{value}"
    if action_id in AI_BLOCKED_IDS:
        kwargs.setdefault("risk", "blocked")
        surfaces = set(kwargs.get("surfaces", ALL_SURFACES))
        surfaces.discard("aitools")
        kwargs["surfaces"] = frozenset(surfaces)
    elif action_id in AI_CONFIRM_IDS:
        kwargs.setdefault("risk", "confirm")
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


# /vc の ParamSpec。cogs/sio_voice.py の dispatch_voice_action が実際に受け取り、
# 値ごとの分岐先（_echo_impl 等）が使う引数だけを定義する。範囲は dispatch の
# app_commands.Range 指定に合わせた。dispatch が受け取っても分岐先で使われない
# 引数（record の delay、transcribe の channel など）は定義しない。
_CHANGER_PARAMS: tuple[ParamSpec, ...] = (
    ParamSpec(name="pitch", label="ピッチ（半音）", type="number",
              min_value=-24.0, max_value=24.0, help="声の高さのずらし幅"),
    ParamSpec(name="buffer_ms", label="目標バッファ（ms）", type="number",
              min_value=20.0, max_value=2000.0),
    ParamSpec(name="max_ms", label="上限バッファ（ms）", type="number",
              min_value=20.0, max_value=4000.0),
)

VC_ACTION_PARAMS: dict[str, tuple[ParamSpec, ...]] = {
    # _echo_impl: 開始時に遅延として使う（未指定なら 2.0 秒）。
    "echo_start": (
        ParamSpec(name="delay", label="遅延（秒）", type="number",
                  min_value=0.1, max_value=30.0, help="やまびこの遅延時間"),
    ),
    # _karaoke_impl: 開始には歌詞が必須（未指定だと開始できない）。
    "karaoke_start": (
        ParamSpec(name="lyrics", label="お題の歌詞", type="text", required=True,
                  help="カラオケのお題にする歌詞"),
    ),
    # _changer_impl: start では開始時設定、status では動作中の設定変更になる。
    "changer_start": _CHANGER_PARAMS,
    "changer_status": _CHANGER_PARAMS,
    # _global_impl: 参加にはルーム名が必須。パスワードは非公開ルーム用。
    "global_start": (
        ParamSpec(name="room", label="ルーム名", type="text", required=True,
                  help="参加するグローバルVCルーム名"),
        ParamSpec(name="password", label="パスワード", type="text",
                  help="非公開ルームのパスワード"),
    ),
}


def build_vc_actions() -> list[ActionSpec]:
    return [
        make_action("vc", value, label, "vc", ROOT_LABELS["vc"],
                    params=VC_ACTION_PARAMS.get(value, ()))
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
