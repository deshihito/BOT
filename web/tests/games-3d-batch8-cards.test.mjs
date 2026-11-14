// 3D化 第8バッチ カード・トークン系（memory / janken / bombpass / hagetaka）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（memory 3 / janken 0 / bombpass 1 / hagetaka 1）以下
// - 入力が既存ハンドラ（memory: onFlip / janken: doThrow / bombpass: doPass /
//   hagetaka: doBid）へ接続される
// - 合法判定・勝敗判定を 3D 側で再実装していないこと
// - 秘匿情報をシーンへ渡していないこと:
//   memory は裏向きカードの絵柄、janken は公開前の相手の手、
//   bombpass は爆発タイマー、hagetaka は他人の未公開入札
// - ロジック層（lib/memory-match.ts, lib/online/games/*.ts）へ three が混入していないこと
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
const sceneJsxOf = (client, sceneName) => {
  const start = client.indexOf(`<${sceneName}`);
  return client.slice(start, client.indexOf("/>", start));
};

const BATCH = [
  { dir: "memory", client: "MemoryClient.tsx", scene: "MemoryScene3D.tsx", buttons: 3 },
  { dir: "janken", client: "JankenClient.tsx", scene: "JankenScene3D.tsx", buttons: 0 },
  { dir: "bombpass", client: "BombPassClient.tsx", scene: "BombPassScene3D.tsx", buttons: 1 },
  { dir: "hagetaka", client: "HagetakaClient.tsx", scene: "HagetakaScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch8-cards ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは three-kit を直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /onFail=\{\(\) => setWebglFailed\(true\)\}/, "onFail で 2D 表示へ切り替える");
  });

  test(`3D batch8-cards ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-cards ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });
}

test("3D batch8-cards memory: カードはフリップ回転でめくれ、ペア確定は持ち上げ＋発光で表す", () => {
  const scene = read("app", "games", "memory", "MemoryScene3D.tsx");
  assert.match(scene, /FACE_UP/, "表向きの回転を持つ");
  assert.match(scene, /FACE_DOWN/, "裏向きの回転を持つ");
  assert.match(scene, /targetRotX/, "フリップは目標回転への補間追従で表す");
  assert.match(scene, /Math\.exp\(-dt/, "補間は指数追従");
  assert.match(scene, /cardsRt/, "カードは差分同期で管理する");
  assert.match(scene, /canvasTexture/, "絵柄は CanvasTexture に図形として描く");
  assert.match(scene, /memorySymbol/, "絵柄の形×色は lib の定義を使う");
  assert.match(scene, /emissiveIntensity/, "ペア確定は発光で示す");
  assert.match(scene, /targetY: card\.matched \? 0\.22/, "ペア確定は持ち上げで示す");
});

test("3D batch8-cards memory: タップが既存の onFlip へ接続され、照合を 3D 側で再実装しない", () => {
  const scene = read("app", "games", "memory", "MemoryScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onFlip\(Number\(id\.slice\(5\)\)\)/, "タップが onFlip を呼ぶ");
  assert.doesNotMatch(scene, /(flipCard|settlePair|createMemoryGame|isPairPending)\s*\(/, "めくり・照合を 3D 側で再実装しない");
  const client = read("app", "games", "memory", "MemoryClient.tsx");
  assert.match(client, /onFlip=\{onFlip\}/, "既存の onFlip へ接続する");
  assert.match(client, /flipCard\(s, index\)/, "状態遷移は lib の flipCard のまま");
  assert.match(client, /settlePair\(s\)/, "照合は lib の settlePair のまま");
});

test("3D batch8-cards memory: 裏向きカードの絵柄をシーンへ渡さない", () => {
  const client = read("app", "games", "memory", "MemoryClient.tsx");
  assert.match(client, /icon: faceUp \? card\.icon : null/, "絵柄は表向きの間だけ渡す");
  const scene = read("app", "games", "memory", "MemoryScene3D.tsx");
  assert.match(scene, /icon: string \| null/, "シーンは絵柄を nullable で受け取る");
});

test("3D batch8-cards janken: 手は造形で判別できる（グー=塊 / チョキ=2指 / パー=平板）", () => {
  const scene = read("app", "games", "janken", "JankenScene3D.tsx");
  assert.match(scene, /createHandMesh/, "手を造形する");
  assert.match(scene, /IcosahedronGeometry\(0\.46/, "グーは角ばった塊で表す");
  assert.match(scene, /CylinderGeometry\(0\.085, 0\.105, 0\.92/, "チョキは細長い指で表す");
  assert.match(scene, /rotation\.z = 0\.38/, "チョキの指は V 字に開く");
  assert.match(scene, /BoxGeometry\(1\.02, 0\.14, 1\.18\)/, "パーは平らな平板で表す");
  assert.match(scene, /createBall/, "手のひらは球も使う");
});

test("3D batch8-cards janken: 手のタップが既存の提出ハンドラへ接続され、勝敗判定を 3D 側で再実装しない", () => {
  const scene = read("app", "games", "janken", "JankenScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onThrow\(id\.slice\(5\) as JankenHand3D\)/, "タップが onThrow を呼ぶ");
  assert.doesNotMatch(scene, /api\.move/, "シーンは move を直接送らない");
  const client = read("app", "games", "janken", "JankenClient.tsx");
  assert.match(client, /onThrow=\{doThrow\}/, "既存の提出ラッパへ接続する");
  assert.match(client, /void api\.move\(\{ type: "throw", hand \}\)/, "提出は既存の throw move のまま");
});

test("3D batch8-cards janken: 公開前の相手の手をシーンへ渡さない（submitted のみ）", () => {
  const client = read("app", "games", "janken", "JankenClient.tsx");
  assert.match(client, /players=\{state\.players\.map\(\(p\) => \(\{ seat: p\.seat, submitted: p\.submitted/, "choosing で渡すのは提出状況だけ");
  assert.match(client, /revealed=\{state\.phase === "reveal" \?/, "手の中身は reveal のときだけ渡す");
  const scene = read("app", "games", "janken", "JankenScene3D.tsx");
  assert.match(scene, /submitted: boolean/, "シーンは提出状況だけを受け取る型を持つ");
});

test("3D batch8-cards bombpass: 爆弾は立体造形で、所持者の変化に補間追従して受け渡される", () => {
  const scene = read("app", "games", "bombpass", "BombPassScene3D.tsx");
  assert.match(scene, /createBomb/, "爆弾を造形する");
  assert.match(scene, /createBall\(0\.34, 0x171a21/, "爆弾の本体は黒い球");
  assert.match(scene, /bomb-spark/, "導火線の火花を持つ");
  assert.match(scene, /bombPos\.lerp\(target, k\)/, "爆弾は所持者へ補間追従する");
  assert.match(scene, /playersRt/, "プレイヤーは差分同期で管理する");
  assert.match(scene, /createPlayerToken/, "プレイヤーは人型トークンで表す");
});

test("3D batch8-cards bombpass: 相手トークンのタップが既存のパスハンドラへ接続される", () => {
  const scene = read("app", "games", "bombpass", "BombPassScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onPass\(Number\(id\.slice\(5\)\)\)/, "タップが onPass を呼ぶ");
  assert.doesNotMatch(scene, /api\.move/, "シーンは move を直接送らない");
  const client = read("app", "games", "bombpass", "BombPassClient.tsx");
  assert.match(client, /onPass=\{doPass\}/, "既存のパス用ラッパへ接続する");
  assert.match(client, /void api\.move\(\{ type: "pass", target: seat \}\)/, "パスは既存の pass move のまま");
  assert.match(client, /void api\.move\(\{ type: "pass", target: p\.seat \}\)/, "2D ボタンのパスも従来どおり");
});

test("3D batch8-cards bombpass: 爆発タイマー（秘匿情報）をシーンへ渡さない", () => {
  const scene = read("app", "games", "bombpass", "BombPassScene3D.tsx");
  assert.doesNotMatch(scene, /(explodeAt|remainingMs|deadlineAt|bombTimer)/, "シーンはタイマー情報を受け取らない");
  const client = read("app", "games", "bombpass", "BombPassClient.tsx");
  const jsx = sceneJsxOf(client, "BombPassScene3D");
  assert.doesNotMatch(jsx, /lastEvent/, "クライアントはシーンへ lastEvent（内部イベント）を渡さない");
  assert.match(jsx, /holderSeat=\{state\.holder\}/, "シーンへ渡すのは公開済みの所持者だけ");
});

test("3D batch8-cards hagetaka: カード型の流用で、数字は大きな数字テクスチャで描く", () => {
  const scene = read("app", "games", "hagetaka", "HagetakaScene3D.tsx");
  assert.match(scene, /createCard/, "カードは three-kit の createCard を使う");
  assert.match(scene, /label: value > 0 \? `\+\$\{value\}`/, "得点カードは大きな数字で描く");
  assert.match(scene, /label: String\(card\)/, "手札カードは大きな数字で描く");
  assert.match(scene, /entries/, "カードは差分同期（entries）で管理する");
  assert.match(scene, /0xf2b33d/, "獲得・提出済みは金縁で示す");
});

test("3D batch8-cards hagetaka: 手札タップが既存の入札ハンドラへ接続され、勝敗判定を 3D 側で再実装しない", () => {
  const scene = read("app", "games", "hagetaka", "HagetakaScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onBid\(card\)/, "タップが onBid を呼ぶ");
  assert.doesNotMatch(scene, /api\.move/, "シーンは move を直接送らない");
  const client = read("app", "games", "hagetaka", "HagetakaClient.tsx");
  assert.match(client, /onBid=\{doBid\}/, "既存の入札ラッパへ接続する");
  assert.match(client, /void api\.move\(\{ type: "bid", card \}\)/, "入札は既存の bid move のまま");
});

test("3D batch8-cards hagetaka: 他人の未公開入札をシーンへ渡さない（submitted のみ、手札は自分のものだけ）", () => {
  const client = read("app", "games", "hagetaka", "HagetakaClient.tsx");
  assert.match(client, /submitted=\{state\.players\.map\(\(pl\) => \(\{ seat: pl\.seat, submitted: pl\.submitted/, "他人について渡すのは提出状況だけ");
  assert.match(client, /hand=\{state\.you\.hand\}/, "シーンへ渡す手札は自分のものだけ");
  const jsx = sceneJsxOf(client, "HagetakaScene3D");
  assert.doesNotMatch(jsx, /players\.map\(\(pl\) => \(\{[^}]*card/, "他人のカードをシーンへ渡さない");
  const scene = read("app", "games", "hagetaka", "HagetakaScene3D.tsx");
  assert.match(scene, /submitted: boolean/, "シーンは提出状況だけを受け取る型を持つ");
});

test("3D batch8-cards: ロジック層（lib/memory-match.ts, lib/online/games/*.ts）に three が混入していない", () => {
  assert.doesNotMatch(read("lib", "memory-match.ts"), /from "three"/, "lib/memory-match.ts");
  for (const f of ["janken.ts", "bombpass.ts", "hagetaka.ts"]) {
    assert.doesNotMatch(read("lib", "online", "games", f), /from "three"/, `lib/online/games/${f}`);
    assert.doesNotMatch(read("lib", "online", "games", f), /three-kit/, `lib/online/games/${f}`);
  }
});
