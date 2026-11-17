// AGO WORLD BOX ロビーの検証:
// - ロビー外形（図形の和集合・境界は壁・図形外は無効）
// - オブジェクト配置（重なり無し・壁に置かない・ステーション・店員NPC）
// - 各ゾーンへの到達可能性（1階は入場点から、2階は階段着地点から）
// - セーブ v6 のロビー空間（往復・クランプ・帰還点）
// - プレゼンスの空間フィルタ（純粋ロジック＋API）
// - 掲示板（純粋ロジック＋API: 投稿・一覧・上限・検証）
// - クライアント配線（ハンバーガー・ピクセル固定描画・掲示板パネル）
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

const wb = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/presence.ts", "worldbox/save.ts", "worldbox/board.ts"],
  [
    "T_GRASS", "T_ROCK",
    "LOBBY_W", "LOBBY_H", "L_VOID", "L_WALL", "L_MARBLE", "L_PLAZA", "L_RING", "L_CARPET", "L_WOOD",
    "L_SAND", "L_DARK", "L_CHECK", "LOBBY_FLOOR_SPRITE", "LOBBY_FLOOR_FALLBACK", "isSolidLobbyTile",
    "inLobbyShape", "LOBBY_OBJECTS", "LOBBY_NPCS", "LOBBY_ENTRY", "LOBBY_WARP_PAD",
    "RACETRACK", "RACE_CORRIDOR", "RACECOURSE", "isRaceTrackTile", "isRaceInfieldTile",
    "LOBBY_STAIRS_UP", "LOBBY_STAIRS_DOWN", "LOBBY_UP_LANDING", "LOBBY_DOWN_LANDING",
    "buildLobby", "lobbyTileAt", "stationNear",
    "sanitizeHeartbeat", "sanitizePresenceSpace", "parsePresenceEntry", "selectVisiblePlayers",
    "SAVE_VERSION", "serializeSave", "parseSave",
    "BOARD_MAX_POSTS", "BOARD_TEXT_MAX", "sanitizeBoardText", "parseBoardPosts", "appendBoardPost",
  ],
);

const lobby = wb.buildLobby();
const tile = (x, y) => wb.lobbyTileAt(lobby.tiles, x, y);

// ---------- ロビー外形（図形の和集合） ----------

test("lobby: 寸法は 126×64 で、タイル配列が一致する", () => {
  assert.equal(wb.LOBBY_W, 126);
  assert.equal(wb.LOBBY_H, 64);
  assert.equal(lobby.tiles.length, 126 * 64);
  // moveMap はタイル源（範囲外は岩＝固体）
  assert.equal(lobby.moveMap.tileAt(-1, 0), wb.T_ROCK);
  assert.equal(lobby.moveMap.tileAt(126, 0), wb.T_ROCK);
});

test("lobby: 中央は大円の広場（内側は歩行可、リングが縁取る）", () => {
  assert.equal(tile(28, 20), wb.L_PLAZA);
  assert.equal(tile(28, 13), wb.L_RING); // 円の北端はリング
  assert.equal(lobby.moveMap.tileAt(28, 20), wb.T_GRASS); // 歩行可
  // 噴水の場所は固体オブジェクトで塞がれている
  assert.ok(lobby.blocked.has("28,24"));
});

test("lobby: 図形の外は無効（VOID）、境界セルは壁", () => {
  assert.equal(tile(0, 0), wb.L_VOID);
  assert.equal(tile(55, 43), wb.L_VOID);
  assert.equal(tile(40, 60), wb.L_VOID); // 2階の外
  assert.equal(tile(28, 45), wb.L_VOID); // 1階と2階の間の帯
  assert.equal(tile(-1, 24), wb.L_VOID); // グリッド外
  assert.equal(tile(2, 24), wb.L_WALL); // ショップ翼の西端
  assert.equal(tile(28, 0), wb.L_WALL); // アプスの頂点
  assert.equal(tile(53, 19), wb.L_WALL); // カジノ翼の東端（通路の開口の外）
  // 壁と無効は moveMap でも固体
  assert.equal(lobby.moveMap.tileAt(2, 24), wb.T_ROCK);
  assert.equal(lobby.moveMap.tileAt(0, 0), wb.T_ROCK);
});

