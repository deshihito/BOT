import logging
import re

import discord
from core.emojis import SUCCESS, FAILED
from discord import app_commands
from discord.ext import commands

from core.guild_settings import get_store

logger = logging.getLogger(__name__)

# 以前から使っている自己紹介チャンネル（個別設定がない場合の既定値）
INTRO_CHANNEL_ID = 1531592567131734056
WEBHOOK_NAME = "AGOBOT 自己紹介"
PANEL_SETTINGS_ID = "verify_button:settings"  # 旧設定画面から送られたパネル（ロールは設定から読む）


def auth_settings(guild_id: int) -> dict:
    """認証の設定。未設定の項目は以前の動き（フォーム有効・固定の自己紹介チャンネル）になる。"""
    saved = get_store().get(guild_id, "auth")
    return {
        "enabled": saved.get("enabled", True),
        "role_id": saved.get("role_id"),
        "intro_channel_id": saved.get("intro_channel_id") or INTRO_CHANNEL_ID,
    }


def sanitize_webhook_name(name: str | None) -> str:
    """Webhook の表示名に使えない文字列（「discord」「clyde」など）を避けて、1〜80 文字にする。"""
    text = (name or "").strip()
    text = re.sub(r"(?i)discord", lambda m: m.group(0)[:4] + "\u200b" + m.group(0)[4:], text)
    text = re.sub(r"(?i)clyde", lambda m: m.group(0)[:3] + "\u200b" + m.group(0)[3:], text)
    if text.lower() in ("everyone", "here"):
        text = f"{text}さん"
    text = text[:80].strip()
    return text or "名無し"


async def get_intro_webhook(channel, bot_user_id: int):
    """この Bot が作った Webhook を使う（なければ作る）。ほかの Bot・連携の Webhook は使わない。"""
    for webhook in await channel.webhooks():
        owner = getattr(webhook, "user", None)
        if owner is not None and owner.id == bot_user_id and getattr(webhook, "token", None):
            return webhook
    return await channel.create_webhook(name=WEBHOOK_NAME)


def role_failure_reason(guild, role) -> str:
    me = getattr(guild, "me", None)
    perms = getattr(me, "guild_permissions", None)
    if perms is not None and not perms.manage_roles:
        return "Bot に「ロールの管理」権限がありません。"
    top = getattr(me, "top_role", None)
    if top is not None and role >= top:
        return f"Bot のロールが「{role.name}」より下にあります。サーバー設定で Bot のロールを上に移動してください。"
    return "Bot にこのロールを付ける権限がありません。"

