"""隠しチャンネル（Bot が閲覧できないチャンネル）への安全対策ヘルパー。

2026-11-16 から Discord は、Bot が閲覧できないチャンネルを
名前 ``___hidden___`` で届けるようになる。保証されるのは
チャンネル ID・種類・位置・親チャンネルだけで、名前・トピック・
権限上書きなどのフィールドは信頼できない。

このモジュールは「そのチャンネルは隠しチャンネルか」の判定と、
表示用の安全な名前だけを提供する。隠しチャンネルの名前に依存する
処理は置かず、判定はセンチネル名との一致だけで行う。
"""
from __future__ import annotations

#: Discord が閲覧不可チャンネルの名前に使うセンチネル。
HIDDEN_CHANNEL_NAME = "___hidden___"

#: 隠しチャンネルの名前を表示しなければならない場面の代替表記。
HIDDEN_CHANNEL_LABEL = "（閲覧できないチャンネル）"


def is_hidden_channel(channel) -> bool:
    """Bot から閲覧できない（＝名前がセンチネルで届いた）チャンネルか。

    名前が取れないオブジェクトは隠しチャンネルとはみなさない。
    """
    return getattr(channel, "name", None) == HIDDEN_CHANNEL_NAME


def channel_display_name(channel, *, fallback: str = HIDDEN_CHANNEL_LABEL) -> str:
    """表示に使ってよいチャンネル名。隠しチャンネルや名前が無い場合は fallback。"""
    name = getattr(channel, "name", None)
    if not name or name == HIDDEN_CHANNEL_NAME:
        return fallback
    return str(name)
