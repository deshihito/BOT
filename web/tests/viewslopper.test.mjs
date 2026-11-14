// lib/viewslopper.ts の純粋ロジック（URL検証・本文抽出・Slop Score・診断）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "viewslopper.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const SLOP_TEXT =
  "本記事では、AIツールの魅力についてご紹介します。AIツールを活用することで、業務の効率化を実現し、さらなる成長の可能性を広げることができます。まず、AIツールは作業の効率を向上させます。次に、AIツールはクオリティの向上にも貢献します。さらに、AIツールは未来の働き方を大きく変える可能性を秘めています。重要なのは、自分に合ったツールを選ぶことです。一方で、メリットもあればデメリットもありますが、総合的に見て価値があると言えるでしょう。まとめると、AIツールは画期的で革新的な存在であり、私たちの未来に欠かせません。いかがでしたか。ぜひ活用してみてはいかがでしょうか。";
const SOLID_TEXT =
  "11月14日17時48分、経済リセットを実行した。対象は41人、全員の残高を10,000に揃え、総供給は1,901,394,057から410,000になった。プールには100,000を置いたが、21時前にほぼ払い出された。原因は core/data/economy_pool.json の古いコピーで、起動時に正規ファイルより先に読まれていた。中身は11月6日時点で凍結した168と73だった。対策として古いコピーを退避し、再起動は /home/luna/BOT/venv/bin/python を絶対パスで実行した。宝くじプールは633,983,227から4,001に切り、21時の抽選の払い出しは約3,600に収まった。";

test("URL検証は公開ページだけを通し、危険な宛先を弾く", () => {
  assert.equal(m.validateViewUrl("https://example.com/article"), "https://example.com/article");
  assert.equal(m.validateViewUrl("javascript:alert(1)"), null);
  assert.equal(m.validateViewUrl("ftp://example.com/x"), null);
  assert.equal(m.validateViewUrl("http://localhost:3000/admin"), null);
  assert.equal(m.validateViewUrl("http://127.0.0.1/x"), null);
  assert.equal(m.validateViewUrl("http://192.168.1.1/x"), null);
  assert.equal(m.validateViewUrl("http://172.16.0.5/x"), null);
  assert.equal(m.validateViewUrl("https://user:pass@example.com/"), null);
  assert.equal(m.validateViewUrl("https://example.local/x"), null);
  assert.equal(m.validateViewUrl(42), null);
  assert.equal(m.validateViewUrl(""), null);
});

test("本文抽出はタイトル・説明・見出しを取り、scriptを落とす", () => {
  const html = `<html><head><title>テスト記事</title><meta name="description" content="説明文です"></head>
<body><script>var x = "定型句いかがでしたか";</script><h1>見出し1</h1><p>本文の一文目です。</p><p>本文の二文目です。</p></body></html>`;
  const page = m.extractPage(html, "https://example.com/a");
  assert.equal(page.title, "テスト記事");
  assert.equal(page.description, "説明文です");
  assert.deepEqual(page.headings, ["見出し1"]);
  assert.ok(page.text.includes("本文の一文目です"));
  assert.ok(!page.text.includes("定型句"));
});

test("Slop Scoreは定型文と実記録を大きく分ける", () => {
  const slop = m.scoreText(SLOP_TEXT);
  const solid = m.scoreText(SOLID_TEXT);
  assert.ok(slop.total >= 60, `slop=${slop.total}`);
  assert.ok(solid.total <= 20, `solid=${solid.total}`);
  assert.equal(slop.dimensions.length, 6);
  assert.equal(slop.dimensions.reduce((s, d) => s + d.weight, 0), 100);
});

test("ページ採点はタイトルの煽りをスコアに混ぜる", () => {
  const plain = m.scorePage({ url: "https://e.com", title: "会議の記録", description: "", headings: [], text: SOLID_TEXT });
  const baited = m.scorePage({ url: "https://e.com", title: "衝撃！最強の必見テクニック", description: "", headings: [], text: SOLID_TEXT });
  assert.ok(baited.total > plain.total, `${baited.total} > ${plain.total}`);
  const baitDim = baited.dimensions.find((d) => d.key === "bait");
  assert.ok(baitDim.score > 0);
});

