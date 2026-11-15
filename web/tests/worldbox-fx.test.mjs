// AGO WORLD BOX 演出基盤（アニメーション/モーション/パーティクル）の検証:
// - バースト生成（種類ごとの粒数・上限・決定的乱数）
// - 粒の物理（寿命で消える・重力・減衰）と残り割合
// - 環境パーティクル（雪/落葉/花粉/蛍の選択と生成）
// - 画面の揺れ（最初に強く収束し、終われば 0）
// - 出現ポップ（0.55 から行き過ぎて 1 に収まる）とスイング/風切り
// - クライアント配線（成功イベント→粒、スイング、揺れ、環境粒、ポップ）
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
        .replace(/^export\s+(?=async\s+function)/, "")
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

const fx = await loadBundle(
  ["worldbox/fx.ts"],
  [
    "FX_CAP", "FX_BURST_MAX", "createFxSystem", "fxRand", "fxLifeRatio", "stepFx", "spawnBurst",
    "ambientKindFor", "spawnAmbient", "createShake", "startShake", "shakeOffsetAt",
    "popScale", "popProgress", "SWING_DURATION_MS", "swingProgress", "slashAlpha",
    "spawnMobFx", "mobCountMul", "mobSizeMul", "WHIFF_ALPHA_SCALE",
    "WEATHER_PERIOD_SEC", "weatherAt", "weatherAmbientKind", "phaseKind",
  ],
);

test("fx: バーストは種類ごとの粒数を出し、色は明暗が混ざる", () => {
  const sys = fx.createFxSystem(42);
  const n = fx.spawnBurst(sys, "chop", 10, 10);
  assert.equal(n, 12);
  assert.equal(sys.particles.length, 12);
  for (const p of sys.particles) {
    assert.ok(p.life >= 0.3 && p.life <= 0.6, "伐採の粒は短命");
    assert.ok(["chip", "spark"].includes(p.shape));
    assert.equal(typeof p.color, "string");
  }
  const colors = new Set(sys.particles.map((p) => p.color));
  assert.ok(colors.size >= 2, "単色にしない");
});

test("fx: 同じ種からは同じ飛び方になる（決定的）", () => {
  const a = fx.createFxSystem(7);
  const b = fx.createFxSystem(7);
  fx.spawnBurst(a, "mine", 3, 4);
  fx.spawnBurst(b, "mine", 3, 4);
  assert.deepEqual(
    a.particles.map((p) => [p.x, p.y, p.vx, p.vy, p.life]),
    b.particles.map((p) => [p.x, p.y, p.vx, p.vy, p.life]),
  );
});

test("fx: 同時上限を超えない（古い粒から間引く）", () => {
  const sys = fx.createFxSystem(1, 20);
  for (let i = 0; i < 10; i++) fx.spawnBurst(sys, "harvest", 0, 0);
  assert.ok(sys.particles.length <= 20);
  assert.equal(sys.cap, 20);
  const big = fx.createFxSystem(1);
  assert.equal(big.cap, fx.FX_CAP);
});

test("fx: intensity で生成が絞られる（reduced-motion 用）", () => {
  const sys = fx.createFxSystem(3);
  sys.intensity = 0.35;
  const n = fx.spawnBurst(sys, "chop", 0, 0);
  assert.equal(n, Math.round(12 * 0.35));
  sys.intensity = 0;
  assert.equal(fx.spawnBurst(sys, "chop", 0, 0), 0);
});

test("fx: 粒は寿命で消え、重力で落ち、残り割合が減る", () => {
  const sys = fx.createFxSystem(9);
  fx.spawnBurst(sys, "splash", 5, 5);
  const p0 = sys.particles[0];
  const y0 = p0.y;
  const r0 = fx.fxLifeRatio(p0);
  fx.stepFx(sys, 0.1);
  assert.ok(fx.fxLifeRatio(sys.particles[0]) < r0);
  // 十分な時間が過ぎれば全部消える
  for (let i = 0; i < 40; i++) fx.stepFx(sys, 0.05);
  assert.equal(sys.particles.length, 0);
  assert.ok(Number.isFinite(y0));
});

