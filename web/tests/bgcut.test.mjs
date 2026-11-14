// 背景透過（Web 一時リンク版）の純粋ロジックとトークン検証を確かめる。
// lib/bgcut-core.ts（寸法・上限・α後処理・単色検出・ラダー）と
// lib/bgcut-token.ts（Bot が署名したトークンの検証。ID の精度が要）を、
// 既存テストと同じ流儀で TS のまま読み込んで検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

async function loadTs(rel) {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const core = await loadTs("lib/bgcut-core.ts");
const tokenLib = await loadTs("lib/bgcut-token.ts");

// ----------------------------------------------------------- core: 寸法と上限

test("fitWithin はアスペクトを保ち拡大しない", () => {
  assert.deepEqual(core.fitWithin(800, 600, 512), { width: 512, height: 384 });
  assert.deepEqual(core.fitWithin(100, 50, 512), { width: 100, height: 50 });
  assert.deepEqual(core.fitWithin(200, 200, 128), { width: 128, height: 128 });
});

test("stickerPlacement は 320 キャンバスへ歪ませず中央配置する", () => {
  const wide = core.stickerPlacement(640, 160);
  assert.equal(wide.width, 320);
  assert.equal(wide.height, 80);
  assert.equal(wide.x, 0);
  assert.equal(wide.y, 120);
  const tall = core.stickerPlacement(160, 640);
  assert.equal(tall.width, 80);
  assert.equal(tall.x, 120);
});

test("inputGuardError は 25MB と 6000 万画素を弾く", () => {
  assert.equal(core.inputGuardError({ bytes: 100, width: 10, height: 10 }), null);
  assert.match(
    core.inputGuardError({ bytes: core.MAX_INPUT_BYTES + 1, width: 10, height: 10 }),
    /大きすぎます/,
  );
  assert.match(
    core.inputGuardError({ bytes: 100, width: 9000, height: 9000 }),
    /画素数/,
  );
});

// ------------------------------------------------- core: フレーム計画とラダー

test("planFrameSampling は上限以下なら素通し、超過時は duration を合算する", () => {
  const small = core.planFrameSampling([100, 100, 100]);
  assert.equal(small.sampled, false);
  assert.deepEqual(small.durations, [100, 100, 100]);

  const durations = Array.from({ length: 90 }, () => 50);
  const plan = core.planFrameSampling(durations, 60);
  assert.equal(plan.sampled, true);
  assert.equal(plan.indices.length, 60);
  assert.equal(plan.durations.length, 60);
  assert.equal(plan.durations.reduce((a, b) => a + b, 0), 50 * 90);
  for (let i = 1; i < plan.indices.length; i++) {
    assert.ok(plan.indices[i] > plan.indices[i - 1]);
  }
});

test("stepDurations は step ごとにまとめ、総時間を保つ", () => {
  const { indices, durations } = core.stepDurations([10, 20, 30, 40, 50], 2);
  assert.deepEqual(indices, [0, 2, 4]);
  assert.deepEqual(durations, [30, 70, 50]);
});

test("GIF ラダーは最良画質から始まり単調に劣化する", () => {
  const attempts = core.emojiGifAttempts();
  assert.deepEqual(attempts[0], { maxEdge: 128, step: 1, colors: 256 });
  for (let i = 1; i < attempts.length; i++) {
    assert.ok(attempts[i].maxEdge <= attempts[i - 1].maxEdge);
  }
  const sticker = core.stickerGifAttempts();
  assert.deepEqual(sticker[0], { fitEdge: 320, step: 1, colors: 256 });
  assert.deepEqual(core.emojiStillAttempts().map((a) => a.colors), [0, 256, 128, 64, 32, 16]);
  assert.deepEqual(core.stickerStillAttempts()[0], { fitEdge: 320, colors: 0 });
});

// ------------------------------------------------------- core: 単色背景の検出

function imageWithCorners(corner, center, w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const isCorner = (x < 16 || x >= w - 16) && (y < 16 || y >= h - 16);
      const [r, g, b] = isCorner ? corner : center;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

test("detectFlatBackground は単色の四隅を検出し、ざらつきと透明を弾く", () => {
  const flat = core.detectFlatBackground(
    imageWithCorners([250, 227, 236], [10, 20, 30]), 64, 64);
  assert.equal(flat.flat, true);
  assert.deepEqual(flat.bg, [250, 227, 236]);

  const noisy = imageWithCorners([250, 227, 236], [10, 20, 30]);
  for (let i = 0; i < noisy.length; i += 4) {
    if ((i / 4) % 7 === 0) noisy[i] = 120; // 四隅にばらつきを混ぜる
  }
  assert.equal(core.detectFlatBackground(noisy, 64, 64).flat, false);

  const transparent = imageWithCorners([250, 227, 236], [10, 20, 30]);
  for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
  assert.equal(core.detectFlatBackground(transparent, 64, 64).flat, false);
});

// --------------------------------------------------------- core: α後処理

test("remapAlphaValue は低αを切り捨て高αを締める", () => {
  assert.equal(core.remapAlphaValue(0), 0);
  assert.equal(core.remapAlphaValue(0.05), 0);
  assert.equal(core.remapAlphaValue(0.95), 1);
  assert.equal(core.remapAlphaValue(1), 1);
  assert.ok(Math.abs(core.remapAlphaValue(0.5) - 0.5) < 1e-9);
  assert.ok(core.remapAlphaValue(0.3) < 0.3); // 低い側は持ち上げない
});

test("applyMaskToRgba は背景色をデコンタミネーションし既存αと乗算する", () => {
  // 1画素: 元色 (200,100,50)、背景 (250,240,235)、マスク 0.5 → a=0.5
  const rgba = new Uint8ClampedArray([200, 100, 50, 255]);
  core.applyMaskToRgba(rgba, new Float32Array([0.5]), [250, 240, 235]);
  assert.equal(rgba[3], 128);
  assert.equal(rgba[0], 150); // (200 - 0.5*250) / 0.5
  assert.equal(rgba[1], 0); // (100 - 0.5*240) / 0.5 = -40 → 0 に丸める
  assert.equal(rgba[2], 0);

  // 既存α 128 の画素にマスク 1 → α はほぼ 128 のまま
  const rgba2 = new Uint8ClampedArray([10, 20, 30, 128]);
  core.applyMaskToRgba(rgba2, new Float32Array([1]), null);
  assert.ok(Math.abs(rgba2[3] - 128) <= 1);
  assert.deepEqual([rgba2[0], rgba2[1], rgba2[2]], [10, 20, 30]);

  // マスク 0 は完全透明
  const rgba3 = new Uint8ClampedArray([10, 20, 30, 255]);
  core.applyMaskToRgba(rgba3, new Float32Array([0]), null);
  assert.equal(rgba3[3], 0);
});

// ------------------------------------------------------------- トークン検証

const KEY = "test-bot-api-key";
const NOW = 1_700_000_000;

function botToken(payloadJson, key = KEY) {
  const b64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${b64}`).digest("base64url");
  return `v1.${b64}.${sig}`;
}

test("verifyBgcutToken は Bot 発行トークンを検証し、ID の精度を保つ", () => {
  // Bot（Python）は ID を JSON 数値のまま書く。2^53 超の ID が化けないこと。
  const payloadJson =
    `{"u":1320705325686587408,"p":"sticker","g":1150000000000000001,` +
    `"c":1532264579063873557,"j":"job-abcdef123456","exp":${NOW + 3600}}`;
  const result = tokenLib.verifyBgcutToken(botToken(payloadJson), KEY, NOW);
  assert.equal(result.status, "ok");
  assert.equal(result.payload.userId, "1320705325686587408");
  assert.equal(result.payload.guildId, "1150000000000000001");
  assert.equal(result.payload.channelId, "1532264579063873557");
  assert.equal(result.payload.purpose, "sticker");
  assert.equal(result.payload.jobId, "job-abcdef123456");
  assert.equal(result.payload.expiresAt, NOW + 3600);
});

test("verifyBgcutToken は改竄・期限切れ・鍵違いを区別する", () => {
  const payloadJson = `{"u":42,"p":"emoji","g":100,"c":7,"j":"job-12345678","exp":${NOW + 3600}}`;
  const good = botToken(payloadJson);
  const [v, body, sig] = good.split(".");
  const forgedBody = Buffer.from(
    payloadJson.replace('"u":42', '"u":99'), "utf8").toString("base64url");
  assert.equal(tokenLib.verifyBgcutToken(`${v}.${forgedBody}.${sig}`, KEY, NOW).status, "invalid");
  assert.equal(tokenLib.verifyBgcutToken(good, "other-key", NOW).status, "invalid");
  assert.equal(tokenLib.verifyBgcutToken(good, KEY, NOW + 3600).status, "expired");
  assert.equal(tokenLib.verifyBgcutToken(good, undefined, NOW).status, "unconfigured");
  assert.equal(tokenLib.verifyBgcutToken("garbage", KEY, NOW).status, "invalid");
  const badPurpose = botToken(
    `{"u":42,"p":"other","g":100,"c":7,"j":"job-12345678","exp":${NOW + 3600}}`);
  assert.equal(tokenLib.verifyBgcutToken(badPurpose, KEY, NOW).status, "invalid");
});

// ------------------------------------------- エンコーダ（gifenc / upng-js）

test("gifenc で透過 GIF が往復し、フレーム数と delay と透過が保たれる", async () => {
  const gifenc = (await import("gifenc")).default;
  const gifuct = (await import("gifuct-js")).default;
  const { GIFEncoder, quantize, applyPalette } = gifenc;
  const frame = (dotX) => {
    const d = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = (y * 8 + x) * 4;
        if (x < 4) {
          d[i] = 220; d[i + 1] = 30; d[i + 2] = 30; d[i + 3] = 255;
        }
        if (Math.abs(x - dotX) <= 1 && y >= 3 && y <= 4) {
          d[i] = 30; d[i + 1] = 60; d[i + 2] = 220; d[i + 3] = 255;
        }
      }
    }
    return d;
  };
  const gif = GIFEncoder();
  [[frame(5), 100], [frame(6), 120]].forEach(([rgba, delay], i) => {
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, 8, 8, {
      palette, delay, transparent: true, ...(i === 0 ? { repeat: 0 } : {}),
    });
  });
  gif.finish();
  const bytes = gif.bytes();
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), "GIF89a");
  const parsed = gifuct.parseGIF(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const frames = gifuct.decompressFrames(parsed, true);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.delay), [100, 120]);
  const px = frames[0].patch;
  assert.equal(px[(1 * 8 + 1) * 4 + 3], 255); // 不透明部
  assert.equal(px[(1 * 8 + 6) * 4 + 3], 0); // 透過部
});

test("upng-js で無劣化／パレット PNG が往復する", async () => {
  const UPNG = (await import("upng-js")).default;
  const W = 32;
  const data = new Uint8Array(W * W * 4);
  for (let i = 0; i < W * W; i++) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = (i * 3) % 256;
    data[i * 4 + 2] = 99;
    data[i * 4 + 3] = i % 5 === 0 ? 0 : 255;
  }
  for (const colors of [0, 256, 32]) {
    const png = UPNG.encode([data.buffer], W, W, colors);
    assert.ok(png.byteLength > 8);
    const sig = Buffer.from(png.slice(0, 4)).toString("latin1");
    assert.equal(sig, "\x89PNG");
    const decoded = UPNG.decode(png);
    assert.equal(decoded.width, W);
    assert.equal(decoded.height, W);
    const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    assert.equal(rgba[3], 0); // 先頭画素は透過のまま
    assert.equal(rgba[7], 255);
  }
});
