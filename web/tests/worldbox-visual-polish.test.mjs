// AGO WORLD BOX 視覚演出ブラッシュアップの検証:
// - フローティング数値（生成・上限・寿命・軌道・reducedMotion・色分け）
// - 残像（上限・期限掃除・フェード）
// - 武器種ごとの斬撃スタイル（ミスリル/金/鉄/石・木/空振り）
// - 稲妻分岐・属性別予兆カラー・高度影・溜め震え・呼吸・大気ティント・設置光源ブルーム
// - 属性別追加パーティクルエミッタ & reducedMotion 対応
// - visual-render.ts / WorldBoxClient.tsx への全演出の配線
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

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

const vfx = await loadBundle(
  ["worldbox/fx.ts", "worldbox/visual-fx.ts"],
  [
    "createFxSystem", "emitFxParticle",
    "FLOATING_TEXT_CAP", "createFloatingTextSystem", "spawnFloatingText",
    "stepFloatingTexts", "floatingTextPose", "floatingTextColors",
    "AFTERIMAGE_CAP", "pushAfterimage", "pruneAfterimages", "afterimageAlpha",
    "swingStyleFor", "thunderBranches", "telegraphTintFor", "mobShadowScale",
    "telegraphTremble", "idleBreathScaleY", "atmosphereTintFor", "placedLightGlowColor",
    "spawnFireTrailFx", "spawnIceShatterFx", "spawnElectricSparkFx",
    "spawnHealMoteFx", "spawnPoisonBubbleFx", "spawnSlamDustFx",
  ],
);

test("visual-fx: emitFxParticle は cap と intensity を守る", () => {
  const sys = vfx.createFxSystem(1, 8);
  const sample = {
    x: 0, y: 0, vx: 1, vy: -1, age: 0, life: 1, size: 0.1,
    gravity: 0, drag: 1, rot: 0, vrot: 0, shape: "glow", color: "#fff",
  };
  for (let i = 0; i < 12; i++) {
    assert.equal(vfx.emitFxParticle(sys, { ...sample, x: i, age: Math.max(0, 0.5 - i * 0.04) }), true);
  }
  assert.equal(sys.particles.length, 8);
  assert.ok(sys.particles.every((p) => p.x >= 4), "古い粒から間引かれる");

  sys.intensity = 0;
  assert.equal(vfx.emitFxParticle(sys, sample), false);
});

test("visual-fx: フローティング数値の生成・上限・消滅・姿勢計算", () => {
  const sys = vfx.createFloatingTextSystem(6);
  for (let i = 0; i < 10; i++) {
    vfx.spawnFloatingText(sys, { x: i, y: 2, text: `${i}`, kind: i % 2 === 0 ? "crit" : "damage", nowMs: 1000 });
  }
  assert.equal(sys.items.length, 6, "指定上限を超えない");
  assert.equal(vfx.createFloatingTextSystem(1).cap, 4, "最小キャップは 4");

  const crit = vfx.spawnFloatingText(sys, { x: 5, y: 5, text: "24!", kind: "crit", nowMs: 2000 });
  const early = vfx.floatingTextPose(crit, 2080, false);
  const mid = vfx.floatingTextPose(crit, 2400, false);
  const end = vfx.floatingTextPose(crit, 2000 + crit.durationMs, false);
  assert.ok(early.dy < 0 && mid.dy < early.dy, "上へ浮かび上がる");
  assert.equal(early.alpha, 1);
  assert.equal(end.alpha, 0, "寿命終端で透明になる");

  const rm = vfx.floatingTextPose(crit, 2080, true);
  assert.equal(rm.dx, 0, "reducedMotion 時は横揺れなし");
  assert.equal(rm.scale, crit.scale, "reducedMotion 時はポップ拡縮なし");

  // 期限切れ掃除
  vfx.stepFloatingTexts(sys, 2000 + crit.durationMs + 50);
  assert.equal(sys.items.length, 0);

  // 6種別の色定義がすべて異なる
  const fills = new Set(
    ["damage", "crit", "player_hurt", "heal", "status", "pickup"].map((k) => vfx.floatingTextColors(k).fill),
  );
  assert.equal(fills.size, 6);
});

