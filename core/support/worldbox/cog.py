"""AGO WORLD BOX のプレイヤー状態パネル（Discord 側、管理者向け）。

`!wbstate <ユーザーID>` で、Web 側と同じ保存データ（bot_kv）から
対象プレイヤーの WORLD BOX 状態（残高・所持品・現在地・所属ユニオン）を
Components V2 パネルで表示する。Web の表示と食い違わないよう、読むのは
Web が書いたレコードそのもの（worldbox_profiles / worldbox_presence /
worldbox_save / worldbox_nations）。残高は経済の正である
CirculationCog._balance を使う。

スラッシュコマンドは増やさない（既存の管理者向けテキストコマンド
!all_stats / !logs と同じ許可リストでゲートする）。
"""

from __future__ import annotations

import json
from typing import Any, Optional

import discord
from discord.ext import commands

from core.support.storage import KVStore
from core.support.terminal.cog import ALLOWED_USER_IDS

from core.support.worldbox.state import (  # noqa: E402
    NATIONS_NS,
    PRESENCE_NS,
    PROFILES_NS,
    SAVE_NS,
    build_state_lines,
    _as_dict,
)

class WorldBoxStateView(discord.ui.LayoutView):
    def __init__(self, lines: list[str]):
        super().__init__(timeout=None)
        container = discord.ui.Container(accent_colour=discord.Colour(0x3A7CB4))
        container.add_item(discord.ui.TextDisplay("\n".join(lines)))
        self.add_item(container)


class WorldBoxStateCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._profiles = KVStore(PROFILES_NS)
        self._presence = KVStore(PRESENCE_NS)
        self._save = KVStore(SAVE_NS)
        self._nations = KVStore(NATIONS_NS)

    async def _balance(self, user_id: str) -> Optional[int]:
        cog = self.bot.get_cog("CirculationCog")
        reader = getattr(cog, "_balance", None)
        if reader is None:
            return None
        try:
            return int(await reader(user_id))
        except Exception:
            return None

    @commands.command(name="wbstate", hidden=True)
    @commands.check(lambda ctx: ctx.author.id in ALLOWED_USER_IDS)
    async def wbstate(self, ctx: commands.Context, user_id: str = ""):
        """!wbstate <ユーザーID>: WORLD BOX のプレイヤー状態を表示する。"""
        uid = user_id.strip().strip("<@!>")
        if not uid.isdigit():
            await ctx.send("使い方: `!wbstate <ユーザーID>`")
            return
        owner_key = f"discord:{uid}"
        profile = _as_dict(await self._profiles.load_one(owner_key))
        presence = _as_dict(await self._presence.load_one(owner_key))
        save = _as_dict(await self._save.load_one(owner_key))
        balance = await self._balance(uid)
        nation_name: Optional[str] = None
        nation_role: Optional[str] = None
        members = _as_dict(await self._nations.load_one("members")) or {}
        nations = _as_dict(await self._nations.load_one("nations")) or {}
        membership = members.get(owner_key)
        if isinstance(membership, dict):
            nation_role = str(membership.get("role", ""))
            nation = nations.get(str(membership.get("nationId", "")))
            if isinstance(nation, dict):
                nation_name = str(nation.get("name", ""))
        lines = build_state_lines(
            user_id=uid,
            balance=balance,
            profile=profile,
            presence=presence,
            save=save,
            nation_name=nation_name,
            nation_role=nation_role,
        )
        await ctx.send(view=WorldBoxStateView(lines))


async def setup(bot: commands.Bot):
    await bot.add_cog(WorldBoxStateCog(bot))
