# -*- coding: utf-8 -*-
"""/game: パーティーゲーム（人狼・ワードウルフ・UNO・ダウト・NGワード・お題しりとり・じゃんけん・Wordle・神経衰弱・ババ抜き・数字当て・フラッシュ暗算・大富豪・オセロ・ポーカー・将棋・チェス）の入口。

ゲームを選ぶと、人数の目安・所要時間と「ルール」「募集する」ボタンが出る。
募集は各ゲームの cog の ``start_recruit(interaction)`` をそのまま呼ぶので、個別のコマンド
（!doubt）と同じ流れになる。案内文は core/game/game_guides.py。
"""
import discord
from discord import app_commands
from discord.ext import commands

from core import action_usage
from core.game import party_ranking
from core.game import elo
from core.support import usage_stats
from core.emojis import BACK
from core.game.game_guides import GAME_GUIDES, GAME_ORDER, guide_for_discord
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.public_share import PublicShareView
from core.user_names import resolve_display_names

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
    "minesweeper": "Minesweeper",
    "daifugo": "Daifugo",
    "othello": "Othello",
    "poker": "Poker",
    "shogi": "Shogi",
    "chess": "Chess",
    "dungeon": "DungeonCog",
    "quiz": "Quiz",
    "bingo": "Bingo",
    "majority": "Majority",
    "onenight": "OneNight",
    "loveletter": "LoveLetter",
    "codenames": "Codenames",
    "twochoice": "TwoChoice",
    "thirtyone": "ThirtyOne",
    "koikoi": "Koikoi",
    "gomoku": "Gomoku",
    "connect4": "Connect4",
    "sudoku": "Sudoku",
    "game2048": "Game2048Cog",
    "nonogram": "Nonogram",
    "highlow": "HighLow",
    "justone": "JustOne",
    "ito": "Ito",
    "insider": "Insider",
    "gauge": "Gauge",
    "ruins": "Ruins",
    "hanabi": "Hanabi",
    "hoshi": "Hoshi",
    "liequiz": "LieQuiz",
}

RANKED_GAMES = {"ngword", "shiritori"}

WORDWOLF_LISTS = [("standard", "標準"), ("starail", "崩壊：スターレイル"), ("genshin", "原神")]
# ジャンル説明は他ルートの方針に合わせ、ラベルから自明なものは書かない（導線最適化 S8）。
GAME_GENRES = {
    "party": ("パーティーゲーム", ""),
    "solo": ("ミニゲーム", ""),
    "board": ("ボード・カードゲーム", ""),
}
# 導線最適化ラウンド3: 1件ジャンル「アドベンチャー」（ダンジョンのみ）は器を畳み、
# ダンジョン（1人・自由にプレイ）を solo へ寄せた。分類だけの変更で機能には触らない。
GAME_GENRE_BY_GAME = {
    **{game: "party" for game in ("jinrou", "wordwolf", "uno", "doubt", "ngword", "shiritori", "janken", "babanuki", "quiz", "bingo", "majority", "onenight", "loveletter", "codenames", "twochoice", "thirtyone", "justone", "ito", "insider", "gauge", "ruins", "hanabi", "hoshi", "liequiz")},
    **{game: "solo" for game in ("wordle", "shinkei", "guess", "flash", "minesweeper", "sudoku", "game2048", "nonogram", "highlow", "dungeon")},
    **{game: "board" for game in ("daifugo", "othello", "poker", "shogi", "chess", "koikoi", "gomoku", "connect4")},
}


def hub_embed() -> discord.Embed:
    # 初画面はタイトル＋1行だけ（導線最適化 S2）。ゲーム名・人数・所要時間は
    # ゲームセレクトの label/description と詳細画面が担い、一覧テキストは出さない。
    return discord.Embed(
        title="パーティーゲーム",
        description="遊びたいゲームを下のメニューから選んでください。",
        color=HUB_COLOR,
    )


