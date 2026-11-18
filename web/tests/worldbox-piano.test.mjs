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
  assert.match(sound, /pianoNote\(523\.25 \* Math\.pow\(2, n \/ 12\), at\)/);
});

test("ピアノ: リバーブは生成インパルスのコンボルバを専用バスに挟む", () => {
  assert.match(sound, /export const PIANO_REVERB_SECONDS = 1\.8;/);
  assert.match(sound, /export const PIANO_REVERB_WET = 0\.22;/);
  assert.match(sound, /ctx\.createConvolver\(\)/);
  assert.match(sound, /ctx\.createBuffer\(2, len, rate\)/);
  assert.match(sound, /pianoBus\.connect\(conv\);/);
  assert.match(sound, /wet\.connect\(seBus\);/);
});

test("ピアノ: ペダルは減衰を延ばし、離すとダンパーで止まる", () => {
  assert.match(sound, /export function setPianoPedal\(down: boolean\): void/);
  const decay = sound.match(/export const PIANO_DECAY_SECONDS = ([\d.]+);/);
  const pedalDecay = sound.match(/export const PIANO_PEDAL_DECAY_SECONDS = ([\d.]+);/);
  assert.ok(decay && pedalDecay);
  assert.ok(Number(pedalDecay[1]) > Number(decay[1]), "ペダル中の減衰が長い");
  assert.match(sound, /pianoPedalDown \? PIANO_PEDAL_DECAY_SECONDS : PIANO_DECAY_SECONDS/);
});

test("ピアノ: パネルは Space とボタンでペダルを踏み、閉じたら離す", () => {
  assert.match(panel, /import \{ setPianoPedal \} from "@\/lib\/worldbox\/sound";/);
  assert.match(panel, /e\.code === "Space"/);
  assert.match(panel, /window\.addEventListener\("keyup", onKeyUp\)/);
  assert.match(panel, /aria-label="サステインペダル"/);
  assert.match(panel, /onPointerDown=\{\(e\) => \{ e\.preventDefault\(\); setPedal\(true\); \}\}/);
  assert.match(panel, /useEffect\(\(\) => \(\) => setPianoPedal\(false\), \[\]\)/);
});

const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxPianoPanel.tsx"), "utf8");

test("ピアノ: PC キーボードの2段マッピング（Z列=C4 / Q列=C5）", () => {
  const block = panel.match(/const KEY_TO_SEMI[^=]*= \{([^}]*)\}/);
  assert.ok(block, "KEY_TO_SEMI がある");
  const map = {};
  for (const m of block[1].matchAll(/(?:"([^"]+)"|([a-z]))\s*:\s*(-?\d+)/g)) {
    map[m[1] ?? m[2]] = Number(m[3]);
  }
  assert.equal(map.z, -12);
  assert.equal(map.s, -11);
  assert.equal(map.m, -1);
  assert.equal(map[","], 0);
  assert.equal(map.q, 0);
  assert.equal(map["2"], 1);
  assert.equal(map.w, 2);
  assert.equal(map["7"], 10);
  assert.equal(map.i, 12);
  // 白鍵・黒鍵の全半音（-12..12）にキー名ラベルがある
  const labelBlock = panel.match(/const SEMI_TO_KEY_LABEL[^=]*= \{([^}]*)\}/);
  assert.ok(labelBlock, "SEMI_TO_KEY_LABEL がある");
  for (let semi = -12; semi <= 12; semi++) {
    assert.ok(labelBlock[1].includes(`[${semi}]:`) || labelBlock[1].includes(`${semi}:`), `ラベル ${semi}`);
  }
});

test("ピアノ: パネルは keydown で弾き、クライアントは演奏中は歩かない", () => {
  assert.match(panel, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(panel, /e\.repeat/);
  assert.match(panel, /KEY_TO_SEMI\[e\.key\.toLowerCase\(\)\]/);
  assert.match(client, /pianoOpenRef\.current\) return;/);
  assert.match(client, /const pianoOpenRef = useRef\(false\)/);
});
