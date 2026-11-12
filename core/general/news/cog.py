# -*- coding: utf-8 -*-
"""ニュース通知の Cog：NHK RSS の新着記事をサーバー設定のチャンネルへ投稿。

- 取得元は NHK の公開 RSS（API キー不要）。カテゴリは主要・社会・
  科学文化・政治・経済・国際・スポーツ・エンタメの8つから選べる。
- 設定は guild_settings の news セクション（既定 OFF）。/news コマンドの
  パネル（サーバー管理権限が必要）で投稿先とカテゴリを決める。
- 5分ごとのループでフィードを確認し、未投稿の記事だけをまとめて
  1メッセージで投稿する。初回は既存記事を遡って投稿せず、取り込み
  だけ行う（有効化した瞬間に大量投稿しないため）。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands, tasks

import config
from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

from . import feeds as feeds_mod
from .feeds import FEEDS, NewsItem

logger = logging.getLogger("cogs.news")

POLL_MINUTES = 5
MAX_POSTS_PER_POLL = 5  # 1回のチェックで投稿する新着の上限（古い順）


def format_post(items: list[NewsItem], feed_keys: list[str]) -> str:
    """新着記事を1メッセージ分のテキストに整形する。"""
    labels = "・".join(FEEDS[key][0] for key in feed_keys if key in FEEDS)
    lines = [f"📰 **NHKニュース（{labels}）**"]
    for item in items:
        title = item.title.replace("[", "［").replace("]", "］")
        when = ""
        if item.published is not None:
            when = f"（{item.published.astimezone(config.JST):%H:%M}）"
        lines.append(f"・[{title}]({item.link}){when}")
    return "\n".join(lines)


class NewsCog(commands.Cog):
    def __init__(self, bot: commands.Bot, fetcher=None):
        self.bot = bot
        # fetcher: async (session, feed_key) -> list[NewsItem]（テスト差し替え用）
        self._fetcher = fetcher or feeds_mod.fetch_feed

    async def cog_load(self) -> None:
        if not self.poll_loop.is_running():
            self.poll_loop.start()

    async def cog_unload(self) -> None:
        if self.poll_loop.is_running():
            self.poll_loop.cancel()

    # --------------------------------------------------------------
    # 定期チェック
    # --------------------------------------------------------------
    @tasks.loop(minutes=POLL_MINUTES)
    async def poll_loop(self) -> None:
        try:
            await self.poll_once()
        except Exception:
            logger.exception("news: 定期チェックに失敗しました")

    @poll_loop.before_loop
    async def _before_poll_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def poll_once(self) -> int:
        """有効なサーバーへ新着を投稿し、投稿したサーバー数を返す。"""
        store = guild_settings.get_store()
        await store.ensure_loaded()
        targets: list[tuple[int, dict]] = []
        for guild_id_text in store.all_sections(guild_settings.NEWS_SECTION):
            try:
                guild_id = int(guild_id_text)
            except (TypeError, ValueError):
                continue
            settings = guild_settings.news_settings(guild_id)
            if not settings["enabled"] or not settings["channel_id"]:
                continue
            if not [key for key in settings["feeds"] if key in FEEDS]:
                continue
            targets.append((guild_id, settings))
        if not targets:
            return 0

        # フィード取得はサーバー間で共有する（同じカテゴリは1回だけ取る）。
        wanted = {key for _gid, s in targets for key in s["feeds"] if key in FEEDS}
        fetched: dict[str, list[NewsItem]] = {}
        async with aiohttp.ClientSession() as session:
            results = await asyncio.gather(
                *(self._fetcher(session, key) for key in sorted(wanted)),
                return_exceptions=True)
        for key, result in zip(sorted(wanted), results):
            if isinstance(result, Exception):
                logger.warning("news: フィード取得に失敗 feed=%s", key,
                               exc_info=result)
                continue
            fetched[key] = result

        posted = 0
        for guild_id, settings in targets:
            items: list[NewsItem] = []
            for key in settings["feeds"]:
                items.extend(fetched.get(key, []))
            if not items:
                continue  # 全フィード取得失敗なら状態を触らず次回に回す
            items.sort(
                key=lambda i: i.published or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True)
            fresh, seeded = feeds_mod.select_new(
                items, settings["seen"], MAX_POSTS_PER_POLL)
            # 投稿の成否に関わらず見た記事は記録し、失敗したサーバーが
            # 5分ごとに同じ新着を送り続けないようにする（天気の定時投稿と
            # 同じ割り切り）。
            seen = list(settings["seen"])
            for item in items:
                if item.link not in seen:
                    seen.append(item.link)
            await store.update(guild_id, guild_settings.NEWS_SECTION,
                               seen=seen[-guild_settings.NEWS_SEEN_LIMIT:])
            if seeded or not fresh:
                continue
            channel = self.bot.get_channel(settings["channel_id"])
            if channel is None:
                try:
                    channel = await self.bot.fetch_channel(settings["channel_id"])
                except Exception:
                    channel = None
            if channel is None:
                logger.warning("news: 投稿先が見つかりません guild=%s channel=%s",
                               guild_id, settings["channel_id"])
                continue
            try:
                await channel.send(format_post(fresh, settings["feeds"]))
                posted += 1
            except Exception:
                logger.exception("news: 投稿に失敗 guild=%s channel=%s",
                                 guild_id, settings["channel_id"])
        return posted

    # --------------------------------------------------------------
    # /news 設定パネル
    # --------------------------------------------------------------
    @app_commands.command(
        name="news", description="ニュース通知の設定（NHKニュースの新着を自動投稿）")
    async def news(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "サーバー内でのみ使えます。", ephemeral=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = guild_settings.news_settings(interaction.guild_id)
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (permissions and permissions.manage_guild):
            state = "ON" if settings["enabled"] else "OFF"
            channel = (f"<#{settings['channel_id']}>"
                       if settings["channel_id"] else "未設定")
            labels = "・".join(FEEDS[key][0] for key in settings["feeds"]
                               if key in FEEDS) or "未設定"
            return await interaction.response.send_message(
                f"ニュース通知は現在 **{state}** です（投稿先: {channel} / "
                f"カテゴリ: {labels}）。\n"
                "設定の変更にはサーバー管理権限が必要です。",
                ephemeral=True)
        view = NewsSettingsView(self, interaction.user.id,
                                interaction.guild_id, settings)
        await interaction.response.send_message(view=as_panel_v2(view))


class NewsSettingsView(discord.ui.View):
    """ニュース通知の投稿先・カテゴリの編集ビュー（サーバー管理者のみ）。"""

    def __init__(self, cog: NewsCog, owner_id: int, guild_id: int, settings: dict):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner_id = owner_id
        self.guild_id = guild_id
        self.enabled = bool(settings.get("enabled"))
        self.channel_id = settings.get("channel_id")
        self.feeds = [key for key in settings.get("feeds", []) if key in FEEDS] \
            or ["top"]
        self.notice: str | None = None
        self._sync_controls()

    async def interaction_check(self, interaction) -> bool:
        return interaction.user.id == self.owner_id

    def embed(self) -> discord.Embed:
        lines = []
        if self.notice:
            lines.append(self.notice)
        state = "ON" if self.enabled else "OFF"
        channel = f"<#{self.channel_id}>" if self.channel_id else "未設定"
        labels = "・".join(FEEDS[key][0] for key in self.feeds)
        lines.append(f"現在の設定: **{state}** / 投稿先: {channel} / カテゴリ: {labels}")
        lines.append(
            "保存すると、NHKニュースの新着記事が数分おきにまとめて投稿されます。"
            "有効にした直後は既存の記事を遡って投稿せず、新着分から届きます。")
        return discord.Embed(title="ニュース通知の設定",
                             description="\n".join(lines), color=0xFFFFFF)

    def _sync_controls(self) -> None:
        self.clear_items()
        self.add_item(_NewsChannelSelect(self))
        self.add_item(_NewsFeedSelect(self))
        save = discord.ui.Button(
            label="保存してONにする", style=discord.ButtonStyle.primary,
            custom_id="news:save", row=2)
        save.callback = self._on_save
        self.add_item(save)
        off = discord.ui.Button(
            label="通知をOFFにする", style=discord.ButtonStyle.secondary,
            custom_id="news:off", row=2)
        off.callback = self._on_off
        self.add_item(off)

    async def _edit(self, interaction: discord.Interaction) -> None:
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def _on_save(self, interaction: discord.Interaction) -> None:
        if not self.channel_id:
            self.notice = "投稿先チャンネルを選んでください。"
            self._sync_controls()
            return await self._edit(interaction)
        store = guild_settings.get_store()
        await store.update(self.guild_id, guild_settings.NEWS_SECTION,
                           enabled=True, channel_id=self.channel_id,
                           feeds=list(self.feeds))
        self.enabled = True
        self.notice = "ニュース通知を保存しました。新着記事から届きます。"
        self._sync_controls()
        await self._edit(interaction)

    async def _on_off(self, interaction: discord.Interaction) -> None:
        store = guild_settings.get_store()
        await store.update(self.guild_id, guild_settings.NEWS_SECTION,
                           enabled=False)
        self.enabled = False
        self.notice = "ニュース通知をOFFにしました。"
        self._sync_controls()
        await self._edit(interaction)


class _NewsChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, view: NewsSettingsView):
        self.panel = view
        super().__init__(
            placeholder="投稿先チャンネル",
            channel_types=[discord.ChannelType.text],
            custom_id="news:channel", row=0)

    async def callback(self, interaction: discord.Interaction):
        self.panel.channel_id = self.values[0].id
        self.panel.notice = None
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


class _NewsFeedSelect(discord.ui.Select):
    def __init__(self, view: NewsSettingsView):
        self.panel = view
        options = [
            discord.SelectOption(label=label, value=key,
                                 default=key in view.feeds)
            for key, (label, _url) in FEEDS.items()
        ]
        super().__init__(placeholder="購読するカテゴリ（複数選択可）",
                         options=options, min_values=1,
                         max_values=len(options),
                         custom_id="news:feeds", row=1)

    async def callback(self, interaction: discord.Interaction):
        self.panel.feeds = list(self.values)
        self.panel.notice = None
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


async def setup(bot: commands.Bot):
    await bot.add_cog(NewsCog(bot))
