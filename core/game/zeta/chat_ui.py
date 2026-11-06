import discord
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from discord.ext import commands
from typing import Dict, List, Optional
import re
import os
from core.general import logfare
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.emojis import BACK, BOOK

from core.game.zeta.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.zeta.common import PRESETS, _clip  # noqa: F401
from core.game.zeta.custom_ui import ZetaInfoView  # noqa: F401

logger = logging.getLogger("cogs.zetamodoki")


class ResponseModal(discord.ui.Modal):
    def __init__(self, cog, channel_id: int):
        super().__init__(title="メッセージを入力")
        self.cog = cog
        self.channel_id = channel_id

        self.input_text = discord.ui.TextInput(
            label="発言や行動を入力してください",
            placeholder="例: 『手をつなぎ続けないと出られない』って書いてあるよ",
            style=discord.TextStyle.paragraph,
            max_length=500,
        )
        self.add_item(self.input_text)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer()
        user_text = self.input_text.value.strip()

        # ユーザーの発言を表示
        await interaction.channel.send(f"**{interaction.user.display_name}**: {user_text}")
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=self.channel_id,
                user_input=user_text,
                requester_id=interaction.user.id,
            )


class ChatButtonView(discord.ui.View):
    def __init__(
        self,
        cog,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        private_thread: bool = False,
    ):
        super().__init__(timeout=None)
        self.cog = cog
        self.retry_owner_id = retry_owner_id
        self.retry_input = retry_input
        if retry_owner_id is None or retry_input is None:
            self.remove_item(self.retry_button)
        if not private_thread:
            self.remove_item(self.delete_thread_button)

    @discord.ui.button(label="返信する", style=discord.ButtonStyle.primary, emoji="💬")
    async def reply_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_id = interaction.channel_id
        if channel_id not in self.cog.active_personas:
            await interaction.response.send_message("このチャンネルではセッションが開始されていません。`/general` の「ZetaModoki」から会話を開始してください。", ephemeral=True)
            return

        modal = ResponseModal(self.cog, channel_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="再試行", style=discord.ButtonStyle.secondary, row=0)
    async def retry_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.retry_owner_id:
            await interaction.response.send_message("この発言を送信したユーザーだけが再試行できます。", ephemeral=True)
            return
        failed = self.cog.failed_requests.get(interaction.channel_id)
        if (
            not failed
            or failed["user_id"] != interaction.user.id
            or failed["user_input"] != self.retry_input
        ):
            await interaction.response.send_message("再試行できる失敗した発言が見つかりません。", ephemeral=True)
            return

        channel = interaction.channel
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        await interaction.response.edit_message(
            view=ChatButtonView(self.cog, private_thread=private_thread)
        )
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=interaction.channel_id,
                user_input=self.retry_input,
                requester_id=interaction.user.id,
            )

    @discord.ui.button(label="このスレッドを削除", style=discord.ButtonStyle.danger, row=0)
    async def delete_thread_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        if not isinstance(channel, discord.Thread) or channel.type != discord.ChannelType.private_thread:
            await interaction.response.send_message("このボタンはプライベートスレッド内でのみ使えます。", ephemeral=True)
            return
        confirm = DeleteThreadConfirmView(self.cog, channel.id, interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(confirm), ephemeral=True)


class DeleteThreadConfirmView(discord.ui.View):
    def __init__(self, cog, thread_id: int, requester_id: int):
        super().__init__(timeout=60)
        self.cog = cog
        self.thread_id = thread_id
        self.requester_id = requester_id

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="プライベートスレッドの削除",
            description="このプライベートスレッドと会話履歴を削除しますか？この操作は取り消せません。",
            color=discord.Color.red(),
        )

    @discord.ui.button(label="削除する", style=discord.ButtonStyle.danger)
    async def confirm_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        if interaction.channel_id != self.thread_id or not isinstance(interaction.channel, discord.Thread):
            await interaction.response.send_message("対象のスレッドを確認できません。", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            await interaction.channel.delete(reason="ZetaModoki private conversation deleted by user")
        except discord.HTTPException:
            await interaction.followup.send(
                view=as_panel_v2(ZetaInfoView(discord.Embed(
                    title="スレッドを削除できませんでした",
                    description="Botのスレッド管理権限を確認してください。",
                    color=discord.Color.red()))),
                ephemeral=True,
            )
            return
        self.cog.active_personas.pop(self.thread_id, None)
        self.cog.chat_histories.pop(self.thread_id, None)
        self.cog.failed_requests.pop(self.thread_id, None)
        await interaction.followup.send(
            view=as_panel_v2(ZetaInfoView(discord.Embed(
                title="プライベートスレッドを削除しました", color=discord.Color.purple()))),
            ephemeral=True,
        )

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(discord.Embed(
            title="削除をキャンセルしました", color=discord.Color.purple()))))


