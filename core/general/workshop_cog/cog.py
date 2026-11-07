# -*- coding: utf-8 -*-
"""工房: /general のマネージャンルから使う加工機・合成・委託加工の入口。

本体は core/general/workshop.py（WorkshopStore: 加工機・委託・ストリーク）と
core/general/craft.py（レシピ・合成）。ここは Discord 側の表示と、AGO コイン
残高の実移動（加工機の購入）だけを担う。コインの増減は必ず
cogs/wallet.py の安全な経路（CAS 更新 _change_balance と
transaction_history への記録）を通す（cogs/items.py と同じ組み立て）。
アイテムの実増減は ItemsCog が持つ ItemStore を共有して行う。

入口は新規スラッシュを作らず、/general パネルの action 経由
（general:workshop / general:machine_buy / general:workshop_claim /
general:craft）だけ。
"""
from __future__ import annotations
from core.support.emojis import SUCCESS

import asyncio
import logging
from datetime import datetime

import discord
from discord.ext import commands, tasks

import config
from core.game import clan as clan_core
from core.general import craft as craft_core
from core.general import items as items_core
from core.game import prison as prison_core
from core.general import workshop as workshop_core
from core.support.messages import (
    craft_action_failed,
    workshop_action_failed,
)
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from cogs import wallet as wallet_module  # INSUFFICIENT は実行時に引く（テストの cog 再読込で同一性が崩れないため）

logger = logging.getLogger("cogs.workshop")

WORKSHOP_COLOR = 0x95A5A6
WORKSHOP_ID = "WORKSHOP"


# ---------------------------------------------------------------------------
# コンポーネントV2 統一（core/support/panel_v2.py の流儀）
# ---------------------------------------------------------------------------

def _wrap(view):
    """View を PanelLayoutView で包み、再描画用に view._v2 へ保持する。"""
    view._v2 = as_panel_v2(view)
    return view._v2


async def _edit_panel(interaction: discord.Interaction, view, *, button=None) -> None:
    """パネルをその場で再描画する（V2 で包まれていれば V2 の編集経路）。"""
    container = getattr(button, "view", None)
    if container is None or not hasattr(container, "_sync"):
        container = getattr(view, "_v2", None) or view
    if hasattr(container, "_sync"):
        container._sync()
        await edit_panel_v2(interaction, container)
    elif interaction.response.is_done():
        await interaction.edit_original_response(embed=view.embed(), view=view)
    else:
        await interaction.response.edit_message(embed=view.embed(), view=view)


def _item_name(item_id: str) -> str:
    definition = items_core.ITEM_DEFS.get(item_id)
    return definition["name"] if definition else item_id


def _tier_lines() -> list[str]:
    # HCD方針（2026-11-06）: レア率や生産見込みの期待値のような数値仕様は
    # ユーザー向け文言に出さない（遊び方と結果だけ出す）。
    lines = []
    for tier_id, tier in workshop_core.MACHINE_TIERS.items():
        materials = "・".join(
            items_core.ITEM_DEFS[item_id]["name"] for item_id, _w in tier["production"])
        lines.append(
            f"・**{tier['name']}** — {tier['price']:,} AGO"
            f"（{tier['cycle_hours']}時間ごとに {materials} を生産、"
            f"貯蔵は{tier['storage_hours']}時間分まで、"
            f"寿命{tier['lifespan_cycles']}サイクル"
            f"（満稼働で約{workshop_core.lifetime_days(tier_id):.0f}日）で"
            "消える使い捨て）"
        )
    return lines