test("lobby: ゾーンごとの床（カジノ=カーペット、ショップ=木、鍛冶屋=ダーク、2階=チェック、闘技場=砂）", () => {
  assert.equal(tile(45, 24), wb.L_CARPET);
  assert.equal(tile(10, 22), wb.L_WOOD);
  assert.equal(tile(28, 37), wb.L_DARK);
  assert.equal(tile(10, 52), wb.L_CHECK);
  assert.equal(tile(28, 6), wb.L_SAND);
  // 床種は拡張可能な列挙で、スプライトか平色のどちらかで必ず描ける
  for (const id of [wb.L_WALL, wb.L_MARBLE, wb.L_PLAZA, wb.L_RING, wb.L_CARPET, wb.L_WOOD, wb.L_SAND, wb.L_DARK, wb.L_CHECK]) {
    assert.ok(id in wb.LOBBY_FLOOR_SPRITE, `床 ${id} のスプライト対応が無い`);
    assert.ok(typeof wb.LOBBY_FLOOR_FALLBACK[id] === "string", `床 ${id} の平色が無い`);
  }
});

// ---------- オブジェクト配置 ----------

test("lobby: オブジェクトに重なりが無く、全て壁・無効でない床の上にあり、グリッド内にある", () => {
  const seen = new Set();
  for (const o of wb.LOBBY_OBJECTS) {
    assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.w <= wb.LOBBY_W && o.y + o.h <= wb.LOBBY_H, `範囲外: ${o.sprite} ${o.x},${o.y}`);
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        const key = `${o.x + dx},${o.y + dy}`;
        assert.ok(!seen.has(key), `重なり: ${key} (${o.sprite})`);
        seen.add(key);
        const t = tile(o.x + dx, o.y + dy);
        assert.ok(t !== wb.L_WALL && t !== wb.L_VOID, `壁・無効の上に置かれている: ${o.sprite} ${key}`);
      }
    }
  }
  // 固体オブジェクトは blocked と一致する（座席は上に乗って座るため除く）
  let solidTiles = 0;
  for (const o of wb.LOBBY_OBJECTS) {
    if (o.solid && !["bench", "chair", "sofa"].includes(o.sprite)) solidTiles += o.w * o.h;
  }
  assert.equal(lobby.blocked.size, solidTiles);
  // ベンチ・ソファのマスは blocked に入っていない（座れる）
  for (const o of wb.LOBBY_OBJECTS) {
    if (["bench", "chair", "sofa"].includes(o.sprite)) {
      assert.equal(lobby.blocked.has(`${o.x},${o.y}`), false, `${o.sprite} が固体になっている`);
    }
  }
});

test("lobby: 7つのステーションが全て存在し、隣接で検出できる", () => {
  const cases = [
    ["board", 28, 16],
    ["guild", 24, 16],
    ["bank", 34, 18],
    ["shop", 5, 21],
    ["casino", 44, 20],
    ["arena", 28, 12],
    ["smith", 28, 37],
  ];
  for (const [station, x, y] of cases) {
    assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, x, y), station, `${station} が検出できない`);
    assert.ok(wb.LOBBY_OBJECTS.some((o) => o.station === station), `${station} のオブジェクトが無い`);
  }
  // 広場の真ん中（噴水の南）では何も検出しない
  assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, 24, 28), null);
});

