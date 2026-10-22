"""core/status_updater.py

Botのステータス（プレイ中 / カスタムステータスなど）を定期更新する。
例:
- プレイ中: メンバー数: 123人
- カスタムステータス: メンバー数: 123人
"""

from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands, tasks

logger = logging.getLogger(__name__)


# ======================================================
# 設定
# ======================================================

# 表示形式
# "playing"     -> プレイ中
# "watching"    -> 視聴中
# "listening"   -> リスニング中
# "competing"   -> 競い合い中
# "custom"      -> カスタムステータス（Botでは表示が不安定な場合あり）
STATUS_MODE = "playing"

# 集計方法
# "total" -> Botが参加している全サーバーの合計メンバー数
# "guild" -> TARGET_GUILD_ID で指定した1サーバーのメンバー数
STATUS_SOURCE = "total"

# STATUS_SOURCE = "guild" のときに使うサーバーID
# 例: TARGET_GUILD_ID = 123456789012345678
TARGET_GUILD_ID = None

# 更新間隔（分）
# Discordのレート制限を考えると、5分未満にはしないほうが安全です。
UPDATE_MINUTES = 10

# 表示テキスト
# 利用可能:
# {count}       -> メンバー数
# {guild_name}  -> 1サーバー指定時のサーバー名（total時は空になる）
# {guild_count} -> Botの参加サーバー数
TEXT_TEMPLATE = "メンバー数: {count}人"

# カスタムステータス用の内部名前
# 実際の表示には state / text 側が使われます。
CUSTOM_STATUS_NAME = "ステータス"

# ======================================================


# 最低でも5分開ける
UPDATE_MINUTES = max(5, float(UPDATE_MINUTES))


def truncate_text(text: str, limit: int = 128) -> str:
    """DiscordのActivity名/ステータス用に長さを制限する。"""
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


class StatusUpdater(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.last_text: str | None = None

        # 念のため設定値を反映
        self.update_status.change_interval(minutes=UPDATE_MINUTES)
        self.update_status.start()

        # すでにBotが起動済みなら即時更新
        if self.bot.is_ready():
            asyncio.create_task(self._update())

    async def cog_unload(self):
        self.update_status.cancel()

    def _resolve_count(self) -> tuple[int, str | None]:
        """
        表示用のメンバー数を取得する。

        戻り値:
            count, guild_name
        """
        if STATUS_SOURCE.lower() == "guild" and TARGET_GUILD_ID:
            try:
                guild_id = int(TARGET_GUILD_ID)
            except (TypeError, ValueError):
                logger.warning("TARGET_GUILD_ID が正しくないため全サーバー合計にフォールバックします。")
            else:
                guild = self.bot.get_guild(guild_id)
                if guild is not None:
                    return int(getattr(guild, "member_count", 0) or 0), guild.name

                logger.warning(
                    "TARGET_GUILD_ID のサーバーが見つからないため全サーバー合計にフォールバックします。"
                )

        total = 0
        for guild in self.bot.guilds:
            total += int(getattr(guild, "member_count", 0) or 0)

        return total, None

    def _activity_type(self):
        mode = STATUS_MODE.lower()

        if mode == "custom":
            return getattr(discord.ActivityType, "custom", 4)

        return getattr(discord.ActivityType, mode, discord.ActivityType.playing)

    def _build_activity(self, text: str) -> discord.Activity:
        activity_type = self._activity_type()

        if STATUS_MODE.lower() == "custom":
            return discord.Activity(
                type=activity_type,
                name=CUSTOM_STATUS_NAME,
                state=text,
            )

        return discord.Activity(
            type=activity_type,
            name=text,
        )

    async def _update(self):
        if not self.bot.is_ready():
            return

        count, guild_name = self._resolve_count()
        guild_count = len(self.bot.guilds)

        try:
            text = TEXT_TEMPLATE.format(
                count=count,
                guild_name=guild_name or f"{guild_count}サーバー",
                guild_count=guild_count,
            )
        except Exception:
            logger.exception("TEXT_TEMPLATE の整形に失敗しました。既定の文言にフォールバックします。")
            text = f"メンバー数: {count}人"

        text = truncate_text(text)

        # 前回と同じなら何もしない
        if text == self.last_text:
            return

        try:
            activity = self._build_activity(text)
            await self.bot.change_presence(
                status=discord.Status.online,
                activity=activity,
            )
        except Exception:
            logger.exception("ステータスの更新に失敗しました")

            # カスタムステータスが拒否された場合、プレイ中にフォールバック
            if STATUS_MODE.lower() == "custom":
                try:
                    await self.bot.change_presence(
                        status=discord.Status.online,
                        activity=discord.Activity(
                            type=discord.ActivityType.playing,
                            name=text,
                        ),
                    )
                except Exception:
                    logger.exception("プレイ中へのフォールバックにも失敗しました")
                    return

                self.last_text = text
        else:
            self.last_text = text

    @tasks.loop(minutes=UPDATE_MINUTES)
    async def update_status(self):
        try:
            await self._update()
        except Exception:
            logger.exception("定期ステータス更新中にエラーが発生しました")

    @update_status.before_loop
    async def before_update_status(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_ready(self):
        # 再起動・再接続後にステータスを張り直す
        self.last_text = None
        await self._update()


async def setup(bot: commands.Bot):
    await bot.add_cog(StatusUpdater(bot))