test("ルールベース診断は高い次元だけを出し、クリーンな文には総評を返す", () => {
  const slopDiag = m.buildRuleDiagnosis(m.scoreText(SLOP_TEXT));
  assert.ok(slopDiag.length >= 2);
  assert.ok(slopDiag.every((d) => d.why.length > 0 && d.fix.length > 0));
  const solidDiag = m.buildRuleDiagnosis(m.scoreText(SOLID_TEXT));
  assert.equal(solidDiag.length, 1);
  assert.equal(solidDiag[0].label, "総評");
});

const GOOD_HTML = `<html lang="ja"><head><title>良いページ</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav></header>
<main><h1>主題</h1><p>短い段落です。</p><button>始める</button>
<img src="x.png" alt="説明" width="100" height="50">
<form><label for="q">検索</label><input id="q" type="text"></form></main></body></html>`;

const BAD_HTML = `<html><head><title>悪いページ</title><style>.x{font-size:9px}.y{font-size:10px}.z{font-size:11px}</style></head>
<body><nav>${Array.from({ length: 30 }, (_, i) => `<a href="/n${i}">項目${i}</a>`).join("")}</nav>
<div>${"<p>前置きの文章です。</p>".repeat(30)}</div>
<h1>一つ目</h1><h1>二つ目</h1><h4>飛んだ見出し</h4>
<p>${"長い段落の文章です。".repeat(40)}</p><p>${"別の長い段落です。".repeat(40)}</p>
${'<img src="a.png">'.repeat(4)}
${'<a href="/x">詳細はこちら</a>'.repeat(5)}
<form><input type="text"><input type="email"></form>
<div class="modal-x"></div><div class="cookie-popup"></div>
</body></html>`;

test("UXシグナル抽出は構造の事実を数える", () => {
  const good = m.extractUxSignals(GOOD_HTML);
  assert.equal(good.hasViewport, true);
  assert.equal(good.hasLang, true);
  assert.equal(good.h1Count, 1);
  assert.equal(good.navLinkCount, 3);
  assert.equal(good.imagesMissingAlt, 0);
  assert.equal(good.inputsMissingLabel, 0);
  assert.equal(good.hasEarlyCta, true);
  const bad = m.extractUxSignals(BAD_HTML);
  assert.equal(bad.hasViewport, false);
  assert.equal(bad.h1Count, 2);
  assert.ok(bad.navLinkCount >= 30);
  assert.equal(bad.imagesMissingAlt, 4);
  assert.equal(bad.inputsMissingLabel, 2);
  assert.ok(bad.headingSkips >= 1);
  assert.ok(bad.duplicateLinkTexts.length >= 1);
});

test("UX摩擦スコアは良いページを低く、悪いページを高く分ける", () => {
  const good = m.scoreUx(m.extractUxSignals(GOOD_HTML));
  const bad = m.scoreUx(m.extractUxSignals(BAD_HTML));
  assert.ok(good.friction <= 25, `good=${good.friction}`);
  assert.ok(bad.friction >= 60, `bad=${bad.friction}`);
  assert.ok(bad.findings.length >= 4);
  assert.ok(bad.findings.every((f) => f.evidence.length > 0 && f.fix.length > 0));
  // 重大な所見が先に来る
  assert.equal(bad.findings[0].severity, "high");
});

test("本文抽出はUXシグナルも一緒に返す", () => {
  const page = m.extractPage(GOOD_HTML, "https://example.com/good");
  assert.equal(page.ux.h1Count, 1);
  assert.equal(page.ux.hasViewport, true);
});

test("LLM診断メッセージはスコア固定を指示し、応答検証は不正要素を捨てる", () => {
  const page = { url: "https://e.com", title: "t", description: "", headings: [], text: SLOP_TEXT };
  const msgs = m.buildDiagnosisMessages(page, m.scoreText(SLOP_TEXT));
  assert.ok(msgs[0].content.includes("スコア自体を変えたり"));
  const parsed = m.parseDiagnosisJson(
    JSON.stringify([
      { dimension: "cliche", evidence: "いかがでしたか", why: "定型句", fix: "削る" },
      { dimension: "unknown", evidence: "x", why: "y", fix: "z" },
      { dimension: "vague", evidence: "", why: "", fix: "z" },
    ]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].dimension, "cliche");
  assert.equal(m.parseDiagnosisJson("これはJSONではない"), null);
});
