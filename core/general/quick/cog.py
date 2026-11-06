# -*- coding: utf-8 -*-
"""クイックパレット `/quick`: 全機能横断の直接実行コマンド。

スラッシュコマンドの母数を増やさない原則（仕様書 §3 原則6）の唯一の例外として
新設する1件。引数 ``action`` の動的オートコンプリートを
``core/action_registry`` から生成し、選ばれたアクションを既存 dispatch へ
委譲するだけに徹する（実行ロジックは持たない）。

- 対象は surfaces に "palette" を含むアクションだけ
- required 引数を持つアクションは、そのまま dispatch せず、本人だけが
  操作できる補完ビュー（ボタン→モーダル→検証→実行）を挟む
  （PR #376 の AI tools 補完ビューと同型）
- 権限チェックは従来どおり dispatch 側が正。レジストリに permission を
  持つアクションは現状ない（ActionSpec.permission は全件 None）ため、
  autocomplete での権限フィルタは行わず dispatch 任せとする
"""
from __future__ import annotations

import logging
from typing import Any

import discord
from discord import app_commands
from discord.ext import commands

from core.general import action_registry

logger = logging.getLogger(__name__)

AUTOCOMPLETE_LIMIT = 25


class QuickError(RuntimeError):
    """委譲先の cog が見つからないなど、/quick 側で止めるべきエラー。"""


# ---------------------------------------------------------------------------
# オートコンプリート（レジストリから生成）
# ---------------------------------------------------------------------------

def palette_actions(
    registry: action_registry.ActionRegistry | None = None,
) -> list[action_registry.ActionSpec]:
    """パレット対象（surfaces に "palette" を含む）アクションの一覧。"""
    registry = registry or action_registry.default_registry()
    return list(registry.for_surface("palette"))


def _matches(spec: action_registry.ActionSpec, query: str) -> bool:
    if not query:
        return True
    needle = query.lower()
    haystacks = [spec.label, spec.id, spec.value, spec.genre, spec.genre_label, spec.description]
    haystacks.extend(spec.keywords)
    return any(needle in str(text).lower() for text in haystacks if text)


def filter_palette_actions(
    query: str,
    *,
    registry: action_registry.ActionRegistry | None = None,
    limit: int = AUTOCOMPLETE_LIMIT,
) -> list[action_registry.ActionSpec]:
    """入力文字列で label／keywords／id／genre に部分一致フィルタし、最大 limit 件を返す。"""
    query = (query or "").strip()
    matched = [spec for spec in palette_actions(registry) if _matches(spec, query)]
    return matched[:limit]


def autocomplete_choices(
    query: str,
    *,
    registry: action_registry.ActionRegistry | None = None,
) -> list[app_commands.Choice[str]]:
    """オートコンプリート候補（表示「ジャンル名 / ラベル」、値は action id）。"""
    return [
        app_commands.Choice(name=f"{spec.genre_label} / {spec.label}", value=spec.id)
        for spec in filter_palette_actions(query, registry=registry)
    ]


# ---------------------------------------------------------------------------
# 実行の委譲
# ---------------------------------------------------------------------------

async def _send_ephemeral(interaction: discord.Interaction, text: str, *, ephemeral: bool = True) -> None:
    if interaction.response.is_done():
        await interaction.followup.send(text, ephemeral=ephemeral)
    else:
        await interaction.response.send_message(text, ephemeral=ephemeral)


async def dispatch_action(
    bot,
    interaction: discord.Interaction,
    spec: action_registry.ActionSpec,
    params: dict[str, Any] | None = None,
) -> Any:
    """アクションを root ごとの既存 dispatch へ委譲する。

    パネル／ショートカットと同じ dispatch を使うため、権限チェックや
    利用履歴の記録（dispatch 入口）もそのまま効く。
    """
    params = params or {}
    if spec.root == "general":
        cog = bot.get_cog("GeneralCog")
        if cog is None:
            raise QuickError("機能ディスパッチャーが読み込まれていません。")
        return await cog.dispatch_general(interaction, spec.value)
    if spec.root == "vc":
        cog = bot.get_cog("VoiceHub")
        if cog is None:
            raise QuickError("VC機能が読み込まれていません。")
        allowed = {param.name for param in spec.params}
        kwargs = {name: value for name, value in params.items() if name in allowed}
        return await cog.dispatch_voice_action(interaction, spec.value, **kwargs)
    if spec.root == "support":
        cog = bot.get_cog("SupportCog")
        if cog is None:
            raise QuickError("サポート機能が読み込まれていません。")
        return await cog.dispatch(interaction, spec.value)
    if spec.root == "game":
        cog = bot.get_cog("GameHub")
        if cog is None:
            raise QuickError("ゲーム機能が読み込まれていません。")
        return await cog.start_game(interaction, spec.value.removeprefix("game:"))
    if spec.root == "help":
        return await _send_ephemeral(interaction, "ヘルプは `/help` で確認できます。", ephemeral=False)
    raise QuickError(f"未知のルートです: {spec.root}")


def missing_required_params(spec: action_registry.ActionSpec) -> list[action_registry.ParamSpec]:
    """値が無いと実行できない required 引数の一覧（/quick は引数を取らないため全件不足扱い）。"""
    return [param for param in spec.params if param.required]


# ---------------------------------------------------------------------------
# required 引数の補完フロー（本人だけが操作できるビュー＋モーダル）
# ---------------------------------------------------------------------------