class QuestionModal(discord.ui.Modal, title="認証フォーム"):
    q1 = discord.ui.TextInput(
        label="あだ名はなんですか？(5文字以内)",
        placeholder="5文字以内で入力",
        max_length=5,
        required=True
    )
    q2 = discord.ui.TextInput(
        label="一番のウリはなんですか？",
        style=discord.TextStyle.paragraph,
        required=True
    )
    q3 = discord.ui.TextInput(
        label="堅実型ですか、発想型ですか？",
        placeholder="堅実型 または 発想型",
        required=True
    )
    q4 = discord.ui.TextInput(
        label="あなたは自分に寛容になれますか(Y/N)",
        placeholder="Y または N",
        max_length=2,
        required=True
    )

    def __init__(self, role_id: int, intro_channel_id: int | None = None):
        super().__init__()
        self.role_id = role_id
        self.intro_channel_id = intro_channel_id

    async def on_submit(self, interaction: discord.Interaction):
        ans1 = self.q1.value.strip()
        ans2 = self.q2.value.strip()
        ans3 = self.q3.value.strip()
        ans4 = self.q4.value.strip().upper()

        if len(ans1) > 5 or len(ans1) == 0:
            await interaction.response.send_message("あだ名は5文字以内で入力してください。", ephemeral=True)
            return

        if ans3 not in ["堅実型", "発想型"]:
            await interaction.response.send_message("3つ目の質問は「堅実型」または「発想型」で回答してください。", ephemeral=True)
            return

        if ans4 not in ["Y", "N", "Ｙ", "Ｎ"]:
            await interaction.response.send_message("4つ目の質問は Y または N で回答してください。", ephemeral=True)
            return

        role = interaction.guild.get_role(self.role_id)
        if role is None:
            await interaction.response.send_message("指定されたロールが存在しません。", ephemeral=True)
            return
        if role in getattr(interaction.user, "roles", []):
            await interaction.response.send_message("あなたはすでに認証済みです。", ephemeral=True)
            return

        # ロールの付与と投稿は時間がかかることがあるので、先に応答を保留する。
        await interaction.response.defer(ephemeral=True, thinking=True)

        # 先にロールを付ける。付けられなかったときは自己紹介も投稿しない。
        try:
            await interaction.user.add_roles(role, reason="認証フォーム")
        except discord.Forbidden:
            await interaction.followup.send(
                f"{FAILED} ロールを付けられなかったため、認証できませんでした。管理者に伝えてください。\n理由: {role_failure_reason(interaction.guild, role)}",
                ephemeral=True,
            )
            return
        except discord.HTTPException:
            logger.warning("認証ロールの付与に失敗しました", exc_info=True)
            await interaction.followup.send(
                f"{FAILED} ロールを付けられませんでした（Discord との通信エラー）。少し待ってからもう一度試してください。", ephemeral=True,
            )
            return

        intro_channel = interaction.guild.get_channel(self.intro_channel_id) if self.intro_channel_id else None
        if intro_channel:
            content = (
                f"【あだ名】\n{ans1}\n\n"
                f"【一番のウリ】\n{ans2}\n\n"
                f"【タイプ】\n{ans3}\n\n"
                f"【自分への寛容さ】\n{ans4}"
            )
            try:
                webhook = await get_intro_webhook(intro_channel, interaction.client.user.id)
                await webhook.send(
                    content=content,
                    username=sanitize_webhook_name(interaction.user.display_name),
                    avatar_url=interaction.user.display_avatar.url,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            except discord.HTTPException:
                logger.warning("自己紹介の投稿に失敗しました（認証は完了）", exc_info=True)

        await interaction.followup.send(f"{SUCCESS} 認証が完了しました。ロールを付与しました。", ephemeral=True)

class VerifyView(discord.ui.View):
    def __init__(self, role_id: int | None):
        super().__init__(timeout=None)
        button = discord.ui.Button(
            label="認証を開始する",
            style=discord.ButtonStyle.green,
            custom_id=f"verify_button:{role_id}" if role_id else PANEL_SETTINGS_ID,
        )
        self.add_item(button)

class VerificationCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type == discord.InteractionType.component:
            custom_id = interaction.data.get("custom_id", "")
            if custom_id.startswith("verify_button:"):
                await self.start_verification(interaction, custom_id.split(":", 1)[1])

    async def start_verification(self, interaction: discord.Interaction, panel_role: str) -> None:
        """認証ボタンが押されたとき。パネルに書かれたロール（以前のパネル）か保存済み設定のロールを使う。"""
        await get_store().ensure_loaded()
        settings = auth_settings(interaction.guild_id)
        if not settings["enabled"]:
            await interaction.response.send_message("いまこのサーバーでは認証フォームを停止しています。", ephemeral=True)
            return
        role_id = int(panel_role) if panel_role.isdigit() else settings["role_id"]
        role = interaction.guild.get_role(role_id) if role_id else None
        if role is None:
            await interaction.response.send_message(
                "認証で付けるロールが見つかりません。サーバー管理者にお問い合わせください。", ephemeral=True,
            )
            return
        if role in getattr(interaction.user, "roles", []):
            await interaction.response.send_message("あなたはすでに認証済みです。", ephemeral=True)
            return
        await interaction.response.send_modal(QuestionModal(role.id, settings["intro_channel_id"]))

async def sync_category_perms(category, role) -> int:
    """カテゴリを「@everyone には見えない・role には見える」にして、中のチャンネルを同期する。同期した数を返す。

    もとは /sync_category_perms。旧設定ウィザードから使われていた。
    """
    everyone_role = category.guild.default_role
    overwrites = {
        everyone_role: discord.PermissionOverwrite(view_channel=False),
        role: discord.PermissionOverwrite(view_channel=True),
    }
    await category.edit(overwrites=overwrites)
    count = 0
    for channel in category.channels:
        await channel.edit(sync_permissions=True)
        count += 1
    return count


async def setup(bot: commands.Bot):
    await bot.add_cog(VerificationCog(bot))
