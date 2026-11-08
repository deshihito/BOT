# -*- coding: utf-8 -*-
"""fastHTML（一時HTML埋め込み）。

/general のアクションから起動し、ユーザーがチャンネルに送った HTML
ファイルを一時 URL（https://fast.agobot.app/fast/<token>、60分）で公開する。

サーバー側は HTML 実体を一切保存しない。添付実体は Discord CDN 上にだけ
あり、Bot はその署名付き CDN URL を BOT_API_KEY で HMAC 署名した
トークンに包んで渡すだけ。Web（fast.agobot.app）は署名を検証し、
CDN からそのまま中継する。HTML の中身は検査・変換せず、実行は
開いた人のブラウザ側で完結する（配信側の sandbox ヘッダで隔離）。
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import time

import discord

from core.general.attachment_wait import (
    AttachmentWaitCancelView,
    edit_original_response_quietly,
    wait_for_attachment,
)

logger = logging.getLogger("cogs.general")

FAST_HTML_WAIT_TIMEOUT = 120.0        # ファイル投稿を待つ秒数（meme と同じ）
FAST_HTML_TTL_SECONDS = 60 * 60       # 一時URLの有効期限（60分）
FAST_HTML_MAX_BYTES = 5 * 1024 * 1024  # 添付のサイズ上限（Web の中継側でも強制）
FAST_HTML_EXTS = (".html", ".htm")
# 発行クールダウン: URL 発行を短時間に連打させないための下限間隔。
# 待ちフロー自体が120秒あるため、体感を損なわない10秒。
FAST_HTML_COOLDOWN_SECONDS = 10.0
FAST_HTML_PUBLIC_BASE = (
    os.getenv("FASTHTML_PUBLIC_BASE_URL") or "https://fast.agobot.app"
).rstrip("/")

# 添付実体が置かれる Discord CDN の URL 接頭辞。これ以外はトークンに包まない。
FAST_HTML_CDN_PREFIXES = (
    "https://cdn.discordapp.com/attachments/",
    "https://media.discordapp.net/attachments/",
)
FAST_HTML_TOKEN_VERSION = "v1"


def fast_html_public_url(token: str) -> str:
    return f"{FAST_HTML_PUBLIC_BASE}/fast/{token}"


def _fast_html_attachment(message) -> object | None:
    """メッセージの添付から HTML らしいものを1つ返す (無ければ None)。"""
    for att in getattr(message, "attachments", None) or []:
        filename = (getattr(att, "filename", "") or "").lower()
        if filename.endswith(FAST_HTML_EXTS):
            return att
    return None


def fast_html_attachment_error(att) -> str | None:
    """添付の事前検証。問題があればユーザー向け文面、無ければ None。"""
    filename = (getattr(att, "filename", "") or "")
    if not filename.lower().endswith(FAST_HTML_EXTS):
        return "HTMLファイル（.html / .htm）を送ってください。"
    size = getattr(att, "size", 0) or 0
    if size > FAST_HTML_MAX_BYTES:
        return (
            f"ファイルが大きすぎます（上限 {FAST_HTML_MAX_BYTES // (1024 * 1024)}MB）。"
        )
    return None


def _fast_html_display_name(filename: str) -> str:
    """embed 表示用にファイル名を整える（改行・バッククォート除去、長さ制限）。"""
    name = "".join(ch for ch in (filename or "") if ch not in "\r\n`")
    return (name or "index.html")[:100]


# ------------------------------------------------------------
# 署名付きトークン（サーバーは実体を持たず、CDN URL を包むだけ）
# ------------------------------------------------------------
def fast_html_cdn_url_ok(url) -> bool:
    """Discord CDN の添付 URL かどうか（att.url は署名付き CDN URL）。"""
    return isinstance(url, str) and url.startswith(FAST_HTML_CDN_PREFIXES)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _fast_html_signing_key() -> bytes | None:
    key = (os.getenv("BOT_API_KEY") or "").strip()
    return key.encode("utf-8") if key else None


def create_fast_html_token(cdn_url: str, *, now: float | None = None) -> tuple[str, int] | None:
    """CDN URL を署名付きトークンに包み (token, expires_at) を返す。

    形式は v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)> で、
    署名対象は "v1.<base64url(payload)>"。Web 側が同じ BOT_API_KEY で
    検証する。BOT_API_KEY 未設定なら None（発行基盤が未設定）。
    """
    key = _fast_html_signing_key()
    if key is None:
        return None
    issued = int(time.time() if now is None else now)
    expires_at = issued + FAST_HTML_TTL_SECONDS
    payload = json.dumps(
        {"u": cdn_url, "exp": expires_at}, separators=(",", ":"),
    )
    signing_input = f"{FAST_HTML_TOKEN_VERSION}.{_b64url_encode(payload.encode('utf-8'))}"
    signature = hmac.new(
        key, signing_input.encode("ascii"), hashlib.sha256,
    ).digest()
    return f"{signing_input}.{_b64url_encode(signature)}", expires_at


# ------------------------------------------------------------
# Views
# ------------------------------------------------------------
class FastHtmlCancelView(AttachmentWaitCancelView):
    """ファイル待ちをキャンセルするためのボタン。"""

    def __init__(self, cog: "FastHtmlMixin", key: tuple[int, int], user_id: int):
        super().__init__(
            cog, "_fast_html_waits", key, user_id,
            timeout=FAST_HTML_WAIT_TIMEOUT + 30,
            cancel_text="fastHTMLをキャンセルしました。",
        )


class FastHtmlResultView(discord.ui.View):
    """発行結果の「開く」リンク＋本人だけ押せる「リンクを無効化」ボタン。

    実体は Discord CDN 上の元の投稿にしか無いため、無効化は
    (1) この結果メッセージを無効化済みの文面に差し替え、
    (2) 元の投稿メッセージの削除を試みる（消えれば CDN 実体も消え、
    中継は 404 になる）。削除権限が無くても例外にはしない。
    """

    def __init__(self, cog: "FastHtmlMixin", token: str, owner_id: int,
                 source_message=None):
        super().__init__(timeout=FAST_HTML_TTL_SECONDS)
        self.cog, self.token, self.owner_id = cog, token, owner_id
        self.source_message = source_message
        self.add_item(discord.ui.Button(
            label="開く", style=discord.ButtonStyle.link,
            url=fast_html_public_url(token),
        ))

    @discord.ui.button(label="リンクを無効化", style=discord.ButtonStyle.danger)
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message(
                "アップロードした本人だけ無効化できます。", ephemeral=True
            )
        await interaction.response.edit_message(
            content="このリンクは無効化されました。", view=None,
        )
        source = self.source_message
        if source is not None:
            try:
                await source.delete()
            except Exception:
                logger.debug(
                    "fastHTML: 元の投稿メッセージを削除できませんでした",
                    exc_info=True,
                )


# ------------------------------------------------------------
# フロー本体
# ------------------------------------------------------------
class FastHtmlMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    async def _fast_html_start(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel is None:
            return await interaction.response.send_message(
                "チャンネルが特定できませんでした。", ephemeral=True
            )
        key = (channel.id, interaction.user.id)
        if key in self._fast_html_waits:
            return await interaction.response.send_message(
                "このチャンネルでは既にfastHTMLのファイル待ち中です。"
                "HTMLファイルを投稿するか、先にキャンセルしてください。",
                ephemeral=True,
            )
        last = self._fast_html_last_issue.get(interaction.user.id, 0.0)
        remain = FAST_HTML_COOLDOWN_SECONDS - (time.monotonic() - last)
        if last and remain > 0:
            return await interaction.response.send_message(
                f"発行が続いています。あと{int(remain) + 1}秒待ってからお試しください。",
                ephemeral=True,
            )
        event = asyncio.Event()
        self._fast_html_waits[key] = event
        await interaction.response.send_message(
            "このチャンネルに、公開したいHTMLファイル（.html / .htm、"
            f"{FAST_HTML_MAX_BYTES // (1024 * 1024)}MBまで）を投稿してください"
            f"（{int(FAST_HTML_WAIT_TIMEOUT)}秒以内）。\n"
            "発行される一時URLは60分有効で、HTMLはあなたのブラウザで実行されます。",
            view=FastHtmlCancelView(self, key, interaction.user.id),
        )
        self._spawn(self._fast_html_wait_for_file(interaction, key, event))

    async def _fast_html_wait_for_file(self, interaction, key, event):
        channel_id, user_id = key

        def check(m) -> bool:
            return (
                getattr(m.author, "id", None) == user_id
                and getattr(m.channel, "id", None) == channel_id
                and _fast_html_attachment(m) is not None
            )

        try:
            kind, msg = await wait_for_attachment(
                self.bot, check=check, event=event, timeout=FAST_HTML_WAIT_TIMEOUT)
            if kind == "cancel":
                return  # キャンセルボタン側で案内済み
            if kind == "timeout":
                await edit_original_response_quietly(
                    interaction, "fastHTML",
                    content="時間切れのためfastHTMLを終了しました。", view=None)
                return
            att = _fast_html_attachment(msg)
            if att is None:
                return
            error = fast_html_attachment_error(att)
            if error is not None:
                await msg.reply(
                    f"{error}fastHTMLを終了しました。", mention_author=False,
                )
                return
            # 実体はダウンロードしない。Discord CDN 上の添付 URL を
            # 署名付きトークンに包むだけ（サーバーは実体を保存しない）。
            cdn_url = getattr(att, "url", "") or ""
            if not fast_html_cdn_url_ok(cdn_url):
                await msg.reply(
                    "一時URLを発行できませんでした。時間をおいてお試しください。",
                    mention_author=False,
                )
                return
            now = time.time()
            created = create_fast_html_token(cdn_url, now=now)
            if created is None:
                await msg.reply(
                    "一時URLの発行基盤が未設定のため、今は利用できません。",
                    mention_author=False,
                )
                return
            token, expires_at = created
            self._fast_html_last_issue[user_id] = time.monotonic()
            embed = discord.Embed(title="fastHTML", color=0xFFFFFF)
            embed.add_field(
                name="ファイル", value=_fast_html_display_name(att.filename), inline=False,
            )
            embed.add_field(
                name="有効期限", value=f"<t:{expires_at}:R>（60分）", inline=False,
            )
            embed.set_footer(
                text="リンクを知っている人は開けます。HTMLは開いた人のブラウザで実行されます。",
            )
            await msg.reply(
                embed=embed,
                view=FastHtmlResultView(self, token, user_id, source_message=msg),
                mention_author=False,
            )
            await edit_original_response_quietly(
                interaction, "fastHTML", content="fastHTMLを発行しました。", view=None)
        except Exception:
            logger.exception("fastHTML: ファイル待ち処理に失敗しました")
        finally:
            self._fast_html_waits.pop(key, None)
