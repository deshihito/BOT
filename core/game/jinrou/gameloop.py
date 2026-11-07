import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.support.emojis import FAILED, KISHI, MASAI, MENHERA, MUSIC, PANYA, RESTART, SUCCESS
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core.game import autoplay
from core.game import game_restore, jinrou_review, jinrou_snapshot
from core.game import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.jinrou.common import _is_wolf_side  # noqa: F401
from core.game.jinrou.game import JinrouGame  # noqa: F401
from core.game.jinrou.helpers import _check_and_reveal_ura_yakushoku, _get_display_role, _guide_role_lookup  # noqa: F401
from core.game.jinrou.views import NightActionView, RoleCheckView  # noqa: F401
from core.game.game_v2 import GamePanelView  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


class GameLoopMixin:
    async def _start_game_loop(self, game: JinrouGame, channel):
        if len(game.players) < 5:
            game.is_running = False
            await channel.send(f"{FAILED}参加者が5人未満のため、ゲームを中止します。")
            return

        game.alive_players = game.players.copy()
        game.started = True
        self.assign_roles(game)
        jinrou_snapshot.save_boundary_safely(game, "roles_assigned")

        mentions = " ".join([p.mention for p in game.players])

        is_mokumoku_active = any(game.roles.get(p.id) == "もくもく" for p in game.alive_players) and game.mokumoku_turns < 3
        if is_mokumoku_active:
            roles_list = "（もくもくにより非公開）"
        else:
            roles_for_display = []
            for p_id, r in game.roles.items():
                display_r = _get_display_role(game, p_id, reveal_hidden=False)
                roles_for_display.append(display_r)
            roles_list = " / ".join(set(roles_for_display))

        role_check_view = RoleCheckView(game, self)
        role_check_view.set_content(
            "ゲーム開始",
            f"{SUCCESS}{mentions}\n今回の役職内訳: {roles_list}\n下のボタンで自分の役職確認を行ってください。")
        await game_panels.replace(channel, "party", view=role_check_view)

        for p in game.players:
            role = game.roles[p.id]
            if role == "リア充":
                for pair in game.riacchu_pairs:
                    if p.id in pair:
                        other_id = pair[1] if pair[0] == p.id else pair[0]
                        other_m = channel.guild.get_member(other_id)
                        name = other_m.display_name if other_m else "不明"
                        try: await p.send(f"【リア充】あなたの相方は {name} さんです。")
                        except Exception:
                            logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)
            elif role == "貴族":
                slave_id = game.kizoku_slave.get(p.id)
                if slave_id:
                    slave_m = channel.guild.get_member(slave_id)
                    name = slave_m.display_name if slave_m else "不明"
                    try: await p.send(f"【貴族】あなたの奴隷は {name} さんです。")
                    except Exception:
                        logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)
            elif role == "奴隷":
                for k_id, s_id in game.kizoku_slave.items():
                    if s_id == p.id:
                        k_m = channel.guild.get_member(k_id)
                        name = k_m.display_name if k_m else "不明"
                        try: await p.send(f"【奴隷】あなたのご主人様（貴族）は {name} さんです。")
                        except Exception:
                            logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)

        try:
            await self.run_discussion(game, seconds=150, title="特別ディスカッション")

            while game.is_running:
                await self.run_night_phase(game)
                if not game.is_running or await self.check_victory(game): break
                jinrou_snapshot.save_boundary_safely(game, "day_start")

                game.chairman_ketsugu_target = None
                game.chairman_forced_vote = False
                await self.run_discussion(game, seconds=150, title="昼のディスカッション")
                if not game.is_running: break

                before_vote = {p.id for p in game.alive_players}
                if game.chairman_forced_vote:
                    game.chairman_forced_vote = False
                    await self.run_chairman_vote_phase(game)
                else:
                    await self.run_voting_phase(game)
                jinrou_review.record_day(game, game.day_count,
                                         [p.id for p in game.players if p.id in before_vote and p.id not in {a.id for a in game.alive_players}])
                jinrou_snapshot.save_boundary_safely(game, "vote_done")

                if not game.is_running or await self.check_victory(game): break

        except Exception as e:
            logger.exception("人狼のゲームループでエラーが発生しました")
        finally:
            # 終了時は発言制限をすべて解除する（死亡者の制限も解く）
            game.silenced_players.clear()
            game.in_discussion = False
            game.in_night_phase = False
            game.started = False
            if game.roles:
                try: await self._announce_final_roles(game)
                except Exception:
                    logger.debug("人狼: 最終役職の発表に失敗しました", exc_info=True)
                if game.review:
                    try: await game.game_channel.send(view=jinrou_review.build_view(game))
                    except Exception:
                        logger.debug("人狼: 振り返りパネルの送信に失敗しました", exc_info=True)
            game.is_running = False
            jinrou_snapshot.clear_safely(game)


    async def run_discussion(self, game, seconds, title):
        if not game.is_running: return
        game.in_night_phase = False
        game.chairman_skip_event = asyncio.Event()
        game.in_discussion = True

        game.silenced_players.clear()

        minutes_str = f"{seconds // 60}分{seconds % 60}秒" if seconds % 60 else f"{seconds // 60}分"
        panel = GamePanelView(f"{title}（{minutes_str}）", "", timeout=seconds + 30)
        panel.add_row(jinrou_guide.PhaseHelpButton("day", _guide_role_lookup(game)))
        await game_panels.replace(game.game_channel, "party", view=panel)
        if any(game.roles.get(p.id) == "パン屋" for p in game.alive_players):
            await game.game_channel.send(PANYA + 'パン屋がパンを焼きました')

        for _ in range(seconds):
            if game.chairman_skip_event.is_set():
                break
            await asyncio.sleep(1)
            if not game.is_running:
                game.in_discussion = False
                return

        game.in_discussion = False
        await game.game_channel.send(f"ーー {title}終了 ーー")


    async def run_night_phase(self, game):
        if not game.is_running: return
        game.in_night_phase = True
        jinrou_snapshot.save_boundary_safely(game, "night_start")
        game.day_count += 1
        await game.game_channel.send(f"ーー 第{game.day_count}夜（1分） ーー")

        game.silenced_players.clear()
        game.silenced_players.update(p.id for p in game.alive_players if game.roles.get(p.id) != "ネット民")

        game.night_actions = {}
        view = NightActionView(game)
        view.add_help_button(jinrou_guide.PhaseHelpButton("night", _guide_role_lookup(game)))
        msg = await game_panels.replace(game.game_channel, "party", view=view)

        req_roles_single = ["占い師", "騎士", "罠師", "あごむに破道砲", "マサイ族", "陽キャ"]
        if game.day_count == 1: req_roles_single.append("ワンころ")
        # 人狼・デカ狼以外の役職の生存者数を数える
        req = sum(1 for p in game.alive_players if game.roles.get(p.id) in req_roles_single)

        # 人狼・デカ狼が1人でも生存していれば、要求アクション数を +1 する
        if any(game.roles.get(p.id) in ["人狼", "デカ狼"] for p in game.alive_players):
            req += 1

        alive_ids = {p.id for p in game.alive_players}
        has_dead = any(p.id not in alive_ids for p in game.players)
        req += sum(1 for p in game.alive_players if game.roles.get(p.id) == "大霊媒師" and has_dead)
        req += sum(1 for p in game.alive_players if game.roles.get(p.id) == "ミュージシャン" and not game.musician_party_used)

        t = 0
        while len(game.night_actions) < req and t < 60:
            await asyncio.sleep(1)
            t += 1
            if not game.is_running: break

        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)

        if game.is_running:
            await self._autoplay_night(game)
        game.in_night_phase = False
        game.silenced_players.clear()
        await self.process_night_results(game)


    async def process_night_results(self, game):
        if not game.is_running: return

        # もくもくの効果適用判定
        is_mokumoku_active = any(game.roles.get(p.id) == "もくもく" for p in game.alive_players) and game.mokumoku_turns < 3

        # ログ送信用の内部関数（もくもく効果中ならコメントを差し替える）
        async def send_log(message: str):
            if is_mokumoku_active:
                await game.game_channel.send("もくもく")
            else:
                await game.game_channel.send(message)

        alive_before = [p.id for p in game.alive_players]
        actions_snapshot = dict(game.night_actions)
        attack_results = {}  # 振り返り表用 {人狼: (対象, 結果)}
        dead_ids = set()
        wolf_attacks   = {}
        knight_targets = set()
        trap_targets   = {}

        # メンヘラおよびヤンデレのIDを物理消去の判定用セットに格納
        psycho_killer_ids = {p.id for p in game.alive_players if game.roles.get(p.id) == "メンヘラ"}

        # ヤンデレに紐づいている人狼が夜に関与された場合、関与したプレイヤーを返り討ちにする
        yandere_triggered_by = set()
        for yandere_id, wolf_id in game.yandere_targets.items():
            if yandere_id in {p.id for p in game.alive_players}:
                yandere_triggered_by.add(wolf_id)

        menhera_triggered = False
        cancelled_ids = set()
        musician_protected = set()

        # ミュージシャンのパーティ処理
        for p_id, t_id in game.night_actions.items():
            role = game.roles.get(p_id)
            if role == "ミュージシャン" and t_id == 0 and not game.musician_party_used:
                game.musician_party_used = True
                candidates = [p for p in game.alive_players if p.id != p_id]
                party_count = min(4, len(candidates))
                if party_count > 0:
                    party_members = random.sample(candidates, party_count)
                    party_ids = {p.id for p in party_members}
                    party_names = []
                    for pid in party_ids:
                        m = game.game_channel.guild.get_member(pid)
                        if m: party_names.append(m.display_name)

                    await send_log(f"ミュージシャンがパーティを開催！ {', '.join(party_names)} が招待されました！")

                    for pid in party_ids:
                        cancelled_ids.add(pid)
                        musician_protected.add(pid)

                    wolf_in_party = [pid for pid in party_ids if game.roles.get(pid) in ["人狼", "デカ狼"]]
                    if wolf_in_party and random.random() < 0.3:
                        non_wolf_party = [pid for pid in party_ids if game.roles.get(pid) not in ["人狼", "デカ狼"]]
                        if non_wolf_party:
                            victim_id = random.choice(non_wolf_party)
                            dead_ids.add(victim_id)
                            victim_m = game.game_channel.guild.get_member(victim_id)
                            if victim_m:
                                await send_log(f"{MUSIC} パーティに人狼が紛れ込んでいた！ {victim_m.display_name} が犠牲になりました...")
                break

        # 陽キャのアクション処理
        for p_id, t_id in list(game.night_actions.items()):
            role = game.roles.get(p_id)
            if role != "陽キャ" or p_id in cancelled_ids:
                continue

            t_role = game.roles.get(t_id)
            target_m = game.game_channel.guild.get_member(t_id)
            target_name = target_m.display_name if target_m else "不明"
            yoikya_m = game.game_channel.guild.get_member(p_id)
            yoikya_name = yoikya_m.display_name if yoikya_m else "不明"

            if t_role in ["人狼", "デカ狼"]:
                dead_ids.add(p_id)
                await send_log(f"{yoikya_name} が {target_name} をℳ𝓎𝒽ℴ𝓂ℯに誘ったが人狼に返り討ちにあった...")
            elif t_role == "メンヘラ":
                game.roles[p_id] = "リア充"
                game.roles[t_id] = "リア充"
                game.riacchu_pairs.append((p_id, t_id))
                psycho_killer_ids.discard(t_id)
                await send_log(f"{yoikya_name} が {target_name}（メンヘラ）を堕とした！ 2人はリア充へと変化しました！")
            else:
                cancelled_ids.add(t_id)
                await send_log(f"{yoikya_name} が {target_name} をℳ𝓎𝒽ℴ𝓂ℯに誘って酔い潰した！ {target_name} の夜のアクションはキャンセルされました。")

        # 各役職のアクションおよび関与の精査
        for p_id, t_id in game.night_actions.items():
            role = game.roles.get(p_id)
            if p_id in cancelled_ids or t_id == 0:
                continue

            # メンヘラへの直接関与、またはヤンデレ対象の人狼への夜の関与のチェック
            if t_id in psycho_killer_ids or t_id in yandere_triggered_by:
                dead_ids.add(p_id)
                menhera_triggered = True

            if role in ["人狼", "デカ狼"]:
                wolf_attacks[p_id] = t_id
            elif role == "騎士":
                knight_targets.add(t_id)
            elif role == "罠師":
                trap_targets[t_id] = p_id
            elif role == "あごむに破道砲":
                dead_ids.add(p_id); dead_ids.add(t_id)
                game.used_hadouhou = True
                others = [p.id for p in game.alive_players if p.id not in [p_id, t_id]]
                if others: dead_ids.add(random.choice(others))
                await send_log("あごむに破道砲が火を噴きました。")
            elif role == "ワンころ" and game.day_count == 1:
                game.wan_owner[p_id] = t_id

        if menhera_triggered:
            await send_log(MENHERA + '誰かがメンヘラ（またはヤンデレの呪い）に返り討ちにされました。')

        # 人狼の襲撃処理
        for wolf_id, target_id in wolf_attacks.items():
            if wolf_id in dead_ids:
                attack_results[wolf_id] = (target_id, "attacker_dead")
                continue
            if target_id in trap_targets:
                dead_ids.add(wolf_id)
                attack_results[wolf_id] = (target_id, "trapped")
                await send_log("罠師の罠が発動！ 狼が罠にかかりました。")
                continue
            if target_id in knight_targets or target_id in musician_protected:
                attack_results[wolf_id] = (target_id, "guarded" if target_id in knight_targets else "party")
                continue
            if game.roles.get(target_id) == "マサイ族" and game.masai_evasion.get(target_id):
                if random.random() < 0.5:
                    attack_results[wolf_id] = (target_id, "evaded")
                    await send_log(MASAI + 'マサイ族は襲撃を回避しました。')
                    continue
            attack_results[wolf_id] = (target_id, "success")
            dead_ids.add(target_id)

        # 貴族・奴隷・リア充等の死亡連動処理（既存コードを維持）
        final_dead = set()
        already_substituted = set()
        for d_id in list(dead_ids):
            if d_id in already_substituted: continue
            if game.roles.get(d_id) == "貴族":
                slave_id = game.kizoku_slave.get(d_id)
                if slave_id and slave_id in {p.id for p in game.alive_players} and slave_id not in dead_ids:
                    await send_log("貴族の死亡判定が奴隷に肩代わりされました。")
                    final_dead.add(slave_id)
                    already_substituted.add(slave_id)
                    continue
            final_dead.add(d_id)

        for pair in game.riacchu_pairs:
            if pair[0] in final_dead or pair[1] in final_dead:
                final_dead.add(pair[0]); final_dead.add(pair[1])

        # 生存者リスト更新
        if final_dead:
            for d_id in list(final_dead):
                if d_id not in {p.id for p in game.alive_players}: continue
                m = game.game_channel.guild.get_member(d_id)
                if m:
                    await send_log(f"夜の結果: {m.display_name} さんが犠牲になりました。")

                    # 裏役職の判明トリガーチェック（死亡時）
                    await _check_and_reveal_ura_yakushoku(game, d_id, "death")

                    if game.roles.get(d_id) == "タフむに":
                        killers = [pid for pid, tid in game.night_actions.items() if tid == d_id and pid not in final_dead and pid in {p.id for p in game.alive_players}]
                        if killers:
                            k_id = random.choice(killers)
                            k_m = game.game_channel.guild.get_member(k_id)
                            if k_m:
                                await send_log(f"タフむにの反撃。 {k_m.display_name} を道連れにしました。")
                                game.alive_players = [p for p in game.alive_players if p.id != k_id]

                    game.alive_players = [p for p in game.alive_players if p.id != d_id]
                    await self._check_mokumoku_reveal(game, d_id)
        else:
            await send_log(KISHI + '夜の結果: 昨晩の犠牲者はいないようです。')

        alive_after = {p.id for p in game.alive_players}
        jinrou_review.record_night(game, game.day_count, actions_snapshot, cancelled_ids, attack_results,
                                   [uid for uid in alive_before if uid not in alive_after])

        # もくもくの経過ターンカウントをインクリメント
        if any(game.roles.get(p.id) == "もくもく" for p in game.alive_players):
            game.mokumoku_turns += 1

        if game.alive_players:
            survivors_mention = " ".join(p.mention for p in game.alive_players)
            await game.game_channel.send(view=phase_summary_view(
                "夜が明けました",
                [f"生存者（{len(game.alive_players)}人）: {survivors_mention}"],
            ))


    async def check_victory(self, game):
        if not game.is_running: return True

        wolves_alive = [p for p in game.alive_players if game.roles.get(p.id) in ["人狼", "デカ狼"]]
        if not wolves_alive:
            await game.game_channel.send(view=phase_summary_view(
                "勝敗確定", ["人狼全滅。村人陣営の勝利です。"], color=0x2ECC71))
            await self._check_koumorimuni_win(game)
            await self._record_team_win(game, winner_is_wolf=False)
            await self._process_elo_ratings(game, winner_is_wolf=False)
            game.is_running = False
            return True

        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        wolves    = [p for p in game.alive_players if is_wolf_side(p.id)]
        non_wolves = [p for p in game.alive_players if not is_wolf_side(p.id)]

        if len(wolves) >= len(non_wolves):
            await game.game_channel.send(view=phase_summary_view(
                "勝敗確定", ["人狼が支配した。人狼陣営の勝利です。"], color=0xE74C3C))
            await self._check_koumorimuni_win(game)
            await self._record_team_win(game, winner_is_wolf=True)
            await self._process_elo_ratings(game, winner_is_wolf=True)
            game.is_running = False
            return True

        return False


