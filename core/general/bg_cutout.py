# -*- coding: utf-8 -*-
"""背景透過・絵文字/スタンプ化（make_image ジャンルのアクション）。

ユーザーが投稿した画像/GIF の背景を透過し、Discord のカスタム絵文字
（≤256KB）/ スタンプ（≤512KB・320×320）としてアップロードできる形に
変換して返す。処理の実体は core/general/bgcut/engine.py で、bot 本体の
メモリを圧迫しないようサブプロセスで実行する（同時実行は1つまで）。

フローは meme / fastHTML と同型：パネルで用途を選ぶ → 同じチャンネルで
画像の投稿を待つ → 結果をそのチャンネルへ公開投稿する。
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from .common import *
from core.general.attachment_wait import (
    AttachmentWaitCancelView,
    edit_original_response_quietly,
    wait_for_attachment,
)

BG_CUTOUT_WAIT_TIMEOUT = 120.0     # 用途選択＋画像投稿を待つ秒数
BG_CUTOUT_PROCESS_TIMEOUT = 360.0  # サブプロセス処理の上限（アニメGIF想定）
BG_CUTOUT_MAX_INPUT_BYTES = 25 * 1024 * 1024  # engine 側の上限と揃える
BG_CUTOUT_COOLDOWN_SECONDS = 20.0  # 処理開始ごとのユーザー単位クールダウン
BG_CUTOUT_MAX_JOBS = 2             # 実行中＋待機中のジョブ上限
BG_CUTOUT_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".apng")
BG_CUTOUT_PURPOSES = {
    "emoji": "絵文字用（256KB以下・最大128×128）",
    "sticker": "スタンプ用（512KB以下・320×320）",
}

_ENGINE_PATH = Path(__file__).resolve().parent / "bgcut" / "engine.py"
_REPO_ROOT = Path(__file__).resolve().parents[2]


class BgCutoutFailed(Exception):
    """エンジン実行の失敗。str(exc) はユーザーに見せてよい文面。"""

    def __init__(self, message: str, *, unavailable: bool = False):
        super().__init__(message)
        self.unavailable = unavailable


def _bgcut_image_attachment(message) -> object | None:
    """メッセージの添付から画像らしいものを1つ返す (無ければ None)。"""
    for att in getattr(message, "attachments", None) or []:
        content_type = (getattr(att, "content_type", None) or "").lower()
        if content_type.startswith("image/"):
            return att
        filename = (getattr(att, "filename", "") or "").lower()
        if filename.endswith(BG_CUTOUT_IMAGE_EXTS):
            return att
    return None


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


class BgCutoutStartView(discord.ui.View):
    """用途（絵文字用／スタンプ用）を選ぶ開始パネル。本人のみ操作可。"""

    def __init__(self, cog: "BgCutoutMixin", key, user_id: int):
        super().__init__(timeout=BG_CUTOUT_WAIT_TIMEOUT + 30)
        self.cog = cog
        self.key = key
        self.user_id = user_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @discord.ui.button(label="絵文字用", style=discord.ButtonStyle.primary)
    async def emoji(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._bgcut_choose(interaction, self.key, "emoji", self)

    @discord.ui.button(label="スタンプ用", style=discord.ButtonStyle.primary)
    async def sticker(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog._bgcut_choose(interaction, self.key, "sticker", self)

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        event = self.cog._bgcut_waits.get(self.key)
        if event is not None:
            event.set()
        self.stop()
        await interaction.response.edit_message(
            content="背景透過をキャンセルしました。", view=None)


class BgCutoutCancelView(AttachmentWaitCancelView):
    """用途選択後の画像待ちをキャンセルするボタン。"""

    def __init__(self, cog: "BgCutoutMixin", key, user_id: int):
        super().__init__(
            cog, "_bgcut_waits", key, user_id,
            timeout=BG_CUTOUT_WAIT_TIMEOUT + 30,
            cancel_text="背景透過をキャンセルしました。",
        )


class BgCutoutMixin:
    """GeneralCog の一部。entry.py で合成される。"""

    async def _bgcut_start(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel is None:
            return await interaction.response.send_message(
                "チャンネルが特定できませんでした。", ephemeral=True
            )
        key = (channel.id, interaction.user.id)
        if key in self._bgcut_waits:
            return await interaction.response.send_message(
                "このチャンネルでは既に背景透過の待ち受け中です。"
                "用途を選んで画像を投稿するか、先にキャンセルしてください。",
                ephemeral=True,
            )
        last = self._bgcut_last.get(interaction.user.id, 0.0)
        remain = BG_CUTOUT_COOLDOWN_SECONDS - (time.monotonic() - last)
        if last and remain > 0:
            return await interaction.response.send_message(
                f"処理が続いています。あと{int(remain) + 1}秒待ってからお試しください。",
                ephemeral=True,
            )
        event = asyncio.Event()
        self._bgcut_waits[key] = event
        await interaction.response.send_message(
            "画像やGIFの背景を透過して、Discordの絵文字／スタンプとして"
            "使えるサイズに変換します。\n"
            "まず用途を選んでください。選んだあと、このチャンネルに変換したい"
            f"画像やGIFを投稿してください（{int(BG_CUTOUT_WAIT_TIMEOUT)}秒以内、"
            f"{BG_CUTOUT_MAX_INPUT_BYTES // (1024 * 1024)}MBまで）。",
            view=BgCutoutStartView(self, key, interaction.user.id),
        )
        self._spawn(self._bgcut_wait_for_image(interaction, key, event))

    async def _bgcut_choose(self, interaction: discord.Interaction, key,
                            purpose: str, view: BgCutoutStartView):
        if key not in self._bgcut_waits:
            return await interaction.response.send_message(
                "この待ち受けは既に終了しています。", ephemeral=True
            )
        self._bgcut_purposes[key] = purpose
        view.stop()
        await interaction.response.edit_message(
            content=(
                f"用途：{BG_CUTOUT_PURPOSES[purpose]}\n"
                "このチャンネルに、変換したい画像やGIFを投稿してください"
                f"（{int(BG_CUTOUT_WAIT_TIMEOUT)}秒以内）。"
            ),
            view=BgCutoutCancelView(self, key, interaction.user.id),
        )

    async def _bgcut_wait_for_image(self, interaction, key, event):
        channel_id, user_id = key

        def check(m) -> bool:
            return (
                getattr(m.author, "id", None) == user_id
                and getattr(m.channel, "id", None) == channel_id
                and key in self._bgcut_purposes
                and _bgcut_image_attachment(m) is not None
            )

        try:
            kind, msg = await wait_for_attachment(
                self.bot, check=check, event=event,
                timeout=BG_CUTOUT_WAIT_TIMEOUT)
            if kind == "cancel":
                return  # キャンセルボタン側で案内済み
            if kind == "timeout":
                await edit_original_response_quietly(
                    interaction, "背景透過",
                    content="時間切れのため背景透過を終了しました。", view=None)
                return
            att = _bgcut_image_attachment(msg)
            if att is None:
                return
            if getattr(att, "size", 0) and att.size > BG_CUTOUT_MAX_INPUT_BYTES:
                await msg.reply(
                    f"ファイルが大きすぎます（上限 "
                    f"{BG_CUTOUT_MAX_INPUT_BYTES // (1024 * 1024)}MB）。"
                    "背景透過を終了しました。",
                    mention_author=False,
                )
                return
            if self._bgcut_jobs >= BG_CUTOUT_MAX_JOBS:
                await msg.reply(
                    "処理が混み合っています。少し待ってからもう一度お試しください。",
                    mention_author=False,
                )
                return
            try:
                data = await att.read()
            except Exception:
                logger.debug("背景透過: 添付画像の取得に失敗しました", exc_info=True)
                await msg.reply("画像を取得できませんでした。", mention_author=False)
                return
            purpose = self._bgcut_purposes.get(key, "emoji")
            self._bgcut_last[user_id] = time.monotonic()
            self._bgcut_jobs += 1
            try:
                await msg.reply(
                    "処理中です（背景透過と圧縮を行っています）。"
                    "アニメーションGIFは時間がかかることがあります。",
                    mention_author=False,
                )
                meta, out_data = await self._bgcut_run_engine(data, purpose)
            except BgCutoutFailed as exc:
                if exc.unavailable:
                    logger.warning("背景透過: 処理基盤が利用不可です: %s", exc)
                await msg.reply(f"{exc} 背景透過を終了しました。",
                                mention_author=False)
                return
            finally:
                self._bgcut_jobs -= 1
            file = discord.File(io.BytesIO(out_data), filename=meta["filename"])
            await msg.reply(bgcut_result_text(meta), file=file,
                            mention_author=False)
            await edit_original_response_quietly(
                interaction, "背景透過",
                content="背景透過が完了しました。", view=None)
        except Exception:
            logger.exception("背景透過: 画像待ち処理に失敗しました")
        finally:
            self._bgcut_waits.pop(key, None)
            self._bgcut_purposes.pop(key, None)

    async def _bgcut_run_engine(self, data: bytes, purpose: str):
        """エンジンをサブプロセスで実行し (meta, 出力バイト列) を返す。

        同時実行はセマフォで1つに絞る（Pi のメモリ/CPU 保護）。
        """
        with tempfile.TemporaryDirectory(prefix="bgcut-") as td:
            in_path = Path(td) / "input.bin"
            out_path = Path(td) / "output.bin"
            in_path.write_bytes(data)
            async with self._bgcut_sem:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, str(_ENGINE_PATH),
                    str(in_path), str(out_path), purpose,
                    cwd=str(_REPO_ROOT),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(), timeout=BG_CUTOUT_PROCESS_TIMEOUT)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
                    raise BgCutoutFailed(
                        "処理がタイムアウトしました。"
                        "小さい画像で再試行してください。")
            if stderr:
                logger.debug("背景透過エンジン stderr: %s",
                             stderr.decode("utf-8", "replace")[-500:])
            lines = stdout.decode("utf-8", "replace").strip().splitlines()
            try:
                payload = json.loads(lines[-1]) if lines else {}
            except json.JSONDecodeError:
                payload = {}
            if proc.returncode != 0 or "error" in payload:
                raise BgCutoutFailed(
                    payload.get("error") or "処理に失敗しました。",
                    unavailable=bool(payload.get("unavailable")),
                )
            return payload, out_path.read_bytes()
