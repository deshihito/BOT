# -*- coding: utf-8 -*-
"""アイテム: /general のマネージャンルから使う所持・ショップ・宝箱の入口。

定義・所持・効果・抽選の本体は core/items.py（ItemStore）。ここは Discord
側の表示と、AGO コイン残高の実移動だけを担う。コインの増減は必ず
cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通し、この cog 独自の残高更新は作らない
（cogs/market.py と同じ組み立て）。

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:items / general:item_buy / general:item_use / general:box_open）だけ。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core import items as items_core
from core.messages import ITEM_INVALID_INPUT, ITEM_NOT_FOUND, item_action_failed
from cogs import wallet as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

logger = logging.getLogger(__name__)

ITEMS_COLOR = 0xE67E22
SHOP_ID = "ITEM_SHOP"
BOX_ID = "TREASURE_BOX"


def _item_name(item_id: str) -> str:
    definition = items_core.ITEM_DEFS.get(item_id)
    return definition["name"] if definition else item_id


def _shop_lines() -> list[str]:
    lines = []
    for item_id, definition in items_core.ITEM_DEFS.items():
        if not definition["purchasable"]:
            continue
        line = f"・{definition['name']} — **{definition['price']:,} AGO**"
        if definition["sell_price"] is not None:
            line += f"（売却 {definition['sell_price']:,} AGO）"
        lines.append(line)
    return lines


def _items_embed(store: items_core.ItemStore, user_id: int) -> discord.Embed:
    uid = str(user_id)
    embed = discord.Embed(title="アイテム", color=ITEMS_COLOR)
    inventory = store.inventory(uid)
    if inventory:
        lines = [
            f"・{_item_name(item_id)} ×{count}"
            for item_id, count in sorted(inventory.items())
        ]
        embed.add_field(name="所持アイテム", value="\n".join(lines), inline=False)
    else:
        embed.add_field(name="所持アイテム", value="（なし）", inline=False)
    embed.add_field(
        name="宝箱", value=f"**{inventory.get('treasure_box', 0)} 個**", inline=True)
    effects = store.active_effects(uid)
    if effects:
        now = datetime.now(config.JST)
        lines = []
        for effect_id, expires in effects.items():
            remaining = max(0.0, (expires - now).total_seconds() / 3600)
            label = "手数料パス" if effect_id == items_core.FEE_DISCOUNT_EFFECT else effect_id
            lines.append(f"・{label}（あと約 {remaining:.1f} 時間）")
        embed.add_field(name="発動中の効果", value="\n".join(lines), inline=False)
    embed.add_field(name="ショップ", value="\n".join(_shop_lines()), inline=False)
    embed.set_footer(text="買えない素材は合成や宝箱で手に入ります。")
    return embed


class ItemAmountModal(discord.ui.Modal):
    item = discord.ui.TextInput(label="アイテム名", max_length=64)
    amount = discord.ui.TextInput(label="数量", max_length=10, default="1", required=False)

    def __init__(self, cog: "ItemsCog", action: str):
        self.cog = cog
        self.action = action
        titles = {"buy": "アイテムを買う", "sell": "アイテムを売る", "use": "アイテムを使う"}
        super().__init__(title=titles[action])
        if action == "use":
            self.amount.required = False
            self.amount.placeholder = "使う場合は1固定です"

    async def on_submit(self, interaction: discord.Interaction):
        item_id = items_core.resolve_item_id(str(self.item.value))
        if item_id is None:
            return await interaction.response.send_message(ITEM_NOT_FOUND, ephemeral=True)
        raw = str(self.amount.value or "1").replace(",", "").strip() or "1"
        try:
            count = int(raw)
        except ValueError:
            return await interaction.response.send_message(ITEM_INVALID_INPUT, ephemeral=True)
        if count <= 0:
            return await interaction.response.send_message(ITEM_INVALID_INPUT, ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        if self.action == "buy":
            message = await self.cog.execute_buy(interaction.user.id, item_id, count)
        elif self.action == "sell":
            message = await self.cog.execute_sell(interaction.user.id, item_id, count)
        else:
            message = self.cog.execute_use(interaction.user.id, item_id)
        await interaction.followup.send(message, ephemeral=True)


class ItemsView(discord.ui.View):
    def __init__(self, cog: "ItemsCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary)
    async def refresh(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(
            embed=_items_embed(self.cog.store, self.user_id), view=self)

    @discord.ui.button(label="買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(ItemAmountModal(self.cog, "buy"))

    @discord.ui.button(label="売る", style=discord.ButtonStyle.primary)
    async def sell(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(ItemAmountModal(self.cog, "sell"))

    @discord.ui.button(label="使う", style=discord.ButtonStyle.secondary)
    async def use(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(ItemAmountModal(self.cog, "use"))

    @discord.ui.button(label="宝箱を開ける", style=discord.ButtonStyle.danger)
    async def open_box(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        message = await self.cog.execute_open_boxes(interaction.user.id)
        await interaction.followup.send(message, ephemeral=True)


class ItemsCog(commands.Cog):
    def __init__(self, bot: commands.Bot, store: items_core.ItemStore | None = None):
        self.bot = bot
        self.store = store if store is not None else items_core.ItemStore()

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.store.flush()

    @tasks.loop(seconds=items_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.store.maybe_flush()
        except Exception:
            logger.exception("items: 定期フラッシュに失敗しました")

    @flush_loop.before_loop
    async def _before_flush_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------ 入口
    async def show_items(self, interaction: discord.Interaction):
        view = ItemsView(self, interaction.user.id)
        await interaction.response.send_message(
            embed=_items_embed(self.store, interaction.user.id), view=view, ephemeral=True)

    async def open_buy(self, interaction: discord.Interaction):
        await interaction.response.send_modal(ItemAmountModal(self, "buy"))

    async def open_use(self, interaction: discord.Interaction):
        await interaction.response.send_modal(ItemAmountModal(self, "use"))

    async def open_boxes(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        message = await self.execute_open_boxes(interaction.user.id)
        await interaction.followup.send(message, ephemeral=True)

    # ------------------------------------------------------------------ 実行
    def _wallet(self):
        wallet = self.bot.get_cog("WalletCog")
        if wallet is None:
            raise items_core.ItemError("コイン機能が読み込まれていません。")
        return wallet

    async def _record_history(self, sender_id: str, receiver_id: str, amount: int, reason: str) -> None:
        try:
            await asyncio.to_thread(lambda: config.db_api.table("transaction_history").insert({
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "amount": amount,
                "reason": reason,
            }).execute())
        except Exception:
            # 操作自体は終わっているので、履歴だけ残せなかったことを記録する（wallet.pay と同方針）。
            logger.exception("items: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                             sender_id, receiver_id, amount)

    async def execute_buy(self, user_id: int, item_id: str, count: int) -> str:
        uid = str(user_id)
        try:
            definition = items_core.ITEM_DEFS.get(item_id)
            if definition is None:
                return item_action_failed("そのアイテムは存在しません。")
            if not definition["purchasable"]:
                return item_action_failed(f"{definition['name']}はショップでは買えません。")
            if count <= 0:
                return item_action_failed("数量を正しく入力してください。")
            total = int(definition["price"]) * count
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -total, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return item_action_failed("コインが不足しています。")
            if debit is None:
                return item_action_failed("コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                held = self.store.add(uid, item_id, count)
            except items_core.ItemError as exc:
                await wallet._change_balance(uid, total)
                return item_action_failed(exc)
            await self._record_history(uid, SHOP_ID, total, "item_buy")
            return (
                f"✅ **{definition['name']}を買いました**\n"
                f"{total:,} AGO で {count} 個（所持: {held} 個）\n"
                f"コイン残高: {debit:,} AGO"
            )
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 購入処理に失敗 user=%s item=%s count=%s", uid, item_id, count)
            return item_action_failed("購入中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_sell(self, user_id: int, item_id: str, count: int) -> str:
        uid = str(user_id)
        try:
            definition = items_core.ITEM_DEFS.get(item_id)
            if definition is None:
                return item_action_failed("そのアイテムは存在しません。")
            if definition["sell_price"] is None:
                return item_action_failed(f"{definition['name']}は売却できません。")
            if count <= 0:
                return item_action_failed("数量を正しく入力してください。")
            total = int(definition["sell_price"]) * count
            wallet = self._wallet()
            self.store.remove(uid, item_id, count)
            credit = await wallet._change_balance(uid, total, create_with=0)
            if credit is None or credit is wallet_module.INSUFFICIENT:
                self.store.add(uid, item_id, count)
                return item_action_failed("コインの更新に失敗したため、売却を取り消しました。")
            await self._record_history(SHOP_ID, uid, total, "item_sell")
            held = self.store.count(uid, item_id)
            return (
                f"✅ **{definition['name']}を売りました**\n"
                f"{count} 個 → **{total:,} AGO**（所持: {held} 個）\n"
                f"コイン残高: {credit:,} AGO"
            )
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 売却処理に失敗 user=%s item=%s count=%s", uid, item_id, count)
            return item_action_failed("売却中にエラーが発生しました。時間をおいて再試行してください。")

    def execute_use(self, user_id: int, item_id: str) -> str:
        try:
            return "✅ " + self.store.use_item(str(user_id), item_id)
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 使用処理に失敗 user=%s item=%s", user_id, item_id)
            return item_action_failed("使用中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_open_boxes(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            result = self.store.open_boxes(uid)
            coins = int(result["coins"])
            balance = None
            if coins > 0:
                wallet = self._wallet()
                balance = await wallet._change_balance(uid, coins, create_with=0)
                if balance is None or balance is wallet_module.INSUFFICIENT:
                    self.store.rollback_open(uid, result)
                    return item_action_failed("コインの更新に失敗したため、開封を取り消しました。")
                await self._record_history(BOX_ID, uid, coins, "box_open")
            lines = [f"🎁 **宝箱を {result['opened']} 個開けました**"]
            if coins > 0:
                lines.append(f"コイン: **{coins:,} AGO**")
            for item_id, count in sorted(result["items"].items()):
                lines.append(f"・{_item_name(item_id)} ×{count}")
            if balance is not None:
                lines.append(f"コイン残高: {balance:,} AGO")
            if coins <= 0 and not result["items"]:
                lines.append("中身は空でした。")
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 宝箱の開封に失敗 user=%s", uid)
            return item_action_failed("開封中にエラーが発生しました。時間をおいて再試行してください。")


async def setup(bot: commands.Bot):
    await bot.add_cog(ItemsCog(bot))
