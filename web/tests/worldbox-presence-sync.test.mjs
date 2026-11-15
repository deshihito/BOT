// AGO WORLD BOX プレゼンス同期のテスト。
// - サーバー/クライアント間の時計ずれ推定と、それを使った外挿の誤差
// - 外挿キャップ
// - API ルートとクライアントの配線（now 返却・補正・適応ハートビート・欠落グレース）
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

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

const url = bundleModule(
  ["worldbox/mapgen.ts", "worldbox/presence.ts"],
  ["clockOffsetEstimate", "predictPosition", "EXTRAPOLATE_CAP_SEC"],
);
const wb = await import(url);
const bounds = { width: 1024, height: 1024 };

test("clockOffsetEstimate: 往復中点との差でずれを推定する", () => {
  // クライアントがサーバーより 3000ms 進んでいる（往復 100ms）
  const serverNow = 1_000_000;
  const before = serverNow + 3000 - 50;
  const after = serverNow + 3000 + 50;
  const offset = wb.clockOffsetEstimate(serverNow, before, after);
  assert.ok(Math.abs(offset - -3000) < 1e-9, `offset=${offset}`);
  // ずれゼロなら 0
  assert.equal(wb.clockOffsetEstimate(5000, 4900, 5100), 0);
});

test("時計ずれ補正で外挿誤差が消える（補正なしでは速度ぶんずれる）", () => {
  // サーバー時刻 1,000,000 に x=100, vx=4 で記録されたエントリ。
  // 受信側の時計は +3000ms 進んでいて、実時刻ではエントリは 800ms 前のもの。
  const entry = { id: "a", name: "n", x: 100, y: 50, vx: 4, vy: 0, face: 1, space: "world", ts: 1_000_000 };
  const serverNowAtReceipt = 1_000_800;
  const clientNow = serverNowAtReceipt + 3000;
  const truth = 100 + 4 * 0.8;
  // 補正なし: dt = 実経過0.8s + ずれ3.0s が上限2sに張り付き、行き過ぎる（誤差4.8タイル）
  const raw = wb.predictPosition(entry, clientNow, bounds);
  assert.ok(Math.abs(raw.x - 108) < 1e-9, `raw=${raw.x}`);
  assert.ok(Math.abs(raw.x - truth) > 3);
  // 補正あり: 真の位置に一致
  const offset = wb.clockOffsetEstimate(serverNowAtReceipt, clientNow - 40, clientNow + 40);
  const fixed = wb.predictPosition(entry, clientNow + offset, bounds);
  assert.ok(Math.abs(fixed.x - truth) < 1e-9, `fixed=${fixed.x}`);
});

test("外挿キャップは2秒（ポーリング間隔の尾を覆う）", () => {
  assert.equal(wb.EXTRAPOLATE_CAP_SEC, 2);
  const e = { id: "a", name: "n", x: 10, y: 10, vx: 2, vy: 0, face: 1, space: "world", ts: 0 };
  const p = wb.predictPosition(e, 60_000, bounds);
  assert.ok(Math.abs(p.x - 14) < 1e-9, `x=${p.x}`);
});

test("API と クライアント: now 返却・補正・適応間隔・欠落グレースが配線されている", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/presence/route.ts"), "utf8");
  assert.ok(route.includes("now: Date.now()"), "GET 応答にサーバー時刻が無い");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("clockOffsetEstimate("), "時計ずれ推定を使っていない");
  assert.ok(client.includes("presenceNow()"), "補正時刻が使われていない");
  assert.ok(client.includes("stepRemoteTrack(o.track, presenceNowMs"), "描画追跡が補正時刻でない");
  assert.ok(client.includes("missedPolls"), "欠落グレースが無い");
  assert.ok(client.includes("setInterval(pollOthers, 1000)"), "ポーリングが1秒でない");
  assert.ok(client.includes("moving ? 500 : 2000"), "ハートビートの適応間隔が無い");
  assert.ok(client.includes("movedDist <= 4"), "ジャンプ時の即時送信が無い");
});
