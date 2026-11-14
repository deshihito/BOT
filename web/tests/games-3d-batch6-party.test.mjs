// 3D化 第6バッチ パーティ系（nanja / musicalchairs）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（nanja 3 / musicalchairs 2）以下
// - 入力が既存ハンドラ（nanja: flip / musicalchairs: sit）へ接続される
// - 勝敗・進行判定を 3D 側で再実装していないこと
// - ロジック（lib/online/games/*.ts）へ three が混入していないこと
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
  { dir: "nanja", client: "NanjaClient.tsx", scene: "NanjaScene3D.tsx", buttons: 3 },
  { dir: "musicalchairs", client: "MusicalChairsClient.tsx", scene: "MusicalChairsScene3D.tsx", buttons: 2 },
];

for (const g of BATCH) {
  test(`3D batch6-party ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch6-party ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch6-party ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });
}

test("3D batch6-party nanja: 生き物は lib と同じ色×形の造形で判別し、名前は 3D に置かない", () => {
  const scene = read("app", "games", "nanja", "NanjaScene3D.tsx");
  assert.match(scene, /CREATURES/, "生き物定義（色×形）を持つ");
  assert.match(scene, /SphereGeometry/, "丸は球で造形する");
  assert.match(scene, /OctahedronGeometry/, "菱形は八面体で造形する");
  assert.match(scene, /ExtrudeGeometry/, "星は押し出しで造形する");
  assert.match(scene, /createCard/, "カードは three-kit の createCard で作る");
  assert.match(scene, /createCreature/, "生き物トークンを造形する");
  assert.doesNotMatch(scene, /canvasTexture|label:/, "名前・文字をテクスチャに描かない");
});

test("3D batch6-party nanja: めくりはフリップ＋フライイン、山は差分同期 Map で管理する", () => {
  const scene = read("app", "games", "nanja", "NanjaScene3D.tsx");
  assert.match(scene, /entries: Map/, "オブジェクトはキー単位 Map で管理する");
  assert.match(scene, /flipGroup\.rotation\.y/, "カードがめくれるフリップアニメーションがある");
  assert.match(scene, /exiting/, "山が流れるときの消滅アニメーションがある");
  assert.match(scene, /pile-\$\{i\}/, "場の山は層キーで差分同期する");
  assert.match(scene, /deck-\$\{i\}/, "山札は層キーで差分同期する");
});

test("3D batch6-party nanja: 山札タップが既存 flip ハンドラへ接続され、判定は親の canFlip が持つ", () => {
  const scene = read("app", "games", "nanja", "NanjaScene3D.tsx");
  assert.match(scene, /pickId = "flip"/, "タップ対象に pickId を付ける");
  assert.match(scene, /propsRef\.current\.onFlip\(\)/, "タップが onFlip を呼ぶ");
  assert.match(scene, /propsRef\.current\.canFlip/, "めくれるかは親の判定に従う");
  const client = read("app", "games", "nanja", "NanjaClient.tsx");
  assert.match(client, /onFlip=\{doFlip\}/, "既存の doFlip へ接続する");
  assert.match(client, /api\.move\(\{ type: "flip" \}\)/, "送信アクションは既存の flip のまま");
  assert.match(client, /canFlip=\{canFlip\}/, "手番・フェーズ判定済みの canFlip を渡す");
  assert.doesNotMatch(scene, /api\.move|applyAction/, "シーンはアクション送信や判定をしない");
});

test("3D batch6-party musicalchairs: 椅子は座面＋背もたれ＋脚の造形で円形に並ぶ", () => {
  const scene = read("app", "games", "musicalchairs", "MusicalChairsScene3D.tsx");
  assert.match(scene, /createChair/, "椅子を造形する");
  assert.match(scene, /chairPos/, "椅子を円形に配置する");
  assert.match(scene, /CHAIR_R/, "椅子の円半径を持つ");
  assert.match(scene, /createPeg|createBall/, "プレイヤーマーカーは円柱＋球で造形する");
  assert.match(scene, /SEAT_COLORS/, "マーカーは座席ごとの色で区別する");
});

test("3D batch6-party musicalchairs: 周回は再生状態への追従だけで、勝敗判定を再実装しない", () => {
  const scene = read("app", "games", "musicalchairs", "MusicalChairsScene3D.tsx");
  assert.match(scene, /orbitAngle/, "シーン内時計で周回を表現する");
  assert.match(scene, /phase === "playing"/, "周回は音楽再生中だけ進む");
  assert.doesNotMatch(scene, /eliminated|winnerSeat|resolveRound|stopAt/, "脱落・勝敗・停止時刻の判定を 3D 側で再実装しない");
  assert.match(scene, /chairs: Map|chairs\.set|rt\.chairs/, "椅子はキー単位 Map で差分同期する");
  assert.match(scene, /exiting/, "椅子が減るときの消滅アニメーションがある");
});

test("3D batch6-party musicalchairs: 椅子タップが既存 sit ハンドラへ接続され、判定は親の canSit が持つ", () => {
  const scene = read("app", "games", "musicalchairs", "MusicalChairsScene3D.tsx");
  assert.match(scene, /chair-\$\{idx\}|`chair-/, "椅子に pickId を付ける");
  assert.match(scene, /propsRef\.current\.onSit\(\)/, "椅子タップが onSit を呼ぶ");
  assert.match(scene, /propsRef\.current\.canSit/, "座れるかは親の判定に従う");
  const client = read("app", "games", "musicalchairs", "MusicalChairsClient.tsx");
  assert.match(client, /onSit=\{doSit\}/, "既存の doSit へ接続する");
  assert.match(client, /api\.move\(\{ type: "sit" \}\)/, "送信アクションは既存の sit のまま");
  assert.match(client, /canSit=\{canSit\}/, "フェーズ・生存・着席判定済みの canSit を渡す");
});

test("3D batch6-party: ロジック層（lib/online/games/nanja.ts, musicalchairs.ts）に three が混入していない", () => {
  for (const f of ["nanja.ts", "musicalchairs.ts"]) {
    assert.doesNotMatch(read("lib", "online", "games", f), /from "three"/, `lib/online/games/${f}`);
  }
});

test("3D batch6-party: クライアントは three-kit を直接触らない", () => {
  for (const g of BATCH) {
    const client = read("app", "games", g.dir, g.client);
    assert.doesNotMatch(client, /three-kit/, `${g.dir} client は基盤を直接触らない`);
  }
});
