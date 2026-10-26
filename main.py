# -*- coding: utf-8 -*-
import discord
from discord.ext import commands
import os
import asyncio
import traceback
import config
import defining as df
from keep_alive import configure_coder, keep_alive
import logging
from collections import deque

# Supabase クライアントは config（core/supabase_client.py）で作った 1 つを共有する。
supabase = config.supabase
if supabase is None:
    raise RuntimeError('SUPABASE_URL と SUPABASE_KEYを設定してください。')

NOTIFY_CHANNEL_ID = 1513038883787505764
DEBUG_CHANNEL_ID = 1407389497016193177

class LogBuffer(logging.Handler):
    def __init__(self, maxlen=100):
        logging.Handler.__init__(self)
        self.logs = deque(maxlen=maxlen)
 
    def emit(self, record):
        log_entry = self.format(record)
        self.logs.append(log_entry)

class MyBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.all() 
        super().__init__(command_prefix=config.PREFIX, intents=intents)
        self.updated_notified = False

    async def close(self):
        # 終了前に、Supabase へ送れていない設定を送っておく（送れなくても次回起動時に再送する）。
        try:
            from core.storage import flush_all
            await flush_all(timeout=5.0)
        except Exception:
            logging.getLogger(__name__).exception("未送信の設定を保存できませんでした")
        await super().close()

    async def setup_hook(self):
        print(df.format_log("--- COGS LOADING PROCESS START ---"))
        
        if os.path.exists('./cogs'):
            files = os.listdir('./cogs')
            print(df.format_log(f"Files found in ./cogs: {files}"))
            
            for filename in files:
                if filename.endswith('.py') and not filename.startswith('__'):
                    ext_name = f'cogs.{filename[:-3]}'
                    print(df.format_log(f"Attempting to load: {ext_name}"))
                    try:
                        await self.load_extension(ext_name)
                        print(df.format_log(f"SUCCESS: {filename} loaded."))
                    except Exception:
                        err_detail = traceback.format_exc()
                        print(df.format_log(f"FAILED: {filename}\n{err_detail}"))
        else:
            print(df.format_log("ERROR: './cogs' directory not found."))
        
        try:
            synced = await sync_application_commands(self)
            print(df.format_log(f"Slash commands synced: {len(synced)}"))
        except Exception:
            print(df.format_log(f"Slash command sync failed:\n{traceback.format_exc()}"))

    async def on_ready(self):
        self.coder_loop = asyncio.get_running_loop()
        print(df.format_log(f"Logged in as {self.user} (ID: {self.user.id})"))
        
        print(df.format_log(f"Active Cogs: {list(self.cogs.keys())}"))
        if not self.updated_notified:
            channel = self.get_channel(NOTIFY_CHANNEL_ID)
            if channel:
                try:
                    await channel.send("<a:AGOMUNIMUNI:1490255555632037909>システムを更新しました。")
                except Exception as e:
                    print(df.format_log(f"Notification error: {e}"))
            self.updated_notified = True 

bot = MyBot()
bot.supabase = supabase


async def sync_application_commands(client: commands.Bot):
    """Sync local commands without removing Discord's Entry Point command."""
    tree = client.tree
    commands_to_sync = tree._get_all_commands(guild=None)
    payload = [command.to_dict(tree) for command in commands_to_sync]
    remote = await client.http.get_global_commands(client.application_id)
    for command in remote:
        if command.get("type") != 4:
            continue
        preserved = {
            key: value
            for key, value in command.items()
            if key not in {"id", "application_id", "guild_id", "version"}
        }
        if not any(item.get("type") == 4 for item in payload):
            payload.append(preserved)
        break
    return await client.http.bulk_upsert_global_commands(client.application_id, payload=payload)

@bot.command()
@commands.is_owner()
async def sync(ctx):
    try:
        synced = await sync_application_commands(bot)
        await ctx.send(f"<:success:1490985168100659322> {len(synced)} 個のスラッシュコマンドを同期しました！")
    except discord.HTTPException as e:
        if e.code == 50240:
            await ctx.send(
                "<:failed:1490986584676368535> 同期できませんでした。DiscordのEntry Pointコマンドを保持したまま再同期してください。"
            )
        else:
            await ctx.send(f"<:failed:1490986584676368535> 同期失敗: {e}")
    except Exception as e:
        await ctx.send(f"<:failed:1490986584676368535> 同期失敗: {e}")

log_buffer = LogBuffer(maxlen=100)
log_buffer.setFormatter(logging.Formatter(
    "[%(levelname)s] %(asctime)s | %(message)s",
    "%H:%M:%S"
))
logger = logging.getLogger()
logger.setLevel(logging.WARNING)
logger.addHandler(log_buffer)
bot.log_buffer = log_buffer

if __name__ == "__main__":
    configure_coder(bot)
    keep_alive()
    print("DEBUG: Keep-alive server initiated.")
    try:
        bot.run(config.TOKEN)
    except Exception:
        print(df.format_log(f"Bot runtime crash:\n{traceback.format_exc()}"))