test("lobby: 店員NPCはカウンターの背面に立ち、当たり判定が無い", () => {
  assert.ok(wb.LOBBY_NPCS.length >= 4);
  const counterTiles = new Set();
  for (const o of wb.LOBBY_OBJECTS) {
    if (o.sprite !== "shop_counter") continue;
    for (let dy = 0; dy < o.h; dy++) for (let dx = 0; dx < o.w; dx++) counterTiles.add(`${o.x + dx},${o.y + dy}`);
  }
  for (const n of wb.LOBBY_NPCS) {
    assert.ok(!lobby.blocked.has(`${n.x},${n.y}`), `NPCが固体タイルにいる: ${n.x},${n.y}`);
    const t = tile(n.x, n.y);
    assert.ok(t !== wb.L_WALL && t !== wb.L_VOID);
    const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => counterTiles.has(`${n.x + dx},${n.y + dy}`));
    assert.ok(adjacent, `NPC ${n.x},${n.y} の隣にカウンターが無い`);
  }
  // 自販機はショップ翼（x<20, y<31）に置かない
  assert.ok(!wb.LOBBY_OBJECTS.some((o) => o.sprite === "vending" && o.x < 20 && o.y < 31), "ショップ翼に自販機がある");
});

test("lobby: ワープパッドと階段は歩行可タイルで、着地点も立てる", () => {
  const walkable = (x, y) => {
    const t = tile(x, y);
    return t !== wb.L_WALL && t !== wb.L_VOID && !lobby.blocked.has(`${x},${y}`);
  };
  assert.ok(walkable(wb.LOBBY_WARP_PAD.x, wb.LOBBY_WARP_PAD.y));
  for (const s of [...wb.LOBBY_STAIRS_UP, ...wb.LOBBY_STAIRS_DOWN]) assert.ok(walkable(s.x, s.y), `階段 ${s.x},${s.y}`);
  assert.ok(walkable(Math.floor(wb.LOBBY_ENTRY.x), Math.floor(wb.LOBBY_ENTRY.y)));
  assert.ok(walkable(Math.floor(wb.LOBBY_UP_LANDING.x), Math.floor(wb.LOBBY_UP_LANDING.y)));
  assert.ok(walkable(Math.floor(wb.LOBBY_DOWN_LANDING.x), Math.floor(wb.LOBBY_DOWN_LANDING.y)));
  // ワールド側に固定パッドは無い（ロビー行きは ≡ メニューから）
  assert.ok(!("WORLD_WARP_PAD" in wb), "ワールド側の固定ワープパッドが残っている");
});

// ---------- 到達可能性 ----------

function reachableFrom(sx, sy) {
  const W = wb.LOBBY_W;
  const H = wb.LOBBY_H;
  const walk = (x, y) =>
    x >= 0 && y >= 0 && x < W && y < H &&
    lobby.moveMap.tileAt(x, y) !== wb.T_ROCK && !lobby.blocked.has(`${x},${y}`);
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length > 0) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (walk(nx, ny) && !seen.has(key)) {
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  return seen;
}

test("lobby: 入場点から全ゾーンへ歩いて届く", () => {
  const reach = reachableFrom(28, 32);
  const targets = {
    掲示板: [28, 16],
    銀行: [34, 18],
    ショップ: [5, 21],
    カジノ: [44, 20],
    闘技場の土俵: [28, 5],
    鍛冶屋: [28, 37],
    階段: [17, 29],
    ワープパッド: [28, 34],
  };
  for (const [name, [x, y]] of Object.entries(targets)) {
    assert.ok(reach.has(`${x},${y}`), `${name} (${x},${y}) に届かない`);
  }
});

// ---------- 競馬場（カジノ翼の東の拡張） ----------

test("lobby: 競馬場エリアは 66×44 の大エリアで、通路がカジノ東壁を開ける", () => {
  assert.equal(wb.RACECOURSE.x1 - wb.RACECOURSE.x0 + 1, 66);
  assert.equal(wb.RACECOURSE.y1 - wb.RACECOURSE.y0 + 1, 44);
  // カジノ翼の東壁は通路の高さ（y 22〜26）だけ開き、それ以外は壁のまま
  for (const y of [22, 23, 24, 25, 26]) {
    assert.notEqual(tile(53, y), wb.L_WALL, `カジノ東壁 (${53},${y}) が開いていない`);
    assert.equal(tile(56, y), wb.L_CARPET, `通路 (${56},${y}) がカーペットでない`);
  }
  assert.equal(tile(54, 21), wb.L_WALL); // 通路の北側壁
  assert.equal(tile(54, 27), wb.L_WALL); // 通路の南側壁
  // 競馬場の外周は壁、外は無効
  assert.equal(tile(93, 4), wb.L_WALL);
  assert.equal(tile(125, 26), wb.L_WALL);
  assert.equal(tile(93, 3), wb.L_VOID);
  assert.equal(tile(126 - 1, 60), wb.L_VOID); // 競馬場の南は従来どおり無効帯
});

