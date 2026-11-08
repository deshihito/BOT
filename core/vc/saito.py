# =====================
# SaitoRelay Cog (通話系)
# =====================

import discord
from core.support.embeds import we
from discord.ext import commands
import asyncio
import io
import logging
from discord.ext import voice_recv
from core.support.emojis import FAILED, LOUPE


logger = logging.getLogger("cogs.sio_saito")


from core.support.legacy import Responder
from core.vc.voice_session import SHARED_FEATURES, VoiceBusy, get_manager
from core.support.panel_v2 import as_embed_v2
from core.vc.voice_media import (
    FRAME_BYTES,
    add_audio_source,
    add_mixer_tap,
    add_receive_sink,
    remove_audio_source,
    remove_mixer_tap,
    remove_receive_sink,
)
from core.vc.match_image import fetch_guild_icon_bytes, render_match_card
from core.leaderboard_image import (
    BoardRow,
    board_safe_name,
    fetch_avatar_bytes,
    render_leaderboard_png,
)

MEMBERS_BOARD_MAX = 60


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


class _SilenceSource(discord.AudioSource):
    """共有ミキサーに常駐し、通話中は常に再生（送信路）を維持する無音ソース。

    以前は FFmpegPCMAudio("/dev/null") を直接 play していたが、共有ミキサー
    経由にすることで音楽・読み上げと1つの VoiceClient を分け合える。
    """

    def read(self) -> bytes:
        return b"\x00" * FRAME_BYTES

    def is_opus(self) -> bool:
        return False


def format_match_relay(author_name: str, guild_name: str, content: str,
                       attachment_urls) -> str:
    """通話中チャット中継の送信文を作る（純粋関数）。"""
    lines = [f"**{author_name}**（{guild_name}）"]
    if content:
        lines.append(content)
    lines.extend(attachment_urls)
    return "\n".join(lines)[:2000]


