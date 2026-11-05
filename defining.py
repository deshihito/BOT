# ~/BOT/defining.py
# -*- coding: utf-8 -*-
import config  # config.py から JST や db_api を参照

def format_log(message: str) -> str:
    """
    JST（日本時間）を付与した標準的なログフォーマットを返します。
    """
    now = config.get_now().strftime('%Y-%m-%d %H:%M:%S')
    return f"[{now}] {message}"

