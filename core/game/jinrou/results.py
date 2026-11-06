import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.emojis import FAILED, HAGE, REIBAI, SUCCESS
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core import autoplay
from core.game import jinrou_review
from core import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.jinrou.common import _is_wolf_side, reibai_color  # noqa: F401
from core.game.jinrou.helpers import _check_and_reveal_ura_yakushoku, _guide_role_lookup  # noqa: F401
from core.game.jinrou.views import ChairmanVoteView, PublicVoteView, ReplayView  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


class ResultsMixin:
    async def _send_exile_summary(self, game, lines):
        """追放結果の発表ラインを1枚の embed に集約して送る（§4.2-9）。"""
        if lines:
            await game.game_channel.send(embed=phase_summary_embed("追放結果", lines))

    async def _record_wins(self, game, user_ids):
        guild = getattr(getattr(game, "game_channel", None), "guild", None)
        if guild is None:
            return
        for uid in dict.fromkeys(user_ids):
            await party_ranking.shared().record_win(guild.id, uid, "jinrou")


    async def _record_team_win(self, game, winner_is_wolf: bool):
        alive_ids = {p.id for p in game.alive_players}

        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        winners = []
        for p in game.players:
            role = game.roles.get(p.id)
            if role == "ハゲ":
                continue
            if role == "コウモリむに":
                if p.id in alive_ids:
                    winners.append(p.id)
                continue
            if is_wolf_side(p.id) == winner_is_wolf:
                winners.append(p.id)
        await self._record_wins(game, winners)


    async def _check_koumorimuni_win(self, game):
        koumoris = [p for p in game.alive_players if game.roles.get(p.id) == "コウモリむに"]
        if not koumoris:
            return
        names_list = []
        for p in koumoris:
            m = game.game_channel.guild.get_member(p.id)
            if m: names_list.append(m.display_name)
        if names_list:
            await game.game_channel.send(f"さらに、{'、'.join(names_list)} は最後まで生き残り個人勝利しました！")


    async def _announce_final_roles(self, game):
        if not game.game_channel or not game.roles:
            return

        # ゲーム終了時はすべての裏役職を判明させる
        for p_id in game.roles.keys():
            await _check_and_reveal_ura_yakushoku(game, p_id, "end")

        lines = []
        alive_ids = {p.id for p in game.alive_players}
        for p in game.players:
            m = game.game_channel.guild.get_member(p.id)
            name = m.display_name if m else "不明"
            role = game.roles.get(p.id, "不明")
            status = SUCCESS if p.id in alive_ids else "💀"
            lines.append(f"{status} **{name}**: {role}")
        embed = discord.Embed(
            title="最終役職開示",
            description="\n".join(lines),
            color=0xFFFFFF
        )
        await game_panels.replace(game.game_channel, "party", embed=embed, view=ReplayView(game, self))


    async def _notify_reibai(self, game, executed_id):
        role = game.roles.get(executed_id)
        if role is None:
            return
        result = reibai_color(role)
        ex_member = game.game_channel.guild.get_member(executed_id)
        ex_name = ex_member.display_name if ex_member else "不明"

        for p in game.alive_players:
            p_role = game.roles.get(p.id)
            if p_role not in ["霊媒師", "大霊媒師"]:
                continue
            member = game.game_channel.guild.get_member(p.id)
            if not member:
                continue
            try:
                if p_role == "霊媒師":
                    await member.send(
                        f"{REIBAI}霊媒結果：**{ex_name}** は【{result}】でした。"
                    )
                elif p_role == "大霊媒師":
                    await member.send(
                        f"{REIBAI}大霊媒師の霊媒結果：**{ex_name}** は【{result}】"
                        f"（役職：**{role}**）でした。"
                    )
            except Exception:
                logger.debug("人狼: 霊媒結果のDM送信に失敗しました", exc_info=True)


    async def apply_forced_execution(self, game, target_id):
        if not game.is_running: return
        alive_ids = {p.id for p in game.alive_players}
        if target_id not in alive_ids:
            return

        actual_target_id = target_id

        lines: list[str] = []
        if game.roles.get(actual_target_id) == "貴族":
            slave_id = game.kizoku_slave.get(actual_target_id)
            if slave_id:
                slave_m = game.game_channel.guild.get_member(slave_id)
                if slave_m and slave_id in alive_ids:
                    lines.append(f"貴族の処刑判定が奴隷 {slave_m.display_name} に肩代わりされました。")
                    actual_target_id = slave_id

        target_m = game.game_channel.guild.get_member(actual_target_id)
        if not target_m: return

        game.last_executed = actual_target_id
        game.silenced_players.add(actual_target_id)
        game.alive_players = [p for p in game.alive_players if p.id != actual_target_id]

        # 裏役職の判明トリガーチェック（死亡時）
        await _check_and_reveal_ura_yakushoku(game, actual_target_id, "death")

        lines.append(f"{target_m.display_name} さんが追放されました。")

        await self._notify_reibai(game, actual_target_id)
        await self._check_mokumoku_reveal(game, actual_target_id)

        executed_role = game.roles.get(actual_target_id)
        if executed_role == "ハゲ":
            lines.append(HAGE + 'ハゲが追放された。ハゲの勝利です。')
            await self._send_exile_summary(game, lines)
            await self._record_wins(game, [actual_target_id])
            game.is_running = False
            return
        elif executed_role == "コウモリむに":
            lines.append("コウモリむにが追放された。しかし追放ではコウモリむには勝利できない...")

        for pair in game.riacchu_pairs:
            if actual_target_id in pair:
                partner_id = pair[1] if pair[0] == actual_target_id else pair[0]
                if partner_id in {p.id for p in game.alive_players}:
                    partner_m = game.game_channel.guild.get_member(partner_id)
                    if partner_m:
                        lines.append(f"リア充のパートナー {partner_m.display_name} も道連れになりました。")
                        game.silenced_players.add(partner_id)
                        game.alive_players = [p for p in game.alive_players if p.id != partner_id]
                break
        await self._send_exile_summary(game, lines)


    async def run_voting_phase(self, game):
        if not game.is_running: return
        game.in_night_phase = False
        await game.game_channel.send("ーー 投票フェーズ（40秒） ーー")
        game.silenced_players.update(p.id for p in game.alive_players)

        opts = [discord.SelectOption(label=p.display_name, value=str(p.id)) for p in game.alive_players]
        opts.append(discord.SelectOption(label="スキップ", value="skip"))
        game.voted_count = {}
        view = PublicVoteView(game, opts)
        view.add_item(jinrou_guide.PhaseHelpButton("vote", _guide_role_lookup(game), row=1))
        msg = await game_panels.replace(game.game_channel, "party", "生存者は投票してください", view=view)
        for _ in range(40):
            await asyncio.sleep(1)
            if not game.is_running: break
        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
        if game.is_running:
            await self._autoplay_votes(game)

        for p in game.alive_players:
            game.silenced_players.discard(p.id)

        if not game.voted_count:
            return await game.game_channel.send("投票なし。追放はありません。")

        counts = Counter(game.voted_count.values())
        most = counts.most_common()

        if len(most) > 1 and most[0][1] == most[1][1]:
            return await game.game_channel.send("同数票のためスキップされました。追放はありません。")

        target_id_str = most[0][0]
        if target_id_str == "skip":
            return await game.game_channel.send("投票の結果、スキップされました。追放はありません。")

        actual_target_id = int(target_id_str)
        target_m = game.game_channel.guild.get_member(actual_target_id)
        if not target_m:
            return

        lines: list[str] = []
        if game.roles.get(actual_target_id) == "貴族":
            slave_id = game.kizoku_slave.get(actual_target_id)
            if slave_id:
                slave_m = game.game_channel.guild.get_member(slave_id)
                if slave_m and slave_id in {p.id for p in game.alive_players}:
                    lines.append(f"貴族の処刑判定が奴隷 {slave_m.display_name} に肩代わりされました。")
                    actual_target_id = slave_id
                    target_m = slave_m

        lines.append(f"{target_m.display_name} さんが追放されました。")
        game.last_executed = actual_target_id
        game.silenced_players.add(actual_target_id)
        game.alive_players = [p for p in game.alive_players if p.id != actual_target_id]

        # 裏役職の判明トリガーチェック（死亡時）
        await _check_and_reveal_ura_yakushoku(game, actual_target_id, "death")

        await self._notify_reibai(game, actual_target_id)
        await self._check_mokumoku_reveal(game, actual_target_id)

        executed_role = game.roles.get(actual_target_id)
        if executed_role == "ハゲ":
            lines.append(HAGE + 'ハゲが追放された。ハゲの勝利です。')
            await self._send_exile_summary(game, lines)
            await self._record_wins(game, [actual_target_id])
            game.is_running = False
            return
        elif executed_role == "コウモリむに":
            lines.append("コウモリむにが追放された。しかし追放ではコウモリむには勝利できない...")

        for pair in game.riacchu_pairs:
            if actual_target_id in pair:
                partner_id = pair[1] if pair[0] == actual_target_id else pair[0]
                if partner_id in {p.id for p in game.alive_players}:
                    partner_m = game.game_channel.guild.get_member(partner_id)
                    if partner_m:
                        lines.append(f"リア充のパートナー {partner_m.display_name} も道連れになりました。")
                        game.silenced_players.add(partner_id)
                        game.alive_players = [p for p in game.alive_players if p.id != partner_id]
                break
        await self._send_exile_summary(game, lines)


    async def run_chairman_vote_phase(self, game):
        if not game.is_running: return
        game.chairman_vote_event = asyncio.Event()
        game.chairman_ketsugu_target = None

        opts = [
            discord.SelectOption(label=p.display_name, value=str(p.id))
            for p in game.alive_players
            if game.roles.get(p.id) != "議長"
        ]
        if not opts:
            await game.game_channel.send("追放できる対象がいません。")
            return

        for p in game.alive_players:
            if game.roles.get(p.id) != "議長":
                game.silenced_players.add(p.id)

        view = ChairmanVoteView(game, opts)
        view.add_item(jinrou_guide.PhaseHelpButton("vote", _guide_role_lookup(game), row=1))
        msg = await game_panels.replace(game.game_channel, "party",
            "ーー 強制投票（60秒） ーー\n**議長のみ**が投票できます。追放する対象を選んでください。",
            view=view
        )

        t = 0
        while not game.chairman_vote_event.is_set() and t < 60:
            await asyncio.sleep(1)
            t += 1
            if not game.is_running: break

        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)

        for p in game.alive_players:
            game.silenced_players.discard(p.id)

        if game.chairman_ketsugu_target:
            await self.apply_forced_execution(game, game.chairman_ketsugu_target)
            game.chairman_ketsugu_target = None
        else:
            await game.game_channel.send("議長が時間内に投票しなかった。追放はありません。")
