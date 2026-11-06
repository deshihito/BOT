"""!nation を初めて使った人に、DMで 3 ステップのガイドを出す。

- 文章は ``core/command_meta.NATION_TUTORIAL``（!help と Web サイトと共通）。
- 「もう見た」かどうかは ``core/storage.KVStore``（Supabase の ``bot_kv``、namespace ``nation_onboarding``）に保存する。
- ``on_command_completion`` で !nation のコマンドが終わったあとにDMで送る。新しいコマンドは追加しない。
"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands

from core.command_meta import NATION_TUTORIAL
from core.storage import KVStore

log = logging.getLogger(__name__)

NAMESPACE = "nation_onboarding"
COLOR = 0x3498db


def tutorial_embed(step: int) -> discord.Embed:
    data = NATION_TUTORIAL[step]
    embed = discord.Embed(title=f"国づくりのはじめかた：{data['title']}", description=data["body"], color=COLOR)
    embed.set_footer(text=f"{step + 1} / {len(NATION_TUTORIAL)}")
    return embed


class TutorialView(discord.ui.View):
    def __init__(self, user_id: int, step: int = 0):
        super().__init__(timeout=600)
        self.user_id = user_id
        self.step = step
        self._refresh()

    def _refresh(self):
        self.back.disabled = self.step == 0
        last = self.step == len(NATION_TUTORIAL) - 1
        self.next.label = "とじる" if last else "次へ"
        self.next.style = discord.ButtonStyle.success if last else discord.ButtonStyle.primary

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.secondary)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.step = max(0, self.step - 1)
        self._refresh()
        await interaction.response.edit_message(embed=tutorial_embed(self.step), view=self)

    @discord.ui.button(label="次へ", style=discord.ButtonStyle.primary)
    async def next(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.step >= len(NATION_TUTORIAL) - 1:
            self.stop()
            await interaction.response.edit_message(
                content="ガイドをとじました。`!help nation join` からもう一度読めます。", embed=None, view=None)
            return
        self.step += 1
        self._refresh()
        await interaction.response.edit_message(embed=tutorial_embed(self.step), view=self)


class NationOnboardingCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: KVStore | None = None):
        self.bot = bot
        self.store = store or KVStore(NAMESPACE)
        self.seen: set[str] = set(self.store.load_local())
        self._loaded = False
        self._lock = asyncio.Lock()

    async def _first_time(self, user_id: str) -> bool:
        """初めてなら True を返し、同時に「見た」と記録する。"""
        async with self._lock:
            if not self._loaded:
                try:
                    self.seen |= set(await self.store.load_all())
                except Exception:  # noqa: BLE001 - 読めなくてもローカルの記録で続ける
                    log.exception("nation_onboarding の読み込みに失敗")
                self._loaded = True
            if user_id in self.seen:
                return False
            self.seen.add(user_id)
        await self.store.set(user_id, True)
        return True

    @commands.Cog.listener()
    async def on_command_completion(self, ctx: commands.Context):
        name = getattr(ctx.command, "qualified_name", "") or ""
        if name.split(" ")[0] != "nation":
            return
        try:
            if not await self._first_time(str(ctx.author.id)):
                return
            await ctx.author.send(embed=tutorial_embed(0), view=TutorialView(ctx.author.id))
        except discord.Forbidden:
            try:
                await ctx.send(embed=discord.Embed(
                    title="国づくりのはじめかた",
                    description="DMを送れなかったため、ガイドをここに表示します。操作方法はサーバー管理者に確認してください。",
                    color=COLOR,
                ))
            except discord.HTTPException:
                log.exception("国づくりガイドをDM・チャンネルのどちらにも送れませんでした")
        except Exception:  # noqa: BLE001 - ガイドが出せなくても本体のコマンドには影響させない
            log.exception("国づくりのガイドを送れませんでした")


async def setup(bot: commands.Bot):
    await bot.add_cog(NationOnboardingCog(bot))
