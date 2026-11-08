# -*- coding: utf-8 -*-
"""再起動で死んだ操作パネルの再表示フォールバック (PR-B)。

操作パネル (/general /vc /support /game /help) の View はプロセスメモリにしか
存在しないため、Bot が再起動すると Discord 側に残ったメッセージの部品を押しても
応答する View が無く「応答しませんでした」になる。各部品には固定 custom_id
``panel:<root>:<part>`` が付いている (core/general/panel.py 等) ので、この cog が
死んだパネルの受け口になり、押した本人にだけ新しいパネルを ephemeral で開き直す。

二重応答の防止と待機の要否について (discord.py 2.7.1 の実装根拠):
- component interaction は ``ConnectionState.parse_interaction_create``
  (discord/state.py) が先に ``ViewStore.dispatch_view`` を呼び、生存中の View が
  あればその item の callback を task として起動し、その後で
  ``dispatch('interaction')`` により Cog の on_interaction リスナーへ届く。
- dispatch_view はリスナーより先に同期実行されるため、ViewStore を
  dispatch_view と同じ引き方 (message_id → 無ければ永続 View のバケット、
  キーは (component_type, custom_id)) で確認すれば、「生存中の callback が
  起動したか」を待たずに判定できる。item が無い / item.view が None
  (本番で "unknown view ... Discarding" になるケース) / View が終了済みなら、
  誰も応答しないことが確定するので、待機せず即座に再表示する。
  旧実装はこの確定ケースでも一律 RECOVERY_WAIT_SECONDS (1.5秒) 待っており、
  起動直後の高負荷 (配送遅延 + 応答 HTTP の遅延) と重なると Discord の
  初回応答期限 (3秒) を超え、再表示が 10062 Unknown interaction で
  失敗していた (2026-11-08 実機)。
- item があり View が生存している場合だけ、callback の応答を
  RECOVERY_WAIT_SECONDS を上限にポーリングで待つ。is_done() は応答の
  HTTP 完了後に立つ (discord/interactions.py: ``_response_type is not None``)
  ため、上限まで応答が無ければ従来どおり再表示に進む。その場合も
  send_message が InteractionResponded で失敗し得るので、それを握って
  静かに終わる (利用者には生存中の View の応答が見える)。
- ViewStore の内部構造が想定と違う等で判定できない場合は「応答する
  見込みあり」に倒して従来どおり待つ (安全側)。
"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ext import commands

from core.support.panel_v2 import as_panel_v2

logger = logging.getLogger(__name__)


def _recovery_wait_seconds():
    """RECOVERY_WAIT_SECONDS is held by the cogs.support entry (tests patch it there)."""
    from cogs.support import RECOVERY_WAIT_SECONDS
    return RECOVERY_WAIT_SECONDS

CUSTOM_ID_PREFIX = "panel:"

KNOWN_ROOTS = frozenset({"general", "vc", "support", "game", "help"})

FALLBACK_MESSAGE = "パネルを再表示できませんでした。お手数ですが、コマンドをもう一度実行してください。"

# 生存中 callback の応答をポーリングする間隔 (秒)。
RECOVERY_POLL_INTERVAL_SECONDS = 0.05

# interaction 自体が失効していることを示す Discord エラーコード。
UNKNOWN_INTERACTION_CODE = 10062


def _live_callback_expected(bot, interaction: discord.Interaction) -> bool:
    """生存中の View の callback がこの interaction に応答する見込みがあるか。

    ``ViewStore.dispatch_view`` (discord.py 2.7.1) と同じ引き方で store を
    確認する。dispatch_view は on_interaction リスナーより先に実行済みなので、
    ここで item が引けない / item.view が None / View が終了済みなら、
    callback は起動しておらず誰も応答しないことが確定する (False)。
    判定材料が欠ける・想定外の構造だった場合は True (待つ側 = 安全側)。
    """
    try:
        store = bot._connection._view_store
        views = store._views
        data = interaction.data or {}
        custom_id = data.get("custom_id") or ""
        # DynamicItem のテンプレートに一致する場合は動的 callback が応答し得る。
        for pattern in getattr(store, "_dynamic_items", None) or ():
            if pattern.fullmatch(custom_id):
                return True
        key = (data.get("component_type"), custom_id)
        item = None
        message = getattr(interaction, "message", None)
        message_id = getattr(message, "id", None)
        if message_id is not None:
            item = views.get(message_id, {}).get(key)
        if item is None:
            # 永続 View (message_id なしで登録されたもの) のバケット。
            item = views.get(None, {}).get(key)
        if item is None:
            return False
        view = item.view
        if view is None or view.is_finished():
            return False
        return True
    except Exception:
        return True


async def _wait_for_live_response(interaction: discord.Interaction, timeout: float) -> bool:
    """生存中 callback の応答を最大 timeout 秒ポーリングし、応答したら True。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout, 0.0)
    while True:
        if interaction.response.is_done():
            return True
        remaining = deadline - loop.time()
        if remaining <= 0:
            return False
        await asyncio.sleep(min(RECOVERY_POLL_INTERVAL_SECONDS, remaining))


async def _send_fallback_message(interaction: discord.Interaction) -> None:
    try:
        if not interaction.response.is_done():
            await interaction.response.send_message(FALLBACK_MESSAGE, ephemeral=True)
    except Exception:
        logger.debug("panel recovery: 案内文の送信にも失敗しました", exc_info=True)


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
        from cogs.vc import VoicePanelView

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

        if _live_callback_expected(self.bot, interaction):
            # 生存中の View の callback (task として起動済み) が応答するのを待つ。
            await _wait_for_live_response(interaction, _recovery_wait_seconds())
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
        except discord.NotFound as exc:
            if getattr(exc, "code", None) == UNKNOWN_INTERACTION_CODE:
                # interaction 自体が既に失効している。復旧しようがないので
                # traceback なしで静かに終わる (案内文も届かない)。
                logger.info(
                    "panel recovery: interaction が失効していたため再表示できませんでした (%s)",
                    custom_id,
                )
                return
            logger.exception("panel recovery: パネルの再表示に失敗しました (%s)", custom_id)
            await _send_fallback_message(interaction)
        except Exception:
            logger.exception("panel recovery: パネルの再表示に失敗しました (%s)", custom_id)
            await _send_fallback_message(interaction)


async def setup(bot: commands.Bot):
    await bot.add_cog(PanelRecoveryCog(bot))
