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

// ── PC 幅でもはみ出す固定カメラの対策（第2弾）────────────────────────
// 画角フィットは「横」の見切れだけを直す。縦はみ出し（盤の手前縁・
// 背の高いパネル・静止ボール等）はアスペクトに依らないため、
// 固定カメラのゲームはカメラ自体を引いて収めるしかない。
// ここでは各シーンのカメラ定義をファイルから読み、監査で求めた
// コンテンツ外形（bbox 隅8点）を実際に投影して、
// PC 幅（メインカラム 840px / SceneBox 高さ）と基準アスペクト 1.4 の
// 両方で画面内に収まることを固定する。
function parseStageCamera(src) {
  const m = src.match(/camera: \{ position: \[([-\d., ]+)\], lookAt: \[([-\d., ]+)\], fov: (\d+) \}/);
  assert.ok(m, "createStage のカメラ定義が読める");
  const nums = (s) => s.split(",").map((v) => Number(v.trim()));
  return { position: nums(m[1]), lookAt: nums(m[2]), fov: Number(m[3]) };
}

function projectMax(cam, aspect, points) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fwd = norm(sub(cam.lookAt, cam.position));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up2 = cross(right, fwd);
  const tanV = Math.tan(((cam.fov * Math.PI) / 180) / 2);
  const tanH = tanV * aspect;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    const d = sub(p, cam.position);
    const z = dot(d, fwd);
    if (z <= 0) continue;
    mx = Math.max(mx, Math.abs(dot(d, right) / z / tanH));
    my = Math.max(my, Math.abs(dot(d, up2) / z / tanV));
  }
  return { mx, my };
}

const bboxCorners = ([x0, x1], [y0, y1], [z0, z1]) => {
  const pts = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) pts.push([x, y, z]);
  return pts;
};

// file: [SceneBox 高さ, コンテンツ外形 points]
const PC_FIT_SCENES = {
  "chess/ChessScene3D.tsx": [460, bboxCorners([-4.15, 4.15], [-0.36, 1.0], [-4.15, 4.15])],
  "chesspuzzle/ChessPuzzleScene3D.tsx": [420, bboxCorners([-4.15, 4.15], [-0.36, 1.03], [-4.15, 4.15])],
  "reversi/ReversiScene3D.tsx": [400, bboxCorners([-4.23, 4.23], [-0.355, 0.16], [-4.23, 4.23])],
  "connect4/Connect4Scene3D.tsx": [430, bboxCorners([-3.93, 3.93], [-0.15, 7.3], [-0.25, 0.36])],
  "mergefruit/MergeFruitScene3D.tsx": [430, bboxCorners([-2.6, 2.84], [-0.16, 9.13], [-0.41, 0.4])],
  "musicalchairs/MusicalChairsScene3D.tsx": [340, bboxCorners([-3.8, 3.8], [-0.19, 1.13], [-3.8, 3.8])],
  "penalty/PenaltyScene3D.tsx": [380, bboxCorners([-2.83, 2.83], [0, 2.42], [-0.77, 3.32])],
  "curling/CurlingScene3D.tsx": [560, bboxCorners([-1.75, 1.75], [-0.03, 0.19], [-4.05, 4.05])],
  "cranegame/CraneScene3D.tsx": [380, bboxCorners([-3.45, 3.45], [-0.22, 3.85], [-2.55, 2.55])],
  "darts/DartsScene3D.tsx": [420, bboxCorners([-1.24, 1.24], [-1.24, 1.29], [-0.08, 0.47])],
};

test("固定カメラ: PC幅と基準アスペクトでコンテンツが収まる", () => {
  for (const [rel, [height, points]] of Object.entries(PC_FIT_SCENES)) {
    const cam = parseStageCamera(read("app", "games", ...rel.split("/")));
    const pc = projectMax(cam, 840 / height, points);
    assert.ok(pc.my <= 0.97, `${rel}: PC幅で縦にはみ出す (maxNDC y=${pc.my.toFixed(3)})`);
    assert.ok(pc.mx <= 1.0, `${rel}: PC幅で横にはみ出す (maxNDC x=${pc.mx.toFixed(3)})`);
    const ref = projectMax(cam, FIT_REF, points);
    assert.ok(ref.mx <= 1.0, `${rel}: 基準アスペクト1.4で横にはみ出す (maxNDC x=${ref.mx.toFixed(3)})`);
  }
});

