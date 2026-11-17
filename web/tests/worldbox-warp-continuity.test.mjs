// AGO WORLD BOX 移動連続性（B4）と登録済み同一空間ワープ対の検証:
// - ロビー擬似2F階段（上り/下り）は同一空間 "lobby" 内のクライアント駆動
//   ワープで約31〜35タイル跳ぶため、B4 の連続性検証に「登録済みワープ対」
//   として通らなければならない（2026-11-17 階段バグ: 踏むとフェードして
//   同じ場所へ戻る、の回帰固定）
// - 対象は REST 時刻基準 / REST セーブ基準 / WS 中継（relay-core）の3経路
// - 登録されていないジャンプは全経路で依然として却下されること
// - presence.ts のワープ表（複製）と lobby.ts の正の定数の一致（ドリフト防止）
// - 遺跡の転移罠はサーバーがプレゼンス/セーブを転移先へそろえる配線
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const require = createRequire(import.meta.url);
const relay = require(path.join(rootDir, "realtime", "relay-core.js"));

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
  ["checkMovementContinuity", "checkSaveFallbackContinuity", "isRegisteredWarpJump", "SAME_SPACE_WARPS", "WARP_LANDING_TOLERANCE_TILES", "WARP_FALLBACK_SOURCE_REACH_TILES"],
);
const wb = await import(url);

const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);

const NOW = 1_700_000_000_000;
// 階段の形状（lobby.ts が正）: 上り元 (17,29)/(18,29) → 着地 (17.5,60.5)
// 下り元 (17,62)/(18,62) → 着地 (17.5,27.5)
const UP_LANDING = { x: 17.5, y: 60.5, space: "lobby" };
const DOWN_LANDING = { x: 17.5, y: 27.5, space: "lobby" };
const PLAZA = { x: 28.5, y: 32.5, space: "lobby" };

test("ワープ表は lobby.ts の階段定数と一致する（ドリフト防止）", () => {
  assert.equal(wb.SAME_SPACE_WARPS.length, 2);
  const [up, down] = wb.SAME_SPACE_WARPS;
  assert.deepEqual(up.sources, lobby.LOBBY_STAIRS_UP);
  assert.deepEqual(up.landing, lobby.LOBBY_UP_LANDING);
  assert.deepEqual(down.sources, lobby.LOBBY_STAIRS_DOWN);
  assert.deepEqual(down.landing, lobby.LOBBY_DOWN_LANDING);
  assert.equal(up.space, "lobby");
  assert.equal(down.space, "lobby");
  // 中継ミラーも同じ表を持つ
  assert.deepEqual(relay.SAME_SPACE_WARPS, wb.SAME_SPACE_WARPS);
  assert.equal(relay.WARP_LANDING_TOLERANCE_TILES, wb.WARP_LANDING_TOLERANCE_TILES);
  assert.equal(relay.WARP_FALLBACK_SOURCE_REACH_TILES, wb.WARP_FALLBACK_SOURCE_REACH_TILES);
});

test("時刻基準: 擬似2F階段の上り/下りが通る（REST ハートビート/セーブ）", () => {
  // 階段を踏む直前の保管位置は元タイルの手前〜タイル上（ハートビート間隔ぶんの遅れを含む）
  for (const lagMs of [0, 500, 2000]) {
    const upBase = { x: 17.5, y: 30.4, space: "lobby", ts: NOW };
    assert.equal(wb.checkMovementContinuity(upBase, UP_LANDING, NOW + lagMs).ok, true, `up lag=${lagMs}`);
    const downBase = { x: 17.5, y: 61.4, space: "lobby", ts: NOW };
    assert.equal(wb.checkMovementContinuity(downBase, DOWN_LANDING, NOW + lagMs).ok, true, `down lag=${lagMs}`);
  }
  // 元タイルの真上にいる保管位置からでも通る
  assert.equal(wb.checkMovementContinuity({ x: 17.2, y: 29.8, space: "lobby", ts: NOW }, UP_LANDING, NOW).ok, true);
  assert.equal(wb.checkMovementContinuity({ x: 18.6, y: 62.3, space: "lobby", ts: NOW }, DOWN_LANDING, NOW).ok, true);
});

test("セーブ基準: 擬似2F階段の上り/下りが通る（プレゼンス無しの経路）", () => {
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 29.5, space: "lobby" }, UP_LANDING).ok, true);
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 62.5, space: "lobby" }, DOWN_LANDING).ok, true);
  // 元タイルの間近（到達範囲 5 以内）のセーブからでも通る
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 31.5, space: "lobby" }, UP_LANDING).ok, true);
  // 往復の着地点（反対側の元タイルまで 2 タイル）からのセーブでも通る
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 27.5, space: "lobby" }, UP_LANDING).ok, true);
});

