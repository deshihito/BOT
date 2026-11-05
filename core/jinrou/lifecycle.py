import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core import game_panels, jinrou_snapshot
from core.emojis import FAILED, SUCCESS
from core import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core import autoplay, jinrou_review
from core import party_ranking
import math
import config

from core.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.jinrou.common import AHO_FAKE_CANDIDATES  # noqa: F401
from core.jinrou.game import JinrouGame  # noqa: F401
from core.jinrou.ratings import can_end_game  # noqa: F401
from core.jinrou.views import GlobalChannelProxy, GlobalJoinView, SetupView  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


class LifecycleMixin:
    def get_game(self, channel_id) -> JinrouGame:
        if channel_id not in self.games:
            self.games[channel_id] = JinrouGame()
        return self.games[channel_id]


    def get_wolves_names(self, game) -> str:
        wolves = []
        for p_id, role in game.roles.items():
            if role in ["人狼", "デカ狼"]:
                m = game.game_channel.guild.get_member(p_id)
                if m: wolves.append(m.display_name)
        return "、".join(wolves) if wolves else "なし"


    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return

        # 元のサーバーのチャンネルには、以前のローカル用のゲーム（止まっているもの）が残っていることがある。
        # それが動いていないときは、このチャンネルが入っているグローバルゲームを探す
        game = self.games.get(message.channel.id)
        if not game or not game.is_running:
            for g in self.games.values():
                if g.is_running and getattr(g, "is_global", False) and message.channel.id in [c.id for c in g.channels]:
                    game = g
                    break

        if not game or not game.is_running:
            return

        # 死亡・追放された参加者は、昼・夜・投票中を問わず発言できない
        if game.is_dead_player(message.author.id):
            try: await message.delete()
            except Exception:
                logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
            return

        player_role = game.roles.get(message.author.id)
        is_alive = any(p.id == message.author.id for p in game.alive_players)

        if is_alive and player_role == "ネット民":
            if game.in_discussion:
                try: await message.delete()
                except Exception:
                    logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                return
        else:
            if message.author.id in game.silenced_players:
                try: await message.delete()
                except Exception:
                    logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                return

        if game.in_discussion:
            if player_role == "議長" and is_alive:
                content = message.content.strip()

                if content == "スキップ":
                    if game.chairman_skip_event and not game.chairman_skip_event.is_set():
                        await game.game_channel.send("議長がスキップを宣言。議論を終了し投票フェーズに移行します。")
                        game.chairman_skip_event.set()

                elif content == "強制投票" and not game.chairman_ketsugu_used:
                    game.chairman_ketsugu_used = True
                    game.chairman_forced_vote = True
                    if game.chairman_skip_event and not game.chairman_skip_event.is_set():
                        game.chairman_skip_event.set()
                    await game.game_channel.send(
                        "議長が強制投票を宣言！ 議論を中断し、議長による投票に移行します。"
                    )

            if getattr(game, "is_global", False):
                import time
                now = time.time()
                last_time = game.last_speak_time.get(message.author.id, 0)
                if now - last_time < 1.0:
                    try: await message.delete()
                    except Exception:
                        logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                    return
                game.last_speak_time[message.author.id] = now

                escaped_content = discord.utils.escape_mentions(message.content)

                if not hasattr(self, "webhook_cache"):
                    self.webhook_cache = {}

                for chan in game.channels:
                    if chan.id != message.channel.id:
                        try:
                            webhook = self.webhook_cache.get(chan.id)
                            if not webhook:
                                webhooks = await chan.webhooks()
                                webhook = discord.utils.get(webhooks, name="Jinrou-Global")
                                if not webhook:
                                    webhook = await chan.create_webhook(name="Jinrou-Global")
                                self.webhook_cache[chan.id] = webhook

                            await webhook.send(
                                content=escaped_content,
                                username=f"{message.author.display_name} ({message.guild.name})",
                                avatar_url=message.author.display_avatar.url,
                                allowed_mentions=discord.AllowedMentions.none()
                            )
                        except Exception:
                            logger.debug("人狼: グローバル対戦の発言転送に失敗しました", exc_info=True)


    def assign_roles(self, game):
        num = len(game.players)
        num_wolves = max(1, num // 4)

        # メンヘラの発展先としてヤンデレを追加
        promotion_map = {
            "人狼":             "デカ狼",
            "騎士":             "罠師",
            "一般通過あごむに": "タフむに",
            "狂人":             "狂信者",
            "入狼":             "ワンころ",
            "ハゲ":             "コウモリむに",
            "霊媒師":           "大霊媒師",
            "陽キャ":           "ミュージシャン",
            "ビー玉ブレイカー": "もくもく",
            "メンヘラ":         "ヤンデレ",
        }

        def maybe_promote(role):
            # ベーシックモード時は発展職（昇格）を発生させない
            if game.game_mode == "ベーシック":
                return role
            if role in promotion_map and random.random() < 0.35:
                return promotion_map[role]
            return role

        excluded = set(game.excluded_roles)
        required = list(game.required_roles)

        pool = list(required)

        wolf_in_req = sum(1 for r in required if r in ["人狼", "デカ狼"])
        additional_wolves = max(0, num_wolves - wolf_in_req)
        for _ in range(min(additional_wolves, num - len(pool))):
            pool.append(maybe_promote("人狼"))

        # 候補プールに「ネット民」と「アホ」を追加
        candidates = [
            r for r in [
                "占い師", "騎士", "霊媒師", "パン屋", "マサイ族", "入狼",
                "議長", "ビー玉ブレイカー", "陽キャ", "狂人", "ハゲ", "メンヘラ", "あごむに破道砲", "ネット民", "アホ"
            ]
            if r not in excluded and r not in required
        ]
        random.shuffle(candidates)
        ci = 0

        while len(pool) < num:
            if random.random() < 0.65 and ci < len(candidates):
                r = candidates[ci]; ci += 1
                pool.append(maybe_promote(r))
            else:
                pool.append(maybe_promote("一般通過あごむに"))

        pool = pool[:num]

        # 2人役職はプロモード時（発展職が有効な設定）のみ発生させる仕様に準拠
        if game.game_mode == "プロ" and num >= 8 and random.random() < 0.3:
            pair_type = random.choice(["リア充", "貴族奴隷"])
            pair_roles = ["リア充", "リア充"] if pair_type == "リア充" else ["貴族", "奴隷"]

            replaceable = [i for i, r in enumerate(pool) if r in ["一般通過あごむに", "タフむに"]]
            if len(replaceable) >= 2:
                idxs = random.sample(replaceable, 2)
                for i, idx in enumerate(idxs):
                    pool[idx] = pair_roles[i]
            elif len(replaceable) == 1:
                pool[replaceable[0]] = pair_roles[0]
                if len(pool) < num:
                    pool.append(pair_roles[1])
                else:
                    pool[-1] = pair_roles[1]
            else:
                safe = [i for i, r in enumerate(pool) if r not in ["人狼", "デカ狼", "占い師"]]
                if len(safe) >= 2:
                    idxs = random.sample(safe, 2)
                    for i, idx in enumerate(idxs):
                        pool[idx] = pair_roles[i]

        pool = pool[:num]
        random.shuffle(pool)

        for i, p in enumerate(game.players):
            game.roles[p.id] = pool[i]
            game.display_roles[p.id] = pool[i]  # 最初は表示用も本当の役職
            game.ura_reveal_triggers[p.id] = False  # 裏役職は未判明

            # アホの場合、偽装役職をランダムに選択
            if pool[i] == "アホ":
                game.aho_fake_role[p.id] = random.choice(AHO_FAKE_CANDIDATES)

        # ヤンデレが選択された場合、生存している人狼陣営からランダムで1人対象を選ぶ
        wolves_ids = [p_id for p_id, r in game.roles.items() if r in ["人狼", "デカ狼"]]
        for p_id, r in game.roles.items():
            if r == "ヤンデレ" and wolves_ids:
                game.yandere_targets[p_id] = random.choice(wolves_ids)

        riacchu_ids = []
        kizoku_id = dorei_id = None
        for p in game.players:
            role = game.roles[p.id]
            if role == "リア充":   riacchu_ids.append(p.id)
            elif role == "貴族":   kizoku_id = p.id
            elif role == "奴隷":   dorei_id = p.id

        if len(riacchu_ids) >= 2:
            game.riacchu_pairs.append((riacchu_ids[0], riacchu_ids[1]))
        if kizoku_id and dorei_id:
            game.kizoku_slave[kizoku_id] = dorei_id


    async def _check_mokumoku_reveal(self, game, dead_id):
        if game.roles.get(dead_id) != "もくもく":
            return
        if any(game.roles.get(p.id) == "もくもく" for p in game.alive_players):
            return
        roles_for_display = []
        for r in game.roles.values():
            if r == "タフむに":         roles_for_display.append("一般通過あごむに")
            elif r == "入狼":           roles_for_display.append("一般通過あごむに")
            elif r == "大霊媒師":       roles_for_display.append("霊媒師")
            elif r == "ミュージシャン":  roles_for_display.append("陽キャ")
            elif r == "もくもく":       roles_for_display.append("一般通過あごむに")
            elif r == "ヤンデレ":       roles_for_display.append("メンヘラ")
            elif r == "ビー玉ブレイカー": roles_for_display.append("一般通過あごむに")
            elif r == "アホ":           roles_for_display.append(game.aho_fake_role.get(game.players[[p.id for p in game.players if game.roles.get(p.id) == "アホ"][0]].id if any(p.id for p in game.players if game.roles.get(p.id) == "アホ") else None, "一般通過あごむに"))
            else:                       roles_for_display.append(r)
        roles_list = " / ".join(set(roles_for_display))
        await game.game_channel.send(f"もくもくが姿を消した。役職構成が明らかになります！\n{roles_list}")


    async def force_end(self, interaction: discord.Interaction):
        """/game の人狼画面の「ゲームを終了」から呼ぶ。参加者・ホスト・管理者のみ（UNO の終了ボタンと同じ）。"""
        game = self.get_game(interaction.channel_id)
        if not game.is_running:
            embed = discord.Embed(description="このチャンネルで実行中のゲームはありません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if not can_end_game(game, interaction.user):
            embed = discord.Embed(description="人狼を終了できるのは参加者・ホスト・管理者だけです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        game.is_running = False
        jinrou_snapshot.clear_safely(game)
        game.silenced_players.clear()
        game.in_discussion = False
        if game.chairman_skip_event:
            game.chairman_skip_event.set()
        if game.chairman_vote_event:
            game.chairman_vote_event.set()
        embed = discord.Embed(description=f"<@{interaction.user.id}> さんがゲームを強制終了しました。", color=0xFFFFFF)
        await interaction.response.send_message(embed=embed)


    async def start_recruit(self, interaction: discord.Interaction, mode: str = "local"):
        """/game のハブから呼ぶ。このチャンネルで設定パネルを出す（mode は local / global）。"""
        await self.open_setup(interaction, mode if mode in ("local", "global") else "local")


    async def open_setup(self, interaction: discord.Interaction, mode: str = "local"):
        # 追加
        if mode == "global":
            game = self.games.get("global")
            if game and game.is_running:
                if all(c.id != interaction.channel.id for c in game.channels):
                    game.channels.append(interaction.channel)
                embed = discord.Embed(
                    title="グローバル人狼ゲーム（合流）",
                    description="既に他サーバーで起動中のグローバル人狼ゲームがあります。\n参加ボタンを押して合流してください。",
                    color=0xFFFFFF
                )
                await interaction.response.send_message(embed=embed, view=GlobalJoinView(self, game))
                return
            else:
                game = JinrouGame()
                self.games["global"] = game
                game.is_global = True
                game.channels = [interaction.channel]
                game._original_channel = interaction.channel
                game.game_channel = GlobalChannelProxy(game)
        else:
            game = self.get_game(interaction.channel_id)
            if game.is_running:
                embed = discord.Embed(description="このチャンネルでは既にゲームが進行中です。", color=0xFFFFFF)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            game._original_channel = interaction.channel
            game.game_channel = interaction.channel

        # 前のゲームの状態（yandere_targets・mokumoku_turns なども含む）をすべて初期化する
        game.reset_for_new_game()
        game.is_running = True
        game.host_id = interaction.user.id

        embed = discord.Embed(
            title="人狼ゲーム設定",
            description="必須役職・除外役職を設定してください。（各最大4つ）\n設定後「確定してパネルを送信」を押してください。",
            color=0xFFFFFF
        )
        await interaction.response.send_message(
            embed=embed,
            view=SetupView(game, self, game.game_channel),
            ephemeral=True
        )


    async def run_from_hub(self, game: JinrouGame, channel, host_id: int = None):
        """play.py から create_task で呼ぶ。60秒待機してゲームループを開始する。"""
        if host_id:
            game.host_id = host_id
        await asyncio.sleep(60)
        if not game.is_running:
            return
        await self._start_game_loop(game, channel)
