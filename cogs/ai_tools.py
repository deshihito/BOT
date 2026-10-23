"""Logfare Clefを使ったAI toolsのツール呼び出し。"""
from __future__ import annotations

import logging
import os
import re

import discord
from discord.ext import commands

from core import ai_tools_router, logfare

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return os.getenv("AITOOLS_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_invoker(message, bot_user):
    """Bot投稿ではinteraction/reply/明示mention、最後に単独VC参加者から人間を特定する。"""
    if not getattr(message.author, "bot", False):
        return message.author

    guild = getattr(message, "guild", None)

    def as_member(user):
        if user is None:
            return None
        get_member = getattr(guild, "get_member", None)
        member = get_member(user.id) if callable(get_member) else None
        return member or user

    metadata = getattr(message, "interaction_metadata", None)
    interaction = getattr(message, "interaction", None)
    reference = getattr(message, "reference", None)
    resolved = getattr(reference, "resolved", None)
    candidates = [
        getattr(metadata, "user", None),
        getattr(interaction, "user", None),
        getattr(resolved, "author", None),
    ]
    candidates.extend(
        user for user in getattr(message, "mentions", [])
        if getattr(user, "id", None) != getattr(bot_user, "id", None)
    )
    for user in candidates:
        member = as_member(user)
        if member is not None and not getattr(member, "bot", False):
            return member

    # Bot-to-bot依頼にユーザー情報が載らない場合、VC内の人間が一人だけなら曖昧でない。
    members = {
        member.id: member
        for channel in getattr(guild, "voice_channels", [])
        for member in getattr(channel, "members", [])
        if not getattr(member, "bot", False)
    }
    return next(iter(members.values())) if len(members) == 1 else None


class AIToolsCog(commands.Cog):
    """Mention-driven tool selection; no per-user or per-action configuration."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def _prompt(self, content: str) -> str:
        if not self.bot.user:
            return content.strip()
        return re.sub(rf"<@!?{self.bot.user.id}>", "", content).strip()

    @commands.command(name="aitools", help="AI toolsの稼働状態を確認")
    async def aitools(self, ctx: commands.Context, action: str = "status"):
        action = action.strip().lower()
        if action not in {"", "status"}:
            return await ctx.reply("AI toolsはメンションから使う単一機能です。状態確認は `!aitools status`。", mention_author=False)
        candidates = ai_tools_router.action_candidates()
        configured = bool(logfare.api_key())
        key_status = "設定済み" if configured else "未設定"
        return await ctx.reply(
            "AI tools稼働状態\n"
            f"全体有効: `{_enabled()}`\n"
            f"Logfare APIキー: `{key_status}`\n"
            f"モデル: `clef`\n"
            f"実行可能な安全ツール: `{len(candidates)}件`\n"
            "BOTへのメンションに依頼を続けてください。個人別・操作別の設定はありません。",
            mention_author=False,
        )

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if not message.guild:
            return
        if not self.bot.user or message.author.id == self.bot.user.id or self.bot.user not in message.mentions:
            return
        if not _enabled():
            return await message.reply("AI toolsはサーバー設定で停止中です。", mention_author=False)
        invoker = _resolve_invoker(message, self.bot.user)
        if invoker is None:
            return await message.reply(
                "AI toolsは呼び出し元の人間を特定できませんでした。人間をメンションするか、VCに人間が一人だけいる状態で依頼してください。",
                mention_author=False,
            )
        if not logfare.api_key():
            return await message.reply(
                "AI toolsを実行できません。運用環境に `LOGFARE_API_KEY` が設定されていません。",
                mention_author=False,
            )
        prompt = self._prompt(message.content)
        if not prompt:
            return await message.reply("メンションの後に実行したい内容を入力してください。", mention_author=False)
        try:
            candidates = ai_tools_router.action_candidates()
            selected = await ai_tools_router.decide_action(prompt, candidates)
            async with message.channel.typing():
                await ai_tools_router.invoke_action(self.bot, message, candidates[selected], invoker=invoker)
        except ai_tools_router.AIToolsDecisionError as exc:
            logger.info("AI tools stopped: %s", exc)
            await message.reply(f"AI toolsは実行されませんでした。理由: {exc}", mention_author=False)
        except Exception:
            logger.exception("AI tools failed: user=%s", message.author.id)
            await message.reply("AI toolsの判定または機能実行に失敗しました。Botログを確認してください。", mention_author=False)


async def setup(bot: commands.Bot):
    await bot.add_cog(AIToolsCog(bot))
