# -*- coding: utf-8 -*-
"""天気の Cog：/general パネルの入口と全国概況の定時投稿。

- 本体は地域別のオンデマンド予報カード（気象庁 bosai 予報JSON）。
  地域は「地方ブロック → 発表官署」の2段セレクトで選ぶ。サーバーの
  既定地域（管理者が設定）と、ユーザー個人の前回地域を覚える。
- 定時投稿は相乗りオプション：サーバー設定で投稿先と時刻を決めると、
  主要12地点の「全国の天気」カードを毎日1回投稿する（既定OFF）。
  置き場所は本体と同じ Cog の毎分ループ（日報DMと同じ作法）:
  設定が guild_settings の weather セクションに集約されているため、
  server_assist 側に分けると設定と実行が二重管理になる。
- 取得に失敗したときは、その旨を表示して古い予報を最新と偽らない
  （カードには発表時刻と取得時刻を必ず明記する）。
"""
from __future__ import annotations

import asyncio
import io
import logging
import time
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

from . import areas as areas_mod
from .forecast import WeatherFetchError, fetch_forecast
from .render import render_forecast_png, render_national_png
from .store import WeatherUserStore

logger = logging.getLogger("cogs.weather")

CARD_FILENAME = "weather.png"
NATIONAL_FILENAME = "weather_national.png"
CACHE_TTL_SECONDS = 600  # 予報は5/11/17時発表。10分キャッシュで十分新鮮


class WeatherCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: WeatherUserStore | None = None,
                 fetcher=None):
        self.bot = bot
        self.store = store or WeatherUserStore()
        self._fetcher = fetcher or fetch_forecast
        self._cache: dict[str, tuple[float, object]] = {}

    async def cog_load(self) -> None:
        if not self.post_loop.is_running():
            self.post_loop.start()

    async def cog_unload(self) -> None:
        if self.post_loop.is_running():
            self.post_loop.cancel()

    # --------------------------------------------------------------
    # 予報取得（短いキャッシュ付き）
    # --------------------------------------------------------------
    async def get_forecast(self, office_code: str):
        cached = self._cache.get(office_code)
        if cached is not None and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
        forecast = await self._fetcher(office_code)
        self._cache[office_code] = (time.monotonic(), forecast)
        return forecast

    async def get_national(self) -> list:
        """主要12地点の予報を集める（取れた地点だけ返す）。"""
        results = await asyncio.gather(
            *(self.get_forecast(code) for code, _label in areas_mod.MAJOR_CITIES),
            return_exceptions=True,
        )
        entries = []
        for (code, label), result in zip(areas_mod.MAJOR_CITIES, results):
            if isinstance(result, Exception):
                logger.warning("weather: 全国概況の取得に失敗 code=%s", code,
                               exc_info=result)
                continue
            entries.append((label, result))
        return entries

    # --------------------------------------------------------------
    # /general パネル
    # --------------------------------------------------------------
    async def open_panel(self, interaction: discord.Interaction):
        guild_id = interaction.guild_id
        if guild_id is None:
            return await interaction.response.send_message(
                "サーバー内でのみ使えます。", ephemeral=True)
        # 取得を伴うため先にACKする（EXP系と同じ作法）。
        await interaction.response.defer()
        settings_store = guild_settings.get_store()
        await settings_store.ensure_loaded()
        settings = guild_settings.weather_settings(guild_id)
        area_code = settings.get("default_area")
        if not area_code:
            last = self.store.last_area(interaction.user.id)
            if last and areas_mod.office_name(last):
                area_code = last
        permissions = getattr(interaction.user, "guild_permissions", None)
        is_admin = bool(permissions and permissions.manage_guild)
        view = WeatherView(self, interaction.user.id, guild_id, is_admin,
                           area_code=area_code)
        await view.prepare()
        file = view.panel_file()
        await interaction.followup.send(
            view=as_panel_v2(view),
            files=[file] if file is not None else [])

    # --------------------------------------------------------------
    # 定時投稿（全国の天気）
    # --------------------------------------------------------------
    @tasks.loop(minutes=1)
    async def post_loop(self) -> None:
        try:
            await self.post_due_national()
        except Exception:
            logger.exception("weather: 定時投稿のチェックに失敗しました")

    @post_loop.before_loop
    async def _before_post_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def post_due_national(self, now: datetime | None = None) -> int:
        """定時が来たサーバーへ全国の天気カードを投稿し、投稿数を返す。"""
        now = now or datetime.now(config.JST)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        due: list[tuple[int, int]] = []
        for guild_id_text in store.all_sections(guild_settings.WEATHER_SECTION):
            try:
                guild_id = int(guild_id_text)
            except (TypeError, ValueError):
                continue
            channel_id = guild_settings.weather_post_due(guild_id, now)
            if channel_id is not None:
                due.append((guild_id, channel_id))
        if not due:
            return 0
        entries = await self.get_national()
        if not entries:
            # 気象庁側の障害時はその日に偽の投稿をせず、次分で再試行する。
            logger.warning("weather: 全国概況を取得できず定時投稿を見送ります")
            return 0
        png = await asyncio.to_thread(
            render_national_png, entries, entries[0][1].fetched_at)
        today = now.strftime("%Y-%m-%d")
        posted = 0
        for guild_id, channel_id in due:
            channel = self.bot.get_channel(channel_id)
            if channel is None:
                try:
                    channel = await self.bot.fetch_channel(channel_id)
                except Exception:
                    channel = None
            if channel is not None:
                try:
                    await channel.send(
                        content=f"🌤 全国の天気（{now.strftime('%m/%d')}）",
                        file=discord.File(io.BytesIO(png),
                                          filename=NATIONAL_FILENAME))
                    posted += 1
                except Exception:
                    logger.exception(
                        "weather: 定時投稿に失敗 guild=%s channel=%s",
                        guild_id, channel_id)
            # 投稿できなかったサーバーも当日分は試行済みにし、毎分
            # リトライし続けない（日報DMと同じ割り切り）。
            await store.update(guild_id, guild_settings.WEATHER_SECTION,
                               posted_date=today)
        return posted