test("lobby: トラックは楕円の砂の帯、内側はインフィールド", () => {
  assert.equal(tile(93, 8), wb.L_SAND); // 北直線のトラック
  assert.equal(tile(93, 44), wb.L_SAND); // 南直線のトラック
  assert.equal(tile(64, 26), wb.L_SAND); // 西直線のトラック
  assert.ok(wb.isRaceTrackTile(93, 8) && wb.isRaceTrackTile(122, 26));
  assert.equal(tile(93, 26), wb.L_PLAZA); // インフィールド中央
  assert.ok(wb.isRaceInfieldTile(93, 26));
  assert.ok(!wb.isRaceInfieldTile(93, 8));
  // スタンド前のアプロンは大理石
  assert.equal(tile(93, 45), wb.L_MARBLE);
});

test("lobby: 競馬場の station race がカウンターと掲示板で検出できる", () => {
  assert.ok(wb.LOBBY_OBJECTS.some((o) => o.station === "race"), "race のオブジェクトが無い");
  assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, 71, 25), "race"); // 馬券カウンターの正面（西）
  assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, 71, 21), "race"); // 結果掲示板の正面（西）
  assert.equal(wb.stationNear(wb.LOBBY_OBJECTS, 60, 21), "race"); // 入口の看板の正面
});

test("lobby: 入場点から通路を通って競馬場の各所へ歩いて届く", () => {
  const reach = reachableFrom(28, 32);
  const targets = {
    通路: [56, 24],
    競馬場の入口: [62, 24],
    馬券カウンター前: [71, 25],
    結果掲示板前: [71, 21],
    インフィールド中央: [93, 26],
    パドック: [107, 25],
    南スタンド前: [93, 45],
    競馬場の東端: [124, 26],
    "東スタンド前（北）": [123, 18],
    "東スタンド前（南）": [123, 34],
    インフィールド南の小道: [93, 37],
    厩舎の入口: [120, 39],
    厩舎内部: [120, 41],
    厩舎の餌場前: [117, 43],
  };
  for (const [name, [x, y]] of Object.entries(targets)) {
    assert.ok(reach.has(`${x},${y}`), `${name} (${x},${y}) に届かない`);
  }
});

