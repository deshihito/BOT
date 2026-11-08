# -*- coding: utf-8 -*-
"""アイテム: /general のマネージャンルから使う所持・ショップ・宝箱の入口。

定義・所持・効果・抽選の本体は core/general/items/items.py（ItemStore）。ここは Discord
側の表示と、AGO コイン残高の実移動だけを担う。コインの増減は必ず
cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通し、この cog 独自の残高更新は作らない
（cogs/market.py と同じ組み立て）。

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:items / general:item_buy / general:item_use / general:box_open）だけ。
"""
from __future__ import annotations
from core.support.emojis import SUCCESS

import asyncio
import io
import logging
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core.economy_image import PanelRow, render_panel_png
from core.general.items import items as items_core
from core.game.game import prison as prison_core
from core.support.messages import (
    COIN_UPDATE_FAILED_RETRY,
    ITEM_INVALID_INPUT,
    ITEM_NOT_FOUND,
    PURCHASE_FAILED_RETRY,
    item_action_failed,
)
from core.support.panel_v2 import as_panel_v2, edit_panel_v2, edit_panel_view as _edit_panel, wrap_panel_view as _wrap
from cogs import general as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

logger = logging.getLogger(__name__)

ITEMS_COLOR = 0xE67E22
ITEMS_ACCENT = (230, 126, 34)
ITEMS_FILENAME = "items_panel.png"
SHOP_ID = "ITEM_SHOP"
BOX_ID = "TREASURE_BOX"


# ---------------------------------------------------------------------------
# コンポーネントV2 統一（core/support/panel_v2.py の流儀）
# ---------------------------------------------------------------------------


def _item_name(item_id: str) -> str:
    definition = items_core.ITEM_DEFS.get(item_id)
    return definition["name"] if definition else item_id


def _shop_lines() -> tuple[list[str], list[str]]:
    """ショップ表示行を（素材・その他, 効果・消費）の2群で返す。

    全アイテム売却可能（売却額は購入価格の半分）なので売却額は常に併記し、
    効果・消費アイテムには短い効果説明を付ける。
    """
    plain: list[str] = []
    consumables: list[str] = []
    for item_id, definition in items_core.ITEM_DEFS.items():
        if not definition["purchasable"]:
            continue
        line = (f"・{definition['name']} — **{definition['price']:,} AGO**"
                f"（売却 {definition['sell_price']:,} AGO）")
        if definition["kind"] == "consumable":
            line += f"／{definition['desc']}"
            consumables.append(line)
        else:
            plain.append(line)
    return plain, consumables


def _inventory_rows(store: items_core.ItemStore, user_id: int) -> list[PanelRow]:
    """所持アイテムの画像行（_items_embed のフィールドと同じ並び・値）。"""
    inventory = store.inventory(str(user_id))
    return [
        PanelRow(_item_name(item_id), f"×{count}")
        for item_id, count in sorted(inventory.items())
    ]


def _effect_rows(store: items_core.ItemStore, user_id: int) -> list[PanelRow]:
    """発動中の効果の画像行（_items_embed のフィールドと同じ表記）。"""
    uid = str(user_id)
    effects = store.active_effects(uid)
    if not effects:
        return []
    now = datetime.now(config.JST)
    effect_labels = {
        definition.get("effect"): definition["name"]
        for definition in items_core.ITEM_DEFS.values()
        if definition.get("effect")
    }
    rows = []
    for effect_id, expires in effects.items():
        remaining = max(0.0, (expires - now).total_seconds())
        rows.append(PanelRow(
            effect_labels.get(effect_id, effect_id),
            f"あと{prison_core.format_remaining(remaining)}"))
    return rows


def _shop_rows() -> tuple[list[PanelRow], list[PanelRow]]:
    """ショップの画像行（_shop_lines と同じ並び・価格・説明）。"""
    plain: list[PanelRow] = []
    consumables: list[PanelRow] = []
    for item_id, definition in items_core.ITEM_DEFS.items():
        if not definition["purchasable"]:
            continue
        sub = f"売却 {definition['sell_price']:,} AGO"
        if definition["kind"] == "consumable":
            sub += f"／{definition['desc']}"
            consumables.append(PanelRow(
                definition["name"], f"{definition['price']:,} AGO", sub=sub))
        else:
            plain.append(PanelRow(
                definition["name"], f"{definition['price']:,} AGO", sub=sub))
    return plain, consumables


