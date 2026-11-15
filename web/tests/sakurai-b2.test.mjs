// 櫻井流バッチ2「終了画面とリトライの統一＋ご褒美帯」の検証。
// - lib/juice.ts の純粋ロジック: endFanfare（決着音の対応）と
//   goalBandState（ベストまでの残り計算、lowerIsBetter 対応）
// - GameJuice の公開面: EndScreen v2（Rキー・sound opt-in・敗北演出・
//   confettiOnLose）、GoalBand、useRoomJuice / useBoardJuice
// - 配線: オンライン対戦タイトルへの useRoomJuice、GoalBand 7タイトル、
//   simon への sfx 配線（二重再生を作らない形）
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

async function loadModule(relPath) {
  const js = transpile(relPath);
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function read(rel) {
  return fs.readFileSync(path.join(webDir, rel), "utf8");
}

const juice = await loadModule("lib/juice.ts");

test("endFanfare: 勝利+ベスト更新で KO 級、通常勝利は win、敗北は lose", () => {
  assert.equal(juice.endFanfare("win", true), "ko");
  assert.equal(juice.endFanfare("win", false), "win");
  assert.equal(juice.endFanfare("win"), "win");
  assert.equal(juice.endFanfare("lose", true), "lose");
  assert.equal(juice.endFanfare("lose"), "lose");
  assert.equal(juice.endFanfare("draw"), "draw");
  assert.equal(juice.endFanfare("finish", true), "win");
  assert.equal(juice.endFanfare("finish", false), "finish");
});

test("goalBandState: 記録なし・追走・更新中を正しく判定する（高いほど良い）", () => {
  assert.deepEqual(juice.goalBandState(100, null), { kind: "none", remaining: 0 });
  assert.deepEqual(juice.goalBandState(100, undefined), { kind: "none", remaining: 0 });
  assert.deepEqual(juice.goalBandState(100, 0), { kind: "none", remaining: 0 });
  assert.deepEqual(juice.goalBandState(300, 500), { kind: "chasing", remaining: 200 });
  assert.deepEqual(juice.goalBandState(500, 500), { kind: "chasing", remaining: 0 });
  assert.deepEqual(juice.goalBandState(501, 500), { kind: "beating", remaining: 0 });
});

test("goalBandState: 小さいほど良い指標（タイム等）でも残りを正しく出す", () => {
  assert.deepEqual(juice.goalBandState(50, 45, true), { kind: "chasing", remaining: 5 });
  assert.deepEqual(juice.goalBandState(45, 45, true), { kind: "chasing", remaining: 0 });
  assert.deepEqual(juice.goalBandState(40, 45, true), { kind: "beating", remaining: 0 });
  assert.deepEqual(juice.goalBandState(40, 0, true), { kind: "none", remaining: 0 });
  assert.deepEqual(juice.goalBandState(40, Number.NaN), { kind: "none", remaining: 0 });
});

const gameJuice = read("app/games/GameJuice.tsx");

test("GameJuice: EndScreen v2 は Rキーリトライと sound opt-in を持ち、既定では鳴らさない", () => {
  assert.match(gameJuice, /export function EndScreen/);
  assert.match(gameJuice, /sound = false/);
  assert.match(gameJuice, /confettiOnLose = false/);
  assert.match(gameJuice, /e\.key !== "r" && e\.key !== "R"/);
  assert.match(gameJuice, /tag === "INPUT"/);
  assert.match(gameJuice, /playEndFanfare/);
  assert.match(gameJuice, /Rキーでもう一度/);
});

test("GameJuice: GoalBand と対戦系フック（useRoomJuice / useBoardJuice）を公開する", () => {
  assert.match(gameJuice, /export function GoalBand/);
  assert.match(gameJuice, /export function useRoomJuice/);
  assert.match(gameJuice, /export function useBoardJuice/);
  assert.match(gameJuice, /og-game-area/);
  assert.match(gameJuice, /goalBandState/);
});

const css = read("app/globals.css");
test("globals.css: ご褒美帯と終了ヒントのスタイルがある", () => {
  assert.match(css, /\.juice-goal-band \{/);
  assert.match(css, /\.juice-goal-band-beating \{/);
  assert.match(css, /\.juice-end-hint \{/);
});

// 2026-11-15 のカタログ削減で対戦10タイトル（bingobattle / checkers /
// dartsbattle / domino / flashanzan / gomoku / janken / minority /
// simonbattle / tictactoe）を削除したため、対象は残る25タイトル。
const ROOM_TITLES = [
  "babanuki", "battleship", "bombpass", "burst", "calcrace",
  "cheat", "connect4", "countdown", "daifugo",
  "drawguess", "hagetaka",
  "liarsdice", "majority", "musicalchairs", "nanja", "quizbattle",
  "shiritori", "speed", "stopbattle", "territory", "texas",
  "typerace", "werewolf", "wordbasket", "wordwolf",
];

test("対戦25タイトル: useRoomJuice が配線され、lib/sfx を二重に被せていない", () => {
  for (const title of ROOM_TITLES) {
    const dir = path.join(webDir, "app/games", title);
    const client = fs.readdirSync(dir).find((f) => f.endsWith("Client.tsx"));
    assert.ok(client, `${title}: Client が見つからない`);
    const src = fs.readFileSync(path.join(dir, client), "utf8");
    assert.match(src, /import \{ useRoomJuice \} from "\.\.\/GameJuice";/, `${title}: useRoomJuice import がない`);
    assert.match(src, /useRoomJuice\(/, `${title}: useRoomJuice 呼び出しがない`);
    assert.doesNotMatch(src, /from "@\/lib\/sfx"/, `${title}: lib/sfx を二重配線している`);
    // 既存の音響（balku-sound の playSe）が残っていること
    assert.match(src, /playSe\(/, `${title}: 既存の playSe が消えている`);
  }
});

const GOALBAND_TITLES = [
  ["2048", "SliderClient.tsx"],
  ["reaction", "ReactionClient.tsx"],
  ["typing", "TypingClient.tsx"],
  ["mole", "MoleClient.tsx"],
  ["stacker", "StackerClient.tsx"],
  ["minesweeper", "MinesweeperClient.tsx"],
  ["simon", "SimonClient.tsx"],
];

test("GoalBand: スコア系7タイトルに配線されている", () => {
  for (const [title, file] of GOALBAND_TITLES) {
    const src = read(`app/games/${title}/${file}`);
    assert.match(src, /GoalBand/, `${title}: GoalBand がない`);
    assert.match(src, /<GoalBand /, `${title}: GoalBand が描画されていない`);
  }
});

test("simon: 自前 pad 音は残し、欠けていた sfx（開始/クリア/終了）だけを足している", () => {
  const src = read("app/games/simon/SimonClient.tsx");
  assert.match(src, /playTone/);
  assert.match(src, /sfxCorrect\(\)/);
  assert.match(src, /sfxTap\(\)/);
  assert.match(src, /<EndScreen[\s\S]*?sound/);
});
