// 3D化 第8バッチ 線・経路系（amida / pipe / laser）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（amida 3 / pipe 2 / laser 1）以下
// - 入力が既存ハンドラ（amida: startTrace / pipe: rotatePipe を使う onTile /
//   laser: onMirror）へ接続される
// - 経路・反射・接続判定を 3D 側で再実装していないこと
//   （amida: tracePath / computeResults、pipe: flowIndices / isPipeSolved /
//     rotatePipe、laser: traceLaser / rotateLaserMirror / reflect を呼ばない）
// - ロジック（lib/amida.ts 等）へ three が混入していないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const countButtons = (dir) => {
  let n = 0;
  for (const f of fs.readdirSync(path.join(webDir, "app", "games", dir))) {
    if (f.endsWith(".tsx")) n += (read("app", "games", dir, f).match(/<button/g) ?? []).length;
  }
  return n;
};

const BATCH = [
  { dir: "amida", client: "AmidaClient.tsx", scene: "AmidaScene3D.tsx", buttons: 3, lib: "amida.ts" },
  { dir: "pipe", client: "PipeClient.tsx", scene: "PipeScene3D.tsx", buttons: 2, lib: "pipe.ts" },
  { dir: "laser", client: "LaserClient.tsx", scene: "LaserScene3D.tsx", buttons: 1, lib: "laser.ts" },
];

