# -*- coding: utf-8 -*-
"""MIQ 設定パネルの UI。元 cogs/general.py から分割。"""
from __future__ import annotations

from ..common import *
from .miq import (
    MIQ_DEFAULT_PREFS, MIQ_FORMATS, MIQ_THEMES, _miq_available_fonts, miq_get_prefs,
    miq_resolve_format, miq_save_prefs,
)
from ..meme import MEME_MAX_TEXT

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
        elif resolved_fmt == "pair":
            # ペアハート風のプレビューはサンプルの2人の会話で作る
            avatar_bytes = None
            try:
                avatar_bytes = await interaction.user.display_avatar.replace(size=256, format="png").read()
            except Exception:
                logger.debug("MIQ: アバターの取得に失敗しました", exc_info=True)
                avatar_bytes = None
            entries = [
                {"name": "サンプル", "username": "sample", "text": "人間の作り方を教えて",
                 "avatar_bytes": None, "author_key": "miq-preview-other"},
                {"name": interaction.user.display_name, "username": getattr(interaction.user, "name", ""),
                 "text": "プレビューです。見た目の確認ができます。",
                 "avatar_bytes": avatar_bytes, "author_key": "miq-preview-self"},
            ]
            file = await parent.cog._miq_render_pair_file(entries, parent.prefs)
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


# ------------------------------------------------------------
# MIQ 生成メッセージに付く操作 View (削除 + フォーマット変更で再生成)
# ------------------------------------------------------------

# 生成メッセージの操作が有効な時間。設定パネル (300秒) より長めに取り、
# ゲーム系の長めの View (3600秒) に揃える。状態はインメモリのみで、
# timeout 経過後や BOT 再起動後は操作できなくなる (画像自体は残る)。
MIQ_OUTPUT_TIMEOUT = 3600


def miq_output_can_manage(user_id, requester_id, target_author_id) -> bool:
    """MIQメッセージを操作できるのは、MIQした人 (requester) と
    MIQされた人 (対象メッセージの著者) だけ。"""
    return user_id is not None and (user_id == requester_id or user_id == target_author_id)


class MiqOutputFormatSelect(discord.ui.Select):
    def __init__(self, parent: "MiqOutputView"):
        self.parent_view = parent
        current = parent.current_format
        super().__init__(
            placeholder="フォーマットを変更して再生成",
            custom_id="miq_output:format",
            options=[discord.SelectOption(label=label, value=key, emoji=emoji, default=key == current)
                     for key, (label, emoji) in MIQ_FORMATS.items()],
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.handle_format(interaction, self.values[0])


class MiqOutputDeleteButton(discord.ui.Button):
    def __init__(self, parent: "MiqOutputView"):
        self.parent_view = parent
        super().__init__(
            label="削除", emoji="🗑️", style=discord.ButtonStyle.danger,
            custom_id="miq_output:delete", row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.handle_delete(interaction)


class MiqOutputView(discord.ui.View):
    """MIQで生成した画像メッセージに付ける操作View。

    削除ボタンと、フォーマットを変えてその場で再生成するセレクトを持つ。
    再生成に必要な情報 (対象メッセージの所在・requester・対象著者・現在の
    フォーマット) はこの View が保持する。設定プレビューやミームには付けない。
    """

    def __init__(self, cog, *, requester_id: int, target_author_id, channel_id,
                 target_message_id, current_format: str):
        super().__init__(timeout=MIQ_OUTPUT_TIMEOUT)
        self.cog = cog
        self.requester_id = requester_id
        self.target_author_id = target_author_id
        self.channel_id = channel_id
        self.target_message_id = target_message_id
        self.current_format = current_format if current_format in MIQ_FORMATS else "quote"
        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(MiqOutputFormatSelect(self))
        self.add_item(MiqOutputDeleteButton(self))

    async def _check_actor(self, interaction: discord.Interaction, action: str) -> bool:
        if miq_output_can_manage(interaction.user.id, self.requester_id, self.target_author_id):
            return True
        await interaction.response.send_message(
            f"MIQした人か、MIQされた人だけが{action}できます。", ephemeral=True,
        )
        return False

    async def handle_delete(self, interaction: discord.Interaction):
        if not await self._check_actor(interaction, "削除"):
            return
        try:
            await interaction.response.defer()
        except discord.HTTPException:
            pass
        message = interaction.message
        if message is not None:
            try:
                await message.delete()
            except discord.HTTPException:
                # 既に削除されている等の競合は静かに流す
                logger.debug("MIQ: 生成メッセージの削除に失敗しました", exc_info=True)
        self.stop()

    async def handle_format(self, interaction: discord.Interaction, selected: str):
        if not await self._check_actor(interaction, "フォーマット変更"):
            return
        await interaction.response.defer()
        target = await self._fetch_target()
        if target is None:
            return await interaction.followup.send(
                "対象のメッセージが見つかりませんでした。", ephemeral=True,
            )
        size_limit = getattr(interaction.guild, "filesize_limit", None)
        file, resolved, error = await self.cog._miq_regenerate_file(
            target, self.requester_id, selected, size_limit,
        )
        if error is not None or file is None:
            return await interaction.followup.send(
                error or "引用画像を作れませんでした。", ephemeral=True,
            )
        self.current_format = resolved
        self.refresh()
        message = interaction.message
        if message is None:
            return
        try:
            # 新しい添付を明示的に渡して差し替える (渡さないと編集で添付が落ちる)
            await message.edit(attachments=[file], view=self)
        except discord.HTTPException:
            logger.debug("MIQ: フォーマット変更の編集に失敗しました", exc_info=True)
            await interaction.followup.send("画像の差し替えに失敗しました。", ephemeral=True)

    async def _fetch_target(self):
        """対象メッセージを取り直す。削除済み等で取れなければ None。"""
        channel = None
        bot = getattr(self.cog, "bot", None)
        if bot is not None and self.channel_id is not None:
            channel = bot.get_channel(self.channel_id)
            if channel is None:
                try:
                    channel = await bot.fetch_channel(self.channel_id)
                except discord.HTTPException:
                    logger.debug("MIQ: 再生成の対象チャンネル取得に失敗しました", exc_info=True)
                    return None
        if channel is None:
            return None
        try:
            return await channel.fetch_message(self.target_message_id)
        except discord.HTTPException:
            logger.debug("MIQ: 再生成の対象メッセージ取得に失敗しました", exc_info=True)
            return None


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
            f"モノクロ: `{onoff(p['grayscale'])}`　文字色連動: `{onoff(p['color_text'])}`　左右反転: `{onoff(p['flip'])}`",
            f"太字: `{onoff(p['bold'])}`　全面レイアウト: `{onoff(p['full'])}`　GIF出力: `{onoff(p['gif'])}`",
            f"フォント: `{font_label}`　配色: `{theme_label}`",
            "",
            "**引用の拒否**",
            f"あなたのメッセージの引用を拒否: `{onoff(p['refuse'])}`",
            "ONにすると、他の人はあなたのメッセージをMIQにできません（自分の引用は可能）。",
        ]
        return discord.Embed(title="MIQ設定", description="\n".join(lines), color=0xFFFFFF)