def detail_embed(game_id: str) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    embed = discord.Embed(title=guide["name"], description=guide["summary"], color=HUB_COLOR)
    embed.add_field(name="人数の目安", value=guide["players"], inline=True)
    embed.add_field(name="所要時間", value=guide["duration"], inline=True)
    return embed


def rules_embed(game_id: str) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    embed = discord.Embed(title=f"{guide['name']} のルール", description=guide_for_discord(game_id), color=HUB_COLOR)
    embed.add_field(name="人数の目安", value=guide["players"], inline=True)
    embed.add_field(name="所要時間", value=guide["duration"], inline=True)
    embed.add_field(name="個別コマンド", value=" / ".join(f"`{c}`" for c in guide["commands"]), inline=False)
    return embed


async def monthly_embed(guild_id, bot=None) -> discord.Embed:
    """今月のゲーム王: その月の全ゲーム合計勝利数の上位（月次シーズン）。"""
    month = party_ranking.current_month()
    rows = await party_ranking.shared().monthly_top(guild_id, limit=10) if guild_id else []
    if rows:
        medals = {1: "👑", 2: "🥈", 3: "🥉"}
        # 氏名はメンションではなく通常表記（サーバー外・退室済みだと unknown になるため）
        names = await resolve_display_names(bot, [uid for uid, _wins in rows])
        lines = [f"{medals.get(i, f'{i}.')} {names.get(int(uid), '')} — {wins}勝" for i, (uid, wins) in enumerate(rows, 1)]
        text = "\n".join(lines)
    else:
        text = "今月はまだ記録がありません。ゲームに勝って最初のゲーム王を目指しましょう。"
    year, mon = month.split("-")
    embed = discord.Embed(title=f"今月のゲーム王（{int(year)}年{int(mon)}月）", description=text, color=HUB_COLOR)
    embed.set_footer(text="月が変わると集計はリセットされます（累積のランキングは各ゲームの画面で見られます）。")
    return embed


async def ranking_embed(guild_id, game_id: str, bot=None) -> discord.Embed:
    guide = GAME_GUIDES[game_id]
    rows = await party_ranking.shared().top(guild_id, game_id, limit=10) if guild_id else []
    if rows:
        medals = {1: "🥇", 2: "🥈", 3: "🥉"}
        names = await resolve_display_names(bot, [uid for uid, _wins in rows])
        lines = [f"{medals.get(i, f'{i}.')} {names.get(int(uid), '')} — {wins}勝" for i, (uid, wins) in enumerate(rows, 1)]
        text = "\n".join(lines)
    else:
        text = "まだ記録がありません。"
    embed = discord.Embed(title=f"{guide['name']} のサーバーランキング", description=text, color=HUB_COLOR)
    if game_id in elo.GAMES and guild_id:
        rows = elo.shared().top(guild_id, game_id, limit=10)
        if rows:
            names = await resolve_display_names(bot, [uid for uid, *_rest in rows])
            lines = [f"{i}. {names.get(int(uid), '')} — レート {rating:.0f}（{wins}勝{losses}敗{draws}分）"
                     for i, (uid, rating, wins, losses, draws) in enumerate(rows, 1)]
            embed.add_field(name="📈 レート上位（対人戦）", value="\n".join(lines)[:1024], inline=False)
    return embed


class GameGenreSelect(discord.ui.Select):
    def __init__(self, selected: str = None):
        super().__init__(placeholder="ジャンルを選択してください", options=[
            discord.SelectOption(label=label, description=description, value=value, default=value == selected)
            for value, (label, description) in GAME_GENRES.items()
        ], custom_id="panel:game:genre", row=0)

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
        view.page = 0
        view.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(view))


SELECT_PAGE_SIZE = 25  # Discord のセレクト選択肢上限