def _workshop_embed(cog: "WorkshopCog", user_id: int) -> discord.Embed:
    uid = str(user_id)
    now = datetime.now(config.JST)
    store = cog.workshop_store
    embed = discord.Embed(title="工房", color=WORKSHOP_COLOR)
    machines = store.machines(uid)
    if machines:
        lines = []
        for machine in machines:
            tier = workshop_core.MACHINE_TIERS[machine["tier"]]
            pending = store.pending_cycles(machine, now)
            max_cycles = tier["storage_hours"] // tier["cycle_hours"]
            state = f"生産完了 **{pending} サイクル分**"
            if pending >= max_cycles:
                state += "（貯蔵上限で停止中）"
            if pending >= int(machine.get("cycles_left", 0)):
                state += "（受け取ると寿命が尽きます）"
            lines.append(
                f"・{tier['name']} — {state}"
                f"／残り寿命 {machine.get('cycles_left', 0)} サイクル")
        embed.add_field(name="所有加工機", value="\n".join(lines), inline=False)
    else:
        embed.add_field(name="所有加工機", value="（なし）", inline=False)
    streak = store.streak_status(uid, now)
    if streak["days"]:
        embed.add_field(
            name="連続稼働ストリーク",
            value=f"**{streak['days']} 日**（受け取り続けると生産ボーナスが付きます）",
            inline=False)
    jobs = store.commissions(uid)
    if jobs:
        lines = []
        for job in jobs:
            ready_at = datetime.fromisoformat(job["ready_at"])
            names = f"{_item_name(job['a'])} ＋ {_item_name(job['b'])}"
            if ready_at <= now:
                lines.append(f"・{names} — **受け取り可能**")
            else:
                # 残り時間の表記は prison.format_remaining に統一する（導線最適化ラウンド4）。
                seconds = (ready_at - now).total_seconds()
                lines.append(f"・{names} — 完了まで{prison_core.format_remaining(seconds)}")
        embed.add_field(name="委託加工", value="\n".join(lines), inline=False)
    embed.add_field(name="加工機（購入）", value="\n".join(_tier_lines()), inline=False)
    embed.set_footer(text="生産物は「生産物を受け取る」でまとめて受け取れます。")
    return embed


def _craft_embed(cog: "WorkshopCog", user_id: int) -> discord.Embed:
    store = cog._item_store()
    inventory = store.inventory(str(user_id))
    embed = discord.Embed(title="合成", color=WORKSHOP_COLOR)
    owned = [
        f"・{_item_name(item_id)} ×{count}"
        for item_id, count in sorted(inventory.items())
        if item_id in craft_core.craftable_item_ids() and count > 0
    ]
    embed.add_field(
        name="合成に使える所持素材", value="\n".join(owned) if owned else "（なし）",
        inline=False)
    # レシピ（組み合わせの対応表）はユーザーに見せない。原典もそうで、
    # 試して見つけるのが仕様（2026-11-06 ユーザー指示）。
    embed.set_footer(
        text="素材を2つ選んで「合成する」と即時、「委託する」と時間をかけてレア結果が出やすくなります。"
             "組み合わせは試して見つけてください。")
    return embed


class BuyMachineView(discord.ui.View):
    def __init__(self, cog: "WorkshopCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        for tier_id, tier in workshop_core.MACHINE_TIERS.items():
            button = discord.ui.Button(
                label=f"{tier['name']}（{tier['price']:,} AGO）",
                style=discord.ButtonStyle.success,
            )
            button.callback = self._make_callback(tier_id)
            self.add_item(button)

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="加工機を買う", description="購入する加工機を選んでください。",
            color=WORKSHOP_COLOR)

    def _make_callback(self, tier_id: str):
        async def callback(interaction: discord.Interaction):
            await interaction.response.defer()
            message = await self.cog.execute_buy_machine(interaction.user.id, tier_id)
            await interaction.followup.send(message)

        return callback


