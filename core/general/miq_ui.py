# -*- coding: utf-8 -*-
"""MIQ 設定パネルの UI。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .miq import (
    MIQ_DEFAULT_PREFS, MIQ_FORMATS, MIQ_THEMES, _miq_available_fonts, miq_get_prefs,
    miq_resolve_format, miq_save_prefs,
)
from .meme import MEME_MAX_TEXT

MIQ_TOGGLES = (
    ("grayscale", "モノクロ"),
    ("color_text", "文字色連動"),
    ("flip", "左右反転"),
    ("bold", "太字"),
    ("full", "全面レイアウト"),
)


class MiqToggleButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView", field: str, label: str, *, row: int, danger: bool = False):
        self.parent_view, self.field = parent, field
        on = bool(parent.prefs.get(field))
        if on:
            style = discord.ButtonStyle.danger if danger else discord.ButtonStyle.primary
        else:
            style = discord.ButtonStyle.secondary
        super().__init__(label=f"{label}: {'ON' if on else 'OFF'}", style=style, row=row)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs[self.field] = not parent.prefs.get(self.field)
        await parent.commit(interaction)


class MiqFontSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.current_font_key()
        super().__init__(
            placeholder="フォントを選択",
            options=[discord.SelectOption(label=f"{label} ({key})"[:100], value=key, default=key == current)
                     for key, label, _path in parent.fonts],
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["font"] = self.values[0]
        await parent.commit(interaction)


class MiqThemeSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.prefs.get("theme")
        super().__init__(
            placeholder="配色を選択",
            options=[discord.SelectOption(label=label, value=key, emoji=emoji, default=key == current)
                     for key, (label, emoji, _bg, _fg) in MIQ_THEMES.items()],
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["theme"] = self.values[0]
        await parent.commit(interaction)


class MiqFormatSelect(discord.ui.Select):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        current = parent.prefs.get("format")
        super().__init__(
            placeholder="フォーマットを選択",
            options=[discord.SelectOption(label=label, value=key, emoji=emoji, default=key == current)
                     for key, (label, emoji) in MIQ_FORMATS.items()],
            row=3,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        parent.prefs["format"] = self.values[0]
        await parent.commit(interaction)


class MiqPreviewButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        super().__init__(label="プレビュー", emoji="🖼️", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        limit = getattr(interaction.guild, "filesize_limit", None)
        # ランダムは押すたびに1回だけ解決する
        resolved_fmt = miq_resolve_format(parent.prefs)
        if resolved_fmt == "line":
            # LINE風のプレビューはサンプルの2件会話で作る
            now = datetime.now(timezone.utc)
            avatar_bytes = None
            try:
                avatar_bytes = await interaction.user.display_avatar.replace(size=128, format="png").read()
            except Exception:
                logger.debug("MIQ: アバターの取得に失敗しました", exc_info=True)
                avatar_bytes = None
            entries = [
                {"name": "サンプル", "text": "こんにちは！", "created_at": now,
                 "avatar_bytes": None, "author_key": "miq-preview-other"},
                {"name": interaction.user.display_name, "text": "プレビューです。\n見た目の確認ができます。",
                 "created_at": now, "avatar_bytes": avatar_bytes, "author_key": "miq-preview-self"},
            ]
            file = await parent.cog._miq_render_line_file(entries, parent.prefs)
        else:
            eff_prefs = dict(parent.prefs)
            eff_prefs["format"] = resolved_fmt
            file = await parent.cog._miq_build_file(
                interaction.user, "プレビューです。\n見た目の確認ができます。", eff_prefs, limit,
            )
        if file is None:
            return await interaction.followup.send("プレビューを作れませんでした。時間をおいて再試行してください。", ephemeral=True)
        await interaction.followup.send(file=file, ephemeral=True)


class MiqResetButton(discord.ui.Button):
    def __init__(self, parent: "MiqSettingsView"):
        self.parent_view = parent
        super().__init__(label="見た目を初期化", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if not await parent.check_owner(interaction):
            return
        for key, default in MIQ_DEFAULT_PREFS.items():
            if key != "refuse":  # 引用拒否の設定は初期化しない
                parent.prefs[key] = default
        await parent.commit(interaction)


class MiqSettingsView(discord.ui.View):
    """MIQの見た目と引用拒否の設定パネル。設定はユーザーごとに保存され、MIQを作る時に使われる。"""

    def __init__(self, cog: "GeneralCog", user_id: int):
        super().__init__(timeout=300)
        self.cog, self.user_id = cog, user_id
        self.prefs = miq_get_prefs(user_id)
        self.fonts = _miq_available_fonts()
        self.refresh()

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 設定は本人のものなので操作は本人のみ。
        return interaction.user.id == self.user_id

    def current_font_key(self) -> str:
        keys = [key for key, _label, _path in self.fonts]
        return self.prefs.get("font") if self.prefs.get("font") in keys else keys[0]

    def refresh(self):
        self.clear_items()
        for field, label in MIQ_TOGGLES:
            self.add_item(MiqToggleButton(self, field, label, row=0))
        self.add_item(MiqFontSelect(self))
        self.add_item(MiqThemeSelect(self))
        self.add_item(MiqFormatSelect(self))
        self.add_item(MiqToggleButton(self, "gif", "GIF出力", row=4))
        self.add_item(MiqToggleButton(self, "refuse", "引用を拒否", row=4, danger=True))
        self.add_item(MiqPreviewButton(self))
        self.add_item(MiqResetButton(self))

    async def check_owner(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.user_id:
            return True
        await interaction.response.send_message("この設定画面を開いたユーザーだけ変更できます。", ephemeral=True)
        return False

    async def commit(self, interaction: discord.Interaction):
        ok = await miq_save_prefs(self.user_id, self.prefs)
        self.refresh()
        await edit_panel_v2(interaction, as_panel_v2(self))
        if not ok:
            try:
                await interaction.followup.send("設定の保存に失敗しました。時間をおいて再試行してください。", ephemeral=True)
            except discord.HTTPException:
                logger.debug("MIQ: 設定保存の失敗通知の送信に失敗しました", exc_info=True)

    def embed(self) -> discord.Embed:
        p = self.prefs

        def onoff(value) -> str:
            return "ON" if value else "OFF"

        font_key = self.current_font_key()
        font_label = next((label for key, label, _path in self.fonts if key == font_key), font_key)
        theme_label = MIQ_THEMES.get(p.get("theme"), MIQ_THEMES["bw"])[0]
        format_label = MIQ_FORMATS.get(p.get("format"), MIQ_FORMATS["random"])[0]
        lines = [
            "**見た目**（あなたがMIQを作る時に使われます）",
            f"フォーマット: `{format_label}`",
            "未設定の既定はランダムです。ランダムでは生成のたびに単体フォーマットから1つ選ばれます（LINE風は選ばれません）。",
            f"モノクロ: `{onoff(p['grayscale'])}`　文字色連動: `{onoff(p['color_text'])}`　左右反転: `{onoff(p['flip'])}`",
            f"太字: `{onoff(p['bold'])}`　全面レイアウト: `{onoff(p['full'])}`　GIF出力: `{onoff(p['gif'])}`",
            f"フォント: `{font_label}`　配色: `{theme_label}`",
            "",
            "**引用の拒否**",
            f"あなたのメッセージの引用を拒否: `{onoff(p['refuse'])}`",
            "ONにすると、他の人はあなたのメッセージをMIQにできません（自分の引用は可能）。",
            "",
            "GIF出力はアイコンがGIFアニメの時だけ有効です（それ以外はPNG）。",
            "引用 (従来) 以外のフォーマットは常にPNGです（モノクロ等の設定は引用 (従来) 専用）。",
            "LINE風は画像・スタンプ・絵文字の合成にも対応し、画像やスタンプだけのメッセージも変換できます。",
        ]
        return discord.Embed(title="MIQ設定", description="\n".join(lines), color=0xFFFFFF)
