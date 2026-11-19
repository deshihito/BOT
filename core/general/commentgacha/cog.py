"""「コメントガチャ」の投稿に反応して、そのチャンネルの過去の発言を1件再投稿する機能。

イースターエッグ枠（今北産業と同じ置き方）: 設定はなく常時オン。
トリガー語を含む発言に反応し、そのチャンネルの全履歴から候補の総数を
数え、ダイスロールで決めた1件だけを抜き出して、元の投稿者の名前と
アバターを付けた webhook で再投稿する。
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
# 全履歴の走査を伴うため、チャンネル単位の間隔は長めに取る。
COOLDOWN_SECONDS = 60


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


async def count_candidates(channel: Any, *, exclude_id: Any) -> int:
    """候補になる発言の総数を数える（発言自体は保持しない）。"""
    history = getattr(channel, "history", None)
    if not callable(history):
        return 0
    count = 0
    async for candidate in history(limit=None):
        if _eligible(candidate, exclude_id=exclude_id):
            count += 1
    return count


async def fetch_candidate_at(channel: Any, index: int, *, exclude_id: Any) -> Any | None:
    """候補を先頭から数えて index 番目の1件だけを取り出す（到達したら打ち切る）。

    走査中に発言が削除されて index に届かなかった場合は、最後に見つけた
    候補を返す（ガチャ自体は止めない）。
    """
    history = getattr(channel, "history", None)
    if not callable(history):
        return None
    seen = -1
    last: Any | None = None
    async for candidate in history(limit=None):
        if not _eligible(candidate, exclude_id=exclude_id):
            continue
        seen += 1
        last = candidate
        if seen == index:
            return candidate
    return last


async def draw_random_message(channel: Any, *, exclude_id: Any) -> Any | None:
    """候補の総数を取得 → ダイスロール → 当たりの1件だけを抜き出す。"""
    total = await count_candidates(channel, exclude_id=exclude_id)
    if total <= 0:
        return None
    index = random.randrange(total)
    return await fetch_candidate_at(channel, index, exclude_id=exclude_id)


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
        try:
            source = await draw_random_message(channel, exclude_id=trigger_message.id)
            if source is None:
                return
            await self._repost(channel, source)
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
