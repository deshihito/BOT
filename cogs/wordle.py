# -*- coding: utf-8 -*-
"""Wordle（英語版）: 5 文字の英単語を 6 回以内で当てる。

- スラッシュコマンドは増やさず、/game の「Wordle」から始める（GameHub が start_recruit を呼ぶ）。
- モード: "shared"（みんなで）＝チャンネルのだれでも推理でき、6 回はみんなで共有。当てた人の勝ち。
          "solo"（ひとりで）＝始めた人だけが推理できる。
- 推理は盤面の「推理する」ボタン → モーダルに 5 文字を入力。単語リストに無い言葉は回数に数えない。
- 判定: <:g_:1563559471048032376> 位置も文字も合う／<:y_:1563559481768411257> 文字はあるが位置が違う／<:b_:1563559473422016512> 無い。
  同じ文字が複数あるときは、まず <:g_:1563559471048032376> を確定させ、残りの数だけ左から <:y_:1563559481768411257> にする（本家と同じ）。
- 単語リストは Assets/wordle/answers.txt（答え）と allowed.txt（答え以外に推理で使える言葉）。
- 勝利数は core/party_ranking.py に記録する。手番の時間切れは無いので、放置対策（autoplay）はつながない。
"""
import asyncio
import logging
import random
import time
from pathlib import Path

import discord
from core import game_panels, game_restore
from discord.ext import commands

from core import party_ranking

logger = logging.getLogger(__name__)

GAME_ID = "wordle"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
WORD_LEN = 5
MAX_GUESSES = 6
GAME_SECONDS = 600
MODES = (("shared", "みんなで（チャンネルの全員で推理）"), ("solo", "ひとりで（始めた人だけ）"))

DATA_DIR = Path(__file__).resolve().parents[1] / "Assets" / "wordle"
GREEN, YELLOW, GRAY = "<:g_:1563559471048032376>", "<:y_:1563559481768411257>", "<:b_:1563559473422016512>"


def _load(name: str) -> list:
    path = DATA_DIR / name
    return [w.strip().lower() for w in path.read_text(encoding="utf-8").split()
            if len(w.strip()) == WORD_LEN and w.strip().isalpha()]


ANSWERS = _load("answers.txt")
VALID = set(ANSWERS) | set(_load("allowed.txt"))


def score(guess: str, answer: str) -> list:
    """推理の色を返す（GREEN / YELLOW / GRAY の 5 つのリスト）。重複文字も本家どおり。"""
    guess, answer = guess.lower(), answer.lower()
    result = [GRAY] * WORD_LEN
    left = {}
    for i, (g, a) in enumerate(zip(guess, answer)):
        if g == a:
            result[i] = GREEN
        else:
            left[a] = left.get(a, 0) + 1
    for i, g in enumerate(guess):
        if result[i] != GREEN and left.get(g, 0) > 0:
            result[i] = YELLOW
            left[g] -= 1
    return result


def check_guess(word: str):
    """(正規化した言葉, エラー文) を返す。問題なければエラー文は None。"""
    w = (word or "").strip().lower()
    if len(w) != WORD_LEN or not w.isascii() or not w.isalpha():
        return w, f"英字{WORD_LEN}文字で入力してください。"
    if w not in VALID:
        return w, f"「{w.upper()}」は単語リストにありません（回数には数えません）。"
    return w, None