test("時刻基準: 登録されていないジャンプは依然として却下される", () => {
  // 広場から着地点へ直接跳ぶ（元タイルに届いていない）→ 却下
  assert.equal(wb.checkMovementContinuity({ ...PLAZA, ts: NOW }, UP_LANDING, NOW).ok, false);
  assert.equal(wb.checkMovementContinuity({ ...PLAZA, ts: NOW }, UP_LANDING, NOW + 500).ok, false);
  // 元タイルの上にいても、着地点でない遠方への跳躍は却下
  assert.equal(wb.checkMovementContinuity({ x: 17.5, y: 29.5, space: "lobby", ts: NOW }, { x: 100, y: 26, space: "lobby" }, NOW).ok, false);
  // 着地点の近傍を超えた先（10タイル先）への申告は却下
  assert.equal(wb.checkMovementContinuity({ x: 17.5, y: 29.5, space: "lobby", ts: NOW }, { x: 17.5, y: 50, space: "lobby" }, NOW + 500).ok, false);
  // ワールドでの無関係な跳躍は従来どおり却下
  const jumped = wb.checkMovementContinuity({ x: 0, y: 0, space: "world", ts: NOW }, { x: 100, y: 0, space: "world" }, NOW + 1000);
  assert.equal(jumped.ok, false);
  assert.equal(jumped.reason, "position_jump");
});

test("セーブ基準: 登録されていないジャンプは依然として却下される", () => {
  // 広場のセーブ（元タイル中心まで約11.4タイル）は到達範囲 5 の外 → 却下
  assert.equal(wb.checkSaveFallbackContinuity(PLAZA, UP_LANDING).ok, false);
  // 接近途中のセーブ（元タイル中心まで 8.5 タイル）も到達範囲の外 → 却下
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 38, space: "lobby" }, UP_LANDING).ok, false);
  assert.equal(wb.checkSaveFallbackContinuity({ x: 17.5, y: 29.5, space: "lobby" }, { x: 100, y: 26, space: "lobby" }).ok, false);
});

test("isRegisteredWarpJump: 元と着地は同じ対で結ばれる必要がある", () => {
  // 下り元タイル付近から上り着地点へは対にならない（到達範囲 12 でも届かない）
  assert.equal(wb.isRegisteredWarpJump({ x: 17.5, y: 61.5, space: "lobby" }, UP_LANDING, 12), false);
  // 上り元タイル付近から下り着地点へも対にならない
  assert.equal(wb.isRegisteredWarpJump({ x: 17.5, y: 29.5, space: "lobby" }, DOWN_LANDING, 0), false);
  // 空間が違えば対にならない
  assert.equal(wb.isRegisteredWarpJump({ x: 17.5, y: 29.5, space: "world" }, { x: 17.5, y: 60.5, space: "world" }, 12), false);
});

test("WS 中継: 階段の上りが部屋基準でも外部セーブ基準でも通る", () => {
  const hb = (x, y) => ({ x, y, vx: 0, vy: 0, face: 1, space: "lobby" });
  // 部屋に前回（階段手前）がある場合
  const room = relay.createRoom();
  relay.acceptHeartbeat(room, "p1", "n", hb(17.5, 30.4), NOW);
  const res = relay.acceptHeartbeat(room, "p1", "n", hb(17.5, 60.5), NOW + 500);
  assert.ok(res && !res.rejected, "上りの申告が中継で却下された");
  assert.equal(res.y, 60.5);
  // 部屋に前回が無く、外部基準がセーブ（ts 無し）の場合
  const room2 = relay.createRoom();
  const res2 = relay.acceptHeartbeat(room2, "p2", "n", hb(17.5, 27.5), NOW, { x: 17.5, y: 62.5, space: "lobby" });
  assert.ok(res2 && !res2.rejected, "下りの申告が中継（セーブ基準）で却下された");
  // 中継の判定関数も TS と同じ規則
  assert.equal(relay.checkMovementContinuity({ x: 17.5, y: 30.4, space: "lobby", ts: NOW }, UP_LANDING, NOW + 500).ok, true);
  assert.equal(relay.checkSaveFallbackContinuity({ x: 17.5, y: 29.5, space: "lobby" }, UP_LANDING).ok, true);
});

test("WS 中継: 登録されていないジャンプは依然として却下される", () => {
  const hb = (x, y) => ({ x, y, vx: 0, vy: 0, face: 1, space: "lobby" });
  const room = relay.createRoom();
  relay.acceptHeartbeat(room, "p1", "n", hb(PLAZA.x, PLAZA.y), NOW);
  const res = relay.acceptHeartbeat(room, "p1", "n", hb(UP_LANDING.x, UP_LANDING.y), NOW + 500);
  assert.equal(res?.rejected, true);
  assert.equal(res.x, PLAZA.x);
  assert.equal(res.y, PLAZA.y);
  assert.equal(relay.checkMovementContinuity({ ...PLAZA, ts: NOW }, UP_LANDING, NOW + 500).ok, false);
  assert.equal(relay.checkSaveFallbackContinuity(PLAZA, UP_LANDING).ok, false);
});

test("遺跡の転移罠: サーバーがプレゼンス/セーブを転移先へそろえる配線がある", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/instances/route.ts"), "utf8");
  assert.ok(route.includes("putPresence"), "転移時にプレゼンスをそろえていない");
  assert.ok(route.includes("serializeSave({ space, x: teleport.x"), "転移時にセーブをそろえていない");
});