_BOUNDARY_LABELS = {
    "roles_assigned": "役職を配った直後",
    "night_start": "夜の開始時点",
    "day_start": "夜が明けて昼に入る時点",
    "vote_done": "投票が確定した直後",
}


async def resume_game_loop(cog, game, channel, boundary):
    """保存された境界から対局を続行する（_start_game_loop の再開版）。"""
    phase = boundary
    try:
        if phase == "roles_assigned":
            await cog.run_discussion(game, seconds=150, title="特別ディスカッション")
            phase = "night_start"
        while game.is_running:
            if phase == "night_start":
                await cog.run_night_phase(game)
                if not game.is_running or await cog.check_victory(game):
                    break
                jinrou_snapshot.save_boundary_safely(game, "day_start")
                phase = "day_start"
            if phase == "day_start":
                game.chairman_ketsugu_target = None
                game.chairman_forced_vote = False
                await cog.run_discussion(game, seconds=150, title="昼のディスカッション")
                if not game.is_running:
                    break
                before_vote = {p.id for p in game.alive_players}
                if game.chairman_forced_vote:
                    game.chairman_forced_vote = False
                    await cog.run_chairman_vote_phase(game)
                else:
                    await cog.run_voting_phase(game)
                jinrou_review.record_day(game, game.day_count,
                                         [p.id for p in game.players if p.id in before_vote and p.id not in {a.id for a in game.alive_players}])
                jinrou_snapshot.save_boundary_safely(game, "vote_done")
                phase = "vote_done"
            if phase == "vote_done":
                if not game.is_running or await cog.check_victory(game):
                    break
                phase = "night_start"
    except Exception:
        logger.exception("人狼の復旧ループでエラーが発生しました")
    finally:
        game.silenced_players.clear()
        game.in_discussion = False
        game.in_night_phase = False
        game.started = False
        if game.roles:
            try:
                await cog._announce_final_roles(game)
            except Exception:
                logger.debug("人狼: 最終役職の発表に失敗しました", exc_info=True)
            if game.review:
                try:
                    await game.game_channel.send(view=jinrou_review.build_view(game))
                except Exception:
                    logger.debug("人狼: 振り返りEmbedの送信に失敗しました", exc_info=True)
        game.is_running = False
        jinrou_snapshot.clear_safely(game)


