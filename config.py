# -*- coding: utf-8 -*-
import os
import datetime
from dotenv import load_dotenv

# .envの読み込み
load_dotenv()

# --- Discord設定 ---
TOKEN = os.getenv('TOKEN')
PREFIX = "!"

# --- 自前PostgreSQL API設定 ---
BOT_API_BASE_URL = os.getenv('BOT_API_BASE_URL', '').rstrip('/')
from core.support import api_client as _api_client

db_api = _api_client.get_client()
if db_api is None:
    print("WARNING: BOT_API_BASE_URL and BOT_API_KEY are not configured.")

GROQ_API_KEY = os.getenv('GROQ_API_KEY')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')

# --- Bot管理者（追加分） ---
# アプリの所有者に加えて、Bot管理者として扱うユーザーID（カンマ/空白区切り）。
# 常設グローバルVCルームの作成・テーマ変更などが対象。
def _parse_bot_admin_ids(raw: str) -> frozenset:
    ids = set()
    for part in (raw or "").replace(",", " ").split():
        try:
            ids.add(int(part))
        except ValueError:
            continue
    return frozenset(ids)


BOT_ADMIN_IDS = _parse_bot_admin_ids(os.getenv('BOT_ADMIN_IDS', ''))

# --- LibreTranslate設定 ---
# 自動翻訳とローカライズ用の翻訳経路で共有する設定。
LIBRETRANSLATE_URL = os.getenv('LIBRETRANSLATE_URL', 'http://127.0.0.1:18080').rstrip('/')
LIBRETRANSLATE_API_KEY = os.getenv('LIBRETRANSLATE_API_KEY', '')

# --- 共通ユーティリティ ---
JST = datetime.timezone(datetime.timedelta(hours=9))

def get_now():
    """日本時間の現在時刻を返す"""
    return datetime.datetime.now(JST)
