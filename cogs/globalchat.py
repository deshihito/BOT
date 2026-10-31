import discord
from discord import app_commands
from discord.ext import commands
import json
import os

from core import globalchat_moderation as mod

class GlobalChatCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.save_file = "global_channels.json"
        # 登録されたチャンネルIDを保持するセット（重複を防ぐ）
        self.active_channels = self.load_channels()
        # ユーザーごとの連投制限（サーバーをまたいで数える）
        self.rate_limiter = mod.RateLimiter()

    # JSONファイルから登録チャンネルを読み込む
    def load_channels(self):
        if os.path.exists(self.save_file):
            try:
                with open(self.save_file, "r", encoding="utf-8") as f:
                    return set(json.load(f))
            except Exception as e:
                print(f"データの読み込みに失敗しました: {e}")
        return set()

    # JSONファイルへ登録チャンネルを保存する
    def save_channels(self):
        try:
            with open(self.save_file, "w", encoding="utf-8") as f:
                json.dump(list(self.active_channels), f)
        except Exception as e:
            print(f"データの保存に失敗しました: {e}")

    async def notify_sender(self, message: discord.Message, text: str):
        """送信者だけに知らせる（DM。送れなければ <:failed:1490986584676368535> リアクションと、すぐ消える返信）。"""
        try:
            await message.author.send(text)
            return
        except Exception:
            pass
        try:
            await message.add_reaction("<:failed:1490986584676368535>")
            await message.reply(text, delete_after=10, mention_author=False)
        except Exception:
            pass

    # メッセージ送信を検知するイベントリスナー
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        # ボット自身や、他のボット、Webhookからのメッセージは無視（無限ループ防止）
        if message.author.bot or message.webhook_id:
            return

        # 送信されたチャンネルがグローバルチャットに登録されていなければ無視
        if message.channel.id not in self.active_channels:
            return

        # 【メンション対策】@の文字が入っていれば転送を弾く
        if "@" in message.content:
            try:
                # 警告としてメッセージにバツ印のリアクションを付ける
                await message.add_reaction("<:failed:1490986584676368535>")
            except discord.Forbidden:
                pass
            return

        source_guild_id = message.guild.id if message.guild else 0

        # 【NG ワード】既定の一覧と、送信元サーバーで足した言葉に当たれば転送しない
        own_words = mod.settings(source_guild_id)["ng_words"] if source_guild_id else []
        hit = mod.find_ng_word(message.content, list(mod.DEFAULT_NG_WORDS) + own_words)
        if hit is not None:
            await self.notify_sender(message, "⚠️ NG ワードが含まれていたため、グローバルチャットに転送しませんでした。")
            return

        # 【連投制限】
        allowed, wait, first = self.rate_limiter.check(message.author.id)
        if not allowed:
            if first:
                await self.notify_sender(message, f"<:crock:1561710960387956757> 連投が多いため、約 {int(wait)} 秒間グローバルチャットに転送しません。")
            return

        # 自分以外の、登録されているすべてのチャンネルIDを抽出
        target_ids = [cid for cid in self.active_channels if cid != message.channel.id]

        # 各チャンネルへメッセージを転送
        for cid in target_ids:
            channel = self.bot.get_channel(cid)
            
            # キャッシュにない場合は取得を試みる
            if channel is None:
                try:
                    channel = await self.bot.fetch_channel(cid)
                except (discord.NotFound, discord.Forbidden):
                    # チャンネルが削除されている、またはボットが入れない場合はリストから除外
                    self.active_channels.remove(cid)
                    self.save_channels()
                    continue

            # 転送先サーバーのブロック・NG ワード設定
            target_guild = getattr(channel, "guild", None)
            if target_guild is not None and target_guild.id != source_guild_id:
                if mod.is_blocked_by(target_guild.id, user_id=message.author.id, source_guild_id=source_guild_id):
                    continue
                if mod.find_ng_word(message.content, mod.settings(target_guild.id)["ng_words"]) is not None:
                    continue

            # 転送先サーバーでボットに「ウェブフックの管理」権限があるか確認
            if not channel.permissions_for(channel.guild.me).manage_webhooks:
                continue

            try:
                # 既存のグローバルチャット用Webhookを探す
                webhooks = await channel.webhooks()
                webhook = discord.utils.get(webhooks, name="GlobalChat-Webhook")

                # なければ作成
                if webhook is None:
                    webhook = await channel.create_webhook(name="GlobalChat-Webhook")

                # 送信者の名前とアイコンでWebhook送信
                await webhook.send(
                    content=message.content,
                    username=f"{message.author.display_name} [{message.guild.name}]", # どこから来たか分かるようにサーバー名も付与
                    avatar_url=message.author.display_avatar.url,
                    allowed_mentions=discord.AllowedMentions.none(), # 二重のメンション対策
                    _agobot_skip_localization=True,
                )
            except Exception as e:
                print(f"チャンネル {cid} への転送中にエラーが発生しました: {e}")


# Botへの登録用関数
async def setup(bot):
    await bot.add_cog(GlobalChatCog(bot))
