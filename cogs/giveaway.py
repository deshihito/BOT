"""抽選（giveaway）。入口は /giveaway の 1 つだけ。

- 主催者が賞品・当選人数・期間・チャンネル・（任意）参加に必要なロール・（任意）参加費を決める。
- 参加はボタン。もう一度押すと参加を取り消す（参加費は返金）。
- 時間になると自動で抽選。主催者（またはサーバー管理権限のある人）は「管理」ボタンから
  今すぐ終了・再抽選・中止ができる（中止すると参加費は全員に返金）。
- 状態は core/storage.py の KVStore（bot_kv、namespace "giveaway"）に保存し、再起動後はタイマーを再開する。
- 参加費は /pay と同じ残高更新（WalletCog._change_balance、残高を読み直して食い違いなら再試行）で引く。
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Optional

import discord
from discord import app_commands
from discord.ext import commands

from core.storage import KVStore
from cogs.wallet import INSUFFICIENT, coin_embed

log = logging.getLogger(__name__)

NAMESPACE = "giveaway"
JOIN_PREFIX = "giveaway:join:"
MANAGE_PREFIX = "giveaway:manage:"
MAX_WINNERS = 20
MAX_MINUTES = 60 * 24 * 14   # 最長 2 週間
MAX_COST = 100_000
KEEP_FINISHED_SECONDS = 7 * 24 * 3600  # 終わった抽選は 1 週間だけ残す（再抽選用）

RUNNING, ENDED, CANCELLED = "running", "ended", "cancelled"


def draw(entrants: list[int], count: int, exclude: tuple[int, ...] = (), rng: random.Random | None = None) -> list[int]:
    pool = [u for u in dict.fromkeys(entrants) if u not in set(exclude)]
    return (rng or random).sample(pool, min(count, len(pool)))


def build_embed(g: dict[str, Any]) -> tuple[discord.Embed, dict]:
    status = g["status"]
    title = {RUNNING: "<:PREMIUM_AGO_TICKET:1559334882809872474> 抽選", ENDED: "🎉 抽選結果", CANCELLED: "🚫 抽選（中止）"}[status]
    embed, extra = coin_embed(f"{title}: {g['prize']}")
    embed.add_field(name="当選人数", value=f"{g['winners']} 人", inline=True)
    embed.add_field(name="参加者", value=f"{len(g['entrants'])} 人", inline=True)
    embed.add_field(name="主催", value=f"<@{g['host_id']}>", inline=True)
    if g.get("role_id"):
        embed.add_field(name="参加条件", value=f"<@&{g['role_id']}> のロール", inline=True)
    if g.get("cost"):
        embed.add_field(name="参加費", value=f"{g['cost']:,} AGO（取り消し・中止なら返金）", inline=True)
    if status == RUNNING:
        embed.description = f"下の「参加する」を押して参加。もう一度押すと取り消せます。\n締め切り: <t:{int(g['ends_at'])}:R>"
    elif status == ENDED:
        winners = g.get("winner_ids") or []
        embed.description = ("当選: " + " ".join(f"<@{u}>" for u in winners)) if winners else "参加者がいなかったため、当選者はいません。"
        if g.get("winner_dm_message") or g.get("winner_dm_link"):
            embed.description += "\n当選者へDMで案内を送信します。"
    else:
        embed.description = "この抽選は中止されました。"
    return embed, extra


def build_view(message_id: int, g: dict[str, Any]) -> discord.ui.View:
    view = discord.ui.View(timeout=None)
    if g["status"] == RUNNING:
        view.add_item(discord.ui.Button(label="参加する / 取り消す", emoji="<:PREMIUM_AGO_TICKET:1559334882809872474>", style=discord.ButtonStyle.success,
                                        custom_id=f"{JOIN_PREFIX}{message_id}"))
    if g["status"] != CANCELLED:
        view.add_item(discord.ui.Button(label="管理", style=discord.ButtonStyle.secondary,
                                        custom_id=f"{MANAGE_PREFIX}{message_id}"))
    return view


class ManageView(discord.ui.View):
    """主催者にだけ見える管理ボタン。"""

    def __init__(self, cog: "GiveawayCog", message_id: int, status: str):
        super().__init__(timeout=300)
        self.cog, self.message_id = cog, message_id
        if status == RUNNING:
            self._add("今すぐ抽選して終了", discord.ButtonStyle.primary, self.on_end)
            self._add("中止（参加費は返金）", discord.ButtonStyle.danger, self.on_cancel)
        else:
            self._add("再抽選", discord.ButtonStyle.primary, self.on_reroll)

    def _add(self, label, style, handler):
        b = discord.ui.Button(label=label, style=style)
        b.callback = handler
        self.add_item(b)

    async def on_end(self, interaction):
        ok = await self.cog.finish(self.message_id)
        await interaction.response.edit_message(content="抽選して終了しました。" if ok else "この抽選はもう終わっています。", view=None)

    async def on_cancel(self, interaction):
        ok = await self.cog.cancel(self.message_id)
        await interaction.response.edit_message(content="中止しました。" if ok else "この抽選はもう終わっています。", view=None)

    async def on_reroll(self, interaction):
        new = await self.cog.reroll(self.message_id)
        text = ("再抽選しました: " + " ".join(f"<@{u}>" for u in new)) if new else "再抽選できる参加者が残っていません。"
        await interaction.response.edit_message(content=text, view=None)


class GiveawayCog(commands.Cog):
    def __init__(self, bot: commands.Bot, kv: Optional[KVStore] = None, clock=time.time):
        self.bot = bot
        self.kv = kv or KVStore(NAMESPACE)
        self.clock = clock
        self.data: dict[str, dict[str, Any]] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self._loaded = False

    # ------------------------------------------------------------ 起動・保存
    async def cog_load(self):
        asyncio.get_running_loop().create_task(self.resume())

    def cog_unload(self):
        for task in self.tasks.values():
            task.cancel()

    async def resume(self, wait_ready: bool = True) -> None:
        """保存してある抽選を読み込み、進行中のもののタイマーを再開する。"""
        if wait_ready and hasattr(self.bot, "wait_until_ready"):
            await self.bot.wait_until_ready()
        try:
            stored = await self.kv.load_all()
        except Exception:
            log.exception("抽選の読み込みに失敗しました")
            stored = {}
        now = self.clock()
        for key, g in stored.items():
            if not isinstance(g, dict) or "status" not in g:
                continue
            if g["status"] != RUNNING and now - g.get("ends_at", 0) > KEEP_FINISHED_SECONDS:
                await self.kv.delete(key)
                continue
            self.data[key] = g
            if g["status"] == RUNNING:
                self.schedule(key)
        self._loaded = True

    async def save(self, key: str) -> None:
        await self.kv.set(key, self.data[key])

    def lock(self, key: str) -> asyncio.Lock:
        return self.locks.setdefault(key, asyncio.Lock())

    def schedule(self, key: str) -> None:
        old = self.tasks.pop(key, None)
        if old:
            old.cancel()
        self.tasks[key] = asyncio.get_running_loop().create_task(self._timer(key))

    async def _timer(self, key: str) -> None:
        try:
            delay = self.data[key]["ends_at"] - self.clock()
            if delay > 0:
                await asyncio.sleep(delay)
            await self.finish(int(key), from_timer=True)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("抽選 %s の自動終了に失敗しました", key)

    # ------------------------------------------------------------ メッセージ
    async def _channel(self, g):
        ch = self.bot.get_channel(g["channel_id"])
        if ch is None:
            try:
                ch = await self.bot.fetch_channel(g["channel_id"])
            except Exception:
                return None
        return ch

    async def refresh_message(self, key: str) -> None:
        g = self.data[key]
        ch = await self._channel(g)
        if ch is None:
            return
        try:
            msg = ch.get_partial_message(int(key))
            embed, _ = build_embed(g)  # 画像は最初の投稿の添付をそのまま使う
            await msg.edit(embed=embed, view=build_view(int(key), g))
        except Exception:
            log.warning("抽選 %s のメッセージを更新できませんでした", key, exc_info=True)

    async def announce(self, g, text: str, key: str) -> None:
        ch = await self._channel(g)
        if ch is None:
            return
        try:
            await ch.send(text, reference=ch.get_partial_message(int(key)), mention_author=False,
                          allowed_mentions=discord.AllowedMentions(users=True, roles=False, everyone=False))
        except Exception:
            log.warning("抽選 %s の結果を送れませんでした", key, exc_info=True)

    # ------------------------------------------------------------ コイン
    def wallet(self):
        return self.bot.get_cog("WalletCog") if hasattr(self.bot, "get_cog") else None

    async def _coins(self, user_id: int, delta: int, *, require_funds: bool = False):
        wallet = self.wallet()
        if wallet is None:
            return None
        try:
            return await wallet._change_balance(str(user_id), delta, require_funds=require_funds)
        except Exception:
            log.exception("抽選: 残高の更新に失敗 user=%s delta=%s", user_id, delta)
            return None

    async def _refund(self, g, user_id: int) -> bool:
        if not g.get("cost") or user_id not in g.get("paid", []):
            return True
        result = await self._coins(user_id, g["cost"])
        if result is None or result is INSUFFICIENT:
            log.critical("抽選: 返金に失敗しました。手動で戻してください: user=%s amount=%s prize=%s",
                         user_id, g["cost"], g["prize"])
            return False
        g["paid"].remove(user_id)
        return True

    # ------------------------------------------------------------ 操作
    async def create(self, *, message_id: int, guild_id: int, channel_id: int, host_id: int, prize: str,
                     winners: int, minutes: int, role_id: Optional[int] = None, cost: int = 0,
                     winner_dm_message: Optional[str] = None, winner_dm_link: Optional[str] = None) -> dict:
        key = str(message_id)
        self.data[key] = {
            "guild_id": guild_id, "channel_id": channel_id, "host_id": host_id, "prize": prize,
            "winners": winners, "ends_at": self.clock() + minutes * 60, "role_id": role_id, "cost": cost,
            "winner_dm_message": winner_dm_message, "winner_dm_link": winner_dm_link,
            "entrants": [], "paid": [], "winner_ids": [], "status": RUNNING,
        }
        await self.save(key)
        self.schedule(key)
        return self.data[key]

    async def toggle_entry(self, message_id: int, member) -> str:
        """参加/取り消し。結果の文章を返す。"""
        key = str(message_id)
        async with self.lock(key):
            g = self.data.get(key)
            if g is None or g["status"] != RUNNING:
                return "この抽選はもう締め切られています。"
            uid = member.id
            if uid in g["entrants"]:
                if not await self._refund(g, uid):
                    await self.save(key)
                    return "返金に失敗したため、参加は取り消していません。時間を置いてもう一度押してください。"
                g["entrants"].remove(uid)
                await self.save(key)
                note = f"（参加費 {g['cost']:,} AGO を返金しました）" if g.get("cost") else ""
                result = f"参加を取り消しました。{note}"
            else:
                if getattr(member, "bot", False):
                    return "Bot は参加できません。"
                if g.get("role_id") and g["role_id"] not in [r.id for r in getattr(member, "roles", [])]:
                    return f"この抽選に参加するには <@&{g['role_id']}> のロールが必要です。"
                if g.get("cost"):
                    paid = await self._coins(uid, -g["cost"], require_funds=True)
                    if paid is INSUFFICIENT:
                        return f"残高が足りません（参加費 {g['cost']:,} AGO）。`/user_status` で確認してください。"
                    if paid is None:
                        return "参加費の支払いでエラーが起きました。残高は変わっていません。"
                    g["paid"].append(uid)
                g["entrants"].append(uid)
                await self.save(key)
                note = f"（参加費 {g['cost']:,} AGO を支払いました）" if g.get("cost") else ""
                result = f"参加しました！ もう一度押すと取り消せます。{note}"
        await self.refresh_message(key)
        return result

    async def finish(self, message_id: int, from_timer: bool = False) -> bool:
        key = str(message_id)
        async with self.lock(key):
            g = self.data.get(key)
            if g is None or g["status"] != RUNNING:
                return False
            g["winner_ids"] = draw(g["entrants"], g["winners"])
            g["status"] = ENDED
            g["ends_at"] = min(g["ends_at"], self.clock())
            await self.save(key)
        if not from_timer:
            task = self.tasks.pop(key, None)
            if task:
                task.cancel()
        else:
            self.tasks.pop(key, None)
        await self.refresh_message(key)
        winners = g["winner_ids"]
        await self.announce(g, (f"🎉 **{g['prize']}** の当選者: " + " ".join(f"<@{u}>" for u in winners) + " おめでとうございます！")
                            if winners else f"**{g['prize']}** の抽選は参加者がいなかったため、当選者はいません。", key)
        if winners:
            await self.dm_winners(g, winners)
        return True

    async def dm_winners(self, g, winner_ids):
        text = f"🎉 抽選「{g['prize']}」に当選しました！"
        if g.get("winner_dm_message"):
            text += "\n" + g["winner_dm_message"]
        if g.get("winner_dm_link"):
            text += "\n" + g["winner_dm_link"]
        for uid in winner_ids:
            try:
                user = self.bot.get_user(uid) if hasattr(self.bot, "get_user") else None
                if user is None:
                    user = await self.bot.fetch_user(uid)
                await user.send(text, allowed_mentions=discord.AllowedMentions.none())
            except Exception:
                log.info("抽選当選DMを送信できませんでした user=%s", uid, exc_info=True)

    async def reroll(self, message_id: int) -> list[int]:
        """前回の当選者を除いて、当選人数ぶん引き直す。"""
        key = str(message_id)
        async with self.lock(key):
            g = self.data.get(key)
            if g is None or g["status"] != ENDED:
                return []
            new = draw(g["entrants"], g["winners"], exclude=tuple(g.get("winner_ids") or []))
            if not new:
                return []
            g["winner_ids"] = new
            await self.save(key)
        await self.refresh_message(key)
        await self.announce(g, f"<:restart:1563559489121030184> **{g['prize']}** を再抽選しました。当選: " + " ".join(f"<@{u}>" for u in new), key)
        await self.dm_winners(g, new)
        return new

    async def cancel(self, message_id: int) -> bool:
        key = str(message_id)
        async with self.lock(key):
            g = self.data.get(key)
            if g is None or g["status"] != RUNNING:
                return False
            for uid in list(g.get("paid", [])):
                await self._refund(g, uid)
            g["status"] = CANCELLED
            g["ends_at"] = min(g["ends_at"], self.clock())
            await self.save(key)
        task = self.tasks.pop(key, None)
        if task:
            task.cancel()
        await self.refresh_message(key)
        return True

    def can_manage(self, g, member) -> bool:
        perms = getattr(member, "guild_permissions", None)
        return member.id == g["host_id"] or bool(perms and perms.manage_guild)

    # ------------------------------------------------------------ Discord
    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return
        custom_id = (interaction.data or {}).get("custom_id", "")
        if custom_id.startswith(JOIN_PREFIX):
            await interaction.response.defer(ephemeral=True, thinking=True)
            text = await self.toggle_entry(int(custom_id[len(JOIN_PREFIX):]), interaction.user)
            await interaction.followup.send(text, ephemeral=True)
        elif custom_id.startswith(MANAGE_PREFIX):
            mid = int(custom_id[len(MANAGE_PREFIX):])
            g = self.data.get(str(mid))
            if g is None:
                return await interaction.response.send_message("この抽選のデータが見つかりません。", ephemeral=True)
            if not self.can_manage(g, interaction.user):
                return await interaction.response.send_message("管理できるのは主催者とサーバー管理者だけです。", ephemeral=True)
            await interaction.response.send_message("この抽選の操作を選んでください。", view=ManageView(self, mid, g["status"]),
                                                    ephemeral=True)

    async def giveaway(self, interaction: discord.Interaction, prize: app_commands.Range[str, 1, 200],
                       winners: app_commands.Range[int, 1, MAX_WINNERS], minutes: app_commands.Range[int, 1, MAX_MINUTES],
                       channel: Optional[discord.TextChannel] = None, required_role: Optional[discord.Role] = None,
                       cost: app_commands.Range[int, 0, MAX_COST] = 0,
                       winner_dm_message: Optional[app_commands.Range[str, 1, 500]] = None,
                       winner_dm_link: Optional[app_commands.Range[str, 1, 500]] = None):
        channel = channel or interaction.channel
        if cost and self.wallet() is None:
            return await interaction.response.send_message("コインの機能が読み込まれていないため、参加費は設定できません。", ephemeral=True)
        await interaction.response.defer(ephemeral=True, thinking=True)
        g = {"prize": prize, "winners": winners, "ends_at": self.clock() + minutes * 60, "host_id": interaction.user.id,
             "role_id": required_role.id if required_role else None, "cost": cost,
             "winner_dm_message": winner_dm_message, "winner_dm_link": winner_dm_link,
             "entrants": [], "status": RUNNING}
        embed, extra = build_embed(g)
        try:
            message = await channel.send(embed=embed, **extra)
        except discord.HTTPException:
            return await interaction.followup.send(f"{channel.mention} に投稿できませんでした。Bot の権限を確認してください。", ephemeral=True)
        await self.create(message_id=message.id, guild_id=interaction.guild_id, channel_id=channel.id,
                          host_id=interaction.user.id, prize=prize, winners=winners, minutes=minutes,
                          role_id=g["role_id"], cost=cost, winner_dm_message=winner_dm_message,
                          winner_dm_link=winner_dm_link)
        await message.edit(view=build_view(message.id, self.data[str(message.id)]))
        await interaction.followup.send(f"{channel.mention} に抽選を出しました。メッセージの「管理」から終了・再抽選・中止ができます。",
                                        ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(GiveawayCog(bot))
