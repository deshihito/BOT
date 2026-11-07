"""管理者向け利用統計ツール（隠しプレフィックスコマンド ``!usage_stats``）。

``!logs`` や ``!all_stats`` と同じ admin 区分のコマンドで、Bot 全体の
リクエスト総数とコマンド／アクションの使用率を表示する。集計そのものは
core/support/usage_stats/usage_stats.py の総量カウンタ（ユーザ単位の内訳は持たない）が担い、
この cog は「数える入口」と表示だけを持つ:

- プレフィックスコマンド: ``on_command_completion``（正常完了したもの）
  を ``!コマンド名`` として計数
- スラッシュコマンド: ``on_interaction`` で application_command の
  呼び出しを ``/コマンド名`` として計数
- アクション実行: パネル等の dispatch 入口（general/support/vc/game）で
  core/usage_stats.record_action_safely が直接記録する（この cog は関与しない）

権限は cogs/terminal.py の ALLOWED_USER_IDS（bot_admin）を流用し、
対象外のユーザには無言で何も返さない（!check_api と同じ流儀）。
"""
from __future__ import annotations

import logging
from datetime import datetime

import discord
from discord.ext import commands

from cogs.support import ALLOWED_USER_IDS
from core.general import action_registry
from core.support.usage_stats import usage_stats
logger = logging.getLogger(__name__)


def _action_label(action_id: str) -> str | None:
    spec = action_registry.default_registry().get(action_id)
    return spec.label if spec is not None else None


def _started_date(started_at: str) -> str:
    try:
        return datetime.fromisoformat(started_at).date().isoformat()
    except Exception:
        return started_at or "不明"


class UsageStatsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def cog_unload(self):
        # 終了時に未保存分を書き出す（定期フラッシュとの二重化）。
        usage_stats.flush_safely()

    async def _guild_growth_field(self) -> str | None:
        """導入履歴（guild_history）から直近の新規導入数と総サーバー数を返す。

        履歴は記録開始（本機能のデプロイ）以降分のみ。取得に失敗したら
        統計表示自体は落とさず、この欄だけ出さない。
        """
        try:
            from datetime import datetime, timezone

            from core.support.guild_registry import count_recent_joins, get_registry

            events = await get_registry().load_history()
            now = datetime.now(timezone.utc)
            joins_7d = count_recent_joins(events, now=now, days=7)
            joins_30d = count_recent_joins(events, now=now, days=30)
            total = len(self.bot.guilds)
            return (
                f"**現在の総サーバー数:** {total} 件\n"
                f"**新規導入:** 直近7日 {joins_7d} 件 / 直近30日 {joins_30d} 件"
                "（導入履歴の記録開始以降）"
            )
        except Exception:
            return None

    # ------------------------------------------------------------------ 計数
    @commands.Cog.listener()
    async def on_command_completion(self, ctx: commands.Context):
        if ctx.command is None:
            return
        usage_stats.record_command_safely(f"!{ctx.command.qualified_name}")

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.application_command:
            return
        name = (interaction.data or {}).get("name")
        if name:
            usage_stats.record_command_safely(f"/{name}")

    # ------------------------------------------------------------------ 表示
    @commands.command(name="usage_stats", aliases=["ustats"], usage="[reset]")
    async def usage_stats(self, ctx: commands.Context, action: str = None):
        """利用統計の表示（引数なし）／初期化（reset）。Bot 管理者専用。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return

        if action is not None:
            if action.lower() == "reset":
                usage_stats.reset_safely()
                await ctx.send("📊 利用統計をリセットしました（集計は今から再開します）。")
            else:
                await ctx.send(
                    "使い方は `!usage_stats`（統計を表示）または "
                    "`!usage_stats reset`（統計を初期化）です。"
                )
            return

        data = usage_stats.get_store().snapshot()
        commands_count = data.get("commands") or {}
        actions_count = data.get("actions") or {}
        total_commands = sum(commands_count.values())
        total_actions = sum(actions_count.values())
        today = datetime.now(usage_stats.JST).date().isoformat()
        today_bucket = (data.get("daily") or {}).get(today) or {}
        today_commands = int(today_bucket.get("commands") or 0)
        today_actions = int(today_bucket.get("actions") or 0)

        embed = discord.Embed(
            title="📊 利用統計（管理者向け）",
            color=discord.Color.blue(),
            timestamp=datetime.now(usage_stats.JST),
        )
        embed.add_field(
            name="概要",
            value=(
                f"**集計期間:** {_started_date(data.get('started_at', ''))} 〜 {today}\n"
                f"**リクエスト総数:** {total_commands + total_actions} 件"
                f"（コマンド呼び出し {total_commands} 件 + アクション実行 {total_actions} 件）\n"
                f"**本日:** {today_commands + today_actions} 件"
                f"（コマンド {today_commands} 件 + アクション {today_actions} 件）"
            ),
            inline=False,
        )
        guild_field = await self._guild_growth_field()
        if guild_field is not None:
            embed.add_field(name="導入", value=guild_field, inline=False)
        embed.add_field(
            name="コマンド使用率トップ10",
            value=usage_stats.format_top_lines(commands_count),
            inline=False,
        )
        embed.add_field(
            name="アクション使用率トップ10",
            value=usage_stats.format_top_lines(actions_count, label_for=_action_label),
            inline=False,
        )
        embed.set_footer(
            text="計数: プレフィックスは正常完了時、スラッシュは呼び出し時。アクションはパネル等の実行時。"
        )
        await ctx.send(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(UsageStatsCog(bot))
