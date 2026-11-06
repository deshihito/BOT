# =====================
# SaitoRelay Cog (通話系)
# =====================

import discord
from discord.ext import commands
import asyncio
import logging
from discord.ext import voice_recv
from core.emojis import FAILED, LOUPE


logger = logging.getLogger("cogs.sio_saito")


from core.legacy import Responder
from core.voice.voice_session import VoiceBusy, get_manager


class _RelaySink(voice_recv.AudioSink):
    """受け取った音声 (Opus) をそのまま相手サーバーの VC へ送る。"""

    def __init__(self, dest_vc):
        super().__init__()
        self.dest_vc = dest_vc

    def wants_opus(self) -> bool:
        return True

    def write(self, user, data: voice_recv.VoiceData):
        if self.dest_vc and self.dest_vc.is_connected():
            try:
                self.dest_vc.send_audio_packet(data.data)
            except Exception:
                logger.debug("ランダム通話: 音声パケットの転送に失敗しました", exc_info=True)

    def cleanup(self):
        self.dest_vc = None


class SaitoRelay(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.matching_queue = []
        self.voice_sessions = get_manager(bot)
        # 通話中のサーバー同士: { guild_id: 相手の guild_id }
        self.peers: dict[int, int] = {}

    def _cleanup(self, guild_id: int, channel):
        """片方が終わったら（停止・自動退出・外部切断）、相手側も終了する。"""
        def cleanup(reason: str) -> None:
            vc = getattr(channel.guild, "voice_client", None) if channel is not None else None
            if vc is not None:
                try:
                    vc.stop_listening()
                except Exception:
                    logger.debug("ランダム通話: 後片付けの受信停止に失敗しました", exc_info=True)
            peer_id = self.peers.pop(guild_id, None)
            if peer_id is None:
                return
            self.peers.pop(peer_id, None)
            # 相手サーバーのロックは別なので、タスクにして解放する（同じサーバーの release は待たない）。
            asyncio.get_running_loop().create_task(self.voice_sessions.release(
                peer_id, "match", reason="peer_left", notice="📴 相手のサーバーが通話を終了しました。",
            ))
        return cleanup

    # --------------------------------------------------
    # 実装（/voice community）
    # --------------------------------------------------
    async def _match_impl(self, r: Responder, action: str):
        """action: start / stop"""
        if action == "stop":
            return await self._stop(r)
        return await self._start(r)

    @staticmethod
    async def _notify(peer: Responder, text: str) -> None:
        """待っていた側への連絡はチャンネルに送る（interaction の期限切れを避ける）。"""
        try:
            await peer.channel.send(text)
        except Exception:
            logging.debug("saito notify failed", exc_info=True)

    async def _start(self, r: Responder):
        """音声中継マッチング"""
        voice = getattr(r.user, "voice", None)
        if not voice or not voice.channel:
            return await r.send("VCに参加してから実行してください。", ephemeral=True)

        busy = self.voice_sessions.get(r.guild.id)
        if busy is not None:
            return await r.send(self.voice_sessions.busy_message(busy), ephemeral=True)
        if r.voice_client:
            return await r.send("このサーバーでは既に接続中です。", ephemeral=True)

        # 同じサーバーの古い待ちと、もう VC にいない人の待ちを取り除く
        self.matching_queue = [
            c for c in self.matching_queue
            if c.guild.id != r.guild.id and getattr(c.user, "voice", None) and c.user.voice.channel
        ]

        target_peer = None
        for i, peer in enumerate(self.matching_queue):
            if peer.guild.id != r.guild.id:
                target_peer = self.matching_queue.pop(i)
                break

        if not target_peer:
            self.matching_queue.append(r)
            return await r.send(f"{LOUPE} 相手を探しています... ({r.guild.name})")

        await r.send(f"🤝 **{target_peer.guild.name}** と接続中...")
        await self._notify(target_peer, f"🤝 **{r.guild.name}** と接続中...")

        acquired = []
        try:
            vc1 = await self.voice_sessions.acquire(
                r.guild, voice.channel, "match", r.user,
                cleanup=self._cleanup(r.guild.id, r.channel), text_channel=r.channel,
            )
            acquired.append(r.guild.id)
            vc2 = await self.voice_sessions.acquire(
                target_peer.guild, target_peer.user.voice.channel, "match", target_peer.user,
                cleanup=self._cleanup(target_peer.guild.id, target_peer.channel), text_channel=target_peer.channel,
            )
            acquired.append(target_peer.guild.id)
            self.peers[r.guild.id] = target_peer.guild.id
            self.peers[target_peer.guild.id] = r.guild.id

            silence_src1 = discord.FFmpegPCMAudio("/dev/null")
            silence_src2 = discord.FFmpegPCMAudio("/dev/null")
            vc1.play(silence_src1)
            vc2.play(silence_src2)

            vc1.listen(_RelaySink(vc2))
            vc2.listen(_RelaySink(vc1))

            await r.send("🎙️ 通話を開始しました。")
            await self._notify(target_peer, "🎙️ 通話を開始しました。")

        except VoiceBusy as busy:
            # 待っている間に相手サーバーで別の機能が始まった
            for guild_id in acquired:
                self.peers.pop(guild_id, None)
                await self.voice_sessions.release(guild_id, "match", reason="stop")
            await r.send(f"{FAILED} 相手のサーバーで別の機能が始まったため、通話できませんでした。もう一度お試しください。")
            await self._notify(target_peer, str(busy))
        except Exception as e:
            logging.error(f"Saito Match Error: {e}")
            for guild_id in acquired:
                self.peers.pop(guild_id, None)
                await self.voice_sessions.release(guild_id, "match", reason="stop")
            await r.send(FAILED + ' 通話の接続に失敗しました。')

    async def _stop(self, r: Responder):
        if await self.voice_sessions.release(r.guild.id, "match", reason="stop"):
            return await r.send("通話を終了しました。")
        before = len(self.matching_queue)
        self.matching_queue = [c for c in self.matching_queue if c.guild.id != r.guild.id]
        if len(self.matching_queue) != before:
            return await r.send("相手探しを取り消しました。")
        await r.send("通話も相手探しもしていません。", ephemeral=True)
