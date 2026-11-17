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
    ["ツール", "サポート", "サイト情報", "ポリシー", "テスト公開"],
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

// ---- U4（Web IA 再構築）: パンくずの網羅と名称一致 ----
// 公開ページはパンくずで親へ1クリックで戻れる。独立シェル（/games/worldbox・
// /one-prompter・/viewslopper・/folio）とアプリ画面（/dashboard・/login）は
// この網羅の対象外。死蔵ページ /nation・/map は U5 で削除済み（下の回帰テスト参照）。
const appRoot = path.join(import.meta.dirname, "..", "app");
const readPage = (rel) => fs.readFileSync(path.join(appRoot, rel), "utf8");

test("公開ページはパンくずを持ち、末尾ラベルが見出しと一致する", () => {
  const pages = [
    // [page.tsx の相対パス, パンくずの末尾ラベル]
    ["features/page.tsx", "機能紹介"],
    ["commands/page.tsx", "コマンド"],
    ["games/page.tsx", "ゲーム"],
    ["ranking/page.tsx", "ランキング"],
    ["compute/page.tsx", "計算に参加"],
    ["faq/page.tsx", "よくある質問"],
    ["status/page.tsx", "ステータス"],
    ["about/page.tsx", "運営者情報"],
    ["credits/page.tsx", "クレジット"],
    ["terms/page.tsx", "利用規約"],
    ["privacy/page.tsx", "プライバシーポリシー"],
    ["jinrou/roles/page.tsx", "人狼 役職図鑑"],
  ];
  for (const [rel, label] of pages) {
    const src = readPage(rel);
    // /games のパンくずは GamesChrome 側で描くため、ラベルはそちらで確認する
    const labelOk =
      rel === "games/page.tsx"
        ? readPage("games/GamesChrome.tsx").includes("<span>ゲーム</span>")
        : src.includes(`label: "${label}"`);
    const hasCrumb =
      labelOk && (src.includes("Breadcrumbs") || src.includes("GamesBreadcrumb"));
    assert.ok(hasCrumb, `${rel} に「${label}」のパンくずがない`);
    const h1 = src.match(/<h1>([^<]+)<\/h1>/);
    assert.ok(h1, `${rel} に h1 がない`);
    assert.equal(h1[1], label, `${rel} の h1「${h1[1]}」がパンくず「${label}」と違う`);
  }
});

test("役職詳細はパンくずで親へ戻り、手書きの戻るリンクを持たない", () => {
  const src = readPage("jinrou/roles/[id]/page.tsx");
  assert.ok(src.includes('href: "/jinrou/roles"'), "役職詳細のパンくずに親へのリンクがない");
  assert.ok(!src.includes("にもどる"), "役職詳細に手書きの戻るリンクが残っている");
  assert.ok(src.includes("{ label: role.name }"), "役職詳細のパンくず末尾が役職名でない");
});

test("同一行き先の名称はページ内でも揺れない（ランキング／ステータス）", () => {
  for (const [rel, label] of [
    ["ranking/page.tsx", "ランキング"],
    ["status/page.tsx", "ステータス"],
  ]) {
    const src = readPage(rel);
    assert.ok(src.includes(`title: "${label}"`), `${rel} の metadata title が「${label}」でない`);
    assert.ok(!src.includes("リーダーボード"), `${rel} に旧称「リーダーボード」が残っている`);
    assert.ok(!src.includes("サービスステータス"), `${rel} に旧称「サービスステータス」が残っている`);
  }
});

test("人狼 役職図鑑は人狼の詳細ヘッダーから1クリックで届く", async () => {
  const catalogSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "lib", "games-catalog.ts"),
    "utf8",
  );
  const catalogJs = ts.transpileModule(catalogSrc, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const catalog = await import(
    "data:text/javascript;base64," + Buffer.from(catalogJs).toString("base64")
  );
  const werewolf = catalog.WEB_GAMES.find((g) => g.slug === "werewolf");
  assert.ok(werewolf, "人狼のカタログエントリがない");
  assert.deepEqual(werewolf.guide, { href: "/jinrou/roles", label: "人狼 役職図鑑を見る" });
  const chromeSrc = readPage("games/GamesChrome.tsx");
  assert.ok(chromeSrc.includes("game.guide"), "詳細ヘッダーが guide 導線を描画していない");
  assert.ok(chromeSrc.includes("game.guide.href"), "詳細ヘッダーが guide の行き先を使っていない");
});

test("U5: 死蔵ページ /nation・/map は削除され、参照も残っていない", () => {
  for (const rel of ["nation", "map"]) {
    assert.ok(!fs.existsSync(path.join(appRoot, rel)), `app/${rel} が残っている`);
  }
  for (const lib of ["lib/nation.ts", "lib/nation-map.ts"]) {
    assert.ok(!fs.existsSync(path.join(import.meta.dirname, "..", lib)), `${lib} が残っている`);
  }
  const chromeSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "lib", "site-chrome.ts"),
    "utf8",
  );
  assert.ok(!chromeSrc.includes('"/map"'), "site-chrome.ts に /map が残っている");
  assert.ok(!chromeSrc.includes('"/nation"'), "site-chrome.ts に /nation が残っている");
  const routes = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "public", "manus-routes.json"), "utf8"),
  ).routes.map((r) => r.path);
  assert.ok(!routes.includes("/map"), "manus-routes.json に /map が残っている");
  assert.ok(!routes.includes("/nation"), "manus-routes.json に /nation が残っている");
});