def game_select_pages(genre: str | None = None) -> list:
    """対象ゲーム id をセレクト上限（25件）ごとのページに分ける。"""
    ids = [g for g in GAME_ORDER if genre is None or GAME_GENRE_BY_GAME[g] == genre]
    return [ids[i:i + SELECT_PAGE_SIZE] for i in range(0, len(ids), SELECT_PAGE_SIZE)] or [[]]


class GameSelect(discord.ui.Select):
    def __init__(self, genre: str | None = None, selected: str = None, page: int | None = None):
        pages = game_select_pages(genre)
        if page is None:
            page = 0
            if selected is not None:
                for i, chunk in enumerate(pages):
                    if selected in chunk:
                        page = i
                        break
        # 導線最適化ラウンド3: 人数・所要時間は詳細画面のフィールドが担う。
        # セレクトの description にも出すとハブ経由で2回表示になるため付けない
        # （履歴セレクト・/quick 経由では詳細が唯一の表示になる点も詳細を残す理由）。
        options = [
            discord.SelectOption(
                label=GAME_GUIDES[g]["name"],
                value=g,
                default=(g == selected),
            )
            for g in pages[page]
        ]
        placeholder = "ゲームを選択してください"
        if len(pages) > 1:
            placeholder = f"ゲームを選択してください（{page + 1}/{len(pages)}）"
        # ページが変わってもセレクトは1つだけ。custom_id は常に固定。
        super().__init__(placeholder=placeholder, options=options, custom_id="panel:game:select", row=1 if genre else 0)

    async def callback(self, interaction: discord.Interaction):
        game_id = self.values[0]
        panel = GameDetailView(self.view.cog, game_id, self.view.shortcut_mode, self.view.shortcut_item,
                               owner_id=getattr(self.view, "owner_id", None))
        if hasattr(self.view, "panel"):
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        return await edit_panel_v2(interaction, as_panel_v2(panel))


class GamePageButton(discord.ui.Button):
    """ゲームセレクトのページめくりボタン（前へ/次へ）。

    ページ状態は GameHubView.page が保持し、押すとその場でメッセージを
    編集してセレクトの中身とページ表示を切り替える。ジャンル絞り込み時は
    全ジャンルとも1ページに収まるため、ボタン自体を出さない。
    """

    def __init__(self, delta: int, page: int, total_pages: int, row: int):
        if delta < 0:
            label, custom_id = "◀ 前へ", "panel:game:page_prev"
            disabled = page <= 0
        else:
            label, custom_id = "次へ ▶", "panel:game:page_next"
            disabled = page >= total_pages - 1
        super().__init__(label=label, style=discord.ButtonStyle.secondary,
                         custom_id=custom_id, row=row, disabled=disabled)
        self.delta = delta

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        view = getattr(container, "panel", container)
        pages = game_select_pages(getattr(view, "genre", None))
        view.page = min(max(getattr(view, "page", 0) + self.delta, 0), len(pages) - 1)
        view.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(view))


class GameHistorySelect(discord.ui.Select):
    """「よく使う／最近遊んだ」ゲームへの近道（導線最適化 M5）。

    履歴はゲーム単位（start_game で記録される game:game:<id>）で、
    選ぶとそのゲームの詳細画面を直接開く。
    """

    def __init__(self, specs, row: int = 0):
        options = []
        for spec in specs:
            game_id = spec.value.removeprefix("game:")
            if game_id in GAME_GUIDES:
                options.append(discord.SelectOption(
                    label=f"⭐ {GAME_GUIDES[game_id]['name']}", value=game_id))
        super().__init__(placeholder="よく使う／最近遊んだゲーム",
                         options=options, custom_id="panel:game:history", row=row)

    async def callback(self, interaction: discord.Interaction):
        view = self.view
        panel = GameDetailView(view.cog, self.values[0], view.shortcut_mode,
                               view.shortcut_item,
                               owner_id=getattr(view, "owner_id", None))
        return await edit_panel_v2(interaction, as_panel_v2(panel))


