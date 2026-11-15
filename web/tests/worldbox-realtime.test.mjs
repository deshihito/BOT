// AGO WORLD BOX リアルタイム中継（WebSocket）のテスト。
// - 中継コア（realtime/relay-core.js）の整形・部屋管理・鮮度
// - トークンの署名/検証（改竄・期限切れ・鍵なし）
// - ラッパー / デプロイ / トークン発行ルート / クライアントの配線
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const rootDir = path.join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const core = require(path.join(rootDir, "realtime", "relay-core.js"));

const NOW = 1_700_000_000_000;
const hb = (x, y, extra = {}) => ({ x, y, vx: 0, vy: 0, face: 1, space: "world", ...extra });

test("relay: ハートビートは整形され、範囲と速度が丸められる", () => {
  const room = core.createRoom();
  const e = core.acceptHeartbeat(room, "p1", "名前", hb(2000, -5, { vx: 99, face: -1 }), NOW);
  assert.equal(e.x, 1024);
  assert.equal(e.y, 0);
  assert.equal(e.vx, 16);
  assert.equal(e.face, -1);
  assert.equal(e.id, "p1");
  assert.equal(e.ts, NOW);
  assert.equal(core.acceptHeartbeat(room, "p1", "n", { x: "a", y: 1 }, NOW), null);
  assert.equal(core.acceptHeartbeat(room, "p1", "n", null, NOW), null);
});

test("relay: スナップショットは他者だけ・新鮮なものだけ・上限まで", () => {
  const room = core.createRoom();
  core.acceptHeartbeat(room, "me", "私", hb(1, 1), NOW);
  core.acceptHeartbeat(room, "a", "A", hb(2, 2), NOW);
  core.acceptHeartbeat(room, "old", "古", hb(3, 3), NOW - core.FRESH_MS - 1);
  core.acceptHeartbeat(room, "lob", "L", hb(4, 4, { space: "lobby" }), NOW);
  const snap = core.snapshot(room, "world", "me", NOW);
  assert.deepEqual(snap.map((p) => p.id), ["a"]);
  const lobSnap = core.snapshot(room, "lobby", "me", NOW);
  assert.deepEqual(lobSnap.map((p) => p.id), ["lob"]);
});

test("relay: 空間移動で旧空間から消え、削除と掃除が効く", () => {
  const room = core.createRoom();
  core.acceptHeartbeat(room, "p1", "P", hb(1, 1), NOW);
  core.acceptHeartbeat(room, "p1", "P", hb(2, 2, { space: "lobby" }), NOW);
  assert.equal(core.snapshot(room, "world", "x", NOW).length, 0);
  assert.equal(core.snapshot(room, "lobby", "x", NOW).length, 1);
  assert.deepEqual(core.removePlayer(room, "p1"), ["lobby"]);
  core.acceptHeartbeat(room, "p2", "P2", hb(5, 5), NOW);
  const pruned = core.pruneRoom(room, NOW + core.FRESH_MS + 1);
  assert.deepEqual(pruned, [{ id: "p2", space: "world" }]);
});

test("relay token: 署名と検証（改竄・期限切れ・鍵違いを弾く）", () => {
  const secret = "test-secret";
  const token = core.signToken({ pid: "abcd1234", name: "誰か", exp: NOW + 60_000 }, secret);
  assert.deepEqual(core.verifyToken(token, secret, NOW), { pid: "abcd1234", name: "誰か" });
  assert.equal(core.verifyToken(token, "other-secret", NOW), null);
  assert.equal(core.verifyToken(token, secret, NOW + 120_000), null, "期限切れを通した");
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(core.verifyToken(tampered, secret, NOW), null, "改竄を通した");
  assert.equal(core.verifyToken("v1.bad.bad", secret, NOW), null);
  assert.equal(core.verifyToken(token, "", NOW), null);
});

test("配線: ラッパー・デプロイ・トークンルート・クライアント", () => {
  const wrapper = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.ok(wrapper.includes('"/api/worldbox/realtime"') || wrapper.includes("REALTIME_PATH"), "中継パスが無い");
  assert.ok(wrapper.includes("next-server.js"), "Next 本体を内包していない");
  assert.ok(wrapper.includes("verifyToken"), "トークン検証が無い");
  const deploy = fs.readFileSync(path.join(rootDir, "../deploy/deploy-web.sh"), "utf8");
  assert.ok(deploy.includes('mv "$RELEASE/server.js" "$RELEASE/next-server.js"'), "デプロイでラッパーが設置されない");
  assert.ok(deploy.includes('cp -a "$BUILD/realtime-server.js" "$RELEASE/server.js"'), "ラッパーのコピーが無い");
  assert.ok(deploy.includes('node_modules/ws'), "ws のコピーが無い");
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/realtime-token/route.ts"), "utf8");
  assert.ok(route.includes("issueRealtimeToken"), "トークン発行ルートが無い");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/realtime-token"), "クライアントがトークンを取りに行かない");
  assert.ok(client.includes("/api/worldbox/realtime?t="), "クライアントが中継へ繋がない");
  assert.ok(client.includes("sendWsHeartbeat"), "WS ハートビートが無い");
  assert.ok(client.includes('msg.t === "up"'), "中継の更新適用が無い");
  assert.ok(client.includes('msg.t === "bye"'), "中継の退室適用が無い");
  // フォールバック（REST ハートビートとポーリング）が残っている
  assert.ok(client.includes("sendHeartbeat()"), "REST フォールバックが消えている");
  assert.ok(client.includes("pollOthers"), "ポーリングが消えている");
});
