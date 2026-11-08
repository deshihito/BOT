"""Logfare Clefを使ったAI toolsのツール呼び出し。"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

import discord
from discord.ext import commands

from core.general.ai import logfare
from core.general.ai_tools import ai_tools_router
logger = logging.getLogger(__name__)

# インフラ系の失敗（判定APIの障害・タイムアウト・運用環境の問題）と、予期せぬ
# 例外のときに利用者へ返す汎用文。詳細（APIキーの確認指示など運用者向けの
# 内容や生の例外文）は利用者に見せず、サーバーログにのみ残す。
GENERIC_FAILURE_MESSAGE = (
    "fastoolerの判定または機能実行に失敗しました。時間をおいて再度お試しください。"
    "解決しない場合はBotの運営に連絡してください。"
)


def _enabled() -> bool:
    return os.getenv("AITOOLS_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}


def _is_miq_trigger(message, bot_user) -> bool:
    """MIQのトリガー（引用メッセージへの返信で「@BOT miq」）かどうか。

    cogs/general.py の is_miq_trigger と同じ判定を、循環インポートを避けるため
    ここにも持つ。MIQトリガーに AITools が反応すると、LLM が general:miq_settings
    を選び、ShortcutMessageInteraction が ephemeral を捨てて MIQ設定パネルを
    チャンネルへ公開送信してしまう（引用画像と一緒に設定が出る原因）。
    そのため AITools は MIQトリガーには一切反応しない。画像生成は GeneralCog 側が行う。
    """
    if bot_user is None or getattr(message, "reference", None) is None:
        return False
    if getattr(message.reference, "message_id", None) is None:
        return False
    content = getattr(message, "content", "") or ""
    if f"<@{bot_user.id}>" not in content and f"<@!{bot_user.id}>" not in content:
        return False
    return re.sub(r"<@!?\d+>", "", content).strip().lower() == "miq"


def _resolve_invoker(message, bot_user):
    """Bot投稿ではinteraction/reply/明示mention、最後に単独VC参加者から人間を特定する。"""
    if not getattr(message.author, "bot", False):
        return message.author

    guild = getattr(message, "guild", None)

    def as_member(user):
        if user is None:
            return None
        get_member = getattr(guild, "get_member", None)
        member = get_member(user.id) if callable(get_member) else None
        return member or user

    metadata = getattr(message, "interaction_metadata", None)
    interaction = getattr(message, "interaction", None)
    reference = getattr(message, "reference", None)
    resolved = getattr(reference, "resolved", None)
    candidates = [
        getattr(metadata, "user", None),
        getattr(interaction, "user", None),
        getattr(resolved, "author", None),
    ]
    candidates.extend(
        user for user in getattr(message, "mentions", [])
        if getattr(user, "id", None) != getattr(bot_user, "id", None)
    )
    for user in candidates:
        member = as_member(user)
        if member is not None and not getattr(member, "bot", False):
            return member

    # Bot-to-bot依頼にユーザー情報が載らない場合、VC内の人間が一人だけなら曖昧でない。
    members = {
        member.id: member
        for channel in getattr(guild, "voice_channels", [])
        for member in getattr(channel, "members", [])
        if not getattr(member, "bot", False)
    }
    return next(iter(members.values())) if len(members) == 1 else None


def _parse_param_input(param: dict, raw: str) -> Any:
    """補完モーダルの文字列入力を ParamSpec の型に変換する（変換できなければ ValueError）。"""
    raw = (raw or "").strip()
    label = param.get("label") or param.get("name") or "引数"
    ptype = param.get("type")
    if ptype == "int":
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
    if ptype in {"number", "duration"}:
        try:
            return float(raw)
        except ValueError:
            raise ValueError(f"{label}は数値で入力してください。") from None
    if ptype == "bool":
        lowered = raw.lower()
        if lowered in {"true", "on", "オン", "有効", "yes", "1"}:
            return True
        if lowered in {"false", "off", "オフ", "無効", "no", "0"}:
            return False
        raise ValueError(f"{label}はオン/オフで入力してください。")
    if ptype == "choice":
        for choice_label, choice_value in param.get("choices") or []:
            if raw == str(choice_value) or raw == str(choice_label):
                return choice_value
        raise ValueError(f"{label}は選択肢の中から入力してください。")
    if ptype in {"member", "user", "channel", "role"}:
        digits = re.sub(r"\D", "", raw)
        if not digits:
            raise ValueError(f"{label}は対象を指定してください。")
        return int(digits)
    return raw


class AIToolsConfirmView(discord.ui.View):
    """risk="confirm" のアクションで、実行前に明示確認を挟むビュー。

    押せるのは依頼者（invoker）だけ。確認するまで対象アクションは実行されず、
    キャンセル／タイムアウトでも実行しない。
    """

    def __init__(self, *, invoker_id: int, base_text: str, on_execute, timeout: float = 180):
        super().__init__(timeout=timeout)
        self.invoker_id = invoker_id
        self.base_text = base_text
        self.on_execute = on_execute
        self.message: discord.Message | None = None
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.invoker_id

    def _disable_all(self) -> None:
        for child in self.children:
            child.disabled = True

    @discord.ui.button(label="実行する", style=discord.ButtonStyle.danger)
    async def confirm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.finished = True
        self._disable_all()
        await interaction.response.edit_message(content=self.base_text + "\n実行します。", view=self)
        self.stop()
        await self.on_execute()

    @discord.ui.button(label="やめる", style=discord.ButtonStyle.secondary)
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.finished = True
        self._disable_all()
        await interaction.response.edit_message(content=self.base_text + "\nキャンセルしました。実行していません。", view=self)
        self.stop()

    async def on_timeout(self) -> None:
        if self.finished or self.message is None:
            return
        self._disable_all()
        try:
            await self.message.edit(content=self.base_text + "\n時間切れのため実行しませんでした。", view=self)
        except Exception:
            logger.debug("AI tools confirm view timeout edit failed", exc_info=True)


class AIToolsParamModal(discord.ui.Modal, title="不足している引数の入力"):
    """不足している required 引数を入力するモーダル（最大5件）。"""

    def __init__(self, parent_view: "AIToolsParamCompletionView"):
        super().__init__()
        self.parent_view = parent_view
        self.inputs: dict[str, discord.ui.TextInput] = {}
        for param in parent_view.missing[:5]:
            text_input = discord.ui.TextInput(
                label=(param.get("label") or param.get("name") or "引数")[:45],
                required=True,
                placeholder=(param.get("help") or "")[:100],
                max_length=200,
            )
            self.inputs[param["name"]] = text_input
            self.add_item(text_input)

    async def on_submit(self, interaction: discord.Interaction):
        raw = {name: text_input.value for name, text_input in self.inputs.items()}
        await self.parent_view.accept_values(interaction, raw)


class AIToolsParamCompletionView(discord.ui.View):
    """required 引数が不足したときに、依頼者へ入力を求めるビュー。

    押せるのは依頼者だけ。入力が確定するまで対象アクションは実行されず、
    キャンセル／タイムアウトでも実行しない。
    """

    def __init__(self, *, item: dict, base_params: dict, missing: list[dict],
                 invoker_id: int, base_text: str, execute, timeout: float = 300):
        super().__init__(timeout=timeout)
        self.item = item
        self.base_params = base_params
        self.missing = missing
        self.invoker_id = invoker_id
        self.base_text = base_text
        self.execute = execute
        self.message: discord.Message | None = None
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.invoker_id

    def _disable_all(self) -> None:
        for child in self.children:
            child.disabled = True

    @discord.ui.button(label="不足分を入力", style=discord.ButtonStyle.primary)
    async def input_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(AIToolsParamModal(self))

    @discord.ui.button(label="やめる", style=discord.ButtonStyle.secondary)
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.finished = True
        self._disable_all()
        await interaction.response.edit_message(content=self.base_text + "\nキャンセルしました。実行していません。", view=self)
        self.stop()

    async def on_timeout(self) -> None:
        if self.finished or self.message is None:
            return
        self._disable_all()
        try:
            await self.message.edit(content=self.base_text + "\n時間切れのため実行しませんでした。", view=self)
        except Exception:
            logger.debug("AI tools completion view timeout edit failed", exc_info=True)

    async def accept_values(self, interaction: discord.Interaction, raw_values: dict[str, str]) -> None:
        """モーダルの入力を検証し、問題なければ実行（または確認ビューへ遷移）する。"""
        values: dict[str, Any] = {}
        for param in self.missing:
            name = param["name"]
            if name not in raw_values:
                continue
            try:
                values[name] = _parse_param_input(param, raw_values[name])
            except ValueError as exc:
                await interaction.response.send_message(str(exc), ephemeral=True)
                return
        merged = {**self.base_params, **values}
        try:
            merged = ai_tools_router.validate_params_for(self.item, merged)
        except ValueError as exc:
            await interaction.response.send_message(str(exc), ephemeral=True)
            return
        label = self.item.get("label") or self.item.get("value")
        summary = ai_tools_router.format_params_summary(self.item, merged)
        await interaction.response.defer()
        self.finished = True
        self._disable_all()
        if ai_tools_router.requires_confirmation(self.item):
            # 補完できても confirm リスクなら、実行前に確認ビューを挟む。
            text = f"fastooler: 「{label}」を実行しますか？" + (f"\n引数: {summary}" if summary else "")
            confirm_view = AIToolsConfirmView(
                invoker_id=self.invoker_id,
                base_text=text,
                on_execute=lambda: self.execute(merged),
            )
            if self.message is not None:
                await self.message.edit(content=text, view=confirm_view)
                confirm_view.message = self.message
            self.stop()
            return
        if self.message is not None:
            await self.message.edit(content=self.base_text + "\n実行します。", view=self)
        self.stop()
        await self.execute(merged)
        if self.message is not None:
            done_text = f"fastooler: 「{label}」を実行しました。" + (f"（引数: {summary}）" if summary else "")
            try:
                await self.message.edit(content=done_text, view=self)
            except Exception:
                logger.debug("AI tools completion view done edit failed", exc_info=True)


class AIToolsCog(commands.Cog):
    """Mention-driven tool selection; no per-user or per-action configuration."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def _prompt(self, content: str) -> str:
        if not self.bot.user:
            return content.strip()
        return re.sub(rf"<@!?{self.bot.user.id}>", "", content).strip()

    async def _execute_ai_action(self, message, item: dict, invoker, params: dict) -> None:
        """補完／確認ビューから確定した実行（invoke_action への委譲）。"""
        async with message.channel.typing():
            await ai_tools_router.invoke_action(
                self.bot, message, item, invoker=invoker, params=params)

    @commands.command(name="aitools", help="Check the status of fastooler")
    async def aitools(self, ctx: commands.Context, action: str = "status"):
        action = action.strip().lower()
        if action not in {"", "status"}:
            return await ctx.reply("fastoolerはメンションから使う単一機能です。状態確認は `!aitools status`。", mention_author=False)
        candidates = ai_tools_router.action_candidates()
        configured = bool(logfare.api_key())
        key_status = "設定済み" if configured else "未設定"
        return await ctx.reply(
            "fastooler稼働状態\n"
            f"全体有効: `{_enabled()}`\n"
            f"Logfare APIキー: `{key_status}`\n"
            f"モデル: `clef`\n"
            f"実行可能な安全ツール: `{len(candidates)}件`\n"
            "BOTへのメンションに依頼を続けてください。個人別・操作別の設定はありません。",
            mention_author=False,
        )

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not message.guild:
            return
        if not self.bot.user or message.author.id == self.bot.user.id or self.bot.user not in message.mentions:
            return
        # MIQトリガーには反応しない。GeneralCog が引用画像を作る。
        # ここで返さないと、AITools が miq_settings を選んで MIQ設定を公開送信する。
        if _is_miq_trigger(message, self.bot.user):
            return
        if not _enabled():
            return await message.reply("fastoolerはサーバー設定で停止中です。", mention_author=False)
        invoker = _resolve_invoker(message, self.bot.user)
        if invoker is None:
            return await message.reply(
                "fastoolerは呼び出し元の人間を特定できませんでした。人間をメンションするか、VCに人間が一人だけいる状態で依頼してください。",
                mention_author=False,
            )
        if not logfare.api_key():
            return await message.reply(
                "fastoolerを実行できません。運用環境に `LOGFARE_API_KEY` が設定されていません。",
                mention_author=False,
            )
        prompt = self._prompt(message.content)
        if not prompt:
            return await message.reply("メンションの後に実行したい内容を入力してください。", mention_author=False)
        try:
            candidates = ai_tools_router.action_candidates()
            selected = await ai_tools_router.decide_action(prompt, candidates)
            item = candidates[selected]
            label = item.get("label") or selected
            # 引数があるアクションだけ、依頼文からの抽出（第2段）を行う。
            params = await ai_tools_router.extract_params(prompt, item)
            missing = ai_tools_router.missing_required_params(item, params)
            if missing:
                # required な引数が不足していたら推測で実行せず、依頼者にだけ
                # 操作できる補完ビューで入力を求める。
                names = "、".join(p.get("label") or p.get("name") for p in missing)
                text = (
                    f"fastooler: 「{label}」には引数（{names}）が不足しています。"
                    "下のボタンから入力してください。入力がなければ実行しません。"
                )
                view = AIToolsParamCompletionView(
                    item=item,
                    base_params=params,
                    missing=missing,
                    invoker_id=invoker.id,
                    base_text=text,
                    execute=lambda p: self._execute_ai_action(message, item, invoker, p),
                )
                view.message = await message.reply(text, view=view, mention_author=False)
                return
            if ai_tools_router.requires_confirmation(item):
                # risk="confirm" は実行前に確認ビューを挟む（確認なしには実行しない）。
                summary = ai_tools_router.format_params_summary(item, params)
                text = f"fastooler: 「{label}」を実行しますか？" + (f"\n引数: {summary}" if summary else "")
                view = AIToolsConfirmView(
                    invoker_id=invoker.id,
                    base_text=text,
                    on_execute=lambda: self._execute_ai_action(message, item, invoker, params),
                )
                view.message = await message.reply(text, view=view, mention_author=False)
                return
            if params:
                # 引数付きで実行するときは、何を・どの引数で実行するか先に明示する。
                summary = ai_tools_router.format_params_summary(item, params)
                await message.reply(
                    f"fastooler: 「{label}」を実行します（引数: {summary}）。",
                    mention_author=False,
                )
            async with message.channel.typing():
                await ai_tools_router.invoke_action(self.bot, message, item, invoker=invoker, params=params)
        except ai_tools_router.AIToolsNoAction as exc:
            logger.info("AI tools skipped: %s", exc)
        except ai_tools_router.AIToolsUnavailable as exc:
            # 判定API・運用環境側の失敗。詳細は例外型名と原因チェーンつきで
            # ログに残し、利用者には汎用文だけを返す（APIキーの確認指示など
            # 運用者向けの文面や、str が空の例外による未完文を晒さない）。
            logger.warning(
                "AI tools unavailable: %s: %r (cause=%r) user=%s",
                type(exc).__name__, exc, exc.__cause__, message.author.id,
            )
            await message.reply(GENERIC_FAILURE_MESSAGE, mention_author=False)
        except ai_tools_router.AIToolsDecisionError as exc:
            logger.info("AI tools stopped: %s", exc)
            await message.reply(f"fastoolerは実行されませんでした。理由: {exc}", mention_author=False)
        except Exception:
            logger.exception("AI tools failed: user=%s", message.author.id)
            await message.reply(GENERIC_FAILURE_MESSAGE, mention_author=False)


async def setup(bot: commands.Bot):
    await bot.add_cog(AIToolsCog(bot))
