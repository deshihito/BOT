// 3D化 第8バッチ 盤系（tents / river / knightstour）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（tents 1 / river 1 / knightstour 4）以下
// - シーンに絵文字 UI がない（木・テント・駒は立体造形で表す）
// - 入力が既存ハンドラ（tents: onCell/onCheck、river: handleItem/cross、
//   knightstour: handleMove）へ接続される
// - 制約判定・勝敗判定を 3D 側で再実装していないこと
// - ロジック（lib/tents.ts 等）へ three が混入していないこと
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
  { dir: "tents", client: "TentsClient.tsx", scene: "TentsScene3D.tsx", buttons: 1, lib: "tents.ts" },
  { dir: "river", client: "RiverClient.tsx", scene: "RiverScene3D.tsx", buttons: 1, lib: "river.ts" },
  { dir: "knightstour", client: "KnightsTourClient.tsx", scene: "KnightsTourScene3D.tsx", buttons: 4, lib: "knightstour.ts" },
];

for (const g of BATCH) {
  test(`3D batch8-board ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /pickId/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch8-board ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-board ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-board ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch8-board tents: 木=幹＋葉の円錐 / テント=三角プリズム / 草=芽の造形で表す", () => {
  const scene = read("app", "games", "tents", "TentsScene3D.tsx");
  assert.match(scene, /createTree/, "木を造形する");
  assert.match(scene, /ConeGeometry/, "木の葉と草の芽は円錐で作る");
  assert.match(scene, /CylinderGeometry/, "木の幹は円柱で作る");
  assert.match(scene, /createTent/, "テントを造形する");
  assert.match(scene, /ExtrudeGeometry/, "テントは三角形の押し出し（プリズム）で作る");
  assert.match(scene, /createGrassTuft/, "草の印を造形する");
  assert.match(scene, /0x2e7d32/, "葉は現行 2D の SVG と同じ緑");
  assert.match(scene, /0xef6c00/, "テントは現行 2D の SVG と同じオレンジ");
  assert.match(scene, /createBadFrame/, "違反マスは赤枠で示す");
});

test("3D batch8-board tents: タップが onCell、下スワイプが onCheck へ接続され、循環・違反判定を再実装しない", () => {
  const scene = read("app", "games", "tents", "TentsScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.match(scene, /flick\.dir === "down"/, "下方向のフリックをチェックに使う");
  assert.match(scene, /propsRef\.current\.onCheck\(\)/, "スワイプが onCheck を呼ぶ");
  assert.doesNotMatch(scene, /cycleTentsMark\(|tentsViolations\(|isTentsComplete\(/, "循環・違反・完成判定を 3D 側で再実装しない");
  const client = read("app", "games", "tents", "TentsClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "既存の onCell へ接続する");
  assert.match(client, /onCheck=\{onCheck\}/, "既存の onCheck へ接続する");
  assert.match(client, /marks=\{state\.marks\}/, "印は親の状態を渡す");
  assert.match(client, /trees=\{state\.trees\}/, "木の配置は親の状態を渡す");
  assert.match(client, /violationCells=\{\[\.\.\.violationCells\]\}/, "違反マスは親のチェック結果を渡す");
});

test("3D batch8-board tents: 行列ヒントは DOM 併記を維持する（3D は盤面マスのみ）", () => {
  const scene = read("app", "games", "tents", "TentsScene3D.tsx");
  assert.match(scene, /親が DOM で/, "ヒントを DOM 併記に委ねる旨をシーン冒頭に明記する");
  const client = read("app", "games", "tents", "TentsClient.tsx");
  assert.match(client, /col3d-/, "3D レイアウトでも列ヒントを DOM で併記する");
  assert.match(client, /row3d-/, "3D レイアウトでも行ヒントを DOM で併記する");
  assert.match(client, /countStyle\(placedInCol\(c\), target\)/, "列ヒントの色分け（一致=緑）を 3D 側でも維持する");
  assert.match(client, /countStyle\(placedInRow\(r\), target\)/, "行ヒントの色分け（一致=緑）を 3D 側でも維持する");
});

test("3D batch8-board river: 両岸＋川＋ボートと、漢字プレートつきトークンで登場オブジェクトを表す", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /createToken/, "荷物・農夫はトークンで造形する");
  assert.match(scene, /canvasTexture/, "漢字はプレートのテクスチャで大きく描く");
  assert.match(scene, /river-kanji-/, "漢字プレートは荷物ごとに作る");
  assert.match(scene, /createBankPlate/, "岸の名前プレートを置く");
  assert.match(scene, /pickId = "boat"/, "ボートがピック対象になる");
  assert.match(scene, /pickId = `item-\$\{item\.id\}`/, "荷物トークンがピック対象になる");
  assert.match(scene, /FARMER_DEF/, "農夫トークンを持つ");
});

test("3D batch8-board river: 差分同期＋補間追従でボートと荷物が一緒に動く", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /tokensRt/, "トークンは差分同期で管理する");
  assert.match(scene, /boatTargetX/, "ボートは目標位置を持つ");
  assert.match(scene, /Math\.exp\(-dt/, "補間は指数追従");
  assert.match(scene, /tok\.loc === "boat"/, "船上の荷物はボートの現在位置へ追従する");
});

test("3D batch8-board river: 荷物タップが onItem、ボートタップ／対岸スワイプが onCross へ接続され、危険判定を再実装しない", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onItem\(id\.slice\(5\)\)/, "荷物タップが onItem を呼ぶ");
  assert.match(scene, /propsRef\.current\.onCross\(\)/, "ボートタップ／スワイプが onCross を呼ぶ");
  assert.match(scene, /flick\.dir === "right"/, "右方向のフリック（左岸→右岸）を渡河に使う");
  assert.match(scene, /flick\.dir === "left"/, "左方向のフリック（右岸→左岸）を渡河に使う");
  assert.doesNotMatch(scene, /crossRiver\(|toggleRiverItem\(|dangerOnSide\(/, "渡河・積み下ろし・危険判定を 3D 側で再実装しない");
  const client = read("app", "games", "river", "RiverClient.tsx");
  assert.match(client, /onItem=\{handleItem\}/, "既存の乗せ降ろし経路へ接続する");
  assert.match(client, /onCross=\{cross\}/, "既存の cross へ接続する");
  assert.match(client, /const handleItem[\s\S]*?toggleRiverItem\(state, id\)/, "handleItem は既存の toggleRiverItem 経路そのもの");
  assert.match(client, /locations=\{state\.locations\}/, "荷物の場所は親の状態を渡す");
  assert.match(client, /items=\{problem\.items\}/, "荷物定義は親の問題を渡す");
});

test("3D batch8-board knightstour: 訪問順は上面テクスチャで大きく、移動可能マスは緑マーカーで表す", () => {
  const scene = read("app", "games", "knightstour", "KnightsTourScene3D.tsx");
  assert.match(scene, /createVisitedTile/, "訪問済みタイルを造形する");
  assert.match(scene, /canvasTexture/, "訪問順の数字は上面テクスチャで描く");
  assert.match(scene, /kt-visited-/, "数字テクスチャは手数ごとに作る");
  assert.match(scene, /#b8a888/, "訪問済みの暗マスは現行 2D と同じ色");
  assert.match(scene, /markerMat/, "移動可能マスは緑マーカーで示す");
});

test("3D batch8-board knightstour: ナイト駒は chess の造形をシーン内で再実装し、ホップで移動する", () => {
  const scene = read("app", "games", "knightstour", "KnightsTourScene3D.tsx");
  assert.match(scene, /createKnightPiece/, "ナイト駒を造形する");
  assert.match(scene, /chess シーンの createKnight/, "chess の造形を参照した旨を明記する");
  assert.match(scene, /ConeGeometry/, "耳は円錐で作る");
  assert.match(scene, /TorusGeometry/, "現在位置は金のリングで囲む");
  assert.match(scene, /Math\.sin\(e \* Math\.PI\)/, "移動は放物線のホップで表す");
  assert.doesNotMatch(scene, /from "\.\.\/chess\//, "chess シーン全体は import しない（造形のみ再実装）");
});

test("3D batch8-board knightstour: タップが handleMove へ接続され、合法手・訪問順を再実装しない", () => {
  const scene = read("app", "games", "knightstour", "KnightsTourScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.doesNotMatch(scene, /moveKnight\(|legalMoves\(|visitOrder\(|knightTargets\(/, "移動・合法手・訪問順の計算を 3D 側で再実装しない");
  const client = read("app", "games", "knightstour", "KnightsTourClient.tsx");
  assert.match(client, /onCell=\{handleMove\}/, "既存の handleMove へ接続する");
  assert.match(client, /order=\{order\}/, "訪問順は親の visitOrder 結果を渡す");
  assert.match(client, /moves=\{moves\}/, "合法手は親の legalMoves 結果を渡す");
  assert.match(client, /head=\{head\}/, "現在位置は親の状態を渡す");
});
