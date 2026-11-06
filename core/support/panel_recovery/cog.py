# -*- coding: utf-8 -*-
"""再起動で死んだ操作パネルの再表示フォールバック (PR-B)。

操作パネル (/general /vc /support /game /help) の View はプロセスメモリにしか
存在しないため、Bot が再起動すると Discord 側に残ったメッセージの部品を押しても
応答する View が無く「応答しませんでした」になる。各部品には固定 custom_id
``panel:<root>:<part>`` が付いている (core/general/panel.py 等) ので、この cog が
死んだパネルの受け口になり、押した本人にだけ新しいパネルを ephemeral で開き直す。

二重応答の防止について (discord.py 2.7.1 の実装根拠):
- component interaction は ``ConnectionState.parse_interaction_create``
  (discord/state.py) が先に ``ViewStore.dispatch_view`` を呼び、生存中の View が
  あればその item の callback を task として起動し、その後で
  ``dispatch('interaction')`` により Cog の on_interaction リスナーへ届く。
- ただし View 側 callback は task として並行に走るため、リスナー実行時点で
  「callback が応答済み」とは限らない。そこで短時間 (RECOVERY_WAIT_SECONDS)
  待ってから ``interaction.response.is_done()`` を確認し、応答済みなら何もしない。
- is_done() は応答の HTTP 完了後に立つ (discord/interactions.py:
  ``_response_type is not None``) ため、待機をすり抜けた競合もあり得る。
  その場合こちらの send_message は InteractionResponded で失敗するので、
  それを握って静かに終わる (利用者には生存中の View の応答が見える)。
"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands

from core.support.panel_v2 import as_panel_v2

logger = logging.getLogger(__name__)


def _recovery_wait_seconds():
    """RECOVERY_WAIT_SECONDS is held by the cogs.panel_recovery entry (tests patch it there)."""
    from cogs.panel_recovery import RECOVERY_WAIT_SECONDS
    return RECOVERY_WAIT_SECONDS

CUSTOM_ID_PREFIX = "panel:"

KNOWN_ROOTS = frozenset({"general", "vc", "support", "game", "help"})

FALLBACK_MESSAGE = "パネルを再表示できませんでした。お手数ですが、コマンドをもう一度実行してください。"


def build_panel(bot, root: str):
    """root に対応する新しいパネル View を、スラッシュコマンドと同じ経路で作る。

    対象 cog が読み込まれていない場合は None を返す。
    """
    if root == "general":
        cog = bot.get_cog("GeneralCog")
        if cog is None:
            return None
        from core.general.panel import GeneralPanel

        return GeneralPanel(cog)
    if root == "vc":
        hub = bot.get_cog("VoiceHub")
        if hub is None:
            return None
        from cogs.sio_voice import VoicePanelView

        return VoicePanelView(hub)
    if root == "support":
        cog = bot.get_cog("SupportCog")
        if cog is None:
            return None
        from core.support.panel import SupportPanelView

        return SupportPanelView(cog)
    if root == "game":
        cog = bot.get_cog("GameHub")
        if cog is None:
            return None
        from cogs.game import GameHubView

        return GameHubView(cog)
    if root == "help":
        cog = bot.get_cog("HelpCog")
        if cog is None:
            return None
        from cogs.help import HelpView

        return HelpView(cog.catalog())
    return None


class PanelRecoveryCog(commands.Cog):
    """死んだ操作パネル (custom_id が ``panel:`` で始まる部品) の受け口。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return
        data = interaction.data or {}
        custom_id = data.get("custom_id") or ""
        if not custom_id.startswith(CUSTOM_ID_PREFIX):
            return
        root = custom_id[len(CUSTOM_ID_PREFIX):].split(":", 1)[0]
        if root not in KNOWN_ROOTS:
            return

        # 生存中の View の callback (task として起動済み) が応答するのを待つ。
        await asyncio.sleep(_recovery_wait_seconds())
        if interaction.response.is_done():
            return

        try:
            panel = build_panel(self.bot, root)
            if panel is None:
                await interaction.response.send_message(FALLBACK_MESSAGE, ephemeral=True)
                return
            # 元のパネルが他人のものでも、押した本人の新しいパネルを出す。
            # 元のメッセージ自体は編集・削除しない。
            await interaction.response.send_message(view=as_panel_v2(panel), ephemeral=True)
        except discord.InteractionResponded:
            # 待機中に生存中の View が応答した競合。何もしない。
            logger.debug("panel recovery: 競合のため再表示を中止しました (%s)", custom_id)
        except Exception:
            logger.exception("panel recovery: パネルの再表示に失敗しました (%s)", custom_id)
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(FALLBACK_MESSAGE, ephemeral=True)
            except Exception:
                logger.debug("panel recovery: 案内文の送信にも失敗しました", exc_info=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(PanelRecoveryCog(bot))
