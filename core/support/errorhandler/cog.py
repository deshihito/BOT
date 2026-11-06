"""コマンドのエラーをまとめて処理する cog（プレフィックスコマンドとスラッシュコマンドの両方）。

- 存在しないコマンド（ふつうの「!」で始まる会話など）には反応しない
- よくある失敗（クールダウン・権限不足・DM での実行・引数の間違いなど）は日本語で短く案内する
- 想定外のエラーは利用者にはエラー ID だけを見せ、詳しい内容（トレースバック）はログに残す
- コマンドや cog が自分のエラーハンドラーを持っている場合は、そちらに任せて何もしない
"""
from __future__ import annotations

import logging
import uuid
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from core.command_catalog import permission_label
from core.emojis import FAILED

logger = logging.getLogger("cogs.errorhandler")


def new_error_id() -> str:
    return uuid.uuid4().hex[:8]


def _permissions_text(names) -> str:
    return "、".join(permission_label(name) for name in names) or "不明"


def prefix_usage(command: Optional[commands.Command], prefix: str = "!") -> Optional[str]:
    """プレフィックスコマンドの使い方（command_meta の usage があればそれを使う）。"""
    if command is None:
        return None
    try:
        from core.command_meta import COMMAND_META
        usage = (COMMAND_META.get(f"!{command.qualified_name}") or {}).get("usage")
    except Exception:
        usage = None
    if usage:
        return usage
    signature = command.signature
    return f"{prefix}{command.qualified_name}" + (f" {signature}" if signature else "")


def _with_usage(text: str, usage: Optional[str]) -> str:
    return f"{text}\n使い方: `{usage}`" if usage else text


def classify(error: Exception, *, usage: Optional[str] = None) -> tuple[Optional[str], bool]:
    """エラーを (利用者に見せる文, 想定外か) に分ける。文が None のときは何も返さない。

    プレフィックス（commands.*）とスラッシュ（app_commands.*）のどちらのエラーも受け付ける。
    """
    # 呼び出し中に起きた例外は中身で判断する
    if isinstance(error, (commands.CommandInvokeError, commands.HybridCommandError)):
        error = error.original
    if isinstance(error, app_commands.CommandInvokeError):
        error = error.original

    # 反応しない
    if isinstance(error, (commands.CommandNotFound, app_commands.CommandNotFound)):
        return None, False
    if isinstance(error, commands.NotOwner):
        return None, False  # オーナー専用コマンドの存在を知らせない

    # クールダウン・同時実行
    if isinstance(error, (commands.CommandOnCooldown, app_commands.CommandOnCooldown)):
        return f"{FAILED} 少し待ってからもう一度試してください（あと {error.retry_after:.1f} 秒）。", False
    if isinstance(error, commands.MaxConcurrencyReached):
        return f"{FAILED} いまはこのコマンドを同時に実行できる上限に達しています。少し待ってから試してください。", False

    # 権限・ロール
    if isinstance(error, (commands.MissingPermissions, app_commands.MissingPermissions)):
        return f"{FAILED} このコマンドを使うには次の権限が必要です: {_permissions_text(error.missing_permissions)}", False
    if isinstance(error, (commands.BotMissingPermissions, app_commands.BotMissingPermissions)):
        return f"{FAILED} Bot に次の権限がないため実行できません: {_permissions_text(error.missing_permissions)}", False
    if isinstance(error, (commands.MissingRole, commands.MissingAnyRole,
                          app_commands.MissingRole, app_commands.MissingAnyRole)):
        return f"{FAILED} このコマンドを使うのに必要なロールがありません。", False

    # DM / サーバー
    if isinstance(error, (commands.NoPrivateMessage, app_commands.NoPrivateMessage)):
        return "🏠 このコマンドはサーバーの中で使ってください（DM では使えません）。", False
    if isinstance(error, commands.PrivateMessageOnly):
        return "✉️ このコマンドは DM で使ってください。", False
    if isinstance(error, commands.DisabledCommand):
        return f"{FAILED} このコマンドはいま使えません。", False

    # 引数
    if isinstance(error, commands.MissingRequiredArgument):
        return _with_usage(f"{FAILED} `{error.param.name}` が足りません。", usage), False
    if isinstance(error, commands.MissingRequiredAttachment):
        return _with_usage(f"{FAILED} ファイルを添付してください。", usage), False
    if isinstance(error, commands.TooManyArguments):
        return _with_usage(f"{FAILED} 引数が多すぎます。", usage), False
    if isinstance(error, (commands.BadArgument, commands.BadUnionArgument, commands.BadLiteralArgument,
                          commands.ArgumentParsingError, app_commands.TransformerError)):
        return _with_usage(f"{FAILED} 引数の形が正しくありません。", usage), False
    if isinstance(error, commands.UserInputError):
        return _with_usage(f"{FAILED} コマンドの書き方が正しくありません。", usage), False

    # そのほかのチェック失敗（独自のチェックなど）
    if isinstance(error, (commands.CheckFailure, app_commands.CheckFailure)):
        return f"{FAILED} このコマンドを実行できる条件を満たしていません。", False

    return None, True


