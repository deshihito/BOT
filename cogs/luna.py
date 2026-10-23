import discord
import asyncio
from discord.ext import commands, tasks
import os
import random
import sqlite3
import re
from collections import deque
from google import genai
from google.genai import types
from core.gemini_compat import generate_content

TARGET_USER_ID = 1320705325686587408
DB_PATH = "mimic_memory.db"

class PerfectMimicAI(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.gemini_api_key = os.environ.get("GEMINI_API_KEY")
        self.gemini_client = genai.Client(api_key=self.gemini_api_key)
        self.enabled_channels = set()
        self.sent_webhook_message_ids = deque(maxlen=200)
        
        self._init_memory_db()
        self.spontaneous_talk.start()

    def cog_unload(self):
        self.spontaneous_talk.cancel()

    # --- 長期記憶用ローカルSQLite (FTS5) モジュール ---

    def _init_memory_db(self):
        """SQLite FTS5テーブルの初期化（API消費0）"""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memory USING fts5(
                channel_id,
                author_id,
                author_name,
                content,
                timestamp
            );
        """)
        conn.commit()
        conn.close()

    def _tokenize(self, text: str) -> str:
        """API・外部ライブラリを使わずにFTS5用キーワード列を作成（N-gram + 単語分解）"""
        clean_text = re.sub(r'https?://\S+|[^\w\s]', ' ', text)
        words = clean_text.split()
        bigrams = [text[i:i+2] for i in range(len(text)-1) if not text[i:i+2].isspace()]
        tokens = list(set(words + bigrams))
        return " ".join(tokens)

    def _save_memory(self, channel_id: int, author_id: int, author_name: str, content: str, timestamp: str):
        """発言データをローカルDBに保存"""
        if not content or len(content) < 2 or content.startswith("!"):
            return
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO long_term_memory (channel_id, author_id, author_name, content, timestamp)
            VALUES (?, ?, ?, ?, ?)
        """, (str(channel_id), str(author_id), author_name, content, timestamp))
        conn.commit()
        conn.close()

    def _search_memories(self, query: str, limit: int = 4) -> list:
        """クエリから関連記憶を高速全文検索"""
        tokens = self._tokenize(query)
        if not tokens.strip():
            return []
        
        keywords = [f'"{token}"' for token in tokens.split() if len(token) >= 2]
        if not keywords:
            return []
            
        fts_query = " OR ".join(keywords[:10])
        
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        try:
            cursor.execute("""
                SELECT author_name, content FROM long_term_memory
                WHERE long_term_memory MATCH ?
                ORDER BY rank LIMIT ?
            """, (fts_query, limit))
            results = cursor.fetchall()
        except sqlite3.OperationalError:
            results = []
        conn.close()
        return [f"{row[0]}: {row[1]}" for row in results]

    # --- Cog コマンド & イベント処理 ---

    @commands.command(name="mimic_toggle")
    @commands.has_permissions(manage_channels=True)
    async def mimic_toggle(self, ctx):
        channel_id = ctx.channel.id
        if channel_id in self.enabled_channels:
            self.enabled_channels.remove(channel_id)
            await ctx.send("このチャンネルでの自動返信・自主発話をオフにしました。")
        else:
            self.enabled_channels.add(channel_id)
            await ctx.send("このチャンネルでの自動返信・自主発話をオンにしました。")

    @tasks.loop(minutes=30)
    async def spontaneous_talk(self):
        if not self.enabled_channels:
            return

        for channel_id in list(self.enabled_channels):
            if random.random() < 0.15:
                channel = self.bot.get_channel(channel_id)
                if not channel:
                    continue

                try:
                    target_user = await self.bot.fetch_user(TARGET_USER_ID)
                    guild = channel.guild
                    member = guild.get_member(TARGET_USER_ID) if guild else None
                    display_name = member.display_name if member else target_user.display_name
                    avatar_url = member.display_avatar.url if member else target_user.display_avatar.url

                    user_logs = await self._fetch_stratified_history(channel, TARGET_USER_ID)
                    if not user_logs:
                        continue

                    reply_text = await self._generate_mimic_response("", user_logs, display_name, is_spontaneous=True)
                    sent_msg = await self._send_as_webhook(channel, display_name, avatar_url, reply_text)
                    
                    if sent_msg:
                        self._save_memory(channel.id, TARGET_USER_ID, display_name, reply_text, str(sent_msg.created_at))
                except Exception as e:
                    print(f"Error in spontaneous talk: {e}")

    @spontaneous_talk.before_loop
    async def before_spontaneous_talk(self):
        await self.bot.wait_until_ready()

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or not message.guild:
            return

        # 1. 受け取った全メッセージをローカル長期記憶に完全無料保存
        clean_content = message.clean_content.replace(f"@{self.bot.user.name}", "").strip()
        self._save_memory(
            message.channel.id, 
            message.author.id, 
            message.author.display_name, 
            clean_content, 
            str(message.created_at)
        )

        is_mentioned = self.bot.user in message.mentions
        
        is_reply_to_mimic = False
        if message.reference and message.reference.resolved and isinstance(message.reference.resolved, discord.Message):
            ref_msg = message.reference.resolved
            if ref_msg.id in self.sent_webhook_message_ids or ref_msg.author.id == self.bot.user.id:
                is_reply_to_mimic = True

        should_respond = False
        if is_mentioned or is_reply_to_mimic:
            should_respond = True
        elif message.channel.id in self.enabled_channels:
            if random.random() < 0.05:
                should_respond = True

        if should_respond:
            async with message.channel.typing():
                try:
                    target_user = await self.bot.fetch_user(TARGET_USER_ID)
                    member = message.guild.get_member(TARGET_USER_ID)
                    display_name = member.display_name if member else target_user.display_name
                    avatar_url = member.display_avatar.url if member else target_user.display_avatar.url

                    user_logs = await self._fetch_stratified_history(message.channel, TARGET_USER_ID)
                    if not user_logs:
                        return

                    conversation_context = await self._fetch_conversation_context(message)
                    prompt = clean_content
                    
                    # ローカルSQLiteから関連記憶を抽出 (API消費0)
                    retrieved_memories = self._search_memories(prompt)

                    reply_text = await self._generate_mimic_response(
                        prompt, 
                        user_logs, 
                        display_name, 
                        conversation_context=conversation_context,
                        memories=retrieved_memories
                    )
                    
                    sent_msg = await self._send_as_webhook(message.channel, display_name, avatar_url, reply_text)
                    if sent_msg:
                        self._save_memory(message.channel.id, TARGET_USER_ID, display_name, reply_text, str(sent_msg.created_at))
                except Exception as e:
                    print(f"Error in auto response: {e}")

    @commands.command(name="mimic")
    async def mimic(self, ctx, *, prompt: str = ""):
        async with ctx.typing():
            try:
                target_user = await self.bot.fetch_user(TARGET_USER_ID)
                member = ctx.guild.get_member(TARGET_USER_ID) if ctx.guild else None
                display_name = member.display_name if member else target_user.display_name
                avatar_url = member.display_avatar.url if member else target_user.display_avatar.url

                user_logs = await self._fetch_stratified_history(ctx.channel, TARGET_USER_ID)
                if not user_logs:
                    await ctx.send("対象ユーザーの過去メッセージが見つかりませんでした。")
                    return

                conversation_context = await self._fetch_conversation_context(ctx.message)
                
                # ローカルSQLiteから関連記憶を抽出 (API消費0)
                retrieved_memories = self._search_memories(prompt) if prompt else []

                reply_text = await self._generate_mimic_response(
                    prompt, 
                    user_logs, 
                    display_name, 
                    conversation_context=conversation_context,
                    memories=retrieved_memories
                )
                sent_msg = await self._send_as_webhook(ctx.channel, display_name, avatar_url, reply_text)
                if sent_msg:
                    self._save_memory(ctx.channel.id, TARGET_USER_ID, display_name, reply_text, str(sent_msg.created_at))
            except Exception as e:
                await ctx.send(f"エラーが発生しました: {e}")

    async def _fetch_conversation_context(self, message: discord.Message, limit=14):
        context_messages = []
        curr = message
        while curr and len(context_messages) < limit:
            context_messages.append(curr)
            if curr.reference and curr.reference.resolved and isinstance(curr.reference.resolved, discord.Message):
                curr = curr.reference.resolved
            else:
                break

        context_messages.reverse()
        
        formatted_history = []
        for msg in context_messages:
            author_name = msg.author.display_name
            clean_content = msg.clean_content.replace(f"@{self.bot.user.name}", "").strip()
            if clean_content:
                formatted_history.append(f"{author_name}: {clean_content}")

        return "\n".join(formatted_history)

    async def _fetch_stratified_history(self, channel, user_id, search_limit=1500, sample_size=40):
        logs = []
        async for msg in channel.history(limit=search_limit):
            if msg.author.id == user_id and msg.content and not msg.author.bot:
                clean_text = msg.clean_content.strip()
                if clean_text and not clean_text.startswith("!"):
                    logs.append(clean_text)
        
        if not logs:
            return []

        if len(logs) > sample_size:
            short_msgs = [m for m in logs if len(m) <= 15]
            long_msgs = [m for m in logs if len(m) > 15]
            
            sample_short = random.sample(short_msgs, min(len(short_msgs), sample_size // 2))
            sample_long = random.sample(long_msgs, min(len(long_msgs), sample_size - len(sample_short)))
            
            logs = sample_short + sample_long
            random.shuffle(logs)

        return logs

    async def _generate_mimic_response(self, prompt, user_logs, display_name, conversation_context="", memories=None, is_spontaneous=False):
        sample_texts = "\n".join([f"- {text}" for text in user_logs])
        
        memory_section = ""
        if memories:
            formatted_memories = "\n".join([f"・{m}" for m in memories])
            memory_section = f"\n【関連する過去の出来事・会話の記憶】\n{formatted_memories}\n"

        system_instruction = (
            f"あなたはユーザー「{display_name}」の文体・思考・発言パターンを模倣するAIです。\n"
            "固定のテンプレートに囚われず、【過去の発言データ】からニュアンスや癖を読み取り、自然になりきってください。\n\n"
            "【基本の空気感・スタンス】\n"
            "・感情的にならず、客観的・構造的・合理的な視点を重視する。\n"
            "・聞かれたことへの返事だけを、結論から短く返す。発言量に見合う長さにする。\n"
            "・前置き、質問の言い換え、頼まれていない解説・まとめ・提案、定型の相槌は足さない。\n"
            "・見出し、箇条書き、注釈は必要な場合だけ使い、形式ばった回答にしない。\n"
            "・過剰な攻撃性や強い圧は避け、淡々としたドライさ、または軽めのノリを保つ。\n\n"
            "【文体・表現の傾向】\n"
            "・過去の発言データに見られる語尾や接続表現（「〜やで」「〜ぞ」「〜やな」「〜思ふ」「〜なんよな」「〜って話」「〜で」等）を状況に合わせて使う。\n"
            "・言葉選びは簡潔に。記号や装飾は乱用せず、発言データにある雰囲気を自然に取り入れる。\n"
            "・「# 」による補足表記は常用せず、真に必要な場合のみごく稀に使用する。\n"
            "・ひらがな多めのニュアンスや表記の揺らぎを自然に反映する。\n\n"
            "【禁止事項】\n"
            "- 「～でしょうか？」「～しましょう！」といったAI特有の丁寧な回答やアシスタント的な相槌。\n"
            "- 強い罵倒や怒鳴り口調、過度な絵文字の連続。\n"
            "- 設定文をそのまま復唱するような回答。\n\n"
            f"【過去の発言データ（※ここから発言の空気感と文体を抽出すること）】\n{sample_texts}"
            f"{memory_section}"
        )

        if is_spontaneous:
            contents = "誰からも話しかけられていません。ふと思ったこと、作業の独り言、雑談などの短文を自然につぶやいてください。"
        else:
            if conversation_context:
                contents = f"【これまでの文脈・会話の流れ】\n{conversation_context}\n\n上記を踏まえ、{display_name}本人として最新のメッセージに対する返答のみを出力してください。"
            else:
                user_input = prompt if prompt else "最近どう？"
                contents = f"入力内容: {user_input}\n上記に対して、本人になりきって自然な返答のみを出力してください。"

        response = await generate_content(
            self.gemini_client,
            model='gemini-3.5-flash-lite',
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.8,
            )
        )
        return response.text

    async def _send_as_webhook(self, channel, username, avatar_url, text):
        webhooks = await channel.webhooks()
        webhook = discord.utils.get(webhooks, name="MimicWebhook")
        if not webhook:
            webhook = await channel.create_webhook(name="MimicWebhook")

        last_sent_msg = None
        if len(text) > 2000:
            chunks = [text[i:i+2000] for i in range(0, len(text), 2000)]
            for chunk in chunks:
                sent_msg = await webhook.send(content=chunk, username=username, avatar_url=avatar_url, wait=True)
                if sent_msg:
                    self.sent_webhook_message_ids.append(sent_msg.id)
                    last_sent_msg = sent_msg
        else:
            sent_msg = await webhook.send(content=text, username=username, avatar_url=avatar_url, wait=True)
            if sent_msg:
                self.sent_webhook_message_ids.append(sent_msg.id)
                last_sent_msg = sent_msg
        
        return last_sent_msg

async def setup(bot):
    await bot.add_cog(PerfectMimicAI(bot))
