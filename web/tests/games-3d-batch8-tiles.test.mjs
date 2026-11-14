// 3D化 第8バッチ タイル系（floodit / samegame / touchnumber）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（floodit 2 / samegame 2 / touchnumber 3）以下
// - 入力が既存ハンドラへ接続され、判定を 3D 側で再実装していないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
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
  { dir: "floodit", client: "FloodItClient.tsx", scene: "FloodItScene3D.tsx", buttons: 2, lib: "floodit.ts" },
  { dir: "samegame", client: "SameGameClient.tsx", scene: "SameGameScene3D.tsx", buttons: 2, lib: "samegame.ts" },
  { dir: "touchnumber", client: "TouchNumberClient.tsx", scene: "TouchNumberScene3D.tsx", buttons: 3, lib: "touchnumber.ts" },
];

for (const g of BATCH) {
  test(`3D batch8-tiles ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /pickId = `cell-\$\{i\}`/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch8-tiles ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-tiles ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-tiles ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch8-tiles floodit: 立体タイルは InstancedMesh で軽量化し、色は現行 2D と一致する", () => {
  const scene = read("app", "games", "floodit", "FloodItScene3D.tsx");
  assert.match(scene, /InstancedMesh/, "144 マスのタイルは InstancedMesh で描く");
  assert.match(scene, /setColorAt/, "色は instanceColor で差分同期する");
  assert.match(scene, /0xef4444/, "赤は現行 2D と同じ");
  assert.match(scene, /0x22c55e/, "緑は現行 2D と同じ");
  assert.match(scene, /0xa855f7/, "紫は現行 2D と同じ");
});

test("3D batch8-tiles floodit: 領域は高さの差分で表現し、領域集合は親の計算結果を使う", () => {
  const scene = read("app", "games", "floodit", "FloodItScene3D.tsx");
  assert.match(scene, /REGION_H/, "領域タイルは高くする");
  assert.match(scene, /region\.has\(i\)/, "領域判定は親から渡された集合を使う");
  assert.doesNotMatch(scene, /floodRegionIndices\(/, "領域計算を 3D 側で再実装しない");
  const client = read("app", "games", "floodit", "FloodItClient.tsx");
  assert.match(client, /region=\{region\}/, "領域は親の floodRegionIndices 結果を渡す");
});

test("3D batch8-tiles floodit: 盤タップとパレットが現行の pickColor（applyFloodMove）へ接続される", () => {
  const scene = read("app", "games", "floodit", "FloodItScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.doesNotMatch(scene, /applyFloodMove\(/, "塗り広げを 3D 側で再実装しない");
  const client = read("app", "games", "floodit", "FloodItClient.tsx");
  assert.match(client, /onCell=\{handleCellTap\}/, "3D 盤タップは handleCellTap へ接続する");
  assert.match(client, /const handleCellTap[\s\S]*?pickColor\(color\)/, "盤タップはそのマスの色を pickColor へ渡す");
  assert.match(client, /const pickColor[\s\S]*?applyFloodMove\(s, color\)/, "色選択は既存の applyFloodMove 経路を使う");
  assert.match(client, /onClick=\{\(\) => pickColor\(color\)\}/, "DOM パレットも同じ pickColor へ接続する");
});

test("3D batch8-tiles samegame: 立体ブロックの色は現行 2D と一致する", () => {
  const scene = read("app", "games", "samegame", "SameGameScene3D.tsx");
  assert.match(scene, /0xe2534a/, "赤は現行 2D と同じ");
  assert.match(scene, /0x3f7fbf/, "青は現行 2D と同じ");
  assert.match(scene, /0x8d5bb5/, "紫は現行 2D と同じ");
  assert.match(scene, /emissive/, "ホバーグループは発光で示す");
});

test("3D batch8-tiles samegame: タップとホバーが現行ハンドラへ接続され、消去判定を再実装しない", () => {
  const scene = read("app", "games", "samegame", "SameGameScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.match(scene, /propsRef\.current\.onHover\(/, "ホバーが onHover を呼ぶ");
  assert.match(scene, /hover: true/, "ホバーのレイキャストを有効にする");
  assert.doesNotMatch(scene, /removeSameGameGroup\(|sameGameGroupAt\(|sameGameSettle\(/, "消去・グループ・重力の判定を 3D 側で再実装しない");
  const client = read("app", "games", "samegame", "SameGameClient.tsx");
  assert.match(client, /onCell=\{tapBlockAt\}/, "既存の tapBlockAt へ接続する");
  assert.match(client, /onHover=\{setHover\}/, "ホバーは既存の setHover へ接続する");
  assert.match(client, /const tapBlockAt[\s\S]*?removeSameGameGroup\(s, i\)/, "消去は既存の removeSameGameGroup 経路を使う");
  assert.match(client, /hoverGroup=\{hoverGroup\}/, "ホバーグループは親の計算結果を渡す");
});

test("3D batch8-tiles samegame: 落下・左詰めは目標位置への補間で追従する（差分同期）", () => {
  const scene = read("app", "games", "samegame", "SameGameScene3D.tsx");
  assert.match(scene, /b\.grp\.position\.z \+= \(b\.tz - b\.grp\.position\.z\) \* k/, "行方向（落下）を補間する");
  assert.match(scene, /b\.grp\.position\.x \+= \(b\.tx - b\.grp\.position\.x\) \* k/, "列方向（左詰め）を補間する");
  assert.match(scene, /落下/, "落下アニメーションの意図を冒頭コメントに明記する");
});

test("3D batch8-tiles touchnumber: 数字は上面テクスチャで大きく太く描く", () => {
  const scene = read("app", "games", "touchnumber", "TouchNumberScene3D.tsx");
  assert.match(scene, /createNumberTile/, "数字タイルを造形する");
  assert.match(scene, /canvasTexture/, "数字は上面テクスチャで描く");
  assert.match(scene, /bold 92px/, "数字は大きく太く描く");
  assert.match(scene, /0xd9a41c/, "次の数字の金色は現行 2D と同じ");
  assert.match(scene, /emissive/, "次の数字は発光で強調する");
});

test("3D batch8-tiles touchnumber: タップが現行の onTap へ接続され、順番判定を再実装しない", () => {
  const scene = read("app", "games", "touchnumber", "TouchNumberScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onTap\(/, "タップが onTap を呼ぶ");
  assert.doesNotMatch(scene, /tapCell\(|tapValue\(|isCleared\(/, "順番判定・ミス集計を 3D 側で再実装しない");
  const client = read("app", "games", "touchnumber", "TouchNumberClient.tsx");
  assert.match(client, /onTap=\{onTap\}/, "既存の onTap へ接続する");
  assert.match(client, /next=\{state\.next\}/, "次の数字は親の状態を渡す");
  assert.match(client, /wrongIndex=\{wrongIndex\}/, "ミス表示は親の状態を渡す");
});
