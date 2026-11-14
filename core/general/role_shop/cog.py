# -*- coding: utf-8 -*-
"""有期限ロールショップ（ギルド管理者設定型）。

ロールはギルド固有のため、商品棚はギルドごとに管理者が自ギルドの
ロールを登録する形にした（core/general/role_shop/role_shop.py）:

- 管理者（Manage Roles）がロール・価格・期間（日数）を登録（上限あり）
- メンバーが購入すると即時付与され、期限切れで自動剥奪される
- 剥奪は lazy 判定＋10分ごとのスイープ＋起動時スイープで担保する
- Bot に Manage Roles が無い／ロールが Bot の最上位ロール以上なら
  購入前に弾く（登録時にも同じ確認をする）

支払いは wallet の CAS 経路＋理由コード role_buy。購入はマネー系の
実行なので、逮捕中は各 cog の execute_* と同じく入口で拒否する。
入口は新規スラッシュを作らず、/general のマネージャンル
（general:role_shop）とマネーパネルのボタンから。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core.general import economy_helpers
from core.economy_image import PanelRow, render_panel_png
from core.support import guild_settings
from core.game.game import prison as prison_core
from core.general.role_shop import role_shop as shop_core
from core.support.messages import COIN_UPDATE_FAILED_UNCHANGED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2, wrap_panel_view as _wrap
from cogs import general as wallet_module

logger = logging.getLogger(__name__)

SHOP_COLOR = 0x9B59B6


SHOP_ACCENT = (155, 89, 182)
SHOP_FILENAME = "role_shop.png"


def role_shop_rows(snapshot: dict) -> list[PanelRow]:
    """カタログ画像の行（shop_embed のフィールドと同じ値・並び）。"""
    grants = snapshot["grants"]
    rows = []
    for product in snapshot["products"]:
        sub = ""
        until = grants.get(product["role_id"])
        if until is not None:
            sub = f"所持中（{until.strftime('%m/%d %H:%M')} まで）"
        rows.append(PanelRow(
            product["name"],
            f"{product['price']:,} AGO／{product['days']}日",
            sub=sub))
    return rows


def role_shop_panel_png(snapshot: dict) -> bytes | None:
    """ロールショップの商品カタログ画像（商品が無いときは None）。"""
    if not snapshot["products"]:
        return None
    return render_panel_png(
        title="ロールショップ", accent=SHOP_ACCENT,
        sections=[(None, role_shop_rows(snapshot))],
        cache_namespace="role-shop")


def shop_embed(snapshot: dict, *, image: bool = False) -> discord.Embed:
    embed = discord.Embed(title="ロールショップ", color=SHOP_COLOR)
    items = snapshot["products"]
    if not items:
        embed.description = "まだ商品が登録されていません。"
        return embed
    if image:
        # 商品表示は画像（role_shop_panel_png）に寄せ、embed は画像参照
        # だけを持つ（本文の二重表示を避ける）。
        embed.set_image(url=f"attachment://{SHOP_FILENAME}")
        return embed
    for row in role_shop_rows(snapshot):
        value = row.value
        if row.sub:
            value += f"\n{row.sub}"
        embed.add_field(name=row.label, value=value, inline=False)
    return embed


class RoleShopView(discord.ui.View):
    """商品一覧＋購入ボタン。管理者には登録・削除ボタンも出す。"""

    def __init__(self, cog: "RoleShopCog", guild: discord.Guild,
                 user_id: int, snapshot: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild = guild
        self.user_id = user_id
        self.snapshot = snapshot
        self.message: discord.Message | None = None
        self._v2 = None
        self._png: bytes | None = None
        self._png_ready = False
        self.refresh()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    def panel_png(self) -> bytes | None:
        if not self._png_ready:
            self._png_ready = True
            try:
                self._png = role_shop_panel_png(self.snapshot)
            except Exception:
                logger.exception("role_shop: カタログ画像の生成に失敗しました")
                self._png = None
        return self._png

    async def prepare_png(self) -> None:
        """パネル画像をワーカースレッドで先に描いておく。

        panel_png() の遅延描画を非同期側で済ませ、以降の panel_png() /
        panel_files() / embed() はキャッシュを返すだけにする。
        """
        if not self._png_ready:
            self._png_ready = True
            try:
                self._png = await asyncio.to_thread(
                    role_shop_panel_png, self.snapshot)
            except Exception:
                logger.exception("role_shop: カタログ画像の生成に失敗しました")
                self._png = None

    def panel_files(self) -> list[discord.File] | None:
        png = self.panel_png()
        if png is None:
            return None
        return [discord.File(io.BytesIO(png), filename=SHOP_FILENAME)]

    def embed(self) -> discord.Embed:
        return shop_embed(self.snapshot, image=self.panel_png() is not None)

    def refresh(self) -> None:
        self.clear_items()
        row = 0
        for index, product in enumerate(self.snapshot["products"]):
            if index and index % 5 == 0:
                row += 1
            button = discord.ui.Button(
                label=f"買う: {product['name']}"[:80],
                style=discord.ButtonStyle.success, row=min(row, 4))
            button.callback = self._make_buy(product["role_id"])
            self.add_item(button)
        if self.snapshot["can_manage"]:
            admin_row = min(row + 1, 4) if self.snapshot["products"] else 0
            register = discord.ui.Button(
                label="商品を登録", style=discord.ButtonStyle.primary, row=admin_row)
            register.callback = self._open_register
            self.add_item(register)
            delete = discord.ui.Button(
                label="商品を削除", style=discord.ButtonStyle.danger, row=admin_row)
            delete.callback = self._open_delete
            self.add_item(delete)

    def _make_buy(self, role_id: int):
        async def callback(interaction: discord.Interaction):
            await interaction.response.defer()
            member = interaction.user
            message = await self.cog.buy(self.guild, member, role_id)
            await interaction.followup.send(message)
            await self._reload(interaction)

        return callback

    async def _reload(self, interaction: discord.Interaction) -> None:
        self.snapshot = await self.cog.snapshot(self.guild, self.user_id)
        self._png_ready = False  # スナップショットが変わったので画像を作り直す
        await self.prepare_png()
        self.refresh()
        container = getattr(self, "_v2", None)
        try:
            if container is not None:
                container._sync()
                await edit_panel_v2(
                    interaction, container, files=self.panel_files())
            elif self.message is not None:
                await self.message.edit(
                    embed=self.embed(), view=self,
                    attachments=self.panel_files() or [])
        except Exception:
            logger.exception("role_shop: パネルの更新に失敗しました")

    async def _open_register(self, interaction: discord.Interaction):
        view = RegisterRoleView(self.cog, self.guild, self.user_id)
        await interaction.response.send_message(
            "登録するロールを選んでください。", view=view, ephemeral=True)

    async def _open_delete(self, interaction: discord.Interaction):
        if not self.snapshot["products"]:
            return await interaction.response.send_message(
                "登録されている商品がありません。", ephemeral=True)
        view = DeleteProductView(
            self.cog, self.guild, self.snapshot["products"], self.user_id)
        await interaction.response.send_message(
            "削除する商品を選んでください。", view=view, ephemeral=True)


class RegisterRoleView(discord.ui.View):
    """登録するロールを選ぶ（選ぶと価格・期間のモーダルが開く）。

    開いた管理者本人だけが操作できる (B-4 の多層防御)。
    """

    def __init__(self, cog: "RoleShopCog", guild: discord.Guild,
                 user_id: int | None = None):
        super().__init__(timeout=180)
        self.cog = cog
        self.guild = guild
        self.user_id = user_id
        select = discord.ui.RoleSelect(
            placeholder="登録するロールを選択", min_values=1, max_values=1)
        select.callback = self._on_select
        self.add_item(select)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return self.user_id is None or interaction.user.id == self.user_id

    async def _on_select(self, interaction: discord.Interaction):
        values = (getattr(interaction, "data", {}) or {}).get("values") or []
        if not values:
            return await interaction.response.send_message(
                "ロールを取得できませんでした。", ephemeral=True)
        role = self.guild.get_role(int(values[0]))
        if role is None:
            return await interaction.response.send_message(
                "ロールが見つかりませんでした。", ephemeral=True)
        await interaction.response.send_modal(
            RegisterModal(self.cog, self.guild, role, self.user_id))


class RegisterModal(discord.ui.Modal, title="ロールを商品として登録"):
    price = discord.ui.TextInput(
        label="価格（AGO）", placeholder="例: 3000", max_length=10)
    days = discord.ui.TextInput(
        label="期間（日数）", placeholder="例: 30", max_length=4)

    def __init__(self, cog: "RoleShopCog", guild: discord.Guild, role: discord.Role,
                 user_id: int | None = None):
        super().__init__()
        self.cog = cog
        self.guild = guild
        self.role = role
        self.user_id = user_id

    async def on_submit(self, interaction: discord.Interaction):
        # モーダルには interaction_check が無いため、開いた管理者本人か
        # ここで検証する (B-4)。
        if self.user_id is not None and interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "この登録画面を開いた管理者だけが送信できます。", ephemeral=True)
        try:
            price = int(str(self.price.value).strip())
            days = int(str(self.days.value).strip())
        except ValueError:
            return await interaction.response.send_message(
                "価格と期間は数字で入力してください。", ephemeral=True)
        message = await self.cog.register_product(
            self.guild, self.role, price, days, operator=interaction.user)
        await interaction.response.send_message(message, ephemeral=True)


class DeleteProductView(discord.ui.View):
    """削除する商品を選ぶ。開いた管理者本人だけが操作できる (B-4)。"""

    def __init__(self, cog: "RoleShopCog", guild: discord.Guild, products: list,
                 user_id: int | None = None):
        super().__init__(timeout=180)
        self.cog = cog
        self.guild = guild
        self.user_id = user_id
        select = discord.ui.Select(
            placeholder="削除する商品を選択",
            options=[
                discord.SelectOption(
                    label=product["name"][:100], value=str(product["role_id"]))
                for product in products
            ])
        select.callback = self._on_select
        self.add_item(select)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return self.user_id is None or interaction.user.id == self.user_id

    async def _on_select(self, interaction: discord.Interaction):
        values = (getattr(interaction, "data", {}) or {}).get("values") or []
        if not values:
            return await interaction.response.send_message(
                "商品を取得できませんでした。", ephemeral=True)
        message = await self.cog.unregister_product(
            self.guild, int(values[0]), operator=interaction.user)
        await interaction.response.send_message(message, ephemeral=True)
        self.stop()


class RoleShopManageView(discord.ui.View):
    """商品管理の独立入口（登録・削除の2ボタンを束ねる）。

    general:role_shop_manage の着地先。購入導線（RoleShopView）とは
    分け、管理者だけが開ける ephemeral で出す。各ボタンは既存の
    RegisterRoleView / DeleteProductView をそのまま開く。
    """

    def __init__(self, cog: "RoleShopCog", guild: discord.Guild,
                 user_id: int, snapshot: dict):
        super().__init__(timeout=180)
        self.cog = cog
        self.guild = guild
        self.user_id = user_id
        self.snapshot = snapshot

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        count = len(self.snapshot["products"])
        return discord.Embed(
            title="ロールショップ商品管理",
            description=f"登録中の商品: **{count} 件**\n"
                        "商品の登録・削除は下のボタンから行えます。",
            color=SHOP_COLOR)

    @discord.ui.button(label="商品を登録", style=discord.ButtonStyle.primary)
    async def register(self, interaction: discord.Interaction,
                       button: discord.ui.Button):
        view = RegisterRoleView(self.cog, self.guild, self.user_id)
        await interaction.response.send_message(
            "登録するロールを選んでください。", view=view, ephemeral=True)

    @discord.ui.button(label="商品を削除", style=discord.ButtonStyle.danger)
    async def delete(self, interaction: discord.Interaction,
                     button: discord.ui.Button):
        if not self.snapshot["products"]:
            return await interaction.response.send_message(
                "登録されている商品がありません。", ephemeral=True)
        view = DeleteProductView(
            self.cog, self.guild, self.snapshot["products"], self.user_id)
        await interaction.response.send_message(
            "削除する商品を選んでください。", view=view, ephemeral=True)


class RoleShopCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 store: shop_core.RoleShopStore | None = None,
                 settings: guild_settings.GuildSettings | None = None):
        self.bot = bot
        self.store = store if store is not None else shop_core.RoleShopStore()
        self._settings = settings

    async def cog_load(self) -> None:
        if not self.sweep_loop.is_running():
            self.sweep_loop.start()
        # 起動時スイープ（ Bot の準備完了後に剥奪を実行する）。
        asyncio.get_running_loop().create_task(self._startup_sweep())

    async def cog_unload(self) -> None:
        if self.sweep_loop.is_running():
            self.sweep_loop.cancel()
        self.store.flush()

    async def _startup_sweep(self) -> None:
        try:
            await self.bot.wait_until_ready()
            await self.sweep_expired()
        except Exception:
            logger.exception("role_shop: 起動時スイープに失敗しました")

    # ------------------------------------------------------------------ 設定
    def _settings_store(self) -> guild_settings.GuildSettings:
        return self._settings or guild_settings.get_store()

    async def _section(self, guild_id: int) -> dict:
        settings = self._settings_store()
        await settings.ensure_loaded()
        return settings.get(guild_id, shop_core.SECTION)

    async def _save_items(self, guild_id: int, section: dict) -> None:
        settings = self._settings_store()
        await settings.update(guild_id, shop_core.SECTION, items=section["items"])

    # ------------------------------------------------------------------ 表示
    async def snapshot(self, guild: discord.Guild, user_id: int) -> dict:
        section = await self._section(guild.id)
        member = guild.get_member(user_id)
        can_manage = bool(
            member and member.guild_permissions.manage_roles)
        grants = self.store.grants_of_user(guild.id, user_id)
        items = []
        for product in shop_core.products(section):
            role = guild.get_role(product["role_id"])
            items.append({
                **product,
                "name": role.name if role is not None else "（削除済みのロール）",
            })
        return {"products": items, "grants": grants, "can_manage": can_manage}

    async def show_shop(self, interaction: discord.Interaction):
        guild = interaction.guild
        if guild is None:
            return await interaction.response.send_message(
                "ロールショップはサーバー内でのみ使えます。", ephemeral=True)
        snapshot = await self.snapshot(guild, interaction.user.id)
        view = RoleShopView(self, guild, interaction.user.id, snapshot)
        await view.prepare_png()
        files = view.panel_files()
        if files:
            await interaction.response.send_message(
                view=_wrap(view), files=files)
        else:
            await interaction.response.send_message(view=_wrap(view))
        try:
            view.message = await interaction.original_response()
        except Exception:
            logger.exception("role_shop: パネルのメッセージ取得に失敗しました")

    async def open_manage(self, interaction: discord.Interaction):
        """商品管理の独立入口（general:role_shop_manage）。

        購入パネル（show_shop）と導線を分け、管理権限がある人だけに
        登録・削除の入口（RoleShopManageView）を ephemeral で開く。
        権限の最終判定は register_product / unregister_product 側でも
        行う（B-4 の多層防御は従来どおり）。
        """
        guild = interaction.guild
        if guild is None:
            return await interaction.response.send_message(
                "ロールショップはサーバー内でのみ使えます。", ephemeral=True)
        snapshot = await self.snapshot(guild, interaction.user.id)
        if not snapshot["can_manage"]:
            return await interaction.response.send_message(
                "商品を管理するにはロール管理（Manage Roles）権限が必要です。",
                ephemeral=True)
        view = RoleShopManageView(self, guild, interaction.user.id, snapshot)
        await interaction.response.send_message(
            view=_wrap(view), ephemeral=True)

    # ------------------------------------------------------------------ 管理
    def _bot_can_manage(self, guild: discord.Guild,
                        role: discord.Role) -> str | None:
        """Bot がそのロールを付け外しできるか。不可なら理由を返す。"""
        me = guild.me
        if me is None or not me.guild_permissions.manage_roles:
            return "Botにロール管理（Manage Roles）権限がありません。"
        if role.position >= me.top_role.position:
            return "そのロールはBotの最上位ロール以上のため扱えません。"
        return None

    @staticmethod
    def _operator_can_manage(operator) -> bool:
        """操作者 (Member) がロール管理権限を持つか (B-4 のメソッド側検証)。"""
        perms = getattr(operator, "guild_permissions", None)
        return bool(perms and perms.manage_roles)

    async def register_product(self, guild: discord.Guild, role: discord.Role,
                               price: int, days: int, operator=None) -> str:
        # 商品の書き換えは cog メソッド側でも操作者の manage_roles を検証する
        # (入口 View の表示分岐だけに依存しない多層防御)。operator は
        # 対話入口から常に渡される。内部・テストからの直接呼び出し
        # (operator=None) は従来どおり Bot 側の権限確認のみで通す。
        if operator is not None and not self._operator_can_manage(operator):
            return "商品を登録するにはロール管理（Manage Roles）権限が必要です。"
        problem = self._bot_can_manage(guild, role)
        if problem:
            return problem
        section = await self._section(guild.id)
        try:
            new_section = shop_core.with_product(section, role.id, price, days)
        except shop_core.RoleShopError as exc:
            return str(exc)
        await self._save_items(guild.id, new_section)
        return f"🛒 **{role.name}** を登録しました（{price:,} AGO／{days}日）。"

    async def unregister_product(self, guild: discord.Guild, role_id: int,
                                 operator=None) -> str:
        if operator is not None and not self._operator_can_manage(operator):
            return "商品を削除するにはロール管理（Manage Roles）権限が必要です。"
        section = await self._section(guild.id)
        if shop_core.find_product(section, role_id) is None:
            return "その商品は登録されていません。"
        await self._save_items(
            guild.id, shop_core.without_product(section, role_id))
        role = guild.get_role(role_id)
        name = role.name if role is not None else "そのロール"
        return f"🗑️ **{name}** の登録を削除しました（購入済みの期限はそのまま残ります）。"

    # ------------------------------------------------------------------ 購入
    def _wallet(self):
        return economy_helpers.wallet_cog(self.bot)

    async def _record_history(self, sender_id: str, receiver_id: str, amount: int, reason: str) -> None:
        await economy_helpers.record_transaction_history(
            sender_id, receiver_id, amount, reason, log_label="role_shop")

    async def buy(self, guild: discord.Guild, member: discord.Member,
                  role_id: int, now: datetime | None = None) -> str:
        now = now or datetime.now(config.JST)
        uid = str(member.id)
        # 逮捕中はマネー系の実行を拒否する（各 cog の execute_* と同じ入口）。
        blocked = prison_core.block_message(uid, now=now)
        if blocked:
            return blocked
        section = await self._section(guild.id)
        product = shop_core.find_product(section, role_id)
        if product is None:
            return "その商品は販売されていません。"
        role = guild.get_role(role_id)
        if role is None:
            return "ロールが見つかりませんでした。"
        problem = self._bot_can_manage(guild, role)
        if problem:
            return f"購入できません: {problem}"
        wallet = self._wallet()
        if wallet is None:
            return "ウォレット機能が読み込まれていません。"
        price = product["price"]
        debit = await wallet._change_balance(uid, -price, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            return f"コインが足りません（{price:,} AGO 必要です）。"
        if debit is None:
            return COIN_UPDATE_FAILED_UNCHANGED
        try:
            await member.add_roles(role, reason="ロールショップ購入")
        except Exception:
            logger.exception(
                "role_shop: ロール付与に失敗 guild=%s user=%s role=%s",
                guild.id, uid, role_id)
            await wallet._change_balance(
                uid, price, create_with=wallet_module.NEW_USER_BALANCE)
            return "ロールを付与できませんでした。コインは返金しました。"
        await self._record_history(uid, "role_shop", price, shop_core.HISTORY_REASON)
        until = self.store.grant(guild.id, member.id, role_id, product["days"], now)
        return (
            f"🎉 **{role.name}** を購入しました"
            f"（{until.strftime('%m/%d %H:%M')} まで）。")

    # ------------------------------------------------------------------ 剥奪
    @tasks.loop(minutes=10)
    async def sweep_loop(self) -> None:
        try:
            await self.sweep_expired()
            self.store.maybe_flush()
        except Exception:
            logger.exception("role_shop: 定期スイープに失敗しました")

    @sweep_loop.before_loop
    async def _before_sweep_loop(self) -> None:
        await self.bot.wait_until_ready()

    async def sweep_expired(self, now: datetime | None = None) -> int:
        """期限切れの付与を剥奪し、処理した件数を返す。"""
        now = now or datetime.now(config.JST)
        processed = 0
        for guild_id, user_id, role_id in self.store.expired(now):
            guild = self.bot.get_guild(guild_id)
            if guild is None:
                self.store.remove(guild_id, user_id, role_id)
                processed += 1
                continue
            role = guild.get_role(role_id)
            member = guild.get_member(user_id)
            if member is None:
                try:
                    member = await guild.fetch_member(user_id)
                except Exception:
                    member = None
            if member is not None and role is not None and role in member.roles:
                try:
                    await member.remove_roles(role, reason="ロールショップ期限切れ")
                except Exception:
                    logger.exception(
                        "role_shop: 期限切れロールの剥奪に失敗 guild=%s user=%s role=%s",
                        guild_id, user_id, role_id)
                    continue  # 次のスイープで再試行する。
            self.store.remove(guild_id, user_id, role_id)
            processed += 1
        return processed


async def setup(bot: commands.Bot):
    await bot.add_cog(RoleShopCog(bot))
