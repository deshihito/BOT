from __future__ import annotations
import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
import aiohttp
import discord
from discord import app_commands
from discord.ext import commands
try:
    import encodec
    import soundfile as sf
    import torch

    # CPU 推論はスレッドを増やしすぎると逆に遅くなることがある。上限を絞る。
    torch.set_num_threads(min(4, os.cpu_count() or 4))

    VOICE_TRIGGER_AVAILABLE = True
except Exception:  # ImportError だけでなく共有ライブラリ不整合 (OSError) 等も捕捉
    encodec = None
    sf = None
    torch = None
    VOICE_TRIGGER_AVAILABLE = False
    logging.getLogger(__name__).warning(
        "EnCodec/torch/soundfile を読み込めなかったため、音声トリガー機能は無効になります",
        exc_info=True,
    )
from core import action_usage, usage_stats
from core.legacy import Responder
from core.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.voice_media import add_audio_source, remove_audio_source
from core.panel_v2 import as_panel_v2, edit_panel_v2

from core.voice.common import *  # noqa: F401,F403 - shared constants

logger = logging.getLogger("cogs.sio_voice")


VOICE_TRIGGER_DIR = Path(os.getenv("VOICE_TRIGGER_DIR", "data/voice_triggers"))


VOICE_TRIGGER_MAX_SECONDS = 5.0


VOICE_TRIGGER_MAX_PER_GUILD = 10


VOICE_TRIGGER_SAMPLE_RATE = 24000


VOICE_TRIGGER_BANDWIDTH = 6.0


_ENCODEC_MODEL = None


class VoiceTriggerError(Exception):
    pass


def _get_encodec_model():
    global _ENCODEC_MODEL
    if _ENCODEC_MODEL is None:
        if not VOICE_TRIGGER_AVAILABLE:
            raise VoiceTriggerError("EnCodec が利用できません。")
        model = encodec.EncodecModel.encodec_model_24khz()
        model.set_target_bandwidth(VOICE_TRIGGER_BANDWIDTH)
        model.eval()
        _ENCODEC_MODEL = model
    return _ENCODEC_MODEL


