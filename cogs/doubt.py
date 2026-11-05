# -*- coding: utf-8 -*-
import discord
from core import game_panels
from discord.ext import commands

from core import party_ranking

party_ranking.register("doubt")
import asyncio
import logging
import random

logger = logging.getLogger(__name__)


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
            await interaction.channel.send(embed=we(f"<@{user_id}> が「**{claimed_num}**」を宣言してカードを置きました。5秒間ダウト受付中。"))
            
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

class GameControlView(discord.ui.View):
    def __init__(self, game_engine, cog):
        super().__init__(timeout=None)
        self.game_engine = game_engine
        self.cog = cog

    @discord.ui.button(label="手札確認", style=discord.ButtonStyle.grey)
    async def check_hand(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id not in self.game_engine.hands:
            return await interaction.response.send_message(embed=we("あなたはゲームに参加していません。"), ephemeral=True)
            
        hand = self.game_engine.hands.get(interaction.user.id, [])
        hand_str = " ".join(hand) if hand else "手札がありません"
        embed = discord.Embed(title="あなたの手札", description=hand_str, color=0xFFFFFF)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @discord.ui.button(label="カードを置く", style=discord.ButtonStyle.red)
    async def play(self, interaction: discord.Interaction, button: discord.ui.Button):
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

class DoubtJoinView(discord.ui.View):
    def __init__(self, host_id):
        super().__init__(timeout=65) 
        self.players = [host_id]
        self.closed = False
        self.message = None

    async def close(self):
        """募集を締め切る。以降の参加ボタンは受け付けず、ボタンも押せなくする。"""
        self.closed = True
        for child in self.children:
            child.disabled = True
        self.stop()
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except Exception:
                logger.debug("Doubt: 募集パネルのボタン無効化に失敗しました", exc_info=True)

    @discord.ui.button(label="参加", style=discord.ButtonStyle.green)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.closed:
            await interaction.response.send_message(embed=we("募集は締め切られました。"), ephemeral=True)
        elif interaction.user.id not in self.players:
            self.players.append(interaction.user.id)
            await interaction.response.send_message(embed=we(f"参加しました (現在: {len(self.players)}名)"), ephemeral=True)
        else:
            await interaction.response.send_message(embed=we("既に参加しています"), ephemeral=True)

class Doubt(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games = {}
        self.recruiting = set()  # 募集中のチャンネル（同じチャンネルで募集が重ならないように）

    async def send_main_screen(self, channel, game):
        if game.last_panel_msg:
            try:
                await game.last_panel_msg.delete()
            except Exception:
                logger.debug("Doubt: 前回パネルの削除に失敗しました", exc_info=True)

        embed = discord.Embed(title="Doubt Game", color=0xFFFFFF)
        embed.add_field(name="現在の手番", value=f"<@{game.current_player_id}>", inline=False)
        embed.add_field(name="出すべき数字", value=f"**{game.next_required_num}**", inline=True)
        embed.add_field(name="場の状況", value=f"合計: {len(game.field)}枚", inline=True)
        
        status_list = [f"<@{p_id}>: 残り {len(game.hands.get(p_id, []))}枚" for p_id in game.players]
        embed.add_field(name="プレイヤー", value="\n".join(status_list), inline=False)
        
        view = GameControlView(game, self)
        content = f"次の方、カードを選んでください: <@{game.current_player_id}>"
        game.last_panel_msg = await game_panels.replace(channel, "party", content=content, embed=embed, view=view)

    async def declare_winner(self, channel, game, winner_id):
        win_embed = discord.Embed(title="Game Set!", description=f"勝者: <@{winner_id}>", color=0xFFFFFF)
        await channel.send(embed=win_embed)
        if self.games.get(channel.id) is game:
            del self.games[channel.id]
            # サーバーごとのランキング（core/party_ranking.py）: 手札を出し切った 1 人が勝ち
            guild = getattr(channel, "guild", None)
            if guild is not None:
                await party_ranking.shared().record_win(guild.id, winner_id, "doubt")

    async def start_from_hub(self, channel, player_ids, join_view=None):
        await asyncio.sleep(60)
        if join_view is not None:
            await join_view.close()
        player_ids = list(player_ids)  # 開始時点の参加者で固定
        
        if len(player_ids) < 3:
            return await channel.send(embed=we("人数不足（3名以上必要）のため、ダウトを開始できませんでした。"))
        
        engine = DoubtEngine(player_ids)
        self.games[channel.id] = engine
        await channel.send(embed=we("3名以上の参加を確認。カードを配り、ゲームを開始します！"))
        await self.send_main_screen(channel, engine)

    @commands.command(name="doubt")
    async def start_game(self, ctx):
        if ctx.channel.id in self.games or ctx.channel.id in self.recruiting:
            return await ctx.send(embed=we("このチャンネルでは既にダウトが進行中です。"))
        await self._recruit(ctx.channel, ctx.author.id)

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。interaction にはまだ応答していないこと。"""
        channel = interaction.channel
        if channel.id in self.games or channel.id in self.recruiting:
            return await interaction.response.send_message(embed=we("このチャンネルでは既にダウトが進行中です。"), ephemeral=True)
        await interaction.response.send_message(embed=we("ダウトの募集を開始しました。"), ephemeral=True)
        await self._recruit(channel, interaction.user.id)

    async def _recruit(self, channel, host_id):
        view = DoubtJoinView(host_id)
        embed = discord.Embed(
            title="ダウト参加者募集", 
            description="ボタンを押して参加してください\n**3名以上で開始します**（募集時間: 60秒）", 
            color=0xFFFFFF
        )
        self.recruiting.add(channel.id)
        try:
            view.message = await game_panels.replace(channel, "party", embed=embed, view=view)
            await self.start_from_hub(channel, view.players, join_view=view)
        finally:
            self.recruiting.discard(channel.id)

    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot: return
        game = self.games.get(message.channel.id)
        if not game: return

        if message.author.id == game.current_player_id and message.content == "パス" and not game.is_accepting_doubt:
            game.pass_count += 1
            if game.pass_count >= len(game.players):
                game.next_required_num = 1
                game.pass_count = 0
                await message.channel.send(embed=we("全員がパスしたため、数字が1に戻ります。"))
            
            game.next_turn()
            await self.send_main_screen(message.channel, game)
            return

        elif "ダウト" in message.content and game.is_accepting_doubt:
            if message.author.id not in game.hands:
                return

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
            
            embed = discord.Embed(title="審議結果", color=0xFFFFFF)
            embed.add_field(name="宣言された数字", value=f"{game.last_claimed_num}")
            embed.add_field(name="実際のカード", value=f"{actual_card}")
            
            if is_lie:
                embed.description = f"**嘘でした！**（ダウト成功）\n出した人 <@{last_player}> は場のカードをすべて回収します。"
                penalty_user = last_player
            else:
                embed.description = f"**本当でした！**（ダウト失敗）\nダウトと言った <@{message.author.id}> がすべて回収します。"
                penalty_user = message.author.id
            
            for _, c in game.field:
                game.hands[penalty_user].append(c)
            sort_hand(game.hands[penalty_user])
            game.field.clear()
            
            await message.channel.send(embed=embed)
            
            for p_id in game.players:
                if len(game.hands.get(p_id, [])) == 0:
                    return await self.declare_winner(message.channel, game, p_id)

            await self.send_main_screen(message.channel, game)

async def setup(bot):
    await bot.add_cog(Doubt(bot))