test("visual-fx: 残像システムの上限・掃除・不透明度減衰", () => {
  const list = [];
  for (let i = 0; i < vfx.AFTERIMAGE_CAP + 5; i++) {
    vfx.pushAfterimage(list, {
      x: i, y: 0, face: 1, sizeTiles: 1, mobId: null,
      kind: i === 0 ? "mob_teleport" : "player_dash",
      color: "#a8dcff", createdAt: 1000 + i * 20, durationMs: 200,
    });
  }
  assert.equal(list.length, vfx.AFTERIMAGE_CAP);

  const dash = {
    x: 0, y: 0, face: 1, sizeTiles: 1, mobId: null, kind: "player_dash",
    color: "#fff", createdAt: 1000, durationMs: 200,
  };
  const tele = { ...dash, kind: "mob_teleport" };
  assert.ok(vfx.afterimageAlpha(tele, 1000) > vfx.afterimageAlpha(dash, 1000));
  assert.ok(vfx.afterimageAlpha(dash, 1100) < vfx.afterimageAlpha(dash, 1000));
  assert.equal(vfx.afterimageAlpha(dash, 1200), 0);

  vfx.pruneAfterimages(list, 1320);
  assert.ok(list.length < vfx.AFTERIMAGE_CAP);
});

test("visual-fx: 武器・道具の素材別斬撃スタイル", () => {
  const whiff = vfx.swingStyleFor("mithril_sword", true);
  assert.equal(whiff.hasGlint, false, "空振りにはキラメキを出さない");
  assert.ok(whiff.widthMul < 1);

  const mithril = vfx.swingStyleFor("mithril_sword", false);
  const gold = vfx.swingStyleFor("gold_pickaxe", false);
  const iron = vfx.swingStyleFor("iron_axe", false);
  const wood = vfx.swingStyleFor("wood_sword", false);
  assert.equal(mithril.hasGlint, true);
  assert.equal(gold.hasGlint, true);
  assert.equal(iron.hasGlint, true);
  assert.equal(wood.hasGlint, false);
  assert.ok(mithril.widthMul > gold.widthMul && gold.widthMul > iron.widthMul && iron.widthMul > wood.widthMul);
  assert.notEqual(mithril.primary, gold.primary);
});

test("visual-fx: 稲妻分岐・予兆色・影スケール・震え・呼吸・大気ティント・光源ブルーム", () => {
  const b1 = vfx.thunderBranches(777, 10, 4, 10, 10);
  const b2 = vfx.thunderBranches(777, 10, 4, 10, 10);
  assert.deepEqual(b1, b2, "稲妻の枝分かれは決定的");
  assert.equal(b1.length, 3);
  for (const br of b1) assert.equal(br.length, 3);

  assert.notEqual(vfx.telegraphTintFor("breath_cone").accentHex, vfx.telegraphTintFor("shard_burst").accentHex);
  assert.notEqual(vfx.telegraphTintFor("web_shot").accentHex, vfx.telegraphTintFor("leaf_burst").accentHex);
  assert.notEqual(vfx.telegraphTintFor("slam").accentHex, vfx.telegraphTintFor("breath_cone").accentHex);

  assert.equal(vfx.mobShadowScale(0), 1);
  assert.ok(vfx.mobShadowScale(0.2) < 1);
  assert.equal(vfx.mobShadowScale(5), 0.48);

  assert.equal(vfx.telegraphTremble(0.3, 100, false), 0, "予兆前半は震えない");
  assert.equal(vfx.telegraphTremble(0.9, 100, true), 0, "reducedMotion 時は震えない");
  assert.notEqual(vfx.telegraphTremble(0.9, 120, false), 0);

  const breath = vfx.idleBreathScaleY(1000, 0.3);
  assert.ok(breath >= 0.98 && breath <= 1.02);

  assert.equal(vfx.atmosphereTintFor(0.5, 0), null, "晴天の真昼はティントなし");
  assert.ok(vfx.atmosphereTintFor(0.5, 0.8), "雨天の日中は雨雲ティント");
  assert.ok(vfx.atmosphereTintFor(0.24, 0), "朝焼けのピーク");
  assert.ok(vfx.atmosphereTintFor(0.77, 0), "夕焼けのピーク");

  for (const id of ["torch", "campfire", "lamp", "glowstone_block", "lava_block", "magma_block"]) {
    const g = vfx.placedLightGlowColor(id);
    assert.ok(g && g.strength > 0, `${id} にブルーム定義がある`);
  }
  assert.equal(vfx.placedLightGlowColor("wood_wall"), null);
});

