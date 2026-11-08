# -*- coding: utf-8 -*-
"""「添付ファイル/画像の投稿待ち」フローの共通部品（GEN-26 集約）。

meme と fast_html で同型だった、キャンセルボタン付きの待ち受けと
「メッセージ受信 vs キャンセル」の競合解決をここに寄せる。
検証と発行処理だけが各機能側に残る。
"""
from __future__ import annotations

import asyncio
import logging

import discord

logger = logging.getLogger(__name__)


class AttachmentWaitCancelView(discord.ui.View):
    """投稿待ちをキャンセルするボタン。

    waits_attr は cog 側の待ち辞書の属性名（例: "_meme_waits"）。
    """

    def __init__(self, cog, waits_attr: str, key, user_id: int, *,
                 timeout: float, cancel_text: str):
        super().__init__(timeout=timeout)
        self.cog = cog
        self.waits_attr = waits_attr
        self.key = key
        self.user_id = user_id
        self.cancel_text = cancel_text

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        event = getattr(self.cog, self.waits_attr).get(self.key)
        if event is not None:
            event.set()
        await interaction.response.edit_message(content=self.cancel_text, view=None)


async def wait_for_attachment(bot, *, check, event, timeout: float):
    """メッセージ受信とキャンセルを競合させる。

    戻り値は ("message", msg) / ("cancel", None) / ("timeout", None)。
    生成したタスクの後始末もここで行う。
    """
    msg_task = asyncio.ensure_future(bot.wait_for("message", check=check))
    cancel_task = asyncio.ensure_future(event.wait())
    try:
        done, _pending = await asyncio.wait(
            {msg_task, cancel_task}, timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if cancel_task in done:
            return "cancel", None
        if msg_task not in done:
            return "timeout", None
        return "message", msg_task.result()
    finally:
        for task in (msg_task, cancel_task):
            task.cancel()


async def edit_original_response_quietly(interaction, label: str, **kwargs) -> None:
    """元の応答メッセージを編集する（失敗しても待ち処理は止めない）。"""
    try:
        await interaction.edit_original_response(**kwargs)
    except discord.HTTPException:
        logger.debug("%s: 応答メッセージの編集に失敗しました", label, exc_info=True)
