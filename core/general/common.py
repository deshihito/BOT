# -*- coding: utf-8 -*-
"""汎用機能の共通基盤（定数・ジャンル定義）。元 cogs/general.py の冒頭部。"""
from __future__ import annotations

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core import action_registry, action_usage, ai_omnirush, ai_preferences, ai_provider_router, guild_settings, levelup_card, logfare, shortcuts, usage_stats
from core.game_guides import GAME_GUIDES, GAME_ORDER
from core import localization, translation
from core.messages import CIRCULATION_NOT_LOADED, GAMBLING_NOT_LOADED, ITEMS_NOT_LOADED, MARKET_NOT_LOADED, WORKSHOP_NOT_LOADED
from core.libretranslate import LibreTranslateClient, LibreTranslateError

logger = logging.getLogger("cogs.general")  # 分割後も従来のログ名に統一する


# ============================================================
# EXP 設定
# ============================================================
CHAT_EXP_BASE = 50
CHAT_EXP_RATIO = 1.25
VC_EXP_BASE = 50
VC_EXP_RATIO = 1.25

CHAT_EXP_INTERVAL = 5 * 60
VC_EXP_INTERVAL = 5 * 60
CHAT_EXP_PER_GRANT = 5
VC_EXP_PER_GRANT = 5
VC_MAX_GAP_SECONDS = 3 * 60
HISTORY_FUTURE_TOLERANCE = 60

EXP_STORE_KEY = "exp"

# ジャンル説明は、ラベルや配下の機能名から読み取れない情報がある場合だけ書く。
# 機能名の列挙は書かない（空文字 = 説明なし）。
GENERAL_GENRES = {
    "money": ("マネー", ""),
    "rta": ("RTAランキング", ""),
    "exp": ("EXP・レベル", "チャット・VC・generalのEXPとレベル"),
    "survival": ("生存確認", "メンバーの安否・不在の検知"),
    "custom": ("設定・AI", ""),
    "zeta": ("ZetaModoki", "ロールプレイ会話"),
    "translation": ("翻訳", ""),
    "miq": ("引用画像 (MIQ)", "メッセージを引用画像にする"),
    "meme": ("meme作成", "画像に上下テキストを入れてmeme画像を作成する"),
}
GENERAL_ACTIONS = {
    "money": [
        ("マネーパネル", "money_panel"),
        ("プレイヤー状況", "status"),
        ("コイン送金", "pay"),
        ("市場", "market"),
        ("アゴトークンを買う", "token_buy"),
        ("アゴトークンを売る", "token_sell"),
        ("アイテム", "items"),
        ("アイテムを買う", "item_buy"),
        ("アイテムを使う", "item_use"),
        ("宝箱を開ける", "box_open"),
        ("工房", "workshop"),
        ("加工機を買う", "machine_buy"),
        ("生産物を受け取る", "workshop_claim"),
        ("合成する", "craft"),
        ("採掘する", "mining"),
        ("宝くじ", "lottery"),
        ("宝くじを買う", "lottery_buy"),
        ("盗む", "steal"),
        ("スロット", "slot"),
        ("ダブルアップ", "double"),
        ("ブラックジャック", "blackjack"),
        ("ダイス", "dice"),
        ("コイン保有ランキング", "coin_leaderboard"),
    ],
    "rta": [
        ("bump RTAランキング", "bump_leaderboard"),
        ("up RTAランキング", "up_leaderboard"),
    ],
    "survival": [
        ("追跡登録・解除", "fujo_register"),
        ("アクティブ頻度", "fujo_hindo"),
        ("生存確認ランキング", "fujo_ranking"),
        ("フリーズ", "fujo_freeze"),
        ("失踪警報解除", "fujo_panic_disable"),
    ],
    "exp": [
        ("自分のEXP状況", "exp_status"),
        ("EXPランキング", "exp_ranking"),
    ],
    "custom": [
        ("ショートカットを管理", "shortcut_manage"),
        ("AI tools稼働状態", "aitools"),
        ("チャットAIモデルを設定", "ai_default"),
        ("画像生成AIモデルを設定", "image_default"),
        ("AI思考強度を設定", "reasoning_default"),
    ],
    "zeta": [
        ("ZetaModokiと会話", "zetamodoki"),
        ("ZetaModoki会話をリセット", "zeta_reset"),
        ("シチュエーション・キャラクターを登録", "zeta_register"),
        ("登録を管理（編集・削除）", "zeta_manage"),
    ],
    "translation": [
        ("自動翻訳を設定", "translation_settings"),
    ],
    "miq": [
        ("MIQ設定（見た目・引用拒否）", "miq_settings"),
        ("使い方", "miq_help"),
    ],
    "meme": [
        ("memeを作成", "meme_create"),
        ("使い方", "meme_help"),
    ],
}


# ============================================================
# EXP 計算ユーティリティ
# ============================================================
