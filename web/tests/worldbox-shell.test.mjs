// AGO WORLD BOX: 独立シェル（サイト共通クロームなし・100svh 全画面）の配線テスト。
// 共通ヘッダー/フッター・パンくず・見出し・判断材料ヘッダーを画面から外し、
// ステージが画面いっぱいになること、戻り導線が ≡ メニュー内にあることを確認する。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/worldbox/WorldBoxClient.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const page = await readFile(new URL("../app/games/[id]/page.tsx", import.meta.url), "utf8");

test("クライアントの外枠は .wb-shell で、画面外クロームを持たない", () => {
  // 本体・入場ゲートの両方が独立シェルで描かれる
  assert.ok((client.match(/className="wb-shell"/g) ?? []).length >= 2);
  // パンくず・ページ見出し・旧ステータス行は画面に置かない
  assert.doesNotMatch(client, /breadcrumbs/);
  assert.doesNotMatch(client, /page-heading/);
  assert.doesNotMatch(client, /classic-status/);
});

test("ステータスはステージ内のオーバーレイで出す（レイアウトを消費しない）", () => {
  assert.match(client, /position: "absolute", top: "calc\(10px \+ env\(safe-area-inset-top, 0px\)\)", left: "50%", transform: "translateX\(-50%\)"/);
  assert.match(client, /pointerEvents: "none", zIndex: 4/);
});

test("ワールド内の ≡ メニューに「ゲーム一覧へ」は置かない（没入感優先、ユーザー指示 2026-11-16）", () => {
  // 残る「ゲーム一覧へ」は入場ゲート画面の1件だけ（ワールドに入る前の導線）
  assert.equal((client.match(/ゲーム一覧へ/g) ?? []).length, 1);
  assert.equal((client.match(/href=\{`\$\{prefix\}\/games`\}/g) ?? []).length, 1);
});

test("globals.css が共通 main と Activity 埋め込みの中央カラムを打ち消す", () => {
  assert.match(css, /body:has\(\.wb-shell\) > main \{ max-width:none; min-height:0; margin:0; padding:0; \}/);
  assert.match(css, /\.games-shell\[data-activity-root\]:has\(\.wb-shell\) \{ max-width:none; margin:0; padding:0; \}/);
  assert.match(css, /\.games-shell\[data-activity-root\]:has\(\.wb-shell\) > \.games-embedded-bar \{ display:none; \}/);
  assert.match(css, /\.wb-shell \{ height:100svh;/);
});

test("ゲーム詳細ページは worldbox で GameDetailHeader を出さない", () => {
  const start = page.indexOf('game.slug === "worldbox"');
  const branch = page.slice(start, page.indexOf("\n  }", start));
  assert.match(branch, /<WorldBoxClient \/>/);
  assert.doesNotMatch(branch, /GameDetailHeader/);
});
