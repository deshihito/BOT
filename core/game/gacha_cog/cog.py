# -*- coding: utf-8 -*-
"""編成ガチャ＋キャラ収集（キャストは人狼のアゴキャラ）。

原典の編成ガチャは characters.json 前提だったが、そのファイルは
未共有かつ他社IPのため、キャストは AGO の人狼の役職キャラを
そのまま使う（core/game/gacha.py）。仕組みは単発／10連、かぶりの
コイン自動変換、コレクション、編成（最大3体）までを v1 とする。

支払いは wallet の CAS 経路＋理由コード gacha。逮捕中はマネー系の
実行として入口で拒否する。入口は新規スラッシュを作らず、/general
のマネージャンル（general:gacha）とマネーパネルのボタンから。
"""
from __future__ import annotations

import asyncio
import logging
import random

import discord
from discord.ext import commands, tasks

import config
from core.game import clan as clan_core
from core.game import gacha as gacha_core
from core.game import prison as prison_core
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from cogs import wallet as wallet_module

logger = logging.getLogger("cogs.gacha")

GACHA_COLOR = 0xE67E22


def _wrap(view):
    view._v2 = as_panel_v2(view)
    return view._v2


def summary_embed(cog: "GachaCog", user_id: int) -> discord.Embed:
    owned = cog.store.owned(str(user_id))
    kinds = len(owned)
    total = sum(owned.values())
    embed = discord.Embed(title="ガチャ", color=GACHA_COLOR)
    embed.add_field(
        name="コレクション",
        value=f"**{kinds} / {len(gacha_core.CHARACTERS)} 種**（全 {total} 体）",
        inline=True)
    embed.add_field(
        name="累計", value=f"**{cog.store.total_pulls(str(user_id))} 回**", inline=True)
    party = cog.store.party(str(user_id))
    if party:
        lines = [
            gacha_core.character_line(gacha_core.CHARACTER_BY_ID[char_id])
            for char_id in party if char_id in gacha_core.CHARACTER_BY_ID
        ]
        embed.add_field(name="編成", value="\n".join(lines), inline=False)
    return embed


def collection_embed(cog: "GachaCog", user_id: int) -> discord.Embed:
    owned = cog.store.owned(str(user_id))
    embed = discord.Embed(title="コレクション", color=GACHA_COLOR)
    # 天井までの残り（自分の状態表示としてのみ出す。S6-2）。
    remaining = gacha_core.PITY_LIMIT - cog.store.pity(str(user_id))
    pity_line = f"天井まで あと{remaining}回"
    if not owned:
        embed.description = f"まだキャラを持っていません。\n{pity_line}"
        return embed
    embed.set_footer(text=pity_line)
    for rarity in reversed(gacha_core.RARITY_ORDER):
        chars = [
            gacha_core.CHARACTER_BY_ID[char_id]
            for char_id in owned
            if gacha_core.CHARACTER_BY_ID[char_id]["rarity"] == rarity
        ]
        if not chars:
            continue
        chars.sort(key=lambda c: c["name"])
        lines = [
            f"{gacha_core.character_line(c)} ×{owned[c['id']]}"
            for c in chars
        ]
        embed.add_field(name=rarity, value="\n".join(lines), inline=False)
    return embed


