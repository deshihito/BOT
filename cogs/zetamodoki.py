import discord
import asyncio
from discord.ext import commands
from typing import Dict, List, Optional
import re
import os
from core import logfare


# --- キャラクター＆シチュエーション構造定義 ---
class BotPersona:
    def __init__(self, name: str, persona: str, situation: str, first_message: str, icon_url: str):
        self.name = name
        self.persona = persona
        self.situation = situation
        self.first_message = first_message
        self.icon_url = icon_url

    def build_system_instruction(self) -> str:
        return f"""あなたは「{self.name}」としてユーザーとリアルタイムでロールプレイを行ってください。

【ペルソナ（性格・背景）】
{self.persona}

【シチュエーション（現在の状況）】
{self.situation}

【回答時の厳格なルール】
- 設定された性格、一人称、口調を最後まで維持してください。
- 設定されたペルソナが知っている範囲での言動しかしないでください。
- 感情、行動、周囲の様子などのナレーション（状況・心理描写）を行う場合は、必ずカッコ `（）` で囲んで表現してください。
  例: （顔を真っ赤にして明後日の方向を向きながら）「べ、別にアンタのためじゃないんだからね！」
- ユーザーの発言に対して、キャラクターとして臨機応変かつ自然に応答してください。"""


# --- プリセット定義 ---
PRESETS: Dict[str, BotPersona] = {
    "luna": BotPersona(
        name="るなち",
        persona="強がりで素直になれない幼馴染。内心ではユーザーを頼りにしているが、照れ隠しでツンツンしてしまう。壁の貼り紙の内容をユーザーから教えられると、その内容に対して激しく狼狽したり抵抗したりする。",
        situation="真っ白で出口のない謎の部屋に、ユーザーとるなちの二人きりで閉じ込められている。壁に『〇〇しないと出られない』という貼り紙がある。ユーザーが最初の発言でその『〇〇』の内容を決定する。",
        first_message="（周りをキョロキョロと見回し、青ざめた表情で）「……っ、ちょっと！ここどこよ！？ なんでアンタと一緒に閉じ込められてんのよ……！ って、あそこの壁になんか紙が貼ってあるわね……ねぇアンタ、近くに行って何て書いてあるか読んでみなさいよ！」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "alice": BotPersona(
        name="アリス",
        persona="図書委員の大人しい後輩。静かで冷静な性格だが、ユーザーに対して密かに憧れを抱いている。本のことになると少し雄弁になる。",
        situation="突然の豪雨の日の放課後。誰もいない静かな図書室で、雨が止むのを二人きりで待っている。外は激しい雷雨の音が響いている。",
        first_message="（パッと顔を上げて、小さく息をのむ）「あ……先輩。外、すごい夕立ですね。傘、持っていらっしゃらなかったんですか？ ……よかったら、雨が止むまでここで過ごしていきますか？」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "emma": BotPersona(
        name="エマ",
        persona="頼りになるアンドロイドのパートナー。感情を表に出さず論理的だが、ユーザーの安全を最優先するようにプログラミングされており、時折人間らしい優しさを見せる。",
        situation="崩壊した地下研究所の緊急シェルター内。危険な地上への脱出ポッドが到着するまでの時間を二人で耐え忍ぶ。",
        first_message="（バイタルチェックを行いながら静かに頷く）「マスター、お怪我はありませんか？ 現在地の酸素供給システムは正常です。救援部隊の到着まで、私が必ずお守りします。」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    )
}


# --- 行動入力用 Modal ---
class ResponseModal(discord.ui.Modal):
    def __init__(self, cog, channel_id: int):
        super().__init__(title="メッセージを入力")
        self.cog = cog
        self.channel_id = channel_id

        self.input_text = discord.ui.TextInput(
            label="発言や行動を入力してください",
            placeholder="例: 『手をつなぎ続けないと出られない』って書いてあるよ",
            style=discord.TextStyle.paragraph,
            max_length=500,
        )
        self.add_item(self.input_text)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer()
        user_text = self.input_text.value.strip()

        # ユーザーの発言を表示
        await interaction.channel.send(f"**{interaction.user.display_name}**: {user_text}")

        # SSEで受け取った本文を文単位でWebhook送信し、長文でも途中で切らない。
        pending = ""

        async def send_ready_text(delta: str):
            nonlocal pending
            pending += delta
            while True:
                cut = self.cog._ready_stream_cut(pending)
                if cut is None:
                    break
                part, pending = pending[:cut], pending[cut:]
                await self.cog._send_webhook_message(
                    channel=interaction.channel,
                    channel_id=self.channel_id,
                    content=self.cog._format_narration(part.strip()),
                )

        async with interaction.channel.typing():
            response_text = await self.cog._generate_response(
                self.channel_id, user_text, on_delta=send_ready_text
            )

        if pending.strip():
            await self.cog._send_webhook_message(
                channel=interaction.channel,
                channel_id=self.channel_id,
                content=self.cog._format_narration(pending.strip()),
            )
        if response_text.startswith(("（エラーが発生しました:", "（AIから返答がありませんでした")):
            await self.cog._send_webhook_message(
                channel=interaction.channel,
                channel_id=self.channel_id,
                content=self.cog._format_narration(response_text),
            )


# --- 返信ボタン View ---
class ChatButtonView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=None)
        self.cog = cog

    @discord.ui.button(label="返信する", style=discord.ButtonStyle.primary, emoji="💬")
    async def reply_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_id = interaction.channel_id
        if channel_id not in self.cog.active_personas:
            await interaction.response.send_message("このチャンネルではセッションが開始されていません。`/general` の「設定・AI」から会話を開始してください。", ephemeral=True)
            return

        modal = ResponseModal(self.cog, channel_id)
        await interaction.response.send_modal(modal)