class WordleGame:
    def __init__(self, channel_id, guild_id, host, answer: str, mode: str = "shared"):
        self.channel_id, self.guild_id = channel_id, guild_id
        self.host = host
        self.answer = answer
        self.mode = mode
        self.guesses: list = []      # (user, word, colors)
        self.winner = None
        self.phase = "playing"       # playing / done
        self.message = None
        self.finished = asyncio.Event()
        self.started_at = time.time()  # 制限時間（GAME_SECONDS）の起点。再起動復旧でも使う

    def can_guess(self, user_id) -> bool:
        return self.mode == "shared" or user_id == self.host.id

    @property
    def over(self) -> bool:
        return self.winner is not None or len(self.guesses) >= MAX_GUESSES

    def letter_status(self) -> dict:
        status = {}
        rank = {GRAY: 0, YELLOW: 1, GREEN: 2}
        for _, word, colors in self.guesses:
            for c, col in zip(word, colors):
                if c not in status or rank[col] > rank[status[c]]:
                    status[c] = col
        return status

    def board_embed(self, reveal: bool = False) -> discord.Embed:
        mode = "みんなで" if self.mode == "shared" else f"ひとりで（{self.host.display_name}）"
        lines = [f"{''.join(cols)}　`{w.upper()}`　{getattr(u, 'display_name', '')}" for u, w, cols in self.guesses]
        lines += ["⬜⬜⬜⬜⬜"] * (MAX_GUESSES - len(self.guesses))
        embed = discord.Embed(title=f"Wordle（{mode}）", description="\n".join(lines), color=COLOR)
        st = self.letter_status()
        used = " ".join(f"{c.upper()}{st[c]}" for c in sorted(st)) or "まだありません"
        embed.add_field(name="使った文字", value=used[:1024], inline=False)
        if reveal:
            embed.add_field(name="答え", value=f"**{self.answer.upper()}**", inline=False)
        else:
            embed.set_footer(text=f"「推理する」で英単語5文字を入力（残り {MAX_GUESSES - len(self.guesses)} 回）")
        return embed


class GuessModal(discord.ui.Modal, title="Wordle: 5文字の英単語"):
    word = discord.ui.TextInput(label="推理する単語", min_length=WORD_LEN, max_length=WORD_LEN, placeholder="crane")

    def __init__(self, cog, game: WordleGame):
        super().__init__()
        self.cog, self.game = cog, game

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.submit_guess(interaction, self.game, self.word.value)


