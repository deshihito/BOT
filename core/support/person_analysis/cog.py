# -*- coding: utf-8 -*-
"""人物分析: 交流グラフの収集リスナと表示パネル。

収集は guild_settings のトグル（person_analysis セクション、既定 OFF）が
ON のギルドだけ。on_message では本文を見ず、返信先とメンション先の
関係だけを store に数える（本文・チャンネル名は保存しない）。

表示は /support のアクション「人物分析」から開く。権限は一般メンバー
閲覧可で、収集トグルの変更だけサーバー管理権限を要求する。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime

import discord
from discord.ext import commands

from core.general import user_names
from core.general.user_names import resolve_display_names
from core.leaderboard_image import fetch_avatar_bytes
from core.support import guild_settings
from core.support.messages import MANAGE_GUILD_REQUIRED, SETTINGS_UPDATE_FAILED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.person_analysis import metrics, render
from core.support.person_analysis import store as pa_store

logger = logging.getLogger(__name__)

CARD_FILENAME = "person_analysis.png"


def message_targets(message) -> list[int]:
    """メッセージから「絡み」の相手 ID を重複なく取り出す（本文は見ない）。

    - 返信先の著者（message.reference の解決先）
    - メンションされた各ユーザー（返信先と重なる場合は二重に数えない）
    除外: 自分自身、Bot アカウント。
    """
    author_id = getattr(getattr(message, "author", None), "id", None)
    targets: list[int] = []

    reference = getattr(message, "reference", None)
    resolved = getattr(reference, "resolved", None) if reference else None
    reply_author = getattr(resolved, "author", None)
    if reply_author is not None and not getattr(reply_author, "bot", False):
        reply_id = getattr(reply_author, "id", None)
        if reply_id is not None and reply_id != author_id:
            targets.append(reply_id)

    for user in getattr(message, "mentions", None) or []:
        if getattr(user, "bot", False):
            continue
        user_id = getattr(user, "id", None)
        if user_id is None or user_id == author_id or user_id in targets:
            continue
        targets.append(user_id)
    return targets


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


class _CenterUserSelect(discord.ui.UserSelect):
    def __init__(self, panel: "PersonAnalysisView"):
        super().__init__(
            placeholder="分析するメンバーを選択",
            custom_id="person_analysis:user",
            row=0,
        )
        self.panel = panel

    async def callback(self, interaction: discord.Interaction):
        if not self.values:
            return
        await self.panel.change_center(interaction, self.values[0].id)


class _PartnerSelect(discord.ui.Select):
    def __init__(self, panel: "PersonAnalysisView",
                 partners: list[tuple[str, int, int, int]]):
        super().__init__(
            placeholder="よく絡む相手を選択",
            custom_id="person_analysis:partner",
            row=1,
            options=[
                discord.SelectOption(
                    label=name[:100],
                    value=str(user_id),
                    description=f"→{sent} 送った／←{received} 受けた",
                    default=user_id == panel.selected_partner_id,
                )
                for name, user_id, sent, received in partners
            ],
        )
        self.panel = panel

    async def callback(self, interaction: discord.Interaction):
        if not self.values:
            return
        await self.panel.select_partner(interaction, int(self.values[0]))


class PersonAnalysisView(discord.ui.View):
    """人物分析パネル（開いた本人のみ操作可・Components V2 で表示）。"""

    def __init__(self, cog: "PersonAnalysisCog", guild_id: int, *,
                 owner_id: int, center_id: int, enabled: bool,
                 is_admin: bool):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.owner_id = owner_id
        self.center_id = center_id
        self.enabled = enabled
        self.is_admin = is_admin
        self.selected_partner_id: int | None = None
        self._png: bytes | None = None
        self._center_name = ""
        self._partner_options: list[tuple[str, int, int, int]] = []
        self._has_center_data = False
        self._started_at = ""
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
        """スナップショット→指標計算→名前解決→画像生成までを済ませる。"""
        self._png = None
        self._partner_options = []
        self._has_center_data = False
        if not self.enabled:
            self._sync_controls()
            return
        snapshot = self.cog.store.guild_snapshot(self.guild_id)
        self._started_at = snapshot["started_at"]
        edges = snapshot["edges"]
        hours = snapshot["hours"].get(self.center_id, [0] * 24)
        result, peaks = await asyncio.to_thread(
            self._compute, edges, hours, self.center_id)
        self._has_center_data = bool(
            result.sent or result.received or any(hours))
        display_name, username = await self._resolve_center()
        self._center_name = display_name
        partner_ids = [uid for uid, _s, _r in result.partners]
        names = await resolve_display_names(self.cog.bot, partner_ids)
        avatar_ids = [self.center_id, *partner_ids]
        avatars = await fetch_avatar_bytes(self.cog.bot, avatar_ids)
        card = render.PersonCard(
            name=display_name,
            username=username,
            user_id=self.center_id,
            cluster_label=result.cluster_label,
            cluster_size=result.cluster_size,
            received=result.received,
            sent=result.sent,
            pagerank=result.pagerank,
            betweenness=result.betweenness,
            hours=hours,
            peaks=peaks,
            partners=[
                render.PartnerRow(
                    name=names.get(uid, user_names.fallback_name(uid)),
                    user_id=uid, sent=sent, received=received)
                for uid, sent, received in result.partners
            ],
        )
        self._partner_options = [
            (partner.name, partner.user_id, partner.sent, partner.received)
            for partner in card.partners
        ]
        self._png = await asyncio.to_thread(
            render.render_person_card_png, card, avatars)
        self._sync_controls()

    @staticmethod
    def _compute(edges, hours, center_id):
        result = metrics.analyze(edges, center_id)
        return result, metrics.peak_hours(hours)

    async def _resolve_center(self) -> tuple[str, str]:
        bot = self.cog.bot
        guild = bot.get_guild(self.guild_id) if bot is not None else None
        member = guild.get_member(self.center_id) if guild is not None else None
        user_obj = member
        if user_obj is None and bot is not None:
            user_obj = bot.get_user(self.center_id)
        if user_obj is None and bot is not None and hasattr(bot, "fetch_user"):
            try:
                user_obj = await bot.fetch_user(self.center_id)
            except Exception:
                user_obj = None
        if member is not None:
            display = member.display_name
        elif user_obj is not None:
            display = user_obj.display_name
        else:
            display = user_names.fallback_name(self.center_id)
        username = getattr(user_obj, "name", "") or ""
        return display, username

    # --------------------------------------------------------------
    # 表示
    # --------------------------------------------------------------
    def embed(self) -> discord.Embed:
        if not self.enabled:
            description = (
                "このサーバーでは交流データの収集が **OFF** です。\n"
                "サーバー管理者が収集を ON にすると、その時点から返信・"
                "メンションの関係と発言時間帯の記録が始まります"
                "（過去の発言は記録されません。本文は保存しません）。"
            )
            if not self.is_admin:
                description += "\n収集の ON / OFF はサーバー管理者が変更できます。"
            embed = discord.Embed(
                title="人物分析",
                description=description,
                color=0xFFFFFF,
            )
            return embed
        lines = []
        if self._started_at:
            lines.append(f"収集開始: {_started_date(self._started_at)}")
        if not self._has_center_data:
            lines.append("この人のデータはまだありません。"
                         "収集 ON 以降の発言から記録されます。")
        embed = discord.Embed(
            title="人物分析",
            description="\n".join(lines) or None,
            color=0xFFFFFF,
        )
        if self._png is not None:
            embed.set_image(url=f"attachment://{CARD_FILENAME}")
        return embed

    def panel_file(self) -> discord.File | None:
        if self._png is None:
            return None
        return discord.File(io.BytesIO(self._png), filename=CARD_FILENAME)

    def _sync_controls(self) -> None:
        self.clear_items()
        if self.enabled:
            self.add_item(_CenterUserSelect(self))
            if self._partner_options:
                self.add_item(_PartnerSelect(self, self._partner_options))
            center_button = discord.ui.Button(
                label="この人を中心に",
                style=discord.ButtonStyle.primary,
                custom_id="person_analysis:center",
                row=2,
                disabled=self.selected_partner_id is None,
            )
            center_button.callback = self._on_center_button
            self.add_item(center_button)
        if self.is_admin:
            toggle = discord.ui.Button(
                label="収集をOFFにする" if self.enabled else "収集をONにする",
                style=(discord.ButtonStyle.secondary if self.enabled
                       else discord.ButtonStyle.success),
                custom_id="person_analysis:toggle",
                row=2 if self.enabled else 0,
            )
            toggle.callback = self._on_toggle
            self.add_item(toggle)
        close = discord.ui.Button(
            label="閉じる",
            style=discord.ButtonStyle.secondary,
            custom_id="person_analysis:close",
            row=2 if self.enabled else 0,
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

    async def change_center(self, interaction: discord.Interaction,
                            user_id: int) -> None:
        self.center_id = user_id
        self.selected_partner_id = None
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._edit(interaction)

    async def select_partner(self, interaction: discord.Interaction,
                             user_id: int) -> None:
        self.selected_partner_id = user_id
        self._sync_controls()
        file = self.panel_file()
        await edit_panel_v2(interaction, as_panel_v2(self),
                            files=[file] if file is not None else None)

    async def _on_center_button(self, interaction: discord.Interaction):
        if self.selected_partner_id is None:
            return await interaction.response.send_message(
                "先によく絡む相手を選択してください。", ephemeral=True)
        await self.change_center(interaction, self.selected_partner_id)

    async def _on_toggle(self, interaction: discord.Interaction):
        if not _can_manage(interaction):
            return await interaction.response.send_message(
                MANAGE_GUILD_REQUIRED, ephemeral=True)
        new_value = not self.enabled
        try:
            await guild_settings.get_store().update(
                self.guild_id, pa_store.PERSON_ANALYSIS_SECTION,
                enabled=new_value)
        except Exception:
            logger.exception("人物分析の収集トグル更新に失敗しました")
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
            logger.debug("人物分析パネルを閉じる操作に失敗しました",
                         exc_info=True)


class PersonAnalysisCog(commands.Cog):
    """交流グラフの収集リスナと、/support「人物分析」の表示入口。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.store = pa_store.get_store()

    def cog_unload(self):
        pa_store.flush_safely()

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
            settings_store = guild_settings.get_store()
            await settings_store.ensure_loaded()
            if not pa_store.person_analysis_enabled(settings_store, guild.id):
                return
            targets = message_targets(message)
            hour = message.created_at.astimezone(pa_store.JST).hour
            self.store.record(guild.id, message.author.id, targets, hour)
        except Exception:
            logger.debug("人物分析の記録に失敗しました", exc_info=True)

    async def show_person_analysis(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        view = PersonAnalysisView(
            self,
            interaction.guild_id,
            owner_id=interaction.user.id,
            center_id=interaction.user.id,
            enabled=pa_store.person_analysis_enabled(
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
    await bot.add_cog(PersonAnalysisCog(bot))
