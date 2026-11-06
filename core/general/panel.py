# -*- coding: utf-8 -*-
"""汎用パネル本体の UI（ジャンル/アクション選択など）。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *

class PayModal(discord.ui.Modal, title="コインを送金"):
    receiver_id = discord.ui.TextInput(label="送金先のユーザーID", max_length=20)
    amount = discord.ui.TextInput(label="送金するAGO", max_length=9)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction):
        try:
            receiver = await self.cog.bot.fetch_user(int(self.receiver_id.value))
            amount = int(self.amount.value)
        except (ValueError, discord.HTTPException):
            return await interaction.response.send_message("ユーザーIDまたは数量が正しくありません。", ephemeral=True)
        await self.cog.bot.get_cog("WalletCog").pay(interaction, receiver, amount)


class GeneralHistorySelect(discord.ui.Select):
    """「よく使う／最近使った」機能への近道（履歴があるときだけ最上段に出る）。"""

    def __init__(self, cog, specs, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="よく使う／最近使った機能",
            options=[
                discord.SelectOption(label=f"⭐ {spec.label}", value=spec.value)
                for spec in specs
            ],
            custom_id="panel:general:history",
            row=row,
        )

    async def callback(self, interaction):
        await self.cog.dispatch_general(interaction, self.values[0])


class GeneralGenreSelect(discord.ui.Select):
    def __init__(self, cog, selected: str | None = None, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[discord.SelectOption(label=label, description=f"{len(GENERAL_ACTIONS[value])}個の機能", value=value,
                                          default=value == selected)
                     for value, (label, _description) in GENERAL_GENRES.items()],
            custom_id="panel:general:genre",
            row=row,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        wrapper = view if hasattr(view, "panel") else None
        view = getattr(view, "panel", view)
        view.genre = self.values[0]
        view.action = None
        view.action_page = 0
        if wrapper is not None:
            wrapper.refresh()
            return await edit_panel_v2(interaction, wrapper)
        view.refresh()
        return await edit_panel_v2(interaction, as_panel_v2(view))


ACTION_PAGE_SIZE = 25  # Discord のセレクト選択肢上限


def general_action_pages(genre: str) -> list:
    """ジャンルのアクションをセレクト上限（25件）ごとのページに分ける。

    導線最適化ラウンド4: マネージャンルが28件になり上限を超えたため、
    ゲームハブ（core/game/game/cog.py の game_select_pages）と同じ
    「セレクトは1つに固定し、ページをボタンでめくる」方式にした。
    """
    actions = GENERAL_ACTIONS[genre]
    return [actions[i:i + ACTION_PAGE_SIZE]
            for i in range(0, len(actions), ACTION_PAGE_SIZE)] or [[]]


class GeneralActionSelect(discord.ui.Select):
    def __init__(self, cog, genre: str, row: int = 1, page: int = 0):
        self.cog = cog
        self.genre = genre
        pages = general_action_pages(genre)
        page = min(max(page, 0), len(pages) - 1)
        placeholder = "機能を選択してください"
        if len(pages) > 1:
            placeholder = f"機能を選択してください（{page + 1}/{len(pages)}）"
        super().__init__(
            placeholder=placeholder,
            options=[discord.SelectOption(label=label, value=value) for label, value in pages[page]],
            custom_id="panel:general:action",
            row=row,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        panel = getattr(view, "panel", view)
        panel.action = self.values[0]
        if panel.shortcut_mode:
            if hasattr(view, "_sync"):
                view._sync()
                return await edit_panel_v2(interaction, view)
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        await self.cog.dispatch_general(interaction, self.values[0])


class GeneralActionPageButton(discord.ui.Button):
    """アクションセレクトのページめくりボタン（前へ/次へ）。

    ゲームハブの GamePageButton と同じ作り。ページ状態は GeneralPanel
    が保持し、押すとその場でメッセージを編集してセレクトの中身と
    ページ表示を切り替える。custom_id は panel:general: の固定形で、
    パネル復旧（PR-B）は root 単位で開き直すため新規追加でも適合する。
    """

    def __init__(self, delta: int, page: int, total_pages: int, row: int):
        if delta < 0:
            label, custom_id = "◀ 前へ", "panel:general:action_prev"
            disabled = page <= 0
        else:
            label, custom_id = "次へ ▶", "panel:general:action_next"
            disabled = page >= total_pages - 1
        super().__init__(label=label, style=discord.ButtonStyle.secondary,
                         custom_id=custom_id, row=row, disabled=disabled)
        self.delta = delta

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        wrapper = view if hasattr(view, "panel") else None
        panel = getattr(view, "panel", view)
        pages = general_action_pages(panel.genre)
        panel.action_page = min(max(panel.action_page + self.delta, 0), len(pages) - 1)
        if wrapper is not None:
            wrapper.refresh()
            return await edit_panel_v2(interaction, wrapper)
        panel.refresh()
        return await edit_panel_v2(interaction, as_panel_v2(panel))


class GeneralPanel(discord.ui.View):
    def __init__(self, cog, genre: str | None = None, shortcut_mode: bool = False, shortcut_item: dict | None = None,
                 history_specs: list | None = None, owner_id: int | None = None):
        super().__init__(timeout=600)  # ルートパネル共通の寿命（導線最適化 S10）
        self.cog = cog
        self.owner_id = owner_id
        saved = (shortcut_item or {}).get("action", {})
        _genre = genre or saved.get("genre")
        self.genre = GENERAL_GENRE_ALIASES.get(_genre, _genre)
        self.action = saved.get("value")
        # 保存済みショートカットから開いた場合は、その機能が含まれる
        # ページを初期表示にする（ページング対象ジャンルだけの配慮）。
        self.action_page = 0
        if self.genre in GENERAL_ACTIONS and self.action:
            for index, chunk in enumerate(general_action_pages(self.genre)):
                if any(value == self.action for _label, value in chunk):
                    self.action_page = index
                    break
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        # 「よく使う／最近」の対象（core.action_usage.history_panel_specs の結果）。
        # 空ならセクション自体を出さず、従来の見た目と完全同一に保つ。
        self.history_specs = list(history_specs or [])
        self.refresh()

    def refresh(self):
        self.clear_items()
        offset = 0
        if self.history_specs:
            self.add_item(GeneralHistorySelect(self.cog, self.history_specs, row=0))
            offset = 1
        self.add_item(GeneralGenreSelect(self.cog, self.genre, row=offset))
        if self.genre:
            pages = general_action_pages(self.genre)
            self.action_page = min(max(self.action_page, 0), len(pages) - 1)
            self.add_item(GeneralActionSelect(
                self.cog, self.genre, row=offset + 1, page=self.action_page))
            if len(pages) > 1:
                pager_row = offset + 2
                self.add_item(GeneralActionPageButton(
                    -1, self.action_page, len(pages), row=pager_row))
                self.add_item(discord.ui.Button(
                    label=f"{self.action_page + 1} / {len(pages)}ページ",
                    style=discord.ButtonStyle.secondary,
                    custom_id="panel:general:action_indicator",
                    row=pager_row, disabled=True))
                self.add_item(GeneralActionPageButton(
                    1, self.action_page, len(pages), row=pager_row))
        if self.shortcut_mode:
            self.add_item(ShortcutCommitButton())
        else:
            # 導線最適化 M9: 選んだ機能をその場でショートカット登録できる。
            self.add_item(RegisterShortcutButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "general", "genre": self.genre, "value": self.action}

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id


    def embed(self):
        return discord.Embed(title="一般機能", color=0xFFFFFF)

from .shortcuts import RegisterShortcutButton, ShortcutCommitButton  # 相互参照のため末尾で import