def unexpected_message(error_id: str) -> str:
    return f"{FAILED} 予期しないエラーが起きました。管理者に伝えるときはエラーID `{error_id}` を添えてください。"


def _cog_overrides(cog, name: str) -> bool:
    """cog が cog_command_error / cog_app_command_error を自分で定義しているか。"""
    if cog is None:
        return False
    method = getattr(type(cog), name, None)
    return method is not None and method is not getattr(commands.Cog, name, None)


def prefix_has_local_handler(ctx) -> bool:
    command = getattr(ctx, "command", None)
    if command is not None and command.has_error_handler():
        return True
    return _cog_overrides(getattr(ctx, "cog", None), "cog_command_error")


def app_has_local_handler(interaction) -> bool:
    command = getattr(interaction, "command", None)
    if command is None:
        return False
    if getattr(command, "on_error", None) is not None:
        return True
    parent = getattr(command, "parent", None)
    while parent is not None:  # グループ側のハンドラー
        if type(parent).on_error is not app_commands.Group.on_error:
            return True
        parent = getattr(parent, "parent", None)
    return _cog_overrides(getattr(command, "binding", None), "cog_app_command_error")


class ErrorHandler(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        tree = getattr(bot, "tree", None)
        self._previous_tree_error = getattr(tree, "on_error", None) if tree is not None else None
        if tree is not None:
            tree.on_error = self.on_app_command_error

    async def cog_unload(self) -> None:
        tree = getattr(self.bot, "tree", None)
        if tree is not None and self._previous_tree_error is not None:
            tree.on_error = self._previous_tree_error

    # ------------------------------------------------------------ プレフィックスコマンド
    @commands.Cog.listener()
    async def on_command_error(self, ctx: commands.Context, error: commands.CommandError):
        if prefix_has_local_handler(ctx):
            return
        usage = prefix_usage(getattr(ctx, "command", None), getattr(ctx, "clean_prefix", None) or "!")
        message, unexpected = classify(error, usage=usage)
        if unexpected:
            error_id = new_error_id()
            original = getattr(error, "original", error)
            logger.error(
                "[%s] コマンド %s でエラー（ユーザー %s）", error_id,
                getattr(getattr(ctx, "command", None), "qualified_name", "?"), getattr(getattr(ctx, "author", None), "id", "?"),
                exc_info=(type(original), original, original.__traceback__),
            )
            message = unexpected_message(error_id)
        if message is None:
            return
        try:
            await ctx.send(message)
        except discord.HTTPException:
            logger.debug("エラーメッセージを送れませんでした", exc_info=True)

    # ------------------------------------------------------------ スラッシュコマンド
    async def on_app_command_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError):
        if app_has_local_handler(interaction):
            return
        message, unexpected = classify(error)
        if unexpected:
            error_id = new_error_id()
            original = getattr(error, "original", error)
            command = getattr(interaction, "command", None)
            logger.error(
                "[%s] スラッシュコマンド %s でエラー（ユーザー %s）", error_id,
                getattr(command, "qualified_name", "?"), getattr(getattr(interaction, "user", None), "id", "?"),
                exc_info=(type(original), original, original.__traceback__),
            )
            message = unexpected_message(error_id)
        if message is None:
            return
        try:
            if interaction.response.is_done():
                await interaction.followup.send(message, ephemeral=True)
            else:
                await interaction.response.send_message(message, ephemeral=True)
        except discord.HTTPException:
            logger.debug("エラーメッセージを送れませんでした", exc_info=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(ErrorHandler(bot))
