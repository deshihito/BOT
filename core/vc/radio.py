"""24/7 ラジオ（/vc のアクション ``radio_panel``）。

- 流すのは、各局が公式に公開しているストリーム URL の再生だけ。再配信・録音・
  ダウンロードはしない。収録局は、外部プレイヤーでの再生を公式に案内している
  SomaFM と Nightride FM のみ（YouTube 等、外部再生が規約で禁じられている
  音源は扱わない）。
- 接続は core/vc/voice_session の共有リース ``radio`` として持ち、再生は
  voice_media のミキサー経由（音楽・読み上げと併用できる）。
- 24/7 モード（サーバー設定 guild_settings の ``radio`` セクションに保存）:
  ON の間は誰もいなくても自動退出せず（idle_exempt）、切断・Bot 再起動の
  あともスーパーバイザーが同じチャンネル・同じ局で復帰させる。
  24/7 の切替はサーバー管理権限（manage_guild）がある人だけ。
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
from typing import Any, Optional

import discord
from discord.ext import commands, tasks

from core.support.emojis import FAILED, SUCCESS
from core.support.guild_settings import get_store
from core.support.legacy import Responder
from core.vc.voice_media import add_audio_source, has_audio_source, remove_audio_source
from core.vc.voice_session import VoiceBusy, get_manager

logger = logging.getLogger(__name__)

FEATURE = "radio"
SOURCE_KEY = "radio"
SECTION = "radio"

# ストリームが落ちたときの再接続間隔（秒）。FFmpeg 側にも再接続を任せつつ、
# ソース自体が終わってしまった場合はこちらで間隔を広げながら張り直す。
RESTART_BACKOFF_START = 5.0
RESTART_BACKOFF_MAX = 60.0
FFMPEG_BEFORE_OPTIONS = "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"


@dataclasses.dataclass(frozen=True)
class Station:
    id: str
    name: str
    desc: str
    url: str


# 公式ストリーム（外部プレイヤーでの再生を公式が案内している局のみ）。
STATIONS: tuple[Station, ...] = (
    Station("groovesalad", "SomaFM Groove Salad", "アンビエント",
            "https://ice1.somafm.com/groovesalad-128-mp3"),
    Station("lush", "SomaFM Lush", "チルアウト",
            "https://ice1.somafm.com/lush-128-mp3"),
    Station("dronezone", "SomaFM Drone Zone", "ドローン／作業用",
            "https://ice1.somafm.com/dronezone-128-mp3"),
    Station("poptron", "SomaFM PopTron", "エレクトロポップ",
            "https://ice1.somafm.com/poptron-128-mp3"),
    Station("secretagent", "SomaFM Secret Agent", "ラウンジ／スパイジャズ",
            "https://ice1.somafm.com/secretagent-128-mp3"),
    Station("nightride", "Nightride FM", "シンセウェーブ",
            "https://stream.nightride.fm/nightride.mp3"),
)
STATION_BY_ID: dict[str, Station] = {s.id: s for s in STATIONS}
DEFAULT_STATION = "groovesalad"


def clean_radio_settings(raw: Any) -> dict[str, Any]:
    """保存済みラジオ設定を検証して正規化する（壊れた値は既定に落とす）。"""
    raw = raw if isinstance(raw, dict) else {}
    station = raw.get("station")
    if station not in STATION_BY_ID:
        station = DEFAULT_STATION
    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool) or channel_id <= 0:
        channel_id = None
    return {
        "station": station,
        "channel_id": channel_id,
        "always_on": bool(raw.get("always_on", False)),
        "playing": bool(raw.get("playing", False)),
    }


def radio_settings(guild_id: int) -> dict[str, Any]:
    return clean_radio_settings(get_store().get(guild_id, SECTION))


async def save_radio_settings(guild_id: int, **values: Any) -> dict[str, Any]:
    return await get_store().update(guild_id, SECTION, **values)


def make_stream_source(station: Station) -> discord.FFmpegPCMAudio:
    """局の公式ストリームを FFmpeg で直接再生するソース（保存はしない）。"""
    return discord.FFmpegPCMAudio(
        station.url,
        before_options=FFMPEG_BEFORE_OPTIONS,
        options="-vn",
    )


@dataclasses.dataclass
class RadioState:
    guild_id: int
    station_id: str = DEFAULT_STATION
    channel_id: Optional[int] = None
    desired: bool = False  # 流し続けたい状態か（手動停止で False）
    backoff: float = RESTART_BACKOFF_START
    restart_task: Optional[asyncio.Task] = None


class RadioCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.manager = get_manager(bot)
        self._states: dict[int, RadioState] = {}

    async def cog_load(self) -> None:
        self._supervisor.start()

    async def cog_unload(self) -> None:
        self._supervisor.cancel()
        for state in self._states.values():
            if state.restart_task is not None and not state.restart_task.done():
                state.restart_task.cancel()

    # ------------------------------------------------------------ 状態
    def _state(self, guild_id: int) -> RadioState:
        state = self._states.get(guild_id)
        if state is None:
            state = self._states[guild_id] = RadioState(guild_id=guild_id)
        return state

    def session_has_radio(self, guild_id: int) -> bool:
        session = self.manager.get(guild_id)
        return session is not None and (
            session.feature == FEATURE or FEATURE in session.shared_leases
        )

    # ------------------------------------------------------------ 再生制御
    async def start_radio(self, guild, channel, user, station_id: str,
                          text_channel=None) -> Station:
        station = STATION_BY_ID[station_id]
        state = self._state(guild.id)
        state.station_id = station_id
        state.channel_id = getattr(channel, "id", None)
        state.desired = True

        def _cleanup(reason: str, _gid: int = guild.id) -> None:
            self._on_session_cleanup(_gid, reason)

        vc = await self.manager.acquire(
            guild, channel, FEATURE, user,
            cleanup=_cleanup, text_channel=text_channel,
        )
        cfg = radio_settings(guild.id)
        if cfg["always_on"]:
            self.manager.set_idle_exempt(guild.id, True)
        self._play(guild.id, vc, station)
        await save_radio_settings(
            guild.id, station=station_id,
            channel_id=state.channel_id, playing=True,
        )
        return station

    def _play(self, guild_id: int, vc, station: Station) -> None:
        state = self._state(guild_id)

        def _after(error, _gid: int = guild_id) -> None:
            current = self._states.get(_gid)
            if current is not None and current.desired:
                self._schedule_restart(_gid)

        # 既存ソースの差し替えでは after を発火させない（notify=False）。
        remove_audio_source(vc, SOURCE_KEY)
        add_audio_source(vc, SOURCE_KEY, make_stream_source(station), after=_after)
        state.backoff = RESTART_BACKOFF_START

    def _schedule_restart(self, guild_id: int) -> None:
        state = self._state(guild_id)
        if state.restart_task is not None and not state.restart_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        state.restart_task = loop.create_task(self._restart_job(guild_id))

    async def _restart_job(self, guild_id: int) -> None:
        state = self._state(guild_id)
        try:
            await asyncio.sleep(state.backoff)
        except asyncio.CancelledError:
            return
        state.backoff = min(RESTART_BACKOFF_MAX, state.backoff * 2)
        if not state.desired:
            return
        guild = self.bot.get_guild(guild_id)
        vc = getattr(guild, "voice_client", None) if guild is not None else None
        if not self.session_has_radio(guild_id) or vc is None or not vc.is_connected():
            return  # セッション自体が無いケースはスーパーバイザー側で復帰させる
        if has_audio_source(vc, SOURCE_KEY):
            return
        self._play(guild_id, vc, STATION_BY_ID[state.station_id])

    async def stop_radio(self, guild_id: int) -> bool:
        state = self._states.get(guild_id)
        if state is not None:
            state.desired = False
            if state.restart_task is not None and not state.restart_task.done():
                state.restart_task.cancel()
        released = await self.manager.release(guild_id, FEATURE, reason="stop")
        await save_radio_settings(guild_id, playing=False, always_on=False)
        return released

    def _on_session_cleanup(self, guild_id: int, reason: str) -> None:
        """セッション解放時の後片付け（manager のロック内で呼ばれる）。

        manager.release() の再入は禁止。音源の除去とタスク停止だけ行う。
        24/7 ON のときは desired を保ち、スーパーバイザーが復帰させる。
        """
        guild = self.bot.get_guild(guild_id)
        vc = getattr(guild, "voice_client", None) if guild is not None else None
        if vc is not None:
            try:
                remove_audio_source(vc, SOURCE_KEY)
            except Exception:
                logger.debug("guild %s: ラジオ音源の除去に失敗しました", guild_id, exc_info=True)
        state = self._states.get(guild_id)
        if state is not None:
            if state.restart_task is not None and not state.restart_task.done():
                state.restart_task.cancel()
            if not radio_settings(guild_id)["always_on"]:
                state.desired = False

    # ------------------------------------------------------------ 24/7 スーパーバイザー
    @tasks.loop(seconds=60)
    async def _supervisor(self) -> None:
        """24/7 ON のサーバーで、ラジオが止まっていたら復帰させる。

        tasks.loop は本体で例外が漏れるとループごと止まる。設定の読み込み
        失敗は次周期に再試行し、サーバー単位の失敗（再生の開始など）は
        そのサーバーだけ飛ばして次へ進む。
        """
        store = get_store()
        try:
            await store.ensure_loaded()
        except Exception:
            logger.exception("ラジオの監視に失敗しました（設定の読み込み）")
            return
        for guild_key, raw in store.all_sections(SECTION).items():
            try:
                await self._supervise_guild(guild_key, raw)
            except Exception:
                logger.exception("guild %s: ラジオの監視に失敗しました", guild_key)

    async def _supervise_guild(self, guild_key: Any, raw: Any) -> None:
        """_supervisor のサーバー1件分。失敗は呼び出し側で吸収する。"""
        cfg = clean_radio_settings(raw)
        if not (cfg["always_on"] and cfg["playing"]):
            return
        try:
            guild_id = int(guild_key)
        except (TypeError, ValueError):
            return
        guild = self.bot.get_guild(guild_id)
        if guild is None or cfg["channel_id"] is None:
            return
        vc = getattr(guild, "voice_client", None)
        if self.session_has_radio(guild_id) and vc is not None and vc.is_connected():
            if not has_audio_source(vc, SOURCE_KEY):
                self._play(guild_id, vc, STATION_BY_ID[cfg["station"]])
            return
        channel = guild.get_channel(cfg["channel_id"])
        if channel is None:
            return
        try:
            await self.start_radio(guild, channel, self.bot.user, cfg["station"])
        except VoiceBusy:
            logger.debug("guild %s: 他の機能が VC 使用中のためラジオ復帰を次周期に回します", guild_id)
        except Exception:
            logger.exception("guild %s: ラジオの自動復帰に失敗しました", guild_id)

    @_supervisor.before_loop
    async def _supervisor_before(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------ パネル
    def build_panel_embed(self, guild, cfg: dict[str, Any]) -> discord.Embed:
        playing = self.session_has_radio(guild.id)
        station = STATION_BY_ID[cfg["station"]]
        channel = guild.get_channel(cfg["channel_id"]) if cfg["channel_id"] else None
        embed = discord.Embed(title="📻 ラジオ", color=0x35B6F2)
        embed.add_field(
            name="状態",
            value=(
                f"再生中: **{'はい' if playing else 'いいえ'}**\n"
                f"局: **{station.name}**（{station.desc}）\n"
                f"チャンネル: {getattr(channel, 'mention', None) or '未設定'}\n"
                f"24/7: **{'ON' if cfg['always_on'] else 'OFF'}**"
                "（ON の間は誰もいなくても退出せず、切れても自動で戻ります）"
            ),
            inline=False,
        )
        embed.add_field(
            name="使い方",
            value=(
                "1. ボイスチャンネルに入る\n"
                "2. 下のメニューで局を選ぶ（選ばなければ現在の局）\n"
                "3. 「再生開始」を押す\n"
                "24/7 の ON/OFF はサーバー管理権限がある人だけが切り替えられます。"
            ),
            inline=False,
        )
        embed.set_footer(
            text="流れるのは各局が公式に公開しているストリームの再生だけです（再配信・録音はしません）。"
        )
        return embed

    async def _radio_panel_impl(self, r: Responder) -> None:
        guild = r.guild
        if guild is None:
            await r.send(f"{FAILED} サーバー内でのみ使えます。", ephemeral=True)
            return
        cfg = radio_settings(guild.id)
        view = RadioPanelView(self, guild.id, cfg["station"])
        await r.send(embed=self.build_panel_embed(guild, cfg), view=view, ephemeral=True)


class RadioPanelView(discord.ui.View):
    def __init__(self, cog: RadioCog, guild_id: int, current_station: str):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.selected_station = current_station
        select = discord.ui.Select(
            placeholder="流すラジオ局を選ぶ",
            custom_id="radio:station",
            options=[
                discord.SelectOption(
                    label=f"{s.name} — {s.desc}", value=s.id,
                    default=(s.id == current_station),
                )
                for s in STATIONS
            ],
        )
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction) -> None:
        values = interaction.data.get("values") or []
        if values:
            self.selected_station = values[0]
        await interaction.response.defer()

    @discord.ui.button(label="▶ 再生開始", style=discord.ButtonStyle.success, custom_id="radio:start")
    async def start_button(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        member = interaction.user
        voice = getattr(member, "voice", None)
        channel = getattr(voice, "channel", None)
        if channel is None:
            await interaction.response.send_message(
                f"{FAILED} 先にボイスチャンネルへ入ってください。", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        try:
            station = await self.cog.start_radio(
                interaction.guild, channel, member,
                self.selected_station, text_channel=interaction.channel,
            )
        except VoiceBusy as error:
            await interaction.followup.send(str(error), ephemeral=True)
            return
        except Exception:
            logger.exception("guild %s: ラジオ開始に失敗しました", self.guild_id)
            await interaction.followup.send(
                f"{FAILED} 接続に失敗しました。少し待ってからもう一度お試しください。",
                ephemeral=True)
            return
        await interaction.followup.send(
            f"{SUCCESS} 📻 **{station.name}** を流し始めました。", ephemeral=True)

    @discord.ui.button(label="⏹ 停止", style=discord.ButtonStyle.danger, custom_id="radio:stop")
    async def stop_button(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await interaction.response.defer(ephemeral=True)
        await self.cog.stop_radio(self.guild_id)
        await interaction.followup.send("📻 ラジオを止めました（24/7 も OFF になりました）。", ephemeral=True)

    @discord.ui.button(label="🔁 24/7 切替", style=discord.ButtonStyle.primary, custom_id="radio:toggle247")
    async def toggle_button(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        member = interaction.user
        perms = getattr(member, "guild_permissions", None)
        if not (perms and (perms.manage_guild or perms.administrator)):
            await interaction.response.send_message(
                f"{FAILED} 24/7 の切替はサーバー管理権限がある人だけが行えます。",
                ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        cfg = radio_settings(self.guild_id)
        if cfg["always_on"]:
            await save_radio_settings(self.guild_id, always_on=False)
            self.cog.manager.set_idle_exempt(self.guild_id, False)
            await interaction.followup.send(
                "🔁 24/7 を **OFF** にしました（再生はそのまま続けます）。", ephemeral=True)
            return
        # ON にする: 流すチャンネルを決める（現在のセッション → 自分の VC → 保存済み）
        session = self.cog.manager.get(self.guild_id)
        channel = None
        if session is not None and session.channel_id is not None:
            channel = interaction.guild.get_channel(session.channel_id)
        if channel is None:
            voice = getattr(member, "voice", None)
            channel = getattr(voice, "channel", None)
        if channel is None and cfg["channel_id"] is not None:
            channel = interaction.guild.get_channel(cfg["channel_id"])
        if channel is None:
            await interaction.followup.send(
                f"{FAILED} 流すボイスチャンネルが決まっていません。先に VC へ入ってから切り替えてください。",
                ephemeral=True)
            return
        station_id = self.selected_station or cfg["station"]
        await save_radio_settings(
            self.guild_id, always_on=True, playing=True,
            channel_id=channel.id, station=station_id,
        )
        if self.cog.session_has_radio(self.guild_id):
            self.cog.manager.set_idle_exempt(self.guild_id, True)
            await interaction.followup.send(
                f"🔁 24/7 を **ON** にしました（{channel.mention} で流し続けます）。",
                ephemeral=True)
            return
        try:
            station = await self.cog.start_radio(
                interaction.guild, channel, member, station_id,
                text_channel=interaction.channel,
            )
        except VoiceBusy as error:
            await interaction.followup.send(str(error), ephemeral=True)
            return
        await interaction.followup.send(
            f"🔁 24/7 を **ON** にしました。{channel.mention} で **{station.name}** を流し続けます。",
            ephemeral=True)


async def setup(bot):
    await bot.add_cog(RadioCog(bot))
