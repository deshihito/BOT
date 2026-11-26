# -*- coding: utf-8 -*-
"""パネル操作の自動 ACK（defer）基盤。

Discord の component / modal_submit interaction は、初回応答まで約3秒しか
猶予がない。パネルの callback は読み込み（DB/API の往復、最悪10秒級の
タイムアウト設定）や画像生成を応答前に挟むことが多く、読み込み時間だけで
制限を超えて「応答しませんでした」になる事故が多発していた。個別 callback
への defer 先行は行き渡っておらず（監査: 対象 callback の約8割が defer
なし）、付け忘れがそのまま事故になる。

そこで View のディスパッチ（``BaseView._scheduled_task``）にタイマー式の
ウォッチドッグを1箇所だけ差し込み、全 View 共通で担保する:

- callback 開始と同時にタイマーを張り、``AUTO_DEFER_DELAY_SECONDS`` を
  超えても未応答なら ``interaction.response.defer()`` で ACK する。
  component では deferred_message_update（無表示）なので、速い callback
  の見た目は一切変わらない。
- ACK 済みの後段は、既存の is_done 対応ヘルパー
  （``edit_panel_v2`` / ``refresh_panel`` / followup 分岐）がそのまま
  ``edit_original_response`` / ``followup.send`` へ流れる。
- panel_recovery の生存判定（1.5秒）より前に ACK が始まるよう、遅延は
  1.25秒に置く。死んだ View はディスパッチ自体が走らないため、この
  ウォッチドッグは発火せず、recovery の再表示が従来どおり働く。

外し方（モーダルを開く callback など、defer と両立しない経路向け）:

- View クラス/インスタンスに ``auto_defer = False`` を置く
- item の callback 関数に ``@auto_defer_exempt`` を付ける

modal_submit は thinking 付き defer（送信が新規メッセージになる前提の
経路）で ACK する。スラッシュコマンド本体は View ディスパッチを通らない
ため対象外（入口側は従来どおり個別に defer する）。
"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord.ui.modal import Modal
from discord.ui.view import BaseView

logger = logging.getLogger(__name__)

__all__ = [
    "AUTO_DEFER_DELAY_SECONDS",
    "auto_defer_exempt",
    "defer_if_not_done",
    "send_or_followup",
    "install_auto_defer",
]

#: 初回応答の制限（約3秒）と panel_recovery の生存判定（1.5秒）の両方に
#: 間に合わせるための、自動 defer までの猶予。
AUTO_DEFER_DELAY_SECONDS = 1.25

_original_scheduled_task = BaseView._scheduled_task
_original_modal_scheduled_task = Modal._scheduled_task
_installed = False


def auto_defer_exempt(func):
    """この callback を自動 defer の対象外にする（モーダル起動系など）。"""
    func.__auto_defer_exempt__ = True
    return func


async def defer_if_not_done(interaction: discord.Interaction, **kwargs) -> bool:
    """未応答なら defer して True、応答済みなら何もせず False を返す。

    defer 自体の失敗（競合で応答済みになった等）は握って False を返す。
    呼び出し側は戻り値に依らず、後段を is_done 対応ヘルパー /
    ``send_or_followup`` で送ればよい。
    """
    try:
        if interaction.response.is_done():
            return False
    except Exception:
        return False
    try:
        await interaction.response.defer(**kwargs)
    except Exception:
        logger.debug("auto_defer: defer に失敗しました", exc_info=True)
        return False
    return True


async def send_or_followup(interaction: discord.Interaction, *args, **kwargs):
    """新規メッセージ送信を、応答済みなら followup で届ける。

    自動 defer や先行 defer で応答済みになった interaction に対して
    ``response.send_message`` を呼ぶと InteractionResponded で落ち、
    処理結果が利用者に届かなくなる。その吸収をここに集約する。
    """
    if interaction.response.is_done():
        return await interaction.followup.send(*args, **kwargs)
    return await interaction.response.send_message(*args, **kwargs)


def _is_exempt(view, item) -> bool:
    if getattr(view, "auto_defer", True) is False:
        return True
    if getattr(item, "auto_defer", True) is False:
        return True
    callback = getattr(item, "callback", None)
    if getattr(callback, "__auto_defer_exempt__", False):
        return True
    return False


async def _watchdog(view, item, interaction) -> None:
    try:
        await asyncio.sleep(AUTO_DEFER_DELAY_SECONDS)
    except asyncio.CancelledError:
        return
    if _is_exempt(view, item):
        return
    if getattr(interaction, "type", None) is discord.InteractionType.modal_submit:
        # モーダル送信の後段は新規メッセージ送信が前提のため、
        # thinking 付き（deferred_channel_message）で ACK する。
        await defer_if_not_done(interaction, thinking=True)
    else:
        await defer_if_not_done(interaction)


async def _scheduled_task_with_auto_defer(self, item, interaction):
    watchdog: asyncio.Task | None = None
    if getattr(interaction, "type", None) is discord.InteractionType.component \
            and not _is_exempt(self, item):
        watchdog = asyncio.ensure_future(_watchdog(self, item, interaction))
    try:
        return await _original_scheduled_task(self, item, interaction)
    finally:
        if watchdog is not None:
            watchdog.cancel()


async def _modal_scheduled_task_with_auto_defer(self, interaction, components, namespace):
    # Modal は BaseView._scheduled_task を使わず独自シグネチャで
    # on_submit をディスパッチするため、こちらにも同じ型を差し込む。
    watchdog: asyncio.Task | None = None
    if getattr(interaction, "type", None) is discord.InteractionType.modal_submit \
            and getattr(self, "auto_defer", True) is not False:
        watchdog = asyncio.ensure_future(_watchdog(self, None, interaction))
    try:
        return await _original_modal_scheduled_task(self, interaction, components, namespace)
    finally:
        if watchdog is not None:
            watchdog.cancel()


def install_auto_defer() -> bool:
    """全 View のディスパッチへ自動 defer ウォッチドッグを差し込む。

    二重に呼んでも安全（2回目以降は何もしない）。戻り値は今回差し込んだか。
    """
    global _installed
    if _installed:
        return False
    BaseView._scheduled_task = _scheduled_task_with_auto_defer
    Modal._scheduled_task = _modal_scheduled_task_with_auto_defer
    _installed = True
    logger.info(
        "auto_defer: ウォッチドッグを有効化しました (delay=%.2fs)",
        AUTO_DEFER_DELAY_SECONDS,
    )
    return True
