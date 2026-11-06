# -*- coding: utf-8 -*-
"""レベルアップカードの描画と通知。元 cogs/general.py から分割。"""
from __future__ import annotations

from ..common import *
from .exp import _REPO_ROOT

LEVELUP_SECTION = "levelup_notify"


def get_levelup_settings(store, guild_id: int) -> dict:
    """/support の「レベルアップ通知」の設定(support側のパネルからも使う)。

    未設定時は『オン・EXPが入った場所(発言したチャンネル/いたVC)へ通知』。
    """
    raw = store.get(guild_id, LEVELUP_SECTION)
    if not isinstance(raw, dict):
        raw = {}
    enabled = raw.get("enabled")
    channel_id = raw.get("channel_id")
    return {
        "enabled": enabled if isinstance(enabled, bool) else True,
        "channel_id": channel_id if isinstance(channel_id, int) and not isinstance(channel_id, bool) else None,
    }
LEVELUP_CARD_W, LEVELUP_CARD_H = 1000, 360
_LEVELUP_SS = 2  # 内部は2倍解像度で描いて縮小(ジャギー防止)

_LEVELUP_CJK_FONTS = (
    os.getenv("LEVELUP_FONT_PATH") or "",
    str(_REPO_ROOT / "assets" / "fonts" / "levelup.ttf"),
    str(_REPO_ROOT / "assets" / "fonts" / "levelup.otf"),
    str(_REPO_ROOT / "assets" / "fonts" / "levelup.ttc"),
    # リポジトリ同梱の日本語フォント。assets/fonts はリポジトリに存在しないため、
    # OSフォントが無くてもここで日本語が描ける (Hachi Maru Pop)。
    str(_REPO_ROOT / "font.ttf"),
    "C:/Windows/Fonts/meiryob.ttc",
    "C:/Windows/Fonts/YuGothB.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/takao-gothic/TakaoPGothic.ttf",
)
_LEVELUP_LATIN_FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)

