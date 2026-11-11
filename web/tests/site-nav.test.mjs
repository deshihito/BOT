// 共通レイアウトの導線定義（lib/site.ts の PRIMARY_NAV / UTILITY_NAV / FOOTER_GROUPS）が
// 「公開ページの入り口は共通レイアウト内の1か所だけ」「同じ行き先は同名でだけ重複可」
// という情報配置の規則を守っていることを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "site.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const allLinks = [
  ...m.PRIMARY_NAV,
  ...m.UTILITY_NAV,
  ...m.FOOTER_GROUPS.flatMap((g) => g.links),
];

test("主導線は探索系の4件で、ラベルが重複しない", () => {
  assert.deepEqual(
    m.PRIMARY_NAV.map((l) => l.href),
    ["/features", "/commands", "/games", "/ranking"],
  );
  const labels = m.PRIMARY_NAV.map((l) => l.label);
  assert.equal(new Set(labels).size, labels.length);
});

test("内部の行き先は共通レイアウト内にちょうど1か所だけ現れる", () => {
  const counts = new Map();
  for (const link of allLinks) {
    if (link.external) continue;
    counts.set(link.href, (counts.get(link.href) ?? 0) + 1);
  }
  for (const [href, count] of counts) {
    assert.equal(count, 1, `${href} が ${count} か所に置かれている`);
  }
});

test("重複してよいのはサポートサーバーだけで、名称が完全に一致する", () => {
  const byHref = new Map();
  for (const link of allLinks) {
    if (!byHref.has(link.href)) byHref.set(link.href, new Set());
    byHref.get(link.href).add(link.label);
  }
  for (const [href, labels] of byHref) {
    assert.equal(labels.size, 1, `${href} の名称が揺れている: ${[...labels].join(" / ")}`);
    if (labels.size === 1 && href !== m.SUPPORT_SERVER_URL) {
      const appearances = allLinks.filter((l) => l.href === href).length;
      assert.equal(appearances, 1, `${href} が同名のまま重複している`);
    }
  }
});

test("サイトマップの主要公開ページはすべて共通レイアウトから1回で届く", () => {
  const hrefs = new Set(allLinks.map((l) => l.href));
  for (const href of [
    "/features", "/commands", "/games", "/ranking",
    "/one-prompter", "/compute", "/status", "/credits", "/terms", "/privacy", "/faq",
  ]) {
    assert.ok(hrefs.has(href), `${href} への共通導線がない`);
  }
});

test("フッターは役割ごとの群に分かれ、ポリシー群は規約類だけを含む", () => {
  assert.deepEqual(
    m.FOOTER_GROUPS.map((g) => g.label),
    ["ツール", "サポート", "サイト情報", "ポリシー"],
  );
  const policy = m.FOOTER_GROUPS.find((g) => g.label === "ポリシー");
  assert.deepEqual(
    policy.links.map((l) => l.href),
    ["/terms", "/privacy"],
  );
  // フッターに主導線の複写を置かない
  const footerHrefs = new Set(m.FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href)));
  for (const link of m.PRIMARY_NAV) {
    assert.ok(!footerHrefs.has(link.href), `${link.href} がフッターにも複写されている`);
  }
});

test("isNavActive は配下ページで親を現在地とし、紛らわしい前方一致を弾く", () => {
  assert.equal(m.isNavActive("/commands", "/commands"), true);
  assert.equal(m.isNavActive("/commands/general", "/commands"), true);
  assert.equal(m.isNavActive("/games/chess", "/games"), true);
  assert.equal(m.isNavActive("/commandsx", "/commands"), false);
  assert.equal(m.isNavActive("/", "/commands"), false);
  assert.equal(m.isNavActive("/ranking", "/games"), false);
});
