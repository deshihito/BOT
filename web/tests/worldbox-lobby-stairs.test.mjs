// AGO WORLD BOX ロビー階段遷移（L2b）の検証:
// - 1F の新階段（LOBBY_STAIRS_2F、ギルドショップ区画の東の階段室の続き）は
//   歩行可能で、擬似2F の着地点から歩いて届く
// - floorWarpAt が 1F⇄2F⇄3F の対応を返し、着地点は行き先の階段の前で
//   階段タイル自身ではない（着地で再発火しない）
// - 往復の各ステップでセーブ（v6）が空間と座標をそのまま保持する（復帰が壊れない）
// - relay-core.js が lobby2/lobby3 を潰さず、階の境界で丸め、空間ごとに分離する
// - クライアント（WorldBoxClient.tsx）が階データを indoorData / 境界 / 描画へ配線し、
//   階段判定をフェード遷移（beginTransition 経由の doFloorWarp）で実行する
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

const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floors = await import(floorsUrl);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const save = await import(saveUrl);

// ---------- 到達可能性の道具（floors テストと同じ歩行可能定義） ----------

function walkableTiles(data) {
  const out = new Set();
  for (let y = 0; y < data.height; y++) {
    for (let x = 0; x < data.width; x++) {
      const id = data.tiles[y * data.width + x];
      if (id !== 0 && id !== 1 && !data.blocked.has(`${x},${y}`)) out.add(`${x},${y}`);
    }
  }
  return out;
}
function reachableFrom(data, sx, sy) {
  const walk = walkableTiles(data);
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const k = `${nx},${ny}`;
      if (walk.has(k) && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}
const tileOf = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
const keyOf = (p) => `${p.x},${p.y}`;

// ---------- 1F の新階段 ----------

test("stairs: 1F の 2F への階段はギルドショップ区画にあり、歩行可能で着地点と対になる", () => {
  const data = lobby.buildLobby();
  const walk = walkableTiles(data);
  for (const s of lobby.LOBBY_STAIRS_2F) {
    assert.ok(walk.has(keyOf(s)), `1F の階段 ${keyOf(s)} が歩行不可`);
    // 階段オブジェクトは通過可（solid でない）の stairs スプライト
    const obj = data.objects.find((o) => o.x === s.x && o.y === s.y);
    assert.ok(obj && obj.sprite === "stairs" && obj.solid === false, `1F の階段 ${keyOf(s)} のオブジェクトが無い/固体`);
  }
  // 擬似2F の着地点（1F 階段を上がった先）から歩いて届く（階段室の続きとして成立する）
  const reach = reachableFrom(data, tileOf(lobby.LOBBY_UP_LANDING).x, tileOf(lobby.LOBBY_UP_LANDING).y);
  for (const s of lobby.LOBBY_STAIRS_2F) assert.ok(reach.has(keyOf(s)), `階段 ${keyOf(s)} に着地点から行けない`);
  // 2F から下りてくる着地点は階段の南隣で、階段タイル自身ではない（再発火しない）
  const landing = tileOf(lobby.LOBBY_2F_LANDING);
  assert.ok(walk.has(keyOf(landing)), "1F の着地点が歩行不可");
  assert.ok(reach.has(keyOf(landing)), "1F の着地点に着地点群から行けない");
  assert.equal(landing.y, lobby.LOBBY_STAIRS_2F[0].y + 1, "着地点が階段の前（南）でない");
  assert.ok(!lobby.LOBBY_STAIRS_2F.some((s) => s.x === landing.x && s.y === landing.y), "着地点が階段タイルと重なる");
  // 既存の導線と重ならない（擬似2F の階段・ワープパッド）
  for (const s of lobby.LOBBY_STAIRS_2F) {
    assert.ok(!lobby.LOBBY_STAIRS_UP.some((t) => t.x === s.x && t.y === s.y), "擬似2F への階段と重なる");
    assert.ok(!lobby.LOBBY_STAIRS_DOWN.some((t) => t.x === s.x && t.y === s.y), "擬似2F からの階段と重なる");
    assert.ok(!(lobby.LOBBY_WARP_PAD.x === s.x && lobby.LOBBY_WARP_PAD.y === s.y), "ワープパッドと重なる");
  }
});

// ---------- floorWarpAt: 対応表 ----------

test("stairs: floorWarpAt は 1F⇄2F⇄3F の階段だけを対応付け、他は null", () => {
  // 1F → 2F
  for (const s of lobby.LOBBY_STAIRS_2F) {
    assert.deepEqual(floors.floorWarpAt("lobby", s.x, s.y), { to: "lobby2", entry: floors.LOBBY2_ENTRY });
  }
  // 2F → 1F / 3F
  for (const s of floors.LOBBY2_STAIRS_DOWN) {
    assert.deepEqual(floors.floorWarpAt("lobby2", s.x, s.y), { to: "lobby", entry: lobby.LOBBY_2F_LANDING });
  }
  for (const s of floors.LOBBY2_STAIRS_UP) {
    assert.deepEqual(floors.floorWarpAt("lobby2", s.x, s.y), { to: "lobby3", entry: floors.LOBBY3_ENTRY });
  }
  // 3F → 2F
  for (const s of floors.LOBBY3_STAIRS_DOWN) {
    assert.deepEqual(floors.floorWarpAt("lobby3", s.x, s.y), { to: "lobby2", entry: floors.LOBBY2_UP_LANDING });
  }
  // 階段でないタイル・別空間では発火しない（擬似2F の階段とワープパッドは対象外）
  assert.equal(floors.floorWarpAt("lobby", lobby.LOBBY_ENTRY.x, lobby.LOBBY_ENTRY.y), null);
  for (const s of lobby.LOBBY_STAIRS_UP) assert.equal(floors.floorWarpAt("lobby", s.x, s.y), null, "擬似2F の階段が階移動になっている");
  for (const s of lobby.LOBBY_STAIRS_DOWN) assert.equal(floors.floorWarpAt("lobby", s.x, s.y), null, "擬似2F の階段が階移動になっている");
  assert.equal(floors.floorWarpAt("lobby", lobby.LOBBY_WARP_PAD.x, lobby.LOBBY_WARP_PAD.y), null, "ワープパッドが階移動になっている");
  assert.equal(floors.floorWarpAt("lobby2", 20, 14), null);
  assert.equal(floors.floorWarpAt("lobby3", 16, 13), null);
  assert.equal(floors.floorWarpAt("world", lobby.LOBBY_STAIRS_2F[0].x, lobby.LOBBY_STAIRS_2F[0].y), null);
  assert.equal(floors.floorWarpAt("tent", floors.LOBBY2_STAIRS_DOWN[0].x, floors.LOBBY2_STAIRS_DOWN[0].y), null);
});

test("stairs: 着地点は行き先の階段の前で歩行可能、かつその階の階段タイルではない", () => {
  const datas = { lobby: lobby.buildLobby(), lobby2: floors.buildLobby2(), lobby3: floors.buildLobby3() };
  const stairsOf = {
    lobby: [...lobby.LOBBY_STAIRS_UP, ...lobby.LOBBY_STAIRS_DOWN, ...lobby.LOBBY_STAIRS_2F],
    lobby2: [...floors.LOBBY2_STAIRS_DOWN, ...floors.LOBBY2_STAIRS_UP],
    lobby3: [...floors.LOBBY3_STAIRS_DOWN],
  };
  const trips = [
    { from: "lobby", at: lobby.LOBBY_STAIRS_2F[0] },
    { from: "lobby2", at: floors.LOBBY2_STAIRS_DOWN[0] },
    { from: "lobby2", at: floors.LOBBY2_STAIRS_UP[0] },
    { from: "lobby3", at: floors.LOBBY3_STAIRS_DOWN[0] },
  ];
  for (const trip of trips) {
    const warp = floors.floorWarpAt(trip.from, trip.at.x, trip.at.y);
    assert.ok(warp, `${trip.from} (${trip.at.x},${trip.at.y}) の遷移が無い`);
    const dest = datas[warp.to];
    const landing = tileOf(warp.entry);
    assert.ok(walkableTiles(dest).has(keyOf(landing)), `${warp.to} の着地点 ${keyOf(landing)} が歩行不可`);
    assert.ok(
      !stairsOf[warp.to].some((s) => s.x === landing.x && s.y === landing.y),
      `${warp.to} の着地点がその階の階段タイルと重なる（着地で再発火する）`,
    );
    // 着地点から行き先の全階段へ歩いて戻れる（往復が成立する）
    const reach = reachableFrom(dest, landing.x, landing.y);
    for (const s of stairsOf[warp.to]) {
      // 1F の階段群は擬似2F で分断されるため、1F では 2F への階段だけを見る
      if (warp.to === "lobby" && !(s.x === lobby.LOBBY_STAIRS_2F[0].x || s.x === lobby.LOBBY_STAIRS_2F[1].x)) continue;
      if (warp.to === "lobby" && s.y !== lobby.LOBBY_STAIRS_2F[0].y) continue;
      assert.ok(reach.has(keyOf(s)), `${warp.to} の着地点から階段 ${keyOf(s)} へ戻れない`);
    }
  }
});

// ---------- セーブ往復（保存・復帰が壊れない） ----------

test("stairs: 1F→2F→3F→2F→1F の往復でセーブが空間と座標を保持する", () => {
  const worldReturn = { x: 512.5, y: 512.5 };
  const roundTrip = (space, x, y) => save.parseSave(save.serializeSave({ space, x, y, worldReturn }));
  // 往路: 1F の階段を踏む → 2F 入口 → 2F の上り階段 → 3F 入口
  let state = { space: "lobby", x: lobby.LOBBY_STAIRS_2F[0].x + 0.5, y: lobby.LOBBY_STAIRS_2F[0].y + 0.5 };
  let warp = floors.floorWarpAt(state.space, Math.floor(state.x), Math.floor(state.y));
  state = { space: warp.to, x: warp.entry.x, y: warp.entry.y };
  let restored = roundTrip(state.space, state.x, state.y);
  assert.deepEqual([restored.space, restored.x, restored.y], ["lobby2", floors.LOBBY2_ENTRY.x, floors.LOBBY2_ENTRY.y]);
  assert.deepEqual(restored.worldReturn, worldReturn, "階移動で worldReturn が壊れた");
  state = { space: "lobby2", x: floors.LOBBY2_STAIRS_UP[1].x + 0.5, y: floors.LOBBY2_STAIRS_UP[1].y + 0.5 };
  warp = floors.floorWarpAt(state.space, Math.floor(state.x), Math.floor(state.y));
  state = { space: warp.to, x: warp.entry.x, y: warp.entry.y };
  restored = roundTrip(state.space, state.x, state.y);
  assert.deepEqual([restored.space, restored.x, restored.y], ["lobby3", floors.LOBBY3_ENTRY.x, floors.LOBBY3_ENTRY.y]);
  // 復路: 3F の下り階段 → 2F 南踊り場 → 2F の下り階段 → 1F 着地点
  state = { space: "lobby3", x: floors.LOBBY3_STAIRS_DOWN[0].x + 0.5, y: floors.LOBBY3_STAIRS_DOWN[0].y + 0.5 };
  warp = floors.floorWarpAt(state.space, Math.floor(state.x), Math.floor(state.y));
  state = { space: warp.to, x: warp.entry.x, y: warp.entry.y };
  restored = roundTrip(state.space, state.x, state.y);
  assert.deepEqual([restored.space, restored.x, restored.y], ["lobby2", floors.LOBBY2_UP_LANDING.x, floors.LOBBY2_UP_LANDING.y]);
  state = { space: "lobby2", x: floors.LOBBY2_STAIRS_DOWN[0].x + 0.5, y: floors.LOBBY2_STAIRS_DOWN[0].y + 0.5 };
  warp = floors.floorWarpAt(state.space, Math.floor(state.x), Math.floor(state.y));
  state = { space: warp.to, x: warp.entry.x, y: warp.entry.y };
  restored = roundTrip(state.space, state.x, state.y);
  assert.deepEqual([restored.space, restored.x, restored.y], ["lobby", lobby.LOBBY_2F_LANDING.x, lobby.LOBBY_2F_LANDING.y]);
  assert.deepEqual(restored.worldReturn, worldReturn, "往復で worldReturn が壊れた");
});

// ---------- 中継（relay-core.js） ----------

test("relay: lobby2/lobby3 を空間として保持し、未知の階はワールドに寄せる", () => {
  assert.equal(relay.sanitizeSpace("lobby2"), "lobby2");
  assert.equal(relay.sanitizeSpace("lobby3"), "lobby3");
  assert.equal(relay.sanitizeSpace("lobby"), "lobby");
  assert.equal(relay.sanitizeSpace("lobby4"), "world");
  assert.deepEqual(relay.boundsForSpace("lobby2"), { minX: 0, maxX: 40, minY: 0, maxY: 28 });
  assert.deepEqual(relay.boundsForSpace("lobby3"), { minX: 0, maxX: 32, minY: 0, maxY: 24 });
});

test("relay: 2F/3F のハートビートは階の範囲へ丸められ、空間ごとに分離される", () => {
  const room = relay.createRoom();
  const now = 1_000_000;
  const e2 = relay.acceptHeartbeat(room, "p2", "floor2", { x: 999, y: -5, vx: 0, vy: 0, face: 1, space: "lobby2" }, now);
  assert.equal(e2.space, "lobby2");
  assert.deepEqual([e2.x, e2.y], [40, 0]);
  relay.acceptHeartbeat(room, "p3", "floor3", { x: 16, y: 13, vx: 0, vy: 0, face: 1, space: "lobby3" }, now);
  assert.deepEqual(relay.snapshot(room, "lobby2", "self", now).map((e) => e.id), ["p2"]);
  assert.deepEqual(relay.snapshot(room, "lobby3", "self", now).map((e) => e.id), ["p3"]);
  assert.deepEqual(relay.snapshot(room, "lobby", "self", now), []);
  // 階を移動したら旧空間の表から消える
  relay.acceptHeartbeat(room, "p2", "floor2", { x: 15, y: 5, vx: 0, vy: 0, face: 1, space: "lobby3" }, now + 1000);
  assert.deepEqual(relay.snapshot(room, "lobby2", "self", now + 1000), []);
  assert.deepEqual(relay.snapshot(room, "lobby3", "self", now + 1000).map((e) => e.id).sort(), ["p2", "p3"]);
});

// ---------- クライアント配線 ----------

test("client: 階データが indoorData / 境界 / 描画へ配線され、階段はフェード遷移で実行される", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /space === "lobby2" \? buildLobby2\(\) : space === "lobby3" \? buildLobby3\(\)/, "indoorData が 2F/3F を返していない");
  assert.match(client, /space === "lobby2" \? rectBounds\(LOBBY2_W, LOBBY2_H\)/, "2F の境界が無い");
  assert.match(client, /space === "lobby3" \? rectBounds\(LOBBY3_W, LOBBY3_H\)/, "3F の境界が無い");
  assert.match(client, /space === "lobby2" \? lobby2TileAt\(indoor\.tiles, tx, ty\)/, "2F の床描画が lobbyTileAt のまま");
  assert.match(client, /space === "lobby3" \? lobby3TileAt\(indoor\.tiles, tx, ty\)/, "3F の床描画が lobbyTileAt のまま");
  assert.match(client, /floorWarpAt\(space, tx, ty\)/, "階段判定（floorWarpAt）が配線されていない");
  assert.match(client, /const doFloorWarp = /, "階移動の実行（doFloorWarp）が無い");
  assert.match(client, /doFloorWarp\(floorWarp\.to, floorWarp\.entry\)/, "階段判定の結果が実行へ渡っていない");
  // フェード遷移（B1）経由であること: doFloorWarp は beginTransition の中で空間を切り替える
  const start = client.indexOf("const doFloorWarp");
  const body = client.slice(start, start + 900);
  assert.ok(body.includes("beginTransition(() => {"), "doFloorWarp が beginTransition を使っていない（ハードカットになる）");
  assert.ok(body.includes("setSpaceUi(target)"), "doFloorWarp が空間 state を切り替えていない");
  assert.ok(body.includes("placePlayer(entry.x, entry.y)"), "doFloorWarp が着地点へ置いていない");
  // 復帰時のステータス文言が階を持つ
  assert.match(client, /space === "lobby2" \? "ロビー 2F" : space === "lobby3" \? "ロビー 3F"/, "復帰時の階の文言が無い");
  // 1F の従来導線（ワープパッド・擬似2F）は 1F 限定に絞られている
  assert.match(client, /if \(space !== "lobby"\) return;/, "1F 導線が他階でも発火しうる");
});