# ============================================================
# パネル本体
# ============================================================

class WeatherView(discord.ui.View):
    def __init__(self, cog: WeatherCog, owner_id: int, guild_id: int,
                 is_admin: bool, area_code: str | None = None):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner_id = owner_id
        self.guild_id = guild_id
        self.is_admin = is_admin
        self.area_code = area_code
        self.block_code = areas_mod.OFFICE_BLOCK.get(area_code or "")
        self.forecast = None
        self.error: str | None = None
        self.notice: str | None = None
        self._png: bytes | None = None
        self._sync_controls()

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return interaction.user.id == self.owner_id

    # --------------------------------------------------------------
    async def prepare(self) -> None:
        self.error = None
        self._png = None
        self.forecast = None
        if not self.area_code:
            self._sync_controls()
            return
        try:
            self.forecast = await self.cog.get_forecast(self.area_code)
        except WeatherFetchError as exc:
            self.error = str(exc)
            self._sync_controls()
            return
        except Exception:
            logger.exception("weather: 予報の取得に失敗 code=%s", self.area_code)
            self.error = "気象庁への接続に失敗しました"
            self._sync_controls()
            return
        label = areas_mod.office_name(self.area_code) or ""
        self._png = await asyncio.to_thread(
            render_forecast_png, self.forecast, label)
        self._sync_controls()

    def panel_file(self) -> discord.File | None:
        if self._png is None:
            return None
        return discord.File(io.BytesIO(self._png), filename=CARD_FILENAME)

    def embed(self) -> discord.Embed:
        lines = []
        if self.notice:
            lines.append(self.notice)
        if self.error:
            lines.append(f"予報を取得できませんでした（{self.error}）。"
                         "時間をおいて地域を選び直してください。")
        elif self.forecast is None:
            lines.append("地域を選ぶと、今日・明日・明後日の予報と週間予報を"
                         "表示します（気象庁のデータ・日本国内のみ）。")
        else:
            lines.append("出典: 気象庁 / 取得時刻はカード内に表示しています。")
        embed = discord.Embed(
            title="天気", description="\n".join(lines) or None, color=0xFFFFFF)
        if self._png is not None:
            embed.set_image(url=f"attachment://{CARD_FILENAME}")
        return embed

    # --------------------------------------------------------------
    # 操作部品
    # --------------------------------------------------------------
    def _sync_controls(self) -> None:
        self.clear_items()
        self.add_item(_BlockSelect(self))
        self.add_item(_AreaSelect(self))
        if self.is_admin and self.guild_id is not None:
            default_button = discord.ui.Button(
                label="サーバーの既定地域に設定",
                style=discord.ButtonStyle.secondary,
                custom_id="weather:set_default", row=2,
                disabled=self.area_code is None)
            default_button.callback = self._on_set_default
            self.add_item(default_button)
            schedule_button = discord.ui.Button(
                label="定時投稿の設定",
                style=discord.ButtonStyle.secondary,
                custom_id="weather:schedule", row=2)
            schedule_button.callback = self._on_open_schedule
            self.add_item(schedule_button)
        close = discord.ui.Button(
            label="閉じる", style=discord.ButtonStyle.secondary,
            custom_id="weather:close", row=2)
        close.callback = self._on_close
        self.add_item(close)

    async def _edit(self, interaction: discord.Interaction) -> None:
        file = self.panel_file()
        await edit_panel_v2(interaction, as_panel_v2(self),
                            files=[file] if file is not None else None)

    async def change_block(self, interaction: discord.Interaction,
                           block_code: str) -> None:
        self.block_code = block_code
        self.notice = None
        self._sync_controls()
        await self._edit(interaction)

    async def change_area(self, interaction: discord.Interaction,
                          area_code: str) -> None:
        self.area_code = area_code
        self.block_code = areas_mod.OFFICE_BLOCK.get(area_code)
        self.notice = None
        self.cog.store.remember(self.owner_id, area_code)
        await self.prepare()
        await self._edit(interaction)

    async def _on_set_default(self, interaction: discord.Interaction) -> None:
        if not self.area_code:
            return
        store = guild_settings.get_store()
        await store.update(self.guild_id, guild_settings.WEATHER_SECTION,
                           default_area=self.area_code)
        label = areas_mod.office_name(self.area_code) or self.area_code
        self.notice = f"サーバーの既定地域を「{label}」に設定しました。"
        self._sync_controls()
        await self._edit(interaction)

    async def _on_open_schedule(self, interaction: discord.Interaction) -> None:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = guild_settings.weather_settings(self.guild_id)
        view = WeatherScheduleView(self, settings)
        await edit_panel_v2(interaction, as_panel_v2(view))

    async def _on_close(self, interaction: discord.Interaction) -> None:
        self.clear_items()
        await edit_panel_v2(interaction, as_panel_v2(self))
        self.stop()