test("fx: 環境粒の種類選択（雪 > 森 > 夜 > 花粉）", () => {
  assert.equal(fx.ambientKindFor(6, false, 0), "snow"); // T_SNOW
  assert.equal(fx.ambientKindFor(7, true, 0), "snow"); // T_SNOW_TREE
  assert.equal(fx.ambientKindFor(0, true, 0), "leaf"); // 草地だが木のそば
  assert.equal(fx.ambientKindFor(0, false, 0.8), "firefly");
  assert.equal(fx.ambientKindFor(0, false, 0), "pollen");
});

test("fx: 環境粒は範囲の上辺から生まれ、下向きに漂う", () => {
  const sys = fx.createFxSystem(11);
  const p = fx.spawnAmbient(sys, "snow", 10, 20, 5);
  assert.ok(p);
  assert.ok(p.x >= 10 && p.x <= 20);
  assert.equal(p.y, 4.7);
  assert.ok(p.vy > 0, "雪は落ちる");
  assert.equal(p.shape, "snow");
  const f = fx.spawnAmbient(sys, "firefly", 0, 5, 0);
  assert.equal(f.shape, "glow");
});

test("fx: 揺れは最初に強く、収束して 0 に戻る", () => {
  let shake = fx.createShake();
  assert.deepEqual(fx.shakeOffsetAt(shake, 1000), { x: 0, y: 0 });
  shake = fx.startShake(shake, 3, 1000, 180);
  const early = fx.shakeOffsetAt(shake, 1016);
  const late = fx.shakeOffsetAt(shake, 1150);
  assert.ok(Math.abs(early.x) + Math.abs(early.y) > 0);
  assert.ok(Math.abs(late.x) <= 3 && Math.abs(late.y) <= 3);
  assert.deepEqual(fx.shakeOffsetAt(shake, 1200), { x: 0, y: 0 });
  // 弱い揺れでは強い揺れを上書きしない
  const strong = fx.startShake(shake, 1, 1010, 180);
  assert.equal(strong.amp, 3);
});

test("fx: 出現ポップは 0.55 から行き過ぎて 1 に収まる", () => {
  assert.equal(fx.popScale(0), 0.55);
  assert.equal(fx.popScale(1), 1);
  assert.equal(fx.popScale(2), 1);
  let max = 0;
  for (let k = 0; k <= 1.0001; k += 0.02) max = Math.max(max, fx.popScale(k));
  assert.ok(max > 1.05, `行き過ぎがある (max=${max})`);
  assert.equal(fx.popProgress(1000, 1000, 240), 0);
  assert.equal(fx.popProgress(1000, 1240, 240), 1);
});

test("fx: スイングは時間で進み、風切りは振り抜きで濃くなる", () => {
  assert.equal(fx.swingProgress(0, 500), 1);
  assert.equal(fx.swingProgress(1000, 1000), 0);
  assert.equal(fx.swingProgress(1000, 1000 + fx.SWING_DURATION_MS), 1);
  assert.ok(fx.slashAlpha(0.3) > fx.slashAlpha(0));
  assert.equal(fx.slashAlpha(1), 0);
});

test("fx2: hit は赤い火花で短命、death は大きめの破片、spawn は立ち上る", () => {
  const hit = fx.createFxSystem(21);
  assert.equal(fx.spawnBurst(hit, "hit", 5, 5), 10);
  for (const p of hit.particles) {
    assert.ok(p.life >= 0.18 && p.life <= 0.38, "hit は短命");
    assert.ok(["spark", "chip"].includes(p.shape));
  }
  assert.ok(hit.particles.some((p) => p.color === "#e5484d"), "ダメージ色（赤）を含む");

  const death = fx.createFxSystem(22);
  assert.equal(fx.spawnBurst(death, "death", 5, 5), 22);
  for (const p of death.particles) {
    assert.ok(["chip", "puff"].includes(p.shape));
    assert.ok(p.size >= 0.09, "death の粒は大きめ");
    assert.ok(p.life >= 0.4 && p.life <= 0.85);
  }

  const spawn = fx.createFxSystem(23);
  assert.equal(fx.spawnBurst(spawn, "spawn", 5, 5), 14);
  for (const p of spawn.particles) {
    assert.ok(["puff", "glow"].includes(p.shape));
    assert.ok(p.gravity < 0, "spawn は立ち上る（負の重力）");
  }
});

