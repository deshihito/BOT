"""/help: カテゴリごとのコマンド一覧と、コマンドごとの使い方・ガイドを表示する。

一覧は core/command_catalog.py のカタログ（Web サイトと同じデータ）から作る。
プレフィックスの !help もこのカタログを使う形に置き換える（詳しい一覧は /help に案内する）。
"""

from __future__ import annotations

import re

import discord
from discord import app_commands
from discord.ext import commands

from core.help.help.command_catalog import (build_catalog, command_key, find_command, permission_label, registered_commands,
                                  visible_commands)
from core.help.help.command_meta import COMMAND_META
from core.support.emojis import BACK, BOOK, LEFT, RIGHT
from core.support.panel_v2 import as_panel_v2, edit_panel_v2, wrap_panel_view

# Discord の上限
EMBED_TITLE = 256
EMBED_DESCRIPTION = 4096
FIELD_VALUE = 1024
FIELD_NAME = 256
MAX_FIELDS = 25
SELECT_OPTIONS = 25
OPTION_TEXT = 100
CHOICES = 25
CHOICE_TEXT = 100

PAGE_BUDGET = 3500  # 1 ページの説明文の目安（上限 4096 より少し余裕を持たせる）
COLOR = 0xFFFFFF
VIEW_TIMEOUT = 600


