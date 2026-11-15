// AGO WORLD BOX モーションの検証:
// - anim.ts の曲線（歩行位相・スイング・バネ・ゆらぎ・マグネット・ポーズ）が純粋関数として正しい
// - クライアントがそれらを実際に使っている（ソースチェック）
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

const anim = await loadBundle(
  ["worldbox/anim.ts"],
  [
    "advanceWalkPhase", "stepBeatIndex", "walkBob", "walkSquashY", "moveLean",
    "airPose", "springStep", "landingSquashY",
    "SWING_WINDUP", "SWING_STRIKE", "ARM_REST_ANGLE", "digSwingAngle", "attackSwingAngle",
    "flickerNoise", "torchFlameScale", "torchLightFlicker",
    "magnetStep", "poofPose", "flipDeathPose", "respawnPose",
    "advanceEnemyPhase", "enemyRock", "telegraphSquashY", "damp",
  ],
);

test("歩行位相は速さに比例して単調に進み、静止では進まない", () => {
  const dt = 1 / 60;
  const slow = anim.advanceWalkPhase(0, 2, dt);
  const fast = anim.advanceWalkPhase(0, 6, dt);
  assert.ok(fast > slow && slow > 0, "速いほど位相が進む");
  assert.ok(Math.abs(fast - slow * 3) < 1e-9, "進みは速さに比例する");
  assert.equal(anim.advanceWalkPhase(1.5, 0, dt), 1.5, "静止では進まない");
  assert.equal(anim.advanceWalkPhase(1.5, -6, dt), anim.advanceWalkPhase(1.5, 6, dt), "向きでなく速さで進む");
});

test("歩行の拍（土煙のトリガー）は位相の進行で切り替わる", () => {
  assert.equal(anim.stepBeatIndex(0), 0);
  assert.equal(anim.stepBeatIndex(Math.PI - 0.01), 0);
  assert.equal(anim.stepBeatIndex(Math.PI + 0.01), 1);
  let beats = 0;
  let prev = anim.stepBeatIndex(0);
  for (let p = 0; p < Math.PI * 6; p += 0.05) {
    const b = anim.stepBeatIndex(p);
    if (b !== prev) beats++;
    prev = b;
  }
  assert.equal(beats, 5, "3周期で拍が5回切り替わる");
});

test("歩行の上下動と潰れは範囲内に収まる", () => {
  for (let p = 0; p < Math.PI * 4; p += 0.1) {
    const bob = anim.walkBob(p);
    assert.ok(bob >= 0 && bob <= 1, `bob ${bob}`);
    const sq = anim.walkSquashY(p);
    assert.ok(sq >= 0.94 && sq <= 1, `squash ${sq}`);
  }
});

test("前傾は速度比に比例し ±0.09 ラジアンで頭打ち", () => {
  assert.equal(anim.moveLean(0), 0);
  assert.ok(anim.moveLean(1) > 0 && anim.moveLean(1) <= 0.09);
  assert.ok(anim.moveLean(-1) < 0 && anim.moveLean(-1) >= -0.09);
  assert.equal(anim.moveLean(5), anim.moveLean(1), "クランプされる");
});

test("空中の伸び: 上昇は最大 1.07、落下は最大 1.11 で頭打ち", () => {
  const rise = anim.airPose(-12, 1);
  assert.ok(rise.scaleY > 1 && rise.scaleY <= 1.07, `上昇 ${rise.scaleY}`);
  const riseMax = anim.airPose(-30, 1);
  assert.ok(riseMax.scaleY <= 1.07, `上昇上限 ${riseMax.scaleY}`);
  const fall = anim.airPose(19, 1);
  assert.ok(fall.scaleY > rise.scaleY && fall.scaleY <= 1.11, `落下 ${fall.scaleY}`);
  const fallMax = anim.airPose(60, 1);
  assert.ok(fallMax.scaleY <= 1.11, `落下上限 ${fallMax.scaleY}`);
  assert.equal(anim.airPose(0, 0).scaleY, 1, "頂点では等倍");
  assert.ok(anim.airPose(19, 1).tilt > 0, "落下中は前進方向へ傾く");
  assert.equal(anim.airPose(19, 0).tilt, 0, "水平移動なしでは傾かない");
});