class _BlockSelect(discord.ui.Select):
    def __init__(self, view: WeatherView):
        self.panel = view
        options = [
            discord.SelectOption(
                label=label, value=block,
                default=block == view.block_code)
            for block, label, _offices in areas_mod.BLOCKS
        ]
        super().__init__(placeholder="地方を選ぶ", options=options,
                         custom_id="weather:block", row=0)

    async def callback(self, interaction: discord.Interaction):
        await self.panel.change_block(interaction, self.values[0])


class _AreaSelect(discord.ui.Select):
    def __init__(self, view: WeatherView):
        self.panel = view
        offices = (areas_mod.offices_of_block(view.block_code)
                   if view.block_code else ())
        options = [
            discord.SelectOption(
                label=name, value=code, default=code == view.area_code)
            for code, name in offices
        ] or [discord.SelectOption(label="先に地方を選んでください",
                                   value="__none__")]
        super().__init__(placeholder="地域を選ぶ", options=options,
                         custom_id="weather:area", row=1,
                         disabled=not offices)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            return await interaction.response.defer()
        await self.panel.change_area(interaction, self.values[0])


# ============================================================
# 定時投稿の設定ビュー
# ============================================================

class WeatherScheduleView(discord.ui.View):
    """定時投稿（全国の天気）の投稿先・時刻の編集ビュー（管理者のみ）。"""

    def __init__(self, parent: WeatherView, settings: dict):
        super().__init__(timeout=600)
        self.parent = parent
        self.cog = parent.cog
        self.owner_id = parent.owner_id
        self.guild_id = parent.guild_id
        self.channel_id = settings.get("post_channel_id")
        post_time = settings.get("post_time") or "07:00"
        try:
            hour, minute = (int(part) for part in str(post_time).split(":"))
        except (TypeError, ValueError):
            hour, minute = 7, 0
        self.hour = hour if 0 <= hour <= 23 else 7
        self.minute = minute if minute in (0, 15, 30, 45) else 0
        self.enabled = bool(settings.get("post_enabled"))
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
        lines.append(
            f"現在の設定: **{state}** / 投稿先: {channel} / "
            f"時刻: {self.hour:02d}:{self.minute:02d}（JST）")
        lines.append("保存すると、毎日その時刻に主要地点の「全国の天気」"
                     "カードを投稿します。")
        return discord.Embed(
            title="天気の定時投稿", description="\n".join(lines),
            color=0xFFFFFF)

    def _sync_controls(self) -> None:
        self.clear_items()
        self.add_item(_ScheduleChannelSelect(self))
        self.add_item(_HourSelect(self))
        self.add_item(_MinuteSelect(self))
        save = discord.ui.Button(
            label="保存してONにする", style=discord.ButtonStyle.primary,
            custom_id="weather:sched_save", row=3)
        save.callback = self._on_save
        self.add_item(save)
        off = discord.ui.Button(
            label="定時投稿をOFFにする", style=discord.ButtonStyle.secondary,
            custom_id="weather:sched_off", row=3)
        off.callback = self._on_off
        self.add_item(off)
        back = discord.ui.Button(
            label="天気に戻る", style=discord.ButtonStyle.secondary,
            custom_id="weather:sched_back", row=3)
        back.callback = self._on_back
        self.add_item(back)

    async def _edit(self, interaction: discord.Interaction) -> None:
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def _on_save(self, interaction: discord.Interaction) -> None:
        if not self.channel_id:
            self.notice = "投稿先チャンネルを選んでください。"
            self._sync_controls()
            return await self._edit(interaction)
        store = guild_settings.get_store()
        await store.update(
            self.guild_id, guild_settings.WEATHER_SECTION,
            post_enabled=True, post_channel_id=self.channel_id,
            post_time=f"{self.hour:02d}:{self.minute:02d}")
        self.enabled = True
        self.notice = "定時投稿を保存しました。"
        self._sync_controls()
        await self._edit(interaction)

    async def _on_off(self, interaction: discord.Interaction) -> None:
        store = guild_settings.get_store()
        await store.update(self.guild_id, guild_settings.WEATHER_SECTION,
                           post_enabled=False)
        self.enabled = False
        self.notice = "定時投稿をOFFにしました。"
        self._sync_controls()
        await self._edit(interaction)

    async def _on_back(self, interaction: discord.Interaction) -> None:
        await self.parent.prepare()
        file = self.parent.panel_file()
        await edit_panel_v2(interaction, as_panel_v2(self.parent),
                            files=[file] if file is not None else None)