def clip(text: str | None, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def discord_markdown(text: str) -> str:
    """Markdown の見出し（## など）を、埋め込みでも読みやすい太字に置き換える。"""
    return re.sub(r"^#{1,6}\s*(.+?)\s*$", r"**\1**", text or "", flags=re.MULTILINE).strip()


def _category(catalog: dict, category_id: str) -> dict | None:
    return next((c for c in catalog["categories"] if c["id"] == category_id), None)


def _permission_note(entry: dict) -> str:
    if not entry["permissions"]:
        return ""
    return "（要: " + "・".join(permission_label(p) for p in entry["permissions"]) + "）"


def entry_line(entry: dict) -> str:
    guide = ' ' + BOOK if entry["guide"] else ""
    return f"`{clip(entry['usage'], 150)}`{guide}\n{clip(entry['summary'], 200)}{_permission_note(entry)}"


# ---------------------------------------------------------------- パネル機能の統合（導線最適化 M6）
# /help のカテゴリに、パネル側のレジストリアクションを対応付ける対応表。
# アクション側の情報（ラベル・ジャンル）は action_registry が単一の真実で、
# ここに手書きのメタは増やさない。対応は (root, genre) の組で、genre=None は
# そのルート全件。未対応のジャンルが残らないよう、全ジャンルをいずれかの
# カテゴリに割り当てる（テストで網羅を固定する）。
ACTION_CATEGORY_MAP: dict[str, list[tuple[str, str | None]]] = {
    "support": [("general", "survival"), ("support", "automation"),
                ("support", "analysis")],
    "economy": [("general", "money"), ("general", "trade_craft"),
                ("general", "play"), ("general", "rta"),
                ("general", "boardnotify_rta")],
    "game": [("game", None)],
    "voice": [("vc", None)],
    # 導線最適化ラウンド4: M8 で廃止された miq ジャンル（custom へ吸収済み）
    # の対応が死にエントリとして残っていたため削除した。
    "fun": [("general", "custom"), ("general", "zeta"),
            ("general", "make_image"), ("general", "exp"),
            ("general", "garden"), ("general", "fortune"),
            ("general", "utility")],
    "admin": [("support", "moderation"), ("support", "roles"), ("support", "logs"),
              ("support", "rta"),
              ("support", "boardnotify"), ("support", "sns")],
}


def panel_action_lines(category_id: str) -> list[str]:
    """カテゴリに対応するパネル機能を「開き方」つきの行として生成する。

    レジストリの読み込みに失敗しても /help 自体は壊さない（空リストを返す）。
    """
    try:
        from core.general import action_registry

        specs = action_registry.default_registry().all()
    except Exception:
        return []
    targets = ACTION_CATEGORY_MAP.get(category_id, [])
    lines: list[str] = []
    for root, genre in targets:
        for spec in specs:
            if spec.root != root:
                continue
            if genre is not None and spec.genre != genre:
                continue
            if root in ("game", "vc"):
                route = f"/{root}"
            else:
                route = f"/{root} → {spec.genre_label}"
            lines.append(f"・{spec.label}（{route}）")
    return lines


# ---------------------------------------------------------------- 埋め込み
HIDDEN_FEATURE_LINE = "隠し機能: チャンネルで「今北産業」と送ると、直近の会話を最大3行で要約します。"


def overview_embed(catalog: dict) -> discord.Embed:
    embed = discord.Embed(
        title="コマンド一覧",
        description=(
            '`/help command:` にコマンド名を入れると詳しい説明が表示されます。\nパネル機能は `/quick` で名前から検索して直接実行できます。\n' + BOOK + ' はガイド（くわしい説明）があるコマンドです\n\n' + HIDDEN_FEATURE_LINE
        ),
        color=COLOR,
    )
    for category in catalog["categories"][:MAX_FIELDS]:
        count = len(visible_commands(catalog, category["id"]))
        if not count:
            continue
        embed.add_field(name=clip(f"{category['label']}（{count}）", FIELD_NAME),
                        value=clip(category["description"] or "—", FIELD_VALUE), inline=False)
    return embed


def category_pages(catalog: dict, category_id: str) -> list[discord.Embed]:
    category = _category(catalog, category_id)
    if category is None:
        return [discord.Embed(title="カテゴリが見つかりません", color=COLOR)]
    header = clip(category["description"], 500)
    if category["guide"]:
        header += "\n「このカテゴリの説明」でくわしい案内を読めます。"
    lines = [entry_line(e) for e in visible_commands(catalog, category_id)]
    action_lines = panel_action_lines(category_id)
    if action_lines:
        lines = lines + ["**パネル機能**（/quick で名前から直接実行できます）"] + action_lines
    pages: list[list[str]] = [[]]
    size = len(header)
    for line in lines:
        if pages[-1] and size + len(line) + 2 > PAGE_BUDGET:
            pages.append([])
            size = len(header)
        pages[-1].append(line)
        size += len(line) + 2
    embeds = []
    for number, page in enumerate(pages, start=1):
        title = category["label"] + (f"（{number}/{len(pages)}）" if len(pages) > 1 else "")
        body = header + "\n\n" + ("\n\n".join(page) if page else "表示できるコマンドはありません。")
        embed = discord.Embed(title=clip(title, EMBED_TITLE), description=clip(body, EMBED_DESCRIPTION), color=COLOR)
        embeds.append(embed)
    return embeds


def command_embed(entry: dict, catalog: dict | None = None) -> discord.Embed:
    key = command_key(entry["kind"], entry["name"])
    embed = discord.Embed(title=clip(key, EMBED_TITLE), description=clip(entry["summary"] or "—", EMBED_DESCRIPTION),
                          color=COLOR)
    embed.add_field(name="使い方", value=clip(f"`{entry['usage']}`", FIELD_VALUE), inline=False)
    if entry["options"]:
        lines = []
        for option in entry["options"]:
            need = "必須" if option["required"] else "省略可"
            text = f"`{option['name']}`（{need}）"
            if option["description"]:
                text += f" {option['description']}"
            lines.append(text)
        embed.add_field(name="オプション", value=clip("\n".join(lines), FIELD_VALUE), inline=False)
    if entry["permissions"]:
        embed.add_field(name="必要な権限", value=clip("・".join(permission_label(p) for p in entry["permissions"]),
                                                       FIELD_VALUE), inline=True)
    if entry["aliases"]:
        embed.add_field(name="別名", value=clip(" ".join(f"`!{a}`" for a in entry["aliases"]), FIELD_VALUE),
                        inline=True)
    if entry["guild_only"]:
        embed.add_field(name="使える場所", value="サーバー内のみ", inline=True)
    if catalog is not None:
        category = _category(catalog, entry["category"])
        if category:
            embed.set_footer(text=f"カテゴリ: {category['label']}" + ('\u3000' + BOOK + ' ガイドあり' if entry["guide"] else ""))
    return embed


def guide_embed(title: str, guide: str) -> discord.Embed:
    return discord.Embed(title=clip(title, EMBED_TITLE), description=clip(discord_markdown(guide), EMBED_DESCRIPTION),
                         color=COLOR)


def command_choices(catalog: dict, current: str) -> list[app_commands.Choice[str]]:
    """入力中の文字に合うコマンドを、前方一致 → 名前に含む → 説明に含む の順で最大 25 件返す。"""
    query = " ".join((current or "").lower().split())
    bare = query.lstrip("/!")
    ranked = []
    for entry in visible_commands(catalog):
        key = command_key(entry["kind"], entry["name"])
        name = entry["name"].lower()
        if not query:
            rank = 0
        elif key.lower().startswith(query) or name.startswith(bare):
            rank = 0
        elif bare in name:
            rank = 1
        elif query in (entry["summary"] or "").lower():
            rank = 2
        else:
            continue
        ranked.append((rank, key, entry))
    ranked.sort(key=lambda item: (item[0], item[1]))
    return [app_commands.Choice(name=clip(f"{key} — {entry['summary']}", CHOICE_TEXT), value=key[:CHOICE_TEXT])
            for _, key, entry in ranked[:CHOICES]]


# ---------------------------------------------------------------- 画面（View）
class CategorySelect(discord.ui.Select):
    def __init__(self, catalog: dict, current: str | None):
        options = []
        for category in catalog["categories"]:
            if not visible_commands(catalog, category["id"]):
                continue
            # カテゴリ説明は overview_embed のフィールド側だけに寄せる（導線最適化 S4:
            # 同一画面の二重表示をなくすため、option description には入れない）。
            options.append(discord.SelectOption(
                label=clip(category["label"], OPTION_TEXT), value=category["id"],
                default=category["id"] == current))
        super().__init__(placeholder="カテゴリを選択してください", options=options[:SELECT_OPTIONS], custom_id="panel:help:category", row=0)

    async def callback(self, interaction: discord.Interaction):
        view: HelpView = self.view
        await view.show(interaction, self.values[0], 0)


class FunctionSelect(discord.ui.Select):
    """選択したカテゴリ内のコマンドを、次の機能欄として選ぶ。"""

    def __init__(self, catalog: dict, category_id: str):
        self.catalog = catalog
        self.category_id = category_id
        options = []
        for entry in visible_commands(catalog, category_id):
            key = command_key(entry["kind"], entry["name"])
            options.append(discord.SelectOption(
                label=clip(key, OPTION_TEXT), value=key[:OPTION_TEXT],
                description=clip(entry["summary"], OPTION_TEXT)))
        super().__init__(placeholder="機能（コマンド）を選択してください", options=options[:SELECT_OPTIONS], custom_id="panel:help:function", row=1)

    async def callback(self, interaction: discord.Interaction):
        entry = find_command(self.catalog, self.values[0])
        view: HelpView = self.view
        if entry is None:
            return await interaction.response.send_message("コマンドが見つかりませんでした。", ephemeral=True)
        await edit_panel_v2(interaction, as_panel_v2(CommandView(
            self.catalog, entry, owner_id=getattr(view, "owner_id", None))))


CATEGORY_GUIDE = "__category__"


class GuideSelect(discord.ui.Select):
    def __init__(self, catalog: dict, category_id: str):
        self.catalog = catalog
        self.category_id = category_id
        options = []
        category = _category(catalog, category_id)
        if category and category["guide"]:
            options.append(discord.SelectOption(label="このカテゴリの説明", value=CATEGORY_GUIDE))
        for entry in visible_commands(catalog, category_id):
            if entry["guide"]:
                key = command_key(entry["kind"], entry["name"])
                options.append(discord.SelectOption(label=clip(f"{key} のガイド", OPTION_TEXT), value=key[:OPTION_TEXT],
                                                    description=clip(entry["summary"], OPTION_TEXT)))
        super().__init__(placeholder="ガイド（くわしい説明）を読む", options=options[:SELECT_OPTIONS], custom_id="panel:help:guide", row=3)

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]
        if value == CATEGORY_GUIDE:
            category = _category(self.catalog, self.category_id)
            embed = guide_embed(f"{category['label']}の説明", category["guide"])
        else:
            entry = find_command(self.catalog, value)
            embed = guide_embed(f"{value} のガイド", entry["guide"]) if entry and entry["guide"] else \
                discord.Embed(description="ガイドが見つかりませんでした。", color=COLOR)
        view: HelpView = self.view
        await edit_panel_v2(
            interaction, as_panel_v2(BackView(self.catalog, self.category_id, view.page, embed,
                                              owner_id=getattr(view, "owner_id", None))))


