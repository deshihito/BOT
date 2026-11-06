# -*- coding: utf-8 -*-
"""ワンナイト人狼（3〜6人・約5分）。

夜フェーズ1回（役職アクション）→ 議論 → 投票 → 処刑で決着する
本編人狼の短縮版。ロジックは core/game/onenight.py、勝者は party_ranking に
"onenight" として記録される。本編人狼（cogs/jinrou.py）とは別ゲーム。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.game.onenight import (MAX_PLAYERS, MIN_PLAYERS, ROBBER, ROLE_INFO, SEER, VILLAGER, WOLF,
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
    member = guild.get_member(user_id) if guild else None
    return member.mention if member else f"<@{user_id}>"


class SeerSelect(discord.ui.Select):
    def __init__(self, cog, runtime: Runtime, user_id, guild):
        session = runtime.session
        options = [discord.SelectOption(label=f"{_name(cog.bot, guild, uid)} の役職を見る", value=f"p:{uid}")
                   for uid in session.players if uid != user_id]
        options.append(discord.SelectOption(label="中央のカード2枚を見る", value="center"))
        super().__init__(placeholder="占い先を選んでください", options=options[:25])
        self.cog, self.runtime, self.user_id = cog, runtime, user_id

    async def callback(self, interaction: discord.Interaction):
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
        session = self.runtime.session
        target = int(self.values[0])
        session.set_robber_target(self.user_id, target)
        new_role = session.initial[target]
        self.runtime.acted.add(self.user_id)
        await interaction.response.send_message(
            f"<@{target}> さんとカードを交換しました。あなたの新しい役職は **{new_role}** です"
            "（勝敗はこの役職で決まります）。", ephemeral=True)


class NightView(discord.ui.View):
    def __init__(self, cog, runtime: Runtime):
        super().__init__(timeout=NIGHT_SECONDS + 30)
        self.cog, self.runtime = cog, runtime

    @discord.ui.button(label="役職確認と夜の行動", style=discord.ButtonStyle.primary)
    async def act(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = self.runtime.session
        uid = interaction.user.id
        if uid not in session.players:
            return await interaction.response.send_message("あなたは参加していません。", ephemeral=True)
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


class RecruitView(discord.ui.View):
    def __init__(self, host_id):
        super().__init__(timeout=RECRUIT_SECONDS + 10)
        self.host_id = host_id
        self.players = [host_id]
        self.started = False

    @discord.ui.button(label="参加する", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id in self.players:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(self.players) >= MAX_PLAYERS:
            return await interaction.response.send_message(f"満員です（{MAX_PLAYERS}人まで）。", ephemeral=True)
        self.players.append(interaction.user.id)
        await interaction.response.send_message(f"参加しました（現在 {len(self.players)}名）。")

    @discord.ui.button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message("開始できるのはホストだけです。", ephemeral=True)
        if self.started:
            return await interaction.response.send_message("すでに開始しています。", ephemeral=True)
        self.started = True
        await interaction.response.send_message("ワンナイト人狼を開始します！")
        self.stop()


class SkipView(discord.ui.View):
    def __init__(self, runtime: Runtime, host_id):
        super().__init__(timeout=DISCUSS_SECONDS + 10)
        self.runtime, self.host_id = runtime, host_id

    @discord.ui.button(label="議論を終える（ホスト）", style=discord.ButtonStyle.secondary)
    async def skip(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message("ホストだけが使えます。", ephemeral=True)
        self.runtime.skip.set()
        await interaction.response.send_message("議論を終えて投票に進みます。")


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
        view = RecruitView(interaction.user.id)
        embed = discord.Embed(
            title="🌙 ワンナイト人狼 参加者募集",
            description=(f"{MIN_PLAYERS}〜{MAX_PLAYERS}人・約5分で終わる短縮版人狼です。"
                         f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。"),
            color=0xFFFFFF,
        )
        await interaction.response.send_message(embed=embed, view=view)
        asyncio.create_task(self._run(channel, view, interaction.user.id))

    async def _run(self, channel, view: RecruitView, host_id):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if view.started:
                    break
                await asyncio.sleep(0.5)
            if not view.started:
                view.started = True
                view.stop()
            players = list(dict.fromkeys(view.players))
            if not MIN_PLAYERS <= len(players) <= MAX_PLAYERS:
                await channel.send(embed=discord.Embed(
                    description=f"人数不足（{MIN_PLAYERS}人以上必要）のため、開始できませんでした。", color=0xFFFFFF))
                return
            session = OneNightSession(players)
            runtime = Runtime(session)
            await channel.send(
                embed=discord.Embed(
                    title="🌙 夜になりました",
                    description=("全員「役職確認と夜の行動」ボタンを押してください。"
                                 f"全員の行動が終わるか、{NIGHT_SECONDS}秒で朝になります。"),
                    color=0xFFFFFF),
                view=NightView(self, runtime))
            for _ in range(NIGHT_SECONDS * 2):
                if len(runtime.acted) >= len(players):
                    break
                await asyncio.sleep(0.5)
            session.resolve_night()
            await channel.send(embed=discord.Embed(
                title="☀️ 朝になりました",
                description=f"死者はいませんでした。これから{DISCUSS_SECONDS}秒の議論です。"
                            "怪盗にカードを交換された人は、最終的な役職が入れ替わっています。",
                color=0xFFFFFF), view=SkipView(runtime, host_id))
            try:
                await asyncio.wait_for(runtime.skip.wait(), timeout=DISCUSS_SECONDS)
            except asyncio.TimeoutError:
                pass
            vote_view = discord.ui.View(timeout=VOTE_SECONDS + 10)
            vote_view.add_item(VoteSelect(self, runtime, channel.guild))
            await channel.send(embed=discord.Embed(
                title="🗳️ 投票",
                description=f"処刑したい人を選んでください（{VOTE_SECONDS}秒）。最多票の人が処刑されます（同票は全員）。",
                color=0xFFFFFF), view=vote_view)
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
            lines.append(f"<@{uid}>: {session.final[uid]}{mark}")
        if result["peaceful"]:
            verdict = "プレイヤーの中に人狼はいませんでした（平和な夜）。**村人陣営の勝ち**です。"
        elif result["village_win"]:
            verdict = "人狼を処刑できました。**村人陣営の勝ち**です。"
        else:
            verdict = "人狼は生き残りました。**人狼陣営の勝ち**です。"
        embed = discord.Embed(title="🌙 ワンナイト人狼 結果", description="\n".join(lines) + f"\n\n{verdict}", color=0xFFFFFF)
        await channel.send(embed=embed)
        if guild is not None:
            for uid in result["winners"]:
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(OneNight(bot))