const FIT_REF = 1.4;

test("固定カメラ: nanja は円形テーブルの縁が収まる", () => {
  const cam = parseStageCamera(read("app", "games", "nanja", "NanjaScene3D.tsx"));
  // 円形テーブルは bbox 隅（存在しない角）でなく縁上の点で評価する
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * i) / 16;
    for (const y of [-0.19, -0.01]) pts.push([2.6 * Math.cos(a), y, 2.6 * Math.sin(a)]);
  }
  pts.push([0, 1.69, 0], [1.75, 0.3, 0], [-1.5, 1.0, 0]);
  const pc = projectMax(cam, 840 / 300, pts);
  assert.ok(pc.my <= 0.97 && pc.mx <= 1.0, `nanja: PC幅ではみ出す (${pc.mx.toFixed(3)}/${pc.my.toFixed(3)})`);
  const ref = projectMax(cam, FIT_REF, pts);
  assert.ok(ref.mx <= 1.0, `nanja: 基準アスペクトではみ出す (${ref.mx.toFixed(3)})`);
});

test("固定カメラ: crocodile（自前カメラ）は開いた上顎が収まる", () => {
  const src = read("app", "games", "crocodile", "CrocodileScene3D.tsx");
  const pm = src.match(/camera\.position\.set\(([^)]+)\)/);
  const lm = src.match(/camera\.lookAt\(([^)]+)\)/);
  assert.ok(pm && lm, "crocodile のカメラ定義が読める");
  const nums = (s) => s.split(",").map((v) => Number(v.trim()));
  const cam = { position: nums(pm[1]), lookAt: nums(lm[1]), fov: 46 };
  const pts = bboxCorners([-1.3, 1.3], [-0.25, 3.26], [-2.0, 2.88]);
  const pc = projectMax(cam, 840 / 380, pts);
  assert.ok(pc.my <= 0.97, `crocodile: PC幅で縦にはみ出す (maxNDC y=${pc.my.toFixed(3)})`);
});

test("snake: 盤サイズでカメラをフィットさせる（fitCamera系）", () => {
  const src = read("app", "games", "snake", "SnakeScene3D.tsx");
  assert.match(src, /FIT_REFERENCE_ASPECT/);
  assert.match(src, /const aspect = Math\.max\(w \/ h, FIT_REFERENCE_ASPECT\)/);
  assert.match(src, /fitCamera\(stage, container, s0\.cols, s0\.rows\)/);
  // 20x20 盤での実カメラ（dist は奥行き側が支配的でアスペクトに依らない）を投影確認
  const cam = { position: [0, 24.26, 12.86], lookAt: [0, 0, 0.8], fov: 42 };
  const pts = bboxCorners([-10.15, 10.15], [-0.25, 0.64], [-10.15, 10.15]);
  const pc = projectMax(cam, 840 / 480, pts);
  assert.ok(pc.mx <= 0.97 && pc.my <= 0.97, `snake: 20x20盤が収まらない (${pc.mx.toFixed(3)}/${pc.my.toFixed(3)})`);
});

test("cranegame: 横レールはキャリッジの子にしない（横移動ではみ出すため）", () => {
  const src = read("app", "games", "cranegame", "CraneScene3D.tsx");
  assert.match(src, /railBridge\.add\(railX\)/);
  assert.doesNotMatch(src, /carriage\.add\(railX\)/);
  assert.match(src, /rt\.railBridge\.position\.z = rt\.carriagePos\.z/);
});

test("多枚数レイアウト: 間隔圧縮で全体幅を収める", () => {
  const watersort = read("app", "games", "watersort", "WaterSortScene3D.tsx");
  assert.match(watersort, /Math\.min\(1\.02, 6\.4 \/ \(n - 1\)\)/);
  const blackjack = read("app", "games", "blackjack", "BlackjackScene3D.tsx");
  assert.match(blackjack, /Math\.min\(0\.98, 6\.6 \/ \(count - 1\)\)/);
  const hagetaka = read("app", "games", "hagetaka", "HagetakaScene3D.tsx");
  assert.match(hagetaka, /Math\.min\(0\.95, 6\.6 \/ \(table\.length - 1\)\)/);
  const hearts = read("app", "games", "hearts", "HeartsScene3D.tsx");
  assert.match(hearts, /Math\.min\(0\.6, 6\.6 \/ \(myHand\.length - 1\)\)/);
});
