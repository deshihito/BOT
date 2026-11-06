from __future__ import annotations
import logging
import threading
import time
import numpy as np
import discord
import discord.opus
from discord.ext import commands
from discord.ext import voice_recv
from core.legacy import Responder
from core.voice import vc_feature_restore
from core.messages import VOICE_NOT_JOINED, voice_connection_failed
from core.voice.voice_session import VoiceBusy, get_manager
from core.emojis import CLOCK, FAILED, MUSIC, PAUSE, THU
from functools import partial as _partial

from core.voice.voicechanger.common import *  # noqa: F401,F403 - shared constants/helpers
from core.voice.voicechanger.common import DEFAULT_TARGET_BUFFER_MS, we  # noqa: F401
from core.voice.voicechanger.sink import VoiceChangerSink  # noqa: F401

logger = logging.getLogger("cogs.sio_voicechanger")


class SessionMixin:
    async def _changer_impl(self, r: Responder, action: str, pitch: float | None = None,
                            buffer_ms: float | None = None, max_ms: float | None = None):
        """action: start / status / stop

        pitch・buffer_ms・max_ms を付けると、動作中ならその設定を変える（start でも status でも）。
        """
        guild_id = r.guild.id
        session = self.vc_sessions.get(guild_id)
        has_options = pitch is not None or buffer_ms is not None or max_ms is not None

        if action == "stop":
            if session is None:
                return await r.send(embed=we(f"{FAILED} ボイスチェンジャーは実行されていません。"), ephemeral=True)
            if not await self.voice_sessions.release(guild_id, "changer", reason="stop"):
                self._cleanup(guild_id)("stop")
            return await r.send(embed=we("🛑 ボイスチェンジャーを停止しました。"))

        if action == "start" and session is None:
            return await self._start(r, pitch, buffer_ms, max_ms)

        if has_options:
            if session is None:
                return await r.send(embed=we(f"{FAILED} ボイスチェンジャーが開始されていません。"), ephemeral=True)
            return await self._apply(r, session, pitch, buffer_ms, max_ms)

        if action == "start":
            return await r.send(embed=we(
                f"{FAILED} 既にボイスチェンジャーが実行中です。設定を変えるときは `pitch` や `buffer_ms` を付けてください。"
            ), ephemeral=True)
        await self._send_status(r, session)


    @staticmethod
    def _resolve_buffer(current_target: float, buffer_ms: float | None, max_ms: float | None):
        """(目標ms, 上限ms, エラー文) を返す。"""
        target = current_target if buffer_ms is None else buffer_ms
        if target < 20:
            return None, None, f"{FAILED} 目標バッファは20ms以上を指定してください。"
        resolved_max = max_ms if max_ms is not None else target * 2
        if resolved_max < target:
            return None, None, f"{FAILED} 上限バッファは目標バッファ以上にしてください。"
        return target, resolved_max, None


    async def _apply(self, r: Responder, session: dict, pitch, buffer_ms, max_ms):
        sink: VoiceChangerSink = session["sink"]
        lines = []
        if buffer_ms is not None or max_ms is not None:
            target, resolved_max, error = self._resolve_buffer(sink.audio_source.target_buffer_ms, buffer_ms, max_ms)
            if error:
                return await r.send(embed=we(error), ephemeral=True)
            sink.audio_source.update_settings(target_buffer_ms=target, max_buffer_ms=resolved_max)
            lines.append(f"📦 バッファ: 目標 `{target:.0f} ms` / 上限 `{resolved_max:.0f} ms`")
        if pitch is not None:
            sink.set_semitones(pitch)
            lines.append(f"{MUSIC} ピッチ: `{pitch:+.1f}` 半音")
        # 再開用スナップショットにも新しい設定を反映する
        vc_feature_restore.update_settings("changer", r.guild.id, {
            "semitones": getattr(sink, "semitones", pitch if pitch is not None else 0.0),
            "target_buffer_ms": sink.audio_source.target_buffer_ms,
            "max_buffer_ms": sink.audio_source.max_buffer_ms,
        })
        await r.send(embed=we("🔧 ボイスチェンジャーの設定を変更しました。\n" + "\n".join(lines)))


    async def _send_status(self, r: Responder, session: dict | None):
        if session is None:
            return await r.send(embed=we(PAUSE + ' ボイスチェンジャー停止中 (`/vc のパネルからボイスチェンジャー開始` で開始)'))
        sink: VoiceChangerSink = session["sink"]
        src = sink.audio_source

        proc_ms = sink.last_proc_time_ms
        avg_ms = sink.avg_proc_time_ms
        buf_ms = src.buffered_ms
        total_est_delay = avg_ms + src.target_buffer_ms + 20.0

        await r.send(embed=we(
            f"🎙️ **ボイスチェンジャー動作中 (20ms低遅延・無音待機再同期モード)**\n"
            f"{MUSIC} 設定ピッチ: `{sink.semitones:+.1f}` 半音\n\n"
            f"📊 **遅延ステータス (数値)**\n"
            f"├ {THU} 変換処理時間: `{proc_ms:.2f} ms` (平均: `{avg_ms:.2f} ms`)\n"
            f"├ 📦 バッファ滞留量: `{buf_ms:.1f} ms`\n"
            f"├ 🎯 目標プリバッファ: `{src.target_buffer_ms:.0f} ms` / 上限: `{src.max_buffer_ms:.0f} ms`\n"
            f"├ ⚠️ アンダーラン(待機発生)回数: `{src.underrun_count}` 回\n"
            f"├ 🩹 パケットロス補完(PLC): `{sink.concealed_count}` 回 (ロスト検出: `{sink.lost_packet_count}` 回)\n"
            f"└ {CLOCK} **推定トータル遅延**: `~{total_est_delay:.1f} ms`\n\n"
            f"・設定変更: `/vc のパネルからボイスチェンジャー状態 pitch:<半音数> buffer_ms:<目標ms> max_ms:<上限ms>`\n"
            f"・停止: `/vc のパネルからボイスチェンジャー停止`"
        ))


    async def _start(self, r: Responder, pitch, buffer_ms, max_ms):
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send(embed=we(VOICE_NOT_JOINED), ephemeral=True)
        pitch = 0.0 if pitch is None else pitch
        buffer = None
        if buffer_ms is not None or max_ms is not None:
            target, resolved_max, error = self._resolve_buffer(DEFAULT_TARGET_BUFFER_MS, buffer_ms, max_ms)
            if error:
                return await r.send(embed=we(error), ephemeral=True)
            buffer = (target, resolved_max)

        guild_id = r.guild.id
        target_channel = voice.channel
        await r.defer()

        # 別の機能が VC を使っているときは追い出さずに断る。
        try:
            vc = await self.voice_sessions.acquire(
                r.guild, target_channel, "changer", r.user,
                cleanup=self._cleanup(guild_id), text_channel=r.channel, force=True, timeout=30.0,
            )
        except VoiceBusy as busy:
            return await r.send(embed=we(str(busy)), ephemeral=True)
        except Exception as e:
            return await r.send(embed=we(voice_connection_failed(e)))

        sink = VoiceChangerSink(bot=self.bot, vc=vc, semitones=pitch)
        if buffer is not None:
            sink.audio_source.update_settings(target_buffer_ms=buffer[0], max_buffer_ms=buffer[1])
        vc.listen(sink)

        self.vc_sessions[guild_id] = {"sink": sink, "vc": vc}
        self._save_resume_snapshot(guild_id, target_channel, r.channel, r.user, sink)
        await r.send(embed=we(
            f"🎙️ **{target_channel.name}** でボイスチェンジャーを開始しました！\n"
            f"{MUSIC} ピッチ: `{pitch:+.1f}` 半音\n"
            f"📦 プリバッファ: `{(buffer[0] if buffer else DEFAULT_TARGET_BUFFER_MS):.0f} ms` (超低遅延モード)\n"
            f"📊 `/vc のパネルからボイスチェンジャー状態` で遅延数値を確認できます。"
        ))


    def _cleanup(self, guild_id: int):
        """VC を手放すときの後片付け（切断は VoiceSessionManager が行う）。"""
        def cleanup(reason: str) -> None:
            vc_feature_restore.clear_feature("changer", guild_id)
            session = self.vc_sessions.pop(guild_id, None)
            if not session:
                return
            vc = session["vc"]
            session["sink"].cleanup()
            try:
                vc.stop_listening()
                vc.stop()
            except Exception:
                logger.debug("ボイスチェンジャー: 後片付けの停止に失敗しました", exc_info=True)
        return cleanup
