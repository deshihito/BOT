# -*- coding: utf-8 -*-
"""背景透過＋絵文字/スタンプ用エンコードの処理エンジン。

bot 本体（Raspberry Pi、メモリ逼迫）からはサブプロセスとして起動される
前提の自己完結モジュール。discord には依存せず、Pillow / numpy と
（背景除去時のみ）onnxruntime だけを使う。

    python engine.py <入力ファイル> <出力ファイル> <emoji|sticker>

結果メタデータは stdout の最終行に JSON で出す。失敗時は
{"error": "..."}（利用不可のときは "unavailable": true も）を出して
0 以外で終了する。

背景除去は u2netp（軽量版 U-2-Net、約4.6MB）を onnxruntime で直接推論する。
rembg 本体は依存が重い（scikit-image 等）ため採用しない。モデルは
リポジトリに含めず、初回利用時に公式配布（rembg の GitHub Release）から
data/models/ へダウンロードして md5 を検証する。
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageSequence

# --- 上限・目標値 -----------------------------------------------------------
EMOJI_MAX_BYTES = 256 * 1024        # カスタム絵文字の上限
EMOJI_MAX_EDGE = 128                # 絵文字の最大の一辺 (px)
STICKER_MAX_BYTES = 512 * 1024      # スタンプの上限
STICKER_SIZE = 320                  # スタンプは 320×320 ちょうど
MAX_INPUT_BYTES = 25 * 1024 * 1024  # 入力ファイルの上限
MAX_INPUT_PIXELS = 60_000_000       # 入力の総ピクセル数上限
WORK_MAX_EDGE = 512                 # 背景除去の作業解像度（長辺上限）
MAX_FRAMES = 60                     # 背景除去するアニメーションの最大フレーム数

MODEL_FILENAME = "u2netp.onnx"
MODEL_URL = (
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
)
MODEL_MD5 = "8e83ca70e441ab06c318d82300c84806"
MODEL_ENV_VAR = "AGO_BG_MODEL_PATH"

_U2NET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_U2NET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

PURPOSE_EMOJI = "emoji"
PURPOSE_STICKER = "sticker"


class BgCutError(Exception):
    """ユーザーに見せてよい文面を持つ処理失敗。"""


class UnavailableError(BgCutError):
    """処理基盤（onnxruntime / モデル）が使えない環境での失敗。"""


@dataclass
class ProcessResult:
    data: bytes
    filename: str
    out_format: str  # "PNG" / "GIF"
    width: int
    height: int
    in_bytes: int
    in_width: int
    in_height: int
    in_format: str
    animated: bool
    frames_in: int
    frames_out: int
    purpose: str
    notes: list[str] = field(default_factory=list)

    def meta(self) -> dict:
        return {
            "filename": self.filename,
            "format": self.out_format,
            "width": self.width,
            "height": self.height,
            "out_bytes": len(self.data),
            "in_bytes": self.in_bytes,
            "in_width": self.in_width,
            "in_height": self.in_height,
            "in_format": self.in_format,
            "animated": self.animated,
            "frames_in": self.frames_in,
            "frames_out": self.frames_out,
            "purpose": self.purpose,
            "notes": self.notes,
        }


# --- モデル取得 -------------------------------------------------------------

def model_path() -> Path:
    """モデルの置き場所。環境変数で上書きでき、既定は <repo>/data/models/。"""
    override = os.environ.get(MODEL_ENV_VAR)
    if override:
        return Path(override)
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "data" / "models" / MODEL_FILENAME


def _md5_of(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 256), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model() -> Path:
    """モデルを用意する。無ければダウンロードし、md5 を検証する。"""
    path = model_path()
    if path.exists() and _md5_of(path) == MODEL_MD5:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".onnx.tmp")
    try:
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "ago-bot-bgcut"})
        with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as fh:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                fh.write(chunk)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise UnavailableError(
            "背景透過モデルを取得できませんでした（この環境では利用できません）"
        ) from exc
    if _md5_of(tmp) != MODEL_MD5:
        tmp.unlink(missing_ok=True)
        raise UnavailableError(
            "背景透過モデルの検証に失敗しました（この環境では利用できません）"
        )
    tmp.replace(path)
    return path


# --- 背景除去 ---------------------------------------------------------------

_SESSION = None


def _get_session():
    global _SESSION
    if _SESSION is None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise UnavailableError(
                "背景透過ライブラリ（onnxruntime）が未導入のため、"
                "この環境では利用できません"
            ) from exc
        path = ensure_model()
        try:
            _SESSION = ort.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
        except Exception as exc:
            raise UnavailableError(
                "背景透過モデルを読み込めませんでした（この環境では利用できません）"
            ) from exc
    return _SESSION


def predict_alpha(rgb: Image.Image) -> Image.Image:
    """RGB 画像から前景マスク（'L'、入力と同じサイズ）を推定する。"""
    session = _get_session()
    inp = session.get_inputs()[0]
    small = rgb.resize((320, 320), Image.BILINEAR)
    arr = np.asarray(small).astype(np.float32) / 255.0
    arr = (arr - _U2NET_MEAN) / _U2NET_STD
    arr = arr.transpose(2, 0, 1)[None, ...]
    out = session.run(None, {inp.name: arr})[0][0, 0]
    lo, hi = float(out.min()), float(out.max())
    if hi - lo < 1e-6:
        mask = np.zeros(out.shape, dtype=np.uint8)
    else:
        mask = ((out - lo) / (hi - lo) * 255.0).astype(np.uint8)
    mask_img = Image.fromarray(mask, mode="L").resize(rgb.size, Image.BILINEAR)
    # 薄い背景ハゼを落とし、縁を締めるための穏やかな再マッピング。
    lut = [0 if i < 10 else 255 if i > 245 else int((i - 10) * 255 / 235)
           for i in range(256)]
    return mask_img.point(lut)


def _fit_work(img: Image.Image) -> Image.Image:
    """作業解像度（長辺 WORK_MAX_EDGE 上限）に縮小する（拡大はしない）。"""
    w, h = img.size
    scale = min(1.0, WORK_MAX_EDGE / max(w, h))
    if scale >= 1.0:
        return img
    return img.resize(
        (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS
    )


def remove_background(img: Image.Image) -> Image.Image:
    """1枚の画像の背景を透過した RGBA 画像を返す。

    元から透過を持つ入力は、白背景に合成して推論し、予測マスクと
    既存アルファの小さい方を採用する（既存の切り抜きを壊さない）。
    """
    rgba = img.convert("RGBA")
    work = _fit_work(rgba)
    rgb = Image.new("RGB", work.size, (255, 255, 255))
    rgb.paste(work, mask=work.getchannel("A"))
    mask = predict_alpha(rgb)
    alpha = np.minimum(
        np.asarray(mask, dtype=np.uint16),
        np.asarray(work.getchannel("A"), dtype=np.uint16),
    ).astype(np.uint8)
    out = work.copy()
    out.putalpha(Image.fromarray(alpha, mode="L"))
    return out


# --- 入力読み込み -------------------------------------------------------------

def _sample_frames(frames, durations):
    """フレーム数を MAX_FRAMES 以下に間引く（継続時間は合算する）。"""
    n = len(frames)
    if n <= MAX_FRAMES:
        return frames, durations, False
    step = -(-n // MAX_FRAMES)  # ceil
    out_f, out_d = [], []
    for i in range(0, n, step):
        out_f.append(frames[i])
        out_d.append(sum(durations[i:i + step]))
    return out_f, out_d, True


def load_image(data: bytes):
    """バイト列を開き (frames, durations, loop, src) を返す。

    frames は RGBA のリスト（静止画は1枚）。アニメーションは
    MAX_FRAMES まで間引き済み。src は開いた PIL 画像（メタ情報用）。
    """
    if len(data) > MAX_INPUT_BYTES:
        raise BgCutError(
            f"ファイルが大きすぎます（上限 {MAX_INPUT_BYTES // (1024 * 1024)}MB）"
        )
    try:
        src = Image.open(io.BytesIO(data))
        src.load()
    except Exception as exc:
        raise BgCutError("画像として読み込めませんでした") from exc
    if src.width * src.height > MAX_INPUT_PIXELS:
        raise BgCutError("画像のピクセル数が大きすぎます")
    n_frames = getattr(src, "n_frames", 1)
    if n_frames <= 1:
        return [src.convert("RGBA")], [0], 0, src, False
    frames, durations = [], []
    default_duration = int(src.info.get("duration", 100) or 100)
    for frame in ImageSequence.Iterator(src):
        frames.append(frame.convert("RGBA"))
        durations.append(int(frame.info.get("duration", default_duration) or default_duration))
    loop = int(src.info.get("loop", 0) or 0)
    frames, durations, _sampled = _sample_frames(frames, durations)
    return frames, durations, loop, src, True


# --- エンコード共通 -----------------------------------------------------------

def _save_bytes(img: Image.Image, fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def _fit_within(img: Image.Image, max_edge: int) -> Image.Image:
    """アスペクト比を保って max_edge×max_edge 内に収める（拡大しない）。"""
    w, h = img.size
    scale = min(1.0, max_edge / w, max_edge / h)
    if scale >= 1.0:
        return img
    return img.resize(
        (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS
    )


def _quantize(img: Image.Image, colors: int) -> Image.Image:
    """RGBA をパレット PNG 向けに量子化する（アルファは保持される）。"""
    return img.quantize(colors=colors, method=Image.MEDIANCUT)


# --- 静止画エンコード -----------------------------------------------------------

def encode_still_emoji(rgba: Image.Image):
    """絵文字用静止画: PNG ≤256KB、最大128×128。"""
    img = _fit_within(rgba, EMOJI_MAX_EDGE)
    data = _save_bytes(img, "PNG", optimize=True)
    if len(data) <= EMOJI_MAX_BYTES:
        return data, img.size, []
    for colors in (256, 128, 64, 32, 16):
        data = _save_bytes(_quantize(img, colors), "PNG", optimize=True)
        if len(data) <= EMOJI_MAX_BYTES:
            return data, img.size, [f"色数を{colors}色に減らして容量内に収めました"]
    raise BgCutError("256KB以内に収められませんでした")


def _sticker_canvas(subject: Image.Image, fit_edge: int) -> Image.Image:
    """被写体を fit_edge 内に収め、320×320 の透過キャンバス中央へ置く。"""
    fitted = _fit_within(subject, fit_edge)
    canvas = Image.new("RGBA", (STICKER_SIZE, STICKER_SIZE), (0, 0, 0, 0))
    canvas.paste(
        fitted,
        ((STICKER_SIZE - fitted.width) // 2, (STICKER_SIZE - fitted.height) // 2),
        fitted,
    )
    return canvas


def encode_still_sticker(rgba: Image.Image):
    """スタンプ用静止画: 320×320 PNG ≤512KB。"""
    attempts = [(STICKER_SIZE, None), (STICKER_SIZE, 256), (256, 256),
                (192, 256), (192, 128), (128, 128), (96, 64)]
    notes: list[str] = []
    for fit_edge, colors in attempts:
        canvas = _sticker_canvas(rgba, fit_edge)
        target = _quantize(canvas, colors) if colors else canvas
        data = _save_bytes(target, "PNG", optimize=True)
        if len(data) <= STICKER_MAX_BYTES:
            if fit_edge < STICKER_SIZE:
                notes.append("容量内に収めるため被写体を縮小しました")
            if colors:
                notes.append(f"色数を{colors}色に減らして容量内に収めました")
            return data, canvas.size, notes
    raise BgCutError("512KB以内に収められませんでした")


# --- アニメーションエンコード ---------------------------------------------------

def _gif_frame(rgba: Image.Image, colors: int) -> Image.Image:
    """RGBA フレームを、最終インデックスを透過色とした P モードへ変換する。"""
    if colors < 2:
        colors = 2
    pal = rgba.convert("RGB").quantize(
        colors=colors - 1, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG
    )
    alpha = rgba.getchannel("A")
    trans_mask = alpha.point(lambda a: 255 if a < 128 else 0)
    pal.paste(colors - 1, mask=trans_mask)
    pal.info["transparency"] = colors - 1
    return pal


def _encode_gif(frames, durations, loop, colors) -> bytes:
    pal_frames = [_gif_frame(f, colors) for f in frames]
    return _save_bytes(
        pal_frames[0], "GIF", save_all=True, append_images=pal_frames[1:],
        duration=durations, loop=loop, disposal=[2] * len(pal_frames),
        optimize=False,
    )


def _sample_durations(durations, step):
    if step <= 1:
        return durations
    return [sum(durations[i:i + step]) for i in range(0, len(durations), step)]


def _clamp_durations(durations):
    return [max(20, int(d)) for d in durations]


def encode_anim_emoji(frames, durations, loop):
    """絵文字用アニメーション: GIF ≤256KB（最大128×128）。"""
    # 優先順（画質を保てる順）: 寸法 → 色数 → フレーム間引き を段階的に落とす。
    ladder = [
        (128, 1, 256), (128, 1, 128), (128, 1, 64), (128, 2, 256),
        (112, 1, 128), (128, 2, 128), (96, 1, 128), (128, 3, 128),
        (96, 2, 128), (80, 2, 128), (128, 4, 64), (64, 2, 64),
        (64, 3, 64), (48, 3, 32), (32, 4, 32),
    ]
    base_size = _fit_within(frames[0], EMOJI_MAX_EDGE).size
    for edge, step, colors in ladder:
        use_frames = [_fit_within(f, edge) for f in frames[::step]] if step > 1 \
            else [_fit_within(f, edge) for f in frames]
        use_durations = _clamp_durations(_sample_durations(durations, step))
        data = _encode_gif(use_frames, use_durations, loop, colors)
        if len(data) <= EMOJI_MAX_BYTES:
            notes = []
            if step > 1:
                notes.append(f"容量内に収めるためフレームを間引きました（{len(frames)}→{len(use_frames)}）")
            if use_frames[0].size != base_size:
                notes.append(f"容量内に収めるためサイズを{use_frames[0].width}×{use_frames[0].height}に縮小しました")
            if colors < 256:
                notes.append(f"色数を{colors}色に減らして容量内に収めました")
            return data, use_frames[0].size, len(use_frames), notes
    raise BgCutError("256KB以内に収められませんでした")


def encode_anim_sticker(frames, durations, loop):
    """スタンプ用アニメーション: GIF ≤512KB（320×320、透過は1bit）。

    GIF で送られたものは GIF で返るのが利用者の期待のため、スタンプの
    アニメーション出力は GIF を既定とする（APNG にはしない）。
    """
    # 優先順（画質を保てる順）: 寸法 → 色数 → フレーム間引き を段階的に落とす。
    ladder = [
        (320, 1, 256), (320, 1, 128), (320, 2, 256),
        (256, 1, 128), (320, 2, 128), (256, 2, 128),
        (192, 1, 128), (320, 3, 128), (192, 2, 128),
        (128, 2, 128), (192, 3, 64), (128, 3, 64),
        (96, 4, 64), (96, 4, 32),
    ]
    for fit_edge, step, colors in ladder:
        use_frames = [_sticker_canvas(f, fit_edge) for f in frames[::step]]
        use_durations = _clamp_durations(_sample_durations(durations, step))
        data = _encode_gif(use_frames, use_durations, loop, colors)
        if len(data) <= STICKER_MAX_BYTES:
            notes = []
            if step > 1:
                notes.append(f"容量内に収めるためフレームを間引きました（{len(frames)}→{len(use_frames)}）")
            if fit_edge < STICKER_SIZE:
                notes.append("容量内に収めるため被写体を縮小しました")
            if colors < 256:
                notes.append(f"色数を{colors}色に減らして容量内に収めました")
            return data, "GIF", (STICKER_SIZE, STICKER_SIZE), len(use_frames), notes
    raise BgCutError("512KB以内に収められませんでした")


# --- 本体 ---------------------------------------------------------------------

def process_bytes(data: bytes, purpose: str) -> ProcessResult:
    """入力バイト列を処理し、用途別の出力とメタデータを返す。"""
    if purpose not in (PURPOSE_EMOJI, PURPOSE_STICKER):
        raise BgCutError("用途の指定が不正です")
    frames, durations, loop, src, animated = load_image(data)
    in_w, in_h = src.size
    in_format = src.format or "?"
    frames_in = getattr(src, "n_frames", 1) if animated else 1
    notes: list[str] = []
    if animated and frames_in > len(frames):
        notes.append(f"フレーム数が多いため{len(frames)}フレームに間引いて処理しました")

    if not animated:
        cut = remove_background(frames[0])
        if purpose == PURPOSE_EMOJI:
            out, (w, h), enc_notes = encode_still_emoji(cut)
            filename, out_format = "emoji.png", "PNG"
        else:
            out, (w, h), enc_notes = encode_still_sticker(cut)
            filename, out_format = "sticker.png", "PNG"
        notes += enc_notes
        frames_out = 1
    else:
        cut_frames = [remove_background(f) for f in frames]
        if purpose == PURPOSE_EMOJI:
            out, (w, h), frames_out, enc_notes = encode_anim_emoji(
                cut_frames, durations, loop)
            filename, out_format = "emoji.gif", "GIF"
        else:
            out, out_format, (w, h), frames_out, enc_notes = encode_anim_sticker(
                cut_frames, durations, loop)
            filename = "sticker.gif" if out_format == "GIF" else "sticker.png"
        notes += enc_notes

    return ProcessResult(
        data=out, filename=filename, out_format=out_format,
        width=w, height=h,
        in_bytes=len(data), in_width=in_w, in_height=in_h,
        in_format=in_format, animated=animated,
        frames_in=frames_in, frames_out=frames_out,
        purpose=purpose, notes=notes,
    )


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3:
        print(json.dumps({"error": "引数が不正です"}, ensure_ascii=False))
        return 2
    in_path, out_path, purpose = argv
    try:
        data = Path(in_path).read_bytes()
        result = process_bytes(data, purpose)
        Path(out_path).write_bytes(result.data)
        print(json.dumps(result.meta(), ensure_ascii=False))
        return 0
    except UnavailableError as exc:
        print(json.dumps({"error": str(exc), "unavailable": True},
                         ensure_ascii=False))
        return 3
    except BgCutError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2
    except Exception as exc:  # 想定外も無言にせず理由を返す
        print(json.dumps(
            {"error": f"処理中にエラーが発生しました（{type(exc).__name__}）"},
            ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