class HelpView(discord.ui.View):
    """カテゴリ選択・ページ送り・ガイド選択をまとめた画面。操作のたびに作り直す。"""

    def __init__(self, catalog: dict, category_id: str | None = None, page: int = 0,
                 shortcut_mode: bool = False, shortcut_item: dict | None = None,
                 owner_id: int | None = None):
        super().__init__(timeout=VIEW_TIMEOUT)
        self.catalog = catalog
        self.owner_id = owner_id
        self.category_id = category_id
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        saved = (shortcut_item or {}).get("action", {}).get("options", {})
        if category_id is None:
            self.category_id = saved.get("category_id")
        if page == 0:
            page = saved.get("page", page)
        category_id = self.category_id
        self.pages = category_pages(catalog, category_id) if category_id else []
        self.page = max(0, min(page, len(self.pages) - 1)) if self.pages else 0
        self.add_item(CategorySelect(catalog, category_id))
        if category_id:
            function_select = FunctionSelect(catalog, category_id)
            if function_select.options:
                self.add_item(function_select)
            guide_select = GuideSelect(catalog, category_id)
            if guide_select.options:
                self.add_item(guide_select)
            self.previous_page.disabled = self.page <= 0
            self.next_page.disabled = self.page >= len(self.pages) - 1
        else:
            self.remove_item(self.previous_page)
            self.remove_item(self.next_page)
            self.remove_item(self.back_to_top)
        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton("help"))

    def shortcut_action(self):
        if self.category_id is None:
            return None
        return {"root": "help", "value": "overview", "options": {"category_id": self.category_id, "page": self.page}}


    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id

    def embed(self) -> discord.Embed:
        return self.pages[self.page] if self.category_id else overview_embed(self.catalog)

    async def show(self, interaction: discord.Interaction, category_id: str | None, page: int,
                   *, v2: bool = False):
        view = HelpView(self.catalog, category_id, page, self.shortcut_mode, self.shortcut_item,
                        owner_id=self.owner_id)
        self.stop()
        return await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="前へ", emoji=LEFT, style=discord.ButtonStyle.secondary, row=2, custom_id="panel:help:prev")
    async def previous_page(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.show(interaction, self.category_id, self.page - 1,
                        v2=hasattr(getattr(button, "view", None), "_sync"))

    @discord.ui.button(label="次へ", emoji=RIGHT, style=discord.ButtonStyle.secondary, row=2, custom_id="panel:help:next")
    async def next_page(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.show(interaction, self.category_id, self.page + 1,
                        v2=hasattr(getattr(button, "view", None), "_sync"))

    @discord.ui.button(label="カテゴリ一覧", style=discord.ButtonStyle.primary, row=2, custom_id="panel:help:top")
    async def back_to_top(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.show(interaction, None, 0,
                        v2=hasattr(getattr(button, "view", None), "_sync"))


class BackView(discord.ui.View):
    """ガイドを読んでいる画面から、カテゴリの一覧へ戻るボタン。"""

    def __init__(self, catalog: dict, category_id: str | None, page: int = 0, content=None,
                 owner_id: int | None = None):
        super().__init__(timeout=VIEW_TIMEOUT)
        self.catalog, self.category_id, self.page, self.content = catalog, category_id, page, content
        self.owner_id = owner_id


    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id

    def embed(self) -> discord.Embed:
        return self.content or discord.Embed(title="ヘルプ", description="カテゴリの一覧へ戻れます。", color=COLOR)

    @discord.ui.button(label="一覧に戻る", emoji=BACK, style=discord.ButtonStyle.primary, custom_id="panel:help:back")
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = HelpView(self.catalog, self.category_id, self.page, owner_id=self.owner_id)
        self.stop()
        await edit_panel_v2(interaction, as_panel_v2(view))


class CommandView(discord.ui.View):
    """1 つのコマンドの説明画面。ガイドがあれば「ガイドを読む」ボタンを出す。"""

    def __init__(self, catalog: dict, entry: dict, owner_id: int | None = None):
        super().__init__(timeout=VIEW_TIMEOUT)
        self.catalog, self.entry = catalog, entry
        self.owner_id = owner_id
        if not entry["guide"]:
            self.remove_item(self.read_guide)


    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id

    def embed(self) -> discord.Embed:
        return command_embed(self.entry, self.catalog)

    @discord.ui.button(label="ガイドを読む", emoji=BOOK, style=discord.ButtonStyle.success, custom_id="panel:help:read_guide")
    async def read_guide(self, interaction: discord.Interaction, button: discord.ui.Button):
        key = command_key(self.entry["kind"], self.entry["name"])
        await edit_panel_v2(interaction, as_panel_v2(BackView(
                self.catalog, self.entry["category"], 0,
                guide_embed(f"{key} のガイド", self.entry["guide"]), owner_id=self.owner_id)))

    @discord.ui.button(label="カテゴリの一覧を見る", style=discord.ButtonStyle.primary, custom_id="panel:help:open_category")
    async def open_category(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = HelpView(self.catalog, self.entry["category"], owner_id=self.owner_id)
        self.stop()
        await edit_panel_v2(interaction, as_panel_v2(view))


# ---------------------------------------------------------------- !help
class CatalogHelpCommand(commands.HelpCommand):
    """!help をカタログに合わせる。詳しい一覧は /help に案内する。"""

    # HelpCommand は呼ばれるたびに自分を deepcopy するので、Cog や Bot は持たずに実行時に探す。
    def __init__(self, **options):
        options.setdefault("command_attrs", {"help": COMMAND_META["!help"]["summary"]})
        super().__init__(**options)

    @property
    def help_cog(self) -> "HelpCog":
        return self.context.bot.get_cog("HelpCog")

    async def command_callback(self, ctx, /, *, command: str | None = None):
        if command:
            entry = find_command(self.help_cog.catalog(), command)
            if entry:
                return await ctx.send(embed=command_embed(entry, self.help_cog.catalog()))
        return await super().command_callback(ctx, command=command)

    async def send_bot_help(self, mapping):
        embed = overview_embed(self.help_cog.catalog())
        embed.description = (
            "カテゴリごとの一覧と使い方は `/help` で見られます。\n"
            f"個別の使い方は `{self.context.clean_prefix}help コマンド名` で確認できます。\n"
            + HIDDEN_FEATURE_LINE
        )
        await self.get_destination().send(embed=embed)

    async def send_cog_help(self, cog):
        await self.send_bot_help({})

    async def send_command_help(self, command):
        entry = find_command(self.help_cog.catalog(), command_key("prefix", command.qualified_name))
        if entry is None:
            return await self.get_destination().send(self.command_not_found(command.qualified_name))
        await self.get_destination().send(embed=command_embed(entry, self.help_cog.catalog()))

    async def send_group_help(self, group):
        await self.send_command_help(group)

    def command_not_found(self, string: str) -> str:
        return f"「{clip(string, 50)}」というコマンドは見つかりませんでした。`/help` で一覧を確認してください。"

    def subcommand_not_found(self, command, string: str) -> str:
        return self.command_not_found(f"{command.qualified_name} {string}")


# ---------------------------------------------------------------- Cog
class HelpCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._cache: tuple[tuple, dict] | None = None
        self._original_help = None

    async def cog_load(self):
        self._original_help = self.bot.help_command
        self.bot.help_command = CatalogHelpCommand()

    async def cog_unload(self):
        self.bot.help_command = self._original_help

    def catalog(self) -> dict:
        """カタログを返す。コマンドの数が変わったとき（cog の読み込みなど）だけ作り直す。"""
        signature = tuple(sorted(registered_commands(self.bot)))
        if self._cache is None or self._cache[0] != signature:
            self._cache = (signature, build_catalog(self.bot))
        return self._cache[1]

    @app_commands.command(name="help", description="コマンドの一覧と使い方を表示します")
    @app_commands.describe(command="使い方を見たいコマンド（入力すると候補が出ます）")
    async def help(self, interaction: discord.Interaction, command: str | None = None):
        # BOT fixer のコマンド制限（管理者は対象外）。
        from core.support import command_control

        if not await command_control.guard(interaction, "help:overview"):
            return
        catalog = self.catalog()
        if command:
            entry = find_command(catalog, command)
            if entry is None:
                await interaction.response.send_message(
                    f"「{clip(command, 50)}」というコマンドは見つかりませんでした。`/help` で一覧を確認してください。",
                    ephemeral=True)
                return
            await interaction.response.send_message(
                view=wrap_panel_view(CommandView(catalog, entry, owner_id=interaction.user.id)))
            return
        view = HelpView(catalog, owner_id=interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(view))

    @help.autocomplete("command")
    async def help_command_autocomplete(self, interaction: discord.Interaction, current: str):
        return command_choices(self.catalog(), current)


async def setup(bot: commands.Bot):
    await bot.add_cog(HelpCog(bot))
