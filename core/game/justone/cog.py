# -*- coding: utf-8 -*-
"""「ひとことヒント」（Just One 系の協力ワードゲーム）。

盤面表現: お題・ヒントはテキスト情報のみで盤面性が無いため、V2 Container の
構造化テキストで表示する（画像化は更新頻度に見合わない。判断は実装ログ参照）。
秘匿: お題は回答者以外にだけ ephemeral で見せ、ヒント提出はモーダル。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core.game.game import game_records
from core.game.game.game_v2 import GamePanelView, text_panel, lobby_auto_start_text, lobby_not_enough_text
from core.game.justone.justone import ROUNDS_DEFAULT, WORDS, JustOneSession

logger = logging.getLogger(__name__)

GAME_ID = "justone"
RECRUIT_SECONDS = 60
HINT_SECONDS = 60
GUESS_SECONDS = 60
MIN_PLAYERS = 3
MAX_PLAYERS = 8


class HintModal(discord.ui.Modal, title="ヒントを出す（1単語だけ）"):
    hint = discord.ui.TextInput(label="ヒント（空白なし・1単語）", max_length=30)

    def __init__(self, cog, session: JustOneSession):
        super().__init__()
        self.cog = cog
        self.session = session

    async def on_submit(self, interaction: discord.Interaction):
        if self.session.submit_hint(interaction.user.id, str(self.hint.value)):
            await interaction.response.send_message("ヒントを受け付けました。", ephemeral=True)
            await self.cog.maybe_reveal(interaction.channel.id)
        else:
            await interaction.response.send_message(
                "受け付けできませんでした（空白を含む・回答者・提出済みのいずれか）。", ephemeral=True)


class GuessModal(discord.ui.Modal, title="お題を当てる"):
    answer = discord.ui.TextInput(label="お題だと思う答え", max_length=30)

    def __init__(self, cog, session: JustOneSession):
        super().__init__()
        self.cog = cog
        self.session = session

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.apply_guess(interaction, self.session, str(self.answer.value))


class JustOne(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, JustOneSession] = {}
        self.messages: dict[int, discord.Message] = {}
        self.revealed: set[int] = set()

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None  # 募集中の目印
        players = [interaction.user.id]
        state = {"started": False}

        def lobby_body(members):
            return (f"ヒントが他の人と被ると消えてしまう協力ワードゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                    f"{lobby_auto_start_text(RECRUIT_SECONDS)}\n"
                    + (f"参加者: <@{members[0]}>" if len(members) == 1 else
                       f"参加者（{len(members)}名）: " + " ".join(f"<@{p}>" for p in members)))

        panel = GamePanelView("🤝 ひとことヒント 参加者募集", lobby_body(players),
                              timeout=RECRUIT_SECONDS + 30)

        async def on_join(inter: discord.Interaction):
            if state["started"] or state.get("closed"):
                return await inter.response.send_message("募集は終了しました。", ephemeral=True)
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=lobby_body(players))
            await inter.response.edit_message(view=panel)

        async def on_start(inter: discord.Interaction):
            if state.get("closed"):
                return await inter.response.send_message("募集は終了しました。", ephemeral=True)
            if inter.user.id != players[0]:
                return await inter.response.send_message("開始できるのはホストだけです。", ephemeral=True)
            state["started"] = True
            await inter.response.send_message("開始します！", ephemeral=True)

        join_btn = discord.ui.Button(label="参加する", style=discord.ButtonStyle.success)
        join_btn.callback = on_join
        start_btn = discord.ui.Button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
        start_btn.callback = on_start
        panel.add_row(join_btn, start_btn)
        await interaction.response.send_message(view=panel)
        asyncio.create_task(self._run(channel, players, state))

    async def _run(self, channel, players: list[int], state: dict):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if state["started"]:
                    break
                await asyncio.sleep(0.5)
            state["closed"] = True
            players = list(dict.fromkeys(players))
            if len(players) < MIN_PLAYERS:
                await channel.send(view=text_panel("ひとことヒント", f"{lobby_not_enough_text(MIN_PLAYERS)}"))
                return
            words = random.sample(WORDS, ROUNDS_DEFAULT)
            session = JustOneSession(players, words)
            self.channels[channel.id] = session
            await self._play(channel, session)
        except Exception:  # noqa: BLE001
            logger.exception("JustOne: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)
            self.revealed.discard(channel.id)

    # ------------------------------------------------------------------ 進行
    async def _play(self, channel, session: JustOneSession):
        while True:
            word = session.next_round()
            if word is None:
                break
            self.revealed.discard(channel.id)
            await self._round_panel(channel, session)
            for _ in range(HINT_SECONDS * 2):
                if session.all_hints_in():
                    break
                await asyncio.sleep(0.5)
            await self.maybe_reveal(channel.id, force=True)
            # 回答フェーズ（GUESS_SECONDS 待つ。回答が来たら apply_guess が進める）
            for _ in range(GUESS_SECONDS * 2):
                if session.guess is not None:
                    break
                await asyncio.sleep(0.5)
            if session.guess is None:
                session.guess = "（無回答）"
                await self._announce_result(channel, session, ok=False, timeout=True)
        rows = session.successes
        await channel.send(view=text_panel(
            "🏆 ひとことヒント 結果",
            f"チームの成績: **{rows} / {len(session.words)} 問成功**\n"
            + "参加者: " + " ".join(f"<@{p}>" for p in session.players)))
        for uid in session.players:
            game_records.record_justone_safely(uid, rows)

    async def _round_panel(self, channel, session: JustOneSession):
        number = session.round_index + 1
        panel = GamePanelView(
            f"第{number}ラウンド / {len(session.words)}",
            f"回答者は <@{session.guesser}> です。\n"
            f"回答者以外の人は「お題を見る」でお題を確認し、「ヒントを出す」から1単語のヒントを入力してください（{HINT_SECONDS}秒）。\n"
            "ヒントが他の人と完全に同じだと、そのヒントは消えてしまいます。")

        async def on_show(inter: discord.Interaction):
            if inter.user.id == session.guesser:
                return await inter.response.send_message("あなたは回答者です。お題は見られません。", ephemeral=True)
            if inter.user.id not in session.players:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            await inter.response.send_message(view=GamePanelView("お題", f"お題は **{session.word}** です。"), ephemeral=True)

        async def on_hint(inter: discord.Interaction):
            if inter.user.id == session.guesser or inter.user.id not in session.players:
                return await inter.response.send_message("ヒントを出せるのは回答者以外の参加者だけです。", ephemeral=True)
            if inter.user.id in session.hints:
                return await inter.response.send_message("すでにヒント済みです。", ephemeral=True)
            await inter.response.send_modal(HintModal(self, session))

        show_btn = discord.ui.Button(label="お題を見る", style=discord.ButtonStyle.secondary)
        show_btn.callback = on_show
        hint_btn = discord.ui.Button(label="ヒントを出す", style=discord.ButtonStyle.primary)
        hint_btn.callback = on_hint
        panel.add_row(show_btn, hint_btn)
        msg = await channel.send(view=panel)
        self.messages[channel.id] = msg

    async def maybe_reveal(self, channel_id: int, force: bool = False):
        session = self.channels.get(channel_id)
        if session is None or channel_id in self.revealed:
            return
        if not force and not session.all_hints_in():
            return
        self.revealed.add(channel_id)
        channel = self.messages.get(channel_id)
        if channel is None:
            return
        kept, removed = session.kept_hints()
        lines = [f"提出されたヒント: {len(session.hints)}件"]
        if removed:
            lines.append("重複で消えたヒント: " + "、".join(f"「{h}」" for h in removed))
        if kept:
            lines.append("残ったヒント: " + " ".join(f"「{h}」" for h in kept.values()))
        else:
            lines.append("残ったヒントはありません…！")
        lines.append(f"<@{session.guesser}> さん、「回答する」からお題を当ててください（{GUESS_SECONDS}秒）。")
        panel = GamePanelView(f"第{session.round_index + 1}ラウンド ヒント公開", "\n".join(lines))

        async def on_guess(inter: discord.Interaction):
            if inter.user.id != session.guesser:
                return await inter.response.send_message("回答できるのは回答者だけです。", ephemeral=True)
            await inter.response.send_modal(GuessModal(self, session))

        guess_btn = discord.ui.Button(label="回答する", style=discord.ButtonStyle.success)
        guess_btn.callback = on_guess
        panel.add_row(guess_btn)
        msg = self.messages[channel_id]
        await msg.edit(view=panel)

    async def apply_guess(self, interaction: discord.Interaction, session: JustOneSession, text: str):
        if interaction.user.id != session.guesser or session.guess is not None:
            return await interaction.response.send_message("すでに回答済みです。", ephemeral=True)
        ok = session.answer(text)
        await interaction.response.send_message("回答を受け付けました。", ephemeral=True)
        await self._announce_result(interaction.channel, session, ok=ok)

    async def _announce_result(self, channel, session: JustOneSession, ok: bool, timeout: bool = False):
        head = "🎉 正解！" if ok else ("⏰ 時間切れ…" if timeout else "❌ 残念…")
        await channel.send(view=text_panel(
            f"第{session.round_index + 1}ラウンド 結果",
            f"{head} お題は **{session.word}**、回答は「{session.guess}」でした。\n"
            f"現在の成績: {session.successes}問成功"))
        await asyncio.sleep(2)


async def setup(bot):
    await bot.add_cog(JustOne(bot))
