// LLL: WorldBox 同様の独立フルビューポートシェル配線・AIスロップ排除・ホームハブ検証テスト。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/lll/LllClient.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../app/games/lll/LllHomeView.tsx", import.meta.url), "utf8");
const lllCss = await readFile(new URL("../app/games/lll/lll.css", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const page = await readFile(new URL("../app/games/[id]/page.tsx", import.meta.url), "utf8");
const chrome = await readFile(new URL("../lib/site-chrome.ts", import.meta.url), "utf8");

test("LLL は CHROMELESS_PATHS に登録され、ゲーム詳細ページで GameDetailHeader を出さない", () => {
  assert.match(chrome, /"\/games\/lll"/);
  const start = page.indexOf('game.slug === "lll"');
  assert.ok(start >= 0, 'game.slug === "lll" の分岐が存在する');
  const branch = page.slice(start, page.indexOf("\n  }", start));
  assert.match(branch, /<LllClient \/>/);
  assert.doesNotMatch(branch, /GameDetailHeader/);
});

test("globals.css が共通 main と Activity 埋め込みの中央カラムを .lll-shell で打ち消す", () => {
  assert.match(globalsCss, /body:has\(\.lll-shell\) > main \{ max-width:none; min-height:0; margin:0; padding:0; \}/);
  assert.match(globalsCss, /\.games-shell\[data-activity-root\]:has\(\.lll-shell\) \{ max-width:none; margin:0; padding:0; \}/);
  assert.match(globalsCss, /\.games-shell\[data-activity-root\]:has\(\.lll-shell\) > \.games-embedded-bar \{ display:none; \}/);
});

test("LllClient は独立シェル (.lll-shell)・専用トップバー・独立フッターとハブ初期表示を持つ", () => {
  assert.match(client, /useState<Tab>\("hub"\)/);
  assert.ok((client.match(/className="lll-shell lll-table"/g) ?? []).length >= 2);
  assert.match(client, /className="lll-appbar"/);
  assert.match(client, /className="lll-footer"/);
  assert.match(client, /href=\{`\$\{prefix\}\/games`\}/);
});

test("AIスロップ（ネオン紫グラデ・定型キャッチコピー・UI絵文字乱用）が混入していない", () => {
  for (const [label, src] of [
    ["LllClient.tsx", client],
    ["LllHomeView.tsx", home],
    ["lll.css", lllCss],
  ]) {
    assert.doesNotMatch(src, /#7c5cff/i, `${label} に旧ネオン紫 #7c5cff が残っている`);
    assert.doesNotMatch(src, /#a78bfa/i, `${label} に旧ネオン紫 #a78bfa が残っている`);
    assert.doesNotMatch(src, /#f472b6/i, `${label} に旧ネオンピンク #f472b6 が残っている`);
    assert.doesNotMatch(src, /想像を、切り札に/, `${label} に旧AIキャッチコピーが残っている`);
  }
});