test("lobby: 競馬場に厩舎と東・南スタンド増設、インフィールド南の植栽がある", () => {
  const at = (x, y) => wb.LOBBY_OBJECTS.find((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
  // 厩舎は柵囲いで、北側の入口（x120〜121）だけが開いている
  assert.equal(at(116, 39)?.sprite, "fence_wood");
  assert.equal(at(115, 42)?.sprite, "fence_wood");
  assert.equal(at(120, 45)?.sprite, "fence_wood");
  assert.equal(at(124, 42)?.sprite, "fence_wood");
  assert.ok(!lobby.blocked.has("120,39") && !lobby.blocked.has("121,39"), "厩舎の入口が塞がれている");
  assert.equal(at(114, 39)?.sprite, "sign_board"); // 厩舎の看板
  assert.equal(at(116, 44)?.sprite, "crate"); // 餌置き場
  assert.equal(at(123, 40)?.sprite, "workbench"); // 手入れ台
  // 東スタンドは縦列、南スタンドは延長＋両翼2列目
  assert.equal(at(124, 18)?.sprite, "bench");
  assert.equal(at(124, 34)?.sprite, "bench");
  assert.equal(at(80, 46)?.sprite, "bench");
  assert.equal(at(105, 45)?.sprite, "bench");
  // インフィールド南の植栽（生垣と植木）
  assert.equal(at(84, 36)?.sprite, "hedge");
  assert.equal(at(93, 34)?.sprite, "lamp");
  assert.equal(at(89, 38)?.sprite, "planter");
});

test("lobby: 2階は階段着地点から区画と下り階段へ届く（1階とは地続きでない）", () => {
  const reach2 = reachableFrom(17, 60);
  assert.ok(reach2.has("4,52"), "2階の屋台区画に届かない");
  assert.ok(reach2.has("17,62"), "2階の下り階段に届かない");
  assert.ok(!reach2.has("28,32"), "2階から1階へ歩けてしまう");
  const reach1 = reachableFrom(28, 32);
  assert.ok(!reach1.has("17,60"), "1階から2階へ歩けてしまう");
});

// ---------- セーブ v6（ロビー空間） ----------

test("save v6: ロビー位置と帰還点の往復、ロビー範囲でクランプ", () => {
  const state = { space: "lobby", x: 28.5, y: 32.5, worldReturn: { x: 514.5, y: 512.5 } };
  assert.deepEqual(wb.parseSave(wb.serializeSave(state)), state);
  const clamped = wb.parseSave(wb.serializeSave({ space: "lobby", x: 9999, y: -3, worldReturn: null }));
  assert.ok(clamped.x <= wb.LOBBY_W - 0.5 && clamped.y >= 0.5);
  // 壊れた帰還点は null に落ち、位置は残る
  const bad = wb.parseSave(JSON.stringify({ version: 6, space: "lobby", x: 10, y: 10, worldReturn: { x: "a" } }));
  assert.equal(bad.worldReturn, null);
  assert.equal(bad.space, "lobby");
  // 空間の無い v5 は破棄（トップダウン側のテストと対）
  assert.equal(wb.parseSave(JSON.stringify({ version: 5, x: 28.5, y: 32.5 })), null);
});

// ---------- プレゼンスの空間 ----------

test("presence: ハートビートの空間（lobby は保持、不正と省略は world）", () => {
  const bounds = { width: 56, height: 64 };
  assert.equal(wb.sanitizeHeartbeat({ x: 1, y: 1, space: "lobby" }, bounds).space, "lobby");
  assert.equal(wb.sanitizeHeartbeat({ x: 1, y: 1, space: "mars" }, bounds).space, "world");
  assert.equal(wb.sanitizeHeartbeat({ x: 1, y: 1 }, bounds).space, "world");
  assert.equal(wb.sanitizePresenceSpace("lobby"), "lobby");
  assert.equal(wb.sanitizePresenceSpace(null), "world");
  // 保存値の parse: 空間なしは world、ありは保持
  const now = Date.now();
  const old = wb.parsePresenceEntry("aaaa", JSON.stringify({ name: "n", x: 1, y: 1, vx: 0, vy: 0, face: 1, ts: now }));
  assert.equal(old.space, "world");
  const inLobby = wb.parsePresenceEntry("bbbb", JSON.stringify({ name: "n", x: 1, y: 1, vx: 0, vy: 0, face: 1, space: "lobby", ts: now }));
  assert.equal(inLobby.space, "lobby");
});

test("presence: 空間フィルタは同じ空間の者だけを返す", () => {
  const now = 1_700_000_000_000;
  const mk = (id, space) => ({ id, name: id, x: 1, y: 1, vx: 0, vy: 0, face: 1, space, ts: now });
  const entries = [mk("w1", "world"), mk("w2", "world"), mk("l1", "lobby")];
  assert.deepEqual(wb.selectVisiblePlayers(entries, null, now, 32, "world").map((e) => e.id), ["w1", "w2"]);
  assert.deepEqual(wb.selectVisiblePlayers(entries, null, now, 32, "lobby").map((e) => e.id), ["l1"]);
  assert.equal(wb.selectVisiblePlayers(entries, null, now).length, 3); // フィルタ無しは従来どおり
});

// ---------- 掲示板（純粋ロジック） ----------

test("board: 本文の検証（空・長すぎ・非文字列は null、空白は整形）", () => {
  assert.equal(wb.sanitizeBoardText("  こんにちは  "), "こんにちは");
  assert.equal(wb.sanitizeBoardText("a\nb"), "a b");
  assert.equal(wb.sanitizeBoardText(""), null);
  assert.equal(wb.sanitizeBoardText("   "), null);
  assert.equal(wb.sanitizeBoardText("x".repeat(wb.BOARD_TEXT_MAX)).length, wb.BOARD_TEXT_MAX);
  assert.equal(wb.sanitizeBoardText("x".repeat(wb.BOARD_TEXT_MAX + 1)), null);
  assert.equal(wb.sanitizeBoardText(42), null);
  assert.equal(wb.sanitizeBoardText(null), null);
});

test("board: 追加と parse（新しい順・30件で切り詰め・壊れた要素は落とす）", () => {
  let posts = [];
  for (let i = 0; i < 35; i++) posts = wb.appendBoardPost(posts, { name: "n", text: `post${i}`, at: 1000 + i });
  assert.equal(posts.length, wb.BOARD_MAX_POSTS);
  assert.equal(posts[0].text, "post34");
  assert.equal(posts[posts.length - 1].text, "post5");
  const parsed = wb.parseBoardPosts(JSON.stringify([
    { name: "a", text: "old", at: 100 },
    { name: "b", text: "new", at: 200 },
    { name: "c", text: "", at: 300 },
    "garbage",
    { text: "noname", at: 400 },
  ]));
  assert.deepEqual(parsed.map((p) => p.text), ["new", "old"]);
  assert.deepEqual(wb.parseBoardPosts("{壊れた"), []);
  assert.deepEqual(wb.parseBoardPosts(null), []);
});

// ---------- API（プレゼンス空間・掲示板） ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
globalThis.__wbLobbyStore = store;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyModUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const tentModUrl = dataUrl(
  transpile("worldbox/tent.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)).replaceAll('"./lobby"', JSON.stringify(lobbyModUrl)),
);
const floorsModUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyModUrl)),
);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyModUrl))
    .replaceAll('"./tent"', JSON.stringify(tentModUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
);
const boardUrl = dataUrl(transpile("worldbox/board.ts"));
const boardOnlineUrl = dataUrl(
  transpile("worldbox/board-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./board"', JSON.stringify(boardUrl)),
);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const metricsOnlineStubUrl = dataUrl(`
export async function recordPresenceMetric() {}
export async function recordFirstStep() {}
export async function bumpMetric() {}
export async function loadDayMetrics() { return null; }
export async function loadUserFirstSteps() { return null; }
export async function loadEconDay() { return null; }
`);
const presenceRoute = await import(
  dataUrl(
    transpile("api/worldbox/presence/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/lobby"', JSON.stringify(lobbyModUrl))
      .replaceAll('"@/lib/worldbox/lobby-floors"', JSON.stringify(floorsModUrl))
      .replaceAll('"@/lib/worldbox/tent"', JSON.stringify(tentModUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/metrics-online"', JSON.stringify(metricsOnlineStubUrl)),
  ),
);
const stationStubUrl = dataUrl(`
export async function loadMyLobbyStation() { return "board"; }
`);
const boardRoute = await import(
  dataUrl(
    transpile("api/worldbox/board/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/board"', JSON.stringify(boardUrl))
      .replaceAll('"@/lib/worldbox/board-online"', JSON.stringify(boardOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationStubUrl)),
  ),
);
const gateRoute = await import(
  dataUrl(
    transpile("api/worldbox/gate/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "lobby", "test", "secret"].join("-");
function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}
function apiRequest(url, method, cookie, body, headers = {}) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("API(presence): 空間ごとに分けて返し、既定は world", async () => {
  const cookieW = sessionCookie("611111111111111111", "world-user");
  const cookieL = sessionCookie("622222222222222222", "lobby-user");
  assert.equal((await presenceRoute.PUT(apiRequest("http://localhost/api/worldbox/presence", "PUT", cookieW, { x: 100, y: 100, space: "world" }))).status, 200);
  assert.equal((await presenceRoute.PUT(apiRequest("http://localhost/api/worldbox/presence", "PUT", cookieL, { x: 28.5, y: 32.5, space: "lobby" }))).status, 200);
  const worldSeen = await (await presenceRoute.GET(apiRequest("http://localhost/api/worldbox/presence?space=world", "GET", null))).json();
  assert.deepEqual(worldSeen.players.map((p) => p.name), ["world-user"]);
  assert.equal(worldSeen.players[0].space, "world");
  const lobbySeen = await (await presenceRoute.GET(apiRequest("http://localhost/api/worldbox/presence?space=lobby", "GET", null))).json();
  assert.deepEqual(lobbySeen.players.map((p) => p.name), ["lobby-user"]);
  assert.equal(lobbySeen.players[0].space, "lobby");
  const defaultSeen = await (await presenceRoute.GET(apiRequest("http://localhost/api/worldbox/presence", "GET", null))).json();
  assert.deepEqual(defaultSeen.players.map((p) => p.name), ["world-user"]);
});

test("API(board): ゲストは読めるが書けない、投稿はセッション名で新しい順", async () => {
  const url = "http://localhost/api/worldbox/board";
  const guest = await (await boardRoute.GET(apiRequest(url, "GET", null))).json();
  assert.deepEqual(guest.posts, []);
  assert.equal(guest.loggedIn, false);
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", null, { text: "hi" }))).status, 401);
  const cookie = sessionCookie("633333333333333333", "board-user");
  const posted = await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "  ロビー着いた  " }));
  assert.equal(posted.status, 200);
  const after = await (await boardRoute.GET(apiRequest(url, "GET", null))).json();
  assert.equal(after.posts.length, 1);
  assert.equal(after.posts[0].name, "board-user");
  assert.equal(after.posts[0].text, "ロビー着いた");
});

test("API(board): 不正な本文は 400、他オリジンは 403、上限30件で切り詰める", async () => {
  const url = "http://localhost/api/worldbox/board";
  const cookie = sessionCookie("644444444444444444", "board-user-2");
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "" }))).status, 400);
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "x".repeat(121) }))).status, 400);
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", cookie, { text: 42 }))).status, 400);
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "ok" }, { origin: "http://evil.example" }))).status, 403);
  // 連投制限（同一ユーザーは 1.5 秒間隔）があるため、上限の検証は
  // 投稿者を変えながら行う（掲示板の蓄積は全体で数える）。
  for (let i = 0; i < 35; i++) {
    const capCookie = sessionCookie(`65${String(i).padStart(16, "0")}`, `cap-user-${i}`);
    assert.equal((await boardRoute.POST(apiRequest(url, "POST", capCookie, { text: `cap${i}` }))).status, 200);
  }
  const after = await (await boardRoute.GET(apiRequest(url, "GET", null))).json();
  assert.equal(after.posts.length, wb.BOARD_MAX_POSTS);
  assert.equal(after.posts[0].text, "cap34");
});

