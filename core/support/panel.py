# -*- coding: utf-8 -*-
"""サポートパネル本体と汎用モーダル (clear / giveaway)。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


class SupportClearModal(discord.ui.Modal, title="メッセージ削除"):
    amount = discord.ui.TextInput(
        label=f"削除する件数（1〜{MAX_CLEAR}）",
        placeholder="例: 10",
        max_length=3,
    )

    def __init__(self, cog: "SupportCog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        try:
            count = int(self.amount.value)
        except ValueError:
            return await interaction.response.send_message(
                "件数は整数で入力してください。",
                ephemeral=True,
            )

        if not 1 <= count <= MAX_CLEAR:
            return await interaction.response.send_message(
                f"件数は1〜{MAX_CLEAR}で指定してください。",
                ephemeral=True,
            )

        cog = self.cog.bot.get_cog("ClearCog")
        if cog is None:
            return await self.cog._missing(interaction, "メッセージ削除")

        await cog.clear(interaction, count, None)


class GiveawayModal(discord.ui.Modal, title="抽選を作成"):
    prize = discord.ui.TextInput(label="賞品", max_length=200)
    winners = discord.ui.TextInput(label="当選人数", default="1", max_length=2)
    minutes = discord.ui.TextInput(label="締切までの分数", default="60", max_length=5)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        # A modal submit has the same short acknowledgement deadline as a
        # slash command.  Defer before validation or handing off to GiveawayCog.
        await interaction.response.defer(ephemeral=True, thinking=True)
        if interaction.guild is None:
            return await interaction.followup.send(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        ):
            return await interaction.followup.send(
                "抽選の作成にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        try:
            winners = int(self.winners.value)
            minutes = int(self.minutes.value)
        except ValueError:
            return await interaction.followup.send(
                "当選人数と分数は整数で入力してください。",
                ephemeral=True,
            )

        giveaway = self.cog.bot.get_cog("GiveawayCog")
        if giveaway is None:
            return await self.cog._missing(interaction, "giveaway")

        await giveaway.giveaway(
            interaction,
            self.prize.value,
            winners,
            minutes,
            None,
            None,
            0,
            None,
            None,
        )


class SupportHistorySelect(discord.ui.Select):
    """「よく使う／最近使った」機能への近道（履歴があるときだけ最上段に出る）。"""

    def __init__(self, cog: "SupportCog", specs, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="よく使う／最近使った機能",
            options=[
                discord.SelectOption(label=f"⭐ {spec.label}", value=spec.value)
                for spec in specs
            ],
            custom_id="panel:support:history",
            row=row,
        )

    async def callback(self, interaction: discord.Interaction):
        await self.cog.dispatch(interaction, self.values[0])


class SupportGenreSelect(discord.ui.Select):
    def __init__(self, cog: "SupportCog", selected: str | None = None, row: int = 0):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[
                discord.SelectOption(
                    label=label,
                    description=f"{len(SUPPORT_ACTIONS_BY_GENRE[value])}個の機能",
                    value=value,
                    default=value == selected,
                )
                for value, (label, _description) in SUPPORT_GENRES.items()
            ],
            custom_id="panel:support:genre",
            row=row,
        )

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        view: SupportPanelView = getattr(container, "panel", container)

        await interaction.response.defer()

        try:
            view.genre = self.values[0]
            view.action = None
            view.refresh()

            if hasattr(container, "_sync"):
                container._sync()
                await edit_panel_v2(interaction, container)
            else:
                await edit_panel_v2(interaction, as_panel_v2(view))
        except Exception:
            logger.exception("サポート操作パネルのジャンル更新に失敗しました")
            try:
                await interaction.followup.send(
                    "ジャンルの更新に失敗しました。Botのログを確認してください。",
                    ephemeral=True,
                )
            except discord.HTTPException:
                logger.exception("ジャンル更新エラーの通知にも失敗しました")


class SupportActionSelect(discord.ui.Select):
    def __init__(self, cog: "SupportCog", genre: str, row: int = 1):
        self.cog = cog
        super().__init__(
            placeholder="機能を選択してください",
            options=[
                discord.SelectOption(label=label, value=value)
                for label, value in SUPPORT_ACTIONS_BY_GENRE[genre]
            ],
            custom_id="panel:support:action",
            row=row,
        )

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]

        container = self.view
        panel = getattr(container, "panel", container)
        panel.action = value

        if getattr(panel, "shortcut_mode", False):
            if hasattr(container, "_sync"):
                container._sync()
                return await edit_panel_v2(interaction, container)
            return await edit_panel_v2(interaction, as_panel_v2(panel))

        await self.cog.dispatch(interaction, value)


class SupportPanelView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        genre: str | None = None,
        shortcut_mode: bool = False,
        shortcut_item: dict | None = None,
        history_specs: list | None = None,
    ):
        super().__init__(timeout=300)
        self.cog = cog

        saved = (shortcut_item or {}).get("action", {})
        saved_genre = saved.get("genre")
        self.genre = SUPPORT_GENRE_ALIASES.get(genre or saved_genre, genre or saved_genre)
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item
        # 「よく使う／最近」の対象。空ならセクション自体を出さない。
        self.history_specs = list(history_specs or [])

        self.refresh()

    def refresh(self):
        self.clear_items()
        offset = 0
        if self.history_specs:
            self.add_item(SupportHistorySelect(self.cog, self.history_specs, row=0))
            offset = 1
        self.add_item(SupportGenreSelect(self.cog, self.genre, row=offset))

        if self.genre:
            self.add_item(SupportActionSelect(self.cog, self.genre, row=offset + 1))

        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton("support"))

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "support", "genre": self.genre, "value": self.action}

    def embed(self):
        return discord.Embed(title="サポート操作", color=0xFFFFFF)
