# ~/BOT/defining.py
# -*- coding: utf-8 -*-
import os
import discord
import config  # config.py から JST や db_api を参照

def format_log(message: str) -> str:
    """
    JST（日本時間）を付与した標準的なログフォーマットを返します。
    """
    now = config.get_now().strftime('%Y-%m-%d %H:%M:%S')
    return f"[{now}] {message}"

def get_asset_path(filename: str) -> str:
    """
    Assets フォルダ内のファイルパスを安全に取得します。
    画像などのリソース管理用です。
    """
    path = os.path.join("Assets", filename)
    if not os.path.exists(path):
        # 警告ログを出す（開発時に役立ちます）
        print(format_log(f"Warning: Asset not found at {path}"))
    return path

async def send_error_embed(ctx, error_message: str):
    """
    共通のエラー埋め込みメッセージを送信します。
    """
    embed = discord.Embed(
        title="エラーが発生しました",
        description=error_message,
        color=discord.Color.red()
    )
    await ctx.send(embed=embed)