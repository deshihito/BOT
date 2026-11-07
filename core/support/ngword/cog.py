# -*- coding: utf-8 -*-
"""NGワード: 自分だけ知らない「NGワード」を言ったら脱落する、チャンネルで遊ぶ短いパーティーゲーム。

- スラッシュコマンドは増やさず、/game の「NGワード」から募集する（GameHub が start_recruit を呼ぶ）。
- 状態はチャンネルごとに ``self.games[channel_id]`` に持ち、終わったら必ず消す。
- 勝利数は core/game/game/party_ranking.py 経由で Supabase の party_game_record_win に送る。
  関数がまだ無いときはメモリだけで数える（Bot を再起動すると消える）。
"""
import asyncio
import random

import discord
from core.game.game import game_panels
from core.game.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.support.messages import recruit_join_prompt
from discord.ext import commands

from core.game.game import party_ranking
COLOR = 0xFFFFFF
RECRUIT_SECONDS = 60
GAME_SECONDS = 180   # 既定（3分）。互換のため残す
MIN_PLAYERS = 3
MAX_PLAYERS = 8

NG_WORDS = [
    "うん", "ええ", "なるほど", "たしかに", "すごい", "やばい", "えっ", "まじ", "ほんと", "いいね",
    "わかる", "ありがとう", "ごめん", "おはよう", "おつかれ", "わたし", "ぼく", "なんで", "どう", "それ",
    "これ", "あれ", "ちょっと", "めっちゃ", "かわいい", "おいしい", "たのしい", "ねむい", "ゲーム", "今日",
    "明日", "好き", "笑", "w", "草", "はい", "いや", "でも", "だから", "とりあえず",
]


# 制限時間の選択肢（分）。/game の画面で選ぶ
TIME_CHOICES = (3, 5, 10)
DEFAULT_MINUTES = 3
MODES = {"word": "ワードモード", "char": "一文字モード"}

# 一文字モードの NG 文字。清音のひらがなから、
# - 会話でほぼ毎回出てしまう文字（の・は・に・て・た・い・か・し・る・と）
# - ほとんど出ない文字（ゐ・ゑ・を・ぬ・へ）と「ん」（単独で狙いにくく、文末で多すぎる）
# を外して、「気をつければ避けられるが、うっかり言う」くらいの 32 文字にした。
NG_CHARS = list("あうえおきくけこさすせそちつなねひふほまみむめもやゆよらりれろわ")

_SMALL = str.maketrans("ぁぃぅぇぉっゃゅょゎゕゖ", "あいうえおつやゆよわかけ")


def normalize_kana(text: str) -> str:
    """カタカナ→ひらがな、小書き文字→大きい文字（ゃ→や、ッ→つ）。濁点は残す（「か」と「が」は別の文字）。"""
    out = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in (text or ""))
    return out.translate(_SMALL)


def contains_ng_char(text: str, char: str) -> bool:
    """一文字モード: 正規化したメッセージに NG 文字が含まれるか。"""
    return normalize_kana(char) in normalize_kana(text)


def contains_ng(text: str, word: str) -> bool:
    """大文字小文字を区別せずに、メッセージに NG ワードが含まれるか。"""
    return word.lower() in (text or "").lower()


class NGGame:
    def __init__(self, channel_id: int, guild_id: int, host_id: int,
                 minutes: int = DEFAULT_MINUTES, mode: str = "word"):
        self.minutes = minutes if minutes in TIME_CHOICES else DEFAULT_MINUTES
        self.seconds = self.minutes * 60
        self.mode = mode if mode in MODES else "word"
        self.channel_id = channel_id
        self.guild_id = guild_id
        self.host_id = host_id
        self.players: dict = {}      # user_id -> member
        self.words: dict = {}        # user_id -> NG ワード
        self.out: list = []          # 脱落した user_id（順番）
        self.phase = "recruit"       # recruit / playing / done

    @property
    def alive(self):
        return [uid for uid in self.players if uid not in self.out]

    def hits(self, uid, text) -> bool:
        word = self.words[uid]
        return contains_ng_char(text, word) if self.mode == "char" else contains_ng(text, word)

    def deal(self, rng=random):
        pool = NG_CHARS if self.mode == "char" else NG_WORDS
        picked = rng.sample(pool, len(self.players))
        self.words = dict(zip(self.players, picked))


class PlayPanel(GamePanelView):
    """進行パネル（V2）。NGワード一覧は本人向け ephemeral で返す。"""

    def __init__(self, cog, game: NGGame, body: str = ""):
        super().__init__("NGワード スタート！", body, timeout=game.seconds + 30)
        self.cog, self.game = cog, game
        self.peek = discord.ui.Button(label="みんなのNGワードを見る", style=discord.ButtonStyle.primary)
        self.peek.callback = self._peek
        self.add_row(self.peek)

    async def _peek(self, interaction: discord.Interaction):
        g = self.game
        if interaction.user.id not in g.players:
            return await interaction.response.send_message("参加者だけが見られます。", ephemeral=True)
        lines = []
        for uid, member in g.players.items():
            if uid == interaction.user.id:
                lines.append(f"{member.display_name}（あなた）: ？？？")
            else:
                mark = "（脱落）" if uid in g.out else ""
                lines.append(f"{member.display_name}{mark}: **{g.words[uid]}**")
        embed = discord.Embed(title="みんなのNGワード", description="\n".join(lines), color=COLOR)
        embed.set_footer(text="自分のNGワードは見えません。相手に言わせるよう会話を誘導しましょう。")
        await interaction.response.send_message(embed=embed, ephemeral=True)


