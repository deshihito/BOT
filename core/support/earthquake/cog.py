# -*- coding: utf-8 -*-
"""地震情報フィード: P2P地震情報のポーリングとサーバーへの投稿。

30秒ごとに P2P地震情報 API（code 551）を取得し、新しい地震の
「震度・震源に関する情報」以降の報を設定済みサーバーへ投稿する。
既読状態は store.PostedEvents に永続化し、再起動をまたいで二重投稿
しない。起動直後の初回ポーリングは既読の取り込みだけを行い（ベース
ライン）、古い地震を流さない。

接続エラー（ポーリングの常駐ループ）は単一 WARNING・トレースバック
なしで静かに継続する（定期ループのログ方針）。それ以外の例外は
通常どおり exception ログに残す。

設定は /support のアクション「地震情報」から開く管理者向けパネルで
行う（guild_settings の earthquake セクション、既定 OFF）。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime

import aiohttp
import discord
from discord.ext import commands, tasks

from core.support import guild_settings
from core.support.earthquake import badge as badge_mod
from core.support.earthquake import feed, map_render, render, store as eq_store
from core.support.messages import SETTINGS_UPDATE_FAILED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger(__name__)

#: ポーリング間隔（秒）。速報性と API への負荷のバランスで30秒。
POLL_SECONDS = 30

USER_AGENT = "AGOBOT-EarthquakeFeed/1.0 (+https://agobot.app)"

#: 設定パネルの操作権限（SNS通知などの設定系パネルと同じ管理者水準）。
ADMIN_REQUIRED = "この設定には管理者権限が必要です。"


def _can_manage(interaction: discord.Interaction) -> bool:
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(getattr(permissions, "administrator", False))


class EarthquakeSettingsView(discord.ui.View):
    """地震情報の設定パネル（開いた本人のみ操作可）。"""

    def __init__(self, cog: "EarthquakeCog", guild_id: int, *,
                 owner_id: int, settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.owner_id = owner_id
        self.settings = settings
        self._sync_controls()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.owner_id:
            return True
        await interaction.response.send_message(
            "このパネルは開いた本人だけが操作できます。",
            ephemeral=True,
        )
        return False

    def embed(self) -> discord.Embed:
        settings = self.settings
        if settings["enabled"] and settings["channel_id"]:
            state = "ON"
            target = f"<#{settings['channel_id']}>"
        elif settings["enabled"]:
            state = "ON（投稿先チャンネル未設定のため投稿されません）"
            target = "未設定"
        else:
            state = "OFF"
            target = f"<#{settings['channel_id']}>" if settings["channel_id"] else "未設定"
        description = (
            "気象庁が発表する地震情報を、このサーバーへ自動投稿します"
            "（日本国内向けの情報です）。\n"
            f"状態: **{state}**\n"
            f"投稿先: {target}\n"
            f"最低震度: **震度{feed.scale_label(settings['min_scale'])}** 以上\n\n"
            "投稿先チャンネルと最低震度を選んでから ON にしてください。"
            "緊急地震速報（EEW）は対象外です。"
        )
        return discord.Embed(
            title="地震情報の設定", description=description, color=0xFFFFFF)

    def _sync_controls(self) -> None:
        self.clear_items()
        channel_select = discord.ui.ChannelSelect(
            placeholder="投稿先チャンネル",
            channel_types=[discord.ChannelType.text],
            custom_id="earthquake:channel",
            row=0,
        )
        channel_select.callback = self._on_channel
        self.add_item(channel_select)

        options = [
            discord.SelectOption(
                label=f"震度{feed.scale_label(scale)}以上",
                value=str(scale),
                default=(scale == self.settings["min_scale"]),
            )
            for scale in feed.SCALE_CHOICES
        ]
        scale_select = discord.ui.Select(
            placeholder="最低震度",
            options=options,
            custom_id="earthquake:min_scale",
            row=1,
        )
        scale_select.callback = self._on_scale
        self.add_item(scale_select)

        toggle = discord.ui.Button(
            label="OFFにする" if self.settings["enabled"] else "ONにする",
            style=(discord.ButtonStyle.secondary if self.settings["enabled"]
                   else discord.ButtonStyle.success),
            custom_id="earthquake:toggle",
            row=2,
        )
        toggle.callback = self._on_toggle
        self.add_item(toggle)

        close = discord.ui.Button(
            label="閉じる",
            style=discord.ButtonStyle.secondary,
            custom_id="earthquake:close",
            row=2,
        )
        close.callback = self._on_close
        self.add_item(close)

    async def _save(self, interaction: discord.Interaction, **values) -> bool:
        if not _can_manage(interaction):
            await interaction.response.send_message(
                ADMIN_REQUIRED, ephemeral=True)
            return False
        try:
            await guild_settings.get_store().update(
                self.guild_id, eq_store.EARTHQUAKE_SECTION, **values)
        except Exception:
            logger.exception("地震情報の設定更新に失敗しました")
            await interaction.response.send_message(
                SETTINGS_UPDATE_FAILED, ephemeral=True)
            return False
        settings_store = guild_settings.get_store()
        self.settings = eq_store.get_earthquake_settings(
            settings_store, self.guild_id)
        self._sync_controls()
        if not interaction.response.is_done():
            await interaction.response.defer()
        await edit_panel_v2(interaction, as_panel_v2(self))
        return True

    async def _on_channel(self, interaction: discord.Interaction):
        values = interaction.data.get("values") or []
        if not values:
            return
        await self._save(interaction, channel_id=int(values[0]))

    async def _on_scale(self, interaction: discord.Interaction):
        values = interaction.data.get("values") or []
        if not values:
            return
        await self._save(interaction, min_scale=int(values[0]))

    async def _on_toggle(self, interaction: discord.Interaction):
        await self._save(interaction, enabled=not self.settings["enabled"])

    async def _on_close(self, interaction: discord.Interaction):
        self.stop()
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
            await interaction.delete_original_response()
        except discord.HTTPException:
            logger.debug("地震情報パネルを閉じる操作に失敗しました",
                         exc_info=True)


class EarthquakeCog(commands.Cog):
    """P2P地震情報をポーリングし、設定済みサーバーへ投稿する。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.posted = eq_store.PostedEvents()
        self._http: aiohttp.ClientSession | None = None
        self._baseline_done = False

    async def cog_load(self):
        self._http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=15),
            headers={"User-Agent": USER_AGENT},
        )
        self.poll_loop.start()

    async def cog_unload(self):
        self.poll_loop.cancel()
        if self._http is not None and not self._http.closed:
            await self._http.close()

    # --------------------------------------------------------------
    # ポーリング
    # --------------------------------------------------------------
    @tasks.loop(seconds=POLL_SECONDS)
    async def poll_loop(self):
        try:
            await self._poll_once()
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            # 定期ループの接続エラーは単一 WARNING で静かに継続する。
            logger.warning("地震情報の取得に失敗しました（接続エラー）: %s", exc)
        except Exception:
            logger.exception("地震情報の巡回に失敗しました")

    @poll_loop.before_loop
    async def _poll_before(self):
        await self.bot.wait_until_ready()

    @poll_loop.error
    async def _poll_error(self, error: BaseException):
        logger.error("地震情報の巡回ループが異常終了しました", exc_info=error)

    async def _fetch_events(self) -> list[feed.QuakeEvent]:
        if self._http is None:
            return []
        async with self._http.get(feed.HISTORY_URL) as response:
            response.raise_for_status()
            payload = await response.json(content_type=None)
        return feed.parse_history(payload)

    async def _poll_once(self) -> list[feed.QuakeEvent]:
        """1回分のポーリング。投稿した地震のリストを返す（テスト用）。"""
        events = await self._fetch_events()
        now = datetime.now(feed.JST)
        state = feed.prune_state(self.posted.load(), now=now)
        posts, new_state = feed.plan_posts(
            events, state, now=now, baseline=not self._baseline_done)
        self._baseline_done = True
        if new_state != state:
            self.posted.save(new_state)
        for event in posts:
            await self._deliver(event)
        return posts

    # --------------------------------------------------------------
    # 投稿
    # --------------------------------------------------------------
    async def _deliver(self, event: feed.QuakeEvent) -> None:
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        badge_png = None
        map_png = map_render.render_map_png(event)
        try:
            badge_png = await asyncio.to_thread(
                badge_mod.render_badge_png, event.max_scale)
        except Exception:
            logger.warning("震度バッジの描画に失敗しました", exc_info=True)
        view = render.build_post_view(
            event, badge_png=badge_png, map_png=map_png)
        for guild in list(self.bot.guilds):
            settings = eq_store.get_earthquake_settings(
                settings_store, guild.id)
            if not settings["enabled"] or not settings["channel_id"]:
                continue
            if event.max_scale < settings["min_scale"]:
                continue
            channel = guild.get_channel(settings["channel_id"])
            if not isinstance(channel, discord.TextChannel):
                continue
            me = guild.me
            if me is None:
                continue
            perms = channel.permissions_for(me)
            if not (perms.view_channel and perms.send_messages):
                logger.warning(
                    "地震情報の送信先に投稿できません (guild=%s channel=%s)",
                    guild.id, channel.id)
                continue
            files = []
            send_view = view
            if badge_png is not None and perms.attach_files:
                files.append(discord.File(
                    io.BytesIO(badge_png), filename=badge_mod.BADGE_FILENAME))
            if map_png is not None and perms.attach_files:
                files.append(discord.File(
                    io.BytesIO(map_png), filename=map_render.MAP_FILENAME))
            if not files:
                # 添付できない場合はバッジ参照のない文面だけ送る。
                send_view = render.build_post_view(event)
            try:
                await channel.send(
                    view=send_view,
                    files=files,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            except (discord.Forbidden, discord.HTTPException) as exc:
                logger.warning(
                    "地震情報の送信に失敗 (guild=%s channel=%s): %s",
                    guild.id, channel.id, exc)

    # --------------------------------------------------------------
    # 設定パネル入口（/support のアクション「地震情報」）
    # --------------------------------------------------------------
    async def show_earthquake_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )
        if not _can_manage(interaction):
            return await interaction.response.send_message(
                ADMIN_REQUIRED, ephemeral=True)
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        view = EarthquakeSettingsView(
            self,
            interaction.guild_id,
            owner_id=interaction.user.id,
            settings=eq_store.get_earthquake_settings(
                settings_store, interaction.guild_id),
        )
        await interaction.response.send_message(
            view=as_panel_v2(view),
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(EarthquakeCog(bot))
