// AGO WORLD BOX: プレゼンスポーリング間引き（Phase 0）のテスト。
// - isWsHealthy: 接続中かつ生存窓内の応答がある間だけ健全
// - presencePollDue: 健全時は 15 秒セーフティ、不健全時は 1 秒
// - 配線: relay の定期 tick / クライアントの pollTick / 中継コアは不変
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const {
  PRESENCE_POLL_MS, PRESENCE_SAFETY_POLL_MS, WS_ALIVE_WINDOW_MS,
  isWsHealthy, presencePollDue,
} = loadBundle(["worldbox/realtime-poll.ts"], [
  "PRESENCE_POLL_MS", "PRESENCE_SAFETY_POLL_MS", "WS_ALIVE_WINDOW_MS",
  "isWsHealthy", "presencePollDue",
]);

test("realtime-poll: 間隔定数が設計どおり", () => {
  assert.equal(PRESENCE_POLL_MS, 1_000);
  assert.equal(PRESENCE_SAFETY_POLL_MS, 15_000);
  // relay の tick（15秒）より広く、ping/pong 検知（30秒）より狭い
  assert.ok(WS_ALIVE_WINDOW_MS > PRESENCE_SAFETY_POLL_MS);
  assert.ok(WS_ALIVE_WINDOW_MS < 30_000);
});

test("realtime-poll: WS 健全判定は接続と生存窓の両方を見る", () => {
  const now = 1_000_000;
  assert.equal(isWsHealthy(true, now - 1_000, now), true);
  assert.equal(isWsHealthy(true, now - WS_ALIVE_WINDOW_MS, now), true);
  assert.equal(isWsHealthy(true, now - WS_ALIVE_WINDOW_MS - 1, now), false);
  assert.equal(isWsHealthy(false, now, now), false);
  assert.equal(isWsHealthy(true, 0, now), false);
});

test("realtime-poll: 健全時は15秒、不健全時は1秒で due になる", () => {
  const t0 = 500_000;
  // 不健全: 1 秒未満は未了、1 秒で due
  assert.equal(presencePollDue({ now: t0 + 999, lastPollAt: t0, wsHealthy: false }), false);
  assert.equal(presencePollDue({ now: t0 + 1_000, lastPollAt: t0, wsHealthy: false }), true);
  // 健全: 14.9 秒では due にならず、15 秒で due
  assert.equal(presencePollDue({ now: t0 + 14_999, lastPollAt: t0, wsHealthy: true }), false);
  assert.equal(presencePollDue({ now: t0 + 15_000, lastPollAt: t0, wsHealthy: true }), true);
  // 初回（lastPollAt=0）はどちらでも即 due
  assert.equal(presencePollDue({ now: t0, lastPollAt: 0, wsHealthy: true }), true);
});

test("realtime-poll: relay は定期 tick を送り、クライアントは生存時刻を記録する", () => {
  const server = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.ok(server.includes('t: "tick"'), "relay に tick 送信が無い");
  assert.ok(server.includes("15_000"), "tick 間隔が15秒でない");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("lastWsMsgAt = arrivedAt"), "受信時刻を記録していない");
  assert.ok(client.includes("checkNearDungeonEntrance"), "入口近接判定が tick から分離されていない");
});
