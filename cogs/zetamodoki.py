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
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=self.channel_id,
                user_input=user_text,
                requester_id=interaction.user.id,
            )


# --- 返信ボタン View ---
class ChatButtonView(discord.ui.View):
    def __init__(
        self,
        cog,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        private_thread: bool = False,
    ):
        super().__init__(timeout=None)
        self.cog = cog
        self.retry_owner_id = retry_owner_id
        self.retry_input = retry_input
        if retry_owner_id is None or retry_input is None:
            self.remove_item(self.retry_button)
        if not private_thread:
            self.remove_item(self.delete_thread_button)

    @discord.ui.button(label="返信する", style=discord.ButtonStyle.primary, emoji="💬")
    async def reply_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_id = interaction.channel_id
        if channel_id not in self.cog.active_personas:
            await interaction.response.send_message("このチャンネルではセッションが開始されていません。`/general` の「設定・AI」から会話を開始してください。", ephemeral=True)
            return

        modal = ResponseModal(self.cog, channel_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="再試行", style=discord.ButtonStyle.secondary, row=0)
    async def retry_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.retry_owner_id:
            await interaction.response.send_message("この発言を送信したユーザーだけが再試行できます。", ephemeral=True)
            return
        failed = self.cog.failed_requests.get(interaction.channel_id)
        if (
            not failed
            or failed["user_id"] != interaction.user.id
            or failed["user_input"] != self.retry_input
        ):
            await interaction.response.send_message("再試行できる失敗した発言が見つかりません。", ephemeral=True)
            return

        channel = interaction.channel
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        await interaction.response.edit_message(
            view=ChatButtonView(self.cog, private_thread=private_thread)
        )
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=interaction.channel_id,
                user_input=self.retry_input,
                requester_id=interaction.user.id,
            )

    @discord.ui.button(label="このスレッドを削除", style=discord.ButtonStyle.danger, row=0)
    async def delete_thread_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        if not isinstance(channel, discord.Thread) or channel.type != discord.ChannelType.private_thread:
            await interaction.response.send_message("このボタンはプライベートスレッド内でのみ使えます。", ephemeral=True)
            return
        await interaction.response.send_message(
            "このプライベートスレッドと会話履歴を削除しますか？この操作は取り消せません。",
            view=DeleteThreadConfirmView(self.cog, channel.id, interaction.user.id),
            ephemeral=True,
        )


