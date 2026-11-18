// AGO WORLD BOX の Canvas2D 視覚演出レンダラー（描画専用）。
// ロジック・計算は visual-fx.ts / fx.ts / anim.ts に置き、ここは受け取った座標・進行度・状態から
// 鮮やかなエフェクト・敵予兆・技演出・斬撃・フローティング文字・照明ブルームを描く。
import { torchLightFlicker } from "./anim";
import { fxLifeRatio, hash01, skillFxProgress, thunderBoltPoints, type FxParticle, type SkillFxEffect } from "./fx";
import { PATTERN_DEF, type MobBehaviorState, type MobPatternId } from "./mob-behavior";
import {
  afterimageAlpha,
  atmosphereTintFor,
  floatingTextColors,
  floatingTextPose,
  placedLightGlowColor,
  swingStyleFor,
  telegraphTintFor,
  thunderBranches,
  type Afterimage,
  type FloatingText,
} from "./visual-fx";

// ---------------------------------------------------------------------------
// 1. パーティクル強化描画
// ---------------------------------------------------------------------------

export function drawParticleEnhanced(
  ctx: CanvasRenderingContext2D,
  p: FxParticle,
  sx: number,
  sy: number,
  sizePx: number,
  nowMs: number,
): void {
  const ratio = fxLifeRatio(p);
  ctx.fillStyle = p.color;
  ctx.strokeStyle = p.color;

  if (p.shape === "chip") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ratio * 1.65);
    ctx.translate(sx, sy);
    ctx.rotate(p.rot);
    ctx.fillRect(-sizePx / 2, -sizePx * 0.28, sizePx, sizePx * 0.56);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(-sizePx / 2, -sizePx * 0.28, sizePx, Math.max(1, sizePx * 0.16));
    ctx.restore();
    return;
  }

  if (p.shape === "leaf") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ratio * 1.6);
    ctx.translate(sx + Math.sin(p.age * 5 + p.rot) * 2.5, sy);
    ctx.rotate(p.rot + Math.sin(p.age * 4) * 0.35);
    ctx.beginPath();
    ctx.ellipse(0, 0, sizePx * 0.58, sizePx * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-sizePx * 0.45, 0);
    ctx.lineTo(sizePx * 0.45, 0);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (p.shape === "spark") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ratio * 1.85);
    ctx.translate(sx, sy);
    ctx.rotate(Math.atan2(p.vy, p.vx));
    const len = Math.max(sizePx * 1.35, 3);
    ctx.fillRect(-len * 0.55, -1.2, len, 2.4);
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = Math.min(1, ratio * 1.2) * 0.75;
    ctx.fillRect(0, -0.7, len * 0.45, 1.4);
    ctx.restore();
    return;
  }

  if (p.shape === "ring") {
    const prog = 1 - ratio;
    ctx.save();
    ctx.globalAlpha = 0.7 * ratio;
    ctx.lineWidth = Math.max(1, 2.4 * ratio);
    ctx.beginPath();
    ctx.ellipse(sx, sy, sizePx * (0.65 + 2.5 * prog), sizePx * (0.28 + 0.95 * prog), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35 * ratio;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(sx, sy, sizePx * (0.35 + 1.5 * prog), sizePx * (0.15 + 0.55 * prog), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (p.shape === "puff") {
    ctx.save();
    ctx.globalAlpha = 0.34 * ratio;
    const r = sizePx * (1.2 - 0.32 * ratio);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.arc(sx + r * 0.38, sy - r * 0.16, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (p.shape === "glow") {
    const pulse = 0.85 + 0.22 * Math.sin(nowMs * 0.012 + p.rot * 3);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.34 * ratio * pulse;
    ctx.beginPath();
    ctx.arc(sx, sy, sizePx * 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.85 * ratio;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(1.2, sizePx * 0.48), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.65 * ratio;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(0.8, sizePx * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (p.shape === "snow") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ratio * 1.5);
    if (sizePx >= 2.6) {
      ctx.translate(sx, sy);
      ctx.rotate(p.rot);
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3;
        const dx = Math.cos(a) * sizePx * 0.55;
        const dy = Math.sin(a) * sizePx * 0.55;
        ctx.beginPath();
        ctx.moveTo(-dx, -dy);
        ctx.lineTo(dx, dy);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, sizePx / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // drop: 速度向きの雫＋小さな白ハイライト
  ctx.save();
  ctx.globalAlpha = Math.min(1, ratio * 1.75);
  ctx.beginPath();
  ctx.arc(sx, sy, sizePx / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.55 * ratio;
  ctx.beginPath();
  ctx.arc(sx - sizePx * 0.14, sy - sizePx * 0.14, Math.max(0.8, sizePx * 0.18), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 2. 冒険役職の技エフェクト（全11種の多層・質感レンダリング）
// ---------------------------------------------------------------------------

export function drawSkillFxEnhanced(
  ctx: CanvasRenderingContext2D,
  eff: SkillFxEffect,
  stage: number,
  now: number,
  sx: (wx: number) => number,
  sy: (wy: number) => number,
  TILE: number,
  reducedMotion: boolean,
): void {
  const prog = Math.max(0, skillFxProgress(eff, now));
  const cxp = sx(eff.x);
  const cyp = sy(eff.y);
  ctx.save();

  switch (eff.kind) {
    case "heal_zone": {
      const rTiles = 2.25;
      const pulse = 1 + Math.sin(now / 150) * 0.045;
      const fade = prog > 0.8 ? (1 - prog) / 0.2 : Math.min(1, prog / 0.12);
      const rx = rTiles * TILE * pulse;
      const ry = rTiles * TILE * 0.45 * pulse;

      // 柔らかい地面グラデーション発光
      const grad = ctx.createRadialGradient(cxp, cyp, rx * 0.1, cxp, cyp, rx);
      grad.addColorStop(0, `rgba(170,255,150,${(0.32 * fade).toFixed(3)})`);
      grad.addColorStop(0.7, `rgba(110,225,105,${(0.18 * fade).toFixed(3)})`);
      grad.addColorStop(1, "rgba(110,225,105,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      // 外周の二重魔法陣リング＋回転破線
      ctx.strokeStyle = `rgba(182,250,120,${(0.82 * fade).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.translate(cxp, cyp);
      ctx.scale(1, 0.45);
      ctx.rotate(now * 0.0014);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = `rgba(255,244,160,${(0.68 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(0, 0, rTiles * TILE * 0.78 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 立ち上る回復「＋」シンボル
      if (!reducedMotion) {
        for (let i = 0; i < 6; i++) {
          const cycle = (prog * 2.2 + i * 0.17) % 1;
          const ang = hash01(eff.seed + i * 19) * Math.PI * 2;
          const dist = (0.35 + hash01(eff.seed + i * 37) * 0.55) * rTiles * TILE;
          const px = cxp + Math.cos(ang) * dist;
          const py = cyp + Math.sin(ang) * dist * 0.42 - cycle * TILE * 1.15;
          const a = Math.sin(cycle * Math.PI) * fade * 0.9;
          ctx.fillStyle = i % 2 === 0 ? `rgba(190,255,155,${a.toFixed(3)})` : `rgba(255,244,150,${a.toFixed(3)})`;
          ctx.fillRect(px - 4, py - 1.3, 8, 2.6);
          ctx.fillRect(px - 1.3, py - 4, 2.6, 8);
        }
      }
      break;
    }

    case "poison_field": {
      const rTiles = 2.0;
      const pulse = 1 + Math.sin(now / 180) * 0.04;
      const fade = prog > 0.8 ? (1 - prog) / 0.2 : Math.min(1, prog / 0.1);
      const rx = rTiles * TILE * pulse;
      const ry = rTiles * TILE * 0.45 * pulse;

      const grad = ctx.createRadialGradient(cxp, cyp, rx * 0.1, cxp, cyp, rx);
      grad.addColorStop(0, `rgba(155,225,75,${(0.32 * fade).toFixed(3)})`);
      grad.addColorStop(0.65, `rgba(116,66,182,${(0.24 * fade).toFixed(3)})`);
      grad.addColorStop(1, "rgba(80,150,50,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(158,232,90,${(0.72 * fade).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();

      // 弾ける毒の泡
      for (let i = 0; i < 7; i++) {
        const cycle = (prog * 3.1 + hash01(eff.seed + i * 29)) % 1;
        const ang = hash01(eff.seed + i * 43) * Math.PI * 2;
        const rad = (0.2 + hash01(eff.seed + i * 61) * 0.72) * rTiles * TILE;
        const bx = cxp + Math.cos(ang) * rad;
        const by = cyp + Math.sin(ang) * rad * 0.42 - cycle * TILE * 0.55;
        const br = 2 + Math.sin(cycle * Math.PI) * 3.2;
        ctx.fillStyle = i % 3 === 0 ? `rgba(186,120,255,${(0.65 * fade).toFixed(3)})` : `rgba(168,242,92,${(0.65 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case "sweep": {
      const fx0 = sx(eff.fromX);
      const fy0 = sy(eff.fromY) - TILE * 0.4;
      const aim = Math.atan2(eff.y - eff.fromY, eff.x - eff.fromX);
      const span = 1.9;
      const head = aim - span * 0.65 + Math.min(1, prog * 1.45) * span * 1.25;
      const fade = Math.max(0, 1 - prog);

      ctx.globalCompositeOperation = "lighter";
      for (let k = 0; k < 3; k++) {
        const r = (1.15 + k * 0.34 + prog * 0.25) * TILE;
        ctx.strokeStyle = k === 0 ? `rgba(120,235,255,${(0.9 * fade).toFixed(3)})` : `rgba(225,248,255,${((0.72 - k * 0.18) * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(2, (7 - k * 1.8) * fade);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(fx0, fy0, r, head - 1.15 + k * 0.12, head);
        ctx.stroke();
      }
      // 先端の閃光星
      if (fade > 0.25) {
        const tipR = 1.5 * TILE;
        const txp = fx0 + Math.cos(head) * tipR;
        const typ = fy0 + Math.sin(head) * tipR;
        ctx.fillStyle = `rgba(255,255,255,${(0.9 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(txp, typ, 4.5 * fade, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case "whirlwind": {
      const fx0 = sx(eff.fromX);
      const fy0 = sy(eff.fromY) - TILE * 0.28;
      const fade = Math.max(0, 1 - prog * 0.72);
      ctx.globalCompositeOperation = "lighter";
      for (let k = 0; k < 4; k++) {
        const rr = (0.85 + k * 0.48 + prog * 0.55) * TILE;
        const a0 = prog * Math.PI * 7.5 + k * (Math.PI * 0.65);
        ctx.strokeStyle = k % 2 === 0 ? `rgba(135,235,255,${(0.82 * fade).toFixed(3)})` : `rgba(240,252,255,${(0.75 * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.5, (5.5 - k) * fade);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.ellipse(fx0, fy0, rr, rr * 0.58, 0, a0, a0 + Math.PI * 1.15);
        ctx.stroke();
      }
      break;
    }

    case "fireball": {
      const flightEnd = 0.4;
      if (prog < flightEnd) {
        const t01 = prog / flightEnd;
        const px = eff.fromX + (eff.x - eff.fromX) * t01;
        const py = eff.fromY - 0.4 + (eff.y - 0.4 - (eff.fromY - 0.4)) * t01;
        const curX = sx(px);
        const curY = sy(py);
        const backDx = eff.fromX - eff.x;
        const backDy = eff.fromY - eff.y;
        const dLen = Math.hypot(backDx, backDy) || 1;
        const ux = backDx / dLen;
        const uy = backDy / dLen;

        // 炎の尾（彗星トレイル）
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 4; i++) {
          const dist = (i + 1) * TILE * 0.22;
          const rad = TILE * (0.26 - i * 0.045);
          ctx.fillStyle = i < 2 ? `rgba(255,140,40,${(0.65 - i * 0.14).toFixed(2)})` : `rgba(255,80,25,${(0.45 - i * 0.08).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(curX + ux * dist, curY + uy * dist, Math.max(2, rad), 0, Math.PI * 2);
          ctx.fill();
        }
        // 本体グラデーション＋白熱コア
        const g = ctx.createRadialGradient(curX, curY, TILE * 0.06, curX, curY, TILE * 0.45);
        g.addColorStop(0, "rgba(255,255,220,0.98)");
        g.addColorStop(0.4, "rgba(255,155,48,0.88)");
        g.addColorStop(1, "rgba(255,70,20,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(curX, curY, TILE * 0.45, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // 着弾大爆発（三重リング＋太陽閃光）
        const k = Math.min(1, (prog - flightEnd) / (1 - flightEnd));
        const ease = 1 - Math.pow(1 - k, 2.4);
        const fade = 1 - k;
        const impY = sy(eff.y - 0.35);

        ctx.globalCompositeOperation = "lighter";
        const g = ctx.createRadialGradient(cxp, impY, 2, cxp, impY, TILE * (0.6 + ease * 1.9));
        g.addColorStop(0, `rgba(255,250,210,${(0.9 * fade).toFixed(3)})`);
        g.addColorStop(0.45, `rgba(255,126,38,${(0.65 * fade).toFixed(3)})`);
        g.addColorStop(1, "rgba(255,50,15,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cxp, impY, TILE * (0.6 + ease * 1.9), 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(255,200,90,${(0.85 * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.5, 4 * fade);
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * (0.4 + ease * 2.1), TILE * (0.2 + ease * 0.95), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }

    case "ice_lance": {
      const flightEnd = 0.4;
      if (prog < flightEnd) {
        const t01 = prog / flightEnd;
        const px = eff.fromX + (eff.x - eff.fromX) * t01;
        const py = eff.fromY - 0.4 + (eff.y - 0.4 - (eff.fromY - 0.4)) * t01;
        const curX = sx(px);
        const curY = sy(py);
        const ang = Math.atan2(eff.y - eff.fromY, eff.x - eff.fromX);

        ctx.globalCompositeOperation = "lighter";
        ctx.translate(curX, curY);
        ctx.rotate(ang);
        // 氷霧の尾
        const tailG = ctx.createLinearGradient(-TILE * 1.2, 0, TILE * 0.4, 0);
        tailG.addColorStop(0, "rgba(120,220,255,0)");
        tailG.addColorStop(1, "rgba(190,245,255,0.8)");
        ctx.fillStyle = tailG;
        ctx.beginPath();
        ctx.moveTo(-TILE * 1.15, 0);
        ctx.lineTo(0, -TILE * 0.16);
        ctx.lineTo(0, TILE * 0.16);
        ctx.closePath();
        ctx.fill();

        // 鋭利な氷槍の菱形本体
        ctx.fillStyle = "#b8f2ff";
        ctx.beginPath();
        ctx.moveTo(TILE * 0.52, 0);
        ctx.lineTo(-TILE * 0.08, -TILE * 0.17);
        ctx.lineTo(-TILE * 0.42, 0);
        ctx.lineTo(-TILE * 0.08, TILE * 0.17);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(TILE * 0.45, 0);
        ctx.lineTo(-TILE * 0.05, -TILE * 0.07);
        ctx.lineTo(-TILE * 0.25, 0);
        ctx.lineTo(-TILE * 0.05, TILE * 0.07);
        ctx.closePath();
        ctx.fill();
      } else {
        // 氷結破砕・結晶スパイク
        const k = Math.min(1, (prog - flightEnd) / (1 - flightEnd));
        const fade = 1 - k;
        const ease = 1 - Math.pow(1 - k, 2);
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = `rgba(175,242,255,${(0.9 * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.5, 3 * fade);
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * (0.3 + ease * 1.35), TILE * (0.14 + ease * 0.62), 0, 0, Math.PI * 2);
        ctx.stroke();

        // 放射線状の氷棘
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + eff.seed * 0.1;
          const r0 = TILE * 0.18;
          const r1 = TILE * (0.45 + ease * 0.85);
          ctx.fillStyle = `rgba(220,250,255,${(0.85 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(cxp + Math.cos(a - 0.14) * r0, cyp - TILE * 0.25 + Math.sin(a - 0.14) * r0 * 0.7);
          ctx.lineTo(cxp + Math.cos(a) * r1, cyp - TILE * 0.25 + Math.sin(a) * r1 * 0.7);
          ctx.lineTo(cxp + Math.cos(a + 0.14) * r0, cyp - TILE * 0.25 + Math.sin(a + 0.14) * r0 * 0.7);
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }

    case "thunder_strike": {
      const topY = sy(eff.y - 5.6);
      if (stage === 0) {
        // 予兆: 収束する落雷レティクル＋細い光のガイド柱
        const frac = prog / 0.55;
        const pulse = 0.28 + 0.22 * Math.sin(now / 50);
        ctx.fillStyle = `rgba(170,228,255,${(pulse * 0.65).toFixed(3)})`;
        ctx.fillRect(cxp - 2, topY, 4, cyp - topY);

        ctx.strokeStyle = `rgba(160,234,255,${(0.45 + 0.45 * frac).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * 1.2, TILE * 0.54, 0, 0, Math.PI * 2);
        ctx.stroke();

        const innerR = TILE * 1.2 * (1 - frac * 0.7);
        ctx.strokeStyle = `rgba(255,248,165,${(0.4 + 0.55 * frac).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, innerR, innerR * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // 落雷本体: 外側シアン発光＋芯の白線＋枝分かれ稲妻＋地面電撃リング
        const intensity = stage === 1 ? 1 : Math.max(0, 1 - (prog - 0.75) / 0.25);
        const jitterSeed = stage === 1 ? eff.seed + Math.floor(now / 45) : eff.seed;
        const pts = thunderBoltPoints(jitterSeed, eff.x, eff.y - 5.6, eff.x, eff.y);
        const branches = thunderBranches(jitterSeed, eff.x, eff.y - 5.6, eff.x, eff.y);

        ctx.globalCompositeOperation = "lighter";
        const strokePolyline = (poly: { x: number; y: number }[], width: number, color: string) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          poly.forEach((pt, idx) => {
            const X = sx(pt.x);
            const Y = sy(pt.y);
            if (idx === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          });
          ctx.stroke();
        };

        strokePolyline(pts, 11 * intensity, `rgba(105,212,255,${(0.42 * intensity).toFixed(3)})`);
        strokePolyline(pts, 4.5 * intensity, `rgba(205,246,255,${(0.88 * intensity).toFixed(3)})`);
        strokePolyline(pts, 2.2 * intensity, `rgba(255,255,255,${intensity.toFixed(3)})`);

        for (const br of branches) {
          strokePolyline(br, 4 * intensity, `rgba(105,212,255,${(0.35 * intensity).toFixed(3)})`);
          strokePolyline(br, 1.5 * intensity, `rgba(240,252,255,${(0.85 * intensity).toFixed(3)})`);
        }

        // 着弾地点の電撃オーブ＆リング
        const g = ctx.createRadialGradient(cxp, cyp, 2, cxp, cyp, TILE * 1.35);
        g.addColorStop(0, `rgba(255,255,255,${(0.92 * intensity).toFixed(3)})`);
        g.addColorStop(0.45, `rgba(120,224,255,${(0.55 * intensity).toFixed(3)})`);
        g.addColorStop(1, "rgba(120,224,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * 1.35, TILE * 0.65, 0, 0, Math.PI * 2);
        ctx.fill();

        if (stage === 1) {
          const ringK = (prog - 0.55) / 0.2;
          ctx.strokeStyle = `rgba(255,248,160,${(0.85 * (1 - ringK * 0.5)).toFixed(3)})`;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.ellipse(cxp, cyp, TILE * (0.5 + ringK * 1.25), TILE * (0.22 + ringK * 0.55), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      break;
    }

    case "meteor": {
      if (stage === 0) {
        // 予兆: 二重の赤熱マジックサークル＋収束照準＋照準十字
        const frac = prog / 0.6;
        const r = 2.5 * TILE;
        const ry = r * 0.45;
        ctx.fillStyle = `rgba(255,75,45,${(0.10 + 0.16 * frac).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, r, ry, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(255,105,65,${(0.55 + 0.35 * Math.sin(now / 65)).toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, r, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        // 収束する中心リング
        const shrink = Math.max(0.15, 1 - frac * 0.82);
        ctx.strokeStyle = `rgba(255,215,95,${(0.6 + 0.35 * frac).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, r * shrink, ry * shrink, 0, 0, Math.PI * 2);
        ctx.stroke();

        // 十字マーカー
        ctx.strokeStyle = `rgba(255,160,90,${(0.45 + 0.3 * frac).toFixed(3)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cxp - r * 0.7, cyp);
        ctx.lineTo(cxp + r * 0.7, cyp);
        ctx.moveTo(cxp, cyp - ry * 0.7);
        ctx.lineTo(cxp, cyp + ry * 0.7);
        ctx.stroke();
      } else if (stage === 1) {
        // 落下中の灼熱メテオ＋地面の警告影＋炎の尾
        const t01 = Math.max(0, Math.min(1, (prog - 0.6) / 0.2));
        const px = eff.x + 2.4 * (1 - t01);
        const py = eff.y - 4.8 * (1 - t01);
        const mx = sx(px);
        const my = sy(py);

        // 地面の影がだんだん大きく濃くなる
        ctx.fillStyle = `rgba(20,10,8,${(0.2 + 0.45 * t01).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * (0.4 + 0.8 * t01), TILE * (0.18 + 0.36 * t01), 0, 0, Math.PI * 2);
        ctx.fill();

        // 炎尾
        ctx.globalCompositeOperation = "lighter";
        for (let i = 3; i >= 1; i--) {
          const tx = sx(px + i * 0.32);
          const ty = sy(py - i * 0.62);
          ctx.fillStyle = i === 1 ? "rgba(255,155,55,0.65)" : "rgba(255,80,30,0.38)";
          ctx.beginPath();
          ctx.arc(tx, ty, TILE * (0.48 - i * 0.08), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";

        // 岩塊本体＋溶岩のひび
        ctx.fillStyle = "#4d342b";
        ctx.beginPath();
        ctx.arc(mx, my, TILE * 0.46, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ff8533";
        ctx.beginPath();
        ctx.arc(mx - TILE * 0.1, my + TILE * 0.08, TILE * 0.24, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffd970";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mx, my, TILE * 0.46, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // 着弾後: 大閃光＋二重衝撃波＋地面の放射亀裂
        const k = Math.max(0, Math.min(1, (prog - 0.8) / 0.2));
        const fade = 1 - k;
        const ease = 1 - Math.pow(1 - k, 2.2);

        // 放射状クレーター亀裂
        ctx.strokeStyle = `rgba(255,120,42,${(0.75 * fade).toFixed(3)})`;
        ctx.lineWidth = 2.5 * fade;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + hash01(eff.seed + i) * 0.25;
          const len = (1.4 + hash01(eff.seed + i * 17) * 1.1) * TILE;
          ctx.beginPath();
          ctx.moveTo(cxp + Math.cos(a) * TILE * 0.2, cyp + Math.sin(a) * TILE * 0.09);
          ctx.lineTo(cxp + Math.cos(a) * len, cyp + Math.sin(a) * len * 0.45);
          ctx.stroke();
        }

        ctx.globalCompositeOperation = "lighter";
        const g = ctx.createRadialGradient(cxp, cyp, 4, cxp, cyp, TILE * (0.9 + ease * 2.5));
        g.addColorStop(0, `rgba(255,250,210,${(0.95 * fade).toFixed(3)})`);
        g.addColorStop(0.45, `rgba(255,115,35,${(0.65 * fade).toFixed(3)})`);
        g.addColorStop(1, "rgba(255,40,10,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, TILE * (0.9 + ease * 2.5), TILE * (0.4 + ease * 1.12), 0, 0, Math.PI * 2);
        ctx.fill();

        for (let rIdx = 0; rIdx < 2; rIdx++) {
          const rk = Math.max(0, ease - rIdx * 0.16);
          ctx.strokeStyle = `rgba(255,210,110,${(0.85 * fade).toFixed(3)})`;
          ctx.lineWidth = Math.max(1.5, 4 * fade);
          ctx.beginPath();
          ctx.ellipse(cxp, cyp, TILE * (0.5 + rk * 2.6), TILE * (0.22 + rk * 1.15), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      break;
    }

    case "arrow_rain": {
      const fade = prog > 0.8 ? (1 - prog) / 0.2 : 1;
      ctx.strokeStyle = `rgba(255,214,68,${(0.6 * fade).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, 2.1 * TILE, 2.1 * TILE * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (let i = 0; i < 14; i++) {
        const h = hash01(eff.seed + i * 71);
        const rx = (hash01(eff.seed + i * 19) - 0.5) * 3.6;
        const ry = (hash01(eff.seed + i * 31) - 0.5) * 1.6;
        const fall = (prog * 3.4 + h) % 1;
        const ax = sx(eff.x + rx);
        const groundY = sy(eff.y + ry);
        const ay = groundY - (1 - fall) * TILE * 3.0;

        if (fall > 0.85) {
          // 着弾リング
          const rk = (fall - 0.85) / 0.15;
          ctx.strokeStyle = `rgba(255,245,210,${((1 - rk) * 0.65 * fade).toFixed(3)})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.ellipse(ax, groundY, TILE * (0.08 + rk * 0.22), TILE * (0.04 + rk * 0.1), 0, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // 矢の軌跡＋軸＋羽＋鏃
          ctx.strokeStyle = `rgba(255,255,255,${(0.28 * fade).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(ax - 3, ay - TILE * 0.65);
          ctx.lineTo(ax, ay);
          ctx.stroke();

          ctx.strokeStyle = `rgba(220,185,125,${(0.92 * fade).toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax - 2, ay - TILE * 0.45);
          ctx.lineTo(ax + 1.5, ay);
          ctx.stroke();

          ctx.fillStyle = `rgba(235,245,255,${(0.95 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(ax + 1.5, ay, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }

    case "taunt": {
      const fx0 = sx(eff.fromX);
      const fy0 = sy(eff.fromY);
      const fade = Math.max(0, 1 - prog);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 2; i++) {
        const k = Math.max(0, prog - i * 0.18);
        const a = Math.max(0, 1 - k) * 0.8;
        ctx.strokeStyle = i === 0 ? `rgba(255,212,62,${a.toFixed(3)})` : `rgba(255,140,60,${a.toFixed(3)})`;
        ctx.lineWidth = 3 * fade;
        ctx.beginPath();
        ctx.ellipse(fx0, fy0, (0.45 + k * 3.1) * TILE, (0.2 + k * 1.4) * TILE, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 盾の紋章マークが頭上へ浮かぶ
      const syShield = fy0 - TILE * (1.05 + prog * 0.35);
      ctx.fillStyle = `rgba(255,220,90,${(0.85 * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(fx0 - 7, syShield - 7);
      ctx.lineTo(fx0 + 7, syShield - 7);
      ctx.lineTo(fx0 + 7, syShield);
      ctx.lineTo(fx0, syShield + 8);
      ctx.lineTo(fx0 - 7, syShield);
      ctx.closePath();
      ctx.fill();
      break;
    }

    case "warp": {
      const rise = Math.min(1, prog * 1.55);
      const fade = Math.max(0, 1 - prog * 0.72);
      const colW = TILE * 0.75 * (1 - prog * 0.3);

      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createLinearGradient(cxp - colW, cyp, cxp + colW, cyp);
      g.addColorStop(0, "rgba(185,150,255,0)");
      g.addColorStop(0.5, `rgba(255,235,170,${(0.75 * fade).toFixed(3)})`);
      g.addColorStop(1, "rgba(185,150,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cxp - colW, cyp - TILE * 3.6 * rise, colW * 2, TILE * 3.6 * rise);

      for (let i = 0; i < 2; i++) {
        const rk = (prog + i * 0.25) % 1;
        ctx.strokeStyle = i === 0 ? `rgba(255,212,62,${(0.85 * fade).toFixed(3)})` : `rgba(202,168,255,${(0.75 * fade).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cxp, cyp, (0.3 + rk * 1.25) * TILE, (0.14 + rk * 0.56) * TILE, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 3. モブ予兆・投射物・糸跡・状態バッジ（氷結・怒り・ボスHP・警告!）
// ---------------------------------------------------------------------------

export function drawMobTelegraphEnhanced(
  ctx: CanvasRenderingContext2D,
  t: { pattern: MobPatternId; x: number; y: number; tx: number; ty: number; dirX: number; dirY: number; from: number; until: number; size: number },
  now: number,
  toScreenX: (wx: number) => number,
  toScreenY: (wy: number) => number,
  TILE: number,
): void {
  const pd = PATTERN_DEF[t.pattern];
  const total = Math.max(1, t.until - t.from);
  const frac = Math.max(0, Math.min(1, (now - t.from) / total));
  const tint = telegraphTintFor(t.pattern);
  const pulse = 0.05 * Math.sin(now * 0.032);
  const gx = pd.kind === "dash" || pd.kind === "teleport" || pd.kind === "projectile" ? t.tx : t.x;
  const gy = pd.kind === "dash" || pd.kind === "teleport" || pd.kind === "projectile" ? t.ty : t.y;
  const sx = toScreenX(gx);
  const sy = toScreenY(gy);

  ctx.save();
  if (pd.telegraph === "circle") {
    const r = pd.radius * TILE;
    const ry = r * 0.45;
    // 外枠：真の攻撃範囲（点線＋薄い下地）
    ctx.fillStyle = `rgba(${tint.fillRgb},0.10)`;
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = `rgba(${tint.strokeRgb},${(0.48 + 0.32 * frac).toFixed(3)})`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 内側チャージ円：0 -> 外枠へ伸びる（着弾のタイミングがひと目で分かる）
    ctx.fillStyle = `rgba(${tint.fillRgb},${(0.18 + 0.24 * frac + pulse).toFixed(3)})`;
    ctx.strokeStyle = `rgba(${tint.strokeRgb},${(0.65 + 0.3 * frac).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(sx, sy, r * frac, ry * frac, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (pd.telegraph === "ring") {
    const r = pd.radius * TILE;
    const ry = r * 0.45;
    const ox = toScreenX(t.x);
    const oy = toScreenY(t.y);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = `rgba(${tint.strokeRgb},0.45)`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(ox, oy, r, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = `rgba(${tint.strokeRgb},${(0.7 + 0.25 * frac).toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(ox, oy, r * frac, ry * frac, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (pd.telegraph === "line") {
    const x0 = toScreenX(t.x);
    const y0 = toScreenY(t.y);
    const ex = toScreenX(t.x + t.dirX * pd.radius);
    const ey = toScreenY(t.y + t.dirY * pd.radius);
    const width = Math.max(8, TILE * 0.52 * (0.5 + t.size * 0.2));

    // 外枠レーン
    ctx.lineCap = "round";
    ctx.strokeStyle = `rgba(${tint.fillRgb},0.16)`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // 進行ビーム
    ctx.strokeStyle = `rgba(${tint.strokeRgb},${(0.35 + 0.45 * frac + pulse).toFixed(3)})`;
    ctx.lineWidth = width * (0.35 + 0.65 * frac);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + (ex - x0) * frac, y0 + (ey - y0) * frac);
    ctx.stroke();

    // 方向シェブロン（矢印）
    const ang = Math.atan2(ey - y0, ex - x0);
    const midX = x0 + (ex - x0) * 0.55;
    const midY = y0 + (ey - y0) * 0.55;
    ctx.translate(midX, midY);
    ctx.rotate(ang);
    ctx.strokeStyle = `rgba(255,255,255,${(0.45 + 0.4 * frac).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, -width * 0.26);
    ctx.lineTo(4, 0);
    ctx.lineTo(-6, width * 0.26);
    ctx.stroke();
  } else if (pd.telegraph === "cone") {
    const ox = toScreenX(t.x);
    const oy = toScreenY(t.y);
    const ang = Math.atan2(t.dirY, t.dirX);
    const r = pd.radius * TILE;
    // 外枠扇
    ctx.fillStyle = `rgba(${tint.fillRgb},0.12)`;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.arc(ox, oy, r, ang - 0.6, ang + 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(${tint.strokeRgb},0.5)`;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 伸びる内側チャージ扇
    ctx.fillStyle = `rgba(${tint.fillRgb},${(0.2 + 0.26 * frac + pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.arc(ox, oy, r * frac, ang - 0.6, ang + 0.6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawMobProjectileEnhanced(
  ctx: CanvasRenderingContext2D,
  pr: { pattern: MobPatternId; x: number; y: number; tx: number; ty: number; from: number; until: number; color: string },
  now: number,
  toScreenX: (wx: number) => number,
  toScreenY: (wy: number) => number,
  TILE: number,
): void {
  const f = Math.max(0, Math.min(1, (now - pr.from) / Math.max(1, pr.until - pr.from)));
  const gx = toScreenX(pr.x + (pr.tx - pr.x) * f);
  const gy = toScreenY(pr.y + (pr.ty - pr.y) * f);
  const arc = pr.pattern === "rock_throw" ? Math.sin(f * Math.PI) * TILE * 1.25 : pr.pattern === "bone_throw" ? Math.sin(f * Math.PI) * TILE * 0.35 : 0;
  const sy = gy - arc;

  ctx.save();
  // 地面の影
  const shadowR = pr.pattern === "rock_throw" ? TILE * 0.22 : TILE * 0.13;
  ctx.fillStyle = "rgba(15,18,16,0.32)";
  ctx.beginPath();
  ctx.ellipse(gx, gy, shadowR, shadowR * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(gx, sy);
  if (pr.pattern === "bone_throw") {
    ctx.rotate(f * Math.PI * 5);
    const half = Math.max(6, TILE * 0.22);
    ctx.fillStyle = "#f2efe4";
    ctx.strokeStyle = "#4d453b";
    ctx.lineWidth = 1.5;
    ctx.fillRect(-half, -2.5, half * 2, 5);
    ctx.strokeRect(-half, -2.5, half * 2, 5);
    for (const endX of [-half, half]) {
      for (const dy of [-2.8, 2.8]) {
        ctx.beginPath();
        ctx.arc(endX, dy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  } else if (pr.pattern === "rock_throw") {
    ctx.rotate(f * Math.PI * 3.5);
    const r = Math.max(6, TILE * 0.28);
    ctx.fillStyle = "#7a7671";
    ctx.beginPath();
    ctx.moveTo(-r * 0.85, -r * 0.3);
    ctx.lineTo(-r * 0.2, -r * 0.95);
    ctx.lineTo(r * 0.75, -r * 0.55);
    ctx.lineTo(r * 0.9, r * 0.35);
    ctx.lineTo(r * 0.1, r * 0.9);
    ctx.lineTo(-r * 0.75, r * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#3d3a36";
    ctx.lineWidth = 1.8;
    ctx.stroke();
    // 上面ハイライト
    ctx.fillStyle = "#aca69e";
    ctx.beginPath();
    ctx.moveTo(-r * 0.65, -r * 0.25);
    ctx.lineTo(-r * 0.15, -r * 0.75);
    ctx.lineTo(r * 0.5, -r * 0.45);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
  } else if (pr.pattern === "web_shot") {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(3.5, TILE * 0.14), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(235,240,255,0.65)";
    ctx.lineWidth = 1.4;
    const dx = pr.x - pr.tx;
    const dy = pr.y - pr.ty;
    const len = Math.hypot(dx, dy) || 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo((dx / len) * TILE * 0.45, (dy / len) * TILE * 0.45);
    ctx.stroke();
  } else {
    ctx.fillStyle = pr.color;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(3.5, TILE * 0.15), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawMobWebEnhanced(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  remainRatio: number,
  TILE: number,
): void {
  const alpha = Math.min(0.65, remainRatio * 1.4);
  ctx.save();
  ctx.strokeStyle = `rgba(242,244,248,${alpha.toFixed(3)})`;
  ctx.lineWidth = 1.4;
  const rx = TILE * 0.48;
  const ry = TILE * 0.24;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * rx, sy + Math.sin(a) * ry);
    ctx.stroke();
  }
  for (const k of [0.45, 0.82]) {
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx * k, ry * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** モブの凍結氷結プリズム（単なる四角の塗りつぶしから多角結晶＋光沢へ）。 */
export function drawFrozenPrism(
  ctx: CanvasRenderingContext2D,
  cxp: number,
  cy: number,
  w: number,
  h: number,
  nowMs: number,
): void {
  const hw = w * 0.54;
  const hh = h * 0.54;
  const bevel = Math.min(hw, hh) * 0.28;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cxp - hw + bevel, cy - hh);
  ctx.lineTo(cxp + hw - bevel, cy - hh);
  ctx.lineTo(cxp + hw, cy - hh + bevel);
  ctx.lineTo(cxp + hw, cy + hh - bevel);
  ctx.lineTo(cxp + hw - bevel, cy + hh);
  ctx.lineTo(cxp - hw + bevel, cy + hh);
  ctx.lineTo(cxp - hw, cy + hh - bevel);
  ctx.lineTo(cxp - hw, cy - hh + bevel);
  ctx.closePath();

  const grad = ctx.createLinearGradient(cxp - hw, cy - hh, cxp + hw, cy + hh);
  grad.addColorStop(0, "rgba(215,248,255,0.58)");
  grad.addColorStop(0.5, "rgba(130,210,255,0.42)");
  grad.addColorStop(1, "rgba(85,175,240,0.52)");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(232,250,255,0.88)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 斜め光沢ハイライト
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cxp - hw * 0.45, cy - hh * 0.72);
  ctx.lineTo(cxp - hw * 0.72, cy - hh * 0.35);
  ctx.stroke();

  // 周囲を回る小さな氷片2つ
  const ang = nowMs * 0.0022;
  ctx.fillStyle = "rgba(230,252,255,0.85)";
  for (let i = 0; i < 2; i++) {
    const a = ang + i * Math.PI;
    const fx = cxp + Math.cos(a) * (hw + 4);
    const fy = cy + Math.sin(a) * (hh * 0.45);
    ctx.fillRect(fx - 1.5, fy - 1.5, 3, 3);
  }
  ctx.restore();
}

/** モブの頭上ステータス（警戒「!」・予兆の閃光・ボス名＋遅延追従HPバー）。 */
export function drawMobHudAndBadges(
  ctx: CanvasRenderingContext2D,
  opts: {
    cxp: number;
    by: number;
    sizePx: number;
    mode: MobBehaviorState["mode"];
    enraged: boolean;
    boss: boolean;
    mobName?: string;
    hpFrac: number;
    trailHpFrac: number;
    showHp: boolean;
    skipHpBar?: boolean;
    now: number;
  },
): void {
  const { cxp, by, sizePx, mode, enraged, boss, mobName, hpFrac, trailHpFrac, showHp, skipHpBar, now } = opts;
  ctx.save();

  // 発見（alert）の「!」バッジ
  if (mode === "alert") {
    const bounce = Math.abs(Math.sin(now * 0.018)) * 4;
    const ay = by - (showHp ? 22 : 10) - bounce;
    ctx.fillStyle = "#ff4e3a";
    ctx.strokeStyle = "#1c0a08";
    ctx.lineWidth = 2.5;
    ctx.font = "900 14px sans-serif";
    ctx.textAlign = "center";
    ctx.strokeText("!", cxp, ay);
    ctx.fillText("!", cxp, ay);
  } else if (mode === "windup") {
    const blink = 0.65 + 0.35 * Math.sin(now * 0.045);
    const ay = by - (showHp ? 20 : 8);
    ctx.fillStyle = `rgba(255,214,72,${blink.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cxp, ay - 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ボス王冠エンブレム＋状態ラベル、または HP バー
  if (showHp || (boss && enraged)) {
    const bw = Math.min(200, Math.max(boss ? 68 : 28, sizePx * 0.92));
    const bh = boss ? 6 : 4;
    const bx = Math.round(cxp - bw / 2);
    const byHp = Math.round(by - (boss ? 12 : 9));

    if (boss) {
      // ボス王冠エンブレム＋状態ラベル
      const crownY = byHp - 5;
      const baseLabel = mobName && mobName.length > 0 ? mobName : "BOSS";
      const label = enraged ? `${baseLabel} [怒]` : baseLabel;
      ctx.font = "700 10px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(10,10,14,0.82)";
      ctx.strokeText(label, cxp + 6, crownY);
      ctx.fillStyle = enraged ? "#ff8b78" : "#ffe078";
      ctx.fillText(label, cxp + 6, crownY);
      const tw = ctx.measureText(label).width;
      const crX = cxp + 6 - tw / 2 - 8;
      const crY = crownY - 4;
      ctx.fillStyle = enraged ? "#ff7058" : "#ffd84d";
      ctx.beginPath();
      ctx.moveTo(crX - 4, crY + 3);
      ctx.lineTo(crX - 4, crY - 2);
      ctx.lineTo(crX - 1.5, crY + 0.5);
      ctx.lineTo(crX, crY - 3);
      ctx.lineTo(crX + 1.5, crY + 0.5);
      ctx.lineTo(crX + 4, crY - 2);
      ctx.lineTo(crX + 4, crY + 3);
      ctx.closePath();
      ctx.fill();
    }

    if (!skipHpBar && showHp) {
      ctx.fillStyle = "rgba(10,12,14,0.68)";
      ctx.fillRect(bx - 1, byHp - 1, bw + 2, bh + 2);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(bx, byHp, bw, bh);

      // 白黄色の追従残像バー（ダメージ分がすっと縮む手応え演出）
      const clampedHp = Math.min(1, Math.max(0, hpFrac));
      const clampedTrail = Math.min(1, Math.max(clampedHp, trailHpFrac));
      if (clampedTrail > clampedHp + 0.005) {
        ctx.fillStyle = "rgba(255,242,165,0.88)";
        ctx.fillRect(bx, byHp, Math.round(bw * clampedTrail), bh);
      }
      ctx.fillStyle = hpFrac > 0.5 ? "#7ed957" : hpFrac > 0.25 ? "#f2c53c" : "#e2483a";
      ctx.fillRect(bx, byHp, Math.round(bw * clampedHp), bh);
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 4. 残像＆武器の多層斬撃エフェクト＆フローティング数値
// ---------------------------------------------------------------------------

export function drawAfterimages(
  ctx: CanvasRenderingContext2D,
  list: readonly Afterimage[],
  nowMs: number,
  toScreenX: (wx: number) => number,
  toScreenY: (wy: number) => number,
  lobbyOx: number,
  lobbyOy: number,
  inIndoor: boolean,
  TILE: number,
  avatarTex: HTMLImageElement | undefined,
  mobSprites: Readonly<Record<string, HTMLImageElement | undefined>>,
): void {
  if (list.length === 0) return;
  for (const item of list) {
    const alpha = afterimageAlpha(item, nowMs);
    if (alpha <= 0.01) continue;
    const sx = inIndoor ? Math.round(lobbyOx + item.x * TILE) : toScreenX(item.x);
    const sy = inIndoor ? Math.round(lobbyOy + item.y * TILE) : toScreenY(item.y);
    const size = TILE * (item.kind === "player_dash" ? 1.0 : Math.max(1, item.sizeTiles) * 0.94);

    ctx.save();
    ctx.globalAlpha = alpha;
    const sprite = item.mobId ? mobSprites[item.mobId] : avatarTex;
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      ctx.translate(sx, sy);
      ctx.scale(item.face, 1);
      if (item.kind === "player_dash") {
        ctx.drawImage(sprite, -size / 2, -size, size, size);
      } else {
        ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      }
    } else {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.ellipse(sx, item.kind === "player_dash" ? sy - size * 0.45 : sy, size * 0.34, size * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** 道具スイングの風切り追加表現（素材色・二重軌跡・先端の閃光星）。 */
export function drawWeaponSlashGlow(
  ctx: CanvasRenderingContext2D,
  sk: number,
  ang: number,
  whiff: boolean,
  itemId: string | null | undefined,
  alphaScale: number,
  TILE: number,
): void {
  if (whiff || alphaScale <= 0.02) return;
  const style = swingStyleFor(itemId, whiff);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  // 柔らかい帯状の光弧
  ctx.strokeStyle = style.glow;
  ctx.globalAlpha = alphaScale * 0.72;
  ctx.lineWidth = 7 * style.widthMul;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, 0, TILE * 0.80 * style.radiusMul, ang - 1.25, ang + 0.35);
  ctx.stroke();

  // 色つきの鋭い軌跡
  ctx.strokeStyle = style.primary;
  ctx.globalAlpha = alphaScale * 0.88;
  ctx.lineWidth = 2.6 * style.widthMul;
  ctx.beginPath();
  ctx.arc(0, 0, TILE * 0.84 * style.radiusMul, ang - 0.95, ang + 0.35);
  ctx.stroke();

  // 振り抜きピーク時の刃先キラメキ星
  if (style.hasGlint && sk >= 0.28 && sk <= 0.62) {
    const glintA = Math.sin(((sk - 0.28) / 0.34) * Math.PI);
    const tipR = TILE * 0.88 * style.radiusMul;
    const tx = Math.cos(ang + 0.28) * tipR;
    const ty = Math.sin(ang + 0.28) * tipR;
    ctx.translate(tx, ty);
    ctx.fillStyle = style.core;
    ctx.globalAlpha = glintA * 0.9;
    const arm = 7 * style.widthMul;
    ctx.fillRect(-arm, -1, arm * 2, 2);
    ctx.fillRect(-1, -arm, 2, arm * 2);
  }
  ctx.restore();
}

export function drawFloatingTexts(
  ctx: CanvasRenderingContext2D,
  items: readonly FloatingText[],
  nowMs: number,
  toScreenX: (wx: number) => number,
  toScreenY: (wy: number) => number,
  lobbyOx: number,
  lobbyOy: number,
  inIndoor: boolean,
  TILE: number,
  reducedMotion: boolean,
): void {
  if (items.length === 0) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const item of items) {
    const pose = floatingTextPose(item, nowMs, reducedMotion);
    if (pose.alpha <= 0.01) continue;
    const sx = (inIndoor ? lobbyOx + item.x * TILE : toScreenX(item.x)) + pose.dx * TILE;
    const sy = (inIndoor ? lobbyOy + item.y * TILE : toScreenY(item.y)) + pose.dy * TILE;
    const cols = floatingTextColors(item.kind);
    const fontSize = Math.round(13 * pose.scale);
    ctx.globalAlpha = pose.alpha;
    ctx.font = `800 ${fontSize}px sans-serif`;
    ctx.lineWidth = Math.max(2.5, Math.round(fontSize * 0.24));
    ctx.lineJoin = "round";
    ctx.strokeStyle = cols.stroke;
    ctx.strokeText(item.text, sx, sy);
    ctx.fillStyle = cols.fill;
    ctx.fillText(item.text, sx, sy);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 5. 水面きらめき・雨粒水紋・大気ティント・暖色光ブルーム・被弾ビネット
// ---------------------------------------------------------------------------

/** 水面のきらめき・雨の日の水たまり波紋（ワールド描画直後・粒の前）。 */
export function drawWorldEnvironmentalAccents(
  ctx: CanvasRenderingContext2D,
  opts: {
    tx0: number;
    tx1: number;
    ty0: number;
    ty1: number;
    isWaterTile: (tx: number, ty: number) => boolean;
    toScreenX: (wx: number) => number;
    toScreenY: (wy: number) => number;
    TILE: number;
    now: number;
    rainStrength: number;
    reducedMotion: boolean;
  },
): void {
  const { tx0, tx1, ty0, ty1, isWaterTile, toScreenX, toScreenY, TILE, now, rainStrength, reducedMotion } = opts;
  ctx.save();

  // 水面シマー: 見えている水タイルのうち決定的間引きで約1/4だけ描く（超軽量）
  ctx.fillStyle = "rgba(220,248,255,0.26)";
  const t = now * 0.0022;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (((tx * 73856093) ^ (ty * 19349663)) & 3) continue;
      if (!isWaterTile(tx, ty)) continue;
      const phase = t + tx * 0.9 + ty * 1.3;
      const alpha = 0.14 + 0.14 * Math.sin(phase);
      if (alpha <= 0.08) continue;
      ctx.globalAlpha = alpha;
      const sx = toScreenX(tx + 0.28 + 0.12 * Math.sin(phase * 0.7));
      const sy = toScreenY(ty + 0.45);
      ctx.fillRect(sx, sy, TILE * 0.34, 2);
    }
  }

  // 雨天時は見えている範囲に小さな着弾水紋を周期的に描く
  if (rainStrength > 0.25 && !reducedMotion) {
    const slot = Math.floor(now / 140);
    const spanX = Math.max(1, tx1 - tx0);
    const spanY = Math.max(1, ty1 - ty0);
    const n = Math.min(10, Math.round(8 * rainStrength));
    for (let i = 0; i < n; i++) {
      const idx = slot + i * 13;
      const frac = ((now % 140) + ((i * 37) % 140)) / 280;
      const k = frac % 1;
      const rx = tx0 + hash01(idx * 17) * spanX;
      const ry = ty0 + hash01(idx * 31) * spanY;
      ctx.globalAlpha = (1 - k) * 0.38 * rainStrength;
      ctx.strokeStyle = "#cdeeff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(toScreenX(rx), toScreenY(ry), TILE * (0.06 + 0.18 * k), TILE * (0.03 + 0.08 * k), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** 設置光源の暖色加算ブルーム＋朝焼け/夕焼け/雨の薄い大気色づけ。 */
export function drawLightingAndAtmosphere(
  ctx: CanvasRenderingContext2D,
  opts: {
    cw: number;
    ch: number;
    TILE: number;
    now: number;
    nowMs: number;
    phase: number;
    night: number;
    rainStrength: number;
    inWorld: boolean;
    inDarkInstance: boolean;
    lights: readonly { sx: number; sy: number; rTiles: number; itemId: string; seed: number }[];
    playerLight: { sx: number; sy: number; rTiles: number; itemId: string | null } | null;
  },
): void {
  const { cw, ch, TILE, nowMs, phase, night, rainStrength, inWorld, inDarkInstance, lights, playerLight } = opts;
  const tSec = nowMs / 1000;

  ctx.save();
  // 朝焼け・夕焼け・雨雲の大気ティント（ワールドのみ）
  if (inWorld) {
    const atmo = atmosphereTintFor(phase, rainStrength);
    if (atmo) {
      ctx.fillStyle = `rgba(${atmo.rgb},${atmo.alpha})`;
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  // 夜間または洞窟/ダンジョンの設置光源に暖かい加算ブルームを乗せる
  const lightMul = inDarkInstance ? 1 : night;
  if (lightMul > 0.15) {
    ctx.globalCompositeOperation = "lighter";
    const drawGlow = (sx: number, sy: number, rTiles: number, itemId: string, seed: number) => {
      const spec = placedLightGlowColor(itemId);
      if (!spec) return;
      const flick = torchLightFlicker(tSec, seed);
      const r = rTiles * TILE * 0.72 * flick;
      if (sx < -r || sy < -r || sx > cw + r || sy > ch + r) return;
      const a = spec.strength * lightMul * (0.9 + 0.1 * flick);
      const g = ctx.createRadialGradient(sx, sy, r * 0.08, sx, sy, r);
      g.addColorStop(0, `rgba(${spec.coreRgb},${a.toFixed(3)})`);
      g.addColorStop(0.5, `rgba(${spec.rgb},${(a * 0.45).toFixed(3)})`);
      g.addColorStop(1, `rgba(${spec.rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const l of lights) drawGlow(l.sx, l.sy, l.rTiles, l.itemId, l.seed);
    if (playerLight && playerLight.itemId) {
      drawGlow(playerLight.sx, playerLight.sy, playerLight.rTiles, playerLight.itemId, 7);
    }
  }
  ctx.restore();
}

/** プレイヤーの守護挑発オーラ・被弾赤フラッシュ・ロビー噴水きらめき。 */
export function drawPlayerAndSpaceOverlays(
  ctx: CanvasRenderingContext2D,
  opts: {
    cw: number;
    ch: number;
    playerScreenX: number;
    playerScreenY: number;
    TILE: number;
    now: number;
    hurtAt: number;
    tauntActive: boolean;
    reducedMotion: boolean;
  },
): void {
  const { cw, ch, playerScreenX, playerScreenY, TILE, now, hurtAt, tauntActive, reducedMotion } = opts;
  ctx.save();

  // 守護「挑発」中の黄金の護りオーラ
  if (tauntActive) {
    const pulse = 1 + Math.sin(now / 190) * 0.06;
    ctx.strokeStyle = "rgba(255,212,62,0.58)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.ellipse(playerScreenX, playerScreenY, TILE * 0.52 * pulse, TILE * 0.22 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 被弾時の赤い画面縁フラッシュ（短く収束）
  if (hurtAt > 0 && now - hurtAt < 360) {
    const k = 1 - (now - hurtAt) / 360;
    const maxA = (reducedMotion ? 0.14 : 0.26) * k;
    const g = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.25, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
    g.addColorStop(0, "rgba(220,30,40,0)");
    g.addColorStop(1, `rgba(220,30,40,${maxA.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  ctx.restore();
}