class WorkshopView(discord.ui.View):
    def __init__(self, cog: "WorkshopCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return _workshop_embed(self.cog, self.user_id)

    # 導線最適化ラウンド4: 再描画だけの「更新」ボタンは置かない（S9/R2-5
    # と同じ作法）。受け取り・購入のたびにパネルは更新される。

    @discord.ui.button(label="加工機を買う", style=discord.ButtonStyle.success)
    async def buy(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(
            view=_wrap(BuyMachineView(self.cog, interaction.user.id)))

    @discord.ui.button(label="生産物を受け取る", style=discord.ButtonStyle.primary)
    async def claim(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = self.cog.execute_claim(interaction.user.id)
        await interaction.followup.send(message)

    @discord.ui.button(label="委託を受け取る", style=discord.ButtonStyle.primary)
    async def claim_commission(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer()
        message = self.cog.execute_claim_commissions(interaction.user.id)
        await interaction.followup.send(message)


class CraftView(discord.ui.View):
    def __init__(self, cog: "WorkshopCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        self.first: str | None = None
        self.second: str | None = None
        inventory = cog._item_store().inventory(str(user_id))
        options = [
            discord.SelectOption(
                label=f"{_item_name(item_id)} ×{count}", value=item_id)
            for item_id, count in sorted(inventory.items())
            if item_id in craft_core.craftable_item_ids() and count > 0
        ][:25]
        if not options:
            options = [discord.SelectOption(label="（素材がありません）", value="__none__")]
        first_select = discord.ui.Select(
            placeholder="素材1を選ぶ", options=options, row=0)
        second_select = discord.ui.Select(
            placeholder="素材2を選ぶ", options=list(options), row=1)
        first_select.callback = self._make_select_callback("first")
        second_select.callback = self._make_select_callback("second")
        self.add_item(first_select)
        self.add_item(second_select)

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return _craft_embed(self.cog, self.user_id)

    def _make_select_callback(self, slot: str):
        async def callback(interaction: discord.Interaction):
            value = interaction.data["values"][0]
            setattr(self, slot, None if value == "__none__" else value)
            await interaction.response.defer()

        return callback

    @discord.ui.button(label="合成する", style=discord.ButtonStyle.success, row=2)
    async def craft_now(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.first or not self.second:
            return await interaction.response.send_message(
                craft_action_failed("素材を2つ選んでください。"), ephemeral=True)
        await interaction.response.defer()
        message = self.cog.execute_craft(interaction.user.id, self.first, self.second)
        await interaction.followup.send(message)

    @discord.ui.button(label="委託する", style=discord.ButtonStyle.primary, row=2)
    async def craft_commission(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.first or not self.second:
            return await interaction.response.send_message(
                craft_action_failed("素材を2つ選んでください。"), ephemeral=True)
        await interaction.response.defer()
        message = self.cog.execute_commission(interaction.user.id, self.first, self.second)
        await interaction.followup.send(message)


class WorkshopCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 workshop_store: workshop_core.WorkshopStore | None = None,
                 item_store: items_core.ItemStore | None = None):
        self.bot = bot
        self.workshop_store = (
            workshop_store if workshop_store is not None
            else workshop_core.WorkshopStore())
        self._injected_item_store = item_store

    def _item_store(self) -> items_core.ItemStore:
        """ItemStore は ItemsCog のものを共有する（二重化すると所持が割れる）。"""
        if self._injected_item_store is not None:
            return self._injected_item_store
        items_cog = self.bot.get_cog("ItemsCog")
        if items_cog is None:
            raise items_core.ItemError("アイテム機能が読み込まれていません。")
        return items_cog.store

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.workshop_store.flush()

    @tasks.loop(seconds=workshop_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.workshop_store.maybe_flush()
        except Exception:
            logger.exception("workshop: 定期フラッシュに失敗しました")

    @flush_loop.before_loop
    async def _before_flush_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------ 入口
    async def show_workshop(self, interaction: discord.Interaction):
        view = WorkshopView(self, interaction.user.id)
        await interaction.response.send_message(view=_wrap(view))

    async def open_buy_machine(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            view=_wrap(BuyMachineView(self, interaction.user.id)))

    async def open_claim(self, interaction: discord.Interaction):
        await interaction.response.defer()
        message = self.execute_claim(interaction.user.id)
        await interaction.followup.send(message)

    async def show_craft(self, interaction: discord.Interaction):
        try:
            embed = _craft_embed(self, interaction.user.id)
        except items_core.ItemError as exc:
            return await interaction.response.send_message(
                workshop_action_failed(exc), ephemeral=True)
        view = CraftView(self, interaction.user.id)
        await interaction.response.send_message(view=_wrap(view))

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
            logger.exception("workshop: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                             sender_id, receiver_id, amount)

    async def execute_buy_machine(self, user_id: int, tier_id: str) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return workshop_action_failed(blocked)
            tier = workshop_core.MACHINE_TIERS.get(tier_id)
            if tier is None:
                return workshop_action_failed("その加工機は存在しません。")
            price = int(tier["price"])
            wallet = self._wallet()
            debit = await wallet._change_balance(uid, -price, require_funds=True)
            if debit is wallet_module.INSUFFICIENT:
                return workshop_action_failed("コインが不足しています。")
            if debit is None:
                return workshop_action_failed("コインの更新に失敗しました。時間をおいて再試行してください。")
            try:
                self.workshop_store.add_machine(uid, tier_id)
            except items_core.ItemError as exc:
                refund = await wallet._change_balance(uid, price)
                if refund is None:
                    # 返金自体が失敗 (CAS 枯渇) したら黙って握り潰さず、
                    # critical ログ＋運営への連絡を案内する (E-5c)。
                    logger.critical(
                        "workshop: 加工機購入の返金に失敗しました。"
                        "手動で戻してください user=%s amount=%s", uid, price)
                    return workshop_action_failed(
                        f"{exc}\n返金に失敗しました。Botの運営に連絡してください。")
                return workshop_action_failed(exc)
            await self._record_history(uid, WORKSHOP_ID, price, "machine_buy")
            return (
                f"{SUCCESS} **{tier['name']}を購入しました**\n"
                f"{price:,} AGO（{tier['cycle_hours']}時間ごとに素材を生産します）\n"
                f"寿命は{tier['lifespan_cycles']}サイクル分"
                f"（満稼働で約{workshop_core.lifetime_days(tier_id):.0f}日）の使い捨てです\n"
                f"コイン残高: {debit:,} AGO"
            )
        except items_core.ItemError as exc:
            return workshop_action_failed(exc)
        except Exception:
            logger.exception("workshop: 加工機の購入に失敗 user=%s tier=%s", uid, tier_id)
            return workshop_action_failed("購入中にエラーが発生しました。時間をおいて再試行してください。")

    def execute_claim(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return workshop_action_failed(blocked)
            # 加速オイル発動中は経過時間を2倍として数える（早く貯まる
            # 代わりにサイクル消化＝寿命の消費も速い。貯蔵上限は不変）。
            time_scale = 1.0
            try:
                if self._item_store().has_effect(
                        uid, items_core.WORKSHOP_HASTE_EFFECT):
                    time_scale = items_core.WORKSHOP_HASTE_MULTIPLIER
            except Exception:
                time_scale = 1.0
            result = self.workshop_store.claim_production(uid, time_scale=time_scale)
            if result["cycles"] <= 0:
                return workshop_action_failed("まだ受け取れる生産物がありません。")
            store = self._item_store()
            for item_id, count in result["items"].items():
                store.add(uid, item_id, count)
            lines = [f"{SUCCESS} **生産物を {result['cycles']} サイクル分受け取りました**"]
            for item_id, count in sorted(result["items"].items()):
                lines.append(f"・{_item_name(item_id)} ×{count}")
            for tier_id in result.get("exhausted", []):
                lines.append(
                    f"・{workshop_core.MACHINE_TIERS[tier_id]['name']}"
                    " は寿命が尽きて使えなくなりました（使い捨て）")
            if result["bonus_rate"] > 0:
                lines.append(
                    f"連続稼働ストリーク {result['streak_days']} 日"
                    "（生産ボーナスが付きました）")
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return workshop_action_failed(exc)
        except Exception:
            logger.exception("workshop: 生産物の受け取りに失敗 user=%s", uid)
            return workshop_action_failed("受け取り中にエラーが発生しました。時間をおいて再試行してください。")

    def execute_craft(self, user_id: int, item_a: str, item_b: str) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return craft_action_failed(blocked)
            # 合成触媒発動中はレア結果の重みを上げる。
            rare_boost = 1.0
            try:
                if self._item_store().has_effect(
                        uid, items_core.CRAFT_CATALYST_EFFECT):
                    rare_boost = items_core.CRAFT_CATALYST_MULTIPLIER
            except Exception:
                rare_boost = 1.0
            result = craft_core.execute_craft(
                self._item_store(), uid, item_a, item_b, rare_boost=rare_boost)
            names = f"{_item_name(item_a)} ＋ {_item_name(item_b)}"
            outcome = f"{_item_name(result['item'])} ×{result['count']}"
            # クラン貢献フック（所属中のみ・失敗しても合成に影響させない）。
            clan_core.award_points(uid, clan_core.POINTS_CRAFT, "craft")
            if result["rare"]:
                return f"✨ **大成功！** {names} → **{outcome}**"
            return f"{SUCCESS} **合成しました** {names} → **{outcome}**"
        except items_core.ItemError as exc:
            return craft_action_failed(exc)
        except Exception:
            logger.exception("workshop: 合成に失敗 user=%s a=%s b=%s", uid, item_a, item_b)
            return craft_action_failed("合成中にエラーが発生しました。時間をおいて再試行してください。")

    def execute_commission(self, user_id: int, item_a: str, item_b: str) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return craft_action_failed(blocked)
            self.workshop_store.start_commission(
                self._item_store(), uid, item_a, item_b)
            names = f"{_item_name(item_a)} ＋ {_item_name(item_b)}"
            return (
                f"{SUCCESS} **委託加工を開始しました** {names}\n"
                f"約{workshop_core.COMMISSION_HOURS:.0f}時間後に工房から受け取れます。"
                "通常の合成よりレアな結果が出やすくなります。"
            )
        except items_core.ItemError as exc:
            return craft_action_failed(exc)
        except Exception:
            logger.exception("workshop: 委託加工の開始に失敗 user=%s a=%s b=%s", uid, item_a, item_b)
            return craft_action_failed("委託加工の開始中にエラーが発生しました。時間をおいて再試行してください。")

    def execute_claim_commissions(self, user_id: int) -> str:
        uid = str(user_id)
        try:
            blocked = prison_core.block_message(uid)
            if blocked:
                return workshop_action_failed(blocked)
            jobs = self.workshop_store.commissions(uid)
            if not jobs:
                return workshop_action_failed("委託加工中の品目がありません。")
            # 合成触媒は委託加工にも効く（委託倍率と乗算、上限あり）。
            extra_boost = 1.0
            try:
                if self._item_store().has_effect(
                        uid, items_core.CRAFT_CATALYST_EFFECT):
                    extra_boost = items_core.CRAFT_CATALYST_MULTIPLIER
            except Exception:
                extra_boost = 1.0
            results = self.workshop_store.claim_commissions(
                self._item_store(), uid, extra_rare_boost=extra_boost)
            if not results:
                return workshop_action_failed("まだ完了した委託加工がありません。")
            lines = [f"{SUCCESS} **委託加工を {len(results)} 件受け取りました**"]
            for result in results:
                a, b = result["inputs"]
                names = f"{_item_name(a)} ＋ {_item_name(b)}"
                outcome = f"{_item_name(result['item'])} ×{result['count']}"
                mark = "✨ " if result["rare"] else ""
                lines.append(f"・{mark}{names} → **{outcome}**")
            return "\n".join(lines)
        except items_core.ItemError as exc:
            return workshop_action_failed(exc)
        except Exception:
            logger.exception("workshop: 委託加工の受け取りに失敗 user=%s", uid)
            return workshop_action_failed("受け取り中にエラーが発生しました。時間をおいて再試行してください。")


async def setup(bot: commands.Bot):
    await bot.add_cog(WorkshopCog(bot))
