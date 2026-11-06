# -*- coding: utf-8 -*-
import io
from types import SimpleNamespace

import discord
from core.game import board_image, game_panels
from core.game.board_image import render_cached, render_card, render_card_hand, render_card_pile
from core.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from discord.ext import commands

from core import action_usage
from core.game import party_ranking
from core.support import usage_stats

party_ranking.register("doubt")
import asyncio
import logging
import random

logger = logging.getLogger("cogs.doubt")


from core.embeds import we  # noqa: F401  (共通の白 embed 工場)

SUIT_ORDER = {"S": 0, "H": 1, "D": 2, "C": 3, "JK": 4}
SELECT_LIMIT = 25  # Discord のセレクトメニューに入れられる選択肢の上限


def card_sort_key(card: str):
    """"[S-10]" のようなカードを数字順（同じ数字ならスート順）に並べるためのキー。ジョーカーは最後。"""
    suit, _, rank = card.strip("[]").partition("-")
    try:
        rank_num = int(rank)
    except ValueError:
        rank_num = 0
    if suit == "JK":
        return (99, SUIT_ORDER["JK"], rank_num)
    return (rank_num, SUIT_ORDER.get(suit, 9), 0)


def sort_hand(hand):
    hand.sort(key=card_sort_key)
    return hand


# --- カード画像（共通トランプ基盤） -------------------------------------------
_RANK_LABELS = {1: "A", 11: "J", 12: "Q", 13: "K"}


def card_spec_of(card: str):
    """内部表記（"[S-10]" / "[JK-1]"）を描画基盤の正規形に変換する。"""
    suit, _, rank = card.strip("[]").partition("-")
    if suit == "JK":
        return board_image.CARD_JOKER
    n = int(rank)
    return board_image.card_spec(_RANK_LABELS.get(n, str(n)), suit)


def hand_file(hand, filename="doubt_hand.png"):
    specs = tuple(card_spec_of(c) for c in hand)
    data = render_cached(("doubt-hand", specs),
                         lambda: render_card_hand(list(specs), title="あなたの手札"))
    return discord.File(io.BytesIO(data), filename=filename)


def field_file(count: int, filename="doubt_field.png"):
    """場の山の画像。受けるのは枚数だけで、中身は構造的に渡らない。

    ダウトの場札は伏せ札なので、共有表示は裏面の山＋枚数だけを描く
    （実際のカードはダウト成立時の開示でのみ公開される）。
    """
    data = render_cached(("doubt-pile", count),
                         lambda: render_card_pile(count, label="場のカード"))
    return discord.File(io.BytesIO(data), filename=filename)

class DoubtEngine:
    def __init__(self, player_ids):
        self.players = list(player_ids)  # 開始時点の参加者で固定する（募集リストとは共有しない）
        self.hands = {p_id: [] for p_id in self.players}
        self.field = []
        self.current_turn_idx = 0
        self.last_claimed_num = None
        self.last_player_id = None
        self.is_accepting_doubt = False
        self.last_panel_msg = None 
        self.next_required_num = 1
        self.pass_count = 0
        
        self._setup_game()

    def _setup_game(self):
        suits = ["S", "H", "D", "C"]
        deck = [f"[{s}-{r}]" for s in suits for r in range(1, 14)]
        deck.extend(["[JK-1]", "[JK-2]"])
        random.shuffle(deck)
        
        per_player = len(deck) // len(self.players)
        for i, p_id in enumerate(self.players):
            start = i * per_player
            end = (i + 1) * per_player if i != len(self.players) - 1 else len(deck)
            self.hands[p_id] = sort_hand(deck[start:end])

    @property
    def current_player_id(self):
        return self.players[self.current_turn_idx]

    def next_turn(self):
        self.current_turn_idx = (self.current_turn_idx + 1) % len(self.players)

