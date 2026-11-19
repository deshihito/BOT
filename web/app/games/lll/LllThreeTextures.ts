// LLL 3D シーン専用のプロシージャルテクスチャ生成ユーティリティ。
// 5:7 カード表面・裏面・魔法陣・パーティクル用グローを CanvasTexture として生成し、
// バトル中の HP・シールド・状態変化に合わせて再描画する。
import * as THREE from "three";

export type ThreeCardInput = {
  id: string;
  name: string;
  element: string;
  tier: string;
  level: number;
  limitBreak?: number;
  glyph?: string;
  imageDataUrl?: string;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  shield?: number;
  defending?: boolean;
  alive?: boolean;
  statuses?: { kind: string; turns: number }[];
  showHpBar?: boolean;
};

export const ELEMENT_HEX: Record<string, string> = {
  fire: "#e06d53",
  water: "#5b9bd5",
  wind: "#52b788",
  earth: "#d4a24c",
  light: "#ebd38c",
  dark: "#94a3c4",
};

export const ELEMENT_NUM: Record<string, number> = {
  fire: 0xe06d53,
  water: 0x5b9bd5,
  wind: 0x52b788,
  earth: 0xd4a24c,
  light: 0xebd38c,
  dark: 0x94a3c4,
};

export const ELEMENT_SHORT: Record<string, string> = {
  fire: "火",
  water: "水",
  wind: "風",
  earth: "土",
  light: "光",
  dark: "闇",
};

export const TIER_HEX: Record<string, string> = {
  normal: "#5f6778",
  elite: "#5b9bd5",
  legend: "#d4a24c",
};

export const TIER_NUM: Record<string, number> = {
  normal: 0x5f6778,
  elite: 0x5b9bd5,
  legend: 0xd4a24c,
};

const imageElementCache = new Map<string, HTMLImageElement>();