test("API(board): 同一ユーザーの連投は 429（チャットと同じ最小間隔）", async () => {
  const url = "http://localhost/api/worldbox/board";
  const cookie = sessionCookie("666666666666666666", "board-user-3");
  assert.equal((await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "first" }))).status, 200);
  const second = await boardRoute.POST(apiRequest(url, "POST", cookie, { text: "second" }));
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "too_fast");
});

test("API(gate): Discord セッションだけが入場でき、ゲストと Google は不可", async () => {
  const url = "http://localhost/api/worldbox/gate";
  const guest = await (await gateRoute.GET(apiRequest(url, "GET", null))).json();
  assert.equal(guest.allowed, false);
  const googleCookie = `ago_session=${encodeURIComponent(auth.createSession({ id: "g-123", username: "g-user", provider: "google" }))}`;
  const google = await (await gateRoute.GET(apiRequest(url, "GET", googleCookie))).json();
  assert.equal(google.allowed, false, "Google セッションで入場できてしまう");
  const discordCookie = sessionCookie("655555555555555555", "d-user");
  const discord = await (await gateRoute.GET(apiRequest(url, "GET", discordCookie))).json();
  assert.equal(discord.allowed, true);
  const forged = await (await gateRoute.GET(apiRequest(url, "GET", "ago_session=forged.value"))).json();
  assert.equal(forged.allowed, false);
});

