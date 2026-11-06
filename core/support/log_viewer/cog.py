import io
import logging
from datetime import datetime
import discord
from discord.ext import commands
from core.emojis import FAILED

logger = logging.getLogger("cogs.log_viewer")

ALLOWED_USER_IDS = {
    1320705325686587408,  # ← ここを実際のユーザーIDに置き換える
    1000302102473613373,
}

# 有効なログレベルの定義（優先度順）
VALID_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}

async def is_log_allowed(ctx: commands.Context) -> bool:
    """
    ALLOWED_USER_IDS に含まれているユーザーのみ許可するチェック
    """
    return ctx.author.id in ALLOWED_USER_IDS


class LogViewer(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name="logs", usage="[行数] [重要度]")
    @commands.check(is_log_allowed)
    async def logs(self, ctx: commands.Context, line_count: int = 30, level: str = None):
        """
        !logs 50 ERROR
        のように使って、最新から指定行数分のログを表示する。
        第2引数に重要度(DEBUG, INFO, WARNING, ERROR, CRITICAL)を指定すると、
        その重要度のログのみをフィルタリングして出力する。
        同時に、現在保持している全ログ（またはフィルタ済み全ログ）をファイルで添付する。
        """
        # main.py で設定している bot.log_buffer を取得
        buffer = getattr(self.bot, "log_buffer", None)
        if buffer is None:
            await ctx.send(
                f"{FAILED} `bot.log_buffer` が見つかりません。\n"
                "`main.py` で `bot.log_buffer = log_buffer` が実行されているか確認してください。"
            )
            return

        # deque からリスト化
        all_lines = list(buffer.logs)
        if not all_lines:
            await ctx.send("📭 現在、取得できるログはありません。")
            return

        if line_count <= 0:
            await ctx.send(f"{FAILED} 行数は 1 以上で指定してください。")
            return

        # --- 重要度フィルタリング処理 ---
        filter_level = None
        if level:
            filter_level = level.upper()
            if filter_level not in VALID_LEVELS:
                await ctx.send(
                    f"{FAILED} 無効な重要度です: `{level}`\n"
                    f"使用可能な重要度: `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`"
                )
                return
            
            # ログ行に "[LEVEL]" が含まれているかでフィルタリング
            search_tag = f"[{filter_level}]"
            filtered_lines = [line for line in all_lines if search_tag in line]
        else:
            # フィルタなしの場合は全ログを対象にする
            filtered_lines = all_lines

        if not filtered_lines:
            await ctx.send(f"📭 重要度 `{filter_level}` のログは見つかりませんでした。")
            return

        # 最新側から指定行数分取得
        requested_lines = filtered_lines[-line_count:]
        requested_text = "\n".join(requested_lines)

        # 対象となる全ログ
        all_text = "\n".join(filtered_lines)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # ファイル名のプレフィックス（フィルタ適用時はレベル名を含める）
        prefix = f"{filter_level}_" if filter_level else ""

        # 全ログファイル
        all_file = discord.File(
            io.BytesIO(all_text.encode("utf-8")),
            filename=f"{prefix}all_logs_{timestamp}.txt"
        )

        # コードブロックを壊しにくいように一応エスケープ
        safe_requested_text = requested_text.replace("```", "｀｀｀")
        
        # レベル指定がある場合はメッセージに含める
        level_info = f" (重要度: {filter_level})" if filter_level else ""
        content = (
            f"📜 ログ{level_info}（最新 {len(requested_lines)} 件 / 保持 {len(filtered_lines)} 件）\n"
            f"```log\n"
            f"{safe_requested_text}\n"
            f"```"
        )

        # Discord のメッセージ上限 2000 文字以内なら本文として送る
        if len(content) <= 2000:
            await ctx.send(content, file=all_file)
        else:
            # 長すぎて本文に入りきらない場合はファイルで送る
            if requested_text == all_text:
                await ctx.send(
                    f"📜 ログが長いため、全ログファイルを添付します。{level_info}（保持 {len(filtered_lines)} 件）",
                    file=all_file
                )
            else:
                requested_file = discord.File(
                    io.BytesIO(requested_text.encode("utf-8")),
                    filename=f"{prefix}requested_logs_{timestamp}.txt"
                )
                await ctx.send(
                    f"📜 ログが長いため、指定分と全ログをファイルで添付します。\n"
                    f"{level_info}（指定 {len(requested_lines)} 件 / 保持 {len(filtered_lines)} 件）",
                    files=[all_file, requested_file]
                )

    @logs.error
    async def logs_error(self, ctx: commands.Context, error: commands.CommandError):
        """
        logs コマンド専用エラーハンドラ
        """
        # 許可されていないユーザーが使用した場合
        if isinstance(error, commands.CheckFailure):
            try:
                await ctx.send(f"{FAILED} このコマンドは許可されたユーザーのみ使用できます。")
            except Exception:
                logger.debug("権限エラーの通知送信に失敗しました", exc_info=True)
            return

        # 引数の数字が不正な場合
        if isinstance(error, commands.BadArgument):
            try:
                await ctx.send(f"{FAILED} 行数は数字で指定してください。例: `!logs 50 ERROR`")
            except Exception:
                logger.debug("引数エラーの通知送信に失敗しました", exc_info=True)
            return

        # その他のエラー
        try:
            await ctx.send(f"{FAILED} ログ取得中にエラーが発生しました。")
        except Exception:
            logger.debug("エラー通知の送信に失敗しました", exc_info=True)
        print(f"[LogViewer] logs command error: {error}")


async def setup(bot: commands.Bot):
    await bot.add_cog(LogViewer(bot))
