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

test("UX較正: 単一目的ページは低く、詰め込みポータルは高い", () => {
  const base = m.emptyUxSignals();
  // Google 型: 入力1つ・リンク少数・h1なし・viewport なし → 上限で抑えられる
  const googleLike = { ...base, hasViewport: false, h1Count: 0, totalLinks: 11, inputs: 1, inputsMissingLabel: 1, charsBeforeFirstHeading: -1, hasEarlyCta: true, longParagraphs: 1 };
  assert.ok(m.scoreUx(googleLike).friction <= 15, `google=${m.scoreUx(googleLike).friction}`);
  // Yahoo 型: h1 が大量・リンク総量が多い → 高い
  const portalLike = { ...base, hasViewport: true, h1Count: 29, navLinkCount: 11, totalLinks: 129, inputs: 1, charsBeforeFirstHeading: 12, hasEarlyCta: false };
  assert.ok(m.scoreUx(portalLike).friction >= 40, `portal=${m.scoreUx(portalLike).friction}`);
});

test("本文抽出はUXシグナルも一緒に返す", () => {
  const page = m.extractPage(GOOD_HTML, "https://example.com/good");
  assert.equal(page.ux.h1Count, 1);
  assert.equal(page.ux.hasViewport, true);
});

test("SPA の殻判定: 本文が薄くスクリプトが多いページだけ描画フォールバックする", () => {
  const spaHtml = `<html><head><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>`;
  assert.equal(m.needsRenderFallback(spaHtml, 40), true);
  assert.equal(m.needsRenderFallback(spaHtml, 5000), false);
  assert.equal(m.needsRenderFallback("<html><body><p>静的な本文です</p></body></html>", 40), false);
  assert.equal(m.needsRenderFallback('<html><body><div id="__next"></div></body></html>', 10), true);
});

test("LLM主採点: 応答検証は全次元・全軸が揃った場合だけ通し、集計は重み通り", () => {
  const dims = ["cliche", "vague", "abstract", "repeat", "mechanical", "bait"].map((key, i) => ({
    key, score: [100, 0, 0, 0, 0, 0][i], evidence: "根拠", why: "理由", fix: "直し方",
  }));
  const ux = ["flow", "structure", "firstview", "readability"].map((key) => ({
    key, score: 50, evidence: "根拠", why: "理由", fix: "直し方",
  }));
  const parsed = m.parseAssessJson(JSON.stringify({ dimensions: dims, ux }));
  assert.ok(parsed);
  assert.equal(parsed.dimensions.length, 6);
  // UX は決定的計算に移したため、応答に含まれても採用しない
  assert.equal(parsed.ux.length, 0);
  // 次元が1つ欠けたら不採用
  assert.equal(m.parseAssessJson(JSON.stringify({ dimensions: dims.slice(0, 5), ux })), null);
  assert.equal(m.parseAssessJson("JSONではない"), null);
  const heuristic = m.scoreText(SOLID_TEXT);
  const composed = m.composeAssessed(parsed, heuristic);
  // cliche=100 が重み20 → 合計20
  assert.equal(composed.total, 20);
  assert.equal(composed.grade, "Light");
  assert.equal(composed.diagnosis.length, 1);
  assert.equal(composed.diagnosis[0].dimension, "cliche");
  // 採点メッセージにはアンカーが入り、決定的スコアは渡さない（引きずり防止）
  const page = { url: "https://e.com", title: "t", description: "", headings: [], text: SOLID_TEXT, ux: m.emptyUxSignals() };
  const msgs = m.buildAssessMessages(page, heuristic);
  assert.ok(msgs[0].content.includes("合計78点相当"));
  assert.ok(!msgs[1].content.includes("決定的スコア"));
});