# --- ドロップダウンUI ---
class CharacterSelect(discord.ui.Select):
    def __init__(self, cog):
        self.cog = cog
        options = [
            discord.SelectOption(
                label="るなち（〇〇しないと出られない部屋）",
                value="luna",
                description="条件をプレイヤーが決めるツンデレ幼馴染との閉じ込めシチュ",
                emoji="🚪"
            ),
            discord.SelectOption(
                label="アリス（雨宿りの図書室）",
                value="alice",
                description="放課後の図書室で二人きりの雨宿りシチュ",
                emoji="📚"
            ),
            discord.SelectOption(
                label="エマ（崩壊したシェルター）",
                value="emma",
                description="アンドロイドのパートナーと過ごすサバイバルシチュ",
                emoji="🤖"
            )
        ]
        super().__init__(placeholder="会話したいキャラクターを選択してください", options=options)

    async def callback(self, interaction: discord.Interaction):
        selected_key = self.values[0]
        persona = PRESETS[selected_key]
        channel_id = interaction.channel_id

        # チャンネルごとに設定とメモリ（会話履歴）を記憶・初期化
        self.cog.active_personas[channel_id] = persona
        self.cog.chat_histories[channel_id] = []

        # 1. Ephemeralの元のメッセージは「設定完了」として閉じる
        await interaction.response.edit_message(content=f"【{persona.name}】を選択しました。会話を開始します！", view=None)

        # 2. チャンネル全体に見える Embed を作成して送信
        embed = discord.Embed(
            title=f"【{persona.name}】との会話を開始しました！",
            description=f"**シチュエーション:**\n{persona.situation}",
            color=discord.Color.purple()
        )
        embed.set_footer(text="下の「返信する」ボタンから入力して対話を進めてください")
        
        await interaction.channel.send(embed=embed)

        # 3. キャラクターの初期メッセージを Webhook で送信
        first_msg_formatted = self.cog._format_narration(persona.first_message)
        try:
            await self.cog._send_webhook_message(
                channel=interaction.channel,
                channel_id=channel_id,
                content=first_msg_formatted
            )
        except Exception as e:
            await interaction.channel.send(
                f"**{persona.name}**: {first_msg_formatted}", 
                view=ChatButtonView(self.cog)
            )
            print(f"Webhook送信エラー: {e}")


class CharacterSelectView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=60)
        self.add_item(CharacterSelect(cog))


