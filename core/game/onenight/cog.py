# -*- coding: utf-8 -*-
"""ワンナイト人狼（3〜6人・約5分）。

夜フェーズ1回（役職アクション）→ 議論 → 投票 → 処刑で決着する
本編人狼の短縮版。ロジックは core/game/onenight/onenight.py、勝者は party_ranking に
"onenight" として記録される。本編人狼（cogs/jinrou.py）とは別ゲーム。
"""
import asyncio
import logging

import discord
from core.general.user_names import fallback_name
from discord.ext import commands

from core.game.game import game_panels, party_ranking
from core.game.game.game_v2 import GamePanelView, LobbyView, original_response_or_none, safe_delete, text_panel, GAME_MSG_NOT_JOINED
from core.game.onenight.onenight import (MAX_PLAYERS, MIN_PLAYERS, ROBBER, ROLE_INFO, SEER, VILLAGER, WOLF,
                           OneNightSession)

logger = logging.getLogger(__name__)

party_ranking.register("onenight")

GAME_ID = "onenight"
RECRUIT_SECONDS = 60
NIGHT_SECONDS = 90
DISCUSS_SECONDS = 120
VOTE_SECONDS = 60


class Runtime:
    def __init__(self, session: OneNightSession):
        self.session = session
        self.acted = set()
        self.skip = asyncio.Event()


def _name(bot, guild, user_id):
    """表示名（セレクトのラベル・結果表示用。メンションは返さない、sweep2 GA-24）。"""
    member = guild.get_member(user_id) if guild else None
    return member.display_name if member else fallback_name(user_id)


class SeerSelect(discord.ui.Select):
    def __init__(self, cog, runtime: Runtime, user_id, guild):
        session = runtime.session
        options = [discord.SelectOption(label=f"{_name(cog.bot, guild, uid)} の役職を見る", value=f"p:{uid}")
                   for uid in session.players if uid != user_id]
        options.append(discord.SelectOption(label="中央のカード2枚を見る", value="center"))
        super().__init__(placeholder="占い先を選んでください", options=options[:25])
        self.cog, self.runtime, self.user_id = cog, runtime, user_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("この操作は本人だけが行えます。", ephemeral=True)
        session = self.runtime.session
        if self.values[0] == "center":
            cards = session.seer_view_center(self.user_id)
            text = f"中央のカードは **{cards[0]}** と **{cards[1]}** でした。"
        else:
            target = int(self.values[0][2:])
            role = session.seer_view_player(self.user_id, target)
            text = f"<@{target}> さんの役職は **{role}** でした。"
        self.runtime.acted.add(self.user_id)
        await interaction.response.send_message(text, ephemeral=True)


class RobberSelect(discord.ui.Select):
    def __init__(self, cog, runtime: Runtime, user_id, guild):
        session = runtime.session
        options = [discord.SelectOption(label=f"{_name(cog.bot, guild, uid)} と交換する", value=str(uid))
                   for uid in session.players if uid != user_id]
        super().__init__(placeholder="交換相手を選んでください", options=options[:25])
        self.cog, self.runtime, self.user_id = cog, runtime, user_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message("この操作は本人だけが行えます。", ephemeral=True)
        session = self.runtime.session
        target = int(self.values[0])
        session.set_robber_target(self.user_id, target)
        new_role = session.initial[target]
        self.runtime.acted.add(self.user_id)
        await interaction.response.send_message(
            f"<@{target}> さんとカードを交換しました。あなたの新しい役職は **{new_role}** です"
            "（勝敗はこの役職で決まります）。", ephemeral=True)


class NightPanel(GamePanelView):
    """夜フェーズのパネル（V2）。役職・行動の詳細は ephemeral で返す。"""

    def __init__(self, cog, runtime: Runtime, body: str = ""):
        super().__init__("🌙 夜になりました", body, timeout=NIGHT_SECONDS + 30)
        self.cog, self.runtime = cog, runtime
        self.act = discord.ui.Button(label="役職確認と夜の行動", style=discord.ButtonStyle.primary)
        self.act.callback = self._act
        self.add_row(self.act)

    async def _act(self, interaction: discord.Interaction):
        session = self.runtime.session
        uid = interaction.user.id
        if uid not in session.players:
            return await interaction.response.send_message(GAME_MSG_NOT_JOINED, ephemeral=True)
        if uid in self.runtime.acted:
            return await interaction.response.send_message("夜の行動は済んでいます。", ephemeral=True)
        role = session.initial[uid]
        base = f"あなたの役職は **{role}** です。{ROLE_INFO[role]}"
        if role == WOLF:
            partners = session.wolf_partners(uid)
            if partners:
                base += "\n仲間の人狼: " + " ".join(f"<@{p}>" for p in partners)
            else:
                base += f"\n仲間の人狼はいません。中央のカードの1枚は **{session.center[0]}** でした。"
            self.runtime.acted.add(uid)
            return await interaction.response.send_message(base, ephemeral=True)
        if role == VILLAGER:
            self.runtime.acted.add(uid)
            return await interaction.response.send_message(base, ephemeral=True)
        view = discord.ui.View(timeout=60)
        view.add_item(SeerSelect(self.cog, self.runtime, uid, interaction.guild) if role == SEER
                      else RobberSelect(self.cog, self.runtime, uid, interaction.guild))
        await interaction.response.send_message(base, view=view, ephemeral=True)


NightView = NightPanel  # 互換名


