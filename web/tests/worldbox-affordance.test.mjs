// AGO WORLD BOX 感覚面 B2: アフォーダンスの検証:
// - 使える物の輪は鉱脈と同じ脈動（0.10〜0.60、金色）
// - 輪はフットプリント端から 2 タイル以内で出る（斜めも同じ）
// - 初回誘導バウンスは 900ms で収束し、輪は通常より強い
// - 無効操作は 260ms の赤い輪＋小刻みな揺れ（過ぎたら消える）
// - スティックのノブは掴んだら大きくなる
// - クライアント配線（施設の輪・無効フィードバック・押下感・初回誘導）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=(async\s+function))/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const af = await loadBundle(
  ["worldbox/affordance.ts"],
  [
    "AFFORDANCE_RANGE_TILES", "AFFORDANCE_PULSE_DIVISOR", "AFFORDANCE_NUDGE_MS",
    "DENIED_MS", "DENIED_ALPHA_MAX", "STICK_KNOB_RADIUS", "STICK_KNOB_RADIUS_ACTIVE",
    "AFFORDANCE_RING_RGB", "DENIED_RING_RGB",
    "affordancePulseAlpha", "isWithinAffordanceRange", "nudgeProgress",
    "nudgeBobPx", "nudgeRingAlpha", "deniedActive", "deniedFeedback", "stickKnobRadius",
  ],
);

test("affordance: 輪は 2 タイル以内で出る（斜めも同じ・遠いものには出ない）", () => {
  assert.equal(af.AFFORDANCE_RANGE_TILES, 2);
  // 1×1 の施設 (10, 10)。端からのチェビシェフ距離で測る
  assert.equal(af.isWithinAffordanceRange(10.5, 10.5, 10, 10, 1, 1), true);
  assert.equal(af.isWithinAffordanceRange(12.5, 10.5, 10, 10, 1, 1), true, "横 2 タイル");
  assert.equal(af.isWithinAffordanceRange(13.5, 10.5, 10, 10, 1, 1), false, "横 3 タイルは出ない");
  assert.equal(af.isWithinAffordanceRange(13, 13, 10, 10, 1, 1), true, "斜め 2 タイル");
  assert.equal(af.isWithinAffordanceRange(14, 14, 10, 10, 1, 1), false, "斜め 3 タイルは出ない");
  // 2×1 の施設 (10, 10, w=2, h=1): 本体はタイル 10・11、右端は 12
  assert.equal(af.isWithinAffordanceRange(13.5, 10.5, 10, 10, 2, 1), true, "幅のある施設の右 2 タイル");
  assert.equal(af.isWithinAffordanceRange(14.5, 10.5, 10, 10, 2, 1), false, "右 2.5 タイルは出ない");
});

test("affordance: 脈動は 0.10〜0.60（鉱脈と同じ周期・同じ色味の家族）", () => {
  assert.equal(af.AFFORDANCE_PULSE_DIVISOR, 240);
  assert.equal(af.AFFORDANCE_RING_RGB, "255,210,62");
  for (let t = 0; t < 3000; t += 37) {
    const a = af.affordancePulseAlpha(t);
    assert.ok(a >= 0.1 && a <= 0.6, `t=${t} alpha=${a}`);
  }
  // 1 周期（2π×240ms）で同じ値に戻る
  const period = Math.PI * 2 * 240;
  assert.ok(Math.abs(af.affordancePulseAlpha(100) - af.affordancePulseAlpha(100 + period)) < 1e-9);
});

test("affordance: 初回誘導バウンスは 900ms で収束する", () => {
  assert.equal(af.AFFORDANCE_NUDGE_MS, 900);
  assert.equal(af.nudgeProgress(-5), 0);
  assert.ok(af.nudgeProgress(450) > 0 && af.nudgeProgress(450) < 1);
  assert.equal(af.nudgeProgress(900), 1);
  assert.equal(af.nudgeProgress(5000), 1);
  assert.equal(af.nudgeBobPx(0), 0);
  assert.equal(af.nudgeBobPx(900), 0);
  assert.equal(af.nudgeBobPx(5000), 0);
  // 途中で跳ねる（上向き＝負のオフセット）
  let bobbed = false;
  for (let t = 50; t < 900; t += 50) if (af.nudgeBobPx(t) < -0.5) bobbed = true;
  assert.ok(bobbed, "誘導中は上に跳ねる");
  // 誘導中の輪は通常より強い
  assert.ok(af.nudgeRingAlpha(0, 0) > af.affordancePulseAlpha(0));
  assert.equal(af.nudgeRingAlpha(0, 900), af.affordancePulseAlpha(0));
  assert.ok(af.nudgeRingAlpha(0, 0) <= 0.85);
});

