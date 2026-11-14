// 3D化 第6バッチ（カード系2: babanuki / speed）の回帰テスト（静的検査）。
// 先行バッチ（batch2-cards / batch3-cards）のスタイルに倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer / SceneBox を使う
// - 差分同期（スロットキー＋カードキー Map）で手札・台札を管理する
// - <button> 数が現行（babanuki 1 / speed 3）から増えていないこと
// - babanuki: 相手は枚数（count）だけをシーンへ渡し、中身を参照しないこと
//   / 引く操作は pickId (draw-<index>) 経由で既存の draw ハンドラへ接続されること
//   / ジョーカー（id 52）の表現があること
// - speed: 相手は場札・山札とも枚数だけを渡すこと / 場札・台札タップが既存
//   ハンドラへ接続されること / アニメーションが短め（200〜300ms）であること
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
  { dir: "babanuki", client: "BabanukiClient.tsx", scene: "BabanukiScene3D.tsx", buttons: 1 },
  { dir: "speed", client: "SpeedClient.tsx", scene: "SpeedScene3D.tsx", buttons: 3 },
];

for (const g of BATCH) {
  test(`3D batch6 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D batch6 ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer/SceneBox）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer", "SceneBox"]) {
      assert.match(scene, new RegExp(name), name);
    }
    // 差分同期（スロット＋カードキーの Map で管理する型）であること
    assert.match(scene, /entries/, "スロット単位で差分管理する");
    assert.match(scene, /cardKey/, "カードキーで差分判定する");
    assert.match(scene, /propsRef/, "propsRef で最新 props を参照する");
    // 選択中 = 金縁フレーム（0xf2b33d）
    assert.match(scene, /0xf2b33d/, "金縁フレーム");
  });

  test(`3D batch6 ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch6 ${g.dir}: シーンに絵文字 UI がない（スート記号はカードラベルとしてのみ）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{261F}\u{2700}-\u{27BF}]/u, "絵文字を使わない");
  });
}

test("3D batch6 babanuki: 相手は枚数（count）だけをシーンへ渡し、中身を参照しない", () => {
  const client = read("app", "games", "babanuki", "BabanukiClient.tsx");
  assert.match(client, /others=\{state\.others\.map\(\(o\) => \(\{ seat: o\.seat, count: o\.count \}\)\)\}/, "seat と count だけを渡す");
  const scene = read("app", "games", "babanuki", "BabanukiScene3D.tsx");
  assert.match(scene, /count/, "枚数で裏向きの扇を作る");
  assert.doesNotMatch(scene, /other\.hand|others\[.*\]\.hand/, "相手の手札の中身を参照しない");
});

test("3D batch6 babanuki: 相手の扇タップ = 既存の draw ハンドラ（index 指定）へ接続される", () => {
  const scene = read("app", "games", "babanuki", "BabanukiScene3D.tsx");
  assert.match(scene, /draw-\$\{i\}|draw-/, "引くカードに pickId を付ける");
  assert.match(scene, /onDrawTap/, "タップはコールバックを呼ぶだけ");
  const client = read("app", "games", "babanuki", "BabanukiClient.tsx");
  assert.match(client, /onDrawTap=\{doDraw\}/, "既存ハンドラへ接続する");
  assert.match(client, /api\.move\(\{ type: "draw", index \}\)/, "2D ボタンと同じ move を送る");
});

test("3D batch6 babanuki: 自分の手札はカード id スロットで管理し、ジョーカー表現がある", () => {
  const scene = read("app", "games", "babanuki", "BabanukiScene3D.tsx");
  assert.match(scene, /mine-id-\$\{id\}/, "自分の手札はカード id をスロットキーにする（ペア消滅は消滅として表れる）");
  assert.match(scene, /52/, "ジョーカー id を扱う");
  assert.match(scene, /JOKER/, "ジョーカーのラベル表現");
  assert.match(scene, /lastDraw/, "引いたカードのフライイン起点に lastDraw を使う");
});

test("3D batch6 speed: 台札2山と場札タップが既存ハンドラへ接続される", () => {
  const scene = read("app", "games", "speed", "SpeedScene3D.tsx");
  assert.match(scene, /centers/, "中央の台札を持つ");
  assert.match(scene, /hand-\$\{i\}|hand-/, "場札に pickId を付ける");
  assert.match(scene, /center-\$\{center\}|center-/, "台札に pickId を付ける");
  assert.match(scene, /onHandTap/, "場札タップはコールバックを呼ぶだけ");
  assert.match(scene, /onCenterTap/, "台札タップはコールバックを呼ぶだけ");
  const client = read("app", "games", "speed", "SpeedClient.tsx");
  assert.match(client, /onHandTap=\{onHandCard\}/, "既存の場札ハンドラへ接続する");
  assert.match(client, /onCenterTap=\{handleCenterTap\}/, "台札タップは選択中ハンドラへ接続する");
  assert.match(client, /api\.move\(\{ type: "play", handIndex, center \}\)/, "2D と同じ move を送る");
});

test("3D batch6 speed: 相手の場札は公開情報として表向き、山札は枚数だけをシーンへ渡す", () => {
  const client = read("app", "games", "speed", "SpeedClient.tsx");
  assert.match(client, /opponentField=\{opponent\.hand\}/, "相手の場札は公開情報なのでそのまま渡す");
  assert.match(client, /opponentStockCount=\{opponent\.stockCount\}/, "相手の山札は枚数だけ");
  assert.doesNotMatch(client, /opponent\.stocks/, "相手の山札の中身をシーンへ渡さない");
  const scene = read("app", "games", "speed", "SpeedScene3D.tsx");
  assert.match(scene, /opponentField: number\[\]/, "相手の場札は id 配列で受け取る");
  assert.match(scene, /opponentField\.forEach/, "相手の場札を表向きで描く");
});

test("3D batch6 speed: 選択中=金縁+持ち上げ、出せない札=減光、アニメーションは短め（200〜300ms）", () => {
  const scene = read("app", "games", "speed", "SpeedScene3D.tsx");
  assert.match(scene, /0xf2b33d/, "選択中の金縁フレーム");
  assert.match(scene, /opacity = dim \? 0\.5 : 1|opacity.*0\.5/, "無効札の減光");
  assert.match(scene, /dur: 260/, "フライインは短め");
  assert.match(scene, /dur: 200/, "再配置も短め");
});

test("3D batch6 speed: 出せる札の合法判定はクライアント側（yourPlays 由来）が持つ", () => {
  const client = read("app", "games", "speed", "SpeedClient.tsx");
  assert.match(client, /handLegal=\{you\.hand\.map\(\(_, i\) => legalCentersFor\(i\)\)\}/, "合法山を親が計算して渡す");
  assert.match(client, /selectedLegal\.includes\(center\)/, "台札タップの可否は親が判定する");
});