class DeleteThreadConfirmView(discord.ui.View):
    def __init__(self, cog, thread_id: int, requester_id: int):
        super().__init__(timeout=60)
        self.cog = cog
        self.thread_id = thread_id
        self.requester_id = requester_id

    @discord.ui.button(label="削除する", style=discord.ButtonStyle.danger)
    async def confirm_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        if interaction.channel_id != self.thread_id or not isinstance(interaction.channel, discord.Thread):
            await interaction.response.send_message("対象のスレッドを確認できません。", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            await interaction.channel.delete(reason="ZetaModoki private conversation deleted by user")
        except discord.HTTPException:
            await interaction.followup.send("スレッドを削除できませんでした。Botのスレッド管理権限を確認してください。", ephemeral=True)
            return
        self.cog.active_personas.pop(self.thread_id, None)
        self.cog.chat_histories.pop(self.thread_id, None)
        self.cog.failed_requests.pop(self.thread_id, None)
        await interaction.followup.send("プライベートスレッドを削除しました。", ephemeral=True)

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        await interaction.response.edit_message(content="削除をキャンセルしました。", view=None)


# --- ドロップダウンUI ---
class SessionModeSelect(discord.ui.Select):
    def __init__(self, parent_view):
        self.parent_view = parent_view
        options = [
            discord.SelectOption(
                label="公開チャンネル",
                value="public",
                description="会話をこのチャンネルで行います",
                default=parent_view.mode == "public",
            ),
            discord.SelectOption(
                label="プライベートスレッド",
                value="private",
                description="自分とBotだけが見えるスレッドで会話します",
                default=parent_view.mode == "private",
            ),
        ]
        super().__init__(placeholder="会話モードを選択してください", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.mode = self.values[0]
        self.parent_view.rebuild()
        label = "公開チャンネル" if self.parent_view.mode == "public" else "プライベートスレッド"
        await interaction.response.edit_message(
            content=f"会話モード: **{label}**。続けてキャラクターを選択してください。",
            view=self.parent_view,
        )


class CharacterSelect(discord.ui.Select):
    def __init__(self, cog, parent_view):
        self.cog = cog
        self.parent_view = parent_view
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
        super().__init__(placeholder="会話したいキャラクターを選択してください", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        selected_key = self.values[0]
        persona = PRESETS[selected_key]
        target_channel = interaction.channel
        if self.parent_view.mode == "private":
            if not isinstance(interaction.channel, discord.TextChannel):
                await interaction.response.send_message(
                    "プライベートスレッドは通常のテキストチャンネルから開始してください。",
                    ephemeral=True,
                )
                return
            await interaction.response.defer()
            thread = None
            try:
                thread = await interaction.channel.create_thread(
                    name=f"{persona.name}との会話",
                    type=discord.ChannelType.private_thread,
                    invitable=False,
                    auto_archive_duration=1440,
                )
                await thread.add_user(interaction.user)
                target_channel = thread
            except discord.HTTPException:
                if thread is not None:
                    try:
                        await thread.delete(reason="Failed to add conversation starter")
                    except discord.HTTPException:
                        pass
                await interaction.edit_original_response(
                    content="プライベートスレッドを作成できませんでした。Botにプライベートスレッド作成・管理権限があるか確認してください。",
                    view=None,
                )
                return
        else:
            await interaction.response.defer()

        channel_id = target_channel.id
        self.cog.active_personas[channel_id] = persona
        self.cog.chat_histories[channel_id] = []
        self.cog.failed_requests.pop(channel_id, None)

        is_private_thread = (
            isinstance(target_channel, discord.Thread)
            and target_channel.type == discord.ChannelType.private_thread
        )
        mode_text = "プライベートスレッド" if is_private_thread else "公開チャンネル"
        await interaction.edit_original_response(
            content=f"【{persona.name}】で会話を開始します。会話先: {target_channel.mention}（{mode_text}）",
            view=None,
        )

        # 2. チャンネル全体に見える Embed を作成して送信
        embed = discord.Embed(
            title=f"【{persona.name}】との会話を開始しました！",
            description=f"**シチュエーション:**\n{persona.situation}",
            color=discord.Color.purple()
        )
        embed.set_footer(text="下の「返信する」ボタンから入力して対話を進めてください")
        
        await target_channel.send(embed=embed)

        # 3. キャラクターの初期メッセージを Webhook で送信
        first_msg_formatted = self.cog._format_narration(persona.first_message)
        try:
            await self.cog._send_webhook_message(
                channel=target_channel,
                channel_id=channel_id,
                content=first_msg_formatted
            )
        except Exception as e:
            await target_channel.send(
                f"**{persona.name}**: {first_msg_formatted}", 
                view=ChatButtonView(
                    self.cog,
                    private_thread=isinstance(target_channel, discord.Thread)
                    and target_channel.type == discord.ChannelType.private_thread,
                ),
            )
            print(f"Webhook送信エラー: {e}")


class CharacterSelectView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=60)
        self.cog = cog
        self.mode = "public"
        self.rebuild()

    def rebuild(self):
        self.clear_items()
        self.add_item(SessionModeSelect(self))
        self.add_item(CharacterSelect(self.cog, self))


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
        self.failed_requests: Dict[int, dict] = {}

    async def start(self, interaction: discord.Interaction):
        view = CharacterSelectView(self)
        await interaction.response.send_message(
            "会話モードと、対話したいキャラクターを選択してください：",
            view=view,
            ephemeral=True,
        )

    async def reset(self, interaction: discord.Interaction):
        channel_id = interaction.channel_id
        if channel_id in self.chat_histories:
            self.chat_histories[channel_id] = []
            self.failed_requests.pop(channel_id, None)
            await interaction.response.send_message("このチャンネルの会話履歴をリセットしました。", ephemeral=True)
        else:
            await interaction.response.send_message("リセットする会話履歴がありません。", ephemeral=True)

    def _format_narration(self, text: str) -> str:
        """カッコ （） や () で囲まれたナレーション表現の前に -# を挿入して薄文字化する"""
        text = re.sub(r'（(.*?)）', r'\n-# （\1）\n', text)
        text = re.sub(r'\((.*?)\)', r'\n-# (\1)\n', text)
        text = re.sub(r'\n+', '\n', text).strip()
        return text

    async def _get_or_create_webhook(self, channel: discord.TextChannel | discord.Thread) -> discord.Webhook:
        """親テキストチャンネルから管理用Webhookを取得または作成する"""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        if not isinstance(parent, discord.TextChannel):
            raise RuntimeError("Webhookの親テキストチャンネルを取得できませんでした。")
        webhooks = await parent.webhooks()
        for wh in webhooks:
            if wh.name == "ZetaModoki_Webhook":
                return wh
        return await parent.create_webhook(name="ZetaModoki_Webhook")

    async def _send_webhook_message(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        content: str,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        include_view: bool = True,
    ):
        """キャラクターの名前・アイコンを設定し、長文を分割して送る"""
        persona = self.active_personas.get(channel_id)
        if not persona:
            return

        webhook = await self._get_or_create_webhook(channel)
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        send_kwargs = {"thread": channel} if isinstance(channel, discord.Thread) else {}
        parts = self._split_long_message(content)
        sent_messages = []
        for index, part in enumerate(parts):
            view = None
            if include_view and index == len(parts) - 1:
                view = ChatButtonView(
                    self,
                    retry_owner_id=retry_owner_id,
                    retry_input=retry_input,
                    private_thread=private_thread,
                )
            message_kwargs = dict(
                content=part,
                username=persona.name,
                avatar_url=persona.icon_url,
                **send_kwargs,
                wait=True,
            )
            if view is not None:
                message_kwargs["view"] = view
            message = await webhook.send(**message_kwargs)
            if message is not None:
                sent_messages.append(message)
        return sent_messages

    async def _send_streamed_response(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        user_input: str,
        requester_id: int,
    ):
        """Logfareの生成差分を文単位で送り、失敗時は再試行ボタンを付ける。"""
        pending = ""
        last_message = None

        async def send_ready_text(delta: str):
            nonlocal pending, last_message
            pending += delta
            while True:
                cut = self._ready_stream_cut(pending)
                if cut is None:
                    break
                part, pending = pending[:cut], pending[cut:]
                sent = await self._send_webhook_message(
                    channel=channel,
                    channel_id=channel_id,
                    content=self._format_narration(part.strip()),
                    include_view=False,
                )
                if sent:
                    last_message = sent[-1]

        response_text = await self._generate_response(
            channel_id,
            user_input,
            on_delta=send_ready_text,
            requester_id=requester_id,
        )
        is_error = response_text.startswith(("（エラーが発生しました:", "（AIから返答がありませんでした"))
        if pending.strip():
            sent = await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(pending.strip()),
                include_view=not is_error,
            )
            if sent:
                last_message = sent[-1]
        if is_error:
            await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(response_text),
                retry_owner_id=requester_id,
                retry_input=user_input,
            )
        elif pending.strip() == "" and last_message is not None:
            private_thread = (
                isinstance(channel, discord.Thread)
                and channel.type == discord.ChannelType.private_thread
            )
            await last_message.edit(
                view=ChatButtonView(self, private_thread=private_thread)
            )
        return response_text

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

    async def _generate_response(
        self,
        channel_id: int,
        user_input: str,
        on_delta=None,
        requester_id: int | None = None,
    ) -> str:
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
                if requester_id is not None:
                    self.failed_requests[channel_id] = {
                        "user_id": requester_id,
                        "user_input": user_input,
                    }
                return "（AIから返答がありませんでした。少し待ってからもう一度試してください。）"

            # 履歴管理（直近20件）
            history.append({"user": user_input, "bot": bot_reply})
            if len(history) > 20:
                history = history[-20:]
            self.chat_histories[channel_id] = history
            self.failed_requests.pop(channel_id, None)

            return bot_reply

        except Exception as e:
            if requester_id is not None:
                self.failed_requests[channel_id] = {
                    "user_id": requester_id,
                    "user_input": user_input,
                }
            return f"（エラーが発生しました: {e}）"


async def setup(bot: commands.Bot):
    await bot.add_cog(ZetaModoki(bot))