def items_panel_png(store: items_core.ItemStore, user_id: int) -> bytes:
    """アイテムパネル（所持・効果・ショップ）の白基調画像を描く。"""
    plain, consumables = _shop_rows()
    sections: list = [("所持アイテム", _inventory_rows(store, user_id))]
    effect_rows = _effect_rows(store, user_id)
    if effect_rows:
        sections.append(("発動中の効果", effect_rows))
    if plain:
        sections.append(("ショップ（素材ほか）", plain, 2 if len(plain) > 10 else 1))
    if consumables:
        sections.append((
            "ショップ（効果・消費）", consumables,
            2 if len(consumables) > 10 else 1))
    return render_panel_png(
        title="アイテム", accent=ITEMS_ACCENT, sections=sections,
        cache_namespace="items-panel")


def _items_embed(store: items_core.ItemStore, user_id: int,
                 *, image: bool = False) -> discord.Embed:
    uid = str(user_id)
    embed = discord.Embed(title="アイテム", color=ITEMS_COLOR)
    if image:
        # 数値表示は画像（items_panel_png）に寄せ、embed は画像参照と
        # フッターだけを持つ（本文の二重表示を避ける）。
        embed.set_image(url=f"attachment://{ITEMS_FILENAME}")
        embed.set_footer(text="買えない素材は合成や宝箱で手に入ります。")
        return embed
    inventory = store.inventory(uid)
    if inventory:
        lines = [
            f"・{_item_name(item_id)} ×{count}"
            for item_id, count in sorted(inventory.items())
        ]
        embed.add_field(name="所持アイテム", value="\n".join(lines), inline=False)
    else:
        embed.add_field(name="所持アイテム", value="（なし）", inline=False)
    effects = store.active_effects(uid)
    if effects:
        now = datetime.now(config.JST)
        # 効果ID → 発動元アイテム名（定義から引く。無ければIDのまま）。
        effect_labels = {
            definition.get("effect"): definition["name"]
            for definition in items_core.ITEM_DEFS.values()
            if definition.get("effect")
        }
        lines = []
        for effect_id, expires in effects.items():
            # 残り時間の表記は prison.format_remaining に統一する
            # （マネーパネルの「発動中の効果」と同一形式、導線最適化ラウンド4）。
            remaining = max(0.0, (expires - now).total_seconds())
            label = effect_labels.get(effect_id, effect_id)
            lines.append(f"・{label}（あと{prison_core.format_remaining(remaining)}）")
        embed.add_field(name="発動中の効果", value="\n".join(lines), inline=False)
    plain_lines, consumable_lines = _shop_lines()
    if plain_lines:
        embed.add_field(
            name="ショップ（素材ほか）", value="\n".join(plain_lines), inline=False)
    if consumable_lines:
        embed.add_field(
            name="ショップ（効果・消費）", value="\n".join(consumable_lines),
            inline=False)
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
        # 入力形式の手がかりを常に見せる（監査 #7）。アイテム名はパネルの表記どおり。
        self.item.placeholder = "例: スクラップ"
        if action == "use":
            self.amount.required = False
            # 「1固定」の注意は使うときだけ意味があるので、買う/売るでは出さない。
            self.amount.placeholder = "使う場合は1固定です"
        else:
            self.amount.placeholder = "例: 1（半角数字）"

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
        await interaction.response.defer()
        if self.action == "buy":
            message = await self.cog.execute_buy(interaction.user.id, item_id, count)
        elif self.action == "sell":
            message = await self.cog.execute_sell(interaction.user.id, item_id, count)
        else:
            message = self.cog.execute_use(interaction.user.id, item_id)
        await interaction.followup.send(message)