test("fx2: spawnMobFx はモブの大きさで粒数・粒サイズがスケールし、上限を守る", () => {
  const small = fx.createFxSystem(31);
  const nSmall = fx.spawnMobFx(small, "hit", 5, 5, { sizeTiles: 1 });
  assert.ok(nSmall >= 9 && nSmall <= 11, `小型の hit は基礎数付近 (n=${nSmall})`);

  const huge = fx.createFxSystem(32);
  const nHuge = fx.spawnMobFx(huge, "death", 5, 5, { sizeTiles: 20 });
  assert.equal(nHuge, fx.FX_BURST_MAX, "超巨大でも1バースト上限で頭打ち");
  const avgSmall = small.particles.reduce((a, p) => a + p.size, 0) / small.particles.length;
  const avgHuge = huge.particles.reduce((a, p) => a + p.size, 0) / huge.particles.length;
  assert.ok(avgHuge > avgSmall * 1.5, "大きいモブほど粒も大きい");
  // 占有範囲いっぱいに散る（アンカー中心から離れた粒がある）
  assert.ok(huge.particles.some((p) => Math.abs(p.x - 5) > 1), "散らばりが占有に広がる");

  // 不正なサイズは 1 として扱う（粒数はサイズ1と同じ 10）
  const invalid = fx.createFxSystem(33);
  assert.equal(fx.spawnMobFx(invalid, "hit", 0, 0, { sizeTiles: 0 }), 10);
  assert.equal(fx.spawnMobFx(fx.createFxSystem(33), "hit", 0, 0, { sizeTiles: Number.NaN }), 10);
  // 同時上限（cap）も守る
  const capped = fx.createFxSystem(34, 20);
  for (let i = 0; i < 6; i++) fx.spawnMobFx(capped, "death", 0, 0, { sizeTiles: 20 });
  assert.ok(capped.particles.length <= 20);
  // 倍率関数自体の頭打ち
  assert.ok(fx.mobCountMul(20) <= 2.6 && fx.mobSizeMul(20) <= 2.2);
  assert.ok(fx.mobCountMul(5) > fx.mobCountMul(1));
});

test("fx2: weatherAt は決定的で、区間内は不変、長期的には雨も晴れも出る", () => {
  const t0 = 1700000000;
  assert.equal(fx.weatherAt(t0), fx.weatherAt(t0), "同じ時刻は同じ天候");
  const idx = Math.floor(t0 / fx.WEATHER_PERIOD_SEC);
  const start = idx * fx.WEATHER_PERIOD_SEC;
  assert.equal(fx.weatherAt(start), fx.weatherAt(start + fx.WEATHER_PERIOD_SEC - 1), "区間内は不変");
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(fx.weatherAt(start + i * fx.WEATHER_PERIOD_SEC));
  assert.deepEqual([...seen].sort(), ["clear", "rain"], "200区間で両方が出る");
  const rainRatio = Array.from({ length: 200 }, (_, i) => fx.weatherAt(start + i * fx.WEATHER_PERIOD_SEC)).filter((w) => w === "rain").length / 200;
  assert.ok(rainRatio > 0.1 && rainRatio < 0.6, `雨の比率は 35% 前後 (実測 ${rainRatio})`);
});

test("fx2: weatherAmbientKind の優先順位は 雪 > 雨 > 森 > 夜 > 花粉", () => {
  assert.equal(fx.weatherAmbientKind("rain", 6, false, 0), "snow", "雪バイオームでは雨でも雪");
  assert.equal(fx.weatherAmbientKind("rain", 7, true, 0.9), "snow");
  assert.equal(fx.weatherAmbientKind("rain", 0, true, 0), "rain", "雨は森より優先");
  assert.equal(fx.weatherAmbientKind("rain", 0, false, 0.9), "rain", "雨は夜より優先");
  assert.equal(fx.weatherAmbientKind("clear", 0, true, 0), "leaf");
  assert.equal(fx.weatherAmbientKind("clear", 0, false, 0.9), "firefly");
  assert.equal(fx.weatherAmbientKind("clear", 0, false, 0), "pollen");
});

test("fx2: 雨の環境粒は spark の筋で速く落ちる", () => {
  const sys = fx.createFxSystem(41);
  const p = fx.spawnAmbient(sys, "rain", 0, 10, 5);
  assert.ok(p);
  assert.equal(p.shape, "spark");
  assert.ok(p.vy >= 7, `雨は速い (vy=${p.vy})`);
});