class GameHubView(discord.ui.View):
    def __init__(self, cog, shortcut_mode: bool = False, shortcut_item: dict | None = None,
                 owner_id: int | None = None, history_specs: list | None = None,
                 page: int = 0):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner_id = owner_id
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        self.history_specs = list(history_specs or [])
        self.genre = None
        self.page = page
        self.refresh()

    def refresh(self):
        self.clear_items()
        offset = 0
        history_select = None
        if self.history_specs:
            history_select = GameHistorySelect(self.history_specs, row=0)
            if history_select.options:
                self.add_item(history_select)
                offset = 1
        genre_select = GameGenreSelect(self.genre)
        genre_select.row = offset
        self.add_item(genre_select)
        # 導線最適化 M3: 既定はジャンルなし全ゲームセレクト。
        # ジャンルセレクトは廃止せず「絞り込み」として残し、選んだ場合だけ一覧を絞る。
        # ラウンド3で全34ゲームとなり上限25件を超えたため、セレクトは1つに固定し、
        # 25件ごとのページをボタンでめくる（ジャンル絞り込み時は全ジャンルとも
        # 1ページに収まるのでページめくりは出ない）。
        pages = game_select_pages(self.genre)
        self.page = min(max(self.page, 0), len(pages) - 1)
        game_select = GameSelect(self.genre, page=self.page)
        game_select.row = offset + 1
        self.add_item(game_select)
        next_row = offset + 2
        if len(pages) > 1:
            self.add_item(GamePageButton(-1, self.page, len(pages), row=next_row))
            self.add_item(discord.ui.Button(
                label=f"{self.page + 1} / {len(pages)}ページ", style=discord.ButtonStyle.secondary,
                custom_id="panel:game:page_indicator", row=next_row, disabled=True))
            self.add_item(GamePageButton(1, self.page, len(pages), row=next_row))
            next_row += 1
        monthly = discord.ui.Button(label="👑 今月のゲーム王", style=discord.ButtonStyle.primary,
                                    custom_id="panel:game:monthly", row=next_row)
        monthly.callback = self._monthly_callback
        self.add_item(monthly)
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton("game"))

    async def _monthly_callback(self, interaction: discord.Interaction):
        await interaction.response.send_message(embed=await monthly_embed(interaction.guild_id, bot=getattr(self.cog, "bot", None)))

    def shortcut_action(self):
        return None

    def embed(self):
        if self.genre:
            return discord.Embed(title="パーティーゲーム", description=f"**{GAME_GENRES[self.genre][0]}** のゲームを選んでください。", color=HUB_COLOR)
        return hub_embed()

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id



class WordlistSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=f"お題: {name}", value=value, default=(value == selected))
                   for value, name in WORDWOLF_LISTS]
        super().__init__(placeholder="お題のリスト", options=options, custom_id="panel:game:wordlist", row=1)

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
        super().__init__(placeholder="制限時間", options=options, custom_id="panel:game:ng_time", row=1)

    async def callback(self, interaction: discord.Interaction):
        self.view.ng_minutes = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class NGModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=label, value=value, default=(value == selected))
                   for value, label in NG_MODES]
        super().__init__(placeholder="モード", options=options, custom_id="panel:game:ng_mode", row=2)

    async def callback(self, interaction: discord.Interaction):
        self.view.ng_mode = self.values[0]
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


WORDLE_MODES = (("shared", "みんなで（チャンネルの全員で推理）"), ("solo", "ひとりで（始めた人だけ）"), ("daily", "デイリー（今日の問題・全員同じ答え）"))