def _trim_to_wav(src_path: str, dst_path: str, max_seconds: float = VOICE_TRIGGER_MAX_SECONDS):
    cmd = [
        "ffmpeg", "-y", "-i", src_path,
        "-t", str(max_seconds),
        "-ar", str(VOICE_TRIGGER_SAMPLE_RATE), "-ac", "1",
        "-f", "wav", dst_path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise VoiceTriggerError("音声の変換に失敗しました。対応形式か確認してください。")


def _encodec_compress(wav_path: str, ecdc_path: str):
    if not VOICE_TRIGGER_AVAILABLE:
        raise VoiceTriggerError("EnCodec が利用できません。")
    model = _get_encodec_model()
    data, sr = sf.read(wav_path, dtype="float32", always_2d=True)
    if sr != VOICE_TRIGGER_SAMPLE_RATE:
        raise VoiceTriggerError("サンプルレートが不正です。")
    wav = torch.from_numpy(data.T).unsqueeze(0)
    with torch.no_grad():
        frames = model.encode(wav)
    with open(ecdc_path, "wb") as fh:
        torch.save(frames, fh)


def _encodec_decompress(ecdc_path: str, wav_path: str):
    if not VOICE_TRIGGER_AVAILABLE:
        raise VoiceTriggerError("EnCodec が利用できません。")
    model = _get_encodec_model()
    with open(ecdc_path, "rb") as fh:
        frames = torch.load(fh, map_location="cpu")
    with torch.no_grad():
        wav = model.decode(frames)
    audio = wav.squeeze(0).cpu().numpy().T
    sf.write(wav_path, audio, VOICE_TRIGGER_SAMPLE_RATE)


class VoiceTriggerCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.voice_sessions = get_manager(bot)
        self.triggers: dict[int, dict[str, dict]] = {}
        if VOICE_TRIGGER_AVAILABLE:
            self._load()
        else:
            logger.warning("音声トリガー機能は無効です（encodec / torch / soundfile が未導入）")

    async def cog_load(self):
        """起動直後に EnCodec モデルをウォームアップし、初回再生の待ちをなくす。"""
        if not VOICE_TRIGGER_AVAILABLE:
            return
        try:
            await asyncio.to_thread(_get_encodec_model)
            logger.info("EnCodec モデルをウォームアップしました")
        except Exception:
            logger.exception("EnCodec モデルのウォームアップに失敗")

    def _guild_dir(self, guild_id: int) -> Path:
        path = VOICE_TRIGGER_DIR / str(guild_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _meta_path(self, guild_id: int) -> Path:
        return self._guild_dir(guild_id) / "meta.json"

    def _load(self):
        if not VOICE_TRIGGER_DIR.exists():
            return
        try:
            entries = list(VOICE_TRIGGER_DIR.iterdir())
        except OSError:
            logger.exception("音声トリガーディレクトリの読み込みに失敗しました")
            return
        for guild_dir in entries:
            if not guild_dir.is_dir():
                continue
            try:
                guild_id = int(guild_dir.name)
            except ValueError:
                continue
            meta_path = guild_dir / "meta.json"
            if meta_path.exists():
                try:
                    self.triggers[guild_id] = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    logger.exception("トリガー設定の読み込みに失敗 (guild=%s)", guild_id)

    def _save(self, guild_id: int):
        self._meta_path(guild_id).write_text(
            json.dumps(self.triggers.get(guild_id, {}), ensure_ascii=False),
            encoding="utf-8",
        )

    async def register(self, guild: discord.Guild, word: str, attachment: discord.Attachment,
                       user: discord.abc.User) -> str:
        if not VOICE_TRIGGER_AVAILABLE:
            raise VoiceTriggerError(
                "音声トリガー機能が利用できません。encodec / torch / soundfile の導入を確認してください。"
            )
        word = word.strip()
        if not word:
            raise VoiceTriggerError("トリガー単語を入力してください。")
        if len(word) > 50:
            raise VoiceTriggerError("トリガー単語は 50 文字以内にしてください。")
        if any(c in word for c in "/\\\x00") or word in {".", ".."}:
            raise VoiceTriggerError("トリガー単語に / や \\ は使えません。")

        current = self.triggers.setdefault(guild.id, {})
        if word not in current and len(current) >= VOICE_TRIGGER_MAX_PER_GUILD:
            raise VoiceTriggerError(f"登録できるのはギルドあたり {VOICE_TRIGGER_MAX_PER_GUILD} 個までです。")

        gdir = self._guild_dir(guild.id)
        src = gdir / f"tmp_{attachment.id}_{attachment.filename}"
        wav = gdir / f"tmp_{attachment.id}.wav"
        ecdc = gdir / f"{word}.ecdc"

        try:
            await attachment.save(src)
            await asyncio.to_thread(_trim_to_wav, str(src), str(wav))
            await asyncio.to_thread(_encodec_compress, str(wav), str(ecdc))
        except VoiceTriggerError:
            raise
        except Exception as exc:
            logger.exception("音声トリガー登録に失敗")
            raise VoiceTriggerError(f"登録処理に失敗しました: {exc}") from exc
        finally:
            for p in (src, wav):
                try:
                    p.unlink()
                except OSError:
                    logger.debug("音声トリガー: 一時ファイルの削除に失敗しました", exc_info=True)

        current[word] = {
            "ecdc": str(ecdc),
            "registered_by": user.id,
            "registered_at": time.time(),
        }
        self._save(guild.id)
        return f"「{word}」を登録しました（EnCodec 6kbps）。"

    async def unregister(self, guild: discord.Guild, word: str) -> str:
        current = self.triggers.get(guild.id, {})
        meta = current.pop(word, None)
        if meta is None:
            raise VoiceTriggerError("その単語は登録されていません。")
        try:
            Path(meta["ecdc"]).unlink()
        except OSError:
            logger.debug("音声トリガー: 登録ファイルの削除に失敗しました", exc_info=True)
        self._save(guild.id)
        return f"「{word}」の登録を解除しました。"

    def list_triggers(self, guild_id: int) -> dict[str, dict]:
        return dict(self.triggers.get(guild_id, {}))

    async def _play(self, guild: discord.Guild, meta: dict):
        if not VOICE_TRIGGER_AVAILABLE:
            return
        vc = guild.voice_client
        if vc is None or not vc.is_connected():
            return

        gdir = self._guild_dir(guild.id)
        stamp = int(time.time() * 1000)
        wav = gdir / f"play_{stamp}.wav"
        try:
            await asyncio.to_thread(_encodec_decompress, meta["ecdc"], str(wav))
            # MP3 変換を挟まず WAV を直接再生する（ffmpeg 呼び出しを1回減らす）
            source = discord.FFmpegPCMAudio(str(wav))
            loop = asyncio.get_running_loop()
            done: asyncio.Future = loop.create_future()

            def after(error):
                loop.call_soon_threadsafe(lambda: done.done() or done.set_result(error))

            add_audio_source(vc, "trigger", source, after=after)
            try:
                await asyncio.wait_for(done, timeout=30)
            except asyncio.TimeoutError:
                remove_audio_source(vc, "trigger")
        finally:
            try:
                wav.unlink()
            except OSError:
                logger.debug("音声トリガー: 再生用一時ファイルの削除に失敗しました", exc_info=True)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not VOICE_TRIGGER_AVAILABLE:
            return
        if message.guild is None or message.author.bot:
            return
        triggers = self.triggers.get(message.guild.id)
        if not triggers:
            return
        for word in sorted(triggers, key=len, reverse=True):
            if word in message.content:
                await self._play(message.guild, triggers[word])
                return


_AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".opus", ".webm")


async def _scan_recent_audios(
    bot: commands.Bot, channel: discord.abc.Messageable, limit: int = 50, max_results: int = 25
) -> list[tuple[discord.Message, discord.Attachment]]:
    """チャンネル内の直近メッセージから音声ファイルを抽出する。"""
    results: list[tuple[discord.Message, discord.Attachment]] = []
    try:
        async for msg in channel.history(limit=limit):
            if msg.author.id == bot.user.id:
                continue
            for att in msg.attachments:
                ct = (att.content_type or "").lower()
                if ct.startswith("audio/") or att.filename.lower().endswith(_AUDIO_EXTS):
                    results.append((msg, att))
                    break
            if len(results) >= max_results:
                break
    except Exception:
        logger.exception("音声メッセージのスキャンに失敗")
    return results


class VoiceTriggerPickAudioSelect(discord.ui.Select):
    def __init__(self, cog: VoiceTriggerCog, audios: list[tuple[discord.Message, discord.Attachment]]):
        self.cog = cog
        options: list[discord.SelectOption] = []
        for msg, att in audios[:25]:
            size_kb = max(1, att.size // 1024)
            try:
                when = msg.created_at.astimezone().strftime("%m/%d %H:%M")
            except Exception:
                when = ""
            options.append(
                discord.SelectOption(
                    label=att.filename[:100],
                    description=f"{msg.author.display_name} • {size_kb}KB • {when}",
                    value=f"{msg.channel.id}:{msg.id}:{att.id}",
                )
            )
        super().__init__(placeholder="登録する音声を選択", options=options)

    async def callback(self, interaction: discord.Interaction):
        try:
            ch_id, msg_id, att_id = self.values[0].split(":")
            channel = self.cog.bot.get_channel(int(ch_id))
            if channel is None:
                channel = await self.cog.bot.fetch_channel(int(ch_id))
            msg = await channel.fetch_message(int(msg_id))
            attachment = next((a for a in msg.attachments if a.id == int(att_id)), None)
            if attachment is None:
                return await interaction.response.send_message(
                    "音声ファイルが見つかりません。", ephemeral=True
                )
        except Exception as exc:
            logger.exception("音声ファイルの取得に失敗")
            return await interaction.response.send_message(
                f"⚠️ 音声ファイルを取得できませんでした: {exc}", ephemeral=True
            )

        await interaction.response.send_modal(VoiceTriggerWordModal(self.cog, attachment))


class VoiceTriggerWordModal(discord.ui.Modal, title="トリガー単語を入力"):
    word = discord.ui.TextInput(label="トリガー単語", max_length=50)

    def __init__(self, cog: VoiceTriggerCog, attachment: discord.Attachment):
        super().__init__()
        self.cog = cog
        self.attachment = attachment

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            msg = await self.cog.register(
                interaction.guild, self.word.value, self.attachment, interaction.user
            )
        except Exception as exc:
            return await interaction.followup.send(f"⚠️ {exc}", ephemeral=True)
        await interaction.followup.send(msg, ephemeral=True)


class VoiceTriggerRegisterView(discord.ui.LayoutView):
    def __init__(self, cog: VoiceTriggerCog, audios: list[tuple[discord.Message, discord.Attachment]]):
        super().__init__(timeout=300)

        if not VOICE_TRIGGER_AVAILABLE:
            self.add_item(
                discord.ui.Container(
                    discord.ui.TextDisplay(
                        "## ⚠️ 音声トリガー機能は利用できません\n"
                        "`encodec` / `torch` / `soundfile` の読み込みに失敗しています。"
                    ),
                    accent_colour=0xE74C3C,
                )
            )
            return

        head = (
            "## 🎤 音声トリガー登録\n"
            "このチャンネルの直近メッセージから音声ファイルを選んで登録できます。\n"
            "5秒にトリミングされ、EnCodec 6kbps で圧縮されます。"
        )
        children: list[discord.ui.Item] = [discord.ui.TextDisplay(head)]

        if audios:
            children.append(discord.ui.Separator())
            children.append(
                discord.ui.TextDisplay(
                    f"### 直近の音声ファイル ({len(audios)}件)\n"
                    "-# ドロップダウンから選択してください。"
                )
            )
            children.append(discord.ui.ActionRow(VoiceTriggerPickAudioSelect(cog, audios)))
        else:
            children.append(discord.ui.Separator())
            children.append(
                discord.ui.TextDisplay(
                    "⚠️ このチャンネルに音声ファイルが見つかりませんでした。\n\n"
                    "**登録方法**\n"
                    "音声ファイル（5秒以内）をこのチャンネルに送信してから、もう一度 `/vc` →「音声トリガー」→「トリガー登録」を開くと、"
                    "その音声が候補に表示されます。"
                )
            )

        self.add_item(discord.ui.Container(*children, accent_colour=0xF1C40F))


class VoiceTriggerDeleteSelect(discord.ui.Select):
    def __init__(self, parent: "VoiceTriggerManageView", words: list[str]):
        self.parent_view = parent
        super().__init__(
            placeholder="削除するトリガーを選択",
            options=[discord.SelectOption(label=w[:100], value=w[:100]) for w in words[:25]],
        )

    async def callback(self, interaction: discord.Interaction):
        try:
            from cogs.support import get_voice_trigger_settings
            from core import guild_settings

            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_voice_trigger_settings(store, interaction.guild_id)
            if settings["permission"] == "admin":
                perms = getattr(interaction.user, "guild_permissions", None)
                if not getattr(perms, "administrator", False):
                    return await interaction.response.send_message(
                        "このサーバーでは管理者のみ操作できます。", ephemeral=True
                    )
        except Exception:
            logger.exception("音声トリガー権限チェックに失敗しました")

        word = self.values[0]
        try:
            msg = await self.parent_view.cog.unregister(interaction.guild, word)
        except Exception as exc:
            return await interaction.response.send_message(f"⚠️ {exc}", ephemeral=True)

        self.parent_view._build()
        await interaction.response.edit_message(view=self.parent_view)
        await interaction.followup.send(msg, ephemeral=True)


class VoiceTriggerManageView(discord.ui.LayoutView):
    def __init__(self, cog: VoiceTriggerCog, guild_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self._build()

    def _build(self):
        self.clear_items()

        if not VOICE_TRIGGER_AVAILABLE:
            self.add_item(
                discord.ui.Container(
                    discord.ui.TextDisplay(
                        "## ⚠️ 音声トリガー機能は利用できません\n"
                        "`encodec` / `torch` / `soundfile` の読み込みに失敗しています。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"
                    ),
                    accent_colour=0xE74C3C,
                )
            )
            return

        triggers = self.cog.list_triggers(self.guild_id)
        if not triggers:
            self.add_item(
                discord.ui.Container(
                    discord.ui.TextDisplay(
                        "## 🎤 音声トリガー\n"
                        "登録されているトリガーはありません。\n\n"
                        "**登録方法**: `/vc` →「音声トリガー」→「トリガー登録（このチャンネルの音声から選ぶ）」"
                        "で、チャンネル内の音声から選んで登録できます。"
                    ),
                    accent_colour=0xF1C40F,
                )
            )
            return

        lines = "\n".join(f"• `{w}`" for w in triggers)
        children = [
            discord.ui.TextDisplay(
                f"## 🎤 音声トリガー\n"
                f"**登録済み ({len(triggers)}/{VOICE_TRIGGER_MAX_PER_GUILD})**\n{lines}"
            ),
            discord.ui.Separator(),
            discord.ui.TextDisplay(
                "-# トリガー単語がテキストに含まれると、登録した音声が再生されます。"
            ),
            discord.ui.ActionRow(VoiceTriggerDeleteSelect(self, list(triggers))),
        ]
        self.add_item(discord.ui.Container(*children, accent_colour=0xF1C40F))
