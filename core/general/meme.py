# -*- coding: utf-8 -*-
"""meme 作成（画像＋上下テキスト）。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .miq import (
    _MIQ_ASSET_FONTS, _miq_available_fonts, _miq_clean_text, _miq_load_font,
    _miq_save_png, _miq_wrap, miq_get_prefs, miq_is_refusing,
)

MEME_MAX_EDGE = 1200          # 生成画像の最大の一辺 (px)
MEME_MAX_TEXT = 100           # 上/下テキストそれぞれの最大文字数
MEME_MAX_IMAGE_BYTES = 8 * 1024 * 1024  # ベース画像の取得上限
MEME_WAIT_TIMEOUT = 120.0     # パネル経由フローで画像投稿を待つ秒数
MEME_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")

def _meme_font_path() -> str | None:
    """meme 用に太めのフォントを優先して選ぶ (DelaGothicOne → M PLUS 系 → 既定)。"""
    fonts = _miq_available_fonts()
    bold_file = _MIQ_ASSET_FONTS / "MPLUSRounded1c-Bold.ttf"
    if bold_file.exists():
        return str(bold_file)
    for needle in ("delagothic", "mplus", "rocknroll", "reggae"):
        for _key, _label, path in fonts:
            if path and needle in Path(path).name.lower().replace("_", ""):
                return path
    return fonts[0][2] if fonts else None


def _meme_fit(draw, text: str, font_path: str | None, max_w: int, max_h: int, *, max_size: int, min_size: int = 12):
    """meme の1ブロック (上 or 下) を領域に収めるフォントと折り返しを返す。"""
    size = max_size
    while True:
        font = _miq_load_font(font_path, size)
        lines = _miq_wrap(draw, text, font, max_w)
        lh = int(size * 1.3)
        if len(lines) * lh <= max_h or size <= min_size:
            break
        size -= 2
    max_lines = max(1, max_h // lh)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > max_w:
            last = last[:-1]
        lines[-1] = last + "…"
    return font, lines, lh, size


def render_meme_png(image_bytes: bytes | None, top_text: str, bottom_text: str, *, font_path: str | None = None) -> bytes:
    """ベース画像に上下テキスト (白文字+黒の太縁取り) を描いた meme 画像 (PNG) を返す。

    GIF アニメは1フレーム目を使う。上下ともテキストが空なら ValueError。
    画像として開けない場合も ValueError (呼び出し側でユーザー向け文面にする)。
    """
    from PIL import Image, ImageDraw

    top = _miq_clean_text(top_text)[:MEME_MAX_TEXT].strip()
    bottom = _miq_clean_text(bottom_text)[:MEME_MAX_TEXT].strip()
    if not top and not bottom:
        raise ValueError("上テキストと下テキストのどちらかは必要です")
    if not image_bytes:
        raise ValueError("ベース画像がありません")
    try:
        src = Image.open(io.BytesIO(image_bytes))
        src.seek(0)  # GIF 等は1フレーム目
        img = src.convert("RGB")
    except Exception as exc:
        raise ValueError("画像として読み込めませんでした") from exc
    if img.width * img.height > 60_000_000:
        raise ValueError("画像のピクセル数が大きすぎます")

    # サイズ調整: 最大 MEME_MAX_EDGE に収め、小さい画像は最大2倍まで拡大
    scale = min(MEME_MAX_EDGE / img.width, MEME_MAX_EDGE / img.height)
    if scale < 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    elif scale > 2.0:
        img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
    W, H = img.size

    d = ImageDraw.Draw(img)
    margin_x = max(10, int(W * 0.04))
    margin_y = max(8, int(H * 0.03))
    max_w = W - margin_x * 2
    band_h = int(H * 0.30)
    max_size = max(16, W // 9)

    def draw_block(text: str, *, at_top: bool) -> None:
        font, lines, lh, size = _meme_fit(d, text, font_path, max_w, band_h, max_size=max_size)
        block_h = len(lines) * lh
        y = margin_y if at_top else H - margin_y - block_h
        sw = max(2, size // 9)
        for line in lines:
            if line:
                d.text((W // 2, y), line, font=font, fill=(255, 255, 255),
                       anchor="ma", stroke_width=sw, stroke_fill=(0, 0, 0))
            y += lh

    if top:
        draw_block(top, at_top=True)
    if bottom:
        draw_block(bottom, at_top=False)
    return _miq_save_png(img)


def _meme_image_attachment(message) -> object | None:
    """メッセージの添付から画像らしいものを1つ返す (無ければ None)。"""
    for att in getattr(message, "attachments", None) or []:
        content_type = (getattr(att, "content_type", None) or "").lower()
        if content_type.startswith("image/"):
            return att
        filename = (getattr(att, "filename", "") or "").lower()
        if filename.endswith(MEME_IMAGE_EXTS):
            return att
    return None


# ------------------------------------------------------------
# MIQ ユーザー設定(見た目・引用拒否)の保存
# ------------------------------------------------------------
# ユーザーごと(サーバー共通)の設定を data/miq.json に保存する。
# EXP と同様に、一時ファイル→置換のアトミック書き込み。保存先は環境変数 MIQ_DATA_PATH で変更可能。


class MemeTextModal(discord.ui.Modal, title="memeを作成"):
    """上/下テキストを聞くモーダル。送信後の処理は handler に委ねる。

    handler は async callable(interaction, top_text, bottom_text)。
    入口が /general パネル (画像は後から投稿してもらう) と右クリック
    メニュー (画像は対象メッセージから確定済み) で異なるため分離している。
    """

    top_text = discord.ui.TextInput(
        label="上テキスト", required=False, max_length=MEME_MAX_TEXT,
        placeholder="例: テスト前日なのに",
    )
    bottom_text = discord.ui.TextInput(
        label="下テキスト", required=False, max_length=MEME_MAX_TEXT,
        placeholder="例: 全然勉強してない",
    )

    def __init__(self, handler):
        super().__init__()
        self.handler = handler

    async def on_submit(self, interaction: discord.Interaction):
        top = (self.top_text.value or "").strip()
        bottom = (self.bottom_text.value or "").strip()
        if not top and not bottom:
            return await interaction.response.send_message(
                "上テキストと下テキストのどちらかは入力してください。", ephemeral=True
            )
        await self.handler(interaction, top, bottom)


class MemeCancelView(discord.ui.View):
    """パネル経由の meme 作成で、画像待ちをキャンセルするためのボタン。"""

    def __init__(self, cog: "GeneralCog", key: tuple[int, int], user_id: int):
        super().__init__(timeout=MEME_WAIT_TIMEOUT + 30)
        self.cog, self.key, self.user_id = cog, key, user_id

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "meme作成を開始したユーザーだけキャンセルできます。", ephemeral=True
            )
        event = self.cog._meme_waits.get(self.key)
        if event is not None:
            event.set()
        await interaction.response.edit_message(content="meme作成をキャンセルしました。", view=None)


class MemeMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    def _meme_font_for(self, user_id: int) -> str | None:
        """ユーザーの MIQ フォント設定があればそれを、無ければ meme 用の太めフォントを返す。"""
        prefs = miq_get_prefs(user_id)
        if prefs.get("font"):
            path = next(
                (p for k, _label, p in _miq_available_fonts() if k == prefs["font"]), None,
            )
            if path:
                return path
        return _meme_font_path()


    @staticmethod
    def _meme_size_limit(guild) -> int:
        limit = getattr(guild, "filesize_limit", None) or MEME_MAX_IMAGE_BYTES
        return min(int(limit), MEME_MAX_IMAGE_BYTES)


    async def _meme_build_file(
        self, image_bytes: bytes | None, top: str, bottom: str, user_id: int,
    ) -> tuple[discord.File | None, str | None]:
        """meme 画像を作る。戻り値 (file, error)。error はユーザーに見せてよい文面。"""
        try:
            async with self._levelup_sem:
                data = await asyncio.to_thread(
                    render_meme_png, image_bytes, top, bottom,
                    font_path=self._meme_font_for(user_id),
                )
            return discord.File(io.BytesIO(data), filename="meme.png"), None
        except ImportError:
            self._miq_pillow_missing()
            return None, "画像生成ライブラリが利用できません。"
        except ValueError as exc:
            return None, str(exc)
        except Exception:
            logger.exception("meme: 画像の生成に失敗しました")
            return None, "meme画像を作れませんでした。"


    async def _meme_panel_texts_done(self, interaction: discord.Interaction, top: str, bottom: str):
        """パネル経由: テキスト確定後、同じチャンネルで画像の投稿を待つ。"""
        channel = interaction.channel
        if channel is None:
            return await interaction.response.send_message(
                "チャンネルが特定できませんでした。", ephemeral=True
            )
        key = (channel.id, interaction.user.id)
        if key in self._meme_waits:
            return await interaction.response.send_message(
                "このチャンネルでは既にmeme作成の画像待ち中です。"
                "画像を投稿するか、先にキャンセルしてください。",
                ephemeral=True,
            )
        event = asyncio.Event()
        self._meme_waits[key] = event
        await interaction.response.send_message(
            "このチャンネルに、ベースにしたい画像を投稿してください（120秒以内）。",
            view=MemeCancelView(self, key, interaction.user.id),
        )
        self._spawn(self._meme_wait_for_image(interaction, key, event, top, bottom))


    async def _meme_wait_for_image(self, interaction, key, event, top: str, bottom: str):
        channel_id, user_id = key

        def check(m) -> bool:
            return (
                getattr(m.author, "id", None) == user_id
                and getattr(m.channel, "id", None) == channel_id
                and _meme_image_attachment(m) is not None
            )

        msg_task = asyncio.ensure_future(self.bot.wait_for("message", check=check))
        cancel_task = asyncio.ensure_future(event.wait())
        try:
            done, _pending = await asyncio.wait(
                {msg_task, cancel_task}, timeout=MEME_WAIT_TIMEOUT,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task in done:
                return  # キャンセルボタン側で案内済み
            if msg_task not in done:
                try:
                    await interaction.edit_original_response(
                        content="時間切れのためmeme作成を終了しました。", view=None,
                    )
                except discord.HTTPException:
                    logger.debug("meme: 応答メッセージの編集に失敗しました", exc_info=True)
                return
            msg = msg_task.result()
            att = _meme_image_attachment(msg)
            if att is None:
                return
            limit = self._meme_size_limit(getattr(msg, "guild", None))
            if getattr(att, "size", 0) and att.size > limit:
                await msg.reply(
                    f"画像が大きすぎます（上限 {limit // (1024 * 1024)}MB）。"
                    "meme作成を終了しました。",
                    mention_author=False,
                )
                return
            try:
                image_bytes = await att.read()
            except Exception:
                logger.debug("meme: 添付画像の取得に失敗しました", exc_info=True)
                await msg.reply("画像を取得できませんでした。", mention_author=False)
                return
            file, error = await self._meme_build_file(image_bytes, top, bottom, user_id)
            if file is None:
                await msg.reply(error or "meme画像を作れませんでした。", mention_author=False)
                return
            await msg.reply(file=file, mention_author=False)
            try:
                await interaction.edit_original_response(content="memeを作成しました。", view=None)
            except discord.HTTPException:
                logger.debug("meme: 応答メッセージの編集に失敗しました", exc_info=True)
        except Exception:
            logger.exception("meme: 画像待ち処理に失敗しました")
        finally:
            for task in (msg_task, cancel_task):
                task.cancel()
            self._meme_waits.pop(key, None)


    async def _meme_fetch_url_image(self, url: str, limit: int) -> bytes | None:
        """embed 画像などを URL から取得する (上限を超えたら None)。"""
        import aiohttp

        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return None
                    if resp.content_length is not None and resp.content_length > limit:
                        return None
                    data = await resp.content.read(limit + 1)
                    return data if len(data) <= limit else None
        except Exception:
            logger.debug("meme: URLからの画像取得に失敗しました", exc_info=True)
            return None


    async def meme_context(self, interaction: discord.Interaction, message: discord.Message):
        """メッセージの右クリックメニュー「meme画像にする」。

        ベース画像は 添付画像 → embed 画像 → 投稿者のアバター の順で決める。
        アバターを使う場合のみ MIQ の引用拒否を適用する (添付/embed は
        メッセージ自体に公開されている画像のため対象外)。
        """
        limit = self._meme_size_limit(getattr(interaction, "guild", None))
        image_bytes: bytes | None = None

        att = _meme_image_attachment(message)
        if att is not None:
            if getattr(att, "size", 0) and att.size > limit:
                return await interaction.response.send_message(
                    f"画像が大きすぎます（上限 {limit // (1024 * 1024)}MB）。", ephemeral=True
                )
            try:
                image_bytes = await att.read()
            except Exception:
                logger.debug("meme: 添付画像の取得に失敗しました", exc_info=True)
                return await interaction.response.send_message(
                    "画像を取得できませんでした。", ephemeral=True
                )

        if image_bytes is None:
            for embed in getattr(message, "embeds", None) or []:
                image = getattr(embed, "image", None)
                url = getattr(image, "url", None) if image is not None else None
                if url:
                    image_bytes = await self._meme_fetch_url_image(url, limit)
                    if image_bytes:
                        break

        if image_bytes is None:
            author_id = getattr(message.author, "id", None)
            if author_id != interaction.user.id and miq_is_refusing(author_id):
                return await interaction.response.send_message(
                    "このユーザーは引用画像(MIQ)を拒否しています。", ephemeral=True
                )
            image_bytes = await self._miq_fetch_avatar_bytes(message.author, size=512)
            if image_bytes is None:
                return await interaction.response.send_message(
                    "ベースにできる画像を取得できませんでした。", ephemeral=True
                )

        if not self._miq_cooldown_ok(interaction.user.id):
            return await interaction.response.send_message(
                "少し待ってからもう一度お試しください。", ephemeral=True
            )

        async def handler(modal_interaction: discord.Interaction, top: str, bottom: str):
            await modal_interaction.response.defer(thinking=True)
            file, error = await self._meme_build_file(
                image_bytes, top, bottom, modal_interaction.user.id,
            )
            if file is None:
                return await modal_interaction.followup.send(
                    error or "meme画像を作れませんでした。"
                )
            await modal_interaction.followup.send(file=file)

        return await interaction.response.send_modal(MemeTextModal(handler))
