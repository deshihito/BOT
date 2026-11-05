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
        if wrapper is not None:
            wrapper.refresh()
            return await edit_panel_v2(interaction, wrapper)
        view.refresh()
        return await edit_panel_v2(interaction, as_panel_v2(view))


class GeneralActionSelect(discord.ui.Select):
    def __init__(self, cog, genre: str, row: int = 1):
        self.cog = cog
        self.genre = genre
        super().__init__(
            placeholder="機能を選択してください",
            options=[discord.SelectOption(label=label, value=value) for label, value in GENERAL_ACTIONS[genre]],
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
            self.add_item(GeneralActionSelect(self.cog, self.genre, row=offset + 1))
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
