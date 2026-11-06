# -*- coding: utf-8 -*-
"""お題しりとり: お題に合う言葉だけでしりとりをつなぐ、チャンネルで遊ぶ短いパーティーゲーム。

- スラッシュコマンドは増やさず、/game の「お題しりとり」から募集する（GameHub が start_recruit を呼ぶ）。
- 状態はチャンネルごとに ``self.games[channel_id]`` に持ち、終わったら必ず消す。
- 勝利数は core/party_ranking.py 経由で Supabase の party_game_record_win に送る
  （関数が無いときはメモリだけで数える）。

判定のしくみ（純粋関数は Discord に依存しないので単体テストできる）:
- 答えはひらがな・カタカナだけ（漢字は読みが決められないため受け付けない）。
- ``normalize``: カタカナ→ひらがな、小書き文字→大きい文字（ゃ→や、っ→つ）、
  長音「ー」→直前の文字の母音（「らーめん」→「らあめん」）。
- しりとりのつながりは濁点・半濁点をゆるく見る（「か」「が」は同じ扱い）。
  末尾の「ー」は母音にしてから比べる（「すきー」の次は「い」から）。
- 脱落: 「ん」で終わる／同じ言葉をもう一度言う／制限時間切れ／お題に合わないと投票で判定される。
- お題の判定: 答えのあと、ほかの生存者が「OK」「NG」ボタンで投票（10秒）。
  NG が OK より多いときだけ脱落。同数・無投票はセーフ。
"""
import asyncio
import logging
import random
import unicodedata

import discord
from core import game_panels, game_restore
from core.messages import recruit_join_prompt
from discord.ext import commands

from core import party_ranking
from core.emojis import CROCK, FAILED

logger = logging.getLogger(__name__)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 60
TURN_SECONDS = 20
VOTE_SECONDS = 10
MIN_PLAYERS = 3
MAX_PLAYERS = 8

TOPICS = {
    "食べ物": ["りんご", "すし"],
    "動物": ["ねこ", "いぬ"],
    "国・都市": ["いたりあ", "ぱり"],
    "スポーツ": ["さっかー", "てにす"],
    "乗り物": ["くるま", "でんしゃ"],
    "職業": ["いしゃ", "けいさつ"],
    "植物": ["さくら", "ひまわり"],
    "学校にあるもの": ["ちょーく", "つくえ"],
    "家にあるもの": ["てれび", "れいぞうこ"],
    "色": ["あか", "みどり"],
}

SMALL = str.maketrans("ぁぃぅぇぉっゃゅょゎゕゖ", "あいうえおつやゆよわかけ")
VOWELS = {}
for _vowel, _row in (("あ", "あかさたなはまやらわがざだばぱ"), ("い", "いきしちにひみりぎじぢびぴ"),
                     ("う", "うくすつぬふむゆるぐずづぶぷゔ"), ("え", "えけせてねへめれげぜでべぺ"),
                     ("お", "おこそとのほもよろをごぞどぼぽ")):
    for _c in _row:
        VOWELS[_c] = _vowel