function getLoadedImage(url: string, onLoaded: () => void): HTMLImageElement | null {
  const existing = imageElementCache.get(url);
  if (existing) {
    if (existing.complete && existing.naturalWidth > 0) return existing;
    return null;
  }
  const img = new Image();
  img.onload = () => {
    onLoaded();
  };
  img.src = url;
  imageElementCache.set(url, img);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function drawCardFaceCanvas(
  canvas: HTMLCanvasElement,
  card: ThreeCardInput,
  onImageLoaded?: () => void,
): void {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const tierHex = TIER_HEX[card.tier] ?? TIER_HEX.normal;
  const elHex = ELEMENT_HEX[card.element] ?? ELEMENT_HEX.light;
  const dead = card.alive === false;

  ctx.clearRect(0, 0, W, H);

  // 背景グラデーション
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
  if (card.tier === "legend") {
    bg.addColorStop(0, "#3d3017");
    bg.addColorStop(0.55, "#1b160c");
    bg.addColorStop(1, "#2b2210");
  } else if (card.tier === "elite") {
    bg.addColorStop(0, "#1d2d40");
    bg.addColorStop(0.55, "#121a26");
    bg.addColorStop(1, "#182433");
  } else {
    bg.addColorStop(0, "#232833");
    bg.addColorStop(1, "#14171f");
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 内枠とコーナー光彩
  ctx.strokeStyle = tierHex;
  ctx.lineWidth = 14;
  roundRect(ctx, 10, 10, W - 20, H - 20, 22);
  ctx.stroke();

  if (card.tier !== "normal") {
    ctx.strokeStyle = "rgba(255,255,255,0.26)";
    ctx.lineWidth = 3;
    roundRect(ctx, 20, 20, W - 40, H - 40, 16);
    ctx.stroke();
  }

  // ヘッダー（カード名 + Lv）
  ctx.fillStyle = "rgba(10,12,16,0.58)";
  roundRect(ctx, 26, 26, W - 52, 62, 12);
  ctx.fill();

  ctx.fillStyle = "#edeae2";
  ctx.font = "800 28px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const maxName = card.name.length > 10 ? `${card.name.slice(0, 9)}…` : card.name;
  ctx.fillText(maxName, 40, 57);

  ctx.fillStyle = "rgba(212, 162, 76, 0.22)";
  roundRect(ctx, W - 122, 36, 86, 42, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(237, 234, 226, 0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#edeae2";
  ctx.font = "800 22px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`Lv${card.level}`, W - 79, 57);

  // 限界突破ラベル
  const lb = Math.max(0, Math.min(5, card.limitBreak ?? 0));
  if (lb > 0) {
    ctx.fillStyle = "#d4a24c";
    ctx.font = "800 20px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`限界突破 +${lb}`, 36, 103);
  }

  // アート枠
  const artX = 28;
  const artY = lb > 0 ? 118 : 100;
  const artW = W - 56;
  const artH = card.showHpBar ? 330 : 370;

  ctx.save();
  roundRect(ctx, artX, artY, artW, artH, 16);
  ctx.clip();

  const artBg = ctx.createRadialGradient(W / 2, artY + artH * 0.4, 16, W / 2, artY + artH * 0.5, artW * 0.7);
  artBg.addColorStop(0, `${elHex}44`);
  artBg.addColorStop(1, "#0d1016");
  ctx.fillStyle = artBg;
  ctx.fillRect(artX, artY, artW, artH);

  let drewImage = false;
  if (card.imageDataUrl) {
    const img = getLoadedImage(card.imageDataUrl, () => {
      if (onImageLoaded) onImageLoaded();
    });
    if (img) {
      const ratio = Math.max(artW / img.naturalWidth, artH / img.naturalHeight);
      const dw = img.naturalWidth * ratio;
      const dh = img.naturalHeight * ratio;
      ctx.drawImage(img, artX + (artW - dw) / 2, artY + (artH - dh) / 2, dw, dh);
      drewImage = true;
    }
  }
  if (!drewImage) {
    // 紋章リング
    ctx.strokeStyle = `${elHex}77`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(W / 2, artY + artH / 2, 92, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W / 2, artY + artH / 2, 114, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = card.tier === "legend" ? "#e6c07b" : elHex;
    ctx.font = "900 132px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(card.glyph ?? ELEMENT_SHORT[card.element] ?? "L", W / 2, artY + artH / 2 + 4);
  }
  ctx.restore();

  // アート枠の縁
  ctx.strokeStyle = "rgba(237,234,226,0.2)";
  ctx.lineWidth = 2;
  roundRect(ctx, artX, artY, artW, artH, 16);
  ctx.stroke();

  // 属性バッジ
  ctx.fillStyle = "rgba(12, 14, 18, 0.86)";
  roundRect(ctx, artX + 12, artY + artH - 50, 74, 38, 10);
  ctx.fill();
  ctx.strokeStyle = elHex;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = elHex;
  ctx.font = "800 22px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(ELEMENT_SHORT[card.element] ?? card.element, artX + 49, artY + artH - 31);

  // シールド / 防御バッジ
  if ((card.shield ?? 0) > 0) {
    ctx.fillStyle = "rgba(18, 36, 56, 0.92)";
    roundRect(ctx, artX + artW - 122, artY + artH - 50, 110, 38, 10);
    ctx.fill();
    ctx.strokeStyle = "#5b9bd5";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#cde5ff";
    ctx.font = "800 20px system-ui, sans-serif";
    ctx.fillText(`盾 ${card.shield}`, artX + artW - 67, artY + artH - 31);
  } else if (card.defending) {
    ctx.fillStyle = "rgba(22, 52, 38, 0.92)";
    roundRect(ctx, artX + artW - 118, artY + 12, 106, 36, 10);
    ctx.fill();
    ctx.fillStyle = "#a6e2c2";
    ctx.font = "800 20px system-ui, sans-serif";
    ctx.fillText("防御中", artX + artW - 65, artY + 30);
  }

  // バトル時 HP バー
  let cursorY = artY + artH + 18;
  if (card.showHpBar) {
    const pct = card.maxHp > 0 ? Math.max(0, Math.min(1, card.hp / card.maxHp)) : 0;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    roundRect(ctx, 28, cursorY, W - 56, 20, 10);
    ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = pct <= 0.25 ? "#d9635a" : pct <= 0.5 ? "#dfb85b" : "#52b788";
      roundRect(ctx, 28, cursorY, Math.max(18, (W - 56) * pct), 20, 10);
      ctx.fill();
    }
    ctx.fillStyle = "#edeae2";
    ctx.font = "800 22px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`HP ${Math.max(0, card.hp)} / ${card.maxHp}`, 30, cursorY + 40);
    cursorY += 58;
  }

  // ステータス 4分割パネル
  const statY = cursorY + 6;
  const statH = H - statY - 28;
  ctx.fillStyle = "rgba(10, 12, 16, 0.52)";
  roundRect(ctx, 28, statY, W - 56, statH, 12);
  ctx.fill();
  const cols = [
    ["HP", card.maxHp],
    ["ATK", card.atk],
    ["DEF", card.def],
    ["SPD", card.spd],
  ] as const;
  const colW = (W - 56) / 4;
  cols.forEach(([label, val], idx) => {
    const cx = 28 + colW * idx + colW / 2;
    ctx.fillStyle = "#98a0ae";
    ctx.font = "700 20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, cx, statY + statH * 0.34);
    ctx.fillStyle = "#edeae2";
    ctx.font = "900 32px system-ui, sans-serif";
    ctx.fillText(String(val), cx, statY + statH * 0.72);
  });

  if (dead) {
    ctx.fillStyle = "rgba(10, 12, 16, 0.68)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f2a8a2";
    ctx.font = "900 54px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("DOWN", W / 2, H / 2);
  }
}

export function createCardFaceTexture(card: ThreeCardInput): {
  texture: THREE.CanvasTexture;
  redraw: (nextCard: ThreeCardInput) => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 716;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  let current = card;
  const paint = () => {
    drawCardFaceCanvas(canvas, current, () => {
      drawCardFaceCanvas(canvas, current);
      texture.needsUpdate = true;
    });
    texture.needsUpdate = true;
  };
  paint();

  return {
    texture,
    redraw: (nextCard: ThreeCardInput) => {
      current = nextCard;
      paint();
    },
  };
}

export function createCardBackTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 716;
  const ctx = canvas.getContext("2d")!;
  const bg = ctx.createLinearGradient(0, 0, 512, 716);
  bg.addColorStop(0, "#1d212b");
  bg.addColorStop(0.5, "#11141b");
  bg.addColorStop(1, "#181c24");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 716);

  ctx.strokeStyle = "#d4a24c";
  ctx.lineWidth = 10;
  roundRect(ctx, 20, 20, 472, 676, 22);
  ctx.stroke();

  ctx.strokeStyle = "rgba(212, 162, 76, 0.45)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(256, 358, 148, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(256, 358, 118, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#edeae2";
  ctx.font = "900 54px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("LLL", 256, 358);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createArenaCircleTexture(accentHex = "#d4a24c"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 1024, 1024);

  const cx = 512;
  const cy = 512;
  const glow = ctx.createRadialGradient(cx, cy, 40, cx, cy, 480);
  glow.addColorStop(0, `${accentHex}30`);
  glow.addColorStop(0.65, `${accentHex}14`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.strokeStyle = `${accentHex}99`;
  ctx.lineWidth = 4;
  for (const r of [460, 420, 310, 180]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 幾何学模様
  ctx.strokeStyle = "rgba(212, 162, 76, 0.34)";
  ctx.lineWidth = 3;
  for (const offset of [0, Math.PI / 3]) {
    ctx.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = offset + (i * Math.PI * 2) / 3;
      const px = cx + Math.cos(a) * 310;
      const py = cy + Math.sin(a) * 310;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // 目盛り
  ctx.strokeStyle = "rgba(237, 234, 226, 0.35)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI * 2) / 24;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 425, cy + Math.sin(a) * 425);
    ctx.lineTo(cx + Math.cos(a) * 455, cy + Math.sin(a) * 455);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGlowSpriteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.65)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