// ---------- クライアント配線 ----------

test("クライアント: 入場ゲート（未ログインではワールドを描かず、Discord ログインを出す）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("/api/worldbox/gate"), "ゲート判定を使っていない");
  assert.ok(client.includes("ログインが必要"), "ログインゲートの文言が無い");
  assert.ok(client.includes("Discordでログイン"), "Discord ログインボタンが無い");
  assert.ok(client.includes("/api/auth/discord/authorize?next=/games/worldbox"), "ログイン導線が無い");
  assert.ok(!client.includes("ゲスト"), "ゲスト表記が残っている");
});

test("クライアント: ハンバーガーはデータ駆動のアクションリスト（ワープ・設定トグル）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("menuActions"), "アクションリストが無い");
  assert.ok(client.includes('id: "warp"'), "ワープのアクションが無い");
  assert.ok(client.includes('id: "map"'), "マップ切替のアクションが無い");
  // 合成は経済パネルの合成タブ（作業台の前だけ）に一本化。空のクラフト器は置かない
  assert.ok(!client.includes('id: "craft"'), "空のクラフトアクションが残っている");
  assert.ok(!client.includes("作れるものはまだない"), "空のクラフトパネルが残っている");
});

test("クライアント: ハンバーガーメニューと空間ワープがある", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("≡"), "ハンバーガーボタンが無い");
  assert.ok(client.includes("ロビーへ行く"), "ロビーへの導線が無い");
  assert.ok(client.includes("ワールドへ戻る"), "ワールドへの導線が無い");
  assert.ok(client.includes("ago-worldbox-save-v6"), "セーブキーが v6 でない");
  assert.ok(client.includes("LOBBY_WARP_PAD"), "ロビー側ワープパッド判定が無い");
  assert.ok(!client.includes("WORLD_WARP_PAD"), "ワールド側の固定ワープパッドが残っている");
  assert.ok(client.includes("LOBBY_STAIRS_UP") && client.includes("LOBBY_STAIRS_DOWN"), "階段判定が無い");
});