def _convert_param_input(param: action_registry.ParamSpec, raw: str) -> Any:
    """モーダルの文字列入力を ParamSpec の型に変換する（変換できなければ ValueError）。"""
    raw = (raw or "").strip()
    label = param.label or param.name
    if param.type == "int":
        try:
            return int(raw)
        except ValueError:
            try:
                value = float(raw)
            except ValueError:
                raise ValueError(f"{label}は整数で入力してください。") from None
            if not value.is_integer():
                raise ValueError(f"{label}は整数で入力してください。")
            return int(value)
    if param.type in {"number", "duration"}:
        try:
            return float(raw)
        except ValueError:
            raise ValueError(f"{label}は数値で入力してください。") from None
    if param.type == "bool":
        lowered = raw.lower()
        if lowered in {"true", "on", "オン", "有効", "yes", "1"}:
            return True
        if lowered in {"false", "off", "オフ", "無効", "no", "0"}:
            return False
        raise ValueError(f"{label}はオン/オフで入力してください。")
    if param.type == "choice":
        for choice_label, choice_value in param.choices:
            if raw == str(choice_value) or raw == str(choice_label):
                return choice_value
        raise ValueError(f"{label}は選択肢の中から入力してください。")
    return raw


class QuickParamModal(discord.ui.Modal, title="不足している引数の入力"):
    """不足している required 引数を入力するモーダル（最大5件）。"""

    def __init__(self, cog: "QuickCog", spec: action_registry.ActionSpec,
                 missing: list[action_registry.ParamSpec]):
        super().__init__()
        self.cog = cog
        self.spec = spec
        self.missing = missing
        self.inputs: dict[str, discord.ui.TextInput] = {}
        for param in missing[:5]:
            text_input = discord.ui.TextInput(
                label=(param.label or param.name)[:45],
                required=True,
                placeholder=(param.help or "")[:100],
                max_length=200,
            )
            self.inputs[param.name] = text_input
            self.add_item(text_input)

    async def on_submit(self, interaction: discord.Interaction):
        raw = {name: text_input.value for name, text_input in self.inputs.items()}
        try:
            converted = {
                param.name: _convert_param_input(param, raw[param.name])
                for param in self.missing
                if param.name in raw
            }
            params = action_registry.validate_params(self.spec, converted)
        except ValueError as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await dispatch_action(self.cog.bot, interaction, self.spec, params)


class QuickParamPromptView(discord.ui.View):
    """required 引数が不足したときに、実行者へ入力を求めるビュー。

    押せるのは /quick を実行した本人だけ。入力が確定するまで対象アクションは
    実行されず、キャンセル／タイムアウトでも実行しない。
    """

    def __init__(self, cog: "QuickCog", spec: action_registry.ActionSpec,
                 missing: list[action_registry.ParamSpec], *, user_id: int,
                 timeout: float = 300):
        super().__init__(timeout=timeout)
        self.cog = cog
        self.spec = spec
        self.missing = missing
        self.user_id = user_id
        self.message: discord.Message | None = None
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    def _disable_all(self) -> None:
        for child in self.children:
            child.disabled = True

    @discord.ui.button(label="不足分を入力", style=discord.ButtonStyle.primary)
    async def input_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(
            QuickParamModal(self.cog, self.spec, self.missing))

    @discord.ui.button(label="やめる", style=discord.ButtonStyle.secondary)
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.finished = True
        self._disable_all()
        await interaction.response.edit_message(
            content=f"「{self.spec.label}」はキャンセルしました。実行していません。", view=self)
        self.stop()

    async def on_timeout(self) -> None:
        if self.finished or self.message is None:
            return
        self._disable_all()
        try:
            await self.message.edit(
                content=f"「{self.spec.label}」は時間切れのため実行しませんでした。", view=self)
        except Exception:
            logger.debug("quick param prompt timeout edit failed", exc_info=True)


# ---------------------------------------------------------------------------
# コマンド本体
# ---------------------------------------------------------------------------

class QuickCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="quick", description="全機能から検索して直接実行します")
    @app_commands.describe(action="実行する機能（入力すると候補が出ます）")
    async def quick(self, interaction: discord.Interaction, action: str):
        spec = action_registry.default_registry().get((action or "").strip())
        if spec is None or "palette" not in spec.surfaces:
            return await interaction.response.send_message(
                "その機能は見つかりませんでした。候補から選んでください。", ephemeral=True)
        missing = missing_required_params(spec)
        if missing:
            names = "、".join(param.label or param.name for param in missing)
            text = (
                f"「{spec.label}」には引数（{names}）が必要です。"
                "下のボタンから入力してください。入力がなければ実行しません。"
            )
            view = QuickParamPromptView(self, spec, missing, user_id=interaction.user.id)
            await interaction.response.send_message(text, view=view)
            view.message = await interaction.original_response()
            return
        try:
            await dispatch_action(self.bot, interaction, spec)
        except QuickError as exc:
            await _send_ephemeral(interaction, str(exc))

    @quick.autocomplete("action")
    async def quick_action_autocomplete(
        self, interaction: discord.Interaction, current: str,
    ) -> list[app_commands.Choice[str]]:
        return autocomplete_choices(current)


async def setup(bot: commands.Bot):
    await bot.add_cog(QuickCog(bot))