class BoardView(discord.ui.View):
    def __init__(self, cog, game: WordleGame):
        super().__init__(timeout=GAME_SECONDS + 60)
        self.cog, self.game = cog, game

    @discord.ui.button(label="推理する", style=discord.ButtonStyle.success)
    async def guess(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "playing":
            return await interaction.response.send_message("このゲームは終わりました。", ephemeral=True)
        if not g.can_guess(interaction.user.id):
            return await interaction.response.send_message("ひとりで モードなので、始めた人だけが推理できます。",
                                                           ephemeral=True)
        await interaction.response.send_modal(GuessModal(self.cog, g))

    @discord.ui.button(label="ギブアップ", style=discord.ButtonStyle.secondary)
    async def give_up(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "playing" or interaction.user.id != g.host.id:
            return await interaction.response.send_message("ギブアップできるのは始めた人だけです。", ephemeral=True)
        await interaction.response.send_message("ギブアップしました。", ephemeral=True)
        g.finished.set()


class Wordle(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> WordleGame

    async def start_recruit(self, interaction: discord.Interaction, mode: str = "shared", rng=random):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既に Wordle が進行中です。", color=COLOR),
                ephemeral=True)
        mode = mode if mode in dict(MODES) else "shared"
        g = WordleGame(channel.id, interaction.guild_id, interaction.user, rng.choice(ANSWERS), mode)
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description="Wordle を始めました。", color=COLOR), ephemeral=True)
        try:
            g.message = await game_panels.replace(channel, "party", embed=g.board_embed(), view=BoardView(self, g))
            self._save_snapshot(g)
            await self._watch(channel, g, GAME_SECONDS)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    async def _watch(self, channel, g: WordleGame, timeout):
        """終了イベントか制限時間を待ち、来たら finish する（開始・復旧の共通経路）。"""
        try:
            await asyncio.wait_for(g.finished.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        await self.finish(channel, g)

    async def submit_guess(self, interaction: discord.Interaction, g: WordleGame, word: str):
        if g.phase != "playing" or g.over:
            return await interaction.response.send_message("このゲームは終わりました。", ephemeral=True)
        if not g.can_guess(interaction.user.id):
            return await interaction.response.send_message("ひとりで モードなので、始めた人だけが推理できます。",
                                                           ephemeral=True)
        w, error = check_guess(word)
        if error:
            return await interaction.response.send_message(error, ephemeral=True)
        colors = score(w, g.answer)
        g.guesses.append((interaction.user, w, colors))
        if w == g.answer:
            g.winner = interaction.user
        self._save_snapshot(g)
        await interaction.response.send_message(f"{''.join(colors)} `{w.upper()}`", ephemeral=True)
        if g.message is not None:
            await g.message.edit(embed=g.board_embed())
        if g.over:
            g.finished.set()

    # ------------------------------------------------------------------
    # 再起動復旧（core/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g: WordleGame) -> None:
        if g.phase != "playing" or g.winner is not None:
            return
        state = {
            "host": game_restore.member_ref(g.host),
            "answer": g.answer,
            "mode": g.mode,
            "guesses": [
                [game_restore.member_ref(u), word, list(colors)]
                for u, word, colors in g.guesses
            ],
            "message_id": getattr(g.message, "id", None),
            "started_at": g.started_at,
        }
        game_restore.save_session("wordle", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("wordle", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だった Wordle を、残り時間つきで再開する。"""
        entries = game_restore.session_entries("wordle")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: Wordle の復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("wordle", channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.games:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        guild = getattr(channel, "guild", None)
        guild_id = entry.get("guild_id") or getattr(guild, "id", None)
        host_ref = state.get("host") or {}
        host = game_restore.resolve_member(guild, host_ref.get("id"), host_ref.get("name"))
        answer = state.get("answer")
        if not answer:
            return False
        g = WordleGame(channel_id, guild_id, host, answer,
                       state.get("mode") or "shared")
        guesses = []
        for ref, word, colors in state.get("guesses") or []:
            user = game_restore.resolve_member(guild, ref.get("id"), ref.get("name"))
            guesses.append((user, word, list(colors)))
        if len(guesses) >= MAX_GUESSES:
            return False
        g.guesses = guesses
        started_at = state.get("started_at")
        if isinstance(started_at, (int, float)):
            g.started_at = float(started_at)
        message_id = state.get("message_id")
        fetch = getattr(channel, "fetch_message", None)
        if message_id and callable(fetch):
            try:
                g.message = await fetch(message_id)
            except Exception:
                g.message = None
        self.games[channel_id] = g
        if g.message is not None:
            # 既存の盤面メッセージへ新しい View を付け直して復活させる
            await g.message.edit(embed=g.board_embed(), view=BoardView(self, g))
        else:
            g.message = await game_panels.replace(
                channel, "party", embed=g.board_embed(), view=BoardView(self, g))
        remaining = GAME_SECONDS - (time.time() - g.started_at)
        asyncio.create_task(self._run_restored_session(channel, g, max(0.0, remaining)))
        return True

    async def _run_restored_session(self, channel, g: WordleGame, timeout):
        try:
            await self._watch(channel, g, timeout)
        except Exception:
            logger.exception("channel %s: 復旧した Wordle の進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)

    async def finish(self, channel, g: WordleGame):
        g.phase = "done"
        self._clear_snapshot(g.channel_id)
        if g.message is not None:
            await g.message.edit(embed=g.board_embed(reveal=True), view=None)
        if g.winner is not None:
            await party_ranking.shared().record_win(g.guild_id, g.winner.id, GAME_ID)
            text = f"🏆 {g.winner.mention} さんが {len(g.guesses)}/{MAX_GUESSES} で正解！"
        else:
            text = "正解できませんでした。"
        await channel.send(embed=discord.Embed(
            title="Wordle 終了", description=f"{text}\n答え: **{g.answer.upper()}**", color=COLOR))


async def setup(bot):
    await bot.add_cog(Wordle(bot))
