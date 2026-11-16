// AGO WORLD BOX ロビーのアーケード筐体パネル・ルーム起動（L4）の検証:
// - 全26筐体に station "arcade" とゲーム ID が付き、ARCADE_GAMES と一致する
// - 筐体の前に立つと stationNear が "arcade"、stationArcadeNear がそのゲームを返す
// - 全タイトルがカタログで playable、かつ /games/<id> の振り分けに存在する
//   （パネルの遷移先が実在すること）
// - パネルは既存 online 基盤（作成/参加/public）を使い、セッションを
//   useOnlineRoom と同じ sessionStorage 形式で保存してから遷移する
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const appDir = path.join(rootDir, "app");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
async function loadLib(name) {
  return import(dataUrl(transpile(name)));
}

const arcade = await loadLib("worldbox/arcade.ts");
const catalog = await loadLib("games-catalog.ts");
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobby = await import(lobbyUrl);
const floorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floors = await import(floorsUrl);

const allCabinets = () =>
  [...floors.buildLobby2().objects, ...floors.buildLobby3().objects].filter((o) => o.sprite.startsWith("arcade_"));

test("panel: 全26筐体に station arcade とゲーム ID が付き、ARCADE_GAMES と過不足なく一致する", () => {
  const cabs = allCabinets();
  assert.equal(cabs.length, 26, `筐体が26台でない: ${cabs.length}`);
  for (const o of cabs) {
    assert.equal(o.station, "arcade", `${o.sprite} の station が arcade でない`);
    assert.equal(o.arcade, o.sprite.slice("arcade_".length), `${o.sprite} のゲーム ID が違う`);
    assert.ok(arcade.arcadeById(o.arcade), `${o.arcade} が ARCADE_GAMES に無い`);
  }
  assert.deepEqual(
    cabs.map((o) => o.arcade).sort(),
    arcade.ARCADE_GAMES.map((e) => e.id).sort(),
    "筐体のゲームと ARCADE_GAMES が一致しない",
  );
});

test("panel: 筐体の前に立つと stationNear=arcade / stationArcadeNear=そのゲームを返す", () => {
  for (const data of [floors.buildLobby2(), floors.buildLobby3()]) {
    for (const o of data.objects.filter((x) => x.sprite.startsWith("arcade_"))) {
      // 筐体の周囲（チェビシェフ距離1）で歩行可能なマスのうち、少なくとも
      // 1マスは「この筐体の前」として判定されること
      let found = null;
      for (let ty = o.y - 1; ty <= o.y + o.h && !found; ty++) {
        for (let tx = o.x - 1; tx <= o.x + o.w && !found; tx++) {
          const id = data.tiles[ty * data.width + tx];
          if (id === 0 || id === 1 || data.blocked.has(`${tx},${ty}`)) continue;
          if (lobby.stationArcadeNear(data.objects, tx, ty) === o.arcade) found = { tx, ty };
        }
      }
      assert.ok(found, `${o.sprite} の前に立っても stationArcadeNear が ${o.arcade} を返さない`);
      assert.equal(lobby.stationNear(data.objects, found.tx, found.ty), "arcade", `${o.sprite} の前で stationNear が arcade でない`);
    }
    // 入口（階段の着地点）はどの筐体の前でもない
    const entry = data === floors.buildLobby2() ? floors.LOBBY2_ENTRY : floors.LOBBY3_ENTRY;
    assert.equal(
      lobby.stationArcadeNear(data.objects, Math.floor(entry.x), Math.floor(entry.y)),
      null,
      "着地点で筐体判定が出てしまう",
    );
  }
});

test("panel: 全タイトルがカタログで playable で、遷移先 /games/<id> の振り分けが実在する", () => {
  const pageSrc = fs.readFileSync(path.join(appDir, "games/[id]/page.tsx"), "utf8");
  for (const e of arcade.ARCADE_GAMES) {
    const game = catalog.getWebGame(e.id);
    assert.ok(game, `${e.id} が games-catalog に無い（パネルのタイトルが引けない）`);
    assert.equal(game.status, "playable", `${e.id} が playable でない`);
    assert.ok(
      pageSrc.includes(`game.slug === "${e.id}"`),
      `${e.id} が app/games/[id]/page.tsx の振り分けに無い（遷移先が404になる）`,
    );
  }
});

test("panel: パネルは online 基盤へ作成/参加し、セッション保存後にゲームページへ遷移する", () => {
  const src = fs.readFileSync(path.join(appDir, "games/worldbox/WorldBoxArcadePanel.tsx"), "utf8");
  assert.match(src, /\/api\/online\/\$\{encodeURIComponent\(gameId\)\}/, "online API のベースが無い");
  assert.match(src, /`\$\{base\}\/rooms`/, "ルーム作成の POST 先が無い");
  assert.match(src, /`\$\{base\}\/rooms\/join`/, "ルーム参加の POST 先が無い");
  assert.match(src, /`\$\{base\}\/rooms\/public`/, "公開ルーム一覧の GET 先が無い");
  // useOnlineRoom と同じ保存形式（sessionStorage の online:<gameId> に {code, token}）
  assert.match(src, /sessionStorage\.setItem\(`online:\$\{gameId\}`, JSON\.stringify\(\{ code, token \}\)\)/, "セッション保存が useOnlineRoom の形式と違う");
  assert.match(src, /window\.location\.assign\(`\$\{prefix\}\/games\/\$\{gameId\}`\)/, "ゲームページへの遷移が無い");
  // 名前は OnlineShell と同じ保存キーで共有する
  assert.match(src, /"online-display-name"/, "表示名の共有キーが無い");
});

test("panel: クライアント配線（チップの名前札・遊ぶボタン・パネル描画・離脱で閉じる）", () => {
  const src = fs.readFileSync(path.join(appDir, "games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(src, /arcade: "アーケード"/, "STATION_LABEL に arcade が無い");
  assert.match(src, /stationArcadeNear\(indoorData\(\)\.objects, tx, ty\)/, "フレームループで stationArcadeNear を引いていない");
  assert.match(src, /stationUi === "arcade" && stationArcade/, "チップの名前札が筐体のゲーム名になっていない");
  assert.match(src, /stationUi === "arcade" && \(/, "チップにアーケードのボタンが無い");
  assert.match(src, /setArcadeOpen\(\(v\) => !v\)/, "チップのボタンがパネルを開閉しない");
  assert.match(src, /if \(stationUi !== "arcade"\) setArcadeOpen\(false\)/, "筐体から離れたらパネルが閉じない");
  assert.match(src, /arcadeOpen && stationArcade && \(spaceUi === "lobby2" \|\| spaceUi === "lobby3"\)/, "パネル描画の条件が 2F/3F になっていない");
  assert.match(src, /<WorldBoxArcadePanel/, "WorldBoxArcadePanel が描画されていない");
});