test("バネは着地の潰れ 0.84 から 1 に収束する", () => {
  let s = { x: 0.84, v: 0 };
  for (let i = 0; i < 240; i++) s = anim.springStep(s, 1, 190, 14, 1 / 60);
  assert.ok(Math.abs(s.x - 1) < 0.01, `収束後の値 ${s.x}`);
  let d = { x: 0.2, v: 0 };
  for (let i = 0; i < 240; i++) d = anim.springStep(d, 0, 130, 10, 1 / 60);
  assert.ok(Math.abs(d.x) < 0.01, `沈みバネも 0 に収束 ${d.x}`);
  const still = anim.springStep({ x: 0.5, v: 0 }, 1, 190, 14, 0);
  assert.equal(still.x, 0.5, "dt=0 では動かない");
});

test("着地の潰れは落下距離で深くなり 0.84 で頭打ち", () => {
  assert.equal(anim.landingSquashY(0), 1);
  assert.equal(anim.landingSquashY(0.4), 1, "小さな落下では潰れない");
  assert.ok(anim.landingSquashY(8) <= 0.86, `大きな落下 ${anim.landingSquashY(8)}`);
  assert.equal(anim.landingSquashY(100), 0.84, "下限は 0.84");
});

test("掘りスイングはヒビ段階の境界ごとに振り抜き角へ到達し、振りかぶりへ戻る", () => {
  assert.equal(anim.digSwingAngle(0), anim.SWING_WINDUP, "開始は振りかぶり");
  for (let k = 1; k <= 4; k++) {
    const justBefore = anim.digSwingAngle(k / 4 - 1e-4);
    assert.ok(Math.abs(justBefore - anim.SWING_STRIKE) < 0.02, `段階 ${k} の境界直前 ${justBefore}`);
    if (k < 4) {
      const atBoundary = anim.digSwingAngle(k / 4);
      assert.ok(atBoundary < justBefore - 1, `段階 ${k} の境界で次の振りかぶりへ戻る`);
    }
  }
  // 区間内は単調に振り抜き側へ進む
  let prev = -Infinity;
  for (let p = 0.02; p < 0.24; p += 0.02) {
    const a = anim.digSwingAngle(p);
    assert.ok(a >= prev, "区間内は単調");
    prev = a;
  }
});

test("攻撃スイングは 構え→振りかぶり→振り抜き→構え のキーフレームを通る", () => {
  assert.equal(anim.attackSwingAngle(0), anim.ARM_REST_ANGLE);
  assert.ok(Math.abs(anim.attackSwingAngle(0.3) - anim.SWING_WINDUP) < 1e-9);
  assert.ok(Math.abs(anim.attackSwingAngle(0.55) - anim.SWING_STRIKE) < 1e-9);
  assert.ok(Math.abs(anim.attackSwingAngle(1) - anim.ARM_REST_ANGLE) < 1e-9);
});

test("ゆらぎは決定的で、炎は 0.88〜1.12、光は ±5% に収まる", () => {
  for (let t = 0; t < 20; t += 0.13) {
    for (const seed of [0, 1.7, 42.3]) {
      const n = anim.flickerNoise(t, seed);
      assert.ok(n >= 0 && n <= 1, `noise ${n}`);
      const f = anim.torchFlameScale(t, seed);
      assert.ok(f >= 0.88 && f <= 1.12, `flame ${f}`);
      const l = anim.torchLightFlicker(t, seed);
      assert.ok(l >= 0.95 && l <= 1.05, `light ${l}`);
    }
  }
  assert.equal(anim.flickerNoise(3.3, 7), anim.flickerNoise(3.3, 7), "同じ入力では同じ値（決定的）");
});

test("マグネットは目標へ近づき、行き過ぎない", () => {
  const far = anim.magnetStep(0, 0, 3, 4, 1); // 距離5を1だけ進む
  assert.ok(Math.abs(far.dist - 4) < 1e-9);
  assert.ok(Math.abs(Math.hypot(far.x, far.y) - 1) < 1e-9);
  const reach = anim.magnetStep(0, 0, 0.3, 0.4, 1); // 距離0.5 < ステップ1 → ちょうど届く
  assert.equal(reach.x, 0.3);
  assert.equal(reach.y, 0.4);
  assert.equal(reach.dist, 0);
  const same = anim.magnetStep(1, 1, 1, 1, 1);
  assert.equal(same.dist, 0);
});