class GachaView(discord.ui.View):
    def __init__(self, cog: "GachaCog", user_id: int):
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
        return discord.Embed(title="ガチャ", color=GACHA_COLOR)

    def refresh(self) -> None:
        self.clear_items()
        buttons = [
            (f"1回引く（{gacha_core.SINGLE_PRICE:,} AGO）",
             discord.ButtonStyle.success, self._pull_one),
            (f"10連（{gacha_core.TEN_PRICE:,} AGO）",
             discord.ButtonStyle.primary, self._pull_ten),
            ("コレクション", discord.ButtonStyle.secondary, self._collection),
            ("編成する", discord.ButtonStyle.secondary, self._party),
        ]
        for index, (label, style, handler) in enumerate(buttons):
            button = discord.ui.Button(label=label, style=style, row=index // 5)
            button.callback = handler
            self.add_item(button)

    async def _refresh_panel(self, interaction: discord.Interaction) -> None:
        self._cached_embed = summary_embed(self.cog, self.user_id)
        container = getattr(self, "_v2", None)
        try:
            if container is not None:
                container._sync()
                await edit_panel_v2(interaction, container)
            elif self.message is not None:
                await self.message.edit(embed=self._cached_embed, view=self)
        except Exception:
            logger.exception("gacha: パネルの更新に失敗しました")

    async def _pull(self, interaction: discord.Interaction, count: int):
        await interaction.response.defer()
        message = await self.cog.execute_pull(interaction.user.id, count)
        await interaction.followup.send(message)
        await self._refresh_panel(interaction)

    async def _pull_one(self, interaction: discord.Interaction):
        await self._pull(interaction, 1)

    async def _pull_ten(self, interaction: discord.Interaction):
        await self._pull(interaction, gacha_core.TEN_COUNT)

    async def _collection(self, interaction: discord.Interaction):
        await interaction.response.send_message(
            embed=collection_embed(self.cog, interaction.user.id))

    async def _party(self, interaction: discord.Interaction):
        owned = self.cog.store.owned(str(interaction.user.id))
        if not owned:
            return await interaction.response.send_message(
                "所持キャラがいません。先にガチャを引いてください。",
                ephemeral=True)
        view = PartyView(self.cog, interaction.user.id)
        await interaction.response.send_message(
            "編成するキャラを選んでください（最大3体）。",
            view=view, ephemeral=True)


class PartyView(discord.ui.View):
    """編成（お気に入り最大3体）を選ぶ。所持キャラが対象。"""

    def __init__(self, cog: "GachaCog", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id
        owned = cog.store.owned(str(user_id))
        chars = [gacha_core.CHARACTER_BY_ID[c] for c in owned]
        party = set(cog.store.party(str(user_id)))
        # 導線最適化ラウンド4: セレクト上限25件で切り捨てる際も、編成中の
        # キャラが必ず枠内に入るよう編成中を先頭に寄せる（現在編成は常に
        # 編集できることを保証する）。
        chars.sort(key=lambda c: (
            c["id"] not in party,
            -gacha_core.RARITY_ORDER.index(c["rarity"]), c["name"]))
        select = discord.ui.Select(
            placeholder="編成するキャラ（最大3体）",
            min_values=0, max_values=gacha_core.PARTY_MAX,
            options=[
                discord.SelectOption(
                    label=f"{c['name']}（{c['rarity']}）"[:100],
                    value=c["id"], default=c["id"] in party)
                for c in chars[:25]
            ])
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        values = (getattr(interaction, "data", {}) or {}).get("values") or []
        try:
            self.cog.store.set_party(str(interaction.user.id), list(values))
        except ValueError as exc:
            return await interaction.response.send_message(
                str(exc), ephemeral=True)
        await interaction.response.send_message("編成を保存しました。", ephemeral=True)
        self.stop()


class GachaCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 store: gacha_core.GachaStore | None = None,
                 rng: random.Random | None = None):
        self.bot = bot
        self.store = store if store is not None else gacha_core.GachaStore()
        # 既定 RNG は SystemRandom (E-13: ガチャ抽選は CSPRNG)。
        # テスト等が rng を注入した場合はそのまま使う (シード固定を壊さない)。
        self._rng = rng if rng is not None else random.SystemRandom()

    async def cog_load(self) -> None:
        if not self.flush_loop.is_running():
            self.flush_loop.start()

    async def cog_unload(self) -> None:
        if self.flush_loop.is_running():
            self.flush_loop.cancel()
        self.store.flush()

    @tasks.loop(seconds=gacha_core.FLUSH_INTERVAL_SECONDS)
    async def flush_loop(self) -> None:
        try:
            self.store.maybe_flush()
        except Exception:
            logger.exception("gacha: 定期フラッシュに失敗しました")

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
                "gacha: 取引履歴の記録に失敗 sender=%s amount=%s",
                sender_id, amount)

    async def execute_pull(self, user_id: int, count: int) -> str:
        uid = str(user_id)
        blocked = prison_core.block_message(uid)
        if blocked:
            return blocked
        if count == 1:
            price = gacha_core.SINGLE_PRICE
        elif count == gacha_core.TEN_COUNT:
            price = gacha_core.TEN_PRICE
        else:
            return "回数が不正です。"
        wallet = self._wallet()
        if wallet is None:
            return "ウォレット機能が読み込まれていません。"
        debit = await wallet._change_balance(uid, -price, require_funds=True)
        if debit is wallet_module.INSUFFICIENT:
            return f"コインが足りません（{price:,} AGO 必要です）。"
        if debit is None:
            return "コインの更新に失敗しました。残高は変わっていません。"
        await self._record_history(uid, "gacha", price, gacha_core.HISTORY_REASON)
        try:
            # 天井（S6-2）: SSR が出ていない累計が上限に届く抽選は SSR 確定。
            rolls, new_pity = gacha_core.roll_pulls(
                self._rng, count, self.store.pity(uid))
            self.store.set_pity(uid, new_pity)
            self.store.record_pulls(uid, count)
            # クラン貢献フック（所属中のみ・失敗してもガチャに影響させない）。
            for _ in range(count):
                clan_core.award_points(uid, clan_core.POINTS_GACHA_PER_PULL, "gacha")
            lines = ["🎰 **ガチャ結果**"]
            dup_coins = 0
            for character in rolls:
                if self.store.count_of(uid, character["id"]) > 0:
                    coins = gacha_core.DUPLICATE_COINS[character["rarity"]]
                    dup_coins += coins
                    lines.append(
                        f"{gacha_core.character_line(character)}"
                        f" — かぶり（{coins:,} AGOに変換）")
                else:
                    self.store.add(uid, character["id"])
                    lines.append(f"{gacha_core.character_line(character)} — **NEW!**")
        except Exception:
            # debit 後の例外で支払いだけが残らないよう、返金を試みる (E-5c)。
            logger.exception("gacha: 抽選の反映に失敗 user=%s count=%s", uid, count)
            refund = await wallet._change_balance(
                uid, price, create_with=wallet_module.NEW_USER_BALANCE)
            if refund is None or refund is wallet_module.INSUFFICIENT:
                logger.critical(
                    "gacha: 抽選失敗時の返金に失敗しました。"
                    "手動で戻してください user=%s amount=%s", uid, price)
                return ("ガチャの処理に失敗しました。返金も完了していません。"
                        "Botの運営に連絡してください。")
            return "ガチャの処理に失敗しました。支払ったコインは返金しました。"
        balance = debit
        if dup_coins:
            credit = await wallet._change_balance(
                uid, dup_coins, create_with=wallet_module.NEW_USER_BALANCE)
            if credit is not None and credit is not wallet_module.INSUFFICIENT:
                balance = credit
                await self._record_history(
                    "gacha", uid, dup_coins, gacha_core.HISTORY_REASON_DUP)
            else:
                # 変換コインの付与失敗を握り潰して成功表示にしない (E-5c)。
                logger.critical(
                    "gacha: かぶり変換コインの付与に失敗しました。"
                    "手動で戻してください user=%s amount=%s", uid, dup_coins)
                lines.append(
                    "⚠️ かぶり変換コインの付与に失敗しました。"
                    "Botの運営に連絡してください。")
        lines.append(f"残高: {balance:,} AGO")
        return "\n".join(lines)

    # ------------------------------------------------------------------ 入口
    async def show_gacha(self, interaction: discord.Interaction):
        view = GachaView(self, interaction.user.id)
        view._cached_embed = summary_embed(self, interaction.user.id)
        await interaction.response.send_message(view=_wrap(view))
        try:
            view.message = await interaction.original_response()
        except Exception:
            logger.exception("gacha: パネルのメッセージ取得に失敗しました")


async def setup(bot: commands.Bot):
    await bot.add_cog(GachaCog(bot))