class SkipPanel(GamePanelView):
    """議論フェーズのパネル（V2）。ホストだけが議論を終えられる。"""

    def __init__(self, runtime: Runtime, host_id, body: str = ""):
        super().__init__("☀️ 朝になりました", body, timeout=DISCUSS_SECONDS + 10)
        self.runtime, self.host_id = runtime, host_id
        self.skip = discord.ui.Button(label="議論を終える（ホスト）", style=discord.ButtonStyle.secondary)
        self.skip.callback = self._skip
        self.add_row(self.skip)

    async def _skip(self, interaction: discord.Interaction):
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message("ホストだけが使えます。", ephemeral=True)
        self.runtime.skip.set()
        await interaction.response.send_message("議論を終えて投票に進みます。")


SkipView = SkipPanel  # 互換名


class VotePanel(GamePanelView):
    """投票フェーズのパネル（V2）。セレクトは self.select。"""

    def __init__(self, cog, runtime: Runtime, guild, body: str = ""):
        super().__init__("🗳️ 投票", body, timeout=VOTE_SECONDS + 10)
        self.cog, self.runtime = cog, runtime
        self.select = VoteSelect(cog, runtime, guild)
        self.add_row(self.select)


class VoteSelect(discord.ui.Select):
    def __init__(self, cog, runtime: Runtime, guild):
        session = runtime.session
        options = [discord.SelectOption(label=_name(cog.bot, guild, uid), value=str(uid)) for uid in session.players]
        super().__init__(placeholder="処刑したい人を選んでください", options=options[:25])
        self.cog, self.runtime = cog, runtime

    async def callback(self, interaction: discord.Interaction):
        if self.runtime.session.vote(interaction.user.id, int(self.values[0])):
            await interaction.response.send_message("投票しました。", ephemeral=True)
        else:
            await interaction.response.send_message("投票済みか、参加していません。", ephemeral=True)


class OneNight(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels = set()

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。"""
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでにワンナイト人狼が開催中です。", ephemeral=True)
        self.channels.add(channel.id)
        view = LobbyView(
            title="🌙 ワンナイト人狼 参加者募集", host=interaction.user,
            min_players=MIN_PLAYERS, max_players=MAX_PLAYERS,
            note=(f"約5分で終わる短縮版人狼です。"
                  f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。"),
            timeout=RECRUIT_SECONDS + 10)
        await interaction.response.send_message(view=view)
        lobby_msg = await original_response_or_none(interaction)
        asyncio.create_task(self._run(channel, view, interaction.user.id, lobby_msg))

    async def _run(self, channel, view: LobbyView, host_id, lobby_msg=None):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if view.started or view.cancelled:
                    break
                await asyncio.sleep(0.5)
            view.stop()
            # 募集パネルは開始（または不成立）時点で役割を終える。
            await safe_delete(lobby_msg)
            if view.cancelled:
                return
            players = list(dict.fromkeys(view.players))
            if not MIN_PLAYERS <= len(players) <= MAX_PLAYERS:
                await channel.send(view=text_panel(
                    "", f"人数不足（{MIN_PLAYERS}人以上必要）のため、開始できませんでした。"))
                return
            session = OneNightSession(players)
            runtime = Runtime(session)
            # フェーズパネルは game_panels の追跡枠で引き継ぐ（前フェーズは消える）。
            await game_panels.replace(channel, "party", view=NightPanel(
                self, runtime,
                body=("全員「役職確認と夜の行動」ボタンを押してください。"
                      f"全員の行動が終わるか、{NIGHT_SECONDS}秒で朝になります。")))
            for _ in range(NIGHT_SECONDS * 2):
                if len(runtime.acted) >= len(players):
                    break
                await asyncio.sleep(0.5)
            session.resolve_night()
            await game_panels.replace(channel, "party", view=SkipPanel(
                runtime, host_id,
                body=f"死者はいませんでした。これから{DISCUSS_SECONDS}秒の議論です。"
                     "怪盗にカードを交換された人は、最終的な役職が入れ替わっています。"))
            try:
                await asyncio.wait_for(runtime.skip.wait(), timeout=DISCUSS_SECONDS)
            except asyncio.TimeoutError:
                pass
            vote_view = VotePanel(
                self, runtime, channel.guild,
                body=f"処刑したい人を選んでください（{VOTE_SECONDS}秒）。最多票の人が処刑されます（同票は全員）。")
            await game_panels.replace(channel, "party", view=vote_view)
            for _ in range(VOTE_SECONDS * 2):
                if len(session.votes) >= len(players):
                    break
                await asyncio.sleep(0.5)
            vote_view.stop()
            await self._announce_result(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("OneNight: 進行中にエラーが発生しました")
        finally:
            self.channels.discard(channel.id)

    async def _announce_result(self, channel, session: OneNightSession):
        result = session.result()
        guild = getattr(channel, "guild", None)
        lines = []
        for uid in session.players:
            mark = "（処刑）" if uid in result["executed"] else ""
            lines.append(f"{_name(self.bot, guild, uid)}: {session.final[uid]}{mark}")
        if result["peaceful"]:
            verdict = "プレイヤーの中に人狼はいませんでした（平和な夜）。**村人陣営の勝ち**です。"
        elif result["village_win"]:
            verdict = "人狼を処刑できました。**村人陣営の勝ち**です。"
        else:
            verdict = "人狼は生き残りました。**人狼陣営の勝ち**です。"
        # 投票パネルを片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        await channel.send(view=text_panel("🌙 ワンナイト人狼 結果", "\n".join(lines) + f"\n\n{verdict}"))
        if guild is not None:
            for uid in result["winners"]:
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(OneNight(bot))
