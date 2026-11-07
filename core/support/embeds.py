# -*- coding: utf-8 -*-
"""embed 構築の共通ヘルパー。

文言の単一置き場である core/support/messages.py とは役割を分け、こちらは
embed の様式（色などの構造）だけを持つ。各機能で複製されていた
白基調の embed 工場 `we()` をここに集約した。
"""
from __future__ import annotations

import discord

WHITE = 0xFFFFFF


def we(description: str | None = None, title: str | None = None,
       color: int = WHITE) -> discord.Embed:
    """白基調の embed を作る。基調色の違う機能は color で上書きする。"""
    return discord.Embed(title=title, description=description, color=color)