class ModeButton(discord.ui.Button):
    def __init__(self, parent_view: "CharacterSelectView", mode: str, label: str, emoji: str, disabled: bool = False):
        self.parent_view, self.mode = parent_view, mode
        super().__init__(label=label, emoji=emoji, style=discord.ButtonStyle.primary, disabled=disabled, row=0)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view.mode = self.mode
        view.rebuild()
        await edit_panel_v2(interaction, as_panel_v2(view))


class ModeBackButton(discord.ui.Button):
    def __init__(self, parent_view: "CharacterSelectView"):
        self.parent_view = parent_view
        super().__init__(label="会話モードを選び直す", emoji=BACK, style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view.mode = None
        view.rebuild()
        await edit_panel_v2(interaction, as_panel_v2(view))


class CharacterSelect(discord.ui.Select):
    def __init__(self, cog, parent_view):
        self.cog = cog
        self.parent_view = parent_view
        options = [
            discord.SelectOption(
                label="るなち（〇〇しないと出られない部屋）",
                value="luna",
                description="条件をプレイヤーが決めるツンデレ幼馴染との閉じ込めシチュ",
                emoji="🚪"
            ),
            discord.SelectOption(
                label="アリス（雨宿りの図書室）",
                value="alice",
                description="放課後の図書室で二人きりの雨宿りシチュ",
                emoji=BOOK
            ),
            discord.SelectOption(
                label="エマ（崩壊したシェルター）",
                value="emma",
                description="アンドロイドのパートナーと過ごすサバイバルシチュ",
                emoji="🤖"
            ),
            discord.SelectOption(
                label="ユキ（雪の夜の駅）",
                value="yuki",
                description="終電を逃した駅で始発を待つ、静かな夜",
                emoji="❄️"
            ),
            discord.SelectOption(
                label="シオン（森の古代遺跡）",
                value="shion",
                description="見習い魔法使いと封印された遺跡を探索",
                emoji="✨"
            ),
            discord.SelectOption(
                label="ナオ（学園祭の前日）",
                value="nao",
                description="クラスメイトと学園祭の準備をする放課後",
                emoji="🎨"
            ),
            discord.SelectOption(
                label="レイ（流星群の天文台）",
                value="rei",
                description="天文部員と星空を観測する山頂の夜",
                emoji="🌠"
            ),
            discord.SelectOption(
                label="ハル（雨宿りの喫茶店）",
                value="haru",
                description="海辺の喫茶店で雨が止むのを待つ",
                emoji="☕"
            )
        ]
        # 自分が登録したシチュエーションを末尾に追加（本人にだけ表示される）
        for entry in cog.custom.list(parent_view.user_id):
            options.append(discord.SelectOption(
                label=_clip(f"{entry['name']}（登録）", 100),
                value=f"custom:{entry['id']}",
                description=_clip(entry["situation"], 100),
                emoji="⭐",
            ))
        super().__init__(placeholder="会話したいキャラクターを選択してください", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        if view.mode is None:
            return await interaction.response.send_message("先に会話モードを選択してください。", ephemeral=True)

        selected_key = self.values[0]
        if selected_key.startswith("custom:"):
            entry = self.cog.custom.get(interaction.user.id, selected_key.removeprefix("custom:"))
            if entry is None:
                return await interaction.response.send_message(
                    "その登録が見つかりません。削除された可能性があります。もう一度 `/general` から開始してください。",
                    ephemeral=True,
                )
            persona = self.cog.custom.to_persona(entry)
        else:
            persona = PRESETS[selected_key]

        target_channel = interaction.channel
        if view.mode == "private":
            if not isinstance(interaction.channel, discord.TextChannel):
                return await interaction.response.send_message(
                    "プライベートスレッドは通常のテキストチャンネルから開始してください。",
                    ephemeral=True,
                )
            thread = None
            try:
                thread = await interaction.channel.create_thread(
                    name=_clip(f"{persona.name}との会話", 100),
                    type=discord.ChannelType.private_thread,
                    invitable=False,
                    auto_archive_duration=1440,
                )
                await thread.add_user(interaction.user)
                target_channel = thread
            except discord.HTTPException:
                if thread is not None:
                    try:
                        await thread.delete(reason="Failed to add conversation starter")
                    except discord.HTTPException:
                        logger.debug("ZetaModoki: 失敗したスレッドの削除に失敗しました", exc_info=True)
                failed = discord.Embed(
                    title="プライベートスレッドを作成できませんでした",
                    description="Botに「プライベートスレッドの作成」「スレッドの管理」権限があるか確認してください。",
                    color=discord.Color.red(),
                )
                return await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(failed)))

        channel_id = target_channel.id
        self.cog.active_personas[channel_id] = persona
        self.cog.chat_histories[channel_id] = []
        self.cog.failed_requests.pop(channel_id, None)

        is_private_thread = (
            isinstance(target_channel, discord.Thread)
            and target_channel.type == discord.ChannelType.private_thread
        )
        mode_text = "プライベートスレッド" if is_private_thread else "公開チャンネル"
        started = discord.Embed(
            title=f"【{persona.name}】で会話を開始します",
            description=f"会話先: {target_channel.mention}（{mode_text}）",
            color=discord.Color.purple(),
        )
        await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(started)))

        # チャンネル(スレッド)全体に見えるお知らせ
        embed = discord.Embed(
            title=f"【{persona.name}】との会話を開始しました！",
            description=(
                f"**シチュエーション:**\n{persona.situation}\n\n"
                "-# 下の「返信する」ボタンから入力して対話を進めてください"
            ),
            color=discord.Color.purple()
        )
        await target_channel.send(view=as_panel_v2(ZetaInfoView(embed)))

        # キャラクターの初期メッセージを Webhook で送信
        first_msg_formatted = self.cog._format_narration(persona.first_message)
        try:
            await self.cog._send_webhook_message(
                channel=target_channel,
                channel_id=channel_id,
                content=first_msg_formatted
            )
        except Exception as e:
            await target_channel.send(
                f"**{persona.name}**: {first_msg_formatted}",
                view=ChatButtonView(self.cog, private_thread=is_private_thread),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            logger.warning("Webhook送信エラー: %s", e)


class CharacterSelectView(discord.ui.View):
    """① 公開/プライベートを選ぶ → ② キャラクターを選ぶ。モード未選択ではキャラを選べない。"""

    def __init__(self, cog, user_id: int, private_ok: bool = True):
        super().__init__(timeout=120)
        self.cog = cog
        self.user_id = user_id
        self.private_ok = private_ok
        self.mode: str | None = None
        self.rebuild()

    def rebuild(self):
        self.clear_items()
        if self.mode is None:
            self.add_item(ModeButton(self, "public", "公開チャンネル", "📢"))
            self.add_item(ModeButton(self, "private", "プライベートスレッド", "🔒", disabled=not self.private_ok))
        else:
            self.add_item(CharacterSelect(self.cog, self))
            self.add_item(ModeBackButton(self))

    def embed(self) -> discord.Embed:
        if self.mode is None:
            lines = [
                "会話を行う場所を選んでください。",
                "",
                "**📢 公開チャンネル**",
                "このチャンネルで会話します。他のメンバーにも見えます。",
                "",
                "**🔒 プライベートスレッド**",
                "あなたとBotだけが見えるスレッドを作って会話します。",
            ]
            if not self.private_ok:
                lines += ["", "-# ここは通常のテキストチャンネルではないため、プライベートスレッドは選べません。"]
            return discord.Embed(title="ZetaModoki — 会話モードの選択",
                                 description="\n".join(lines), color=discord.Color.purple())
        label = "公開チャンネル" if self.mode == "public" else "プライベートスレッド"
        return discord.Embed(
            title="ZetaModoki — キャラクターの選択",
            description=f"会話モード: **{label}**\n会話したいキャラクターを選んでください。選ぶとすぐに開始します。",
            color=discord.Color.purple(),
        )
