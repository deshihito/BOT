# -*- coding: utf-8 -*-
"""自分の結果を任意で公開するための小さなビュー（表示モダン化 §4.2-11）。

デフォルトは本人のみ（ephemeral）で表示し、本人が「公開で出す」を
押したときだけ同じ内容をチャンネルへ公開する選択式（C）の導線。
操作は実行した本人だけに限定する（§4.2-10 の interaction_check）。
"""
from __future__ import annotations

from typing import Callable, Union

import discord

EmbedSource = Union[discord.Embed, Callable[[], discord.Embed]]


class PublicShareView(discord.ui.View):
    """ephemeral な結果表示に付ける「公開で出す」ボタン。"""

    def __init__(self, owner_id: int, embed_source: EmbedSource, *, timeout: float = 300):
        super().__init__(timeout=timeout)
        self.owner_id = owner_id
        self._embed_source = embed_source

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.owner_id

    def _embed(self) -> discord.Embed:
        source = self._embed_source
        return source() if callable(source) else source

    @discord.ui.button(label="公開で出す", style=discord.ButtonStyle.primary)
    async def share(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.channel is None:
            return await interaction.response.send_message(
                "公開できるチャンネルがありません。", ephemeral=True)
        await interaction.channel.send(embed=self._embed())
        await interaction.response.send_message("チャンネルに公開しました。", ephemeral=True)
