"""!ai で自動切替または Logfare のチャットモデルを呼び出す機能。"""
from __future__ import annotations

import io
import logging

import discord
from discord.ext import commands

from core import ai_preferences, ai_provider_router, ai_tools, logfare

logger = logging.getLogger(__name__)


class AICog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name="ai", help="AIに質問します。例: !ai 今日の天気を教えて")
    @commands.cooldown(1, 5.0, commands.BucketType.user)
    async def ai(self, ctx: commands.Context, *, prompt: str = ""):
        prompt = prompt.strip()
        if not prompt:
            return await ctx.reply("使い方: `!ai 質問内容`", mention_author=False)
        preferred = ai_preferences.get_model(ctx.author.id) or logfare.configured_default_model()
        auto = preferred == ai_provider_router.AUTO_MODEL
        if auto and not ai_provider_router.enabled():
            return await ctx.reply("AIの自動切替が未設定です。", mention_author=False)
        if not auto and not logfare.api_key():
            return await ctx.reply("Logfareが未設定です。`.env` に `LOGFARE_API_KEY` を設定してください。", mention_author=False)

        sources = []
        try:
            if auto:
                model, exact = preferred, True
                reasoning_effort = None
                model_info = None
            else:
                model, exact = await logfare.resolve_model(preferred)
                reasoning_effort = ai_preferences.get_reasoning_effort(ctx.author.id)
                try:
                    model_info = next(
                        (item for item in await logfare.fetch_free_chat_models() if item.get("id") == model),
                        None,
                    )
                except Exception:
                    model_info = None
                if reasoning_effort:
                    if not model_info or reasoning_effort not in logfare.reasoning_efforts(model_info):
                        reasoning_effort = None
            can_use_web_search = bool(
                model_info and (model_info.get("chat_capabilities") or {}).get("tools") is True
            )
            messages = [
                {
                    "role": "system",
                    "content": (
                        "あなたはDiscord上の親切なアシスタントです。日本語で簡潔かつ正確に回答してください。"
                        + ("必要に応じてweb_searchを使い、回答に参照URLを含めてください。" if can_use_web_search else "")
                    ),
                },
                {"role": "user", "content": prompt},
            ]
            async with ctx.typing():
                if auto:
                    routed = await ai_provider_router.chat(messages)
                    answer = routed.text
                elif can_use_web_search:
                    answer, sources = await ai_tools.answer_with_web_search(
                        model, messages, reasoning_effort=reasoning_effort
                    )
                else:
                    answer = await logfare.chat(model, messages, reasoning_effort=reasoning_effort)
        except Exception:
            logger.exception("!ai request failed: user=%s model=%s", ctx.author.id, preferred)
            return await ctx.reply("AIへの問い合わせに失敗しました。しばらくしてから再試行してください。", mention_author=False)

        if not answer:
            return await ctx.reply("AIから空の回答が返りました。", mention_author=False)
        notice = "" if exact else f"（指定モデルがfree一覧にないため `{model}` を使用）"
        embed = discord.Embed(
            title="AI回答",
            description=answer[:4096],
            color=0x5865F2,
        )
        footer = (f"モデル: {routed.model} / 接続先: {routed.provider}（自動切替）"
                  if auto else f"モデル: {model}{notice}")
        embed.set_footer(text=footer)
        unique_sources = {source.get("url"): source for source in sources if source.get("url")}
        if unique_sources:
            links = "\n".join(
                f"[{source.get('title', '参照')[:80]}]({url})"
                for url, source in list(unique_sources.items())[:5]
            )
            embed.add_field(name="参照ソース", value=links[:1024], inline=False)
        await ctx.reply(embed=embed, mention_author=False)

    @ai.error
    async def ai_error(self, ctx: commands.Context, error: commands.CommandError):
        if isinstance(error, commands.CommandOnCooldown):
            return await ctx.reply(f"少し待ってから再試行してください（{error.retry_after:.1f}秒）。", mention_author=False)
        logger.exception("!ai command error", exc_info=error)

    @commands.command(name="generate", help="Logfareで画像を生成します。例: !generate 星空の下の猫")
    @commands.cooldown(1, 15.0, commands.BucketType.user)
    async def generate(self, ctx: commands.Context, *, prompt: str = ""):
        prompt = prompt.strip()
        if not prompt:
            return await ctx.reply("使い方: `!generate 画像のプロンプト`", mention_author=False)
        if not logfare.api_key():
            return await ctx.reply("Logfareが未設定です。`.env` に `LOGFARE_API_KEY` を設定してください。", mention_author=False)

        preferred = ai_preferences.get_image_model(ctx.author.id)
        try:
            model, exact = await logfare.resolve_image_model(preferred)
            async with ctx.typing():
                image = await logfare.generate_image(model, prompt)
        except Exception:
            logger.exception("!generate request failed: user=%s model=%s", ctx.author.id, preferred)
            return await ctx.reply("画像生成に失敗しました。モデルの利用条件やプロンプトを確認してください。", mention_author=False)

        notice = "" if exact else f"（指定モデルが見つからないため `{model}` を使用）"
        file = discord.File(io.BytesIO(image), filename="logfare-generated.png")
        embed = discord.Embed(title="画像生成", description=notice or None, color=0xE67E22)
        embed.set_image(url="attachment://logfare-generated.png")
        embed.set_footer(text=f"モデル: {model}")
        await ctx.reply(embed=embed, file=file, mention_author=False)

    @generate.error
    async def generate_error(self, ctx: commands.Context, error: commands.CommandError):
        if isinstance(error, commands.CommandOnCooldown):
            return await ctx.reply(f"少し待ってから再試行してください（{error.retry_after:.1f}秒）。", mention_author=False)
        logger.exception("!generate command error", exc_info=error)


async def setup(bot: commands.Bot):
    await bot.add_cog(AICog(bot))
