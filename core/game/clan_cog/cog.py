# -*- coding: utf-8 -*-
"""チーム／クラン基盤 v1（core/game/clan.py の画面と実行部）。

v1 の範囲は作成・参加・脱退・解散・メンバー一覧・クラン内
ランキングまで。国庫との接続、クラン対抗戦、共有倉庫は入れない。
nation 機能とは混ぜない。導線は /general のマネージャンル
（general:clan）とマネーパネルに相乗りする（新ジャンルは作らない）。

作成コストの支払いは wallet の CAS 経路＋理由コード clan_create。
作成はマネー系の実行なので、逮捕中は入口で拒否する。貢献ポイントは
採掘・合成・ガチャの実行部から core/game/clan.py の award_points 経由で
貯まる（この cog と同じ共有ストアを見る）。
"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands, tasks

import config
from core.game import clan as clan_core
from core.game import prison as prison_core
from core.panel_v2 import as_panel_v2, edit_panel_v2
from cogs import wallet as wallet_module

logger = logging.getLogger(__name__)

CLAN_COLOR = 0x3498DB


def _wrap(view):
    view._v2 = as_panel_v2(view)
    return view._v2


def clan_embed(cog: "ClanCog", user_id: int) -> discord.Embed:
    uid = str(user_id)
    clan = cog.store.clan_of(uid)
    embed = discord.Embed(title="クラン", color=CLAN_COLOR)
    if clan is None:
        clans = cog.store.list_clans()
        if not clans:
            embed.description = "まだクランがありません。最初のクランを作れます。"
            return embed
        lines = [
            f"**{c['name']}**（Lv{c['level']}／{c['member_count']}人／"
            f"貢献 {c['total_points']:,}）"
            for c in clans[:10]
        ]
        embed.add_field(name="クラン一覧", value="\n".join(lines), inline=False)
        return embed
    members = cog.store.members(clan["id"])
    own = next((m for m in members if m["user_id"] == uid), None)
    badge = " 🏅" if clan["level"] >= 5 else ""
    embed.add_field(
        name="クラン名", value=f"**{clan['name']}**{badge}", inline=True)
    embed.add_field(
        name="メンバー",
        value=f"**{clan['member_count']} 人**（定員 {clan['member_cap']} 人）",
        inline=True)
    embed.add_field(
        name="貢献ポイント", value=f"**{clan['total_points']:,}**", inline=True)
    level_value = f"**Lv{clan['level']}**"
    if clan["next_level_requirement"] is not None:
        level_value += (
            f"／次のレベルまであと "
            f"{clan['next_level_requirement'] - clan['total_points']:,} ポイント")
    embed.add_field(name="レベル", value=level_value, inline=False)
    pending = cog.store.pending_level_up(clan["id"])
    if pending is not None:
        embed.description = f"🎉 クランが **Lv{pending}** に上がりました！"
    if clan["level"] >= clan_core.STATS_LEVEL:
        stats = clan["stats"]
        embed.add_field(
            name="実績",
            value=(f"総採掘 {stats['mining']:,} 回／総合成 {stats['craft']:,} 回"
                   f"／ガチャ {stats['gacha']:,} 回"),
            inline=False)
    if own is not None:
        role = "リーダー" if clan["leader"] == uid else "メンバー"
        embed.add_field(
            name="あなた",
            value=f"{role}／貢献 **{own['points']:,}** ポイント",
            inline=False)
    lines = []
    for rank, member in enumerate(members[:10], start=1):
        mark = "👑 " if member["user_id"] == clan["leader"] else ""
        lines.append(
            f"{rank}. {mark}<@{member['user_id']}> — {member['points']:,} pt")
    if lines:
        embed.add_field(
            name="クラン内ランキング", value="\n".join(lines), inline=False)
    return embed


class ClanView(discord.ui.View):
    def __init__(self, cog: "ClanCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.message: discord.Message | None = None
        self._v2 = None
        self._cached_embed: discord.Embed | None = None
        self.refresh()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        if self._cached_embed is not None:
            return self._cached_embed
        return discord.Embed(title="クラン", color=CLAN_COLOR)

    def refresh(self) -> None:
        self.clear_items()
        clan = self.cog.store.clan_of(str(self.user_id))
        buttons = []
        if clan is None:
            buttons.append(("クランを作る", discord.ButtonStyle.success, self._create))
            buttons.append(("参加する", discord.ButtonStyle.primary, self._join))
            buttons.append(("コードで参加", discord.ButtonStyle.secondary, self._join_code))
        else:
            buttons.append(("メンバー一覧", discord.ButtonStyle.secondary, self._members))
            buttons.append(("クランボーナス", discord.ButtonStyle.success, self._bonus))
            if clan["leader"] == str(self.user_id):
                buttons.append(("招待コード", discord.ButtonStyle.secondary, self._invite))
                buttons.append(("改名する", discord.ButtonStyle.secondary, self._rename))
                buttons.append(("追放する", discord.ButtonStyle.secondary, self._kick))
                buttons.append(("解散する", discord.ButtonStyle.danger, self._disband))
            else:
                buttons.append(("脱退する", discord.ButtonStyle.danger, self._leave))
        for index, (label, style, handler) in enumerate(buttons):
            button = discord.ui.Button(label=label, style=style, row=index // 5)
            button.callback = handler
            self.add_item(button)

    async def _refresh_panel(self, interaction: discord.Interaction) -> None:
        self._cached_embed = clan_embed(self.cog, self.user_id)
        clan = self.cog.store.clan_of(str(self.user_id))
        if clan is not None:
            self.cog.store.mark_level_announced(clan["id"])
        self.refresh()
        container = getattr(self, "_v2", None)
        try:
            if container is not None:
                container._sync()
                await edit_panel_v2(interaction, container)
            elif self.message is not None:
                await self.message.edit(embed=self._cached_embed, view=self)
        except Exception:
            logger.exception("clan: パネルの更新に失敗しました")

    async def _run(self, interaction: discord.Interaction, coro) -> None:
        await interaction.response.defer()
        try:
            message = await coro
        except Exception:
            logger.exception("clan: 実行に失敗しました")
            message = "実行中にエラーが発生しました。時間をおいて再試行してください。"
        await interaction.followup.send(message)
        await self._refresh_panel(interaction)

    async def _create(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CreateClanModal(self.cog))

    async def _join(self, interaction: discord.Interaction):
        clans = self.cog.store.list_clans()
        if not clans:
            return await interaction.response.send_message(
                "参加できるクランがありません。", ephemeral=True)
        view = JoinClanView(self.cog, clans)
        await interaction.response.send_message(
            "参加するクランを選んでください。", view=view, ephemeral=True)

    async def _members(self, interaction: discord.Interaction):
        clan = self.cog.store.clan_of(str(interaction.user.id))
        if clan is None:
            return await interaction.response.send_message(
                "クランに所属していません。", ephemeral=True)
        members = self.cog.store.members(clan["id"])
        lines = [
            f"{rank}. {'👑 ' if m['user_id'] == clan['leader'] else ''}"
            f"<@{m['user_id']}> — {m['points']:,} pt"
            for rank, m in enumerate(members, start=1)
        ]
        embed = discord.Embed(
            title=f"{clan['name']} のメンバー", color=CLAN_COLOR,
            description="\n".join(lines) if lines else "メンバーがいません。")
        await interaction.response.send_message(embed=embed)

    async def _leave(self, interaction: discord.Interaction):
        await self._run(interaction, self.cog.leave_clan(interaction.user.id))

    async def _disband(self, interaction: discord.Interaction):
        await self._run(interaction, self.cog.disband_clan(interaction.user.id))

    async def _join_code(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CodeJoinModal(self.cog))

    async def _bonus(self, interaction: discord.Interaction):
        await self._run(
            interaction, self.cog.claim_clan_bonus(interaction.user.id))

    async def _invite(self, interaction: discord.Interaction):
        clan = self.cog.store.clan_of(str(interaction.user.id))
        if clan is None:
            return await interaction.response.send_message(
                "クランに所属していません。", ephemeral=True)
        code = self.cog.store.ensure_invite_code(clan["id"])
        view = InviteCodeView(self.cog, interaction.user.id)
        await interaction.response.send_message(
            f"招待コード: `{code}`\n"
            "このコードを渡した人は「コードで参加」から入れます。",
            view=view, ephemeral=True)

    async def _rename(self, interaction: discord.Interaction):
        await interaction.response.send_modal(RenameClanModal(self.cog))

    async def _kick(self, interaction: discord.Interaction):
        clan = self.cog.store.clan_of(str(interaction.user.id))
        if clan is None:
            return await interaction.response.send_message(
                "クランに所属していません。", ephemeral=True)
        targets = [
            m for m in self.cog.store.members(clan["id"])
            if m["user_id"] != clan["leader"]
        ]
        if not targets:
            return await interaction.response.send_message(
                "追放できるメンバーがいません。", ephemeral=True)
        view = KickMemberView(self.cog, targets)
        await interaction.response.send_message(
            "追放するメンバーを選んでください。", view=view, ephemeral=True)


class CreateClanModal(discord.ui.Modal, title="クランを作る"):
    name = discord.ui.TextInput(
        label=f"クラン名（{clan_core.CREATE_COST:,} AGO）",
        placeholder="クラン名", max_length=clan_core.MAX_NAME_LENGTH)

    def __init__(self, cog: "ClanCog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        message = await self.cog.create_clan(
            interaction.user.id, str(self.name.value))
        await interaction.response.send_message(message, ephemeral=True)


class JoinClanView(discord.ui.View):
    def __init__(self, cog: "ClanCog", clans: list):
        super().__init__(timeout=180)
        self.cog = cog
        select = discord.ui.Select(
            placeholder="参加するクラン",
            options=[
                discord.SelectOption(
                    label=f"{c['name']}（{c['member_count']}人）"[:100],
                    value=c["id"])
                for c in clans[:25]
            ])
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        values = (getattr(interaction, "data", {}) or {}).get("values") or []
        if not values:
            return await interaction.response.send_message(
                "クランを取得できませんでした。", ephemeral=True)
        message = await self.cog.join_clan(interaction.user.id, values[0])
        await interaction.response.send_message(message, ephemeral=True)
        self.stop()


class CodeJoinModal(discord.ui.Modal, title="招待コードで参加"):
    code = discord.ui.TextInput(
        label="招待コード", placeholder="招待コード", max_length=64)

    def __init__(self, cog: "ClanCog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        message = await self.cog.join_clan_by_code(
            interaction.user.id, str(self.code.value))
        await interaction.response.send_message(message, ephemeral=True)


class RenameClanModal(discord.ui.Modal, title="クラン名を変更"):
    name = discord.ui.TextInput(
        label=f"新しいクラン名（{clan_core.RENAME_COST:,} AGO）",
        placeholder="クラン名", max_length=clan_core.MAX_NAME_LENGTH)

    def __init__(self, cog: "ClanCog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        message = await self.cog.rename_clan(
            interaction.user.id, str(self.name.value))
        await interaction.response.send_message(message, ephemeral=True)


class InviteCodeView(discord.ui.View):
    """招待コードの表示と再発行（リーダー本人だけが見られる ephemeral）。"""

    def __init__(self, cog: "ClanCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="コードを再発行する", style=discord.ButtonStyle.danger)
    async def regenerate(self, interaction: discord.Interaction,
                         button: discord.ui.Button):
        try:
            code = self.cog.store.regenerate_invite_code(str(interaction.user.id))
        except clan_core.ClanError as exc:
            return await interaction.response.send_message(
                str(exc), ephemeral=True)
        await interaction.response.edit_message(
            content=(f"招待コード: `{code}`\n"
                     "このコードを渡した人は「コードで参加」から入れます。"
                     "（前のコードは使えなくなりました）"),
            view=self)


class KickMemberView(discord.ui.View):
    def __init__(self, cog: "ClanCog", targets: list):
        super().__init__(timeout=180)
        self.cog = cog
        select = discord.ui.Select(
            placeholder="追放するメンバー",
            options=[
                discord.SelectOption(
                    label=f"{m['user_id']}（{m['points']:,} pt）"[:100],
                    value=m["user_id"])
                for m in targets[:25]
            ])
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        values = (getattr(interaction, "data", {}) or {}).get("values") or []
        if not values:
            return await interaction.response.send_message(
                "メンバーを取得できませんでした。", ephemeral=True)
        message = await self.cog.kick_member(interaction.user.id, values[0])
        await interaction.response.send_message(message, ephemeral=True)
        self.stop()


class ClanCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 store: clan_core.ClanStore | None = None):
        self.bot = bot
        # 貢献フック（他 cog の award_points）と状態を共有する。
        self.store = store if store is not None else clan_core.shared_store()

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.store.flush()

    @tasks.loop(seconds=clan_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.store.maybe_flush()
        except Exception:
            logger.exception("clan: 定期フラッシュに失敗しました")

    @flush_loop.before_loop
    async def _before_flush_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------ 実行
    def _wallet(self):
        return self.bot.get_cog("WalletCog")

    async def _record_history(self, sender_id: str, receiver_id: str,
                              amount: int, reason: str) -> None:
        try:
            await asyncio.to_thread(lambda: config.db_api.table(
                "transaction_history").insert({
                    "sender_id": sender_id,
                    "receiver_id": receiver_id,
                    "amount": amount,
                    "reason": reason,
                }).execute())
        except Exception:
            logger.exception(
                "clan: 取引履歴の記録に失敗 sender=%s amount=%s",
                sender_id, amount)

    async def create_clan(self, user_id: int, name: str) -> str:
        uid = str(user_id)
        blocked = prison_core.block_message(uid)
        if blocked:
            return blocked
        # 先に検証だけ済ませ、支払いの後に作成する（失敗時は返金）。
        if self.store.clan_of(uid) is not None:
            return "すでにクランに所属しています。"
        name = str(name).strip()
        if not name or len(name) > clan_core.MAX_NAME_LENGTH:
            return f"クラン名は1〜{clan_core.MAX_NAME_LENGTH}文字で入力してください。"
        if self.store.name_taken(name):
            return "その名前のクランはすでにあります。"
        wallet = self._wallet()
        if wallet is None:
            return "ウォレット機能が読み込まれていません。"
        debit = await wallet._change_balance(
            uid, -clan_core.CREATE_COST, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            return f"コインが足りません（{clan_core.CREATE_COST:,} AGO 必要です）。"
        if debit is None:
            return "コインの更新に失敗しました。残高は変わっていません。"
        try:
            clan = self.store.create(uid, name)
        except clan_core.ClanError as exc:
            await wallet._change_balance(
                uid, clan_core.CREATE_COST,
                create_with=wallet_module.NEW_USER_BALANCE)
            return str(exc)
        await self._record_history(
            uid, "clan", clan_core.CREATE_COST, clan_core.HISTORY_REASON)
        return f"🏳️ **クラン「{clan['name']}」を作りました！**"

    async def join_clan(self, user_id: int, clan_id: str) -> str:
        try:
            clan = self.store.join(str(user_id), str(clan_id))
        except clan_core.ClanError as exc:
            return str(exc)
        return f"🏳️ **クラン「{clan['name']}」に参加しました！**"

    async def leave_clan(self, user_id: int) -> str:
        try:
            clan = self.store.leave(str(user_id))
        except clan_core.ClanError as exc:
            return str(exc)
        return f"クラン「{clan['name']}」を脱退しました。"

    # ------------------------------------------------------------------ S6-5 拡張
    async def join_clan_by_code(self, user_id: int, code: str) -> str:
        try:
            clan = self.store.join_by_code(str(user_id), code)
        except clan_core.ClanError as exc:
            return str(exc)
        return f"🏳️ **クラン「{clan['name']}」に参加しました！**"

    async def rename_clan(self, user_id: int, name: str) -> str:
        uid = str(user_id)
        blocked = prison_core.block_message(uid)
        if blocked:
            return blocked
        clan = self.store.clan_of(uid)
        if clan is None:
            return "クランに所属していません。"
        if clan["leader"] != uid:
            return "改名できるのはリーダーだけです。"
        name = str(name).strip()
        if not name or len(name) > clan_core.MAX_NAME_LENGTH:
            return f"クラン名は1〜{clan_core.MAX_NAME_LENGTH}文字で入力してください。"
        if self.store.name_taken(name, exclude_clan_id=clan["id"]):
            return "その名前のクランはすでにあります。"
        wallet = self._wallet()
        if wallet is None:
            return "ウォレット機能が読み込まれていません。"
        debit = await wallet._change_balance(
            uid, -clan_core.RENAME_COST, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            return f"コインが足りません（{clan_core.RENAME_COST:,} AGO 必要です）。"
        if debit is None:
            return "コインの更新に失敗しました。残高は変わっていません。"
        try:
            renamed = self.store.rename(uid, name)
        except clan_core.ClanError as exc:
            await wallet._change_balance(
                uid, clan_core.RENAME_COST,
                create_with=wallet_module.NEW_USER_BALANCE)
            return str(exc)
        await self._record_history(
            uid, "clan", clan_core.RENAME_COST,
            clan_core.HISTORY_REASON_RENAME)
        return f"🏳️ **クラン名を「{renamed['name']}」に変更しました！**"

    async def kick_member(self, leader_id: int, target_id: str) -> str:
        try:
            clan = self.store.kick(str(leader_id), str(target_id))
        except clan_core.ClanError as exc:
            return str(exc)
        return f"<@{target_id}> をクラン「{clan['name']}」から追放しました。"

    async def claim_clan_bonus(self, user_id: int) -> str:
        """クランボーナス（1日1回、受け取った本人に宝箱×1）。"""
        uid = str(user_id)
        blocked = prison_core.block_message(uid)
        if blocked:
            return blocked
        if self.store.clan_of(uid) is None:
            return "クランに所属していません。"
        if not self.store.try_claim_bonus(uid):
            return "今日のクランボーナスは受け取り済みです。"
        items_cog = self.bot.get_cog("ItemsCog")
        try:
            if items_cog is None:
                raise RuntimeError("items cog not loaded")
            items_cog.store.add(uid, "treasure_box", 1)
        except Exception:
            logger.exception("clan: クランボーナスの付与に失敗 user=%s", uid)
            self.store.unclaim_bonus(uid)
            return "受け取りに失敗しました。時間をおいて再試行してください。"
        return "🎁 **クランボーナスを受け取りました！** 宝箱×1"

    async def disband_clan(self, user_id: int) -> str:
        try:
            clan = self.store.disband(str(user_id))
        except clan_core.ClanError as exc:
            return str(exc)
        return f"クラン「{clan['name']}」を解散しました。"

    # ------------------------------------------------------------------ 入口
    async def show_clan(self, interaction: discord.Interaction):
        view = ClanView(self, interaction.user.id)
        view._cached_embed = clan_embed(self, interaction.user.id)
        # レベルアップ告知は表示した時点で既読にする（S2）。
        clan = self.store.clan_of(str(interaction.user.id))
        if clan is not None:
            self.store.mark_level_announced(clan["id"])
        await interaction.response.send_message(view=_wrap(view))
        try:
            view.message = await interaction.original_response()
        except Exception:
            logger.exception("clan: パネルのメッセージ取得に失敗しました")


async def setup(bot: commands.Bot):
    await bot.add_cog(ClanCog(bot))