class CardSelect(discord.ui.Select):
    def __init__(self, cards, game_engine, cog, page=1, pages=1):
        options = [discord.SelectOption(label=card, value=card) for card in cards]
        placeholder = "出すカードを1枚選んでください"
        if pages > 1:
            placeholder += f"（{page}/{pages}）"
        super().__init__(placeholder=placeholder, options=options)
        self.game_engine = game_engine
        self.cog = cog

    async def callback(self, interaction: discord.Interaction):
        selected_card = self.values[0]
        game = self.game_engine
        user_id = interaction.user.id
        
        if user_id != game.current_player_id:
            return await interaction.response.send_message(embed=we("あなたのターンではありません"), ephemeral=True)
        if game.is_accepting_doubt:
            return await interaction.response.send_message(embed=we("ダウト受付中です。受付が終わってから出してください。"), ephemeral=True)
        
        claimed_num = game.next_required_num
        
        if selected_card in game.hands[user_id]:
            game.hands[user_id].remove(selected_card)
            game.field.append((user_id, selected_card))
            game.last_claimed_num = claimed_num
            game.last_player_id = user_id
            game.pass_count = 0 
            
            await interaction.response.send_message(embed=we(f"**{selected_card}** を「**{claimed_num}**」として出しました。"), ephemeral=True)
            
            game.last_announce = await interaction.channel.send(view=text_panel(
                "", f"<@{user_id}> が「**{claimed_num}**」を宣言してカードを置きました。5秒間ダウト受付中。"))
            game.next_required_num = 1 if claimed_num == 13 else claimed_num + 1
            
            game.is_accepting_doubt = True
            game.next_turn()
            
            await asyncio.sleep(5)
            
            if game.is_accepting_doubt:
                game.is_accepting_doubt = False
                # ダウトされずに最後の1枚を出し切ったら、その時点で勝ち
                if not game.hands[user_id]:
                    return await self.cog.declare_winner(interaction.channel, game, user_id)
                await self.cog.send_main_screen(interaction.channel, game)
        else:
            await interaction.response.send_message(embed=we("そのカードはもう手札にありません。"), ephemeral=True)


class CardSelectView(discord.ui.View):
    """手札を25枚ずつのセレクトメニューに分けて、全部のカードを選べるようにする"""
    def __init__(self, hand, game_engine, cog):
        super().__init__(timeout=180)
        chunks = [hand[i:i + SELECT_LIMIT] for i in range(0, len(hand), SELECT_LIMIT)]
        for page, chunk in enumerate(chunks[:5], start=1):  # 1つのメッセージに置けるのは5行まで（125枚）
            self.add_item(CardSelect(chunk, game_engine, cog, page=page, pages=len(chunks)))

class GameControlView(GamePanelView):
    """メイン画面のパネル（V2）。場の山は画像、操作はボタン。"""

    def __init__(self, game_engine, cog, body: str = ""):
        super().__init__("Doubt Game", body, timeout=None)
        self.game_engine = game_engine
        self.cog = cog
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media="attachment://doubt_field.png")
        self.add_extra(gallery)
        self.doubt = discord.ui.Button(label="ダウト！", style=discord.ButtonStyle.danger)
        self.doubt.callback = self._doubt
        self.pass_turn = discord.ui.Button(label="パス", style=discord.ButtonStyle.secondary)
        self.pass_turn.callback = self._pass_turn
        self.check_hand = discord.ui.Button(label="手札確認", style=discord.ButtonStyle.grey)
        self.check_hand.callback = self._check_hand
        self.play = discord.ui.Button(label="カードを置く", style=discord.ButtonStyle.red)
        self.play.callback = self._play
        self.add_row(self.doubt, self.pass_turn, self.check_hand, self.play)

    async def _doubt(self, interaction: discord.Interaction):
        game = self.game_engine
        if interaction.user.id not in game.hands:
            return await interaction.response.send_message(embed=we("あなたはゲームに参加していません。"), ephemeral=True)
        if not game.is_accepting_doubt:
            return await interaction.response.send_message(embed=we("今はダウトできるタイミングではありません（カードが出てから5秒間だけです）。"), ephemeral=True)
        await interaction.response.send_message(embed=we("ダウトを宣言しました。"), ephemeral=True)
        await self.cog.apply_doubt(interaction.channel, game, interaction.user.id)

    async def _pass_turn(self, interaction: discord.Interaction):
        game = self.game_engine
        if interaction.user.id not in game.hands:
            return await interaction.response.send_message(embed=we("あなたはゲームに参加していません。"), ephemeral=True)
        if interaction.user.id != game.current_player_id:
            return await interaction.response.send_message(embed=we("あなたのターンではありません"), ephemeral=True)
        if game.is_accepting_doubt:
            return await interaction.response.send_message(embed=we("ダウト受付中です。受付が終わってからにしてください。"), ephemeral=True)
        await interaction.response.send_message(embed=we("パスしました。"), ephemeral=True)
        await self.cog.apply_pass(interaction.channel, game, interaction.user.id)

    async def _check_hand(self, interaction: discord.Interaction):
        if interaction.user.id not in self.game_engine.hands:
            return await interaction.response.send_message(embed=we("あなたはゲームに参加していません。"), ephemeral=True)
            
        hand = self.game_engine.hands.get(interaction.user.id, [])
        hand_str = " ".join(hand) if hand else "手札がありません"
        embed = discord.Embed(title="あなたの手札", description=hand_str, color=0xFFFFFF)
        if hand:
            embed.set_image(url="attachment://doubt_hand.png")
            await interaction.response.send_message(embed=embed, ephemeral=True, file=hand_file(hand))
        else:
            await interaction.response.send_message(embed=embed, ephemeral=True)

    async def _play(self, interaction: discord.Interaction):
        if interaction.user.id not in self.game_engine.hands:
            return await interaction.response.send_message(embed=we("あなたはゲームに参加していません。"), ephemeral=True)
            
        if interaction.user.id != self.game_engine.current_player_id:
            return await interaction.response.send_message(embed=we("あなたのターンではありません"), ephemeral=True)
        if self.game_engine.is_accepting_doubt:
            return await interaction.response.send_message(embed=we("ダウト受付中です。受付が終わってから出してください。"), ephemeral=True)
        hand = self.game_engine.hands[interaction.user.id]
        if not hand:
            return await interaction.response.send_message(embed=we("手札がありません。"), ephemeral=True)
        
        view = CardSelectView(hand, self.game_engine, self.cog)
        await interaction.response.send_message(embed=we(f"どのカードを「{self.game_engine.next_required_num}」として出しますか？"), view=view, ephemeral=True)