def to_hiragana(text: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def is_kana_word(text: str) -> bool:
    """ひらがな・カタカナ（と「ー」）だけでできた 2 文字以上の言葉か。"""
    t = to_hiragana((text or "").strip())
    return len(t) >= 2 and all(("ぁ" <= c <= "ゖ") or c == "ー" for c in t)


def normalize(text: str) -> str:
    """カタカナ→ひらがな、小書き→大きい文字、「ー」→直前の母音。"""
    out = []
    for c in to_hiragana((text or "").strip()).translate(SMALL):
        if c == "ー":
            if out and out[-1] in VOWELS:
                out.append(VOWELS[out[-1]])
            elif out:
                out.append(out[-1])  # 「ん」「ー」の後などは直前の文字をそのまま伸ばす
            continue
        out.append(c)
    return "".join(out)


def loose(c: str) -> str:
    """濁点・半濁点を外す（が→か、ぱ→は）。"""
    return unicodedata.normalize("NFC", "".join(
        ch for ch in unicodedata.normalize("NFD", c) if ch not in ("\u3099", "\u309a")))


def first_kana(word: str) -> str:
    return loose(normalize(word)[:1])


def last_kana(word: str) -> str:
    return loose(normalize(word)[-1:])


def check_answer(prev, word: str, used) -> tuple:
    """答えを判定する。(結果, 理由) を返す。

    結果: "ok"（つながった）／"retry"（数えずに言い直し）／"out"（脱落）。
    """
    if not is_kana_word(word):
        return "retry", "ひらがなかカタカナの2文字以上で答えてください。"
    norm = normalize(word)
    if prev is not None and first_kana(word) != last_kana(prev):
        return "retry", f"「{last_kana(prev)}」から始まる言葉で答えてください。"
    if norm in used:
        return "out", "同じ言葉がもう出ています"
    if norm.endswith("ん"):
        return "out", "「ん」で終わりました"
    return "ok", ""


class ShiritoriGame:
    def __init__(self, channel_id: int, guild_id: int, host_id: int):
        self.channel_id = channel_id
        self.guild_id = guild_id
        self.host_id = host_id
        self.players: dict = {}      # user_id -> member（参加順＝手番の順）
        self.out: list = []          # 脱落した user_id（順番）
        self.phase = "recruit"       # recruit / playing / done
        self.topic = None
        self.last_word = None        # 直前に通った言葉
        self.used: set = set()       # 正規化した言葉
        self.history: list = []      # (user_id, 言葉)
        self.turn_index = 0
        self.current = None          # 手番の user_id
        self.answer = None           # 手番の人が出した言葉（受付後）

    @property
    def alive(self):
        return [uid for uid in self.players if uid not in self.out]

    def next_player(self):
        alive = self.alive
        if not alive:
            return None
        uid = alive[self.turn_index % len(alive)]
        return uid

    def eliminate(self, uid):
        """手番の人を脱落させる。次の人が同じ添字に来るので turn_index は進めない。"""
        alive = self.alive
        idx = alive.index(uid)
        self.out.append(uid)
        if idx < self.turn_index % len(alive):
            self.turn_index -= 1
        remaining = len(self.alive)
        if remaining:
            self.turn_index %= remaining

    def accept(self, uid, word):
        """言葉を通して手番を進める。"""
        self.last_word = word
        self.used.add(normalize(word))
        self.history.append((uid, word))
        self.turn_index = (self.alive.index(uid) + 1) % len(self.alive)


def topic_verdict(ok_votes: int, ng_votes: int) -> bool:
    """お題に合っているか。NG が OK より多いときだけ False（同数・無投票はセーフ）。"""
    return ng_votes <= ok_votes


class JoinView(discord.ui.View):
    def __init__(self, cog, game: ShiritoriGame):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.cog, self.game = cog, game

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "recruit":
            return await interaction.response.send_message("募集は終わりました。", ephemeral=True)
        if interaction.user.id in g.players:
            return await interaction.response.send_message("もう参加しています。", ephemeral=True)
        if len(g.players) >= MAX_PLAYERS:
            return await interaction.response.send_message(f"定員（{MAX_PLAYERS}人）に達しました。", ephemeral=True)
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message(f"参加しました（{len(g.players)}人）。")

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "recruit" or interaction.user.id not in g.players:
            return await interaction.response.send_message("抜けられる募集がありません。", ephemeral=True)
        if interaction.user.id == g.host_id:
            return await interaction.response.send_message("募集した人は抜けられません。", ephemeral=True)
        del g.players[interaction.user.id]
        await interaction.response.send_message("参加をやめました。")


class VoteView(discord.ui.View):
    """お題に合っているかの投票。答えた本人と脱落者は投票できない。"""
    def __init__(self, game: ShiritoriGame, answerer: int):
        super().__init__(timeout=VOTE_SECONDS + 30)
        self.game, self.answerer = game, answerer
        self.votes: dict = {}   # user_id -> True(OK)/False(NG)

    @property
    def voters(self):
        return [uid for uid in self.game.alive if uid != self.answerer]

    def tally(self):
        ok = sum(1 for v in self.votes.values() if v)
        return ok, len(self.votes) - ok

    async def _vote(self, interaction, value: bool):
        if interaction.user.id not in self.voters:
            return await interaction.response.send_message("投票できるのは、答えた人以外の生存者だけです。", ephemeral=True)
        self.votes[interaction.user.id] = value
        await interaction.response.send_message("投票しました（変更もできます）。")

    @discord.ui.button(label="OK", style=discord.ButtonStyle.success)
    async def vote_ok(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._vote(interaction, True)

    @discord.ui.button(label="NG（お題に合わない）", style=discord.ButtonStyle.danger)
    async def vote_ng(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._vote(interaction, False)


class OdaiShiritori(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> ShiritoriGame
        self.wins: dict = {}    # guild_id -> {user_id: 勝利数}（メモリのみ）

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既にお題しりとりが進行中です。", color=COLOR),
                ephemeral=True)
        g = ShiritoriGame(channel.id, interaction.guild_id, interaction.user.id)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"お題しりとりの募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            embed = discord.Embed(
                title="お題しりとり 参加者募集",
                description=(f"{interaction.user.mention} さんが募集中です。\n"
                             f"{recruit_join_prompt(RECRUIT_SECONDS)}（{MIN_PLAYERS}〜{MAX_PLAYERS}人）。"),
                color=COLOR)
            await game_panels.replace(channel, "party", embed=embed, view=JoinView(self, g))
            await asyncio.sleep(RECRUIT_SECONDS)
            if len(g.players) < MIN_PLAYERS:
                return await channel.send(embed=discord.Embed(
                    description=f"人数不足のため中止しました（{len(g.players)}人／{MIN_PLAYERS}人以上必要）。", color=COLOR))
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    async def run_game(self, channel, g: ShiritoriGame, rng=random):
        g.topic = rng.choice(list(TOPICS))
        g.last_word = rng.choice(TOPICS[g.topic])
        g.used.add(normalize(g.last_word))
        g.phase = "playing"
        order = " → ".join(m.display_name for m in g.players.values())
        await channel.send(embed=discord.Embed(
            title="お題しりとり スタート！",
            description=(f"お題: **{g.topic}**\n順番: {order}\n\n"
                         f"最初の言葉は「**{g.last_word}**」。次の人は「**{last_kana(g.last_word)}**」から！\n"
                         f"自分の番になったら{TURN_SECONDS}秒以内に、ひらがなかカタカナでチャンネルに書いてください。\n"
                         "「ん」で終わる・同じ言葉・時間切れ・お題に合わない（投票）で脱落。最後の1人が勝ち！"),
            color=COLOR))
        await self._play_loop(channel, g)
        await self.finish(channel, g)

    async def _play_loop(self, channel, g: ShiritoriGame):
        while len(g.alive) > 1:
            await self.play_turn(channel, g)

    async def play_turn(self, channel, g: ShiritoriGame):
        # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
        self._save_snapshot(g)
        uid = g.next_player()
        g.current, g.answer = uid, None
        member = g.players[uid]
        await channel.send(embed=discord.Embed(
            description=f"▶ {member.mention} さんの番です。「**{last_kana(g.last_word)}**」から（{TURN_SECONDS}秒）",
            color=COLOR))
        elapsed = 0
        while g.answer is None and elapsed < TURN_SECONDS and g.phase == "playing":
            await asyncio.sleep(1)
            elapsed += 1
        g.current = None
        if g.answer is None:
            g.eliminate(uid)
            return await channel.send(embed=discord.Embed(
                description=f"{CROCK} {member.mention} さんは時間切れで脱落です。（残り {len(g.alive)}人）", color=COLOR))
        word = g.answer
        result, reason = check_answer(g.last_word, word, g.used)
        if result == "out":
            g.eliminate(uid)
            return await channel.send(embed=discord.Embed(
                description=f"💥 {member.mention} さんの「{word}」は{reason}。脱落です。（残り {len(g.alive)}人）",
                color=COLOR))
        if not await self.topic_vote(channel, g, uid, word):
            g.eliminate(uid)
            return await channel.send(embed=discord.Embed(
                description=f"🙅 「{word}」はお題「{g.topic}」に合わないと判定されました。{member.mention} さんは脱落です。"
                            f"（残り {len(g.alive)}人）",
                color=COLOR))
        g.accept(uid, word)

    async def topic_vote(self, channel, g: ShiritoriGame, uid: int, word: str) -> bool:
        view = VoteView(g, uid)
        await game_panels.replace(channel, "party", embed=discord.Embed(
            description=(f"「**{word}**」はお題「{g.topic}」に合っていますか？\n"
                         f"答えた人以外が{VOTE_SECONDS}秒以内に投票（NG が OK より多いと脱落。同数・無投票はセーフ）"),
            color=COLOR), view=view)
        elapsed = 0
        while elapsed < VOTE_SECONDS and len(view.votes) < len(view.voters):
            await asyncio.sleep(1)
            elapsed += 1
        view.stop()
        return topic_verdict(*view.tally())

    async def finish(self, channel, g: ShiritoriGame):
        g.phase = "done"
        winners = g.alive
        board = self.wins.setdefault(g.guild_id, {})
        for uid in winners:
            board[uid] = board.get(uid, 0) + 1
            await party_ranking.shared().record_win(g.guild_id, uid, "shiritori")
        chain = " → ".join(w for _, w in g.history) or "（なし）"
        win_text = "、".join(g.players[uid].mention for uid in winners) or "なし"
        embed = discord.Embed(title="お題しりとり 終了", description=f"🏆 勝者: {win_text}", color=COLOR)
        embed.add_field(name=f"つながった言葉（お題: {g.topic}）", value=chain[:1024], inline=False)
        await channel.send(embed=embed)

    # ------------------------------------------------------------------
    # 再起動復旧（core/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g: ShiritoriGame) -> None:
        if g.phase != "playing":
            return
        state = {
            "host_id": g.host_id,
            "players": [
                [uid, game_restore.member_ref(m) if m is not None else None]
                for uid, m in g.players.items()
            ],
            "out": list(g.out),
            "topic": g.topic,
            "last_word": g.last_word,
            "used": sorted(g.used),
            "history": [[uid, word] for uid, word in g.history],
            "turn_index": g.turn_index,
        }
        game_restore.save_session("shiritori", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("shiritori", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だったお題しりとりを、手番の開始時点から再開する。"""
        entries = game_restore.session_entries("shiritori")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: お題しりとりの復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("shiritori", channel_id)
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
        g = ShiritoriGame(channel_id, guild_id, state.get("host_id"))
        players = {}
        for uid, ref in state["players"]:
            uid = int(uid)
            players[uid] = None if ref is None else game_restore.resolve_member(
                guild, ref.get("id"), ref.get("name"))
        if len(players) < 2:
            return False
        g.players = players
        g.out = [int(u) for u in state.get("out") or []]
        g.topic = state.get("topic")
        g.last_word = state.get("last_word")
        g.used = set(state.get("used") or [])
        g.history = [(int(uid), word) for uid, word in state.get("history") or []]
        g.turn_index = int(state.get("turn_index") or 0)
        g.current = None
        g.answer = None
        g.phase = "playing"
        if len(g.alive) <= 1:
            return False
        self.games[channel_id] = g
        asyncio.create_task(self._run_restored_session(channel, g))
        return True

    async def _run_restored_session(self, channel, g: ShiritoriGame):
        try:
            await self._play_loop(channel, g)
            await self.finish(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧したお題しりとりの進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)

    async def handle_message(self, message) -> bool:
        """手番の人の発言を答えとして受け付ける。受け付けたら True。"""
        g = self.games.get(getattr(message.channel, "id", None))
        if g is None or g.phase != "playing" or g.current is None or g.answer is not None:
            return False
        if message.author.id != g.current:
            return False
        word = (message.content or "").strip()
        result, reason = check_answer(g.last_word, word, g.used)
        if result == "retry":
            await message.channel.send(embed=discord.Embed(description=f"{FAILED} {reason}（言い直せます）", color=COLOR))
            return False
        g.answer = word
        return True

    @commands.Cog.listener()
    async def on_message(self, message):
        if getattr(message.author, "bot", False):
            return
        await self.handle_message(message)


async def setup(bot):
    await bot.add_cog(OdaiShiritori(bot))