test("ポフ・フリップ・復活のポーズの端点", () => {
  assert.deepEqual(anim.poofPose(0), { scale: 1, alpha: 1 });
  assert.equal(anim.poofPose(1).alpha, 0);
  assert.ok(anim.poofPose(1).scale > 1.6, "ポフは膨らむ");
  assert.equal(anim.flipDeathPose(0).rot, 0);
  assert.ok(Math.abs(anim.flipDeathPose(1).rot - Math.PI) < 1e-9, "倒れ込みは半回転");
  assert.equal(anim.flipDeathPose(1).alpha, 0);
  assert.equal(anim.respawnPose(0).scale, 0.65);
  assert.equal(anim.respawnPose(0).alpha, 0);
  assert.equal(anim.respawnPose(1).scale, 1);
  assert.equal(anim.respawnPose(1).alpha, 1);
});

test("敵の揺れは ±0.07 ラジアン以内で、静止では揺れない。溜めは 0.78 まで潰れる", () => {
  for (let p = 0; p < Math.PI * 4; p += 0.1) {
    const r = anim.enemyRock(1.7, p);
    assert.ok(Math.abs(r) <= 0.07 + 1e-9, `rock ${r}`);
  }
  assert.equal(anim.enemyRock(0, 1.2), 0);
  assert.equal(anim.telegraphSquashY(0), 1);
  assert.ok(Math.abs(anim.telegraphSquashY(1) - 0.78) < 1e-9);
  assert.ok(anim.advanceEnemyPhase(0, 1.7, 0.5) > anim.advanceEnemyPhase(0, 0.8, 0.5));
});

test("damp は目標へ指数的に寄る（カメラ追従）", () => {
  let v = 0;
  for (let i = 0; i < 120; i++) v = anim.damp(v, 10, 7, 1 / 60);
  assert.ok(Math.abs(v - 10) < 0.1, `収束 ${v}`);
  assert.equal(anim.damp(3, 10, 7, 0), 3, "dt=0 では動かない");
});

const clientSrc = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
  "utf8",
);

test("クライアントは anim の曲線を実際に使っている", () => {
  assert.ok(clientSrc.includes('from "@/lib/worldbox/anim"'), "anim を import している");
  for (const name of [
    "advanceWalkPhase(", "stepBeatIndex(", "walkSquashY(", "walkBob(", "moveLean(", "airPose(",
    "springStep(", "landingSquashY(", "digSwingAngle(", "attackSwingAngle(", "ARM_REST_ANGLE",
    "torchFlameScale(", "torchLightFlicker(", "flickerNoise(", "magnetStep(", "damp(",
    "poofPose(", "flipDeathPose(", "respawnPose(", "advanceEnemyPhase(", "enemyRock(", "telegraphSquashY(",
  ]) {
    assert.ok(clientSrc.includes(name), `${name} を使っている`);
  }
});

test("クライアントにモーションの配線がある（土煙・雲・手持ち・カメラ）", () => {
  for (const marker of [
    "spawnDust", // 歩行・着地の土煙
    "drawClouds(", // 流れる雲
    "drawHeldItem(", // 手持ちアイテムの描画
    "hurtAtRef", // 被弾フラッシュ
    "deathFxRef", // 死亡ポフ
    "dyingRef", // 敵の倒れ込み
    "enemyBrainRef", // 敵の溜め/突進
    "landFxRef", // 着地の記録
    "attackAtRef", // 攻撃スイング
    "breakAtRef", // 破砕の反動
  ]) {
    assert.ok(clientSrc.includes(marker), `${marker} がある`);
  }
  // 公式あごむに画像の描画（足元アンカー）は維持する
  assert.ok(clientSrc.includes("drawImage(img, -size / 2, -size, size, size)"), "プレイヤー画像の描画が残っている");
});
