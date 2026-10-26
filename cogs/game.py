# -*- coding: utf-8 -*-
"""/game: パーティーゲーム（人狼・ワードウルフ・UNO・ダウト・NGワード・お題しりとり・じゃんけん・Wordle・神経衰弱・ババ抜き・数字当て・フラッシュ暗算・大富豪・オセロ・ポーカー・将棋・チェス）の入口。

ゲームを選ぶと、人数の目安・所要時間と「ルール」「募集する」ボタンが出る。
募集は各ゲームの cog の ``start_recruit(interaction)`` をそのまま呼ぶので、個別のコマンド
（!doubt）と同じ流れになる。案内文は core/game_guides.py。
"""
import discord
from discord import app_commands
from discord.ext import commands

from core import party_ranking
from core.game_guides import GAME_GUIDES, GAME_ORDER, guide_for_discord
from core.panel_v2 import as_panel_v2, edit_panel_v2

HUB_COLOR = 0xFFFFFF

GAME_COGS = {
    "jinrou": "JinrouCog",
    "wordwolf": "CustomWordWolf",
    "uno": "Uno",
    "doubt": "Doubt",
    "ngword": "NGWord",
    "shiritori": "OdaiShiritori",
    "janken": "Janken",
    "wordle": "Wordle",
    "shinkei": "Shinkei",
    "babanuki": "Babanuki",
    "guess": "Guess",
    "flash": "FlashMentalArithmetic",
    "daifugo": "Daifugo",
    "othello": "Othello",
    "poker": "Poker",
    "shogi": "Shogi",
    "chess": "Chess",
    "dungeon": "DungeonCog",
}

RANKED_GAMES = {"ngword", "shiritori"}

WORDWOLF_LISTS = [("standard", "標準"), ("starail", "崩壊：スターレイル"), ("genshin", "原神")]
GAME_GENRES = {
    "party": ("パーティーゲーム", "人狼、ワードウルフ、UNO、ダウトなど"),
    "solo": ("ミニゲーム", "Wordle、神経衰弱、数字当て、フラッシュ暗算など"),
    "board": ("ボード・カードゲーム", "大富豪、オセロ、ポーカー、将棋、チェス"),
    "adventure": ("アドベンチャー", "ダンジョンを探索します"),
}
GAME_GENRE_BY_GAME = {
    **{game: "party" for game in ("jinrou", "wordwolf", "uno", "doubt", "ngword", "shiritori", "janken", "babanuki")},
    **{game: "solo" for game in ("wordle", "shinkei", "guess", "flash")},
    **{game: "board" for game in ("daifugo", "othello", "poker", "shogi", "chess")},
    "dungeon": "adventure",
}


def hub_embed() -> discord.Embed:
    embed = discord.Embed(
        title="パーティーゲーム",
        description="遊びたいゲームを下のメニューから選んでください。\nルールの確認と、このチャンネルでの募集ができます。",
        color=HUB_COLOR,
    )
    for game_id in GAME_ORDER:
        guide = GAME_GUIDES[game_id]
        embed.add_field(
            name=guide["name"],
            value=f"{guide['summary']}\n <:AGOMUNI:1490254579336613898>{guide['players']}　⏱ {guide['duration']}",
            inline=False,
        )
    return embed


def detail_embed(game_id: str) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    embed = discord.Embed(title=guide["name"], description=guide["summary"], color=HUB_COLOR)
    embed.add_field(name="人数の目安", value=guide["players"], inline=True)
    embed.add_field(name="所要時間", value=guide["duration"], inline=True)
    embed.set_footer(text="「募集する」を押すと、このチャンネルで参加者の募集が始まります。")
    return embed


def rules_embed(game_id: str) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    embed = discord.Embed(title=f"{guide['name']} のルール", description=guide_for_discord(game_id), color=HUB_COLOR)
    embed.add_field(name="人数の目安", value=guide["players"], inline=True)
    embed.add_field(name="所要時間", value=guide["duration"], inline=True)
    embed.add_field(name="個別コマンド", value=" / ".join(f"`{c}`" for c in guide["commands"]), inline=False)
    return embed