test("クライアント: ロビー描画はピクセル固定（整数カメラ・補間オフ）で、ミニマップはロビーで隠す", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("Math.round(cw / 2 - cam.x * TILE)"), "ロビーの整数カメラが無い");
  assert.ok(client.includes("Math.round(ch / 2 - cam.y * TILE)"), "ロビーの整数カメラ（縦）が無い");
  assert.ok(client.includes("imageSmoothingEnabled = false"), "補間オフが無い");
  assert.ok(client.includes('showMap && spaceUi === "world"'), "ミニマップがロビーでも出る");
  assert.ok(client.includes('space === "world" && showMapRef.current'), "ミニマップ描画がロビーでも走る");
  assert.ok(client.includes("loadLobbySprites"), "ロビースプライトを読み込んでいない");
  assert.ok(client.includes("indoorData().npcs"), "店員NPCを描いていない");
});

test("クライアント: プレゼンスは空間つきで送受信し、掲示板パネルがある", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("presence?space=${space}"), "プレゼンス取得に空間が無い");
  assert.ok(client.includes("/api/worldbox/board"), "掲示板 API を使っていない");
  assert.ok(client.includes("グローバル掲示板"), "掲示板パネルが無い");
  assert.ok(client.includes("STATION_LABEL"), "ステーション名札が無い");
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.ok(textures.includes("loadLobbySprites"), "テクスチャ側にロビー読み込みが無い");
  // ローダーが指すスプライトファイルは全て実在する
  const srcRe = /\/img\/worldbox\/lobby\/([a-z0-9_]+\.png)/g;
  const files = new Set();
  for (const m of textures.matchAll(srcRe)) files.add(m[1]);
  assert.ok(files.size >= 30, `ロビースプライトの定義が少ない: ${files.size}`);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(rootDir, "public/img/worldbox/lobby", f)), `スプライトが無い: ${f}`);
  }
});
