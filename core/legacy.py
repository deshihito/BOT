"""スラッシュコマンドとプレフィックスコマンドの返信の違いを吸収する部品。

- ``Responder``: commands.Context と discord.Interaction のどちらからでも同じ書き方で返信できる薄い包み。
  /music・/voice の実装関数（``_xxx_impl``）はこれを受け取る。

旧コマンド（/play・!rec など）から新しいコマンドへ案内する ``legacy`` デコレーターは、
旧コマンドを削除したときに一緒に消した。モジュール名は import している場所が多いのでそのまま残している。
"""
from __future__ import annotations

from typing import Any, Optional


def is_interaction(source) -> bool:
    return hasattr(source, "response") and hasattr(source, "followup")


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
                   want_message: bool = False, skip_localization: bool = False):
        """返信する。``want_message`` のときは送ったメッセージを返す（あとで編集するため）。"""
        kwargs: dict[str, Any] = {}
        if content is not None:
            kwargs["content"] = content
        if embed is not None:
            kwargs["embed"] = embed
        if view is not None:
            kwargs["view"] = view
        if file is not None:
            kwargs["file"] = file
        if skip_localization:
            kwargs["_agobot_skip_localization"] = True
        if not self.is_interaction:
            return await self.source.send(**kwargs)
        kwargs["ephemeral"] = ephemeral
        if self.source.response.is_done():
            if want_message:
                kwargs["wait"] = True
            return await self.source.followup.send(**kwargs)
        await self.source.response.send_message(**kwargs)
        if want_message:
            return await self.source.original_response()
        return None
