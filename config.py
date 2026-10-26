# -*- coding: utf-8 -*-
import os
import datetime
from dotenv import load_dotenv

# .envの読み込み
load_dotenv()

# --- Discord設定 ---
TOKEN = os.getenv('TOKEN')
PREFIX = "!"

# --- Supabase設定 ---
SUPABASE_URL = os.getenv('SUPABASE_URL')
# Bot は通常 SUPABASE_KEY（anon）を使う。SUPABASE_SERVICE_ROLE_KEY は任意の上書き。
# 実際のクライアント作成は core/supabase_client.py に一本化している。
from core import supabase_client as _supabase_client
SUPABASE_KEY, SUPABASE_KEY_SOURCE = _supabase_client.select_key()
GROQ_API_KEY = os.getenv('GROQ_API_KEY')
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')

# --- LibreTranslate設定 ---
# Bot実行時には翻訳APIを呼ばず、翻訳カタログ生成スクリプトだけが利用する。
LIBRETRANSLATE_URL = os.getenv('LIBRETRANSLATE_URL', 'http://127.0.0.1:18080').rstrip('/')
LIBRETRANSLATE_API_KEY = os.getenv('LIBRETRANSLATE_API_KEY', '')

# クライアントの初期化
supabase = _supabase_client.get_client()
if supabase is None:
    print("WARNING: Supabase credentials are missing.")

# --- 共通ユーティリティ ---
JST = datetime.timezone(datetime.timedelta(hours=9))

def get_now():
    """日本時間の現在時刻を返す"""
    return datetime.datetime.now(JST)