class MatchMembersView(discord.ui.View):
    """通話開始カードの「参加メンバーを表示」ボタン。押した人だけに見える。"""

    def __init__(self, cog: "SaitoRelay", guild_a: int, guild_b: int):
        super().__init__(timeout=3600)
        self.cog, self.guild_a, self.guild_b = cog, guild_a, guild_b

    @discord.ui.button(label="参加メンバーを表示", style=discord.ButtonStyle.secondary)
    async def show_members(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        png = await self.cog._members_png(self.guild_a, self.guild_b)
        if png is None:
            return await interaction.followup.send(
                "通話は終了しています。", ephemeral=True)
        await interaction.followup.send(
            file=discord.File(io.BytesIO(png), filename="match_members.png"),
            ephemeral=True,
        )


class SaitoRelay(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.matching_queue = []
        self.voice_sessions = get_manager(bot)
        # 通話中のサーバー同士: { guild_id: 相手の guild_id }
        self.peers: dict[int, int] = {}
        # 通話中のテキスト中継: { text_channel_id: 相手の text_channel_id }
        self.chat_links: dict[int, int] = {}
        # guild_id -> (相手 guild_id, 自分の text_channel_id, 相手の text_channel_id)
        self._match_links: dict[int, tuple[int, int, int]] = {}

    # --------------------------------------------------
    # 後片付け
    # --------------------------------------------------
    def _forget_link(self, guild_id: int) -> None:
        """通話状態（相手・チャット中継）をこのサーバー分だけ忘れる。"""
        self.peers.pop(guild_id, None)
        link = self._match_links.pop(guild_id, None)
        if link is not None:
            _peer_id, my_text, peer_text = link
            self.chat_links.pop(my_text, None)
            self.chat_links.pop(peer_text, None)

    def _cleanup(self, guild_id: int, channel):
        """片方が終わったら（停止・自動退出・外部切断）、相手側も終了する。"""
        def cleanup(reason: str) -> None:
            vc = getattr(channel.guild, "voice_client", None) if channel is not None else None
            if vc is not None:
                for remover, key in (
                    (remove_receive_sink, "match"),
                    (remove_mixer_tap, "match"),
                    (remove_audio_source, "match"),
                ):
                    try:
                        remover(vc, key)
                    except Exception:
                        logger.debug("ランダム通話: 後片付けに失敗しました", exc_info=True)
            peer_id = self.peers.get(guild_id)
            self._forget_link(guild_id)
            if peer_id is None:
                return
            self._forget_link(peer_id)
            # 相手サーバーのロックは別なので、タスクにして解放する（同じサーバーの release は待たない）。
            asyncio.get_running_loop().create_task(self.voice_sessions.release(
                peer_id, "match", reason="peer_left", notice="📴 相手のサーバーが通話を終了しました。",
            ))
        return cleanup

    # --------------------------------------------------
    # 音楽・読み上げの再生音声を相手へ送る
    # --------------------------------------------------
    def _playback_tap(self, from_guild_id: int, dest_vc):
        """共有ミキサーの再生音（音楽・読み上げ）を相手 VC へ送るタップ。"""
        warned = {"done": False}

        def tap(pcm: bytes) -> None:
            if from_guild_id not in self._match_links:
                return
            if dest_vc is None or not dest_vc.is_connected():
                return
            try:
                dest_vc.send_audio_packet(pcm, encode=True)
            except Exception:
                if not warned["done"]:
                    warned["done"] = True
                    logger.warning(
                        "ランダム通話: 再生音声（音楽・読み上げ）の送信に失敗しました",
                        exc_info=True)

        return tap

    # --------------------------------------------------
    # 通話中のチャット中継（グローバルチャットの一時接続）
    # --------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message):
        try:
            await self._relay_chat_message(message)
        except Exception:
            logger.debug("ランダム通話: チャット中継に失敗しました", exc_info=True)

    async def _relay_chat_message(self, message) -> None:
        if getattr(message.author, "bot", False):
            return  # 自分（Bot）の投稿は中継しない（中継文のループ防止）
        channel_id = getattr(getattr(message, "channel", None), "id", None)
        dest_id = self.chat_links.get(channel_id)
        if dest_id is None:
            return
        content = (getattr(message, "content", "") or "").strip()
        attachments = [
            a.url for a in (getattr(message, "attachments", None) or [])
            if getattr(a, "url", None)
        ]
        if not content and not attachments:
            return
        get_channel = getattr(self.bot, "get_channel", None)
        dest = get_channel(dest_id) if get_channel is not None else None
        if dest is None:
            fetch_channel = getattr(self.bot, "fetch_channel", None)
            if fetch_channel is not None:
                dest = await fetch_channel(dest_id)
        if dest is None:
            return
        guild_name = getattr(getattr(message, "guild", None), "name", "") or ""
        text = format_match_relay(
            getattr(message.author, "display_name", None) or "ユーザー",
            guild_name, content, attachments)
        await dest.send(
            text, allowed_mentions=discord.AllowedMentions.none())

    # --------------------------------------------------
    # 参加メンバー画像
    # --------------------------------------------------
    async def _members_png(self, guild_a: int, guild_b: int) -> bytes | None:
        """両サーバーの VC 参加者をサーバー別に並べた画像。通話終了時は None。"""
        if self.peers.get(guild_a) != guild_b:
            return None
        sections = []
        user_ids: list[int] = []
        total = 0
        for gid in (guild_a, guild_b):
            session = self.voice_sessions.get(gid)
            if session is None or session.channel_id is None:
                return None
            get_channel = getattr(self.bot, "get_channel", None)
            channel = get_channel(session.channel_id) if get_channel else None
            if channel is None:
                return None
            guild = getattr(channel, "guild", None)
            guild_name = getattr(guild, "name", None) or "サーバー"
            rows = []
            for member in getattr(channel, "members", []) or []:
                if getattr(member, "bot", False):
                    continue
                if total >= MEMBERS_BOARD_MAX:
                    break
                total += 1
                user_ids.append(int(member.id))
                username = str(getattr(member, "name", "") or "")
                rows.append(BoardRow(
                    user_id=int(member.id),
                    name=board_safe_name(
                        getattr(member, "display_name", None), fallback=username),
                    value=f"@{username}" if username else str(member.id),
                ))
            sections.append((guild_name, rows))
        avatars = await fetch_avatar_bytes(self.bot, user_ids)
        return await asyncio.to_thread(
            render_leaderboard_png,
            title="ランダム通話 参加メンバー", sections=sections,
            accent=(37, 99, 235), avatars=avatars, podium=False,
            empty_text="だれもいません。", cache_namespace="match-members",
        )

    # --------------------------------------------------
    # 通話開始カード
    # --------------------------------------------------
    async def _announce_start(self, r: Responder, peer: Responder,
                              vc_a, vc_b) -> None:
        """開始カード（相手サーバーのアイコン・名前）を両サーバーへ送る。

        画像まわりで失敗しても通話自体は続ける（テキスト通知に落とす）。
        """
        guild_a, guild_b = r.guild, peer.guild
        try:
            icon_a, icon_b = await asyncio.gather(
                fetch_guild_icon_bytes(guild_a),
                fetch_guild_icon_bytes(guild_b),
            )
            members_a = len([
                m for m in getattr(vc_a.channel, "members", []) or []
                if not getattr(m, "bot", False)])
            members_b = len([
                m for m in getattr(vc_b.channel, "members", []) or []
                if not getattr(m, "bot", False)])
            png = await asyncio.to_thread(
                render_match_card,
                guild_a.name, guild_b.name, icon_a, icon_b, members_a, members_b)

            def make_embed() -> discord.Embed:
                embed = discord.Embed(title="🎙️ ランダム通話", color=0xFFFFFF)
                embed.description = (
                    f"**{guild_a.name}** ⇄ **{guild_b.name}**\n"
                    "通話を開始しました。音楽や読み上げの音声も相手に届きます。\n"
                    "このチャンネルのチャットは、通話中だけ相手サーバーへ中継されます。")
                embed.set_image(url="attachment://match_card.png")
                return embed

            await r.send(
                embed=make_embed(),
                file=discord.File(io.BytesIO(png), filename="match_card.png"),
                view=MatchMembersView(self, guild_a.id, guild_b.id),
            )
            await peer.channel.send(
                embed=make_embed(),
                file=discord.File(io.BytesIO(png), filename="match_card.png"),
                view=MatchMembersView(self, guild_a.id, guild_b.id),
            )
            return
        except Exception:
            logger.debug("ランダム通話: 開始カードの送信に失敗しました", exc_info=True)
        await r.send(view=as_embed_v2(we("🎙️ 通話を開始しました。")))
        await self._notify(peer, "🎙️ 通話を開始しました。")

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

        if r.guild.id in self.peers:
            return await r.send("既にランダム通話中です。", ephemeral=True)
        existing = self.voice_sessions.get(r.guild.id)
        if existing is not None:
            if existing.feature == "match":
                return await r.send("既にランダム通話中です。", ephemeral=True)
            if existing.feature not in SHARED_FEATURES:
                return await r.send(self.voice_sessions.busy_message(existing), ephemeral=True)
            if existing.channel_id != voice.channel.id:
                return await r.send(self.voice_sessions.busy_message(existing), ephemeral=True)

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
            return await r.send(view=as_embed_v2(we(f"{LOUPE} 相手を探しています... ({r.guild.name})")))

        await r.send(view=as_embed_v2(we(f"🤝 **{target_peer.guild.name}** と接続中...")))
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
            text_a = getattr(r.channel, "id", None)
            text_b = getattr(target_peer.channel, "id", None)
            if text_a is not None and text_b is not None and text_a != text_b:
                self._match_links[r.guild.id] = (target_peer.guild.id, text_a, text_b)
                self._match_links[target_peer.guild.id] = (r.guild.id, text_b, text_a)
                self.chat_links[text_a] = text_b
                self.chat_links[text_b] = text_a

            # 声: 受けた Opus をそのまま相手へ（従来どおり）。
            # 再生音（音楽・読み上げ）: 共有ミキサーのタップから相手へ送る。
            # 無音ソースがミキサーを常時再生させ、送信路を維持する。
            add_audio_source(vc1, "match", _SilenceSource())
            add_audio_source(vc2, "match", _SilenceSource())
            add_receive_sink(vc1, "match", _RelaySink(vc2))
            add_receive_sink(vc2, "match", _RelaySink(vc1))
            add_mixer_tap(vc1, "match", self._playback_tap(r.guild.id, vc2),
                          exclude_key="match")
            add_mixer_tap(vc2, "match", self._playback_tap(target_peer.guild.id, vc1),
                          exclude_key="match")

            await self._announce_start(r, target_peer, vc1, vc2)

        except VoiceBusy as busy:
            # 待っている間に相手サーバーで別の機能が始まった
            for guild_id in acquired:
                self._forget_link(guild_id)
                await self.voice_sessions.release(guild_id, "match", reason="stop")
            await r.send(view=as_embed_v2(we(f"{FAILED} 相手のサーバーで別の機能が始まったため、通話できませんでした。もう一度お試しください。")), ephemeral=True)
            await self._notify(target_peer, str(busy))
        except Exception as e:
            logging.error(f"Saito Match Error: {e}")
            for guild_id in acquired:
                self._forget_link(guild_id)
                await self.voice_sessions.release(guild_id, "match", reason="stop")
            await r.send(view=as_embed_v2(we(FAILED + ' 通話の接続に失敗しました。')), ephemeral=True)

    async def _stop(self, r: Responder):
        if await self.voice_sessions.release(r.guild.id, "match", reason="stop"):
            return await r.send(view=as_embed_v2(we("通話を終了しました。")))
        before = len(self.matching_queue)
        self.matching_queue = [c for c in self.matching_queue if c.guild.id != r.guild.id]
        if len(self.matching_queue) != before:
            return await r.send(view=as_embed_v2(we("相手探しを取り消しました。")))
        await r.send(view=as_embed_v2(we("通話も相手探しもしていません。")), ephemeral=True)


async def setup(bot):
    await bot.add_cog(SaitoRelay(bot))