# 参考画像(Bahnschrift / DIN 系コンデンス)を優先する
_LEVELUP_DISPLAY_FONTS = (
    os.getenv("LEVELUP_DISPLAY_FONT_PATH") or "",
    str(_REPO_ROOT / "assets" / "fonts" / "levelup-display.ttf"),
    str(_REPO_ROOT / "assets" / "fonts" / "levelup-display.otf"),
    # ★ 参考画像 (Bahnschrift / DIN 系コンデンス) を優先
    "/usr/share/fonts/truetype/bahnschrift/bahnschrift.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-Medium.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-SemiBold.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-SemiBold.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-Bold.ttf",
    "C:/Windows/Fonts/bahnschrift.ttf",
    "C:/Windows/Fonts/BAHNSCHRIFT.TTF",
    # Linux (fontconfig)
    "/usr/share/fonts/truetype/anton/Anton-Regular.ttf",
    "/usr/share/fonts/truetype/bebasneue/BebasNeue-Regular.ttf",
    "/usr/share/fonts/truetype/archivo-black/ArchivoBlack-Regular.ttf",
    "/usr/share/fonts/truetype/barlow-condensed/BarlowCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/oswald/Oswald-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-Black.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDisplay-CondensedBlack.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    # macOS
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    # Windows
    "C:/Windows/Fonts/impact.ttf",
    "C:/Windows/Fonts/ariblk.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)

_LEVELUP_FONT_PICK: tuple[str | None, bool] | None = None
_LEVELUP_DISPLAY_PICK: str | None | bool = False  # 未探索は False


def _levelup_pick_font() -> tuple[str | None, bool]:
    """本文用フォント(CJK 可なら True)を返す(初回のみ探索)。"""
    global _LEVELUP_FONT_PICK
    if _LEVELUP_FONT_PICK is not None:
        return _LEVELUP_FONT_PICK
    from PIL import ImageFont

    pick: tuple[str | None, bool] = (None, False)
    for cjk, paths in ((True, _LEVELUP_CJK_FONTS), (False, _LEVELUP_LATIN_FONTS)):
        for path in paths:
            if not path or not os.path.exists(path):
                continue
            try:
                ImageFont.truetype(path, 20)
            except Exception:
                logger.debug("レベルアップカード: フォント候補の読み込みに失敗しました", exc_info=True)
                continue
            pick = (path, cjk)
            break
        if pick[0]:
            break
    _LEVELUP_FONT_PICK = pick
    return pick


def _levelup_pick_display_font() -> str | None:
    """「LEVEL UP」などの見出しに使う極太ディスプレイフォントを返す。

    参考画像に寄せるため、まず専用の太字サンセリフ体(Bahnschrift / Oswald / Anton 等)を探し、
    無ければ本文フォントにフォールバックする。
    """
    global _LEVELUP_DISPLAY_PICK
    if _LEVELUP_DISPLAY_PICK is not False:
        return _LEVELUP_DISPLAY_PICK  # type: ignore[return-value]
    from PIL import ImageFont

    chosen: str | None = None
    for path in _LEVELUP_DISPLAY_FONTS:
        if not path or not os.path.exists(path):
            continue
        try:
            ImageFont.truetype(path, 20)
        except Exception:
            logger.debug("レベルアップカード: 表示フォント候補の読み込みに失敗しました", exc_info=True)
            continue
        chosen = path
        break
    if chosen is None:
        chosen = _levelup_pick_font()[0]
    _LEVELUP_DISPLAY_PICK = chosen
    return chosen


def _levelup_font(size: int):
    from PIL import ImageFont

    path, _ = _levelup_pick_font()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            logger.debug("レベルアップカード: フォントの読み込みに失敗しました", exc_info=True)
    try:
        return ImageFont.load_default(size=size)  # Pillow>=10.1
    except TypeError:
        return ImageFont.load_default()


def _levelup_display_font(size: int):
    from PIL import ImageFont

    path = _levelup_pick_display_font()
    if path:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            logger.debug("レベルアップカード: 表示フォントの読み込みに失敗しました", exc_info=True)
    return _levelup_font(size)


def _levelup_draw_tracked(d, xy, text, font, fill, tracking: float, anchor: str = "ls"):
    """字間(tracking px)を加えてテキストを描く。戻り値は (描画幅, 描画高さ)。"""
    x, y = xy
    total_w = 0.0
    for ch in text:
        total_w += d.textlength(ch, font=font)
    total_w += tracking * max(0, len(text) - 1)

    # アンカー調整: ls(左ベースライン) のみサポート
    if anchor.startswith("m"):
        x -= total_w / 2
    elif anchor.startswith("r"):
        x -= total_w

    for ch in text:
        d.text((x, y), ch, font=font, fill=fill, anchor=anchor)
        x += d.textlength(ch, font=font) + tracking

    bbox = font.getbbox(text)
    return total_w, bbox[3] - bbox[1]


def _levelup_safe_name(name: str, can_cjk: bool) -> str:
    """画像に描けない文字(絵文字など)を落とす。日本語フォントが無ければASCIIのみ。"""
    out = []
    for ch in str(name or ""):
        o = ord(ch)
        if o >= 0x1F000 or 0x2190 <= o <= 0x2BFF or o in (0x200D, 0xFE0F, 0xFE0E) or o < 0x20:
            continue
        if not can_cjk and o > 0x7E:
            continue
        out.append(ch)
    return "".join(out).strip()


def render_levelup_card(
    avatar_bytes: bytes | None,
    name: str,
    before: int,
    after: int,
    seed: int = 0,
    *,
    bot_avatar_bytes: bytes | None = None,
    theme: str = "default",
) -> bytes:
    """レベルアップ画像(PNG)を生成して bytes で返す。CPU処理なので to_thread で呼ぶこと。

    白基調・装飾最小。Bahnschrift/DIN 系コンデンスフォントにトラッキングを加えた見出し。
    矢印は軸+三角形の2段構成、レベル数字は視覚的中心でベースラインを揃える。
    theme は core.general.levelup_card のテーマ名 (ユーザーごとのカードカスタマイズ)。
    """
    from PIL import Image, ImageDraw

    S = _LEVELUP_SS
    W, H = LEVELUP_CARD_W * S, LEVELUP_CARD_H * S
    _, can_cjk = _levelup_pick_font()

    def px(v: float) -> int:
        return int(round(v * S))

    pal = levelup_card.palette(theme)
    BG = (*pal["bg"], 255)
    INK = (*pal["ink"], 255)
    MUTE = (*pal["mute"], 255)
    LINE = (*pal["line"], 255)
    ACCENT = (*pal["accent"], 255)
    RING = (*pal["ring"], 255)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle(
        [0, 0, W - 1, H - 1], radius=px(28),
        fill=BG, outline=LINE, width=px(2),
    )

    # ============================================================
    # 左: ユーザーアイコン
    # ============================================================
    D = px(196)
    ax, ay = px(56), (H - D) // 2
    ring_w = px(4)
    R = D // 2 + px(8) + ring_w
    acx, acy = ax + D // 2, ay + D // 2
    d.ellipse([acx - R, acy - R, acx + R, acy + R], outline=RING, width=ring_w)

    avatar = None
    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((D, D), Image.LANCZOS)
        except Exception:
            logger.debug("レベルアップカード: アバターの取得に失敗しました", exc_info=True)
            avatar = None
    if avatar is None:
        avatar = Image.new("RGBA", (D, D), (235, 238, 245, 255))
        ad = ImageDraw.Draw(avatar)
        ad.ellipse([D * 0.34, D * 0.20, D * 0.66, D * 0.52], fill=(255, 255, 255, 255))
        ad.ellipse([D * 0.18, D * 0.58, D * 0.82, D * 1.15], fill=(255, 255, 255, 255))
    amask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(amask).ellipse([0, 0, D - 1, D - 1], fill=255)
    img.paste(avatar, (ax, ay), amask)

    # ============================================================
    # 右上: BOT バッジ
    # ============================================================
    BOT_D = px(56)
    BOT_MARGIN = px(28)
    bx = W - BOT_MARGIN - BOT_D
    by = BOT_MARGIN

    if bot_avatar_bytes:
        try:
            bot_avatar = (
                Image.open(io.BytesIO(bot_avatar_bytes))
                .convert("RGBA")
                .resize((BOT_D, BOT_D), Image.LANCZOS)
            )
        except Exception:
            logger.debug("レベルアップカード: Botアバターの取得に失敗しました", exc_info=True)
            bot_avatar = None
        if bot_avatar is not None:
            bring_w = px(2)
            bR = BOT_D // 2 + px(4) + bring_w
            bcx, bcy = bx + BOT_D // 2, by + BOT_D // 2
            d.ellipse([bcx - bR, bcy - bR, bcx + bR, bcy + bR], outline=LINE, width=bring_w)
            bmask = Image.new("L", (BOT_D, BOT_D), 0)
            ImageDraw.Draw(bmask).ellipse([0, 0, BOT_D - 1, BOT_D - 1], fill=255)
            img.paste(bot_avatar, (bx, by), bmask)

    # ============================================================
    # 中央: 見出し + レベル
    # ============================================================
    TX = ax + D + px(52)
    right = W - px(56)
    center_y = H // 2

    # --- 見出し「LEVEL UP」(トラッキング付き) ---
    up_text = "LEVEL UP"
    up_size = px(64)
    up_font = _levelup_display_font(up_size)

    # 収まるまで縮める(収まるときは縮めない)
    max_up_w = (right - TX) * 0.58
    while up_size > px(30) and d.textlength(up_text, font=up_font) > max_up_w:
        up_size -= px(2)
        up_font = _levelup_display_font(up_size)

    up_tracking = px(3)  # 参考画像の広めの字間
    up_w, up_bbox_h = _levelup_draw_tracked(
        d, (TX, 0), up_text, up_font, INK, up_tracking, anchor="ls"
    )

    # --- レベル変化「9 → 10」 ---
    prev_text, new_text = str(before), str(after)
    pfont = _levelup_display_font(px(42))
    nfont = _levelup_display_font(px(72))

    p_w = d.textlength(prev_text, font=pfont)
    n_w = d.textlength(new_text, font=nfont)

    # 矢印の寸法
    arrow_w = px(56)
    arrow_h = px(26)
    shaft_h = max(px(4), int(arrow_h * 0.18))

    # 全体幅 = 前 + gap + 矢印 + gap + 後
    gap_before = px(20)
    gap_after = px(16)
    group_w = p_w + gap_before + arrow_w + gap_after + n_w

    # 見出し + 余白 + レベル群 が右端に収まるよう配置
    group_x = TX + up_w + px(56)
    if group_x + group_w > right:
        group_x = max(TX + up_w + px(24), right - group_w)

    # --- ベースラインの計算 ---
    # 見出しの視覚的な中心を、カードの中央よりやや上に置く
    heading_cy = center_y - px(22)

    # 「LEVEL UP」のベースライン: bbox のアセント分を補正
    up_bbox = up_font.getbbox(up_text)
    up_top = heading_cy - (up_bbox[3] - up_bbox[1]) / 2 - up_bbox[1]
    _levelup_draw_tracked(
        d, (TX, up_top), up_text, up_font, INK, up_tracking, anchor="ls"
    )

    # --- レベル変化のベースライン ---
    # 見出しと同じ視覚的中心 heading_cy に揃える
    p_bbox = pfont.getbbox(prev_text)
    n_bbox = nfont.getbbox(new_text)

    p_top = heading_cy - (p_bbox[3] - p_bbox[1]) / 2 - p_bbox[1]
    n_top = heading_cy - (n_bbox[3] - n_bbox[1]) / 2 - n_bbox[1]

    d.text((group_x, p_top), prev_text, font=pfont, fill=MUTE, anchor="ls")

    # --- 矢印(軸 + 三角形) ---
    arrow_x0 = group_x + p_w + gap_before
    arrow_cy = heading_cy

    # 軸
    d.rectangle(
        [
            arrow_x0,
            arrow_cy - shaft_h // 2,
            arrow_x0 + arrow_w - px(16),
            arrow_cy + shaft_h // 2,
        ],
        fill=ACCENT,
    )
    # 矢じり(3点の三角形)
    tip_x = arrow_x0 + arrow_w
    d.polygon(
        [
            (tip_x, arrow_cy),                                    # 頂点
            (arrow_x0 + arrow_w - px(20), arrow_cy - arrow_h // 2),  # 上
            (arrow_x0 + arrow_w - px(20), arrow_cy + arrow_h // 2),  # 下
        ],
        fill=ACCENT,
    )

    d.text((arrow_x0 + arrow_w + gap_after, n_top), new_text, font=nfont, fill=ACCENT, anchor="ls")

    # ============================================================
    # 下部: 区切り線 + ユーザー名
    # ============================================================
    line_y = H - px(58)
    d.line([px(56), line_y, W - px(56), line_y], fill=LINE, width=px(2))

    shown = _levelup_safe_name(name, can_cjk)
    if shown:
        nfont_small = _levelup_font(px(20))
        maxw = W - px(112)
        text = shown
        while len(text) > 1 and d.textlength(text, font=nfont_small) > maxw:
            text = text[:-1]
        if text != shown:
            text = text.rstrip() + ("…" if can_cjk else "...")
        d.text((px(56), H - px(32)), text, font=nfont_small, fill=MUTE, anchor="ls")

    out = img.resize((LEVELUP_CARD_W, LEVELUP_CARD_H), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ============================================================
# MIQ (Make it a Quote) 引用画像
# ============================================================


class LevelUpMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    async def _levelup_user(self, guild: discord.Guild, user_id: int):
        member = guild.get_member(user_id)
        if member is not None:
            return member
        try:
            return await guild.fetch_member(user_id)
        except discord.HTTPException:
            logger.debug("レベルアップ通知: メンバーの取得に失敗しました", exc_info=True)
        try:
            return await self.bot.fetch_user(user_id)
        except discord.HTTPException:
            logger.debug("レベルアップ通知: ユーザーの取得に失敗しました", exc_info=True)
            return None


    @staticmethod
    def _levelup_can_post(channel, me) -> tuple[bool, bool]:
        """(投稿できるか, 画像を添付できるか)"""
        perms = channel.permissions_for(me)
        if not perms.view_channel:
            return False, False
        can_send = perms.send_messages_in_threads if isinstance(channel, discord.Thread) else perms.send_messages
        return bool(can_send), bool(perms.attach_files)


    async def _fetch_bot_avatar(self) -> bytes | None:
        """レベルアップ画像用の BOT アイコンを取得する(失敗時 None)。"""
        try:
            bot_user = self.bot.user
            if bot_user is None:
                return None
            return await bot_user.display_avatar.replace(size=128, format="png").read()
        except Exception:
            logger.debug("BOTアイコンの取得に失敗しました", exc_info=True)
            return None


    async def render_levelup_image(
        self, user, before: int, after: int, *, bot_avatar_bytes: bytes | None = None
    ) -> bytes | None:
        """レベルアップ画像(PNGのbytes)を作る。Pillowが無い等で作れなければ None。/support のプレビューからも使う。"""
        avatar_bytes = None
        try:
            avatar_bytes = await user.display_avatar.replace(size=256, format="png").read()
        except Exception:
            logger.debug("レベルアップ画像: アイコンの取得に失敗 (user=%s)", getattr(user, "id", "?"), exc_info=True)
        name = getattr(user, "display_name", None) or getattr(user, "name", "") or ""
        if bot_avatar_bytes is None:
            bot_avatar_bytes = await self._fetch_bot_avatar()
        try:
            async with self._levelup_sem:
                return await asyncio.to_thread(
                    render_levelup_card,
                    avatar_bytes, name, before, after, getattr(user, "id", 0),
                    bot_avatar_bytes=bot_avatar_bytes,
                    theme=levelup_card.get_theme(getattr(user, "id", 0)),
                )
        except ImportError:
            if not self._levelup_pillow_warned:
                self._levelup_pillow_warned = True
                logger.warning("レベルアップ画像: Pillow が未インストールです (pip install pillow)。テキスト通知のみ送ります")
            return None
        except Exception:
            logger.exception("レベルアップ画像の生成に失敗しました")
            return None


    async def _notify_levelup(self, guild: discord.Guild, user, before: int, after: int, *, fallback_channel=None):
        """generalレベルが上がった時の通知。user はユーザーオブジェクトかユーザーID。"""
        try:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            cfg = get_levelup_settings(store, guild.id)
            if not cfg["enabled"]:
                return
            me = guild.me
            if me is None:
                return

            # 通知先: /support で指定したチャンネル → 無い/投稿不可なら、EXPが入った場所(発言したチャンネル/いたVC)
            configured = guild.get_channel_or_thread(cfg["channel_id"]) if cfg["channel_id"] else None
            target, can_attach = None, False
            for channel in (configured, fallback_channel):
                if channel is None:
                    continue
                ok, attach = self._levelup_can_post(channel, me)
                if ok:
                    target, can_attach = channel, attach
                    break
            if target is None:
                logger.info("レベルアップ通知: 投稿できるチャンネルがありません (guild=%s)", guild.id)
                return

            if isinstance(user, int):
                user = await self._levelup_user(guild, user)
            if user is None:
                return

            kwargs = {
                "content": f"🎉 {user.mention} がレベルアップしました！ **Lv.{before} → Lv.{after}**",
                "allowed_mentions": discord.AllowedMentions.none(),  # 表示はメンション、通知(ピング)は飛ばさない
            }
            if can_attach:
                bot_avatar_bytes = await self._fetch_bot_avatar()
                png = await self.render_levelup_image(
                    user, before, after, bot_avatar_bytes=bot_avatar_bytes
                )
                if png:
                    kwargs["file"] = discord.File(io.BytesIO(png), filename="levelup.png")
            await target.send(**kwargs)
        except discord.HTTPException:
            logger.warning("レベルアップ通知の送信に失敗しました (guild=%s)", guild.id, exc_info=True)
        except Exception:
            logger.exception("レベルアップ通知で予期しないエラーが発生しました")


    async def _notify_level_rewards(self, guild, member, old_level: int, new_level: int):
        if new_level <= old_level or self.bot is None:
            return
        cog = self.bot.get_cog("ServerAssistCog")
        handler = getattr(cog, "handle_level_rewards", None)
        if handler is None:
            return
        try:
            await handler(guild, member, old_level, new_level)
        except Exception:
            logger.exception("レベル報酬の連携に失敗しました")
