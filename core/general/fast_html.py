# -*- coding: utf-8 -*-
"""fastHTML（一時HTML埋め込み）。

/general のアクションから起動し、ユーザーがチャンネルに送った HTML
ファイルを一時 URL（https://agobot.app/fast/<token>、60分）で公開する。
ファイル実体は Bot 自前 API（api/app.py の /v1/fast）の管理下に置き、
Web（agobot.app）はそれを中継するだけ。HTML の中身は検査・変換せず、
実行は開いた人のブラウザ側で完結する（配信側の sandbox ヘッダで隔離）。
"""
from __future__ import annotations

import asyncio
import base64
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
FAST_HTML_TTL_SECONDS = 60 * 60       # 一時URLの有効期限（API側の保持期間と一致）
FAST_HTML_MAX_BYTES = 5 * 1024 * 1024  # 添付のサイズ上限（API側でも同じ値を強制）
FAST_HTML_EXTS = (".html", ".htm")
FAST_HTML_MAX_ACTIVE_PER_USER = 3     # 同時発行の上限（API側でも同じ値を強制）
# 発行クールダウン: 5MB級のアップロードと URL 発行を短時間に連打させない
# ための下限間隔。待ちフロー自体が120秒あるため、体感を損なわない10秒。
FAST_HTML_COOLDOWN_SECONDS = 10.0
FAST_HTML_PUBLIC_BASE = (
    os.getenv("FASTHTML_PUBLIC_BASE_URL") or "https://agobot.app"
).rstrip("/")


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
# Bot 自前 API（/v1/fast）クライアント
# ------------------------------------------------------------
class FastHtmlApiError(RuntimeError):
    def __init__(self, message: str, *, code: str = "API_ERROR", status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


def _fast_html_api_config() -> tuple[str, str] | None:
    base = (os.getenv("BOT_API_BASE_URL") or "").strip()
    key = (os.getenv("BOT_API_KEY") or "").strip()
    if not base or not key:
        return None
    return base.rstrip("/"), key


def _fast_html_api_request(method: str, path: str, *, payload: dict | None = None,
                           timeout: float = 30.0) -> dict:
    """API へ同期リクエストする（呼び出し側で to_thread すること）。"""
    import requests

    config = _fast_html_api_config()
    if config is None:
        raise FastHtmlApiError(
            "BOT_API_BASE_URL または BOT_API_KEY が設定されていません",
            code="API_NOT_CONFIGURED",
        )
    base, key = config
    try:
        response = requests.request(
            method,
            f"{base}{path}",
            json=payload,
            headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise FastHtmlApiError("自前APIに接続できません", code="API_CONNECTION_ERROR") from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not response.ok:
        detail = body.get("detail", {}) if isinstance(body, dict) else {}
        if isinstance(detail, dict):
            message = str(detail.get("message", "API request failed"))
            code = str(detail.get("code", "API_ERROR"))
        else:
            message, code = "API request failed", "API_ERROR"
        raise FastHtmlApiError(message, code=code, status_code=response.status_code)
    data = body.get("data", {}) if isinstance(body, dict) else {}
    return data if isinstance(data, dict) else {}


def fast_html_api_create(filename: str, owner_id: int, data: bytes) -> dict:
    """HTML を API へ保存し {token, expires_at, size} を返す（同期）。"""
    return _fast_html_api_request(
        "POST",
        "/v1/fast",
        payload={
            "filename": (filename or "index.html")[:200],
            "owner_id": str(owner_id),
            "content_b64": base64.b64encode(data).decode("ascii"),
        },
    )


def fast_html_api_delete(token: str, owner_id: int) -> bool:
    """本人の発行分を削除する（同期）。既に無い場合は False。"""
    try:
        _fast_html_api_request(
            "DELETE", f"/v1/fast/{token}", payload={"owner_id": str(owner_id)},
            timeout=10.0,
        )
        return True
    except FastHtmlApiError as exc:
        if exc.status_code == 404:
            return False
        raise


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
    """発行結果の「開く」リンク＋本人だけ押せる「削除」ボタン。"""

    def __init__(self, cog: "FastHtmlMixin", token: str, owner_id: int):
        super().__init__(timeout=FAST_HTML_TTL_SECONDS)
        self.cog, self.token, self.owner_id = cog, token, owner_id
        self.add_item(discord.ui.Button(
            label="開く", style=discord.ButtonStyle.link,
            url=fast_html_public_url(token),
        ))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger)
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message(
                "アップロードした本人だけ削除できます。", ephemeral=True
            )
        try:
            await asyncio.to_thread(
                fast_html_api_delete, self.token, self.owner_id,
            )
        except FastHtmlApiError:
            logger.debug("fastHTML: 削除API呼び出しに失敗しました", exc_info=True)
            return await interaction.response.send_message(
                "削除できませんでした。時間をおいてもう一度お試しください。",
                ephemeral=True,
            )
        await interaction.response.edit_message(
            content="fastHTMLを削除しました。リンクは無効になりました。", view=None,
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
            try:
                data = await att.read()
            except Exception:
                logger.debug("fastHTML: 添付ファイルの取得に失敗しました", exc_info=True)
                await msg.reply("ファイルを取得できませんでした。", mention_author=False)
                return
            if len(data) > FAST_HTML_MAX_BYTES:
                await msg.reply(
                    f"ファイルが大きすぎます（上限 "
                    f"{FAST_HTML_MAX_BYTES // (1024 * 1024)}MB）。"
                    "fastHTMLを終了しました。",
                    mention_author=False,
                )
                return
            try:
                result = await asyncio.to_thread(
                    fast_html_api_create, att.filename, user_id, data,
                )
            except FastHtmlApiError as exc:
                logger.debug("fastHTML: 発行API呼び出しに失敗しました", exc_info=True)
                if exc.code == "FASTHTML_LIMIT":
                    text = (
                        f"同時に公開できるのは{FAST_HTML_MAX_ACTIVE_PER_USER}件までです。"
                        "有効期限（60分）が切れるか、発行済みの削除ボタンで消してから"
                        "もう一度お試しください。"
                    )
                elif exc.code == "API_NOT_CONFIGURED":
                    text = "一時URLの発行基盤が未設定のため、今は利用できません。"
                else:
                    text = "一時URLを発行できませんでした。時間をおいてお試しください。"
                await msg.reply(text, mention_author=False)
                return
            token = str(result.get("token") or "")
            if not token:
                await msg.reply(
                    "一時URLを発行できませんでした。時間をおいてお試しください。",
                    mention_author=False,
                )
                return
            self._fast_html_last_issue[user_id] = time.monotonic()
            expires_at = int(result.get("expires_at") or 0)
            embed = discord.Embed(title="fastHTML", color=0xFFFFFF)
            embed.add_field(
                name="ファイル", value=_fast_html_display_name(att.filename), inline=False,
            )
            if expires_at:
                embed.add_field(
                    name="有効期限", value=f"<t:{expires_at}:R>（60分）", inline=False,
                )
            embed.set_footer(
                text="リンクを知っている人は開けます。HTMLは開いた人のブラウザで実行されます。",
            )
            await msg.reply(
                embed=embed,
                view=FastHtmlResultView(self, token, user_id),
                mention_author=False,
            )
            await edit_original_response_quietly(
                interaction, "fastHTML", content="fastHTMLを発行しました。", view=None)
        except Exception:
            logger.exception("fastHTML: ファイル待ち処理に失敗しました")
        finally:
            self._fast_html_waits.pop(key, None)
