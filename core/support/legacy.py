"""スラッシュコマンドとプレフィックスコマンドの返信の違いを吸収する部品。

- ``Responder``: commands.Context と discord.Interaction のどちらからでも同じ書き方で返信できる薄い包み。
  /music・/voice の実装関数（``_xxx_impl``）はこれを受け取る。

旧コマンド（/play・!rec など）から新しいコマンドへ案内する ``legacy`` デコレーターは、
旧コマンドを削除したときに一緒に消した。モジュール名は import している場所が多いのでそのまま残している。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def is_interaction(source) -> bool:
    return hasattr(source, "response") and hasattr(source, "followup")


# 一時的なステータスログ（VC参加・読み上げ開始/停止など、流れてよい通知）の
# 自動削除までの秒数。チャンネルに残し続けるとログで埋まるため、短時間だけ出す。
TRANSIENT_LOG_DELETE_AFTER_SECONDS = 15


async def _delete_message_later(message: Any, delay: float) -> None:
    try:
        await asyncio.sleep(delay)
        await message.delete()
    except Exception:
        # 既に消えている・権限がない等は無視する（自動削除はベストエフォート）。
        logger.debug("メッセージの自動削除に失敗しました", exc_info=True)


def schedule_message_delete(message: Any, delay: float) -> None:
    """``delay`` 秒後にメッセージを消すタスクを予約する。

    discord.py の ``Webhook.send``（interaction.followup）は ``delete_after``
    引数に対応していないため、followup 経由の自動削除はこちらで行う。
    """
    asyncio.ensure_future(_delete_message_later(message, delay))


class Responder:
    """ctx / interaction の違いを吸収する。"""

    def __init__(self, source):
        self.source = source
        self.is_interaction = is_interaction(source)

    @property
    def guild(self):
        return getattr(self.source, "guild", None)

    @property
    def guild_id(self) -> Optional[int]:
        guild = self.guild
        return guild.id if guild is not None else getattr(self.source, "guild_id", None)

    @property
    def user(self):
        return getattr(self.source, "user", None) if self.is_interaction else getattr(self.source, "author", None)

    @property
    def channel(self):
        return getattr(self.source, "channel", None)

    @property
    def voice_client(self):
        guild = self.guild
        return getattr(guild, "voice_client", None) if guild is not None else None

    @property
    def attachments(self) -> list:
        message = getattr(self.source, "message", None)
        return list(getattr(message, "attachments", None) or []) if not self.is_interaction else []

    def is_done(self) -> bool:
        return bool(self.is_interaction and self.source.response.is_done())

    async def defer(self, *, ephemeral: bool = False) -> None:
        if self.is_interaction and not self.source.response.is_done():
            await self.source.response.defer(ephemeral=ephemeral)

    async def send(self, content: Any = None, *, embed=None, view=None, file=None, ephemeral: bool = False,
                   want_message: bool = False, skip_localization: bool = False,
                   delete_after: Optional[float] = None):
        """返信する。``want_message`` のときは送ったメッセージを返す（あとで編集するため）。

        ``delete_after`` を渡すと、送信したメッセージがその秒数後に自動で
        消える。一時的なステータスログ用（TRANSIENT_LOG_DELETE_AFTER_SECONDS）。
        followup（Webhook）経路は discord.py の ``delete_after`` 非対応のため、
        送信後に ``schedule_message_delete`` で手動削除する。
        """
        kwargs: dict[str, Any] = {}
        if content is not None:
            kwargs["content"] = content
        if embed is not None:
            kwargs["embed"] = embed
        if view is not None:
            kwargs["view"] = view
        if file is not None:
            kwargs["file"] = file
        if delete_after is not None:
            kwargs["delete_after"] = delete_after
        if skip_localization:
            kwargs["_agobot_skip_localization"] = True
        if not self.is_interaction:
            return await self.source.send(**kwargs)
        kwargs["ephemeral"] = ephemeral
        if self.source.response.is_done():
            if delete_after is not None:
                # Webhook.send は delete_after 非対応。送ってから手動で消す。
                kwargs.pop("delete_after")
                message = await self.source.followup.send(**kwargs, wait=True)
                if message is not None:
                    schedule_message_delete(message, delete_after)
                return message if want_message else None
            if want_message:
                kwargs["wait"] = True
            return await self.source.followup.send(**kwargs)
        await self.source.response.send_message(**kwargs)
        if want_message:
            return await self.source.original_response()
        return None
