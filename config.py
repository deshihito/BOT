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
from core import api_client as _api_client

db_api = _api_client.get_client()
if db_api is None:
    print("WARNING: BOT_API_BASE_URL and BOT_API_KEY are not configured.")

GROQ_API_KEY = os.getenv('GROQ_API_KEY')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')

# --- LibreTranslate設定 ---
# 自動翻訳とローカライズ用の翻訳経路で共有する設定。
LIBRETRANSLATE_URL = os.getenv('LIBRETRANSLATE_URL', 'http://127.0.0.1:18080').rstrip('/')
LIBRETRANSLATE_API_KEY = os.getenv('LIBRETRANSLATE_API_KEY', '')

# --- 共通ユーティリティ ---
JST = datetime.timezone(datetime.timedelta(hours=9))

def get_now():
    """日本時間の現在時刻を返す"""
    return datetime.datetime.now(JST)