async def ranking_embed(guild_id, game_id: str) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    rows = await party_ranking.shared().top(guild_id, game_id, limit=10) if guild_id else []
    if rows:
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        lines = [f"{medals.get(i, f'{i}.')} <@{uid}> — {wins}勝" for i, (uid, wins) in enumerate(rows, 1)]
        text = "\n".join(lines)
    else:
        text = "まだ記録がありません。"
    embed = discord.Embed(title=f"{guide['name']} のサーバーランキング", description=text, color=HUB_COLOR)
    embed.set_footer(text="勝利数の上位10人です。")
    return embed


class GameGenreSelect(discord.ui.Select):
    def __init__(self, selected: str = None):
        super().__init__(placeholder="ジャンルを選ぶ", options=[
            discord.SelectOption(label=label, description=description, value=value, default=value == selected)
            for value, (label, description) in GAME_GENRES.items()
        ], row=0)

    async def callback(self, interaction: discord.Interaction):
        selected = self.values[0]
        container = self.view
        view = getattr(container, "panel", container)
        if selected in GAME_GENRE_BY_GAME:
            panel = GameDetailView(view.cog, selected, view.shortcut_mode, view.shortcut_item)
            if hasattr(container, "panel"):
                return await edit_panel_v2(interaction, as_panel_v2(panel))
            await interaction.response.edit_message(embed=detail_embed(selected), view=panel)
            return
        view.genre = selected
        view.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(view))


class GameSelect(discord.ui.Select):
    def __init__(self, genre: str | None = None, selected: str = None):
        options = [
            discord.SelectOption(
                label=GAME_GUIDES[g]["name"],
                value=g,
                description=f"{GAME_GUIDES[g]['players']}・{GAME_GUIDES[g]['duration']}"[:100],
                default=(g == selected),
            )
            for g in GAME_ORDER if genre is None or GAME_GENRE_BY_GAME[g] == genre
        ]
        super().__init__(placeholder="ゲームを選ぶ", options=options, row=1 if genre else 0)

    async def callback(self, interaction: discord.Interaction):
        game_id = self.values[0]
        panel = GameDetailView(self.view.cog, game_id, self.view.shortcut_mode, self.view.shortcut_item)
        if hasattr(self.view, "panel"):
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        return await edit_panel_v2(interaction, as_panel_v2(panel))


class GameHubView(discord.ui.View):
    def __init__(self, cog, shortcut_mode: bool = False, shortcut_item: dict | None = None):
        super().__init__(timeout=600)
        self.cog = cog
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        self.genre = None
        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(GameGenreSelect(self.genre))
        if self.genre:
            self.add_item(GameSelect(self.genre))
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        return None

    def embed(self):
        if self.genre:
            return discord.Embed(title="パーティーゲーム", description=f"**{GAME_GENRES[self.genre][0]}** のゲームを選んでください。", color=HUB_COLOR)
        return hub_embed()


class WordlistSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=f"お題: {name}", value=value, default=(value == selected))
                   for value, name in WORDWOLF_LISTS]
        super().__init__(placeholder="お題のリスト", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        self.view.wordlist = self.values[0]
        for option in self.options:
            option.default = option.value == self.view.wordlist
        await edit_panel_v2(interaction, self.view)


NG_TIME_CHOICES = (3, 5, 10)
NG_MODES = (("word", "ワードモード（NGは言葉）"), ("char", "一文字モード（NGはひらがな1文字）"))


class NGTimeSelect(discord.ui.Select):
    def __init__(self, selected: int):
        options = [discord.SelectOption(label=f"制限時間: {m}分", value=str(m), default=(m == selected))
                   for m in NG_TIME_CHOICES]
        super().__init__(placeholder="制限時間", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        self.view.ng_minutes = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class NGModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=label, value=value, default=(value == selected))
                   for value, label in NG_MODES]
        super().__init__(placeholder="モード", options=options, row=2)

    async def callback(self, interaction: discord.Interaction):
        self.view.ng_mode = self.values[0]
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


WORDLE_MODES = (("shared", "みんなで（チャンネルの全員で推理）"), ("solo", "ひとりで（始めた人だけ）"))


class WordleModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=label, value=value, default=(value == selected))
                   for value, label in WORDLE_MODES]
        super().__init__(placeholder="モード", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        self.view.wordle_mode = self.values[0]
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


JINROU_MODES = (("local", "ローカルモード（このサーバーだけ）"), ("global", "グローバルモード（他サーバーと合流）"))
ENDABLE_GAMES = {"jinrou", "uno"}


class JinrouModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=label, value=value, default=(value == selected))
                   for value, label in JINROU_MODES]
        super().__init__(placeholder="モード", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        self.view.jinrou_mode = self.values[0]
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class ChessModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [
            discord.SelectOption(label="2人対戦", value="human", default=selected == "human"),
            discord.SelectOption(label="CPU対戦", value="cpu", default=selected == "cpu"),
        ]
        super().__init__(placeholder="チェスの対戦モード", options=options, row=1)

    async def callback(self, interaction):
        self.view.chess_mode = self.values[0]
        for option in self.options:
            option.default = option.value == self.view.chess_mode
        await edit_panel_v2(interaction, self.view)


class BoardGameModeSelect(ChessModeSelect):
    def __init__(self, selected: str):
        super().__init__(selected)
        self.placeholder = "対戦モード"


class ChessDifficultySelect(discord.ui.Select):
    def __init__(self, selected: int):
        options = [discord.SelectOption(label=f"CPU難易度 {level}/10", value=str(level), default=level == selected)
                   for level in range(1, 11)]
        super().__init__(placeholder="CPU難易度（1〜10）", options=options, row=2)

    async def callback(self, interaction):
        self.view.chess_difficulty = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


JANKEN_WAGER_CHOICES = (0, 10, 50, 100, 500)

class JankenWagerSelect(discord.ui.Select):
    def __init__(self, selected=0):
        super().__init__(placeholder="勝敗で動くコイン（1人あたり）", row=1, options=[
            discord.SelectOption(label="なし", value="0", default=selected == 0),
            *[discord.SelectOption(label=f"{amount} AGO", value=str(amount), default=selected == amount)
              for amount in JANKEN_WAGER_CHOICES[1:]]])

    async def callback(self, interaction):
        self.view.wager = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class GameDetailView(discord.ui.View):
    def __init__(self, cog, game_id: str, shortcut_mode: bool = False, shortcut_item: dict | None = None):
        super().__init__(timeout=600)
        self.cog = cog
        self.game_id = game_id
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        saved = (shortcut_item or {}).get("action", {}).get("options", {})
        self.wordlist = saved.get("wordlist", "standard")
        self.ng_minutes, self.ng_mode = saved.get("ng_minutes", 3), saved.get("ng_mode", "word")
        self.jinrou_mode = saved.get("jinrou_mode", "local")
        self.wordle_mode = saved.get("wordle_mode", "shared")
        self.wager = saved.get("wager", 0)
        self.chess_mode = saved.get("chess_mode", "human")
        self.chess_difficulty = saved.get("chess_difficulty", 5)
        if game_id == "janken":
            self.add_item(JankenWagerSelect(self.wager))
        if game_id == "wordle":
            self.add_item(WordleModeSelect(self.wordle_mode))
        if game_id == "ngword":
            self.add_item(NGTimeSelect(self.ng_minutes))
            self.add_item(NGModeSelect(self.ng_mode))
        self.add_item(GameSelect(selected=game_id))
        if game_id == "wordwolf":
            self.add_item(WordlistSelect(self.wordlist))
        if game_id == "jinrou":
            self.add_item(JinrouModeSelect(self.jinrou_mode))
        if game_id in ("chess", "othello", "shogi"):
            self.add_item(ChessModeSelect(self.chess_mode) if game_id == "chess" else BoardGameModeSelect(self.chess_mode))
            self.add_item(ChessDifficultySelect(self.chess_difficulty))
        if game_id != "jinrou":
            self.remove_item(self.rating)
        if game_id not in ENDABLE_GAMES:
            self.remove_item(self.end_game)
        if game_id not in RANKED_GAMES and not party_ranking.is_ranked(game_id):
            self.remove_item(self.ranking)
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton())

    def embed(self):
        return detail_embed(self.game_id)

    def shortcut_action(self):
        return {"root": "game", "value": f"game:{self.game_id}",
                "options": {"wordlist": self.wordlist, "ng_minutes": self.ng_minutes,
                             "ng_mode": self.ng_mode, "wordle_mode": self.wordle_mode,
                             "jinrou_mode": self.jinrou_mode, "wager": self.wager,
                             "chess_mode": self.chess_mode, "chess_difficulty": self.chess_difficulty}}

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary, row=3)
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=rules_embed(self.game_id), ephemeral=True)

    @discord.ui.button(label="募集する", style=discord.ButtonStyle.success, row=3)
    async def recruit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.start_game(interaction, self.game_id, wordlist=self.wordlist,
                                  ng_minutes=self.ng_minutes, ng_mode=self.ng_mode,
                                  wordle_mode=self.wordle_mode, jinrou_mode=self.jinrou_mode,
                                  wager=self.wager, chess_mode=self.chess_mode,
                                  chess_difficulty=self.chess_difficulty)

    @discord.ui.button(label="ランキング", style=discord.ButtonStyle.primary, row=3)
    async def ranking(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=await ranking_embed(interaction.guild_id, self.game_id),
                                                ephemeral=True)

    @discord.ui.button(label="レート", style=discord.ButtonStyle.primary, row=4)
    async def rating(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = self.cog.bot.get_cog(GAME_COGS["jinrou"])
        if cog is None:
            return await interaction.response.send_message(
                embed=discord.Embed(description="人狼 は現在利用できません。", color=HUB_COLOR), ephemeral=True)
        await interaction.response.send_message(embed=await cog.rating_embed(interaction.user), ephemeral=True)

    @discord.ui.button(label="ゲームを終了", style=discord.ButtonStyle.danger, row=4)
    async def end_game(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = self.cog.bot.get_cog(GAME_COGS[self.game_id])
        if cog is None or not hasattr(cog, "force_end"):
            name = GAME_GUIDES[self.game_id]["name"]
            return await interaction.response.send_message(
                embed=discord.Embed(description=f"{name} は現在利用できません。", color=HUB_COLOR), ephemeral=True)
        await cog.force_end(interaction)

    @discord.ui.button(label="戻る", emoji="<:Back:1561700549236097034>", style=discord.ButtonStyle.secondary, row=3)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = GameHubView(self.cog)
        if hasattr(getattr(button, "view", None), "_sync"):
            return await edit_panel_v2(interaction, as_panel_v2(view))
        await interaction.response.edit_message(embed=view.embed(), view=view)


class GameHub(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="game", description="Browse and start party games and dungeon games")
    async def game(self, interaction: discord.Interaction):
        view = GameHubView(self)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def start_game(self, interaction: discord.Interaction, game_id: str, **options):
        cog = self.bot.get_cog(GAME_COGS[game_id])
        if cog is None or not hasattr(cog, "start_recruit"):
            name = GAME_GUIDES[game_id]["name"]
            return await interaction.response.send_message(
                embed=discord.Embed(description=f"{name} は現在利用できません。", color=HUB_COLOR), ephemeral=True)
        if game_id == "ngword":
            return await cog.start_recruit(interaction, minutes=options.get("ng_minutes") or 3,
                                           mode=options.get("ng_mode") or "word")
        if game_id == "wordle":
            return await cog.start_recruit(interaction, mode=options.get("wordle_mode") or "shared")
        if game_id == "wordwolf":
            return await cog.start_recruit(interaction, options.get("wordlist") or "standard")
        if game_id == "jinrou":
            return await cog.start_recruit(interaction, options.get("jinrou_mode") or "local")
        if game_id == "janken":
            return await cog.start_recruit(interaction, wager=options.get("wager", 0))
        if game_id == "chess":
            return await cog.start_recruit(interaction, mode=options.get("chess_mode") or "human",
                                           difficulty=options.get("chess_difficulty") or 5)
        if game_id in ("othello", "shogi"):
            return await cog.start_recruit(interaction, mode=options.get("chess_mode") or "human",
                                           difficulty=options.get("chess_difficulty") or 5)
        return await cog.start_recruit(interaction)


async def setup(bot):
    await bot.add_cog(GameHub(bot))
