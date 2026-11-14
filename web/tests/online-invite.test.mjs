// オンライン基盤の招待まわり拡張（アバター受け渡し）の検証。
// online-foundation.test.mjs と同じ loadBundle 方式・同じスタブを使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

function transpile(relPath) {
  const src = fs.readFileSync(path.join(webDir, relPath), "utf8");
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
    if (/^export\s*\{[^}]*\}\s*from\s/.test(line)) continue;
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

async function loadBundle(relPaths, exportNames, prefix = "") {
  const code =
    prefix +
    relPaths.map((p) => stripModuleSyntax(transpile(p))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const BOT_API_STUB = `
function isBotApiConfigured() { return false; }
async function kvGet() { return null; }
async function kvList() { return new Map(); }
async function kvSet() {}
async function kvDelete() {}
`;

const DUMMY_MODULES = `
const __dummyModule = {
  id: "dummy",
  title: "ダミー",
  minPlayers: 2,
  maxPlayers: 3,
  cpuSupported: true,
  chatEnabled: true,
  createState(players, rng, options) {
    return { phase: "playing", players: players.map((p) => ({ seat: p.seat, name: p.name })), turn: 0, winner: null };
  },
  applyAction(state, seat, action, rng) { throw new Error("不正な手です"); },
  viewFor(state, seat) { return state; },
  parseAction(raw) { return null; },
  phaseOf(state) { return state.phase; },
  isFinished(state) { return state.phase === "finished"; },
  cpuAction(state, seat, rng) { return null; },
};
const __onlineModules = { dummy: __dummyModule };
function getOnlineGame(id) { return __onlineModules[id]; }
`;

const server = await loadBundle(
  ["lib/online/server.ts"],
  ["createOnlineRoom", "joinOnlineRoom", "getOnlineRoom", "parseCreateRoomBody", "parseJoinRoomBody", "parseAvatarUrl"],
  `import { randomBytes } from "node:crypto";\n${BOT_API_STUB}\n${DUMMY_MODULES}\n`,
);

const CDN_AVATAR = "https://cdn.discordapp.com/avatars/1320705325686587408/hash1.png?size=64";
const CDN_DEFAULT = "https://cdn.discordapp.com/embed/avatars/0.png";

test("parseAvatarUrl は Discord CDN の URL だけを通し、それ以外は未設定に倒す", () => {
  assert.equal(server.parseAvatarUrl(CDN_AVATAR), CDN_AVATAR);
  assert.equal(server.parseAvatarUrl(CDN_DEFAULT), CDN_DEFAULT);
  assert.equal(server.parseAvatarUrl("https://example.com/avatars/1/x.png"), undefined);
  assert.equal(server.parseAvatarUrl("http://cdn.discordapp.com/avatars/1/x.png"), undefined);
  assert.equal(server.parseAvatarUrl("https://cdn.discordapp.com.evil.example/avatars/1/x.png"), undefined);
  assert.equal(server.parseAvatarUrl("javascript:alert(1)"), undefined);
  assert.equal(server.parseAvatarUrl(""), undefined);
  assert.equal(server.parseAvatarUrl(undefined), undefined);
  assert.equal(server.parseAvatarUrl(42), undefined);
  assert.equal(server.parseAvatarUrl(`https://cdn.discordapp.com/avatars/${"1".repeat(600)}.png`), undefined);
});

test("作成・参加 body のアバターが検証を通り、ビューに載る", async () => {
  const createInput = server.parseCreateRoomBody({ displayName: "ホスト", isPublic: false, avatarUrl: CDN_AVATAR });
  assert.equal(createInput.avatarUrl, CDN_AVATAR);
  const host = await server.createOnlineRoom("dummy", createInput);
  const hostView = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.equal(hostView.players[0].avatar, CDN_AVATAR);

  const joinInput = server.parseJoinRoomBody({ code: host.code, displayName: "ゲスト", avatarUrl: CDN_DEFAULT });
  assert.equal(joinInput.avatarUrl, CDN_DEFAULT);
  const guest = await server.joinOnlineRoom("dummy", joinInput);
  const guestView = await server.getOnlineRoom("dummy", guest.code, guest.playerToken);
  assert.equal(guestView.players.length, 2);
  assert.equal(guestView.players[1].avatar, CDN_DEFAULT);
  // 既存プレイヤーのアバターは参加で消えない
  assert.equal(guestView.players[0].avatar, CDN_AVATAR);
});

test("アバター未指定ならビューに avatar キー自体が出ない（従来どおり）", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", isPublic: false });
  const view = await server.getOnlineRoom("dummy", host.code, host.playerToken);
  assert.equal("avatar" in view.players[0], false);
});

test("不正なアバター URL は body 検証で落とされ、参加自体は成立する", async () => {
  const host = await server.createOnlineRoom("dummy", { displayName: "ホスト", isPublic: false });
  const joinInput = server.parseJoinRoomBody({ code: host.code, displayName: "ゲスト", avatarUrl: "https://example.com/x.png" });
  assert.equal(joinInput.avatarUrl, undefined);
  const guest = await server.joinOnlineRoom("dummy", joinInput);
  const view = await server.getOnlineRoom("dummy", guest.code, guest.playerToken);
  assert.equal(view.players.length, 2);
  assert.equal("avatar" in view.players[1], false);
});