class WordleModeSelect(discord.ui.Select):
    def __init__(self, selected: str):
        options = [discord.SelectOption(label=label, value=value, default=(value == selected))
                   for value, label in WORDLE_MODES]
        super().__init__(placeholder="モード", options=options, custom_id="panel:game:wordle_mode", row=1)

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
        super().__init__(placeholder="モード", options=options, custom_id="panel:game:jinrou_mode", row=1)

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
        super().__init__(placeholder="チェスの対戦モード", options=options, custom_id="panel:game:chess_mode", row=1)

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
        super().__init__(placeholder="CPU難易度（1〜10）", options=options, custom_id="panel:game:chess_difficulty", row=2)

    async def callback(self, interaction):
        self.view.chess_difficulty = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class DaifugoRuleSelect(discord.ui.Select):
    """大富豪のルールオプション（8切り / スペ3返し）の ON/OFF 選択。"""

    def __init__(self, kind: str, selected: bool):
        self.kind = kind
        label = "8切り" if kind == "eight_cut" else "スペ3返し"
        options = [
            discord.SelectOption(label=f"{label}: ON", value="on", default=selected),
            discord.SelectOption(label=f"{label}: OFF", value="off", default=not selected),
        ]
        super().__init__(placeholder=label, options=options,
                         custom_id=f"panel:game:daifugo_{kind}", row=1 if kind == "eight_cut" else 2)

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0] == "on"
        if self.kind == "eight_cut":
            self.view.daifugo_eight_cut = value
        else:
            self.view.daifugo_spade3 = value
        for option in self.options:
            option.default = (option.value == self.values[0])
        await edit_panel_v2(interaction, self.view)


JANKEN_WAGER_CHOICES = (0, 10, 50, 100, 500)

class JankenWagerSelect(discord.ui.Select):
    def __init__(self, selected=0):
        super().__init__(placeholder="勝敗で動くコイン（1人あたり）", custom_id="panel:game:janken_wager", row=1, options=[
            discord.SelectOption(label="なし", value="0", default=selected == 0),
            *[discord.SelectOption(label=f"{amount} AGO", value=str(amount), default=selected == amount)
              for amount in JANKEN_WAGER_CHOICES[1:]]])

    async def callback(self, interaction):
        self.view.wager = int(self.values[0])
        for option in self.options:
            option.default = option.value == self.values[0]
        await edit_panel_v2(interaction, self.view)