class DoubtJoinView(LobbyView):
    """ダウトの募集ロビー（共通ロビー規格）。

    従来の DoubtJoinView の名前と close() の締切処理を保ちつつ、
    実体は共通ロビー（参加/退出はその場編集、文面統一）に寄せた。
    開始判定は従来どおり start_from_hub 側のタイマー/開始ボタン待ち。
    """

    def __init__(self, host_id):
        host = SimpleNamespace(id=host_id, display_name="", mention=f"<@{host_id}>")
        super().__init__(
            title="ダウト参加者募集", host=host, min_players=3, max_players=99,
            note="ボタンを押して参加してください\n**3名以上で開始します**（募集時間: 60秒）",
            timeout=65)
        self.closed = False
        self.message = None

    async def _on_join(self, interaction: discord.Interaction):
        if self.closed:
            return await interaction.response.send_message("募集は締め切られました。", ephemeral=True)
        await super()._on_join(interaction)

    async def close(self):
        """募集を締め切る。以降の参加ボタンは受け付けず、ボタンも押せなくする。"""
        self.closed = True
        self._finish_ui("募集は締め切られました。")
        self.stop()
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except Exception:
                logger.debug("Doubt: 募集パネルのボタン無効化に失敗しました", exc_info=True)

class Doubt(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games = {}
        self.recruiting = set()  # 募集中のチャンネル（同じチャンネルで募集が重ならないように）

    async def send_main_screen(self, channel, game, note: str = ""):
        # 前のパネルと宣言アナウンスは、game_panels の差し替えとここで片付く。
        announce = getattr(game, "last_announce", None)
        if announce is not None:
            game.last_announce = None
            await safe_delete(announce)
        status_list = [f"<@{p_id}>: 残り {len(game.hands.get(p_id, []))}枚" for p_id in game.players]
        lines = []
        if note:
            lines.append(note)
        lines += [
            f"次の方、カードを選んでください: <@{game.current_player_id}>",
            f"現在の手番: <@{game.current_player_id}>",
            f"出すべき数字: **{game.next_required_num}**",
            f"場の状況: 合計 {len(game.field)}枚",
            "プレイヤー:",
            *status_list,
        ]
        view = GameControlView(game, self, body="\n".join(lines))
        game.last_panel_msg = await game_panels.replace(
            channel, "party", view=view, file=field_file(len(game.field)))

    async def declare_winner(self, channel, game, winner_id):
        # メインパネルと宣言アナウンスを片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        announce = getattr(game, "last_announce", None)
        if announce is not None:
            game.last_announce = None
            await safe_delete(announce)
        await channel.send(view=text_panel("Game Set!", f"勝者: <@{winner_id}>"))
        if self.games.get(channel.id) is game:
            del self.games[channel.id]
            # サーバーごとのランキング（core/game/party_ranking.py）: 手札を出し切った 1 人が勝ち
            guild = getattr(channel, "guild", None)
            if guild is not None:
                await party_ranking.shared().record_win(guild.id, winner_id, "doubt")

    async def start_from_hub(self, channel, player_ids, join_view=None):
        if join_view is not None:
            # 60秒の募集タイマー。主催者が「開始する」を押したら早めに締める。
            for _ in range(60 * 2):
                if join_view.started or join_view.cancelled:
                    break
                await asyncio.sleep(0.5)
            if join_view.cancelled:
                await safe_delete(join_view.message)
                return
            player_ids = list(join_view.players)
            await join_view.close()
        else:
            await asyncio.sleep(60)
        player_ids = list(player_ids)  # 開始時点の参加者で固定

        if len(player_ids) < 3:
            if join_view is not None:
                await safe_delete(join_view.message)
            return await channel.send(view=text_panel(
                "", "人数不足（3名以上必要）のため、ダウトを開始できませんでした。"))

        engine = DoubtEngine(player_ids)
        self.games[channel.id] = engine
        await channel.send(view=text_panel("", "3名以上の参加を確認。カードを配り、ゲームを開始します！"))
        await self.send_main_screen(channel, engine)

    @commands.command(name="doubt")
    async def start_game(self, ctx):
        if ctx.channel.id in self.games or ctx.channel.id in self.recruiting:
            return await ctx.send(embed=we("このチャンネルでは既にダウトが進行中です。"))
        # ハブ経由でなくても利用統計に数える（ハブ側 GameHub.start_game と同じ2系統）
        await action_usage.record_safely(
            getattr(ctx, "guild", None) and ctx.guild.id, ctx.author.id, "game:game:doubt")
        usage_stats.record_action_safely("game:game:doubt")
        await self._recruit(ctx.channel, ctx.author.id)

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。interaction にはまだ応答していないこと。"""
        channel = interaction.channel
        if channel.id in self.games or channel.id in self.recruiting:
            return await interaction.response.send_message(embed=we("このチャンネルでは既にダウトが進行中です。"), ephemeral=True)
        await interaction.response.send_message(embed=we("ダウトの募集を開始しました。"))
        await self._recruit(channel, interaction.user.id)

    async def _recruit(self, channel, host_id):
        view = DoubtJoinView(host_id)
        self.recruiting.add(channel.id)
        try:
            view.message = await game_panels.replace(channel, "party", view=view)
            await self.start_from_hub(channel, view.players, join_view=view)
        finally:
            self.recruiting.discard(channel.id)

    async def apply_pass(self, channel, game, user_id):
        """パスの処理（ボタンとチャット発言の共通）。"""
        if user_id != game.current_player_id or game.is_accepting_doubt:
            return False
        game.pass_count += 1
        note = ""
        if game.pass_count >= len(game.players):
            game.next_required_num = 1
            game.pass_count = 0
            note = "全員がパスしたため、数字が1に戻ります。"
        game.next_turn()
        await self.send_main_screen(channel, game, note=note)
        return True

    async def apply_doubt(self, channel, game, user_id):
        """ダウトの処理（ボタンとチャット発言の共通）。"""
        if not game.is_accepting_doubt or user_id not in game.hands:
            return False
        game.is_accepting_doubt = False
        last_player, actual_card = game.field[-1]

        if "JK" in actual_card:
            is_lie = False
        else:
            try:
                actual_num = int(''.join(filter(str.isdigit, actual_card.split('-')[-1])))
            except ValueError:
                actual_num = 0
            is_lie = (actual_num != game.last_claimed_num)

        if is_lie:
            verdict = f"**嘘でした！**（ダウト成功）\n出した人 <@{last_player}> は場のカードをすべて回収します。"
            penalty_user = last_player
        else:
            verdict = f"**本当でした！**（ダウト失敗）\nダウトと言った <@{user_id}> がすべて回収します。"
            penalty_user = user_id

        for _, c in game.field:
            game.hands[penalty_user].append(c)
        sort_hand(game.hands[penalty_user])
        game.field.clear()

        # 開示された実際のカードは公開情報なので、画像でも見せる。
        # 審議結果は対局の記録として残す（ボタンなしの表示専用パネル）。
        reveal = render_cached(("doubt-reveal", actual_card),
                               lambda: render_card(card_spec_of(actual_card)))
        panel = GamePanelView("審議結果", "\n".join([
            verdict,
            f"宣言された数字: {game.last_claimed_num}",
            f"実際のカード: {actual_card}",
        ]), timeout=None)
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media="attachment://doubt_reveal.png")
        panel.add_extra(gallery)
        await channel.send(view=panel, file=discord.File(io.BytesIO(reveal), filename="doubt_reveal.png"))

        for p_id in game.players:
            if len(game.hands.get(p_id, [])) == 0:
                await self.declare_winner(channel, game, p_id)
                return True

        await self.send_main_screen(channel, game)
        return True

    @commands.Cog.listener()
    async def on_message(self, message):
        # 旧来のチャット発言（「ダウト」「パス」）は互換のため残し、処理はボタンと同じ共通メソッドを使う
        if message.author.bot: return
        game = self.games.get(message.channel.id)
        if not game: return

        if message.author.id == game.current_player_id and message.content == "パス" and not game.is_accepting_doubt:
            await self.apply_pass(message.channel, game, message.author.id)
            return

        elif "ダウト" in message.content and game.is_accepting_doubt:
            await self.apply_doubt(message.channel, game, message.author.id)

async def setup(bot):
    await bot.add_cog(Doubt(bot))