test("外観採点: vision応答を検証し、重み付け集計と所見化する", () => {
  const axes = ["template", "alignment", "typography", "identity"].map((key, i) => ({
    key, score: [80, 40, 40, 40][i], evidence: "見えた根拠", why: "理由", fix: "直し方",
  }));
  const composed = m.composeAppearance(JSON.stringify({ axes }));
  assert.ok(composed);
  // 80*0.35 + 40*0.25 + 40*0.20 + 40*0.20 = 54
  assert.equal(composed.score, 54);
  assert.equal(composed.grade, "Slop気味");
  assert.equal(composed.findings[0].axis, "テンプレ感");
  // 軸が欠けた応答は不採用
  assert.equal(m.composeAppearance(JSON.stringify({ axes: axes.slice(0, 3) })), null);
  assert.equal(m.composeAppearance("not json"), null);
});

test("診断履歴: 端末保存の追加・重複URLの最新化・上限・削除が効く", async () => {
  const hsrc = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "viewslopper-history.ts"), "utf8");
  const hjs = ts.transpileModule(hsrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const h = await import("data:text/javascript;base64," + Buffer.from(hjs).toString("base64"));
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  const mk = (url, score, at) => h.toHistoryEntry({ url, title: "t", score, grade: "Light", ux: { friction: 10 }, appearance: { score: 20 } }, at);
  assert.equal(h.toHistoryEntry({ score: 1 }, 0), null);
  let list = h.saveHistory(storage, mk("https://a.com/", 10, 1000));
  assert.equal(list.length, 1);
  assert.equal(list[0].uxFriction, 10);
  assert.equal(list[0].appearanceScore, 20);
  // 同じURLは最新に差し替わって先頭へ
  h.saveHistory(storage, mk("https://b.com/", 30, 2000));
  list = h.saveHistory(storage, mk("https://a.com/", 55, 3000));
  assert.equal(list.length, 2);
  assert.equal(list[0].url, "https://a.com/");
  assert.equal(list[0].score, 55);
  // 削除と全消去
  list = h.removeHistoryEntry(storage, 3000);
  assert.equal(list.length, 1);
  h.clearHistory(storage);
  assert.deepEqual(h.loadHistory(storage), []);
  // 壊れたデータは空として扱う
  store.set(h.HISTORY_KEY, "{broken");
  assert.deepEqual(h.loadHistory(storage), []);
});

test("LLM採点の2回平均: スコアは平均化され、根拠は平均に近い側が残る", () => {
  const mk = (base) => ({
    dimensions: ["cliche", "vague", "abstract", "repeat", "mechanical", "bait"].map((key, i) => ({
      key, score: base + i, evidence: `根拠${base}`, why: "理由", fix: "直し方",
    })),
    ux: ["flow", "structure", "firstview", "readability"].map((key) => ({
      key, score: base, evidence: `根拠${base}`, why: "理由", fix: "直し方",
    })),
  });
  const merged = m.mergeAssessments(mk(10), mk(30));
  assert.equal(merged.dimensions[0].score, 20);
  assert.equal(merged.ux[0].score, 20);
  // 平均に近い側（どちらも等距離なら先勝ち）の根拠が残る
  assert.equal(merged.ux[0].evidence, "根拠10");
  const composed = m.composeAssessed(merged, m.scoreText(SOLID_TEXT));
  assert.ok(composed.total >= 20 && composed.total <= 26);
});

test("16:9カード: 寸法・ファイル名・省略が仕様通り", async () => {
  const csrc = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "viewslopper-card.ts"), "utf8");
  const cjs = ts.transpileModule(csrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const c = await import("data:text/javascript;base64," + Buffer.from(cjs).toString("base64"));
  assert.equal(c.CARD_WIDTH / c.CARD_HEIGHT, 16 / 9);
  assert.equal(c.buildCardFileName("https://example.com/a?b=1", 42), "viewslopper-example.com-42.png");
  assert.equal(c.buildCardFileName("not a url", 7), "viewslopper-result-7.png");
  assert.equal(c.ellipsize("abcdef", 4), "abc…");
  assert.equal(c.ellipsize("abc", 4), "abc");
  assert.equal(c.cardScoreColor(10), "#46a758");
  assert.equal(c.cardScoreColor(90), "#e5484d");
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
