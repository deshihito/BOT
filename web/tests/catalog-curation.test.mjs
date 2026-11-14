// カタログ削減（2026-11-15 ユーザー決定）の検証。
// - 削除46タイトルがカタログ・振り分け・オンライン登録から外れていること
// - 格下げ25タイトルに demoted フラグが付き、ハブで後ろに分離表示されること
// - 日替わりおすすめに格下げタイトルが混ざらないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(webDir, "lib", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function read(rel) {
  return fs.readFileSync(path.join(webDir, rel), "utf8");
}

const catalog = await loadLib("games-catalog.ts");

// 存在意義なし12＋同系統の二番煎じ34（監査 catalog-audit.md の分類に基づく）。
const DELETED = [
  "tictactoe", "numbercode", "stopwatch", "highlow", "janken", "wordsearch",
  "golf", "montecarlo", "flashanzan", "dartsbattle", "simonbattle", "bingobattle",
  "nurikabe", "hashi", "shikaku", "kenken", "binairo", "kakuro",
  "skyscrapers", "slant", "akari", "tents", "numberlink", "alphametic",
  "mushoku", "columns", "blockpuzzle", "samegame", "floodit", "spider",
  "pyramid", "roulette", "baccarat", "drawpoker", "diceroll", "sugoroku",
  "gomoku", "checkers", "halma", "domino", "hangman", "minority",
  "bingo", "knightstour", "queens", "icemaze",
];

const DEMOTED = [
  "memory", "fifteen", "lightsout", "breakout", "pong", "stacker",
  "colormatch", "numbermemory", "maze", "aim", "dodge", "peg",
  "hanoi", "pentomino", "touchnumber", "spotdiff", "flagquiz", "pipe",
  "laser", "cube", "river", "airhockey", "missile", "dragrace",
  "crocodile",
];

const DELETED_ONLINE = [
  "tictactoe", "janken", "flashanzan", "dartsbattle", "bingobattle",
  "simonbattle", "gomoku", "checkers", "domino", "minority",
];

test("カタログ: 141本から46本を削除し95本になっている", () => {
  assert.equal(DELETED.length, 46);
  assert.equal(catalog.WEB_GAMES.length, 95);
  for (const slug of DELETED) {
    assert.equal(catalog.getWebGame(slug), undefined, `${slug}: カタログに残っている`);
    assert.ok(!fs.existsSync(path.join(webDir, "app/games", slug)), `${slug}: ディレクトリが残っている`);
  }
});

test("カタログ: 格下げは25タイトルちょうどで、全て現行タイトル", () => {
  assert.equal(DEMOTED.length, 25);
  const flagged = catalog.WEB_GAMES.filter((g) => g.demoted).map((g) => g.slug);
  assert.deepEqual([...flagged].sort(), [...DEMOTED].sort());
  for (const slug of DEMOTED) {
    const game = catalog.getWebGame(slug);
    assert.ok(game, `${slug}: 格下げ対象がカタログに無い`);
    assert.equal(game.status, "playable", `${slug}: 直接URLで遊べる状態でない`);
  }
});

test("振り分け: 削除タイトルの import と分岐が [id]/page.tsx に残っていない", () => {
  const page = read("app/games/[id]/page.tsx");
  for (const slug of DELETED) {
    assert.ok(!page.includes(`"../${slug}/`), `${slug}: import が残っている`);
    assert.ok(!page.includes(`game.slug === "${slug}"`), `${slug}: 分岐が残っている`);
  }
});

test("オンライン登録: 削除した対戦タイトルが registry から外れている", () => {
  const registry = read("lib/online/registry.ts");
  for (const slug of DELETED_ONLINE) {
    assert.ok(!registry.includes(`"./games/${slug}"`), `${slug}: 登録が残っている`);
    assert.ok(!fs.existsSync(path.join(webDir, "lib/online/games", `${slug}.ts`)), `${slug}: モジュールが残っている`);
  }
});

test("ハブ: 格下げタイトルは通常タイトルの後ろに分離表示される", () => {
  const grid = read("app/games/GamesGrid.tsx");
  // demoted で二分し、通常側を先に描いてから格下げ側の見出し区切りを出す構造か。
  assert.match(grid, /!game\.demoted/);
  assert.match(grid, /game\.demoted/);
  const demotedSection = grid.indexOf("その他のゲーム");
  assert.ok(demotedSection > 0, "格下げ側の区切り見出しが無い");
  const primaryGrid = grid.indexOf("primary.map");
  assert.ok(primaryGrid > 0 && primaryGrid < demotedSection, "通常タイトルが格下げより前に描画されていない");
});

test("デイリー: 日替わりおすすめに格下げタイトルが入らない", () => {
  for (let day = 0; day < 60; day++) {
    const date = new Date(Date.UTC(2026, 0, 1 + day));
    for (const pick of catalog.dailyPicksFor(date)) {
      assert.ok(!pick.demoted, `${pick.slug}: 格下げがおすすめに入っている`);
      assert.ok(!DELETED.includes(pick.slug), `${pick.slug}: 削除タイトルがおすすめに入っている`);
    }
  }
});
