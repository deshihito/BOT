// 3D化 第5バッチ 対戦系（dartsbattle / simonbattle）の回帰テスト（静的検査）。
// 既存バッチ（games-3d-batch4-a 等）の流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
//   （board2d に切り出し、fallback={board2d} でシーンへ渡す）
// - <button> 数が現行（dartsbattle 0 / simonbattle 1）以下
// - 入力が既存ハンドラ（dartsbattle: handleThrow / simonbattle: press）へ接続される
// - ロジック（lib/*.ts、lib/online）へ three が混入していないこと
// 対戦固有: 状態同期・オンライン基盤には触らず、表示シーンと入力接続だけを
// 差し替える。相手の投擲・再生も同じ差分同期 / lit 追従でアニメーションされる。
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
  { dir: "dartsbattle", client: "DartsBattleClient.tsx", scene: "DartsBattleScene3D.tsx", buttons: 0 },
  { dir: "simonbattle", client: "SimonBattleClient.tsx", scene: "SimonBattleScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch5-battle ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /webglFailed \? board2d/, "WebGL 失敗時は board2d を直接描く");
  });

  test(`3D batch5-battle ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch5-battle dartsbattle: ボードタップが既存の投擲ハンドラへ正規化座標で接続され、セグメント造形がある", () => {
  const scene = read("app", "games", "dartsbattle", "DartsBattleScene3D.tsx");
  assert.match(scene, /DART_SECTORS/, "セクター列は lib の定義を使う（対戦サーバーと同一）");
  assert.match(scene, /DART_RADII/, "リング境界は lib の定義を使う（対戦サーバーと同一）");
  assert.match(scene, /wedgeGeo/, "同心円セグメントを扇形ジオメトリで作る");
  assert.match(scene, /onThrow\(hit\.point\.x, hit\.point\.y\)/, "着弾点をそのまま onThrow へ渡す（ソロ版と同じ座標系）");
  const client = read("app", "games", "dartsbattle", "DartsBattleClient.tsx");
  assert.match(client, /onThrow=\{handleThrow\}/, "既存の投擲ハンドラへ接続する");
  assert.match(client, /\(bx \+ 1\.2\) \/ 2\.4\) \* 1000/, "正規化座標を提出形式 0〜1000 へ変換する");
  assert.match(client, /\(1\.2 - by\) \/ 2\.4\) \* 1000/, "y は上下反転して変換する（サーバー変換の逆）");
  assert.match(client, /api\.move\(\{ type: "throw", x, y \}\)/, "提出は従来どおり api.move の throw");
  assert.match(client, /if \(!myTurn\) return;/, "手番判定はクライアント側ハンドラのまま");
});

test("3D batch5-battle dartsbattle: 投擲はキー差分同期で、自他の新規投擲が飛翔アニメーションになる", () => {
  const scene = read("app", "games", "dartsbattle", "DartsBattleScene3D.tsx");
  assert.match(scene, /entries: Map<string, DartEntry>/, "ダーツはキー（seat-連番）で管理する");
  assert.match(scene, /rt\.entries\.has\(d\.key\)/, "既存の投擲は再生成しない（差分同期）");
  assert.match(scene, /makeDart\(d\.seat\)/, "ダーツは席色で作り、相手の投擲も同じ経路で表示する");
  assert.match(scene, /Math\.hypot\(d\.x, d\.y\) <= 1\.18/, "盤外の着弾（時間切れミス）は描かない");
  const client = read("app", "games", "dartsbattle", "DartsBattleClient.tsx");
  assert.match(client, /roundDarts\.map\(\(\{ hit, seat, key \}\)/, "このラウンドの全プレイヤーの投擲をシーンへ渡す");
});

test("3D batch5-battle simonbattle: パッドタップが既存 press へ接続され、発光は lit/pressed に追従する", () => {
  const scene = read("app", "games", "simonbattle", "SimonBattleScene3D.tsx");
  assert.match(scene, /emissiveIntensity/, "発光は emissive で表現する");
  assert.match(scene, /pressed === i/, "押し込み表現は pressed に追従する");
  assert.match(scene, /onPad\(Number\(/, "パッドタップが onPad へ接続される");
  const client = read("app", "games", "simonbattle", "SimonBattleClient.tsx");
  assert.match(client, /onPad=\{press\}/, "既存の press ハンドラへ接続する");
  assert.match(client, /lit=\{state\.phase === "showing" \? state\.flash : null\}/, "再生中の flash を lit として渡す");
  assert.match(client, /pressed=\{pressed\}/, "自分の押下状態を pressed として渡す");
  assert.match(client, /if \(!canPress\) return;/, "フェーズ・手番判定（canPress）はクライアント側のまま");
  assert.match(client, /api\.move\(\{ type: "press", color \}\)/, "提出は従来どおり api.move の press");
});

test("3D batch5-battle: ロジック層（lib/darts.ts, lib/online/games/*）に three が混入していない", () => {
  for (const p of [
    ["lib", "darts.ts"],
    ["lib", "online", "games", "dartsbattle.ts"],
    ["lib", "online", "games", "simonbattle.ts"],
  ]) {
    assert.doesNotMatch(read(...p), /from "three"/, p.join("/"));
  }
});

test("3D batch5-battle: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
