// 3D化 第6バッチ（カード系3: cheat / burst）の回帰テスト（静的検査）。
// 先行バッチ（batch2-cards / batch3-cards）のスタイルに倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer を使う
// - 差分同期（スロットキー＋カードキー Map）・選択の金縁（0xf2b33d）がある
// - <button> 数が現行（cheat 3 / burst 3）から増えていないこと
// - ロジック（lib/online/games/*.ts）へ three が混入していないこと
// - 秘匿: cheat の場の伏せ札・相手手札は label なしの裏面のみで描き、
//   burst のシーンは他プレイヤーの手札情報を受け取らないこと
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
  { dir: "cheat", client: "CheatClient.tsx", scene: "CheatScene3D.tsx", buttons: 3 },
  { dir: "burst", client: "BurstClient.tsx", scene: "BurstScene3D.tsx", buttons: 3 },
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

  test(`3D batch6 ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer"]) {
      assert.match(scene, new RegExp(name), name);
    }
    // 差分同期（スロット＋カードキーの Map でカードを管理する型）であること
    assert.match(scene, /entries/, "スロット単位でカードを差分管理する");
    assert.match(scene, /cardKey/, "カードキーで差分判定する");
    // 選択中カードの金縁フレーム
    assert.match(scene, /0xf2b33d/, "選択中の金縁フレーム");
    // 無効状態の減光
    assert.match(scene, /opacity = dim \? 0\.5 : 1|setCardDim/, "無効カードを減光する");
  });

  test(`3D batch6 ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch6 cheat: 場の山は伏せ札のみ（label を付けない裏面）で積まれる", () => {
  const scene = read("app", "games", "cheat", "CheatScene3D.tsx");
  assert.match(scene, /pileCount/, "場の山の枚数を受け取る");
  // id が null のカードは createCard に label を渡さず裏面のみで作る
  assert.match(scene, /id === null\s*\?\s*createCard\(CARD_W, CARD_H, \{\}\)/, "伏せカードは label なしで作る");
  assert.match(scene, /id: null/, "山と相手手札のスロットは id null（中身を参照しない）");
  assert.match(scene, /FACE_DOWN/, "伏せ札は裏向きに置く");
});

test("3D batch6 cheat: 相手の手札は count だけから裏向き枚数表現を作る（中身を受け取らない）", () => {
  const scene = read("app", "games", "cheat", "CheatScene3D.tsx");
  assert.match(scene, /others/, "相手情報をシーンが受け取る");
  assert.match(scene, /o\.count/, "相手は枚数だけを使う");
  const client = read("app", "games", "cheat", "CheatClient.tsx");
  // クライアントがシーンへ渡す相手情報は seat と count のみ
  assert.match(client, /others=\{state\.others\.map\(\(o\) => \(\{ seat: o\.seat, count: o\.count \}\)\)\}/, "相手の手札の中身をシーンへ渡さない");
});

test("3D batch6 cheat: 手札タップは既存の選択トグルへ接続し、複数選択が金縁で表される", () => {
  const scene = read("app", "games", "cheat", "CheatScene3D.tsx");
  assert.match(scene, /onCardTap/, "手札タップはコールバックを呼ぶだけ");
  assert.match(scene, /pickId = `card-\$\{pickCardId\}`|pickId.*card-/, "手札カードに pickId を付ける");
  assert.match(scene, /selected/, "選択状態をシーンが受け取る");
  const client = read("app", "games", "cheat", "CheatClient.tsx");
  assert.match(client, /onCardTap=\{handleCardTap\}/, "既存ハンドラへ接続する");
  assert.match(client, /toggleCard\(id\)/, "選択トグル（toggleCard）をそのまま使う");
});

test("3D batch6 cheat: チャレンジ開示は裏→表のフリップでめくれる", () => {
  const scene = read("app", "games", "cheat", "CheatScene3D.tsx");
  assert.match(scene, /revealCards/, "開示カードをシーンが受け取る");
  assert.match(scene, /revealKey/, "開示の同一性キーでフリップし直す");
  assert.match(scene, /flip/, "フリップ遷移を持つ");
  assert.match(scene, /FACE_UP/, "表向きの回転へ遷移する");
  const client = read("app", "games", "cheat", "CheatClient.tsx");
  assert.match(client, /revealCards=\{state\.lastReveal\?\.cards \?\? null\}/, "開示は lastReveal（公開情報）だけを渡す");
});

test("3D batch6 burst: 場の列と手札タップ（選択は既存ハンドラ、確定は DOM ボタン）がある", () => {
  const scene = read("app", "games", "burst", "BurstScene3D.tsx");
  assert.match(scene, /rows/, "場の列をシーンが受け取る");
  assert.match(scene, /onCardTap/, "手札タップはコールバックを呼ぶだけ");
  assert.match(scene, /onRowTap/, "列タップはコールバックを呼ぶだけ");
  const client = read("app", "games", "burst", "BurstClient.tsx");
  assert.match(client, /onCardTap=\{handleCardTap\}/);
  assert.match(client, /setSelected\(card\)/, "タップは既存の選択操作に接続する");
  assert.match(client, /onRowTap=\{handleRowTap\}/);
  assert.match(client, /api\.move\(\{ type: "takeRow", row \}\)/, "列タップは既存の takeRow と同じ move を送る");
});

test("3D batch6 burst: シーンは他プレイヤーの手札・提出カードを受け取らない（秘匿）", () => {
  const scene = read("app", "games", "burst", "BurstScene3D.tsx");
  assert.doesNotMatch(scene, /players/, "他プレイヤー情報をシーンへ持ち込まない");
  assert.doesNotMatch(scene, /submitted/, "他人の提出状況をシーンで描かない");
  const client = read("app", "games", "burst", "BurstClient.tsx");
  assert.match(client, /myHand=\{state\.you\.hand\}/, "自分の手札だけをシーンへ渡す");
  assert.match(client, /pendingCard=\{state\.you\.pendingCard\}/, "pendingCard は自分のものだけを渡す");
});

test("3D batch6 burst: 列の状態表現（5枚=赤縁、列選択中=金縁、pendingCard=金縁）がある", () => {
  const scene = read("app", "games", "burst", "BurstScene3D.tsx");
  assert.match(scene, /0xc62828/, "5枚の列の赤縁");
  assert.match(scene, /pendingCard/, "pendingCard をシーンが受け取る");
  assert.match(scene, /choosing/, "列選択中の状態をシーンが受け取る");
  assert.match(scene, /row-/, "列カードに row 入りの pickId を付ける");
});

test("3D batch6: ロジック層（lib/online/games/cheat.ts, lib/online/games/burst.ts）に three が混入していない", () => {
  for (const f of ["cheat.ts", "burst.ts"]) {
    assert.doesNotMatch(read("lib", "online", "games", f), /from "three"/, `lib/online/games/${f}`);
  }
});
