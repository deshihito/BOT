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
from core.game.zeta.chat_ui import logger, ResponseModal, ChatButtonView, DeleteThreadConfirmView, ModeButton, ModeBackButton, CharacterSelect, CharacterSelectView  # noqa: F401
from core.game.zeta.common import logger, BotPersona, PRESETS, MAX_CUSTOM_PER_USER, DEFAULT_ICON_URL, CUSTOM_FILE, _FORBIDDEN_NAME_WORDS, _clip, validate_custom_fields  # noqa: F401
from core.game.zeta.custom_ui import logger, CustomPersonaModal, CustomEntrySelect, CustomManageView, CustomDeleteConfirmView, ZetaInfoView  # noqa: F401
from core.game.zeta.store import logger, CustomSituationStore  # noqa: F401

logger = logging.getLogger("cogs.zetamodoki")


class ZetaModoki(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        # ロールプレイ向けの会話品質を優先し、LogfareのGemma 4 26Bを既定にする。
        default_model = "gemma-4-26b"
        self.model_name = os.getenv("LOGFARE_ZETAMODOKI_MODEL", default_model).strip() or default_model

        # チャンネルID (int) をキーとして管理
        self.active_personas: Dict[int, BotPersona] = {}
        self.chat_histories: Dict[int, List[dict]] = {}
        self.failed_requests: Dict[int, dict] = {}
        # ユーザー登録シチュエーション（1人3個まで）
        self.custom = CustomSituationStore()

    async def start(self, interaction: discord.Interaction):
        view = CharacterSelectView(
            self, interaction.user.id,
            private_ok=isinstance(interaction.channel, discord.TextChannel),
        )
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def register(self, interaction: discord.Interaction):
        """キャラクター＋シチュエーションの新規登録フォームを開く。"""
        if not isinstance(interaction, discord.Interaction):
            return await interaction.response.send_message(
                "登録には入力フォームが必要なため、`/general` のパネルから実行してください。")
        if len(self.custom.list(interaction.user.id)) >= MAX_CUSTOM_PER_USER:
            return await interaction.response.send_message(
                f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。「登録を管理」から不要な登録を削除してください。",
                ephemeral=True,
            )
        await interaction.response.send_modal(CustomPersonaModal(self, interaction.user.id))

    async def manage(self, interaction: discord.Interaction):
        """登録済みシチュエーションの管理画面（本人にだけ表示）。"""
        if not isinstance(interaction, discord.Interaction):
            return await interaction.response.send_message(
                "管理画面は本人にだけ表示する必要があるため、`/general` のパネルから実行してください。")
        view = CustomManageView(self, interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def reset(self, interaction: discord.Interaction):
        channel_id = interaction.channel_id
        if channel_id in self.chat_histories:
            self.chat_histories[channel_id] = []
            self.failed_requests.pop(channel_id, None)
            await interaction.response.send_message("このチャンネルの会話履歴をリセットしました。", ephemeral=True)
        else:
            await interaction.response.send_message("リセットする会話履歴がありません。", ephemeral=True)

    def _format_narration(self, text: str) -> str:
        """カッコ （） や () で囲まれたナレーション表現の前に -# を挿入して薄文字化する"""
        text = re.sub(r'（(.*?)）', r'\n-# （\1）\n', text)
        text = re.sub(r'\((.*?)\)', r'\n-# (\1)\n', text)
        text = re.sub(r'\n+', '\n', text).strip()
        return text

    async def _get_or_create_webhook(self, channel: discord.TextChannel | discord.Thread) -> discord.Webhook:
        """親テキストチャンネルから管理用Webhookを取得または作成する"""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        if not isinstance(parent, discord.TextChannel):
            raise RuntimeError("Webhookの親テキストチャンネルを取得できませんでした。")
        webhooks = await parent.webhooks()
        for wh in webhooks:
            if wh.name == "ZetaModoki_Webhook":
                return wh
        return await parent.create_webhook(name="ZetaModoki_Webhook")

    async def _send_webhook_message(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        content: str,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        include_view: bool = True,
    ):
        """キャラクターの名前・アイコンを設定し、長文を分割して送る"""
        persona = self.active_personas.get(channel_id)
        if not persona:
            return

        webhook = await self._get_or_create_webhook(channel)
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        send_kwargs = {"thread": channel} if isinstance(channel, discord.Thread) else {}
        parts = self._split_long_message(content)
        sent_messages = []
        for index, part in enumerate(parts):
            view = None
            if include_view and index == len(parts) - 1:
                view = ChatButtonView(
                    self,
                    retry_owner_id=retry_owner_id,
                    retry_input=retry_input,
                    private_thread=private_thread,
                )
            message_kwargs = dict(
                content=part,
                username=persona.name,
                avatar_url=persona.icon_url,
                allowed_mentions=discord.AllowedMentions.none(),
                # AI生成のロールプレイ本文は動的コンテンツなので、静的UI文向けの
                # 送信時翻訳（断片置換）の対象外にする。英語設定サーバーで本文が
                # 置換で崩れ、表示と会話履歴（原文保持）が食い違うのを防ぐ。
                # !ai 本体（cogs/ai.py の _reply_without_localization）と同じ扱い。
                _agobot_skip_localization=True,
                **send_kwargs,
                wait=True,
            )
            if view is not None:
                message_kwargs["view"] = view
            message = await webhook.send(**message_kwargs)
            if message is not None:
                sent_messages.append(message)
        return sent_messages

    async def _send_streamed_response(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        user_input: str,
        requester_id: int,
    ):
        """Logfareの生成差分を文単位で送り、失敗時は再試行ボタンを付ける。"""
        pending = ""
        last_message = None

        async def send_ready_text(delta: str):
            nonlocal pending, last_message
            pending += delta
            while True:
                cut = self._ready_stream_cut(pending)
                if cut is None:
                    break
                part, pending = pending[:cut], pending[cut:]
                sent = await self._send_webhook_message(
                    channel=channel,
                    channel_id=channel_id,
                    content=self._format_narration(part.strip()),
                    include_view=False,
                )
                if sent:
                    last_message = sent[-1]

        response_text = await self._generate_response(
            channel_id,
            user_input,
            on_delta=send_ready_text,
            requester_id=requester_id,
        )
        is_error = response_text.startswith(("（エラーが発生しました:", "（AIから返答がありませんでした"))
        if pending.strip():
            sent = await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(pending.strip()),
                include_view=not is_error,
            )
            if sent:
                last_message = sent[-1]
        if is_error:
            await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(response_text),
                retry_owner_id=requester_id,
                retry_input=user_input,
            )
        elif pending.strip() == "" and last_message is not None:
            private_thread = (
                isinstance(channel, discord.Thread)
                and channel.type == discord.ChannelType.private_thread
            )
            await last_message.edit(
                view=ChatButtonView(self, private_thread=private_thread)
            )
        return response_text

    @staticmethod
    def _split_long_message(text: str, limit: int = 1800) -> list[str]:
        """Discordの本文上限を越えないよう、文境界を優先して分割する。"""
        chunks = []
        while len(text) > limit:
            candidates = [
                text.rfind(mark, 0, limit) + len(mark)
                for mark in ("\n", "。", "！", "？", "!", "?")
                if text.rfind(mark, 0, limit) >= 0
            ]
            cut = max(candidates, default=0)
            if cut < limit // 2:
                cut = limit
            chunks.append(text[:cut])
            text = text[cut:]
        if text:
            chunks.append(text)
        return chunks

    @staticmethod
    def _ready_stream_cut(text: str) -> int | None:
        """文末が届いたら送信し、長い未完文も上限内で順次表示する。"""
        limit = 1400
        search_text = text[:limit]
        boundaries = [
            search_text.rfind(mark) + len(mark)
            for mark in ("\n", "。", "！", "？", "!", "?", "…")
            if search_text.rfind(mark) >= 0
        ]
        boundary = max(boundaries, default=0)
        if boundary >= 60:
            return boundary
        if len(text) >= limit:
            return limit
        if len(text) >= 500:
            return 500
        return None

    async def _generate_response(
        self,
        channel_id: int,
        user_input: str,
        on_delta=None,
        requester_id: int | None = None,
    ) -> str:
        persona = self.active_personas[channel_id]
        history = self.chat_histories.get(channel_id, [])

        messages = [{"role": "system", "content": persona.build_system_instruction()}]
        # 最初の発言も含め、assistant/userの対話順をLogfareへ渡して人格と文脈を維持する。
        messages.append({"role": "assistant", "content": persona.first_message})
        for turn in history:
            messages.append({"role": "user", "content": turn["user"]})
            messages.append({"role": "assistant", "content": turn["bot"]})
        messages.append({"role": "user", "content": user_input})

        try:
            reply_parts = []
            async for delta in logfare.chat_stream(self.model_name, messages, max_tokens=2400):
                reply_parts.append(delta)
                if on_delta is not None:
                    await on_delta(delta)
            bot_reply = "".join(reply_parts).strip()
            if not bot_reply.strip():
                if requester_id is not None:
                    self.failed_requests[channel_id] = {
                        "user_id": requester_id,
                        "user_input": user_input,
                    }
                return "（AIから返答がありませんでした。少し待ってからもう一度試してください。）"

            # 履歴管理（直近20件）
            history.append({"user": user_input, "bot": bot_reply})
            if len(history) > 20:
                history = history[-20:]
            self.chat_histories[channel_id] = history
            self.failed_requests.pop(channel_id, None)

            return bot_reply

        except Exception as e:
            if requester_id is not None:
                self.failed_requests[channel_id] = {
                    "user_id": requester_id,
                    "user_input": user_input,
                }
            return f"（エラーが発生しました: {e}）"


async def setup(bot: commands.Bot):
    await bot.add_cog(ZetaModoki(bot))
