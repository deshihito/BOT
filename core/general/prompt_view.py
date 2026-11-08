# -*- coding: utf-8 -*-
"""本人だけが操作できる確認/補完ビューの共通基底（GEN-09 集約）。

pay 確認・/quick の引数補完・AI tools の確認/補完で同型に複製されていた
所有者チェック・全ボタン無効化・タイムアウト後始末をここに寄せる。
タイムアウト時の文面だけは timeout_text() で各ビューが決める。
"""
from __future__ import annotations

import logging

import discord

logger = logging.getLogger(__name__)


class OwnerPromptView(discord.ui.View):
    """所有者だけが押せるプロンプト系ビューの基底。"""

    def __init__(self, *, owner_id: int, timeout: float):
        super().__init__(timeout=timeout)
        self.owner_id = owner_id
        self.message: discord.Message | None = None
        self.finished = False

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner_id

    def _disable_all(self) -> None:
        for child in self.children:
            child.disabled = True

    def timeout_text(self) -> str:
        return "時間切れのため実行しませんでした。"

    async def on_timeout(self) -> None:
        if self.finished or self.message is None:
            return
        self._disable_all()
        try:
            await self.message.edit(content=self.timeout_text(), view=self)
        except Exception:
            logger.debug("prompt view timeout edit failed", exc_info=True)
