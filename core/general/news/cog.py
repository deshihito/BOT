# -*- coding: utf-8 -*-
"""ニュース通知の Cog：GDELT の新着記事をサーバー設定のチャンネルへ投稿。

- 取得元は GDELT Project の DOC API（オープンデータ。無償・無制限の
  利用と再配布が認められており、条件は出典明記とリンクのみ）。
  国内メディア各社の RSS は「プログラムによる再配信」を認めて
  いないため使わない。
- トピックは日本のニュース・政治・経済・国際・スポーツ・防災の6つ。
  日本語メディアの記事に絞り、分類はキーワード検索で行う。
- 設定は guild_settings の news セクション（既定 OFF）。入口は
  /support の「自動化・通知」→「ニュース通知」（サーバー管理権限が
  必要）で、投稿先とトピックを決める。トップレベルのコマンドは
  増やさない方針のため、専用コマンドは持たない。
- 15分ごとのループで確認し、未投稿の記事だけをまとめて1メッセージで
  投稿する。初回は既存記事を遡って投稿せず、取り込みだけ行う
  （有効化した瞬間に大量投稿しないため）。
- サーバー管理者は任意の RSS / Atom フィードも最大3件まで登録できる
  （custom_feeds）。投稿は見出しとリンクのみで、本文は取得しない。
  フィードごとの初回取得もシードのみ（遡って投稿しない）。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

import aiohttp
import discord
from discord.ext import commands, tasks

import config
from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

from . import feeds as feeds_mod
from .feeds import SITE_URL, TOPICS, NewsItem

logger = logging.getLogger("cogs.news")

POLL_MINUTES = 15  # GDELT のデータ更新間隔に合わせる
MAX_POSTS_PER_POLL = 5  # 1回のチェックで投稿する新着の上限（古い順）
FETCH_SPACING_SECONDS = 6  # GDELT の目安（1リクエスト/5秒）を超えない間隔
RATE_LIMIT_BACKOFF_SECONDS = 1800  # 429 のときは最低30分休む
CUSTOM_FETCH_SPACING_SECONDS = 2  # カスタムフィード取得の間隔


def format_post(items: list[NewsItem], topic_keys: list[str]) -> str:
    """新着記事を1メッセージ分のテキストに整形する。

    末尾の出典表記は GDELT の利用条件（出典明記＋リンク）。
    """
    labels = "・".join(TOPICS[key][0] for key in topic_keys if key in TOPICS)
    lines = [f"📰 **ニュース（{labels}）**"]
    for item in items:
        title = item.title.replace("[", "［").replace("]", "］")
        when = ""
        if item.published is not None:
            when = f"（{item.published.astimezone(config.JST):%H:%M}）"
        lines.append(f"・[{title}]({item.link}){when}")
    lines.append(f"-# データ: [GDELT Project]({SITE_URL})")
    return "\n".join(lines)


def format_custom_post(items: list[NewsItem], feed_name: str) -> str:
    """カスタムフィードの新着を1メッセージ分に整形する（見出し+リンクのみ）。"""
    name = feed_name.replace("[", "［").replace("]", "］")
    lines = [f"📡 **{name}**"]
    for item in items:
        title = item.title.replace("[", "［").replace("]", "］")
        when = ""
        if item.published is not None:
            when = f"（{item.published.astimezone(config.JST):%H:%M}）"
        lines.append(f"・[{title}]({item.link}){when}")
    return "\n".join(lines)


class NewsCog(commands.Cog):
    def __init__(self, bot: commands.Bot, fetcher=None, custom_fetcher=None):
        self.bot = bot
        # fetcher: async (session, topic_key) -> list[NewsItem]（テスト差し替え用）
        self._fetcher = fetcher or feeds_mod.fetch_feed
        # custom_fetcher: async (session, url) -> list[NewsItem]
        self._custom_fetcher = custom_fetcher or feeds_mod.fetch_custom_feed
        # 429 を受けたトピックの再試行時刻（time.monotonic 基準）
        self._topic_backoff: dict[str, float] = {}

    async def cog_load(self) -> None:
        if not self.poll_loop.is_running():
            self.poll_loop.start()
            logger.info("news: ニュース通知の定期チェックを開始しました")

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
            if (not [key for key in settings["feeds"] if key in TOPICS]
                    and not settings["custom_feeds"]):
                continue
            targets.append((guild_id, settings))
        if not targets:
            return 0

        # 取得はサーバー間で共有する（同じトピックは1回だけ取る）。
        # GDELT の制限（1リクエスト/5秒目安）に当たらないよう、並列では
        # なく間隔を空けて順に取る。429 のトピックはしばらく休む。
        wanted = {key for _gid, s in targets for key in s["feeds"] if key in TOPICS}
        fetched: dict[str, list[NewsItem]] = {}
        now_mono = time.monotonic()
        async with aiohttp.ClientSession() as session:
            first = True
            for key in sorted(wanted):
                if self._topic_backoff.get(key, 0.0) > now_mono:
                    continue
                if not first:
                    await asyncio.sleep(FETCH_SPACING_SECONDS)
                first = False
                try:
                    fetched[key] = await self._fetcher(session, key)
                except feeds_mod.RateLimited as exc:
                    backoff = max(exc.retry_after or 0.0,
                                  RATE_LIMIT_BACKOFF_SECONDS)
                    self._topic_backoff[key] = time.monotonic() + backoff
                    logger.info(
                        "news: GDELT が混雑しています（429）。topic=%s は "
                        "%.0f 分ほど取得を休みます", key, backoff / 60)
                except Exception:
                    logger.warning("news: 取得に失敗 topic=%s", key,
                                   exc_info=True)
            # カスタムフィードは URL 単位で共有して取る（サーバー間の重複なし）
            custom_wanted = {feed["url"] for _gid, s in targets
                             for feed in s["custom_feeds"]}
            custom_fetched: dict[str, list[NewsItem]] = {}
            for url in sorted(custom_wanted):
                await asyncio.sleep(CUSTOM_FETCH_SPACING_SECONDS)
                try:
                    custom_fetched[url] = await self._custom_fetcher(session, url)
                except Exception:
                    logger.warning("news: カスタムフィードの取得に失敗 url=%s", url)

        posted = 0
        custom_posted = 0
        fresh_total = 0
        for guild_id, settings in targets:
            updates: dict = {}
            channel = None
            channel_checked = False

            async def resolve_channel():
                nonlocal channel, channel_checked
                if not channel_checked:
                    channel_checked = True
                    channel = await self._resolve_channel(settings["channel_id"])
                    if channel is None:
                        logger.warning(
                            "news: 投稿先が見つかりません guild=%s channel=%s",
                            guild_id, settings["channel_id"])
                return channel

            # --- GDELT トピック ---
            items: list[NewsItem] = []
            for key in settings["feeds"]:
                items.extend(fetched.get(key, []))
            if items:
                items.sort(
                    key=lambda i: i.published or datetime.min.replace(
                        tzinfo=timezone.utc),
                    reverse=True)
                fresh, seeded = feeds_mod.select_new(
                    items, settings["seen"], MAX_POSTS_PER_POLL)
                fresh_total += len(fresh)
                # 投稿の成否に関わらず見た記事は記録し、失敗したサーバーが
                # 次回も同じ新着を送り続けないようにする（天気の定時投稿と
                # 同じ割り切り）。
                seen = list(settings["seen"])
                for item in items:
                    if item.link not in seen:
                        seen.append(item.link)
                updates["seen"] = seen[-guild_settings.NEWS_SEEN_LIMIT:]
                if not seeded and fresh:
                    target_channel = await resolve_channel()
                    if target_channel is not None:
                        try:
                            await target_channel.send(
                                format_post(fresh, settings["feeds"]))
                            posted += 1
                            logger.info(
                                "news: 投稿しました guild=%s channel=%s items=%d",
                                guild_id, settings["channel_id"], len(fresh))
                        except Exception:
                            logger.exception(
                                "news: 投稿に失敗 guild=%s channel=%s",
                                guild_id, settings["channel_id"])

            # --- カスタムフィード ---
            if settings["custom_feeds"]:
                custom_seen = list(settings["custom_seen"])
                seeded_urls = list(settings["custom_seeded"])
                custom_changed = False
                for feed in settings["custom_feeds"]:
                    feed_items = custom_fetched.get(feed["url"])
                    if feed_items is None:
                        continue  # 取得失敗時は状態を触らず次回に回す
                    custom_changed = True
                    if feed["url"] not in seeded_urls:
                        # 登録後の初回は取り込みだけ（遡って投稿しない）
                        for item in feed_items:
                            if item.link not in custom_seen:
                                custom_seen.append(item.link)
                        seeded_urls.append(feed["url"])
                        continue
                    fresh_c, _ = feeds_mod.select_new(
                        feed_items, custom_seen, MAX_POSTS_PER_POLL)
                    for item in feed_items:
                        if item.link not in custom_seen:
                            custom_seen.append(item.link)
                    if not fresh_c:
                        continue
                    target_channel = await resolve_channel()
                    if target_channel is None:
                        continue
                    try:
                        await target_channel.send(
                            format_custom_post(fresh_c, feed["name"]))
                        custom_posted += 1
                        logger.info(
                            "news: カスタムフィードを投稿しました guild=%s "
                            "feed=%s items=%d",
                            guild_id, feed["name"], len(fresh_c))
                    except Exception:
                        logger.exception(
                            "news: カスタムフィードの投稿に失敗 guild=%s feed=%s",
                            guild_id, feed["name"])
                if custom_changed:
                    updates["custom_seen"] = \
                        custom_seen[-guild_settings.NEWS_SEEN_LIMIT:]
                    updates["custom_seeded"] = \
                        seeded_urls[:guild_settings.MAX_CUSTOM_FEEDS]
            if updates:
                await store.update(guild_id, guild_settings.NEWS_SECTION,
                                   **updates)
        logger.info(
            "news: チェック完了 targets=%d fetched=%d fresh=%d posted=%d "
            "custom_posted=%d",
            len(targets), sum(len(v) for v in fetched.values()),
            fresh_total, posted, custom_posted)
        return posted + custom_posted

    async def _resolve_channel(self, channel_id: int):
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(channel_id)
            except Exception:
                channel = None
        return channel

    # --------------------------------------------------------------
    # 設定パネル（/support の「ニュース通知」から開く）
    # --------------------------------------------------------------
    async def open_panel(self, interaction: discord.Interaction):
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
            labels = "・".join(TOPICS[key][0] for key in settings["feeds"]
                               if key in TOPICS) or "未設定"
            return await interaction.response.send_message(
                f"ニュース通知は現在 **{state}** です（投稿先: {channel} / "
                f"トピック: {labels} / カスタムフィード: "
                f"{len(settings['custom_feeds'])}件）。\n"
                "設定の変更にはサーバー管理権限が必要です。",
                ephemeral=True)
        view = NewsSettingsView(self, interaction.user.id,
                                interaction.guild_id, settings)
        await interaction.response.send_message(view=as_panel_v2(view))


class NewsSettingsView(discord.ui.View):
    """ニュース通知の投稿先・トピックの編集ビュー（サーバー管理者のみ）。"""

    def __init__(self, cog: NewsCog, owner_id: int, guild_id: int, settings: dict):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner_id = owner_id
        self.guild_id = guild_id
        self.enabled = bool(settings.get("enabled"))
        self.channel_id = settings.get("channel_id")
        self.feeds = [key for key in settings.get("feeds", []) if key in TOPICS] \
            or ["top"]
        self.custom_feeds = [dict(feed)
                             for feed in settings.get("custom_feeds", [])]
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
        labels = "・".join(TOPICS[key][0] for key in self.feeds)
        lines.append(f"現在の設定: **{state}** / 投稿先: {channel} / トピック: {labels}")
        if self.custom_feeds:
            custom_labels = "、".join(
                f"「{feed['name']}」" for feed in self.custom_feeds)
            lines.append(f"カスタムフィード（{len(self.custom_feeds)}/"
                         f"{guild_settings.MAX_CUSTOM_FEEDS}）: {custom_labels}")
        else:
            lines.append("カスタムフィード: なし"
                         f"（最大{guild_settings.MAX_CUSTOM_FEEDS}件まで追加できます）")
        lines.append(
            "保存すると、世界のニュースメディアから集めた新着記事が"
            "15分おきにまとめて投稿されます（データ: GDELT Project）。"
            "有効にした直後は既存の記事を遡って投稿せず、新着分から届きます。")
        return discord.Embed(title="ニュース通知の設定",
                             description="\n".join(lines), color=0xFFFFFF)

    def _sync_controls(self) -> None:
        self.clear_items()
        self.add_item(_NewsChannelSelect(self))
        self.add_item(_NewsTopicSelect(self))
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
        add_feed = discord.ui.Button(
            label="カスタムフィードを追加", style=discord.ButtonStyle.secondary,
            custom_id="news:custom_add", row=3,
            disabled=len(self.custom_feeds) >= guild_settings.MAX_CUSTOM_FEEDS)
        add_feed.callback = self._on_add_feed
        self.add_item(add_feed)
        if self.custom_feeds:
            self.add_item(_CustomFeedRemoveSelect(self))

    async def _on_add_feed(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_modal(_CustomFeedModal(self))

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
                           feeds=list(self.feeds),
                           custom_feeds=[dict(f) for f in self.custom_feeds])
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


class _NewsTopicSelect(discord.ui.Select):
    def __init__(self, view: NewsSettingsView):
        self.panel = view
        options = [
            discord.SelectOption(label=label, value=key,
                                 default=key in view.feeds)
            for key, (label, _query) in TOPICS.items()
        ]
        super().__init__(placeholder="購読するトピック（複数選択可）",
                         options=options, min_values=1,
                         max_values=len(options),
                         custom_id="news:feeds", row=1)

    async def callback(self, interaction: discord.Interaction):
        self.panel.feeds = list(self.values)
        self.panel.notice = None
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


class _CustomFeedRemoveSelect(discord.ui.Select):
    def __init__(self, view: NewsSettingsView):
        self.panel = view
        options = [
            discord.SelectOption(
                label=feed["name"][:100], value=str(index),
                description=feed["url"][:100])
            for index, feed in enumerate(view.custom_feeds)
        ]
        super().__init__(placeholder="カスタムフィードを削除",
                         options=options, min_values=1, max_values=1,
                         custom_id="news:custom_remove", row=4)

    async def callback(self, interaction: discord.Interaction):
        try:
            index = int(self.values[0])
        except (TypeError, ValueError, IndexError):
            index = -1
        if 0 <= index < len(self.panel.custom_feeds):
            removed = self.panel.custom_feeds.pop(index)
            self.panel.notice = (
                f"カスタムフィード「{removed['name']}」を削除しました"
                "（保存ボタンで反映されます）。")
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


class _CustomFeedModal(discord.ui.Modal):
    """カスタムフィードの名前とURLを入力するモーダル。"""

    def __init__(self, view: NewsSettingsView):
        super().__init__(title="カスタムフィードを追加")
        self.panel = view
        self.name_input = discord.ui.TextInput(
            label="フィード名", max_length=50,
            placeholder="例: ○○公式ブログ")
        self.url_input = discord.ui.TextInput(
            label="RSS / Atom フィードのURL", max_length=500,
            placeholder="https://example.com/feed")
        self.add_item(self.name_input)
        self.add_item(self.url_input)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        name = str(self.name_input.value or "").strip()
        url = str(self.url_input.value or "").strip()
        if not url.startswith(("https://", "http://")):
            self.panel.notice = ("URLは http:// または https:// で始まる"
                                 "ものを入力してください。")
        elif len(self.panel.custom_feeds) >= guild_settings.MAX_CUSTOM_FEEDS:
            self.panel.notice = ("カスタムフィードは"
                                 f"{guild_settings.MAX_CUSTOM_FEEDS}件までです。"
                                 "不要なものを削除してください。")
        else:
            self.panel.custom_feeds.append(
                {"name": name or url, "url": url})
            self.panel.notice = (
                f"カスタムフィード「{name or url}」を追加しました"
                "（保存ボタンで反映されます）。")
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


async def setup(bot: commands.Bot):
    await bot.add_cog(NewsCog(bot))
