"""core/status_updater.py

Botのステータス（プレイ中 / カスタムステータスなど）を定期更新する。
例:
- プレイ中: メンバー数: 123人
- カスタムステータス: メンバー数: 123人

読み込み方（main側）:
    await bot.load_extension("core.status_updater")
"""

from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands, tasks

# "discord." 配下の子ロガーにしておくと、bot.run() が設定する discord.py 標準のログ出力に
# そのまま乗るので、INFO ログも WARNING/ERROR も確実にコンソールへ出る。
logger = logging.getLogger("discord.status_updater")


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
# {guild_name}  -> 1サーバー指定時のサーバー名（total時は「N サーバー」になる）
# {guild_count} -> Botの参加サーバー数
TEXT_TEMPLATE = "メンバー数: {count}人"

# ======================================================


# 最低でも5分開ける
UPDATE_MINUTES = max(5.0, float(UPDATE_MINUTES))

_ACTIVITY_TYPES = {
    "playing": discord.ActivityType.playing,
    "watching": discord.ActivityType.watching,
    "listening": discord.ActivityType.listening,
    "competing": discord.ActivityType.competing,
}


def truncate_text(text: str, limit: int = 128) -> str:
    """DiscordのActivity名/ステータス用に長さを制限する。"""
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


class StatusUpdater(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.last_text: str | None = None
        self._lock = asyncio.Lock()

    # --------------------------------------------------
    # ライフサイクル
    # --------------------------------------------------

    async def cog_load(self):
        # ループは cog_load で開始する（__init__ で start しない）。
        # 初回は before_loop で Bot の準備完了を待ってから実行される。
        self.update_status.start()
        logger.info(
            "StatusUpdater を読み込みました (mode=%s, source=%s, interval=%s分)",
            STATUS_MODE,
            STATUS_SOURCE,
            UPDATE_MINUTES,
        )

    async def cog_unload(self):
        self.update_status.cancel()

    # --------------------------------------------------
    # 集計
    # --------------------------------------------------

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
                    return int(guild.member_count or 0), guild.name

                logger.warning(
                    "TARGET_GUILD_ID のサーバーが見つからないため全サーバー合計にフォールバックします。"
                )

        total = 0
        for guild in self.bot.guilds:
            total += int(guild.member_count or 0)

        return total, None

    # --------------------------------------------------
    # Activity 生成
    # --------------------------------------------------

    def _build_activity(self, text: str) -> discord.BaseActivity:
        mode = STATUS_MODE.lower()

        if mode == "custom":
            # カスタムステータスは Activity(type=custom) ではなく CustomActivity を使う
            return discord.CustomActivity(name=text)

        activity_type = _ACTIVITY_TYPES.get(mode)
        if activity_type is None:
            logger.warning("STATUS_MODE=%r は未対応のため playing にします。", STATUS_MODE)
            activity_type = discord.ActivityType.playing

        return discord.Activity(type=activity_type, name=text)

    # --------------------------------------------------
    # 更新本体
    # --------------------------------------------------

    async def _update(self, *, force: bool = False) -> None:
        """
        ステータスを更新する。

        force=False のときだけ「前回と同じ文言ならスキップ」する。
        定期ループと on_ready は force=True で呼ぶ。
        （他の処理が presence を上書きしても、次回の定期更新で必ず張り直せるようにするため）
        """
        if not self.bot.is_ready():
            return

        async with self._lock:
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

            if not force and text == self.last_text:
                return

            try:
                await self.bot.change_presence(
                    status=discord.Status.online,
                    activity=self._build_activity(text),
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
                    logger.info("ステータスを更新しました(playingにフォールバック): %s", text)
                return

            self.last_text = text
            logger.info("ステータスを更新しました: %s", text)

    # --------------------------------------------------
    # 定期ループ / イベント
    # --------------------------------------------------

    @tasks.loop(minutes=UPDATE_MINUTES)
    async def update_status(self):
        try:
            await self._update(force=True)
        except Exception:
            # tasks.loop は例外で止まってしまうので、ここで必ず握りつぶす
            logger.exception("定期ステータス更新中にエラーが発生しました")

    @update_status.before_loop
    async def before_update_status(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_ready(self):
        # 再起動・再接続後にステータスを張り直す
        self.last_text = None
        await self._update(force=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(StatusUpdater(bot))