test("visual-fx: 属性別追加パーティクルエミッタは粒を出し intensity=0 で抑制される", () => {
  const sys = vfx.createFxSystem(15);
  assert.ok(vfx.spawnFireTrailFx(sys, 1, 1, 4) > 0);
  assert.ok(vfx.spawnIceShatterFx(sys, 2, 2, 8) > 0);
  assert.ok(vfx.spawnElectricSparkFx(sys, 3, 3, 8) > 0);
  assert.ok(vfx.spawnHealMoteFx(sys, 4, 4, 6) > 0);
  assert.ok(vfx.spawnPoisonBubbleFx(sys, 5, 5, 6) > 0);
  assert.ok(vfx.spawnSlamDustFx(sys, 6, 6, 1.5) > 0);
  assert.ok(sys.particles.length > 0);

  const zero = vfx.createFxSystem(15);
  zero.intensity = 0;
  assert.equal(vfx.spawnFireTrailFx(zero, 1, 1, 4), 0);
  assert.equal(vfx.spawnIceShatterFx(zero, 2, 2, 8), 0);
  assert.equal(vfx.spawnElectricSparkFx(zero, 3, 3, 8), 0);
  assert.equal(vfx.spawnHealMoteFx(zero, 4, 4, 6), 0);
  assert.equal(vfx.spawnPoisonBubbleFx(zero, 5, 5, 6), 0);
  assert.equal(vfx.spawnSlamDustFx(zero, 6, 6, 1.5), 0);
});

test("visual-render & WorldBoxClient: 全視覚レンダラーと配線が揃っている", () => {
  const renderSrc = fs.readFileSync(path.join(libDir, "worldbox/visual-render.ts"), "utf8");
  for (const skill of [
    "heal_zone", "poison_field", "sweep", "whirlwind", "fireball",
    "ice_lance", "thunder_strike", "meteor", "arrow_rain", "taunt", "warp",
  ]) {
    assert.ok(renderSrc.includes(`case "${skill}"`), `drawSkillFxEnhanced に ${skill} が無い`);
  }

  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  for (const fn of [
    "drawParticleEnhanced",
    "drawSkillFxEnhanced",
    "drawMobTelegraphEnhanced",
    "drawMobProjectileEnhanced",
    "drawMobWebEnhanced",
    "drawFrozenPrism",
    "drawMobHudAndBadges",
    "drawAfterimages",
    "drawWeaponSlashGlow",
    "drawFloatingTexts",
    "drawWorldEnvironmentalAccents",
    "drawLightingAndAtmosphere",
    "drawPlayerAndSpaceOverlays",
    "telegraphSquashY",
    "telegraphTremble",
    "idleBreathScaleY",
    "mobShadowScale",
    "floatingEventsRef",
    "playerHurtAtRef",
  ]) {
    assert.ok(client.includes(fn), `WorldBoxClient.tsx に ${fn} が配線されていない`);
  }
});
