// WORLD BOX: ロビーのピアノ（弾ける＋音がロビー全員に届く）の検証。
// - 配置ピンは lobby の station、共有の検証は relay-core の純粋関数で、
//   中継サーバーとクライアントの配線はソースで固定する。
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

const wb = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts"],
  ["buildLobby", "stationNear"],
);
const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
const server = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
const sound = fs.readFileSync(path.join(rootDir, "lib/worldbox/sound.ts"), "utf8");

test("ピアノ: ロビーのピアノに station が付き、隣で返る", () => {
  const lobby = wb.buildLobby();
  const piano = lobby.objects.find((o) => o.sprite === "piano");
  assert.ok(piano);
  assert.equal(piano.station, "piano");
  assert.equal(piano.x, 39);
  assert.equal(piano.y, 26);
  assert.equal(wb.stationNear(lobby.objects, 39, 27), "piano");
});

test("ピアノ: 中継の検証は半音配列だけを通す（範囲・個数・型）", () => {
  assert.deepEqual(relay.sanitizePianoNotes([0, 4, 7]), [0, 4, 7]);
  assert.deepEqual(relay.sanitizePianoNotes([-24, 24]), [-24, 24]);
  assert.equal(relay.sanitizePianoNotes([]), null);
  assert.equal(relay.sanitizePianoNotes([25]), null);
  assert.equal(relay.sanitizePianoNotes([-25]), null);
  assert.equal(relay.sanitizePianoNotes([1.5]), null);
  assert.equal(relay.sanitizePianoNotes(["0"]), null);
  assert.equal(relay.sanitizePianoNotes([0, 1, 2, 3, 4, 5, 6, 7, 8]), null); // 9音は多い
  assert.equal(relay.sanitizePianoNotes("0"), null);
  assert.equal(relay.sanitizePianoNotes(null), null);
});

test("ピアノ: 中継サーバーはロビー在席の音だけをロビー全員へ配る", () => {
  assert.match(server, /msg\.t === "note"/);
  assert.match(server, /core\.sanitizePianoNotes\(msg\.notes\)/);
  assert.match(server, /info\.space === "lobby"/);
  assert.match(server, /broadcast\("lobby", ws, \{ t: "note", notes, id: info\.pid \}\)/);
});

test("ピアノ: クライアントは打鍵を送り、届いた音をロビーで鳴らす", () => {
  assert.match(client, /pianoSendRef\.current = \(notes: number\[\]\) =>/);
  assert.match(client, /ws\.send\(JSON\.stringify\(\{ t: "note", notes \}\)\)/);
  assert.match(client, /msg\.t === "note" && Array\.isArray\(msg\.notes\)/);
  assert.match(client, /if \(space === "lobby"\) playPianoNotes\(msg\.notes\);/);
  assert.match(client, /stationUi === "piano"/);
  assert.match(client, /<WorldBoxPianoPanel onClose=\{\(\) => setPianoOpen\(false\)\} onPlay=\{playPianoNote\} \/>/);
});

test("ピアノ: playPianoNotes はスロットル無しで音ごとに鳴らす", () => {
  assert.match(sound, /export function playPianoNotes\(semitones: readonly number\[\]\): void/);
  assert.match(sound, /sePitch = Math\.pow\(2, n \/ 12\);/);
});
