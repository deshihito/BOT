// Scratch ペン拡張の再現（scratch-vm scratch3_pen + scratch-render PenSkin 相当）。
// 色パラメータは HSV 系: color(色相) 0-100 を 0-360度へ、saturation/brightness 0-100、
// transparency 0-100（0で不透明）。color は剰余で回り、その他は 0-100 にクランプされる。
import { toNumber } from "./cast.js";
export function defaultPenState() {
    return {
        color: 0,
        saturation: 100,
        brightness: 100,
        transparency: 0,
        penDown: false,
        penSize: 1,
    };
}
function clamp100(n) {
    return Math.min(100, Math.max(0, n));
}
function wrap100(n) {
    const r = n % 100;
    return r < 0 ? r + 100 : r;
}
/** Scratch の色値（数値 0xRRGGBB / "#rrggbb" 文字列）を RGB に変換する。 */
export function parseScratchColor(v) {
    if (typeof v === "number") {
        const n = Math.floor(v) & 0xffffff;
        return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    const s = String(v).trim();
    const hex = s.startsWith("#") ? s.slice(1) : s;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
        const n = parseInt(hex, 16);
        return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    const num = Number(s);
    if (!Number.isNaN(num))
        return parseScratchColor(num);
    return { r: 0, g: 0, b: 0 };
}
export function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === rn)
            h = 60 * (((gn - bn) / d) % 6);
        else if (max === gn)
            h = 60 * ((bn - rn) / d + 2);
        else
            h = 60 * ((rn - gn) / d + 4);
    }
    if (h < 0)
        h += 360;
    const s = max === 0 ? 0 : d / max;
    return { h, s: s * 100, v: max * 100 };
}
export function hsvToRgb(h, s, v) {
    const hn = ((h % 360) + 360) % 360;
    const sn = clamp100(s) / 100;
    const vn = clamp100(v) / 100;
    const c = vn * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = vn - c;
    let rn = 0, gn = 0, bn = 0;
    if (hn < 60) {
        rn = c;
        gn = x;
    }
    else if (hn < 120) {
        rn = x;
        gn = c;
    }
    else if (hn < 180) {
        gn = c;
        bn = x;
    }
    else if (hn < 240) {
        gn = x;
        bn = c;
    }
    else if (hn < 300) {
        rn = x;
        bn = c;
    }
    else {
        rn = c;
        bn = x;
    }
    return {
        r: Math.round((rn + m) * 255),
        g: Math.round((gn + m) * 255),
        b: Math.round((bn + m) * 255),
    };
}
/** ペン状態から実際に描く CSS 色を作る。 */
export function penCssColor(state) {
    const { r, g, b } = hsvToRgb(state.color * 3.6, state.saturation, state.brightness);
    const alpha = 1 - clamp100(state.transparency) / 100;
    return `rgba(${r},${g},${b},${alpha})`;
}
/** "色を〜にする" ブロック: RGB→HSV 変換して color/saturation/brightness を設定する。 */
export function setPenColorToColor(state, v) {
    const { r, g, b } = parseScratchColor(v);
    const hsv = rgbToHsv(r, g, b);
    state.color = hsv.h / 3.6;
    state.saturation = hsv.s;
    state.brightness = hsv.v;
}
export function setPenParam(state, param, v) {
    const n = toNumber(v);
    switch (param) {
        case "color":
            state.color = wrap100(n);
            break;
        case "saturation":
            state.saturation = clamp100(n);
            break;
        case "brightness":
            state.brightness = clamp100(n);
            break;
        case "transparency":
            state.transparency = clamp100(n);
            break;
        // Scratch 2 互換の shade は brightness として扱う（本作では未使用のはず）
        case "shade":
            state.brightness = wrap100(n);
            break;
    }
}
export function changePenParam(state, param, v) {
    const n = toNumber(v);
    switch (param) {
        case "color":
            state.color = wrap100(state.color + n);
            break;
        case "saturation":
            state.saturation = clamp100(state.saturation + n);
            break;
        case "brightness":
            state.brightness = clamp100(state.brightness + n);
            break;
        case "transparency":
            state.transparency = clamp100(state.transparency + n);
            break;
        case "shade":
            state.brightness = wrap100(state.brightness + n);
            break;
    }
}
/** ペンレイヤー（ステージ座標 480x360 のキャンバス）。 */
export class PenLayer {
    /** 描画が起きたことを Runtime へ伝えるフック (redrawRequested 用)。 */
    onDraw = null;
    canvas;
    ctx;
    /** 描画解像度倍率（表示キャンバスに合わせて上げる） */
    scale;
    constructor(scale = 2) {
        this.scale = scale;
        this.canvas = document.createElement("canvas");
        this.canvas.width = 480 * scale;
        this.canvas.height = 360 * scale;
        const ctx = this.canvas.getContext("2d");
        if (!ctx)
            throw new Error("2d context unavailable");
        this.ctx = ctx;
    }
    clear() {
        this.onDraw?.();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    toPx(x, y) {
        return [(x + 240) * this.scale, (180 - y) * this.scale];
    }
    /** 線を引く。太さはペンサイズ（ステージ座標単位）、端は丸める（Scratch の描画に合わせる）。 */
    drawLine(state, x0, y0, x1, y1) {
        this.onDraw?.();
        const ctx = this.ctx;
        const [ax, ay] = this.toPx(x0, y0);
        const [bx, by] = this.toPx(x1, y1);
        ctx.strokeStyle = penCssColor(state);
        ctx.lineWidth = Math.max(0.5, state.penSize * this.scale);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        // 同一点の場合は丸キャップで点になるよう僅かにずらす
        if (ax === bx && ay === by)
            ctx.lineTo(bx + 0.01, by);
        else
            ctx.lineTo(bx, by);
        ctx.stroke();
    }
    /** スタンプ: 画像をペンレイヤーへ焼き付ける。 */
    stampImage(img, w, h, cx, cy, rotationRad, flipX, alpha) {
        this.onDraw?.();
        const ctx = this.ctx;
        const [px, py] = this.toPx(cx, cy);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(rotationRad);
        if (flipX)
            ctx.scale(-1, 1);
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, (-w / 2) * this.scale, (-h / 2) * this.scale, w * this.scale, h * this.scale);
        ctx.restore();
    }
}