class ItemQuantityModal(discord.ui.Modal):
    """アイテム選択後に数量だけを聞くモーダル（導線最適化 M10）。"""

    amount = discord.ui.TextInput(label="数量", max_length=10, default="1", required=False)

    def __init__(self, cog: "ItemsCog", action: str, item_id: str):
        self.cog = cog
        self.action = action
        self.item_id = item_id
        titles = {"buy": "アイテムを買う", "sell": "アイテムを売る", "use": "アイテムを使う"}
        super().__init__(title=f"{titles[action]}: {_item_name(item_id)}")
        self.amount.placeholder = "使う場合は1固定です" if action == "use" else "例: 1（半角数字）"

    async def on_submit(self, interaction: discord.Interaction):
        raw = str(self.amount.value or "1").replace(",", "").strip() or "1"
        try:
            count = int(raw)
        except ValueError:
            return await interaction.response.send_message(ITEM_INVALID_INPUT, ephemeral=True)
        if count <= 0:
            return await interaction.response.send_message(ITEM_INVALID_INPUT, ephemeral=True)
        await interaction.response.defer()
        if self.action == "buy":
            message = await self.cog.execute_buy(interaction.user.id, self.item_id, count)
        elif self.action == "sell":
            message = await self.cog.execute_sell(interaction.user.id, self.item_id, count)
        else:
            message = self.cog.execute_use(interaction.user.id, self.item_id)
        await interaction.followup.send(message)


def _item_pick_options(cog: "ItemsCog", user_id: int, action: str) -> list[discord.SelectOption]:
    """買う/売る/使うの候補を、対象母集団ごとに組み立てる（M10）。"""
    options: list[discord.SelectOption] = []
    if action == "buy":
        for item_id, definition in items_core.ITEM_DEFS.items():
            if not definition["purchasable"]:
                continue
            options.append(discord.SelectOption(
                label=f"{definition['name']} — {definition['price']:,} AGO", value=item_id))
    else:
        inventory = cog.store.inventory(str(user_id))
        for item_id, count in sorted(inventory.items()):
            definition = items_core.ITEM_DEFS.get(item_id) or {}
            suffix = f"（売却 {definition['sell_price']:,} AGO）" if action == "sell" else ""
            options.append(discord.SelectOption(
                label=f"{_item_name(item_id)} ×{count}{suffix}", value=item_id))
    return options[:25]


class ItemPickView(discord.ui.View):
    """アイテム名の自由記述をやめ、候補から選ばせる中継ビュー（M10）。

    所持品など個人情報を含むため ephemeral で出し、操作は本人のみ。
    """

    def __init__(self, cog: "ItemsCog", user_id: int, action: str,
                 options: list[discord.SelectOption]):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        self.action = action
        titles = {"buy": "買うアイテムを選択", "sell": "売るアイテムを選択",
                  "use": "使うアイテムを選択"}
        self.title = titles[action]
        select = discord.ui.Select(placeholder="アイテムを選択してください", options=options)
        select.callback = self._on_pick
        self.add_item(select)

    async def interaction_check(self, interaction) -> bool:
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return discord.Embed(title=self.title, color=ITEMS_COLOR)

    async def _on_pick(self, interaction: discord.Interaction):
        item_id = interaction.data["values"][0]
        await interaction.response.send_modal(
            ItemQuantityModal(self.cog, self.action, item_id))


async def _send_item_pick(interaction: discord.Interaction, cog: "ItemsCog", action: str):
    options = _item_pick_options(cog, interaction.user.id, action)
    if not options:
        return await interaction.response.send_message(
            "対象のアイテムがありません。", ephemeral=True)
    await interaction.response.send_message(
        view=_wrap(ItemPickView(cog, interaction.user.id, action, options)),
        ephemeral=True)