test("affordance: 無効操作は 260ms の赤い輪＋揺れ（過ぎたら消える）", () => {
  assert.equal(af.DENIED_MS, 260);
  assert.equal(af.DENIED_RING_RGB, "226,72,58");
  assert.equal(af.deniedActive(-1), false);
  assert.equal(af.deniedActive(0), true);
  assert.equal(af.deniedActive(259), true);
  assert.equal(af.deniedActive(260), false);
  assert.equal(af.deniedFeedback(260), null);
  assert.equal(af.deniedFeedback(5000), null);
  const start = af.deniedFeedback(0);
  assert.ok(start && Math.abs(start.alpha - af.DENIED_ALPHA_MAX) < 1e-9, "開始時は最大の赤");
  const mid = af.deniedFeedback(130);
  assert.ok(mid && mid.alpha > 0 && mid.alpha < af.DENIED_ALPHA_MAX, "半ばで薄くなる");
  assert.ok(Math.abs(mid.dx) <= 2.5, "揺れは振幅以内");
  let shook = false;
  for (let t = 10; t < 260; t += 10) {
    const f = af.deniedFeedback(t);
    if (f && Math.abs(f.dx) > 0.3) shook = true;
  }
  assert.ok(shook, "揺れが実際に出る");
});

test("affordance: スティックのノブは掴んだら大きくなる", () => {
  assert.equal(af.STICK_KNOB_RADIUS, 22);
  assert.ok(af.STICK_KNOB_RADIUS_ACTIVE > af.STICK_KNOB_RADIUS);
  assert.equal(af.stickKnobRadius(false), af.STICK_KNOB_RADIUS);
  assert.equal(af.stickKnobRadius(true), af.STICK_KNOB_RADIUS_ACTIVE);
});

const clientSrc = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
  "utf8",
);

test("affordance: クライアントが近くの施設・宝箱・扉に輪を出す", () => {
  assert.ok(clientSrc.includes("affordancePulseAlpha") || clientSrc.includes("nudgeRingAlpha"), "脈動する輪を描く");
  assert.ok(clientSrc.includes("isWithinAffordanceRange"), "範囲判定を使う");
  assert.ok(clientSrc.includes("AFFORDANCE_RING_RGB"), "輪は金色");
  assert.ok(clientSrc.includes("station"), "施設が対象");
});

test("affordance: クライアントが無効操作に赤い輪＋揺れ＋ error SE を出す", () => {
  assert.ok(clientSrc.includes("deniedFeedback"), "無効フィードバックを描く");
  assert.ok(clientSrc.includes("DENIED_RING_RGB"), "無効の輪は赤");
  assert.ok(clientSrc.includes('playWbSe("error")'), "無効時に error SE");
});

test("affordance: クライアントに押下感（ボタン・スティック・チップ）がある", () => {
  assert.ok(clientSrc.includes("stickKnobRadius"), "スティックのノブが掴んだら大きくなる");
  const css = fs.readFileSync(path.join(rootDir, "app/globals.css"), "utf8");
  assert.ok(css.includes(".wb-shell button:active"), "ボタン押下で縮む");
  assert.ok(css.includes("wb-chip-pop") || clientSrc.includes("wb-chip-pop"), "施設チップが出現時にポップする");
});

test("affordance: 初回だけ誘導バウンスが出る（見た施設は覚える）", () => {
  assert.ok(clientSrc.includes("nudgeBobPx"), "誘導バウンスを描く");
  assert.ok(clientSrc.includes("seenAffordance") || clientSrc.includes("affordanceSeen"), "見た施設を覚える");
});