for (const g of BATCH) {
  test(`3D batch8-lines ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは基盤を直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(scene, /fitCamera/, "盤全体が収まるカメラ調整がある");
    assert.match(scene, /pickId/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /const board2d = \(/, "既存 2D 盤面が board2d として切り出されている");
  });

  test(`3D batch8-lines ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-lines ${g.dir}: シーンに絵文字UIがない（色と造形とテクスチャ文字で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-lines ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch8-lines amida: 縦棒と横棒は立体レール／バー、名前と景品は大きな文字プレートで表す", () => {
  const scene = read("app", "games", "amida", "AmidaScene3D.tsx");
  assert.match(scene, /createSegment/, "レールと横棒は円柱セグメントで作る");
  assert.match(scene, /amida\.bars/, "横棒の配置は lib の状態（bars）をそのまま読む");
  assert.match(scene, /createLabelPlate/, "名前／景品プレートを造形する");
  assert.match(scene, /canvasTexture/, "プレートの文字はテクスチャで大きく描く");
  assert.match(scene, /createBall/, "自分の駒は球で表す");
  assert.match(scene, /markerTarget/, "駒は経路の到達点へ追従する目標を持つ");
  assert.match(scene, /Math\.exp\(-dt/, "駒の移動は指数追従で滑らかにする（peg と同じ）");
});

test("3D batch8-lines amida: スタートタップが既存 startTrace へ、経路は親のトレース結果だけを描く", () => {
  const scene = read("app", "games", "amida", "AmidaScene3D.tsx");
  assert.match(scene, /pickId = `start-\$\{x\}`/, "スタート位置に pickId を付ける");
  assert.match(scene, /propsRef\.current\.onStart\(Number\(id\.slice\(6\)\)\)/, "タップが onStart を呼ぶ");
  assert.match(scene, /trace\.path/, "経路は親から受けた trace.path を描く");
  assert.doesNotMatch(scene, /(tracePath|computeResults|createAmida)\s*\(/, "経路計算・結果計算を 3D 側で再実装しない");
  const client = read("app", "games", "amida", "AmidaClient.tsx");
  assert.match(client, /onStart=\{startTrace\}/, "既存の startTrace へ接続する");
  assert.match(client, /tracePath\(amida, selected\)/, "経路トレースは親の既存計算のまま");
  assert.match(client, /trace=\{trace\}/, "トレース結果をシーンへ渡す");
  assert.match(client, /step=\{step\}/, "ステップ進行は親のタイマーが持つ");
});

test("3D batch8-lines pipe: パイプ部品は開口方向の腕＋ハブで造形し、水源と排水口は造形で示す", () => {
  const scene = read("app", "games", "pipe", "PipeScene3D.tsx");
  assert.match(scene, /createPipePiece/, "パイプ部品を造形する");
  assert.match(scene, /pipeOpenings\(cell\)/, "開口の向きは lib の純粋関数から読む（造形専用）");
  assert.match(scene, /CylinderGeometry\(0\.22, 0\.22/, "中心ハブは円柱で作る");
  assert.match(scene, /FLOW_COLOR = 0x38bdf8/, "通水色は現行 2D と同じ水色");
  assert.match(scene, /TorusGeometry/, "水源はリングで示す");
  assert.match(scene, /ConeGeometry/, "水源の雫は円錐で示す");
  assert.match(scene, /0x263238/, "排水口は現行 2D と同じ黒い穴で示す");
  assert.match(scene, /cellsRt/, "タイルは差分同期で管理する");
});

test("3D batch8-lines pipe: タップが既存の回転ハンドラへ、通水表示は親の判定結果に従う", () => {
  const scene = read("app", "games", "pipe", "PipeScene3D.tsx");
  assert.match(scene, /pickId = `cell-\$\{i\}`/, "マスに pickId を付ける");
  assert.match(scene, /propsRef\.current\.onTile\(Number\(id\.slice\(5\)\)\)/, "タップが onTile を呼ぶ");
  assert.match(scene, /flowSet/, "通水マスは親から受けた flow の集合で決める");
  assert.doesNotMatch(scene, /(flowIndices|isPipeSolved|rotatePipe|createPipeGame)\s*\(/, "流れ判定・勝敗・回転を 3D 側で再実装しない");
  const client = read("app", "games", "pipe", "PipeClient.tsx");
  assert.match(client, /onTile=\{onTile\}/, "切り出した既存ハンドラへ接続する");
  assert.match(client, /const onTile = \(index: number\)/, "タイル操作ハンドラが 2D と共有される");
  assert.match(client, /rotatePipe\(s, index\)/, "回転は既存の rotatePipe が担う");
  assert.match(client, /flow=\{\[\.\.\.flow\]\}/, "通水集合は親の flowIndices の結果を渡す");
  assert.match(client, /flowIndices\(state\)/, "流れ判定は親の既存計算のまま");
});

test("3D batch8-lines laser: 鏡は向きの判別できるプレート、的は同心円盤、発射口はノズルで表す", () => {
  const scene = read("app", "games", "laser", "LaserScene3D.tsx");
  assert.match(scene, /createMirror/, "鏡を造形する");
  assert.match(scene, /kind === "\/" \? Math\.PI \/ 4 : -Math\.PI \/ 4/, "鏡の向きはプレートの回転で判別できる");
  assert.match(scene, /createTarget/, "的を造形する");
  assert.match(scene, /0xe53935/, "的は現行 2D と同じ赤");
  assert.match(scene, /ConeGeometry/, "発射口のノズルは円錐で作る");
  assert.match(scene, /createSegment/, "光線はチューブ（円柱セグメント）で描く");
  assert.match(scene, /emissive: BEAM_COLOR/, "光線は発光で示す");
});

test("3D batch8-lines laser: 鏡タップが既存 onMirror へ、光線は親の光路を描くだけで反射計算をしない", () => {
  const scene = read("app", "games", "laser", "LaserScene3D.tsx");
  assert.match(scene, /pickId = `mir-\$\{m\.index\}`/, "鏡に pickId を付ける");
  assert.match(scene, /propsRef\.current\.onMirror\(Number\(id\.slice\(4\)\)\)/, "タップが onMirror を呼ぶ");
  assert.match(scene, /trace\.cells/, "光線は親から受けた trace.cells をつないで描く");
  assert.match(scene, /trace\.endDir/, "終端の伸ばしは親の endDir を描画に使うだけ");
  assert.doesNotMatch(scene, /(traceLaser|rotateLaserMirror|createLaserPuzzle)\s*\(/, "光路計算・回転を 3D 側で再実装しない");
  assert.doesNotMatch(scene, /\breflect\s*\(/, "反射計算を 3D 側で再実装しない");
  const client = read("app", "games", "laser", "LaserClient.tsx");
  assert.match(client, /onMirror=\{onMirror\}/, "既存の onMirror へ接続する");
  assert.match(client, /rotateLaserMirror\(s, index\)/, "鏡の回転は既存の rotateLaserMirror が担う");
  assert.match(client, /trace=\{trace\}/, "光路は親の traceLaser の結果を渡す");
  assert.match(client, /traceLaser\(state\)/, "光路計算は親の既存計算のまま");
});
