# -*- coding: utf-8 -*-
"""サーバー分析: 日次メタ集計の収集リスナと表示パネル。

収集は guild_settings のトグル（server_analytics セクション、既定 OFF）が
ON のギルドだけ。数えるのは件数・時間帯・絵文字の種別といったメタ情報
のみで、メッセージ本文は保存しない（絵文字は種別だけその場で数える）。

表示は /support のアクション「サーバー分析」から開く。Overview（活動量
の要約）と Heatmap（曜日×24時間）をボタンで切り替える。権限は一般
メンバー閲覧可で、収集トグルの変更だけサーバー管理権限を要求する。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime, timezone

import discord
from discord.ext import commands

from core.general import user_names
from core.general.user_names import resolve_display_names
from core.support import guild_settings
from core.support.messages import MANAGE_GUILD_REQUIRED, SETTINGS_UPDATE_FAILED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.person_analysis.cog import message_targets
from core.support.server_analytics import metrics, render
from core.support.server_analytics import store as sa_store

logger = logging.getLogger(__name__)

OVERVIEW_FILENAME = "server_analytics_overview.png"
HEATMAP_FILENAME = "server_analytics_heatmap.png"

MODE_OVERVIEW = "overview"
MODE_HEATMAP = "heatmap"


def _can_manage(interaction: discord.Interaction) -> bool:
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


def _started_date(started_at: str) -> str:
    try:
        return datetime.fromisoformat(started_at).date().isoformat()
    except Exception:
        return started_at or "不明"


class ServerAnalyticsView(discord.ui.View):
    """サーバー分析パネル（開いた本人のみ操作可・Components V2 で表示）。"""

    def __init__(self, cog: "ServerAnalyticsCog", guild_id: int, *,
                 owner_id: int, enabled: bool, is_admin: bool):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.owner_id = owner_id
        self.enabled = enabled
        self.is_admin = is_admin
        self.mode = MODE_OVERVIEW
        self._png: bytes | None = None
        self._started_at = ""
        self._recorded_days = 0
        self._sync_controls()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.owner_id:
            return True
        await interaction.response.send_message(
            "このパネルは開いた本人だけが操作できます。",
            ephemeral=True,
        )
        return False

    # --------------------------------------------------------------
    # データ準備
    # --------------------------------------------------------------
    async def prepare(self) -> None:
        self._png = None
        if not self.enabled:
            self._sync_controls()
            return
        snapshot = self.cog.store.guild_snapshot(self.guild_id)
        self._started_at = snapshot["started_at"]
        today = datetime.now(sa_store.JST).date()
        overview = metrics.build_overview(
            snapshot, end=today, days=sa_store.WINDOW_DAYS)
        self._recorded_days = overview.recorded_days
        guild = self.cog.bot.get_guild(self.guild_id) \
            if self.cog.bot is not None else None
        server_name = getattr(guild, "name", "") or "サーバー"
        member_count = getattr(guild, "member_count", None)
        if self.mode == MODE_HEATMAP:
            matrix = metrics.build_heatmap(
                snapshot, end=today, days=sa_store.WINDOW_DAYS)
            data = render.HeatmapImage(
                server_name=server_name,
                started_at=self._started_at,
                period_start=f"{overview.start.month}/{overview.start.day}",
                period_end=f"{overview.end.month}/{overview.end.day}",
                matrix=matrix,
            )
            self._png = await asyncio.to_thread(render.render_heatmap_png, data)
        else:
            name_ids = list({
                *(uid for uid, _c in overview.top_users),
                *(uid for uid, _c in overview.top_reacted),
                *(uid for uid, _c in overview.top_mentioned),
            })
            names = await resolve_display_names(self.cog.bot, name_ids)
            data = render.OverviewImage(
                server_name=server_name,
                member_count=member_count,
                started_at=self._started_at,
                overview=overview,
                top_user_names=names,
                top_reacted_names=names,
                top_mentioned_names=names,
            )
            self._png = await asyncio.to_thread(render.render_overview_png, data)
        self._sync_controls()

    # --------------------------------------------------------------
    # 表示
    # --------------------------------------------------------------
    def embed(self) -> discord.Embed:
        if not self.enabled:
            description = (
                "このサーバーでは活動データの収集が **OFF** です。\n"
                "サーバー管理者が収集を ON にすると、その時点から発言数・"
                "VC 時間・絵文字の使用数などの記録が始まります"
                "（過去の活動は記録されません。本文は保存しません）。"
            )
            if not self.is_admin:
                description += "\n収集の ON / OFF はサーバー管理者が変更できます。"
            return discord.Embed(
                title="サーバー分析", description=description, color=0xFFFFFF)
        lines = []
        if self._started_at:
            lines.append(f"収集開始: {_started_date(self._started_at)}")
        if self._recorded_days == 0:
            lines.append("データはまだありません。"
                         "収集 ON 以降の活動から記録されます。")
        embed = discord.Embed(
            title="サーバー分析",
            description="\n".join(lines) or None,
            color=0xFFFFFF,
        )
        if self._png is not None:
            filename = (HEATMAP_FILENAME if self.mode == MODE_HEATMAP
                        else OVERVIEW_FILENAME)
            embed.set_image(url=f"attachment://{filename}")
        return embed

    def panel_file(self) -> discord.File | None:
        if self._png is None:
            return None
        filename = (HEATMAP_FILENAME if self.mode == MODE_HEATMAP
                    else OVERVIEW_FILENAME)
        return discord.File(io.BytesIO(self._png), filename=filename)

    def _sync_controls(self) -> None:
        self.clear_items()
        row = 0
        if self.enabled:
            overview_button = discord.ui.Button(
                label="Overview",
                style=(discord.ButtonStyle.primary
                       if self.mode == MODE_OVERVIEW
                       else discord.ButtonStyle.secondary),
                custom_id="server_analytics:overview",
                row=0,
            )
            overview_button.callback = self._on_overview
            self.add_item(overview_button)
            heatmap_button = discord.ui.Button(
                label="Heatmap",
                style=(discord.ButtonStyle.primary
                       if self.mode == MODE_HEATMAP
                       else discord.ButtonStyle.secondary),
                custom_id="server_analytics:heatmap",
                row=0,
            )
            heatmap_button.callback = self._on_heatmap
            self.add_item(heatmap_button)
            row = 1
        if self.is_admin:
            toggle = discord.ui.Button(
                label="収集をOFFにする" if self.enabled else "収集をONにする",
                style=(discord.ButtonStyle.secondary if self.enabled
                       else discord.ButtonStyle.success),
                custom_id="server_analytics:toggle",
                row=row,
            )
            toggle.callback = self._on_toggle
            self.add_item(toggle)
        close = discord.ui.Button(
            label="閉じる",
            style=discord.ButtonStyle.secondary,
            custom_id="server_analytics:close",
            row=row,
        )
        close.callback = self._on_close
        self.add_item(close)

    # --------------------------------------------------------------
    # 操作
    # --------------------------------------------------------------
    async def _edit(self, interaction: discord.Interaction) -> None:
        await self.prepare()
        file = self.panel_file()
        await edit_panel_v2(interaction, as_panel_v2(self),
                            files=[file] if file is not None else None)

    async def _on_overview(self, interaction: discord.Interaction):
        self.mode = MODE_OVERVIEW
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._edit(interaction)

    async def _on_heatmap(self, interaction: discord.Interaction):
        self.mode = MODE_HEATMAP
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._edit(interaction)

    async def _on_toggle(self, interaction: discord.Interaction):
        if not _can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        new_value = not self.enabled
        try:
            await guild_settings.get_store().update(
                self.guild_id, sa_store.SERVER_ANALYTICS_SECTION,
                enabled=new_value)
        except Exception:
            logger.exception("サーバー分析の収集トグル更新に失敗しました")
            return await interaction.response.send_message(
                SETTINGS_UPDATE_FAILED, ephemeral=True)
        self.enabled = new_value
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._edit(interaction)

    async def _on_close(self, interaction: discord.Interaction):
        self.stop()
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
            await interaction.delete_original_response()
        except discord.HTTPException:
            logger.debug("サーバー分析パネルを閉じる操作に失敗しました",
                         exc_info=True)


class ServerAnalyticsCog(commands.Cog):
    """日次メタ集計の収集リスナと、/support「サーバー分析」の表示入口。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.store = sa_store.get_store()
        #: (guild_id, user_id) → VC 参加時刻（メモリのみ・再起動で消える）
        self._vc_since: dict[tuple[int, int], datetime] = {}

    def cog_unload(self):
        sa_store.flush_safely()

    async def _enabled(self, guild_id: int) -> bool:
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        return sa_store.server_analytics_enabled(settings_store, guild_id)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        guild = message.guild
        if guild is None or message.webhook_id is not None:
            return
        if getattr(message.author, "bot", False):
            return
        if message.type not in (discord.MessageType.default,
                                discord.MessageType.reply):
            return
        try:
            if not await self._enabled(guild.id):
                return
            mentioned = message_targets(message)
            emoji_keys = sa_store.extract_emojis(
                getattr(message, "content", ""))
            self.store.record_message(
                guild.id, message.author.id, mentioned, emoji_keys,
                now=message.created_at)
        except Exception:
            logger.debug("サーバー分析の記録に失敗しました", exc_info=True)

    @commands.Cog.listener()
    async def on_reaction_add(self, reaction: discord.Reaction,
                              user: discord.abc.User):
        message = getattr(reaction, "message", None)
        guild = getattr(message, "guild", None)
        if guild is None:
            return
        if getattr(user, "bot", False):
            return
        author = getattr(message, "author", None)
        if author is None or getattr(author, "bot", False):
            return
        if author.id == getattr(user, "id", None):
            return
        try:
            if not await self._enabled(guild.id):
                return
            self.store.record_reaction(guild.id, author.id)
        except Exception:
            logger.debug("サーバー分析のリアクション記録に失敗しました",
                         exc_info=True)

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if getattr(member, "bot", False):
            return
        guild = getattr(member, "guild", None)
        if guild is None:
            return
        try:
            if not await self._enabled(guild.id):
                return
            self.store.record_member_join(guild.id)
        except Exception:
            logger.debug("サーバー分析の参加記録に失敗しました", exc_info=True)

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member,
                                    before: discord.VoiceState,
                                    after: discord.VoiceState):
        if getattr(member, "bot", False):
            return
        guild = getattr(member, "guild", None)
        if guild is None:
            return
        key = (guild.id, member.id)
        before_channel = getattr(before, "channel", None)
        after_channel = getattr(after, "channel", None)
        if before_channel is None and after_channel is not None:
            self._vc_since[key] = datetime.now(timezone.utc)
            return
        if before_channel is not None and after_channel is None:
            started = self._vc_since.pop(key, None)
            if started is None:
                return
            seconds = int(
                (datetime.now(timezone.utc) - started).total_seconds())
            if seconds <= 0:
                return
            try:
                if not await self._enabled(guild.id):
                    return
                self.store.record_vc_seconds(guild.id, member.id, seconds)
            except Exception:
                logger.debug("サーバー分析の VC 記録に失敗しました",
                             exc_info=True)
        # チャンネル移動（同じギルド内）は滞在継続として数える。

    async def show_server_analytics(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        view = ServerAnalyticsView(
            self,
            interaction.guild_id,
            owner_id=interaction.user.id,
            enabled=sa_store.server_analytics_enabled(
                settings_store, interaction.guild_id),
            is_admin=_can_manage(interaction),
        )
        await view.prepare()
        file = view.panel_file()
        await interaction.response.send_message(
            view=as_panel_v2(view),
            files=[file] if file is not None else [],
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(ServerAnalyticsCog(bot))