class _ScheduleChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, view: WeatherScheduleView):
        self.panel = view
        super().__init__(
            placeholder="投稿先チャンネル",
            channel_types=[discord.ChannelType.text],
            custom_id="weather:sched_channel", row=0)

    async def callback(self, interaction: discord.Interaction):
        self.panel.channel_id = self.values[0].id
        self.panel.notice = None
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


class _HourSelect(discord.ui.Select):
    def __init__(self, view: WeatherScheduleView):
        self.panel = view
        options = [
            discord.SelectOption(label=f"{hour}時", value=str(hour),
                                 default=hour == view.hour)
            for hour in range(24)
        ]
        super().__init__(placeholder="投稿する時", options=options,
                         custom_id="weather:sched_hour", row=1)

    async def callback(self, interaction: discord.Interaction):
        self.panel.hour = int(self.values[0])
        self.panel.notice = None
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


class _MinuteSelect(discord.ui.Select):
    def __init__(self, view: WeatherScheduleView):
        self.panel = view
        options = [
            discord.SelectOption(label=f"{minute:02d}分", value=str(minute),
                                 default=minute == view.minute)
            for minute in (0, 15, 30, 45)
        ]
        super().__init__(placeholder="投稿する分", options=options,
                         custom_id="weather:sched_minute", row=2)

    async def callback(self, interaction: discord.Interaction):
        self.panel.minute = int(self.values[0])
        self.panel.notice = None
        self.panel._sync_controls()
        await edit_panel_v2(interaction, as_panel_v2(self.panel))


async def setup(bot: commands.Bot):
    await bot.add_cog(WeatherCog(bot))
