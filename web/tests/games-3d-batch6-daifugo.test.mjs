// 3D化 第6バッチ（daifugo / 大富豪オンライン）の回帰テスト（静的検査）。
// 先行バッチ（games-3d-batch3-cards / batch5-battle）の流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D（board2d）へフォールバックする
// - <button> 数が現行（daifugo 3）から増えていないこと
// - 秘匿: 他プレイヤーは view の count（枚数）だけから裏向き・ラベルなしで描き、
//   手札の中身を一切参照しないこと
// - 入力は既存の選択トグル（toggleCard）へ接続され、出す／パスは既存 DOM のまま
// - ロジック（lib/online/games/daifugo.ts）へ three が混入していないこと
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

test("3D batch6 daifugo: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ", () => {
  const client = read("app", "games", "daifugo", "DaifugoClient.tsx");
  assert.match(client, /dynamic\(\(\) => import\("\.\/DaifugoScene3D"\), \{ ssr: false \}\)/, "dynamic import");
  assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /from "three"/);
  assert.match(scene, /three-kit/, "共通基盤を使う");
  assert.match(scene, /createStage/, "ステージは共通基盤から作る");
  assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
  assert.match(scene, /SceneBox/, "外枠は共通の SceneBox を使う");
  assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  assert.match(client, /webglFailed \? board2d/, "WebGL 失敗時は board2d を直接描く");
});

test("3D batch6 daifugo: シーンはカード系の型（createCard）を使い、差分同期する", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /createCard/, "カードは three-kit の createCard で作る");
  assert.match(scene, /"#c62828"/, "赤カードのラベル色");
  assert.match(scene, /"#1c2333"/, "黒カードのラベル色");
  assert.match(scene, /entries: Map<string, CardEntry>/, "スロットを Map で管理する");
  assert.match(scene, /cardKey/, "カードキーで差分判定する");
  assert.match(scene, /`h\$\{i\}`/, "自分の手札はスロットキーで管理する");
  assert.match(scene, /`f\$\{i\}`/, "場札はスロットキーで管理する");
  assert.match(scene, /`o\$\{other\.seat\}-\$\{i\}`/, "他プレイヤーは席＋連番のスロットキーで管理する");
  // 新規の場札は出した人の手札エリアから中央へフライインする
  assert.match(scene, /seatPos\(field\.seat/, "場札の起点は出した人の席");
  assert.match(scene, /fromPos: ownerPos/, "場札は出した人の手札エリアから飛ぶ");
  // 場が流れると場札スロットが desired から消えて除去される経路がある
  assert.match(scene, /if \(!desired\.has\(slot\)\)/, "不要スロットを除去する（流れた場札を含む）");
});

test("3D batch6 daifugo: 自分の手札は扇状で、枚数に応じて間隔を圧縮する", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /handSpacing/, "手札の間隔を枚数から決める");
  assert.match(scene, /Math\.min\(0\.6,/, "間隔には上限があり、多いときは圧縮される");
  assert.match(scene, /yourHand/, "自分の手札は view の yourHand だけを描く");
});

test("3D batch6 daifugo: 秘匿 — 他プレイヤーは裏向き・ラベルなしの枚数表現のみ", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  // 他プレイヤー用の型は枚数（count）だけを持ち、手札の中身を持たない
  const otherType = scene.match(/interface DaifugoSceneOther \{[^}]*\}/)?.[0] ?? "";
  assert.match(otherType, /count: number/, "他プレイヤーは count のみ");
  assert.doesNotMatch(otherType, /hand|cards/, "他プレイヤー型に手札の中身がない");
  // 他プレイヤーのカードは id: null（裏向き）でだけ生成する
  assert.match(scene, /id: null/, "他プレイヤーは裏向きで生成する");
  assert.match(scene, /other\.count/, "生成枚数は count だけから決まる");
  assert.doesNotMatch(scene, /other\.hand|other\.cards|othersHand|hands\[/, "他人の手札の中身を参照しない");
  // 裏向きカードはラベルなしで生成する（createCard に label を渡さない分岐）
  assert.match(scene, /createCard\(CARD_W, CARD_H, \{\}\)/, "裏向きカードはラベルなしで生成する");
  const client = read("app", "games", "daifugo", "DaifugoClient.tsx");
  assert.match(client, /others=\{state\.others\}/, "クライアントは view の others（枚数のみ）を渡す");
});

test("3D batch6 daifugo: 選択中は金縁＋持ち上げ、手番でないときは減光する", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /0xf2b33d/, "選択中の金縁フレーム");
  assert.match(scene, /isSelected \? 0\.22 : 0\.05/, "選択中のカードを持ち上げる");
  assert.match(scene, /frameColor: isSelected \? 0xf2b33d/, "選択状態をフレーム色へ反映する");
  assert.match(scene, /setCardDim/, "減光ヘルパーがある");
  assert.match(scene, /dim: !isMyTurn/, "手番でないときの減光は DOM の disabled と一致する");
});

test("3D batch6 daifugo: 手札タップは既存の選択トグルへ接続され、出す／パスは DOM のまま", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /pickId = `card-\$\{pickCardId\}`/, "手札カードに pickId を付ける");
  assert.match(scene, /onCardTap\(id\)/, "タップが onCardTap へ接続される");
  const client = read("app", "games", "daifugo", "DaifugoClient.tsx");
  assert.match(client, /onCardTap=\{toggleCard\}/, "既存の toggleCard ハンドラへ接続する");
  assert.match(client, /const toggleCard = \(id: number\)/, "選択トグルは既存ハンドラ");
  assert.match(client, /api\.move\(\{ type: "play", cards \}\)/, "出札は従来どおり api.move の play");
  assert.match(client, /api\.move\(\{ type: "pass" \}\)/, "パスは従来どおり api.move の pass");
  assert.match(client, /出す/, "出すボタンは DOM に残る");
  assert.match(client, /パス/, "パスボタンは DOM に残る");
});

test("3D batch6 daifugo: ジョーカーは JOKER 表記で、絵文字 UI を使わない", () => {
  const scene = read("app", "games", "daifugo", "DaifugoScene3D.tsx");
  assert.match(scene, /"JOKER"/, "ジョーカーは JOKER ラベルで表す");
  assert.doesNotMatch(scene, /★/, "ジョーカー表現に星の装飾を使わない");
  assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}]/u, "シーンに絵文字 UI がない");
});

test("3D batch6 daifugo: <button> 数が現行（3）から増えていない", () => {
  assert.equal(countButtons("daifugo"), 3, `daifugo buttons=${countButtons("daifugo")}`);
});

test("3D batch6 daifugo: ロジック層（lib/online/games/daifugo.ts）に three が混入していない", () => {
  assert.doesNotMatch(read("lib", "online", "games", "daifugo.ts"), /from "three"/, "lib/online/games/daifugo.ts");
});