class ItemsView(discord.ui.View):
    def __init__(self, cog: "ItemsCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        self._png: bytes | None = None
        self._png_ready = False

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def panel_png(self) -> bytes | None:
        """パネル画像（初回だけ描き、失敗時はテキスト表示へ落とす）。"""
        if not self._png_ready:
            self._png_ready = True
            try:
                self._png = items_panel_png(self.cog.store, self.user_id)
            except Exception:
                logger.exception("items: パネル画像の生成に失敗しました")
                self._png = None
        return self._png

    def panel_files(self) -> list[discord.File] | None:
        png = self.panel_png()
        if png is None:
            return None
        return [discord.File(io.BytesIO(png), filename=ITEMS_FILENAME)]

    def embed(self) -> discord.Embed:
        return _items_embed(
            self.cog.store, self.user_id, image=self.panel_png() is not None)

    # 導線最適化ラウンド4: 再描画だけの「更新」ボタンは置かない（S9/R2-5
    # と同じ作法）。所持・効果の状態は自分の操作のたびに更新される。

    @discord.ui.button(label="買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await _send_item_pick(interaction, self.cog, "buy")

    @discord.ui.button(label="売る", style=discord.ButtonStyle.primary)
    async def sell(self, interaction: discord.Interaction, button: discord.ui.Button):
        await _send_item_pick(interaction, self.cog, "sell")

    @discord.ui.button(label="使う", style=discord.ButtonStyle.secondary)
    async def use(self, interaction: discord.Interaction, button: discord.ui.Button):
        await _send_item_pick(interaction, self.cog, "use")

    @discord.ui.button(label="宝箱を開ける", style=discord.ButtonStyle.danger)
    async def open_box(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = await self.cog.execute_open_boxes(interaction.user.id)
        await interaction.followup.send(message)


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
        files = view.panel_files()
        if files:
            await interaction.response.send_message(
                view=_wrap(view), files=files)
        else:
            await interaction.response.send_message(view=_wrap(view))

    async def open_buy(self, interaction: discord.Interaction):
        await _send_item_pick(interaction, self, "buy")

    async def open_sell(self, interaction: discord.Interaction):
        await _send_item_pick(interaction, self, "sell")

    async def open_use(self, interaction: discord.Interaction):
        await _send_item_pick(interaction, self, "use")

    async def open_boxes(self, interaction: discord.Interaction):
        await interaction.response.defer()
        message = await self.execute_open_boxes(interaction.user.id)
        await interaction.followup.send(message)

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
            blocked = prison_core.block_message(uid)
            if blocked:
                return item_action_failed(blocked)
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
                return item_action_failed(COIN_UPDATE_FAILED_RETRY)
            try:
                held = self.store.add(uid, item_id, count)
            except items_core.ItemError as exc:
                # E-5c: debit 後失敗時の返金は戻り値を確認する。
                # None（CAS 枯渇等）なら返金できていないので、成功扱いで
                # 終わらせず critical ログ＋運営への連絡を案内する。
                refund = await wallet._change_balance(uid, total)
                if refund is None or refund is wallet_module.INSUFFICIENT:
                    logger.critical(
                        "items: 購入失敗時の返金に失敗しました。手動で戻してください: "
                        "user=%s item=%s count=%s amount=%s",
                        uid, item_id, count, total)
                    return item_action_failed(
                        "購入に失敗し、コインの返金もできませんでした。"
                        "お手数ですが運営へ連絡してください（記録は残してあります）。")
                return item_action_failed(exc)
            await self._record_history(uid, SHOP_ID, total, "item_buy")
            return (
                f"{SUCCESS} **{definition['name']}を買いました**\n"
                f"{total:,} AGO で {count} 個（所持: {held} 個）\n"
                f"コイン残高: {debit:,} AGO"
            )
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 購入処理に失敗 user=%s item=%s count=%s", uid, item_id, count)
            return item_action_failed(PURCHASE_FAILED_RETRY)

    async def execute_sell(self, user_id: int, item_id: str, count: int) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return item_action_failed(blocked)
            definition = items_core.ITEM_DEFS.get(item_id)
            if definition is None:
                return item_action_failed("そのアイテムは存在しません。")
            # 売却額は全アイテム共通で購入価格の半分（core/general/items/items.py で設定）。
            if count <= 0:
                return item_action_failed("数量を正しく入力してください。")
            total = int(definition["sell_price"]) * count
            wallet = self._wallet()
            self.store.remove(uid, item_id, count)
            # E-1: wallet の DB 即時コミット前にストア側を flush する。
            # クラッシュ時に「アイテム復活＋コイン保持」で再売却できる
            # 窓を塞ぐ（claim_daily_bonus の flush が既存の手本）。
            self.store.flush()
            credit = await wallet._change_balance(uid, total, create_with=0)
            if credit is None or credit is wallet_module.INSUFFICIENT:
                self.store.add(uid, item_id, count)
                return item_action_failed("コインの更新に失敗したため、売却を取り消しました。")
            await self._record_history(SHOP_ID, uid, total, "item_sell")
            held = self.store.count(uid, item_id)
            return (
                f"{SUCCESS} **{definition['name']}を売りました**\n"
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
            blocked = prison_core.block_message(str(user_id))
            if blocked:
                return item_action_failed(blocked)
            return SUCCESS + " " + self.store.use_item(str(user_id), item_id)
        except items_core.ItemError as exc:
            return item_action_failed(exc)
        except Exception:
            logger.exception("items: 使用処理に失敗 user=%s item=%s", user_id, item_id)
            return item_action_failed("使用中にエラーが発生しました。時間をおいて再試行してください。")

    async def execute_open_boxes(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return item_action_failed(blocked)
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
