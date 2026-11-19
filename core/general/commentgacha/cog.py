"""「コメントガチャ」の投稿に反応して、そのチャンネルの過去の発言を1件再投稿する機能。

イースターエッグ枠（今北産業と同じ置き方）: 設定はなく常時オン。
トリガー語を含む発言に反応し、そのチャンネルの過去の発言から1件を
抜き出して、元の投稿者の名前とアバターを付けた webhook で再投稿する。

抜き出しは TakasumiBOT の /top と同じカーソル取得の応用: チャンネル
作成（＝チャンネルID）から最新の発言IDの範囲でランダムなIDを引き、
after カーソルでその直後の発言をピンポイント取得する。全履歴の走査は
しない（通常は窓取得1回＋再投稿1回で完結）。最古発言の取得（after=0）は
履歴が多いチャンネルほど重いため通常経路では使わない。
代わりに均一性は「発言数」ではなく「時間」基準になる（発言が密集した
時期の発言は当たりにくい）。
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import discord
from discord.ext import commands

logger = logging.getLogger("cogs.commentgacha")
TRIGGER_PHRASE = "コメントガチャ"
WEBHOOK_NAME = "AGOBOT-CommentGacha"
# チャンネル単位のクールダウン。同時発火の抑止のみが目的なので1秒だけ置く
# （60秒あった頃は、無反応で握りつぶされる時間が「2回目だけすごく遅い」
# 体感を生んでいた）。
COOLDOWN_SECONDS = 1
# ランダムIDの直後から候補を探す範囲と、候補が無い場合の引き直し回数。
DRAW_WINDOW = 50
DRAW_ATTEMPTS = 3


def _eligible(message: Any, *, exclude_id: Any) -> bool:
    """ガチャの候補になる発言か。Bot/webhook・空発言・システム発言・
    トリガー語を含む発言（過去の呼び出し等）は除く。"""
    if getattr(message, "id", None) == exclude_id:
        return False
    author = getattr(message, "author", None)
    if author is None or getattr(author, "bot", False):
        return False
    if getattr(message, "webhook_id", None) is not None:
        return False
    message_type = getattr(message, "type", None)
    if message_type is not None and message_type not in (
        discord.MessageType.default,
        discord.MessageType.reply,
    ):
        return False
    content = getattr(message, "content", "") or ""
    if TRIGGER_PHRASE in content:
        return False
    attachments = getattr(message, "attachments", None) or []
    return bool(str(content).strip() or attachments)


async def _edge_message(channel: Any, *, oldest: bool) -> Any | None:
    """チャンネルの最古（oldest=True）または最新の発言を1件だけ取得する。"""
    history = getattr(channel, "history", None)
    if not callable(history):
        return None
    kwargs: dict[str, Any] = {"limit": 1}
    if oldest:
        kwargs["oldest_first"] = True
    async for message in history(**kwargs):
        return message
    return None


async def draw_random_message(channel: Any, *, exclude_id: Any) -> Any | None:
    """チャンネル作成〜最新の発言IDの範囲でランダムなIDを引き、その直後の候補から1件選ぶ。

    /top の after カーソル取得と同じ仕組みで、全履歴を走査せずに
    ピンポイントで抜き出す。ランダムIDが削除済み発言や空白期間に
    落ちても、after 取得は次の実在発言を返すためそのまま候補になる。

    範囲の下限はチャンネル自身のID（snowflake＝作成時刻）を使う。
    発言はチャンネル作成より前に存在しないため、最古発言の取得
    （after=0）は通常経路では行わない。after=0 の取得は履歴件数が
    多いチャンネルほど Discord 側の応答が重くなることが実機で
    確認できたためで、窓が空振りし続けた場合のフォールバックでのみ
    使う（発言が実質1件のチャンネルでも引けるようにするため。
    その場合はチャンネル自体が小さいので after=0 でも軽い）。
    """
    # 最新IDはゲートウェイが保持するキャッシュから取る（APIを叩かない）。
    latest_id = getattr(channel, "last_message_id", None)
    if latest_id is None:
        latest = await _edge_message(channel, oldest=False)
        if latest is None:
            return None
        latest_id = latest.id
    history = getattr(channel, "history", None)
    if not callable(history):
        return None
    floor = getattr(channel, "id", 0) or 0
    if floor > latest_id:
        floor = latest_id
    for _ in range(DRAW_ATTEMPTS):
        pivot = random.randint(floor, latest_id)
        window = []
        async for candidate in history(
            limit=DRAW_WINDOW,
            after=discord.Object(pivot),
            oldest_first=True,
        ):
            if _eligible(candidate, exclude_id=exclude_id):
                window.append(candidate)
        if window:
            return random.choice(window)
    # フォールバック: 窓が全部空だった場合のみ最古発言を引く。
    first = await _edge_message(channel, oldest=True)
    if first is not None and _eligible(first, exclude_id=exclude_id):
        return first
    return None


class CommentGachaCog(commands.Cog):
    def __init__(self, bot: commands.Bot, clock=time.monotonic):
        self.bot = bot
        self.clock = clock
        self._last_drawn: dict[int, float] = {}
        self._locks: dict[int, asyncio.Lock] = {}
        self._webhooks: dict[int, Any] = {}

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if getattr(getattr(message, "author", None), "bot", False):
            return
        if TRIGGER_PHRASE not in (getattr(message, "content", "") or ""):
            return
        if getattr(message, "guild", None) is None:
            return
        channel_id = message.channel.id
        lock = self._locks.setdefault(channel_id, asyncio.Lock())
        if lock.locked():
            return
        async with lock:
            now = self.clock()
            if now - self._last_drawn.get(channel_id, float("-inf")) < COOLDOWN_SECONDS:
                return
            self._last_drawn[channel_id] = now
            await self._draw(message)

    async def _draw(self, trigger_message: discord.Message):
        channel = trigger_message.channel
        guild = trigger_message.guild
        me = getattr(guild, "me", None)
        if me is not None:
            try:
                permissions = channel.permissions_for(me)
            except Exception:
                permissions = None
            if permissions is not None and not (
                getattr(permissions, "manage_webhooks", False)
                and getattr(permissions, "read_message_history", False)
            ):
                logger.warning(
                    "コメントガチャにはWebhook管理とメッセージ履歴の閲覧権限が必要です (guild=%s channel=%s)",
                    guild.id,
                    channel.id,
                )
                return
        started = time.monotonic()
        try:
            source = await draw_random_message(channel, exclude_id=trigger_message.id)
            if source is None:
                return
            await self._repost(channel, source)
            logger.debug(
                "コメントガチャ再投稿まで %.2f秒 (channel=%s)",
                time.monotonic() - started,
                channel.id,
            )
        except discord.Forbidden:
            logger.warning(
                "コメントガチャの履歴取得または再投稿が拒否されました (guild=%s channel=%s)",
                guild.id,
                channel.id,
            )
        except discord.HTTPException:
            logger.exception("コメントガチャの再投稿に失敗しました")

    async def _webhook_for(self, channel: Any) -> Any:
        """Return the per-channel webhook used for gacha reposts."""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        cached = self._webhooks.get(parent.id)
        if cached is not None:
            return cached
        webhooks = await parent.webhooks()
        webhook = discord.utils.get(webhooks, name=WEBHOOK_NAME)
        if webhook is None:
            webhook = await parent.create_webhook(name=WEBHOOK_NAME)
        self._webhooks[parent.id] = webhook
        return webhook

    async def _repost(self, channel: Any, source: Any) -> None:
        webhook = await self._webhook_for(channel)
        files = []
        for attachment in getattr(source, "attachments", None) or []:
            try:
                files.append(await attachment.to_file(use_cached=True))
            except (discord.HTTPException, AttributeError):
                # 添付が取得できない場合は本文だけでも再投稿する。
                logger.debug("コメントガチャの添付取得に失敗しました", exc_info=True)
        author = source.author
        kwargs: dict[str, Any] = {
            "content": (getattr(source, "content", "") or "")[:2000] or None,
            "username": str(getattr(author, "display_name", "メンバー"))[:80],
            "avatar_url": str(author.display_avatar.url),
            "files": files,
            "allowed_mentions": discord.AllowedMentions.none(),
            # 再投稿は原文のまま出す（自動翻訳/ローカライズをかけない）。
            "_agobot_skip_localization": True,
        }
        if isinstance(channel, discord.Thread):
            kwargs["thread"] = channel
        await webhook.send(**kwargs)


async def setup(bot: commands.Bot):
    await bot.add_cog(CommentGachaCog(bot))