PlayView = PlayPanel  # 互換名


class NGWord(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> NGGame
        self.wins: dict = {}    # guild_id -> {user_id: 勝利数}（メモリのみ）

    async def start_recruit(self, interaction: discord.Interaction, minutes: int = DEFAULT_MINUTES, mode: str = "word"):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既にNGワードが進行中です。", color=COLOR), ephemeral=True)
        g = NGGame(channel.id, interaction.guild_id, interaction.user.id, minutes=minutes, mode=mode)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"NGワードの募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            lobby = LobbyView(
                title="NGワード 参加者募集", host=interaction.user,
                min_players=MIN_PLAYERS, max_players=MAX_PLAYERS,
                note=(f"{interaction.user.mention} さんが募集中です。（{MODES[g.mode]}・{g.minutes}分）\n"
                      f"{recruit_join_prompt(RECRUIT_SECONDS)}"),
                timeout=RECRUIT_SECONDS + 30)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            g.players = dict(lobby.members)
            if len(g.players) < MIN_PLAYERS:
                await game_panels.clear(channel, "party")
                return await channel.send(view=text_panel(
                    "", f"人数不足のため中止しました（{len(g.players)}人／{MIN_PLAYERS}人以上必要）。"))
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    async def run_game(self, channel, g: NGGame):
        g.deal()
        g.phase = "playing"
        names = "、".join(m.display_name for m in g.players.values())
        body = (f"参加者: {names}\n\n"
                + ("一文字モード: NGは **ひらがな1文字** です。カタカナ・小さい文字（ゃ・っ）も同じ文字として数えます。\n"
                   if g.mode == "char" else "") +
                "一人ひとりに、本人だけが知らないNGワードが付きました。\n"
                "ボタンで **自分以外の** NGワードを確認し、会話の中で相手に言わせましょう。\n"
                f"自分のNGワードを発言したら脱落です。制限時間は{g.minutes}分、最後まで残った人の勝ち！")
        await game_panels.replace(channel, "party", view=PlayPanel(self, g, body=body))
        elapsed = 0
        while elapsed < g.seconds and len(g.alive) > 1:
            await asyncio.sleep(1)
            elapsed += 1
            if elapsed % 60 == 0 and elapsed < g.seconds and len(g.alive) > 1:
                # 経過表示は次の表示で役割を終えるため、常に最新1通だけ残す。
                old = getattr(g, "last_notice", None)
                if old is not None:
                    await safe_delete(old)
                g.last_notice = await channel.send(view=text_panel(
                    "", f"残り{(g.seconds - elapsed) // 60}分（生存 {len(g.alive)}人）"))
        await self.finish(channel, g)

    async def finish(self, channel, g: NGGame):
        g.phase = "done"
        winners = g.alive
        board = self.wins.setdefault(g.guild_id, {})
        for uid in winners:
            board[uid] = board.get(uid, 0) + 1
            await party_ranking.shared().record_win(g.guild_id, uid, "ngword")
        reveal = "\n".join(f"{m.display_name}: {g.words.get(uid, '-')}" + ("（脱落）" if uid in g.out else "")
                           for uid, m in g.players.items())
        win_text = "、".join(g.players[uid].mention for uid in winners) or "なし"
        # 進行パネルと経過/脱落表示を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        old = getattr(g, "last_notice", None)
        if old is not None:
            g.last_notice = None
            await safe_delete(old)
        await channel.send(view=text_panel(
            "NGワード 終了",
            f"🏆 勝者: {win_text}\n\nNGワードの答え合わせ\n{reveal[:1024]}"))

    async def handle_message(self, message) -> bool:
        """進行中のゲームで、発言者が自分の NG ワードを言ったら脱落させる。脱落させたら True。"""
        g = self.games.get(getattr(message.channel, "id", None))
        if g is None or g.phase != "playing":
            return False
        uid = message.author.id
        if uid not in g.players or uid in g.out:
            return False
        word = g.words[uid]
        if not g.hits(uid, message.content):
            return False
        g.out.append(uid)
        # 脱落表示も経過表示と同じ枠で管理し、最新の1通だけを残す。
        old = getattr(g, "last_notice", None)
        if old is not None:
            await safe_delete(old)
        g.last_notice = await message.channel.send(view=text_panel(
            "",
            f"💥 {message.author.mention} さんがNGワード「**{word}**」を言ってしまいました！ 脱落です。"
            f"（残り {len(g.alive)}人）"))
        return True

    @commands.Cog.listener()
    async def on_message(self, message):
        if getattr(message.author, "bot", False):
            return
        await self.handle_message(message)


async def setup(bot):
    await bot.add_cog(NGWord(bot))