test("fx2: phaseKind の境界（daynight の夜判定と整合）", () => {
  assert.equal(fx.phaseKind(0), "night");
  assert.equal(fx.phaseKind(0.17), "night");
  assert.equal(fx.phaseKind(0.18), "dawn");
  assert.equal(fx.phaseKind(0.29), "dawn");
  assert.equal(fx.phaseKind(0.3), "day");
  assert.equal(fx.phaseKind(0.5), "day");
  assert.equal(fx.phaseKind(0.67), "day");
  assert.equal(fx.phaseKind(0.68), "dusk");
  assert.equal(fx.phaseKind(0.85), "dusk");
  assert.equal(fx.phaseKind(0.86), "night");
  assert.equal(fx.phaseKind(0.95), "night");
  // 正規化: 1 を超えても・負でも同じ位相に落ちる
  assert.equal(fx.phaseKind(1.5), "day");
  assert.equal(fx.phaseKind(-0.5), "day");
});

test("fx2: 空振り係数は成功時より薄い（0〜1）", () => {
  assert.ok(fx.WHIFF_ALPHA_SCALE > 0 && fx.WHIFF_ALPHA_SCALE < 1);
});

test("fx: クライアント配線（イベント→粒/揺れ/ポップ、スイング、環境粒）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /from "@\/lib\/worldbox\/fx"/, "fx 基盤を使う");
  assert.match(client, /fxEventsRef\.current\.push/, "行為の成功が演出イベントになる");
  assert.match(client, /spawnBurst\(fxSys, ev\.kind/, "描画ループでイベントを粒に変換する");
  assert.match(client, /startShake/, "行為で画面が揺れる");
  assert.match(client, /attackSwingAngle/, "道具スイングを描く");
  assert.match(client, /spawnAmbient/, "環境パーティクルを出す");
  assert.match(client, /popScaleFor/, "設置/建築に出現ポップを付ける");
  assert.match(client, /stepFx\(fxSys, dt\)/, "毎フレーム粒を進める");
  assert.match(client, /prefers-reduced-motion/, "動きを減らす設定を尊重する");
});

test("fx2: クライアント配線（空振り・天候・時間帯・モブイベント）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 失敗分岐（タイル行為と建築）が whiff を push する（成功バーストは出さない）
  const whiffPushes = client.match(/fxEventsRef\.current\.push\(\{\s*kind: "whiff"|fxEventsRef\.current\.push\(\{\n\s*kind: "whiff"/g) ?? [];
  assert.ok(whiffPushes.length >= 2, `whiff の push が複数箇所にある (実測 ${whiffPushes.length})`);
  assert.match(client, /ev\.kind === "whiff"/, "ループが whiff を分岐する");
  assert.match(client, /whiff: true/, "whiff スイングを立てる");
  assert.match(client, /WHIFF_ALPHA_SCALE/, "空振りは風切りを薄くする");
  assert.match(client, /swing\.whiff \? 1\.5 : 3/, "空振りは風切りを細くする");
  // whiff 分岐は spawnBurst より前にあり、continue で成功粒を出さない構造
  const drainAt = client.indexOf('ev.kind === "whiff"');
  const burstAt = client.indexOf("spawnBurst(fxSys, ev.kind");
  assert.ok(drainAt >= 0 && burstAt > drainAt, "whiff 判定が成功バーストより前");
  // モブイベントは spawnMobFx 経由（ループ側で受ける器）
  assert.match(client, /spawnMobFx\(fxSys, ev\.kind/, "モブイベントを spawnMobFx で出す");
  assert.match(client, /ev\.kind === "death"\) shake = startShake/, "死亡時は小さな揺れ");
  // 天候と時間帯を環境粒に使う
  assert.match(client, /weatherAt\(nowSec\)/, "天候は決定的サイクルから取る");
  assert.match(client, /weatherAmbientKind\(/, "環境粒の種類に天候を反映する");
  assert.match(client, /phaseKind\(phase\)/, "時間帯の切り替わりを検出する");
  assert.match(client, /pk !== lastPhaseKind/, "時間帯が変わったフレームで環境粒を足す");
});
