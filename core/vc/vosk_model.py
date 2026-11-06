"""文字起こし・カラオケで使う Vosk の音声認識モデルの確認。

モデル（`model` フォルダ）が無いときは、VC に入る前にわかりやすく断るために使う。
"""
from __future__ import annotations
from core.support.emojis import FAILED

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

MODEL_MISSING_MESSAGE = (
    FAILED + ' 音声認識モデルが入っていません。Bot のフォルダに Vosk の日本語モデル（`model` フォルダ）を置いてから、もう一度試してください。'
)
VOSK_MISSING_MESSAGE = FAILED + ' 音声認識ライブラリ（vosk）が入っていません。'
MODEL_LOAD_FAILED_MESSAGE = FAILED + ' 音声認識モデルを読み込めませんでした。`model` フォルダの中身を確認してください。'


async def ensure_model(holder, model_cls, model_path: str) -> str | None:
    """使えないときは返信用のメッセージを、使えるときは None を返す。

    モデルはまだ読み込んでいなければここで読み込み、``holder.vosk_model`` に入れる。
    """
    if not os.path.isdir(model_path):
        return MODEL_MISSING_MESSAGE
    if getattr(holder, "vosk_model", None) is not None:
        return None
    if model_cls is None:
        return VOSK_MISSING_MESSAGE
    try:
        holder.vosk_model = await asyncio.to_thread(model_cls, model_path)
    except Exception:
        logger.exception("Vosk モデルの読み込みに失敗しました: %s", model_path)
        return MODEL_LOAD_FAILED_MESSAGE
    return None
