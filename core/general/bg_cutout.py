# -*- coding: utf-8 -*-
"""背景透過・絵文字/スタンプ化（make_image ジャンルのアクション）。

処理はユーザーのブラウザ側で実行する（クライアントサイド処理）。
このモジュールが担うのは次の3つだけ:

1. 用途（絵文字用／スタンプ用）を選ぶ開始パネル（公開）。
2. 署名付き一時リンクの発行。fastHTML と同じ方式で、BOT_API_KEY を
   HMAC 鍵にした署名付きトークン（TTL 60分）に、発行ユーザー・用途・
   発行元ギルド/チャンネル・ジョブID を包む。Web 側が同じ鍵で検証する。
3. Web で処理された結果の受け取りと公開投稿。Web が bot_kv の
   ``bgcut_results`` 名前空間へ結果（base64＋メタ）を書き、Bot が
   30秒ポーリングで拾って発行元チャンネルへ投稿し、投稿後に消す。

リンク自体は発行者本人だけに見せる（エフェメラル）。パネル側には
「リンクを発行した」旨だけを公開表示し、存在感と秘匿を両立させる。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from discord.ext import tasks

from .common import *
from core.support.storage import KVStore

BG_CUTOUT_TTL_SECONDS = 60 * 60        # 一時リンクの有効期限（60分）
BG_CUTOUT_COOLDOWN_SECONDS = 10.0      # 発行クールダウン（fastHTML と同値）
BG_CUTOUT_POLL_SECONDS = 30.0          # 結果ポーリング間隔
# 結果レコードの保持上限。トークン TTL（60分）＋投稿までの余裕。
BG_CUTOUT_RESULT_TTL_SECONDS = BG_CUTOUT_TTL_SECONDS + 300.0
BG_CUTOUT_RESULTS_NAMESPACE = "bgcut_results"
BG_CUTOUT_TOKEN_VERSION = "v1"
BG_CUTOUT_PUBLIC_BASE = (
    os.getenv("BGCUT_PUBLIC_BASE_URL") or "https://agobot.app"
).rstrip("/")
BG_CUTOUT_PURPOSES = {
    "emoji": "絵文字用（256KB以下・最大128×128）",
    "sticker": "スタンプ用（512KB以下・320×320）",
}

# テスト用: 名前空間→KV互換オブジェクト（load_all/delete を持つもの）の差し替え。
_kv_factory = None


def _get_results_kv():
    if _kv_factory is not None:
        return _kv_factory(BG_CUTOUT_RESULTS_NAMESPACE)
    return KVStore(BG_CUTOUT_RESULTS_NAMESPACE)


def set_kv_factory(factory) -> None:
    """テスト用: 結果 KV の読み書き先を差し替える。"""
    global _kv_factory
    _kv_factory = factory


def _fmt_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 10 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024:.1f} KB"


def bgcut_result_text(meta: dict) -> str:
    """結果表示の文面（用途・変換前後のサイズと寸法）。"""
    purpose_label = "絵文字用" if meta["purpose"] == "emoji" else "スタンプ用"
    lines = [
        f"背景透過が完了しました（{purpose_label}・{meta['format']}）",
        f"変換前：{_fmt_bytes(meta['in_bytes'])}"
        f"（{meta['in_width']}×{meta['in_height']}）"
        f" → 変換後：{_fmt_bytes(meta['out_bytes'])}"
        f"（{meta['width']}×{meta['height']}）",
    ]
    for note in meta.get("notes") or []:
        lines.append(f"※ {note}")
    lines.append("このままダウンロードして、絵文字／スタンプとしてアップロードできます。")
    return "\n".join(lines)


# ------------------------------------------------------------
# 署名付きトークン（fastHTML と同形式: v1.<payload>.<HMAC-SHA256>）
# ------------------------------------------------------------

def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _bgcut_signing_key() -> bytes | None:
    key = (os.getenv("BOT_API_KEY") or "").strip()
    return key.encode("utf-8") if key else None


def create_bgcut_token(*, user_id: int, purpose: str, guild_id: int,
                       channel_id: int, now: float | None = None,
                       job_id: str | None = None) -> tuple[str, int] | None:
    """発行情報を署名付きトークンに包み (token, expires_at) を返す。

    BOT_API_KEY 未設定なら None（発行基盤が未設定）。Web 側
    （web/lib/bgcut-token.ts）が同じ鍵・同じ形式で検証する。
    """
    key = _bgcut_signing_key()
    if key is None:
        return None
    issued = int(time.time() if now is None else now)
    expires_at = issued + BG_CUTOUT_TTL_SECONDS
    payload = json.dumps(
        {
            "u": int(user_id),
            "p": purpose,
            "g": int(guild_id),
            "c": int(channel_id),
            "j": job_id or secrets.token_urlsafe(12),
            "exp": expires_at,
        },
        separators=(",", ":"),
    )
    signing_input = (
        f"{BG_CUTOUT_TOKEN_VERSION}.{_b64url_encode(payload.encode('utf-8'))}"
    )
    signature = hmac.new(
        key, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url_encode(signature)}", expires_at


def verify_bgcut_token(token: str, *, now: float | None = None) -> dict | None:
    """トークンを検証し、ペイロード dict を返す。不正・期限切れは None。

    Web 側の検証と同じ規則（署名は定数時間比較、exp は unix 秒）。
    """
    key = _bgcut_signing_key()
    if key is None or not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != BG_CUTOUT_TOKEN_VERSION:
        return None
    expected = hmac.new(
        key, f"{parts[0]}.{parts[1]}".encode("ascii"), hashlib.sha256,
    ).digest()
    try:
        given = _b64url_decode(parts[2])
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
    except Exception:
        return None
    if len(given) != len(expected) or not hmac.compare_digest(given, expected):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        return None
    current = time.time() if now is None else now
    if exp <= current:
        return None
    return payload


def bgcut_public_url(token: str) -> str:
    return f"{BG_CUTOUT_PUBLIC_BASE}/bgcut/{token}"


# ------------------------------------------------------------
# 結果レコード（Web → bot_kv → Bot 投稿）の計画（純粋関数）
# ------------------------------------------------------------

_RESULT_INT_FIELDS = (
    "user_id", "channel_id", "width", "height",
    "out_bytes", "in_bytes", "in_width", "in_height",
)


def _result_record_ok(record) -> bool:
    if not isinstance(record, dict):
        return False
    if record.get("status") != "pending":
        return False
    if record.get("purpose") not in BG_CUTOUT_PURPOSES:
        return False
    if not isinstance(record.get("format"), str) or not record["format"]:
        return False
    if not isinstance(record.get("filename"), str) or not record["filename"]:
        return False
    if not isinstance(record.get("data_b64"), str) or not record["data_b64"]:
        return False
    created = record.get("created_at")
    if not isinstance(created, (int, float)) or isinstance(created, bool):
        return False
    for field in _RESULT_INT_FIELDS:
        value = record.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
    return True


def bgcut_result_post_plan(records: dict, *, now: float):
    """結果レコード群から (投稿すべき (key, record) の列, 破棄すべき key の列) を返す。

    投稿対象は status=pending で形式が正しいもの（created_at 昇順）。
    期限切れ・形式不正・pending でないものは破棄する（再投稿防止も兼ねる）。
    """
    posts: list[tuple[str, dict]] = []
    discards: list[str] = []
    for key in sorted(records):
        record = records[key]
        if not _result_record_ok(record):
            discards.append(key)
            continue
        if now - float(record["created_at"]) > BG_CUTOUT_RESULT_TTL_SECONDS:
            discards.append(key)
            continue
        posts.append((key, record))
    posts.sort(key=lambda item: float(item[1]["created_at"]))
    return posts, discards


# ------------------------------------------------------------
# Views
# ------------------------------------------------------------

class BgCutoutStartView(discord.ui.View):
    """用途（絵文字用／スタンプ用）を選ぶ開始パネル。本人のみ操作可。"""

    def __init__(self, cog: "BgCutoutMixin", user_id: int):
        super().__init__(timeout=180)
        self.cog = cog
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="絵文字用", style=discord.ButtonStyle.primary)
    async def emoji(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._bgcut_choose(interaction, "emoji", self)

    @discord.ui.button(label="スタンプ用", style=discord.ButtonStyle.primary)
    async def sticker(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._bgcut_choose(interaction, "sticker", self)

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.stop()
        await interaction.response.edit_message(
            content="背景透過をキャンセルしました。", view=None)


class BgCutoutLinkView(discord.ui.View):
    """処理ページへのリンクボタン（エフェメラルで発行者だけに渡す）。"""

    def __init__(self, url: str):
        super().__init__(timeout=None)
        self.add_item(discord.ui.Button(
            label="背景透過ページを開く",
            style=discord.ButtonStyle.link,
            url=url,
        ))


class BgCutoutMixin:
    """GeneralCog の一部。entry.py で合成される。"""

    async def _bgcut_start(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel is None:
            return await interaction.response.send_message(
                "チャンネルが特定できませんでした。", ephemeral=True
            )
        last = self._bgcut_last_issue.get(interaction.user.id, 0.0)
        remain = BG_CUTOUT_COOLDOWN_SECONDS - (time.monotonic() - last)
        if last and remain > 0:
            return await interaction.response.send_message(
                f"リンク発行が続いています。あと{int(remain) + 1}秒待ってから"
                "お試しください。",
                ephemeral=True,
            )
        await interaction.response.send_message(
            "画像やGIFの背景を透過して、Discordの絵文字／スタンプとして"
            "使えるサイズに変換します。\n"
            "処理はあなたのブラウザの中で行われます。まず用途を選んでください。"
            "選ぶと、あなただけに見える処理ページへのリンク"
            "（60分有効）を表示します。",
            view=BgCutoutStartView(self, interaction.user.id),
        )

    async def _bgcut_choose(self, interaction: discord.Interaction,
                            purpose: str, view: BgCutoutStartView):
        created = create_bgcut_token(
            user_id=interaction.user.id,
            purpose=purpose,
            guild_id=interaction.guild_id or 0,
            channel_id=interaction.channel.id if interaction.channel else 0,
        )
        view.stop()
        if created is None:
            logger.warning("背景透過: BOT_API_KEY 未設定のためリンクを発行できません")
            await interaction.response.edit_message(
                content="背景透過リンクを発行できませんでした。", view=None)
            await interaction.followup.send(
                "リンク発行の基盤（BOT_API_KEY）が未設定のため、"
                "この環境では利用できません。",
                ephemeral=True,
            )
            return
        token, _expires_at = created
        url = bgcut_public_url(token)
        self._bgcut_last_issue[interaction.user.id] = time.monotonic()
        await interaction.response.edit_message(
            content=(
                f"{interaction.user.display_name} さんが背景透過リンクを"
                f"発行しました（用途：{BG_CUTOUT_PURPOSES[purpose]}）。\n"
                "リンクは発行した本人にだけ表示しています（有効期限60分）。"
            ),
            view=None,
        )
        await interaction.followup.send(
            "背景透過の処理ページです（有効期限：60分）。\n"
            f"`{url}`\n"
            "開いて画像やGIFを入れると、ブラウザの中で背景透過と圧縮を"
            "行います。完了後、そのままダウンロードするか、"
            "このチャンネルへ投稿できます。",
            view=BgCutoutLinkView(url),
            ephemeral=True,
        )

    # ------------------------------------------------------------
    # 結果の受け取り（Web → bot_kv → このチャンネルへ公開投稿）
    # ------------------------------------------------------------

    @tasks.loop(seconds=BG_CUTOUT_POLL_SECONDS)
    async def _bgcut_result_poll(self):
        try:
            await self._bgcut_post_pending_results()
        except Exception:
            logger.exception("背景透過: 結果ポーリングに失敗しました")

    @_bgcut_result_poll.before_loop
    async def _bgcut_result_poll_before(self):
        await self.bot.wait_until_ready()

    async def _bgcut_result_channel(self, channel_id: int):
        channel = self.bot.get_channel(channel_id)
        if channel is not None:
            return channel
        try:
            return await self.bot.fetch_channel(channel_id)
        except Exception:
            logger.warning(
                "背景透過: 結果の投稿先チャンネル %s を取得できませんでした",
                channel_id)
            return None

    async def _bgcut_post_pending_results(self, *, now: float | None = None):
        kv = _get_results_kv()
        records = await kv.load_all()
        if not records:
            return
        posts, discards = bgcut_result_post_plan(
            records, now=time.time() if now is None else now)
        for key in discards:
            try:
                await kv.delete(key)
            except Exception:
                logger.debug("背景透過: 結果レコード %s の破棄に失敗", key,
                             exc_info=True)
        for key, record in posts:
            try:
                data = base64.b64decode(record["data_b64"], validate=True)
            except Exception:
                logger.warning("背景透過: 結果レコード %s の画像が壊れています", key)
                await kv.delete(key)
                continue
            channel = await self._bgcut_result_channel(int(record["channel_id"]))
            if channel is None:
                continue  # 次のポーリングで再試行（TTL で最終的に破棄）
            file = discord.File(io.BytesIO(data), filename=record["filename"])
            try:
                await channel.send(
                    content=(
                        f"<@{int(record['user_id'])}>\n"
                        + bgcut_result_text(record)
                    ),
                    file=file,
                )
            except Exception:
                logger.warning(
                    "背景透過: 結果の投稿に失敗しました（レコード %s）", key,
                    exc_info=True)
                continue
            await kv.delete(key)
