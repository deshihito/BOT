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
            view.action_page = 0
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
                    "ジャンルの更新に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                    ephemeral=True,
                )
            except discord.HTTPException:
                logger.exception("ジャンル更新エラーの通知にも失敗しました")


ACTION_PAGE_SIZE = 25  # Discord のセレクト選択肢上限


def support_action_pages(genre: str) -> list:
    """ジャンルのアクションをセレクト上限（25件）ごとのページに分ける。

    general の general_action_pages と同じ方式（セレクトは1つに固定し、
    ページをボタンでめくる）。自動化・通知ジャンルが34件になったため、
    support でも25件を超えるジャンルを全件選べるようにする。
    """
    actions = SUPPORT_ACTIONS_BY_GENRE[genre]
    return [actions[i:i + ACTION_PAGE_SIZE]
            for i in range(0, len(actions), ACTION_PAGE_SIZE)] or [[]]


class SupportActionSelect(discord.ui.Select):
    def __init__(self, cog: "SupportCog", genre: str, row: int = 1, page: int = 0):
        self.cog = cog
        self.genre = genre
        pages = support_action_pages(genre)
        page = min(max(page, 0), len(pages) - 1)
        placeholder = "機能を選択してください"
        if len(pages) > 1:
            placeholder = f"機能を選択してください（{page + 1}/{len(pages)}）"
        super().__init__(
            placeholder=placeholder,
            options=[
                discord.SelectOption(label=label, value=value)
                for label, value in pages[page]
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


class SupportActionPageButton(discord.ui.Button):
    """アクションセレクトのページめくりボタン（前へ/次へ）。

    general の GeneralActionPageButton と同じ作り。ページ状態は
    SupportPanelView が保持する。custom_id は panel:support: の固定形で、
    パネル復旧は root 単位で開き直すため新規追加でも適合する。
    """

    def __init__(self, delta: int, page: int, total_pages: int, row: int):
        if delta < 0:
            label, custom_id = "◀ 前へ", "panel:support:action_prev"
            disabled = page <= 0
        else:
            label, custom_id = "次へ ▶", "panel:support:action_next"
            disabled = page >= total_pages - 1
        super().__init__(label=label, style=discord.ButtonStyle.secondary,
                         custom_id=custom_id, row=row, disabled=disabled)
        self.delta = delta

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        panel = getattr(container, "panel", container)
        pages = support_action_pages(panel.genre)
        panel.action_page = min(max(panel.action_page + self.delta, 0), len(pages) - 1)
        # 状態を変えたら必ず panel.refresh() で子部品を作り直してから
        # _sync() すること。_sync() だけだと旧ページの子部品が再利用され、
        # ページが切り替わらない（game の GamePageButton と同じ順序）。
        panel.refresh()
        if hasattr(container, "_sync"):
            container._sync()
            return await edit_panel_v2(interaction, container)
        return await edit_panel_v2(interaction, as_panel_v2(panel))


class SupportWarpButton(discord.ui.Button):
    """ジャンルワープボタン（core/panel_warps.py の対応表から自動配置）。

    着地は対象ルートのパネルを対象ジャンルで開く。custom_id は
    panel:support: の固定形（復旧時は support パネルが開き直される）。
    """

    def __init__(self, warp, row: int):
        super().__init__(
            label=warp.label,
            style=discord.ButtonStyle.primary,
            custom_id=f"panel:support:warp_{warp.to_root}_{warp.to_genre or 'hub'}",
            row=row,
        )
        self.warp = warp

    async def callback(self, interaction: discord.Interaction):
        from core.panel_warps import build_warp_panel

        container = self.view
        panel = getattr(container, "panel", container)
        target = build_warp_panel(
            interaction.client, self.warp,
            owner_id=getattr(panel, "owner_id", None),
        )
        if target is None:
            return await interaction.response.send_message(
                "移動先のパネルが読み込まれていません。", ephemeral=True)
        return await edit_panel_v2(interaction, as_panel_v2(target))


class BumpRtaSettingsView(discord.ui.View):
    """boardNotify 共通設定（オン/オフ・メンションロール・広告枠）。

    オン/オフ・ロールの実処理は BumpRta.bumprta_command の既存分岐（on/off/role）に委譲し、
    保存形式・判定は従来と完全に同じにする。状態表示は dispatch 側が
    bumprta_status と同じ文面の embed を添えて出す。
    広告枠（記録表示に出る連携枠）の ON/OFF は guild_settings の
    boardnotify セクションに保存する（core/ads.py）。
    """

    def __init__(self, rta_cog, ads_on: bool = True):
        super().__init__(timeout=300)
        self.rta_cog = rta_cog
        self.ads_on = ads_on

    def embed(self):
        return discord.Embed(title="boardNotify設定（共通）", color=0xFFFFFF)

    async def _run(self, interaction: discord.Interaction, action: str):
        if self.rta_cog is None:
            return await interaction.response.send_message(
                "boardNotify機能が読み込まれていません。", ephemeral=True)
        return await self.rta_cog.bumprta_command(
            interaction,
            app_commands.Choice(name=action, value=action),
        )

    @discord.ui.button(label="通知オン", style=discord.ButtonStyle.success,
                       custom_id="support:bumprta_settings:on")
    async def on_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._run(interaction, "on")

    @discord.ui.button(label="通知オフ", style=discord.ButtonStyle.secondary,
                       custom_id="support:bumprta_settings:off")
    async def off_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._run(interaction, "off")

    @discord.ui.button(label="メンションロール設定", style=discord.ButtonStyle.primary,
                       custom_id="support:bumprta_settings:role")
    async def role_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._run(interaction, "role")

    @discord.ui.button(label="広告枠 ON/OFF", style=discord.ButtonStyle.secondary,
                       custom_id="support:bumprta_settings:ads")
    async def ads_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not getattr(getattr(interaction.user, "guild_permissions", None), "manage_guild", False):
            return await interaction.response.send_message(
                "この操作にはサーバー管理権限が必要です。", ephemeral=True)
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この操作はサーバー内でのみ使えます。", ephemeral=True)
        from core import ads as partner_ads

        current = await partner_ads.ads_enabled(interaction.guild_id)
        new_value = not current
        await partner_ads.set_ads_enabled(interaction.guild_id, new_value)
        self.ads_on = new_value
        return await interaction.response.send_message(
            f"記録表示の広告枠を **{'オン' if new_value else 'オフ'}** にしました。",
            ephemeral=True)


class TempVoicePanelGuideView(discord.ui.View):
    """一時VC操作パネルの案内（実体はVCチャンネル内の常駐View）。

    一時VCを作成すると、そのチャンネルに操作パネル（名前変更・人数制限
    など）が常駐する。ここではその旨の案内と、一時VC設定画面
    （assist_tempvoice）への導線だけを出す。
    """

    def __init__(self, cog: "SupportCog"):
        super().__init__(timeout=300)
        self.cog = cog

    def embed(self):
        return discord.Embed(
            title="一時VC操作パネル",
            description=(
                "一時VCを作成すると、そのVCチャンネルに操作パネルが常駐します"
                "（名前・人数制限などの操作はそのパネルから行います）。\n"
                "一時VCの作成条件や送信先などの設定は、下のボタンから開けます。"
            ),
            color=0xFFFFFF,
        )

    @discord.ui.button(label="一時VC設定を開く", style=discord.ButtonStyle.primary,
                       custom_id="support:tempvoice_panel:settings")
    async def open_settings(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = interaction.client.get_cog("ServerAssistCog")
        if cog is None:
            return await interaction.response.send_message(
                "サーバーアシストが読み込まれていません。", ephemeral=True)
        return await cog.show_feature(interaction, "tempvoice")


class SupportPanelView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        genre: str | None = None,
        shortcut_mode: bool = False,
        shortcut_item: dict | None = None,
        history_specs: list | None = None,
        owner_id: int | None = None,
    ):
        super().__init__(timeout=600)  # ルートパネル共通の寿命（導線最適化 S10）
        self.cog = cog
        self.owner_id = owner_id

        saved = (shortcut_item or {}).get("action", {})
        saved_genre = saved.get("genre")
        self.genre = SUPPORT_GENRE_ALIASES.get(genre or saved_genre, genre or saved_genre)
        self.action = saved.get("value")
        # 保存済みショートカットから開いた場合は、その機能が含まれる
        # ページを初期表示にする（general と同じ配慮）。
        self.action_page = 0
        if self.genre in SUPPORT_ACTIONS_BY_GENRE and self.action:
            for index, chunk in enumerate(support_action_pages(self.genre)):
                if any(value == self.action for _label, value in chunk):
                    self.action_page = index
                    break
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
            pages = support_action_pages(self.genre)
            self.action_page = min(max(self.action_page, 0), len(pages) - 1)
            self.add_item(SupportActionSelect(
                self.cog, self.genre, row=offset + 1, page=self.action_page))
            extra_row = offset + 2
            if len(pages) > 1:
                self.add_item(SupportActionPageButton(
                    -1, self.action_page, len(pages), row=extra_row))
                self.add_item(discord.ui.Button(
                    label=f"{self.action_page + 1} / {len(pages)}ページ",
                    style=discord.ButtonStyle.secondary,
                    custom_id="panel:support:action_indicator",
                    row=extra_row, disabled=True))
                self.add_item(SupportActionPageButton(
                    1, self.action_page, len(pages), row=extra_row))
            if not self.shortcut_mode:
                # ジャンルワープ（core/panel_warps.py の対応表）。
                # ページめくりがある場合は同じ行に相乗りし、行数を増やさない。
                from core.panel_warps import warps_from

                for warp in warps_from("support", self.genre):
                    self.add_item(SupportWarpButton(warp, row=extra_row))

        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton("support"))
        else:
            # 導線最適化 M9: 選んだ機能をその場でショートカット登録できる。
            from core.general.shortcuts import RegisterShortcutButton
            self.add_item(RegisterShortcutButton("support"))

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "support", "genre": self.genre, "value": self.action}

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（導線最適化ラウンド2）: 持ち主だけが操作できる。
        return self.owner_id is None or interaction.user.id == self.owner_id

    def embed(self):
        return discord.Embed(title="サポート操作", color=0xFFFFFF)