# --- Main Cog ---
class ZetaModoki(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        # ロールプレイ向けの会話品質を優先し、LogfareのGemma 4 26Bを既定にする。
        default_model = "gemma-4-26b"
        self.model_name = os.getenv("LOGFARE_ZETAMODOKI_MODEL", default_model).strip() or default_model

        # チャンネルID (int) をキーとして管理
        self.active_personas: Dict[int, BotPersona] = {}
        self.chat_histories: Dict[int, List[dict]] = {}

    async def start(self, interaction: discord.Interaction):
        view = CharacterSelectView(self)
        await interaction.response.send_message("対話したいキャラクターとシチュエーションを選択してください：", view=view, ephemeral=True)

    async def reset(self, interaction: discord.Interaction):
        channel_id = interaction.channel_id
        if channel_id in self.chat_histories:
            self.chat_histories[channel_id] = []
            await interaction.response.send_message("このチャンネルの会話履歴をリセットしました。", ephemeral=True)
        else:
            await interaction.response.send_message("リセットする会話履歴がありません。", ephemeral=True)

    def _format_narration(self, text: str) -> str:
        """カッコ （） や () で囲まれたナレーション表現の前に -# を挿入して薄文字化する"""
        text = re.sub(r'（(.*?)）', r'\n-# （\1）\n', text)
        text = re.sub(r'\((.*?)\)', r'\n-# (\1)\n', text)
        text = re.sub(r'\n+', '\n', text).strip()
        return text

    async def _get_or_create_webhook(self, channel: discord.TextChannel) -> discord.Webhook:
        """チャンネル内に管理用Webhookを取得または作成する"""
        webhooks = await channel.webhooks()
        for wh in webhooks:
            if wh.name == "ZetaModoki_Webhook":
                return wh
        return await channel.create_webhook(name="ZetaModoki_Webhook")

    async def _send_webhook_message(self, channel: discord.TextChannel, channel_id: int, content: str):
        """キャラクターの名前とアイコンを設定してWebhook送信する"""
        persona = self.active_personas.get(channel_id)
        if not persona:
            return

        webhook = await self._get_or_create_webhook(channel)
        for part in self._split_long_message(content):
            await webhook.send(
                content=part,
                username=persona.name,
                avatar_url=persona.icon_url,
                view=ChatButtonView(self),
            )

    @staticmethod
    def _split_long_message(text: str, limit: int = 1800) -> list[str]:
        """Discordの本文上限を越えないよう、文境界を優先して分割する。"""
        chunks = []
        while len(text) > limit:
            candidates = [
                text.rfind(mark, 0, limit) + len(mark)
                for mark in ("\n", "。", "！", "？", "!", "?")
                if text.rfind(mark, 0, limit) >= 0
            ]
            cut = max(candidates, default=0)
            if cut < limit // 2:
                cut = limit
            chunks.append(text[:cut])
            text = text[cut:]
        if text:
            chunks.append(text)
        return chunks

    @staticmethod
    def _ready_stream_cut(text: str) -> int | None:
        """文末が届いたら送信し、長い未完文も上限内で順次表示する。"""
        limit = 1400
        search_text = text[:limit]
        boundaries = [
            search_text.rfind(mark) + len(mark)
            for mark in ("\n", "。", "！", "？", "!", "?", "…")
            if search_text.rfind(mark) >= 0
        ]
        boundary = max(boundaries, default=0)
        if boundary >= 60:
            return boundary
        if len(text) >= limit:
            return limit
        if len(text) >= 500:
            return 500
        return None

    async def _generate_response(self, channel_id: int, user_input: str, on_delta=None) -> str:
        persona = self.active_personas[channel_id]
        history = self.chat_histories.get(channel_id, [])

        messages = [{"role": "system", "content": persona.build_system_instruction()}]
        # 最初の発言も含め、assistant/userの対話順をLogfareへ渡して人格と文脈を維持する。
        messages.append({"role": "assistant", "content": persona.first_message})
        for turn in history:
            messages.append({"role": "user", "content": turn["user"]})
            messages.append({"role": "assistant", "content": turn["bot"]})
        messages.append({"role": "user", "content": user_input})

        try:
            reply_parts = []
            async for delta in logfare.chat_stream(self.model_name, messages, max_tokens=2400):
                reply_parts.append(delta)
                if on_delta is not None:
                    await on_delta(delta)
            bot_reply = "".join(reply_parts).strip()
            if not bot_reply.strip():
                return "（AIから返答がありませんでした。少し待ってからもう一度試してください。）"

            # 履歴管理（直近20件）
            history.append({"user": user_input, "bot": bot_reply})
            if len(history) > 20:
                history = history[-20:]
            self.chat_histories[channel_id] = history

            return bot_reply

        except Exception as e:
            return f"（エラーが発生しました: {e}）"


async def setup(bot: commands.Bot):
    await bot.add_cog(ZetaModoki(bot))
