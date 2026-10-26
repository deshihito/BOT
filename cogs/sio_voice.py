"""/voice グループ: ボイスチャンネルを使う機能（参加・退出・録音・やまびこ・文字起こし・カラオケ・
ボイスチェンジャー・ランダム通話・グローバルVC・VOICEVOX読み上げ）の入口。

それぞれの処理は各機能の cog にある実装関数（``_xxx_impl``）を呼ぶだけ。
VC を誰が使っているかは core/voice_session.py が持つ。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

from core.legacy import Responder
from core.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.voice_media import add_audio_source, remove_audio_source
from core.panel_v2 import as_panel_v2, edit_panel_v2

CONNECTION_ACTIONS = [
    app_commands.Choice(name="参加", value="join"),
    app_commands.Choice(name="退出", value="leave"),
    app_commands.Choice(name="状態", value="status"),
]
STUDIO_FEATURES = [
    app_commands.Choice(name="録音", value="record"),
    app_commands.Choice(name="やまびこ", value="echo"),
    app_commands.Choice(name="文字起こし", value="transcribe"),
    app_commands.Choice(name="カラオケ", value="karaoke"),
]
STUDIO_ACTIONS = [
    app_commands.Choice(name="開始", value="start"),
    app_commands.Choice(name="停止/終了", value="stop"),
    app_commands.Choice(name="状態", value="status"),
    app_commands.Choice(name="音程解析", value="pitch"),
    app_commands.Choice(name="遅延変更", value="delay"),
    app_commands.Choice(name="採点", value="score"),
]
EFFECT_ACTIONS = [
    app_commands.Choice(name="開始", value="start"),
    app_commands.Choice(name="停止", value="stop"),
    app_commands.Choice(name="状態/設定変更", value="status"),
]
COMMUNITY_NETWORKS = [
    app_commands.Choice(name="ランダム通話", value="match"),
    app_commands.Choice(name="グローバルVC", value="global"),
]
COMMUNITY_ACTIONS = [
    app_commands.Choice(name="開始/参加", value="start"),
    app_commands.Choice(name="終了/退出", value="stop"),
]

VOICE_GENRES = {
    "connection": ("VC接続", "参加、退出、現在の使用状況"),
    "music": ("音楽", "音楽操作パネル"),
    "studio": ("録音・音声制作", "録音、やまびこ、文字起こし、カラオケ"),
    "effects": ("音声加工", "ボイスチェンジャー"),
    "community": ("通話ネットワーク", "ランダム通話、グローバルVC"),
    "tts": ("読み上げ", "VOICEVOXによるテキスト読み上げ"),
}
VOICE_ACTIONS_BY_GENRE = {
    "connection": [("参加", "join"), ("退出", "leave"), ("状態", "status")],
    "music": [("音楽操作パネル", "music_panel")],
    "studio": [(f"録音: {label}", f"record_{value}") for label, value in
                (("開始", "start"), ("停止", "stop"), ("状態", "status"), ("音程解析", "pitch"))] +
               [(f"やまびこ: {label}", f"echo_{value}") for label, value in
                (("開始", "start"), ("停止", "stop"), ("遅延変更", "delay"))] +
               [("文字起こし: 開始", "transcribe_start"), ("文字起こし: 停止", "transcribe_stop"),
                ("カラオケ: 開始", "karaoke_start"), ("カラオケ: 停止", "karaoke_stop"),
                ("カラオケ: 採点", "karaoke_score")],
    "effects": [("開始", "changer_start"), ("停止", "changer_stop"), ("状態/設定", "changer_status")],
    "community": [("ランダム通話: 開始/参加", "match_start"), ("ランダム通話: 終了/退出", "match_stop"),
                   ("グローバルVC: 開始/参加", "global_start"), ("グローバルVC: 終了/退出", "global_stop")],
    "tts": [("読み上げ: 開始（このチャンネルを読む）", "tts_start"), ("読み上げ: 停止", "tts_stop"),
            ("読み上げ: 話者・ピッチ・話速の設定", "tts_config"), ("読み上げ: 1回だけ読む", "tts_say")],
}

# 各機能の cog の名前（クラス名）
COGS = {
    "music": "VoiceCog",
    "record": "RecordingCog",
    "transcribe": "TranscriptionCog",
    "karaoke": "KaraokeCog",
    "changer": "VoiceChangerCog",
    "match": "SaitoRelay",
    "global": "GlobalVCCog",
    "tts": "TTSCog",
}


def format_elapsed(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}時間{minutes}分"
    if minutes:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"


class VoiceHub(commands.Cog):
    VOICE_ACTIONS = [
        app_commands.Choice(name="VC参加", value="join"), app_commands.Choice(name="VC退出", value="leave"),
        app_commands.Choice(name="VC状態", value="status"),
        app_commands.Choice(name="音楽操作パネル", value="music_panel"),
        *[app_commands.Choice(name=f"録音: {label}", value=f"record_{value}") for label, value in
          (("開始", "start"), ("停止", "stop"), ("状態", "status"), ("音程解析", "pitch"))],
        *[app_commands.Choice(name=f"やまびこ: {label}", value=f"echo_{value}") for label, value in
          (("開始", "start"), ("停止", "stop"), ("遅延変更", "delay"))],
        app_commands.Choice(name="文字起こし: 開始", value="transcribe_start"),
        app_commands.Choice(name="文字起こし: 停止", value="transcribe_stop"),
        app_commands.Choice(name="カラオケ: 開始", value="karaoke_start"),
        app_commands.Choice(name="カラオケ: 停止", value="karaoke_stop"),
        app_commands.Choice(name="カラオケ: 採点", value="karaoke_score"),
        app_commands.Choice(name="ボイスチェンジャー: 開始", value="changer_start"),
        app_commands.Choice(name="ボイスチェンジャー: 停止", value="changer_stop"),
        app_commands.Choice(name="ボイスチェンジャー: 状態/設定", value="changer_status"),
        app_commands.Choice(name="ランダム通話: 開始/参加", value="match_start"),
        app_commands.Choice(name="ランダム通話: 終了/退出", value="match_stop"),
        app_commands.Choice(name="グローバルVC: 開始/参加", value="global_start"),
        app_commands.Choice(name="グローバルVC: 終了/退出", value="global_stop"),
    ]

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)

    async def _cog(self, interaction: discord.Interaction, key: str):
        cog = self.bot.get_cog(COGS[key])
        if cog is None:
            await Responder(interaction).send("⚠️ この機能はいま読み込まれていません。", ephemeral=True)
        return cog

    # ------------------------------------------------------------ 状態
    def status_embed(self, guild) -> discord.Embed:
        """このサーバーの VC を、どの機能が・誰の操作で使っているか。"""
        session = self.voice_sessions.get(guild.id)
        if session is not None:
            channel = guild.get_channel(session.channel_id) if session.channel_id else None
            channel_text = getattr(channel, "mention", None) or getattr(channel, "name", None) or "不明"
            embed = discord.Embed(title="🔊 ボイスチャンネルの使用状況", color=0x2ECC71)
            active = [session.feature, *session.shared_leases.keys()]
            embed.add_field(name="機能", value="、".join(feature_label(feature) for feature in active), inline=True)
            embed.add_field(name="開始した人", value=session.user_name, inline=True)
            embed.add_field(name="チャンネル", value=channel_text, inline=True)
            embed.add_field(name="経過時間", value=format_elapsed(time.time() - session.started_at), inline=True)
            hints = "\n".join(f"{feature_label(feature)}: `{stop_hint(feature)}`" for feature in active)
            embed.add_field(name="機能を個別に停止", value=hints, inline=False)
            embed.set_footer(text="音楽・GVC・読み上げ・文字起こしは同じVC接続を共有します。")
            return embed

        embed = discord.Embed(title="🔇 ボイスチャンネルの使用状況", color=0x95A5A6)
        voice_client = getattr(guild, "voice_client", None)
        if voice_client is not None:
            name = getattr(getattr(voice_client, "channel", None), "name", "不明")
            embed.description = f"Bot は **{name}** に接続していますが、使っている機能の記録がありません。`/voice` のパネルから退出できます。"
        else:
            embed.description = "いまはどの機能も使っていません。"
        saito = self.bot.get_cog(COGS["match"])
        if saito is not None and any(getattr(r.guild, "id", None) == guild.id for r in getattr(saito, "matching_queue", [])):
            embed.description += "\nランダム通話の相手を探しています（`/voice` のパネルから取り消し）。"
        return embed

    # ------------------------------------------------------------ 統合サブコマンド
    async def voice_connection(self, interaction: discord.Interaction, action: app_commands.Choice[str]):
        if action.value == "status":
            return await Responder(interaction).send(embed=self.status_embed(interaction.guild), ephemeral=True)
        cog = await self._cog(interaction, "music")
        if cog:
            if action.value == "join":
                await cog._join_impl(Responder(interaction))
            else:
                await cog._leave_impl(Responder(interaction))

    async def voice_studio(self, interaction: discord.Interaction, feature: app_commands.Choice[str],
                           action: app_commands.Choice[str],
                           delay: app_commands.Range[float, 0.1, 30.0] | None = None,
                           channel: discord.TextChannel | None = None, lyrics: str | None = None):
        key = feature.value
        valid = {
            "record": {"start", "stop", "status", "pitch"},
            "echo": {"start", "stop", "delay"},
            "transcribe": {"start", "stop"},
            "karaoke": {"start", "stop", "score"},
        }
        if action.value not in valid[key]:
            return await interaction.response.send_message("この機能では選択した操作を利用できません。機能と操作の組み合わせを確認してください。", ephemeral=True)
        cog_key = "record" if key == "echo" else key
        cog = await self._cog(interaction, cog_key)
        if not cog:
            return
        responder = Responder(interaction)
        if key == "record":
            await cog._record_impl(responder, action.value)
        elif key == "echo":
            await cog._echo_impl(responder, action.value, delay)
        elif key == "transcribe":
            await cog._transcribe_impl(responder, action.value, channel)
        else:
            await cog._karaoke_impl(responder, action.value, lyrics)

    async def voice_effects(self, interaction: discord.Interaction, action: app_commands.Choice[str],
                            pitch: app_commands.Range[float, -24.0, 24.0] | None = None,
                            buffer_ms: app_commands.Range[float, 20.0, 2000.0] | None = None,
                            max_ms: app_commands.Range[float, 20.0, 4000.0] | None = None):
        cog = await self._cog(interaction, "changer")
        if cog:
            await cog._changer_impl(Responder(interaction), action.value, pitch=pitch, buffer_ms=buffer_ms, max_ms=max_ms)

    async def voice_community(self, interaction: discord.Interaction, network: app_commands.Choice[str],
                              action: app_commands.Choice[str], room: str | None = None,
                              password: str | None = None):
        if network.value == "match":
            cog = await self._cog(interaction, "match")
            mapped = "start" if action.value == "start" else "stop"
            if cog:
                await cog._match_impl(Responder(interaction), mapped)
        else:
            cog = await self._cog(interaction, "global")
            mapped = "join" if action.value == "start" else "leave"
            if cog:
                await cog._global_impl(Responder(interaction), mapped, room, password)

    async def voice_tts(self, interaction: discord.Interaction, operation: str):
        cog = await self._cog(interaction, "tts")
        if not cog:
            return
        if operation == "start":
            await cog._start_impl(Responder(interaction), None)
        elif operation == "stop":
            await cog._stop_impl(Responder(interaction))
        elif operation == "say":
            await interaction.response.send_modal(TTSSayModal(cog))
        else:
            await interaction.response.send_modal(TTSSettingsModal(cog, interaction.user.id))

    @app_commands.command(name="vc", description="音楽・ボイス機能の操作パネルを表示します")
    async def vc(self, interaction: discord.Interaction):
        view = VoicePanelView(self)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def dispatch_voice_action(self, interaction: discord.Interaction, value: str,
                    delay: app_commands.Range[float, 0.1, 30.0] | None = None,
                    channel: discord.TextChannel | None = None, lyrics: str | None = None,
                    pitch: app_commands.Range[float, -24.0, 24.0] | None = None,
                    buffer_ms: app_commands.Range[float, 20.0, 2000.0] | None = None,
                    max_ms: app_commands.Range[float, 20.0, 4000.0] | None = None,
                    room: str | None = None, password: str | None = None):
        if value == "music_panel":
            cog = await self._cog(interaction, "music")
            if cog:
                await cog._panel_impl(Responder(interaction))
            return
        if value in {"join", "leave", "status"}:
            return await self.voice_connection(interaction, app_commands.Choice(name=value, value=value))
        if "_" not in value:
            return await Responder(interaction).send("操作を選択してください。", ephemeral=True)
        key, operation = value.rsplit("_", 1)
        if key in {"record", "echo", "transcribe", "karaoke"}:
            return await self.voice_studio(
                interaction, app_commands.Choice(name=key, value=key),
                app_commands.Choice(name=operation, value=operation), delay, channel, lyrics)
        if key == "tts":
            return await self.voice_tts(interaction, operation)
        if key == "changer":
            return await self.voice_effects(
                interaction, app_commands.Choice(name=operation, value=operation), pitch, buffer_ms, max_ms)
        return await self.voice_community(
            interaction, app_commands.Choice(name=key, value=key),
            app_commands.Choice(name=operation, value=operation), room, password)


class VoiceGenreSelect(discord.ui.Select):
    def __init__(self, hub: VoiceHub, selected: str | None = None):
        self.hub = hub
        super().__init__(placeholder="ジャンルを選択してください", options=[
            discord.SelectOption(label=label, description=description, value=value, default=value == selected)
            for value, (label, description) in VOICE_GENRES.items()
        ], row=0)

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        view: VoicePanelView = getattr(container, "panel", container)
        view.genre = self.values[0]
        view.action = None
        view.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(view))


class VoiceActionSelect(discord.ui.Select):
    def __init__(self, hub: VoiceHub, genre: str):
        self.hub = hub
        super().__init__(placeholder="機能を選択してください", options=[
            discord.SelectOption(label=label, value=value)
            for label, value in VOICE_ACTIONS_BY_GENRE[genre]
        ], row=1)

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]
        container = self.view
        panel = getattr(container, "panel", container)
        panel.action = value
        if getattr(panel, "shortcut_mode", False):
            if hasattr(container, "_sync"):
                container._sync()
                return await edit_panel_v2(interaction, container)
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        if value == "global_start":
            return await interaction.response.send_modal(GlobalRoomModal(self.hub))
        await self.hub.dispatch_voice_action(interaction, value)


class VoicePanelView(discord.ui.View):
    """引数を覚えなくてもボイス機能を選べるジャンル別操作パネル。"""

    def __init__(self, hub: VoiceHub, genre: str | None = None, shortcut_mode: bool = False,
                 shortcut_item: dict | None = None):
        super().__init__(timeout=900)
        self.hub = hub
        saved = (shortcut_item or {}).get("action", {})
        self.genre = genre or saved.get("genre")
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(VoiceGenreSelect(self.hub, self.genre))
        if self.genre:
            self.add_item(VoiceActionSelect(self.hub, self.genre))
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "vc", "genre": self.genre, "value": self.action}

    def embed(self):
        description = "ジャンルを選ぶと、その中の機能を選択できます。"
        if self.genre:
            description = f"**{VOICE_GENRES[self.genre][0]}** の機能を選択してください。"
        return discord.Embed(title="🔊 VC・音楽機能パネル", description=description, color=0xFFFFFF)


class GlobalRoomModal(discord.ui.Modal, title="グローバルVCに参加"):
    room = discord.ui.TextInput(label="ルーム名", placeholder="参加するルーム名", max_length=100)
    password = discord.ui.TextInput(label="パスワード（任意）", required=False, max_length=100)

    def __init__(self, hub: VoiceHub):
        super().__init__()
        self.hub = hub

    async def on_submit(self, interaction: discord.Interaction):
        await self.hub.dispatch_voice_action(
            interaction, "global_start", room=self.room.value, password=self.password.value or None
        )


# ====================================================================
# VOICEVOX 読み上げ（tts.quest v3 API）
#   https://github.com/ts-klassen/ttsQuestV3Voicevox
#
# スラッシュコマンドは増やさず、/vc パネルの「読み上げ」ジャンルから操作する。
#   開始 / 停止 / 話者・ピッチ・話速の設定（モーダル）/ 1回だけ読む（モーダル）
#
# 読み上げと音楽・グローバルVCは共通のPCMミキサーで同時に再生する。
# API には話者以外のパラメーターが無いので、ピッチと話速は FFmpeg 側で加工する。
# ====================================================================
logger = logging.getLogger(__name__)

TTS_API_BASE = "https://api.tts.quest/v3/voicevox"
# 任意。設定すると高速合成になる（https://su-shiki.com/api/ で VOICEVOX 用に取得）。
TTS_API_KEY = os.getenv("TTSQUEST_API_KEY")
TTS_DEFAULT_SPEAKER = 3          # ずんだもん（ノーマル）
TTS_MAX_CHARS = 300              # 1メッセージで読む最大文字数（超えた分は切り捨て）
TTS_CHUNK_CHARS = 100            # API へ 1 回で送る最大文字数（長文はここで分割）
TTS_QUEUE_MAX = 10               # 読み上げ待ちの上限（荒らし対策）
TTS_PITCH_RANGE = (-12.0, 12.0)  # 半音
TTS_SPEED_RANGE = (0.5, 2.0)
TTS_IGNORE_PREFIXES = ("/", ";", "；")  # これで始まる発言は読まない
TTS_SETTINGS_PATH = Path(os.getenv("TTS_SETTINGS_PATH", "data/tts_settings.json"))


class TTSError(Exception):
    pass


@dataclass
class TTSSettings:
    speaker: int = TTS_DEFAULT_SPEAKER
    pitch: float = 0.0   # 半音（-12〜+12）
    speed: float = 1.0   # 倍速（0.5〜2.0）


def _tempo_filters(tempo: float) -> list[str]:
    """atempo は 0.5〜2.0 の範囲なので、範囲外は連結して表現する。"""
    filters: list[str] = []
    while tempo > 2.0:
        filters.append("atempo=2.0")
        tempo /= 2.0
    while tempo < 0.5:
        filters.append("atempo=0.5")
        tempo /= 0.5
    filters.append(f"atempo={tempo:.6f}")
    return filters


def build_tts_filters(pitch: float, speed: float) -> str:
    """ピッチ（半音）と話速から FFmpeg の -af 文字列を作る。何も要らなければ空文字。

    asetrate でピッチ（と速度）を変え、atempo で速度だけを元に戻す。
    """
    factor = 2 ** (pitch / 12) if abs(pitch) >= 0.01 else 1.0
    filters: list[str] = []
    if factor != 1.0:
        filters += ["aresample=48000", f"asetrate={round(48000 * factor)}", "aresample=48000"]
    tempo = speed / factor
    if abs(tempo - 1.0) >= 0.001:
        filters += _tempo_filters(tempo)
    return ",".join(filters)


def split_tts_text(text: str, limit: int = TTS_CHUNK_CHARS) -> list[str]:
    """句点・改行を優先して limit 文字以内に分ける。"""
    chunks: list[str] = []
    current = ""
    for part in re.split(r"(?<=[。！？!?\n])", text[:TTS_MAX_CHARS]):
        part = part.strip()
        if not part:
            continue
        while len(part) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(part[:limit])
            part = part[limit:]
        if len(current) + len(part) <= limit:
            current += part
        else:
            chunks.append(current)
            current = part
    if current:
        chunks.append(current)
    return chunks


def clean_message_text(message: discord.Message) -> str:
    """発言を読み上げ向けに整える（メンション→名前、URL・絵文字・コードは置き換え）。"""
    text = message.clean_content
    text = re.sub(r"```.*?```", "コード省略", text, flags=re.DOTALL)
    text = re.sub(r"\|\|.*?\|\|", "ネタバレ", text, flags=re.DOTALL)
    text = re.sub(r"https?://\S+", "URL", text)
    text = re.sub(r"<a?:\w+:\d+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text and message.attachments:
        text = "添付ファイル"
    return text


class TTSCog(commands.Cog):
    """VOICEVOX 読み上げ。スラッシュコマンドは持たず、VoiceHub の /vc パネルから呼ばれる。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self.settings: dict[int, TTSSettings] = {}
        self.read_channels: dict[int, int] = {}            # guild_id -> 読み上げ対象のテキストチャンネル
        self.queues: dict[int, asyncio.Queue] = {}
        self.workers: dict[int, asyncio.Task] = {}
        self._speakers: list | None = None
        self._session: aiohttp.ClientSession | None = None
        self._load_settings()

    async def cog_unload(self):
        for task in list(self.workers.values()):
            task.cancel()
        if self._session is not None and not self._session.closed:
            await self._session.close()

    # ------------------------------------------------------------ 設定
    def _load_settings(self):
        try:
            raw = json.loads(TTS_SETTINGS_PATH.read_text(encoding="utf-8"))
            for user_id, value in raw.items():
                self.settings[int(user_id)] = TTSSettings(
                    speaker=int(value.get("speaker", TTS_DEFAULT_SPEAKER)),
                    pitch=float(value.get("pitch", 0.0)),
                    speed=float(value.get("speed", 1.0)),
                )
        except FileNotFoundError:
            pass
        except Exception:
            logger.exception("TTS設定の読み込みに失敗しました")

    def _save_settings(self):
        try:
            TTS_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = TTS_SETTINGS_PATH.with_suffix(".tmp")
            tmp.write_text(
                json.dumps({str(uid): asdict(cfg) for uid, cfg in self.settings.items()}, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(TTS_SETTINGS_PATH)
        except Exception:
            logger.exception("TTS設定の保存に失敗しました")

    def get_settings(self, user_id: int) -> TTSSettings:
        return self.settings.get(user_id) or TTSSettings()

    async def _speaker_name(self, speaker: int) -> str:
        speakers = await self._load_speakers()
        if 0 <= speaker < len(speakers) and speakers[speaker]:
            return str(speakers[speaker])
        return f"話者ID {speaker}"

    async def _apply_config(self, user_id: int, speaker: int | None, pitch: float | None,
                            speed: float | None) -> str:
        """設定を検証して保存し、確認メッセージを返す。不正値は ValueError。"""
        cfg = TTSSettings(**asdict(self.get_settings(user_id)))
        if speaker is not None:
            speakers = await self._load_speakers()
            if speakers and not (0 <= speaker < len(speakers) and speakers[speaker]):
                raise ValueError(f"話者ID {speaker} は使えません。設定画面では名前の一部（例: ずんだ）でも指定できます。")
            if speaker < 0:
                raise ValueError("話者IDは0以上で指定してください。")
            cfg.speaker = speaker
        if pitch is not None:
            if not TTS_PITCH_RANGE[0] <= pitch <= TTS_PITCH_RANGE[1]:
                raise ValueError(f"ピッチは {TTS_PITCH_RANGE[0]:g}〜{TTS_PITCH_RANGE[1]:g}（半音）で指定してください。")
            cfg.pitch = pitch
        if speed is not None:
            if not TTS_SPEED_RANGE[0] <= speed <= TTS_SPEED_RANGE[1]:
                raise ValueError(f"話速は {TTS_SPEED_RANGE[0]:g}〜{TTS_SPEED_RANGE[1]:g} で指定してください。")
            cfg.speed = speed
        self.settings[user_id] = cfg
        self._save_settings()
        return (f"🗣️ 読み上げ設定\n話者: **{await self._speaker_name(cfg.speaker)}**（ID {cfg.speaker}）\n"
                f"ピッチ: **{cfg.pitch:+g}** 半音 / 話速: **{cfg.speed:g}** 倍")

    # ------------------------------------------------------------ API
    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        return self._session

    async def _load_speakers(self) -> list:
        if self._speakers is not None:
            return self._speakers
        try:
            session = await self._get_session()
            async with session.get(f"{TTS_API_BASE}/speakers_array") as resp:
                data = await resp.json(content_type=None)
            speakers = data.get("speakers")
            if isinstance(speakers, list):
                self._speakers = speakers
        except Exception:
            logger.warning("話者一覧を取得できませんでした", exc_info=True)
        return self._speakers or []

    async def _synthesize(self, text: str, speaker: int) -> str:
        """合成して mp3 を一時ファイルに保存し、そのパスを返す。"""
        session = await self._get_session()
        params = {"speaker": speaker, "text": text}
        if TTS_API_KEY:
            params["key"] = TTS_API_KEY

        data: dict = {}
        for _ in range(3):
            async with session.get(f"{TTS_API_BASE}/synthesis", params=params) as resp:
                data = await resp.json(content_type=None)
            if data.get("success"):
                break
            if data.get("retryAfter"):  # 429: 指定秒数待って再送
                await asyncio.sleep(min(float(data["retryAfter"]), 10.0))
                continue
            raise TTSError(str(data.get("errorMessage") or data))
        else:
            raise TTSError("tts.quest がビジー状態です。少し待ってからもう一度お試しください。")

        for _ in range(60):  # 合成完了待ち（最大約30秒）
            async with session.get(data["audioStatusUrl"]) as resp:
                status = await resp.json(content_type=None)
            if status.get("isAudioError"):
                raise TTSError(f"合成に失敗しました: {status.get('status')}")
            if status.get("isAudioReady"):
                break
            await asyncio.sleep(0.5)
        else:
            raise TTSError("合成がタイムアウトしました。")

        audio = None
        for _ in range(5):
            async with session.get(data["mp3DownloadUrl"]) as resp:
                if resp.status == 200:
                    audio = await resp.read()
                    break
            await asyncio.sleep(0.4)
        if audio is None:
            raise TTSError("音声ファイルを取得できませんでした。")

        fd, path = tempfile.mkstemp(prefix="tts_", suffix=".mp3")
        with os.fdopen(fd, "wb") as fh:
            fh.write(audio)
        return path

    async def _synthesize_all(self, text: str, speaker: int) -> list[str]:
        chunks = split_tts_text(text)
        results = await asyncio.gather(*(self._synthesize(c, speaker) for c in chunks), return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        if errors:
            for r in results:
                if isinstance(r, str):
                    self._remove(r)
            raise errors[0]
        return list(results)

    @staticmethod
    def _remove(path: str):
        try:
            os.unlink(path)
        except OSError:
            pass

    # ------------------------------------------------------------ 再生
    async def _play_file(self, vc: discord.VoiceClient, path: str, cfg: TTSSettings):
        options = "-vn -ar 48000 -ac 2"
        filters = build_tts_filters(cfg.pitch, cfg.speed)
        if filters:
            options += f" -af {shlex.quote(filters)}"
        source = discord.FFmpegPCMAudio(path, options=options)

        loop = asyncio.get_running_loop()
        done: asyncio.Future = loop.create_future()

        def after(error):
            loop.call_soon_threadsafe(lambda: done.done() or done.set_result(error))

        add_audio_source(vc, "tts", source, after=after)
        try:
            error = await asyncio.wait_for(done, timeout=120)
            if error:
                logger.warning("TTS再生エラー: %s", error)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            remove_audio_source(vc, "tts")
            raise

    async def enqueue(self, guild: discord.Guild, text: str, user_id: int) -> bool:
        queue = self.queues.setdefault(guild.id, asyncio.Queue(maxsize=TTS_QUEUE_MAX))
        try:
            queue.put_nowait((text, TTSSettings(**asdict(self.get_settings(user_id)))))
        except asyncio.QueueFull:
            return False
        worker = self.workers.get(guild.id)
        if worker is None or worker.done():
            self.workers[guild.id] = asyncio.create_task(self._worker(guild))
        return True

    async def _worker(self, guild: discord.Guild):
        """キューを順に読み上げ、音楽/GVCとは共有ミキサー上で重ねて再生する。"""
        queue = self.queues[guild.id]
        try:
            while not queue.empty():
                text, cfg = queue.get_nowait()
                vc = guild.voice_client
                if vc is None or not vc.is_connected():
                    while not queue.empty():
                        queue.get_nowait()
                    break
                try:
                    paths = await self._synthesize_all(text, cfg.speaker)
                except Exception as exc:
                    logger.warning("TTS合成に失敗: %s", exc)
                    continue
                try:
                    for path in paths:
                        await self._play_file(vc, path, cfg)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("TTS再生に失敗")
                finally:
                    for path in paths:
                        self._remove(path)
        finally:
            if self.read_channels.get(guild.id) is None:
                await self.voice_sessions.release(guild.id, "tts", reason="stop")

    # ------------------------------------------------------------ 読み上げ対象の発言
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        guild = message.guild
        if guild is None or message.author.bot:
            return
        if self.read_channels.get(guild.id) != message.channel.id:
            return
        vc = guild.voice_client
        if vc is None or not vc.is_connected():
            self.read_channels.pop(guild.id, None)
            return
        # VC にいない人の発言は読まない（Bot と同じ VC にいる人だけ）
        voice = getattr(message.author, "voice", None)
        if voice is None or voice.channel != vc.channel:
            return
        if message.content.startswith(TTS_IGNORE_PREFIXES):
            return
        text = clean_message_text(message)
        if text:
            await self.enqueue(guild, text, message.author.id)

    # ------------------------------------------------------------ 実装（/voice パネルからも呼ぶ）
    async def _ensure_connection(self, r: Responder) -> str | None:
        """TTSの独立したリースを取得。既存の共有機能には同じVCで合流する。"""
        guild = r.guild
        if guild is None:
            return "サーバーの中で実行してください。"
        vc = getattr(guild, "voice_client", None)
        channel = getattr(vc, "channel", None) if vc is not None and vc.is_connected() else None
        if channel is None:
            voice = getattr(r.user, "voice", None)
            channel = getattr(voice, "channel", None)
        if channel is None:
            return "先にボイスチャンネルに参加してください。"
        try:
            await self.voice_sessions.acquire(
                guild, channel, "tts", r.user, cleanup=self._cleanup_tts(guild.id),
                text_channel=r.channel, force=False,
            )
        except VoiceBusy as busy:
            return str(busy)
        except Exception as exc:
            logger.exception("TTS voice-session acquisition failed")
            return f"ボイスチャンネルへ接続できませんでした: {exc}"
        return None

    def _cleanup_tts(self, guild_id: int):
        def cleanup(reason: str) -> None:
            self.read_channels.pop(guild_id, None)
            queue = self.queues.get(guild_id)
            if queue is not None:
                while not queue.empty():
                    queue.get_nowait()
            guild = self.bot.get_guild(guild_id)
            vc = getattr(guild, "voice_client", None) if guild else None
            if vc is not None:
                remove_audio_source(vc, "tts")
            worker = self.workers.get(guild_id)
            if worker is not None and worker is not asyncio.current_task() and not worker.done():
                worker.cancel()
        return cleanup

    async def _start_impl(self, r: Responder, channel: discord.abc.Messageable | None = None):
        await r.defer()
        if error := await self._ensure_connection(r):
            return await r.send(error, ephemeral=True)
        target = channel or r.channel
        self.read_channels[r.guild.id] = target.id
        cfg = self.get_settings(r.user.id)
        await r.send(
            f"<#{target.id}>の発言を読み上げます（VC にいる人だけ）。\n"
            f"話者: **{await self._speaker_name(cfg.speaker)}** / ピッチ {cfg.pitch:+g} / 話速 {cfg.speed:g}倍\n"
        )

    async def _stop_impl(self, r: Responder):
        guild_id = r.guild.id
        was_active = self.read_channels.pop(guild_id, None) is not None
        queue = self.queues.get(guild_id)
        if queue is not None:
            while not queue.empty():
                queue.get_nowait()
        worker = self.workers.get(guild_id)
        if worker is not None and not worker.done():
            worker.cancel()
            was_active = True
        guild = r.guild
        vc = getattr(guild, "voice_client", None) if guild else None
        if vc is not None:
            remove_audio_source(vc, "tts")
        await self.voice_sessions.release(guild_id, "tts", reason="stop")
        if was_active:
            await r.send("🔇 読み上げを停止しました。VC には残っています（退出は `/vc` →「VC接続」の退出）。")
        else:
            await r.send("読み上げは開始されていません。", ephemeral=True)

    async def _say_impl(self, r: Responder, text: str):
        """入力した文章を、自分の設定で1回だけ読み上げる。"""
        text = text.strip()
        if not text:
            return await r.send("⚠️ 読み上げる文章を入力してください。", ephemeral=True)
        await r.defer()
        if error := await self._ensure_connection(r):
            return await r.send(error, ephemeral=True)
        if not await self.enqueue(r.guild, text, r.user.id):
            return await r.send("読み上げ待ちがいっぱいです。少し待ってからもう一度どうぞ。", ephemeral=True)
        cfg = self.get_settings(r.user.id)
        await r.send(f"🗣️ 読み上げます（{await self._speaker_name(cfg.speaker)}）", ephemeral=True)

    async def _resolve_speaker(self, value: str) -> int:
        """話者ID（数字）または名前の一部から話者IDを決める。決められなければ ValueError。"""
        value = value.strip()
        if value.isdigit():
            return int(value)
        speakers = await self._load_speakers()
        if not speakers:
            raise ValueError("話者一覧を取得できませんでした。話者IDを数字で入力してください。")
        matches = [(i, str(n)) for i, n in enumerate(speakers) if n and value.lower() in str(n).lower()]
        if not matches:
            raise ValueError(f"「{value}」に当てはまる話者がいません。")
        if len(matches) == 1:
            return matches[0][0]
        listing = "\n".join(f"`{i}` {n}" for i, n in matches[:25])
        more = f"\n…ほか {len(matches) - 25} 件" if len(matches) > 25 else ""
        raise ValueError(f"「{value}」は {len(matches)} 件あります。IDで指定してください。\n{listing}{more}")


class TTSSettingsModal(discord.ui.Modal, title="読み上げ設定"):
    speaker = discord.ui.TextInput(label="話者（IDか名前の一部。例: 3 / ずんだ）", max_length=40)
    pitch = discord.ui.TextInput(label="ピッチ（半音 -12〜12、0が標準）", max_length=6)
    speed = discord.ui.TextInput(label="話速（0.5〜2.0、1.0が標準）", max_length=5)

    def __init__(self, cog: TTSCog, user_id: int):
        super().__init__()
        self.cog = cog
        cfg = cog.get_settings(user_id)
        self.speaker.default = str(cfg.speaker)
        self.pitch.default = f"{cfg.pitch:g}"
        self.speed.default = f"{cfg.speed:g}"

    async def on_submit(self, interaction: discord.Interaction):
        r = Responder(interaction)
        try:
            speaker = await self.cog._resolve_speaker(self.speaker.value)
            pitch = float(self.pitch.value)
            speed = float(self.speed.value)
            message = await self.cog._apply_config(interaction.user.id, speaker, pitch, speed)
        except ValueError as exc:
            text = str(exc)
            if text.startswith("could not convert"):
                text = "ピッチと話速は数値で入力してください。"
            return await r.send(f"⚠️ {text}", ephemeral=True)
        await r.send(message, ephemeral=True)


class TTSSayModal(discord.ui.Modal, title="1回だけ読み上げ"):
    text = discord.ui.TextInput(label="読み上げる文章", style=discord.TextStyle.paragraph,
                                max_length=TTS_MAX_CHARS)

    def __init__(self, cog: TTSCog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog._say_impl(Responder(interaction), self.text.value)


async def setup(bot: commands.Bot):
    await bot.add_cog(VoiceHub(bot))
    await bot.add_cog(TTSCog(bot))