class GameDetailView(discord.ui.View):
    def __init__(self, cog, game_id: str, shortcut_mode: bool = False, shortcut_item: dict | None = None,
                 owner_id: int | None = None):
        super().__init__(timeout=600)
        self.cog = cog
        self.owner_id = owner_id
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
        self.daifugo_eight_cut = saved.get("daifugo_eight_cut", True)
        self.daifugo_spade3 = saved.get("daifugo_spade3", False)
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
        if game_id == "daifugo":
            self.add_item(DaifugoRuleSelect("eight_cut", self.daifugo_eight_cut))
            self.add_item(DaifugoRuleSelect("spade3", self.daifugo_spade3))
        if game_id in ("chess", "othello", "shogi", "gomoku", "connect4", "koikoi"):
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
            self.add_item(ShortcutCommitButton("game"))

    def embed(self):
        return detail_embed(self.game_id)

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id


    def shortcut_action(self):
        return {"root": "game", "value": f"game:{self.game_id}",
                "options": {"wordlist": self.wordlist, "ng_minutes": self.ng_minutes,
                             "ng_mode": self.ng_mode, "wordle_mode": self.wordle_mode,
                             "jinrou_mode": self.jinrou_mode, "wager": self.wager,
                             "chess_mode": self.chess_mode, "chess_difficulty": self.chess_difficulty,
                             "daifugo_eight_cut": self.daifugo_eight_cut,
                             "daifugo_spade3": self.daifugo_spade3}}

    @discord.ui.button(label="ルール", style=discord.ButtonStyle.secondary, row=3, custom_id="panel:game:rules")
    async def rules(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=rules_embed(self.game_id))

    @discord.ui.button(label="募集する", style=discord.ButtonStyle.success, row=3, custom_id="panel:game:recruit")
    async def recruit(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.start_game(interaction, self.game_id, wordlist=self.wordlist,
                                  ng_minutes=self.ng_minutes, ng_mode=self.ng_mode,
                                  wordle_mode=self.wordle_mode, jinrou_mode=self.jinrou_mode,
                                  wager=self.wager, chess_mode=self.chess_mode,
                                  chess_difficulty=self.chess_difficulty,
                                  daifugo_eight_cut=self.daifugo_eight_cut,
                                  daifugo_spade3=self.daifugo_spade3)

    @discord.ui.button(label="ランキング", style=discord.ButtonStyle.primary, row=3, custom_id="panel:game:ranking")
    async def ranking(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(embed=await ranking_embed(interaction.guild_id, self.game_id, bot=getattr(self.cog, "bot", None)))

    @discord.ui.button(label="レート", style=discord.ButtonStyle.primary, row=4, custom_id="panel:game:rating")
    async def rating(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = self.cog.bot.get_cog(GAME_COGS["jinrou"])
        if cog is None:
            return await interaction.response.send_message(
                embed=discord.Embed(description="人狼 は現在利用できません。", color=HUB_COLOR), ephemeral=True)
        # ephemeral第2波方針: 既定で公開する（第1波の選択式から反転）。
        embed = await cog.rating_embed(interaction.user)
        await interaction.response.send_message(
            embed=embed, view=PublicShareView(interaction.user.id, embed))

    @discord.ui.button(label="ゲームを終了", style=discord.ButtonStyle.danger, row=4, custom_id="panel:game:end")
    async def end_game(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = self.cog.bot.get_cog(GAME_COGS[self.game_id])
        if cog is None or not hasattr(cog, "force_end"):
            name = GAME_GUIDES[self.game_id]["name"]
            return await interaction.response.send_message(
                embed=discord.Embed(description=f"{name} は現在利用できません。", color=HUB_COLOR), ephemeral=True)
        await cog.force_end(interaction)

    @discord.ui.button(label="戻る", emoji=BACK, style=discord.ButtonStyle.secondary, row=3, custom_id="panel:game:back")
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        # 戻り先のハブは、見ていたゲームが載っているページで開き直す。
        page = next((i for i, chunk in enumerate(game_select_pages()) if self.game_id in chunk), 0)
        view = GameHubView(self.cog, owner_id=self.owner_id, page=page)
        if hasattr(getattr(button, "view", None), "_sync"):
            return await edit_panel_v2(interaction, as_panel_v2(view))
        await interaction.response.edit_message(embed=view.embed(), view=view)


class GameHub(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="game", description="ゲームの操作パネルを表示します")
    async def game(self, interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        history_specs = []
        if interaction.guild_id is not None:
            from core import action_usage, guild_settings
            store = guild_settings.get_store()
            await store.ensure_loaded()
            history_specs = action_usage.history_panel_specs(
                store, interaction.guild_id, interaction.user.id, "game")
        view = GameHubView(self, owner_id=interaction.user.id,
                           history_specs=history_specs)
        await interaction.followup.send(view=as_panel_v2(view))

    async def start_game(self, interaction: discord.Interaction, game_id: str, **options):
        # 利用履歴（レジストリの game アクション id は "game:game:<id>"）。
        await action_usage.record_safely(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"game:game:{game_id}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"game:game:{game_id}")
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
        if game_id in ("othello", "shogi", "gomoku", "connect4", "koikoi"):
            return await cog.start_recruit(interaction, mode=options.get("chess_mode") or "human",
                                           difficulty=options.get("chess_difficulty") or 5)
        if game_id == "daifugo":
            return await cog.start_recruit(interaction, eight_cut=options.get("daifugo_eight_cut", True),
                                           spade3=options.get("daifugo_spade3", False))
        return await cog.start_recruit(interaction)


async def setup(bot):
    await bot.add_cog(GameHub(bot))
