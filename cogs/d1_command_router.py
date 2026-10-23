"""Logfare Clefを使った機能アクション代理実行。AIチャットとは別機能。"""
from __future__ import annotations

import logging
import os
import re

import discord
from discord.ext import commands

from core import d1_command_preferences, d1_command_router

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return os.getenv("D1_COMMAND_ROUTER_ENABLED", "false").lower() in {"1", "true", "yes", "on"}


class D1CommandRouterCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def cog_load(self):
        await d1_command_preferences.ensure_loaded()

    def _prompt(self, content: str) -> str:
        if not self.bot.user:
            return content.strip()
        return re.sub(rf"<@!?{self.bot.user.id}>", "", content).strip()

    @commands.command(name="d1tools", help="Clefによる機能代理実行の設定")
    async def d1tools(self, ctx: commands.Context, action: str = "", *, value: str = ""):
        config = d1_command_preferences.get_config(ctx.author.id)
        action = action.lower().strip()
        if not action or action == "status":
            available = d1_command_router.action_candidates(config["actions"])
            return await ctx.reply(
                "D1機能代理実行設定\n"
                f"有効: `{config['enabled']}`\n"
                f"許可機能: `{', '.join(config['actions']) or 'なし'}`\n"
                f"解決可能: `{', '.join(available) or 'なし'}`\n"
                f"追加方針: `{config['instruction'] or 'なし'}`\n"
                "設定例: `!d1tools allow vc:join` / `!d1tools prompt 読み取り系を優先`",
                mention_author=False,
            )
        if action in {"on", "enable", "有効"}:
            await d1_command_preferences.update(ctx.author.id, enabled=True)
            return await ctx.reply("D1機能代理実行を有効にしました。", mention_author=False)
        if action in {"off", "disable", "無効"}:
            await d1_command_preferences.update(ctx.author.id, enabled=False)
            return await ctx.reply("D1機能代理実行を無効にしました。", mention_author=False)
        if action in {"allow", "add", "許可"}:
            name = value.strip().lower().lstrip("!")
            from core import d1_command_router as router
            if ":" not in name:
                genre_actions = [
                    key for key, item in router.action_candidates(
                        [f"{name}:{candidate}" for candidate in self._genre_values(name)]
                    ).items()
                ]
                if genre_actions:
                    await d1_command_preferences.update(ctx.author.id, actions=config["actions"] + genre_actions)
                    return await ctx.reply(
                        f"ジャンル`{name}`の安全な機能を許可しました: `{', '.join(genre_actions)}`",
                        mention_author=False,
                    )
            available = router.action_candidates([name])
            if not name or not available:
                return await ctx.reply(
                    "登録できる機能が見つかりません。例: `vc:join`, `vc:status`, `general:status`。",
                    mention_author=False,
                )
            await d1_command_preferences.update(ctx.author.id, actions=config["actions"] + [name])
            return await ctx.reply(f"機能代理実行を許可しました: `{name}`", mention_author=False)
        if action in {"deny", "remove", "禁止"}:
            name = value.strip().lower().lstrip("!")
            await d1_command_preferences.update(
                ctx.author.id, actions=[item for item in config["actions"] if item != name]
            )
            return await ctx.reply(f"機能代理実行の許可を解除しました: `{name}`", mention_author=False)
        if action in {"prompt", "instruction", "方針"}:
            if len(value.strip()) > 1000:
                return await ctx.reply("追加方針は1000文字以内で指定してください。", mention_author=False)
            await d1_command_preferences.update(ctx.author.id, instruction=value.strip())
            return await ctx.reply("D1へ渡す機能代理実行方針を更新しました。", mention_author=False)
        if action == "reset":
            await d1_command_preferences.set_config(ctx.author.id, d1_command_preferences.DEFAULT_CONFIG)
            return await ctx.reply("D1機能代理実行設定を初期化しました。", mention_author=False)
        return await ctx.reply(
            "使い方: `!d1tools status|on|off|allow vc:join|deny vc:join|prompt 方針|reset`",
            mention_author=False,
        )

    @staticmethod
    def _genre_values(genre: str) -> list[str]:
        from cogs.general import SHORTCUT_ROOTS
        root = SHORTCUT_ROOTS.get(genre)
        return [value for _, value in root[1]] if root else []

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or not message.guild or not _enabled():
            return
        if not self.bot.user or self.bot.user not in message.mentions:
            return
        config = d1_command_preferences.get_config(message.author.id)
        if not config["enabled"]:
            return
        prompt = self._prompt(message.content)
        if not prompt:
            return await message.reply("メンションの後に実行したい内容を入力してください。", mention_author=False)
        try:
            candidates = d1_command_router.action_candidates(config["actions"])
            selected = await d1_command_router.decide_action(prompt, candidates, config["instruction"])
            async with message.channel.typing():
                await d1_command_router.invoke_action(self.bot, message, candidates[selected])
        except d1_command_router.D1DecisionError as exc:
            logger.info("D1 action proxy stopped: %s", exc)
            await message.reply(f"機能は実行しませんでした。理由: {exc}", mention_author=False)
        except Exception:
            logger.exception("D1 action proxy failed: user=%s", message.author.id)
            await message.reply("D1の判定または機能実行に失敗したため、実行しませんでした。", mention_author=False)


async def setup(bot: commands.Bot):
    await bot.add_cog(D1CommandRouterCog(bot))
