"""/voice グループ: ボイスチャンネルを使う機能（参加・退出・録音・やまびこ・文字起こし・カラオケ・
ボイスチェンジャー・ランダム通話・グローバルVC・VOICEVOX読み上げ・音声トリガー）の入口。

それぞれの処理は各機能の cog にある実装関数（``_xxx_impl``）を呼ぶだけ。
VC を誰が使っているかは core/vc/voice_session.py が持つ。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

# --- 音声トリガー用の重い依存はここで安全に読み込む ---------------------------
# encodec / torch / soundfile のどれか1つでも import に失敗すると、このモジュール
# 全体の読み込みが止まり、VoiceHub や TTSCog まで道連れになる。それを避けるため、
# 失敗しても VOICE_TRIGGER_AVAILABLE=False にして、音声トリガー機能だけを無効化する。
try:
    import encodec
    import soundfile as sf
    import torch

    # CPU 推論はスレッドを増やしすぎると逆に遅くなることがある。上限を絞る。
    torch.set_num_threads(min(4, os.cpu_count() or 4))

    VOICE_TRIGGER_AVAILABLE = True
except Exception:  # ImportError だけでなく共有ライブラリ不整合 (OSError) 等も捕捉
    encodec = None
    sf = None
    torch = None
    VOICE_TRIGGER_AVAILABLE = False
    logging.getLogger(__name__).warning(
        "EnCodec/torch/soundfile を読み込めなかったため、音声トリガー機能は無効になります",
        exc_info=True,
    )
# ---------------------------------------------------------------------------

from core.general import action_usage
from core.support.usage_stats import usage_stats
from core.support.legacy import Responder
from core.vc.voice_session import VoiceBusy, feature_label, get_manager, stop_hint
from core.vc.voice_media import add_audio_source, remove_audio_source
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

CONNECTION_ACTIONS = [
    app_commands.Choice(name="参加", value="join"),
    app_commands.Choice(name="退出", value="leave"),
    app_commands.Choice(name="状態", value="status"),
]
STUDIO_FEATURES = [
    app_commands.Choice(name="録音", value="record"),
    app_commands.Choice(name="やまびこ", value="echo"),
    app_commands.Choice(name="文字起こし", value="transcribe"),
    app_commands.Choice(name="カラオケ", value="karaoke"),
]
STUDIO_ACTIONS = [
    app_commands.Choice(name="開始", value="start"),
    app_commands.Choice(name="停止/終了", value="stop"),
    app_commands.Choice(name="状態", value="status"),
    app_commands.Choice(name="音程解析", value="pitch"),
    app_commands.Choice(name="遅延変更", value="delay"),
    app_commands.Choice(name="採点", value="score"),
]
EFFECT_ACTIONS = [
    app_commands.Choice(name="開始", value="start"),
    app_commands.Choice(name="停止", value="stop"),
    app_commands.Choice(name="状態/設定変更", value="status"),
]
COMMUNITY_NETWORKS = [
    app_commands.Choice(name="ランダム通話", value="match"),
    app_commands.Choice(name="グローバルVC", value="global"),
]
COMMUNITY_ACTIONS = [
    app_commands.Choice(name="開始/参加", value="start"),
    app_commands.Choice(name="終了/退出", value="stop"),
]

# ジャンル説明は、ラベルや配下の機能名から読み取れない情報がある場合だけ書く。
# 機能名の列挙は書かない（空文字 = 説明なし）。
VOICE_GENRES = {
    "connection": ("VC接続", ""),
    "music": ("音楽", ""),
    "tts": ("読み上げ", "VOICEVOXによるテキスト読み上げ"),
    "studio": ("録音・音声制作", ""),
    "effects": ("音声加工", "ボイスチェンジャー"),
    "trigger": ("音声トリガー", ""),
    "community": ("ランダム通話", ""),
    "gvc_rooms": ("グローバルVCルーム", ""),
}
VOICE_ACTIONS_BY_GENRE = {
    "connection": [("参加", "join"), ("退出", "leave"), ("状態", "status")],
    "music": [("音楽操作パネル", "music_panel")],
    "studio": [(f"録音: {label}", f"record_{value}") for label, value in
                (("開始", "start"), ("停止", "stop"), ("状態", "status"), ("音程解析", "pitch"))] +
               [(f"やまびこ: {label}", f"echo_{value}") for label, value in
                (("開始", "start"), ("停止", "stop"), ("遅延変更", "delay"))] +
               [("文字起こし: 開始", "transcribe_start"), ("文字起こし: 停止", "transcribe_stop"),
                ("カラオケ: 開始", "karaoke_start"), ("カラオケ: 停止", "karaoke_stop"),
                ("カラオケ: 採点", "karaoke_score")],
    "effects": [("開始", "changer_start"), ("停止", "changer_stop"), ("状態/設定", "changer_status")],
    "community": [("ランダム通話: 開始/参加", "match_start"), ("ランダム通話: 終了/退出", "match_stop")],
    "gvc_rooms": [("グローバルVC: 開始/参加", "global_start"), ("グローバルVC: 終了/退出", "global_stop"),
                  ("ルーム一覧（参加ボタン付き）", "gvc_room_list"), ("ルーム作成", "gvc_room_create"),
                  ("ルーム情報", "gvc_room_info"), ("ルーム削除", "gvc_room_delete"),
                  ("グロチャ: 接続（このチャンネル）", "gvc_chat_connect"),
                  ("グロチャ: 接続解除（このチャンネル）", "gvc_chat_disconnect")],
    "tts": [("読み上げ: 開始（このチャンネルを読む）", "tts_start"), ("読み上げ: 停止", "tts_stop"),
            ("読み上げ: 話者・ピッチ・話速の設定", "tts_config"), ("読み上げ: 1回だけ読む", "tts_say")],
    "trigger": [
        ("トリガー登録（このチャンネルの音声から選ぶ）", "trigger_register"),
        ("トリガー一覧・削除", "trigger_panel"),
    ],
}

# グローバルVCルームの操作（/vc パネルから使う）
# 値: (入力フォームのタイトル, [(キー, ラベル, 最大文字数, 必須, 初期値)])
GVC_ROOM_FORMS = {
    "gvc_room_create": ("グローバルVCルームを作成", [
        ("name", "ルーム名", 100, True, ""),
        ("max", "最大参加サーバー数（0=無制限）", 4, False, "0"),
        ("password", "パスワード（入力すると非公開）", 100, False, ""),
        ("desc", "説明（任意）", 200, False, ""),
    ]),
    "gvc_room_info": ("ルーム情報を表示", [("name", "ルーム名", 100, True, "")]),
    "gvc_room_delete": ("ルームを削除", [("name", "ルーム名", 100, True, "")]),
    "gvc_chat_connect": ("グロチャに接続（このチャンネル）", [
        ("name", "ルーム名", 100, True, ""),
        ("password", "パスワード（非公開ルームのみ）", 100, False, ""),
    ]),
}
# 入力なしでパネルから直接実行できる操作
GVC_ROOM_ACTIONS = {"gvc_room_list", "gvc_chat_disconnect", *GVC_ROOM_FORMS}

# 起動時のロード一覧に漏れていても、初回利用時に読み込み直せる拡張（機能キー -> モジュール名）
LAZY_EXTENSIONS = {
    "transcribe": "vc",  # cogs/vc.py（VC統合入口）
}

COGS = {
    "music": "VoiceCog",
    "record": "RecordingCog",
    "transcribe": "TranscriptionCog",
    "karaoke": "KaraokeCog",
    "changer": "VoiceChangerCog",
    "match": "SaitoRelay",
    "global": "GlobalVCCog",
    "tts": "TTSCog",
}


def format_elapsed(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}時間{minutes}分"
    if minutes:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"
