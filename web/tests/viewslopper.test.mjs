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