async def restore_jinrou_sessions(cog):
    """保存された境界スナップショットから対局を再構築する（ローカル対局のみ）。"""
    entries = game_restore.session_entries("jinrou")
    for channel_id, entry in entries.items():
        try:
            restored = await _restore_jinrou_session(cog, channel_id, entry)
        except Exception:
            logger.exception("channel %s: 人狼の復旧に失敗しました", channel_id)
            restored = False
        if not restored:
            game_restore.clear_session("jinrou", channel_id)
    game_restore.flush_store()


async def _restore_jinrou_session(cog, channel_id, entry) -> bool:
    state = entry.get("state")
    if not isinstance(state, dict):
        return False
    boundary = state.get("boundary")
    if boundary not in jinrou_snapshot.BOUNDARIES:
        return False
    channel = cog.bot.get_channel(channel_id)
    if channel is None:
        return False
    existing = cog.games.get(channel_id)
    if existing is not None and getattr(existing, "is_running", False):
        return False
    game = cog.get_game(channel_id)
    guild = getattr(channel, "guild", None)

    def resolve(ref):
        return game_restore.resolve_member(guild, ref.get("id"), ref.get("name"))

    if not jinrou_snapshot.apply_state(game, state, resolve):
        return False
    game.game_channel = channel
    game._original_channel = channel
    label = _BOUNDARY_LABELS.get(boundary, boundary)
    mentions = " ".join(p.mention for p in game.players)
    role_check_view = RoleCheckView(game, cog)
    role_check_view.set_content(
        "人狼を再開します",
        f"{mentions}\n{RESTART} 再起動前に進行中だった人狼を、{label}（第{game.day_count}日）から再開します。\n"
        "※ フェーズの途中経過（その夜のアクションや発言）は失われ、直近の境界まで巻き戻っています。"
        "役職は「役職確認」ボタンで確認し直してください。")
    await channel.send(view=role_check_view)
    asyncio.create_task(resume_game_loop(cog, game, channel, boundary))
    return True
