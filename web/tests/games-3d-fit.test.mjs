// 3D 見切れ対策（画角フィット）の回帰テスト。
// 背景: 透視投影は縦画角固定のため、縦長画面（スマホ縦持ち等）では
// 水平画角が狭まり、固定カメラの 3D シーンは盤・手札の左右が見切れた。
// 対策は three-kit/stage.ts の fitFovForAspect（基準アスペクト未満では
// 縦画角を広げて水平画角を一定に保つ）に集約し、
// - createStage のリサイズ処理と setCamera が必ずそれを通すこと
// - 盤サイズで自前 fitCamera するゲームがアスペクトを基準でクランプし
//   二重補正しないこと
// - 自前ステージの bowling / crocodile も同じ関数を使うこと
// を静的検査で固定する。あわせて fitFovForAspect の数値性質
// （基準以上では不変、基準未満では水平画角が保存される、上限がある）
// を、stage.ts から関数本体を取り出して実際に評価して検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

const stageSrc = read("lib", "three-kit", "stage.ts");

test("three-kit: 画角フィットの公開APIがある", () => {
  assert.match(stageSrc, /export const FIT_REFERENCE_ASPECT = 1\.4/);
  assert.match(stageSrc, /export const FIT_MAX_FOV = 105/);
  assert.match(stageSrc, /export function fitFovForAspect/);
});

test("three-kit: リサイズと setCamera が画角フィットを通す", () => {
  // リサイズ時: aspect と同時に fov を再計算する
  assert.match(stageSrc, /camera\.aspect = w \/ h;\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*camera\.fov = fitFovForAspect\(baseFov, w \/ h\)/);
  // setCamera: 指定 fov を基準画角として保持し、現在のアスペクトで補正する
  assert.match(stageSrc, /baseFov = p\.fov;\s*\n\s*camera\.fov = fittedFov\(\)/);
  // 生成時も補正済み画角でカメラを作る
  assert.match(stageSrc, /new THREE\.PerspectiveCamera\(fittedFov\(\), 1, 0\.1, 100\)/);
});

test("fitFovForAspect: 数値性質（不変・水平画角保存・上限）", () => {
  // stage.ts から定数と関数本体を取り出し、three 非依存で評価する
  const consts = stageSrc.match(/export const FIT_REFERENCE_ASPECT = [0-9.]+;[\s\S]*?export function fitFovForAspect[\s\S]*?\n\}/);
  assert.ok(consts, "fitFovForAspect の定義が取り出せる");
  const code = consts[0].replaceAll("export ", "").replaceAll(": number", "");
  const { FIT_REFERENCE_ASPECT, FIT_MAX_FOV, fitFovForAspect } = new Function(
    `${code}\nreturn { FIT_REFERENCE_ASPECT, FIT_MAX_FOV, fitFovForAspect };`,
  )();
  assert.equal(FIT_REFERENCE_ASPECT, 1.4);
  // 基準アスペクト以上では基準画角のまま（横長画面の見え方は従来通り）
  for (const aspect of [1.4, 1.83, 3.2]) {
    assert.equal(fitFovForAspect(42, aspect), 42, `aspect=${aspect}`);
  }
  // 基準未満では水平画角が「基準アスペクト×基準画角」と等しくなる
  const hTan = (vFovDeg, aspect) => Math.tan((vFovDeg * Math.PI) / 360) * aspect;
  for (const aspect of [0.5, 0.74, 1.0, 1.2]) {
    const fitted = fitFovForAspect(42, aspect);
    assert.ok(Math.abs(hTan(fitted, aspect) - hTan(42, FIT_REFERENCE_ASPECT)) < 1e-9, `aspect=${aspect} fitted=${fitted}`);
    assert.ok(fitted > 42, `aspect=${aspect} では画角が広がる`);
  }
  // 極端に細い画面でも上限を超えない／不正なアスペクトでは基準画角を返す
  assert.ok(fitFovForAspect(42, 0.2) <= FIT_MAX_FOV);
  assert.equal(fitFovForAspect(42, 0), 42);
  assert.equal(fitFovForAspect(42, Number.NaN), 42);
});

// fitCamera 系: 盤の大きさから自前でカメラ距離を計算するゲーム群。
// stage の画角フィットと二重に効くと盤が小さくなりすぎるため、
// 距離計算のアスペクトは基準アスペクトで下限クランプする。
const FIT_CAMERA_SCENES = [
  "amida/AmidaScene3D.tsx",
  "battleship/BattleshipScene3D.tsx",
  "falling/FallingScene3D.tsx",
  "fifteen/FifteenScene3D.tsx",
  "laser/LaserScene3D.tsx",
  "lightsout/LightsOutScene3D.tsx",
  "mastermind/MastermindScene3D.tsx",
  "maze/MazeScene3D.tsx",
  "memory/MemoryScene3D.tsx",
  "minesweeper/MinesweeperScene3D.tsx",
  "nonogram/NonogramScene3D.tsx",
  "peg/PegScene3D.tsx",
  "pentomino/PentominoScene3D.tsx",
  "pipe/PipeScene3D.tsx",
  "river/RiverScene3D.tsx",
  "rushhour/RushHourScene3D.tsx",
  "sokoban/SokobanScene3D.tsx",
  "sudoku/SudokuScene3D.tsx",
  "territory/TerritoryScene3D.tsx",
  "touchnumber/TouchNumberScene3D.tsx",
  "tsume/TsumeScene3D.tsx",
];

test("fitCamera系: 全シーンがアスペクトを基準でクランプする", () => {
  for (const rel of FIT_CAMERA_SCENES) {
    const src = read("app", "games", ...rel.split("/"));
    assert.match(src, /FIT_REFERENCE_ASPECT/, rel);
    assert.match(src, /const aspect = Math\.max\(w \/ h, FIT_REFERENCE_ASPECT\)/, rel);
  }
});

test("自前ステージ（bowling / crocodile）も画角フィットを使う", () => {
  const bowling = read("app", "games", "bowling", "BowlingScene3D.tsx");
  assert.match(bowling, /import \{ fitFovForAspect \} from "@\/lib\/three-kit\/stage"/);
  assert.match(bowling, /camera\.fov = fitFovForAspect\(55, w \/ hgt\)/);
  const crocodile = read("app", "games", "crocodile", "CrocodileScene3D.tsx");
  assert.match(crocodile, /import \{ fitFovForAspect \} from "@\/lib\/three-kit\/stage"/);
  assert.match(crocodile, /camera\.fov = fitFovForAspect\(46, w \/ hgt\)/);
});
