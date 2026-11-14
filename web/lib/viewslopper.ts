// viewslopper の純粋ロジック（URL検証・HTMLからの本文抽出・Slop Score 採点・
// 診断の下書き生成・LLM診断メッセージ構築と応答検証）。
// ネットワークや環境変数には触れない。サーバー側（viewslopper-server.ts）と
// テストの両方から使う。
//
// 採点の設計（ユーザー確定 2026-11-14「Slop Score の産出と診断」）:
// - スコアは決定的な計算（辞書＋統計）だけで決める。LLM には決めさせない
//   （ブレるとスコアの信用が死ぬため）。LLM の仕事は証拠引用つき診断文だけ。
// - LLM が使えない場合はルールベース診断（buildRuleDiagnosis）に落とす。
//   スコアと「どこが当たったか」は常に出る。
// 観点は One Prompter の anti-slop 資産（PR #736 の禁止事項リスト）を流用:
// 定型の締め／機械的列挙／接続詞連発／バズワード／抽象語の裸使い／両論併記／
// 焼き直し要約。

/** 診断対象 URL の入力上限。 */
export const MAX_URL_LENGTH = 2048;
/** 採点に使う本文の上限（これを超える分は切り捨てて採点する）。 */
export const MAX_SCORE_TEXT_CHARS = 20000;
/** 本文がこれ未満なら「中身が薄い」ことも診断に含める。 */
export const THIN_TEXT_CHARS = 300;

export type DimensionKey = "cliche" | "vague" | "abstract" | "repeat" | "mechanical" | "bait";

export type DimensionResult = {
  key: DimensionKey;
  label: string;
  score: number;
  weight: number;
  hits: number;
};

export type PageData = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  ux: UxSignals;
  /** 描画経由（レンダリング済みテキスト）で取得したページかどうか。 */
  rendered?: boolean;
};

/**
 * 直接取得した HTML が「SPA の殻」らしいかどうか。
 * 本文が薄く、スクリプトが多く、アプリのルート要素がある場合は、
 * サーバー側 fetch では中身が見えていない可能性が高い。
 */
export function needsRenderFallback(html: string, textChars: number): boolean {
  if (textChars >= THIN_TEXT_CHARS) return false;
  const scriptCount = (html.match(/<script[\s>]/gi) ?? []).length;
  const hasAppRoot = /id=["'](root|app|__next)["']/i.test(html);
  return scriptCount >= 3 || hasAppRoot;
}

/** HTML構造から取れる UX/配置 の生シグナル（レンダリングなしで数えられるものだけ）。 */
export type UxSignals = {
  hasViewport: boolean;
  hasLang: boolean;
  h1Count: number;
  headingSkips: number;
  navLinkCount: number;
  totalLinks: number;
  duplicateLinkTexts: { text: string; count: number }[];
  images: number;
  imagesMissingAlt: number;
  imagesMissingSize: number;
  inputs: number;
  inputsMissingLabel: number;
  smallFontCount: number;
  modalCount: number;
  charsBeforeFirstHeading: number;
  hasEarlyCta: boolean;
  longParagraphs: number;
  maxParagraphChars: number;
};

export type UxFinding = {
  axis: string;
  severity: "high" | "mid" | "low";
  evidence: string;
  why: string;
  fix: string;
};

export type UxResult = {
  /** UX摩擦スコア 0–100（高いほど摩擦が大きい）。Slop Score と同じ向き。 */
  friction: number;
  grade: string;
  findings: UxFinding[];
};

export function emptyUxSignals(): UxSignals {
  return {
    hasViewport: false, hasLang: false, h1Count: 0, headingSkips: 0,
    navLinkCount: 0, totalLinks: 0, duplicateLinkTexts: [],
    images: 0, imagesMissingAlt: 0, imagesMissingSize: 0,
    inputs: 0, inputsMissingLabel: 0, smallFontCount: 0, modalCount: 0,
    charsBeforeFirstHeading: 0, hasEarlyCta: false, longParagraphs: 0, maxParagraphChars: 0,
  };
}

export type Evidence = {
  dimension: DimensionKey;
  /** 原文からそのまま切り出した証拠（最大120字）。 */
  quote: string;
  detail: string;
};

export type DiagnosisItem = {
  dimension: DimensionKey;
  label: string;
  evidence: string;
  why: string;
  fix: string;
};

export type ViewScore = {
  total: number;
  grade: string;
  dimensions: DimensionResult[];
  evidence: Evidence[];
  thin: boolean;
};

export type ChatMessage = { role: "system" | "user"; content: string };

const CLICHE: readonly string[] = [
  "いかがでしたか", "まとめると", "重要なのは", "本記事では", "と言えるでしょう", "と言えます",
  "ではないでしょうか", "に違いありません", "欠かせません", "ポイントです", "ご紹介します",
  "解説します", "delve", "in conclusion", "it's important to note", "moreover", "furthermore",
  "in today's world",
];
const ABSTRACT: readonly string[] = [
  "価値", "可能性", "重要性", "効果", "向上", "実現", "未来", "成長", "発展",
  "最適化", "効率化", "革新", "クオリティ", "ポテンシャル",
];
const BUZZ: readonly string[] = [
  "革新的", "画期的", "革命", "最強", "究極", "完全", "衝撃", "必見", "神", "ヤバい", "すごい", "驚異的", "圧倒的",
];
const CONNECTIVES: readonly string[] = [
  "まず", "次に", "さらに", "そして", "また", "最後に", "一方で", "しかしながら", "したがって", "つまり",
];
const HEDGE: readonly string[] = [
  "一方で", "メリットもあれば", "デメリットも", "場合があります", "可能性があります", "とも言えます", "人それぞれ",
];

export const DIMENSION_DEFS: readonly { key: DimensionKey; label: string; weight: number }[] = [
  { key: "cliche", label: "定型句・決まり文句", weight: 20 },
  { key: "vague", label: "具体性の欠如", weight: 25 },
  { key: "abstract", label: "抽象語の裸使い", weight: 15 },
  { key: "repeat", label: "繰り返し・冗長", weight: 15 },
  { key: "mechanical", label: "構造の機械性", weight: 15 },
  { key: "bait", label: "煽り・両論併記", weight: 10 },
];

function clamp(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)));
}

function countOccurrences(text: string, word: string): number {
  if (!word) return 0;
  let count = 0;
  let idx = text.indexOf(word);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(word, idx + word.length);
  }
  return count;
}

function countWords(text: string, words: readonly string[]): number {
  return words.reduce((sum, w) => sum + countOccurrences(text, w), 0);
}

function sentences(text: string): string[] {
  return text
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

function grade(total: number): string {
  if (total < 20) return "Clean";
  if (total < 40) return "Light";
  if (total < 60) return "Slop気味";
  if (total < 80) return "Slop";
  return "Heavy Slop";
}

/**
 * 診断対象 URL を検証して正規化する。不正なら null。
 * SSRF の足場にしないため、http/https のみ・URL 内認証情報なし・
 * ローカル/プライベート宛先（localhost、.local、プライベートIPリテラル）を弾く。
 * 名前解決後の宛先チェックはサーバー側 fetch でも行うが、ここは入力段階の門番。
 */
export function validateViewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (isPrivateIpLiteral(host)) return null;
  url.hash = "";
  return url.toString();
}

/** IPv4/IPv6 リテラルがプライベート/ループバック/リンクローカルかどうか。 */
export function isPrivateIpLiteral(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "::1" || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function metaContent(html: string, key: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${key}["']`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return decodeEntities(m[1]).trim();
  }
  return "";
}

/**
 * HTML から診断対象を取り出す。script/style 等を落とし、タグを改行に変えて
 * 行単位に整え、連続重複行を畳む。依存ライブラリなしの簡易抽出（MVP）で、
 * ナビ等の定型部は完全には除けない前提 — その分は診断でなく採点の誤差として扱う。
 */
export function extractPage(html: string, url: string): PageData {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : "";
  const description = metaContent(html, "description") || metaContent(html, "og:description");
  const headings: string[] = [];
  for (const m of html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)) {
    const h = decodeEntities(stripTags(m[1])).trim();
    if (h) headings.push(h.slice(0, 120));
    if (headings.length >= 30) break;
  }
  let body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, "\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = decodeEntities(stripTags(body));
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.replace(/\s+/g, " ").trim();
    if (t.length < 2) continue;
    if (lines[lines.length - 1] === t) continue;
    lines.push(t);
  }
  const text = lines.join("\n").slice(0, MAX_SCORE_TEXT_CHARS);
  return { url, title, description, headings, text, ux: extractUxSignals(html) };
}

const CTA_WORDS = [
  "始める", "登録", "申し込", "購入", "ダウンロード", "無料", "予約", "注文", "ログイン",
  "start", "sign up", "signup", "download", "buy", "get started",
];

/** HTML から UX/配置シグナルを数える。実レンダリングはしない前提で、構造から確実に言えることだけを取る。 */
export function extractUxSignals(html: string): UxSignals {
  const s = emptyUxSignals();
  s.hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  s.hasLang = /<html[^>]+lang=/i.test(html);

  const levels = [...html.matchAll(/<h([1-6])[^>]*>/gi)].map((m) => Number(m[1]));
  s.h1Count = levels.filter((l) => l === 1).length;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) s.headingSkips++;
  }

  const navBlocks = [...html.matchAll(/<nav[\s\S]*?<\/nav>/gi)].map((m) => m[0]);
  const headerBlocks = [...html.matchAll(/<header[\s\S]*?<\/header>/gi)].map((m) => m[0]);
  const navSource = navBlocks.length > 0 ? navBlocks : headerBlocks;
  s.navLinkCount = navSource.reduce((sum, b) => sum + (b.match(/<a\s[^>]*href/gi) ?? []).length, 0);
  s.totalLinks = (html.match(/<a\s[^>]*href/gi) ?? []).length;

  const linkTextCounts = new Map<string, number>();
  for (const m of html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = decodeEntities(stripTags(m[1])).replace(/\s+/g, " ").trim();
    if (t.length >= 1 && t.length <= 30) linkTextCounts.set(t, (linkTextCounts.get(t) ?? 0) + 1);
  }
  s.duplicateLinkTexts = [...linkTextCounts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }));

  const imgTags = [...html.matchAll(/<img[^>]*>/gi)].map((m) => m[0]);
  s.images = imgTags.length;
  s.imagesMissingAlt = imgTags.filter((t) => !/\balt=/i.test(t)).length;
  s.imagesMissingSize = imgTags.filter((t) => !(/\bwidth=/i.test(t) && /\bheight=/i.test(t))).length;

  const labelFors = new Set([...html.matchAll(/<label[^>]+for=["']([^"']+)["']/gi)].map((m) => m[1]));
  const inputTags = [...html.matchAll(/<(input|select|textarea)[^>]*>/gi)]
    .map((m) => m[0])
    .filter((t) => !/type=["'](hidden|submit|button)["']/i.test(t));
  s.inputs = inputTags.length;
  s.inputsMissingLabel = inputTags.filter((t) => {
    if (/aria-label=/i.test(t)) return false;
    const id = t.match(/id=["']([^"']+)["']/i)?.[1];
    return !(id && labelFors.has(id));
  }).length;

  s.smallFontCount = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gi)]
    .filter((m) => Number(m[1]) <= 11).length;
  s.modalCount = (html.match(/<(div|section|dialog)[^>]+(?:class|id)=["'][^"']*(modal|popup|cookie)[^"']*["']/gi) ?? []).length;

  const firstHeadingIdx = html.search(/<h1[^>]*>/i);
  if (firstHeadingIdx === -1) {
    s.charsBeforeFirstHeading = -1;
  } else {
    const before = html.slice(0, firstHeadingIdx)
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
    s.charsBeforeFirstHeading = decodeEntities(stripTags(before)).replace(/\s+/g, " ").trim().length;
  }

  const bodyStart = html.search(/<body[^>]*>/i);
  const early = html.slice(bodyStart === -1 ? 0 : bodyStart, (bodyStart === -1 ? 0 : bodyStart) + 6000);
  s.hasEarlyCta =
    /<button[^>]*>/i.test(early) ||
    [...early.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].some((m) => {
      const t = decodeEntities(stripTags(m[1])).toLowerCase();
      return CTA_WORDS.some((w) => t.includes(w));
    }) ||
    /(?:class|id)=["'][^"']*(cta|btn-primary)[^"']*["']/i.test(early);

  const paraLens = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => decodeEntities(stripTags(m[1])).replace(/\s+/g, " ").trim().length)
    .filter((n) => n > 0);
  s.longParagraphs = paraLens.filter((n) => n > 300).length;
  s.maxParagraphChars = paraLens.length > 0 ? Math.max(...paraLens) : 0;
  return s;
}

function uxGrade(friction: number): string {
  if (friction < 20) return "良好";
  if (friction < 40) return "軽微";
  if (friction < 60) return "要改善";
  if (friction < 80) return "摩擦大";
  return "深刻";
}

/**
 * UX/配置の摩擦スコアと所見。観点は HCD の原則（導線は少なく、配置と構造が
 * 次の一手を示す）に寄せる。全部入り口の数と構造から数えられる事実だけで組み、
 * 実レンダリングでしか分からないこと（実寸のタップ領域など）は扱わない。
 */
export function scoreUx(s: UxSignals): UxResult {
  let friction = 0;
  const findings: (UxFinding & { points: number })[] = [];
  const add = (points: number, axis: string, evidence: string, why: string, fix: string) => {
    friction += points;
    findings.push({
      points, axis,
      severity: points >= 12 ? "high" : points >= 7 ? "mid" : "low",
      evidence, why, fix,
    });
  };

  if (!s.hasViewport) add(18, "モバイル前提", "viewport メタタグなし", "スマホでの表示倍率が保証されず、モバイル利用が前提になっていない。", "viewport を入れ、モバイル幅を本体として設計する。");
  if (s.h1Count === 0) add(12, "見出し構造", "h1 が0個", "ページの主題を表す見出しが構造上存在しない。", "主題を表す h1 を1つ置く。");
  else if (s.h1Count > 1) add(8, "見出し構造", `h1 が${s.h1Count}個`, "主題が複数に分散し、何のページか構造から決められない。", "h1 は1つに絞り、残りは h2 以下に下げる。");
  if (s.headingSkips > 0) add(Math.min(12, s.headingSkips * 6), "見出し構造", `見出しレベルの飛び ${s.headingSkips}箇所`, "階層が飛ぶと構造の読み取りが崩れる。", "見出しレベルを順番に使う。");
  if (s.navLinkCount > 30) add(20, "導線の数", `ナビ内リンク ${s.navLinkCount}本`, "導線が多すぎて、次の一手を配置で示せていない。", "ナビは主要導線だけに絞り、残りは階層を分ける。");
  else if (s.navLinkCount > 15) add(10, "導線の数", `ナビ内リンク ${s.navLinkCount}本`, "導線が多く、迷いの余地が大きい。", "使用頻度の低い導線をナビから外す。");
  for (const dup of s.duplicateLinkTexts.slice(0, 2)) {
    add(6, "導線の重複", `「${dup.text}」が${dup.count}回出現`, "同じ導線の重複は判断を分散させる。", "同じ行き先の導線は1つにまとめる。");
  }
  if (s.images >= 3 && s.imagesMissingAlt / s.images >= 0.3) {
    add(10, "画像の扱い", `画像${s.images}枚中 ${s.imagesMissingAlt}枚に alt なし`, "画像の意味がテキスト側に渡っていない。", "意味のある画像には alt を付け、装飾は alt=\"\" で明示する。");
  }
  if (s.images >= 3 && s.imagesMissingSize / s.images >= 0.5) {
    add(6, "画像の扱い", `画像${s.images}枚中 ${s.imagesMissingSize}枚に寸法指定なし`, "読み込み後にレイアウトが動き、配置が安定しない。", "width/height か aspect-ratio を指定する。");
  }
  if (s.inputsMissingLabel > 0) {
    add(10, "フォーム", `入力欄${s.inputs}件中 ${s.inputsMissingLabel}件にラベルなし`, "何を入れる欄か構造から分からない。", "全入力欄に label か aria-label を付ける。");
  }
  if (s.charsBeforeFirstHeading > 600) {
    add(10, "ファーストビュー", `最初の見出しまで ${s.charsBeforeFirstHeading} 字`, "見出しより前に文章が続き、冒頭でページの構造が掴めない。", "冒頭に見出しと要点を置き、説明は後ろに回す。");
  } else if (s.charsBeforeFirstHeading === -1) {
    add(6, "ファーストビュー", "見出し要素なし", "冒頭の掴みになる構造がない。", "冒頭に見出しを置く。");
  }
  if (!s.hasEarlyCta && s.totalLinks > 0) {
    add(6, "ファーストビュー", "冒頭にボタン/CTAらしい導線なし", "読み始めてすぐの位置に次の一手がない。", "冒頭に主要導線を1つ置く。");
  }
  if (s.longParagraphs >= 2) {
    add(8, "文章の壁", `300字超の段落が ${s.longParagraphs}件（最大${s.maxParagraphChars}字）`, "長い段落の連続は読む前に負荷が立つ。", "段落を分け、要点は見出しと構造で運ぶ。");
  }
  if (s.smallFontCount >= 3) {
    add(6, "文字サイズ", `11px以下の指定が ${s.smallFontCount}箇所`, "小さい文字の多用は可読性の下限を割る。", "本文の文字サイズに下限を設ける。");
  }
  if (s.modalCount >= 2) {
    add(8, "割り込み", `モーダル/ポップアップらしい要素が ${s.modalCount}件`, "割り込み要素が多いと本体の導線が霞む。", "割り込みは1つまでに絞る。");
  }
  if (!s.hasLang) add(4, "基本構造", "html の lang なし", "言語が構造で宣言されていない。", "html に lang を付ける。");

  const total = clamp(friction);
  const sorted = findings.sort((a, b) => b.points - a.points).slice(0, 8)
    .map(({ points: _points, ...f }) => f);
  return { friction: total, grade: uxGrade(total), findings: sorted };
}

/** 本文テキストの6次元採点（プロトタイプ score.py v1 の移植。カタカナ語は具体性に入れない）。 */
export function scoreText(text: string): ViewScore {
  const n = Math.max(text.length, 1);
  const per1k = 1000 / n;
  const sents = sentences(text);
  const ns = Math.max(sents.length, 1);

  const clicheHits = countWords(text, CLICHE);
  const dCliche = clamp(clicheHits * per1k * 14);

  const abstractHits = countWords(text, ABSTRACT);
  const digits = (text.match(/\d/g) ?? []).length;
  const anchor = Math.min(digits * 2, 30);
  const dAbstract = clamp(abstractHits * per1k * 10 - anchor);

  const concrete =
    digits +
    (text.match(/「[^」]{2,}」/g) ?? []).length * 2 +
    (text.match(/\d{4}年|\d+月\d+日|\d+:\d+|\d+%|\d+円|\d+人|\d+分|\d+秒/g) ?? []).length * 3;
  const dVague = clamp(85 - concrete * per1k * 2.2);

  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= text.length; i++) {
    const g = text.slice(i, i + 4);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let rep = 0;
  for (const c of grams.values()) if (c > 1) rep += c - 1;
  const endings = new Map<string, number>();
  for (const s of sents) {
    if (s.length >= 3) {
      const e = s.slice(-3);
      endings.set(e, (endings.get(e) ?? 0) + 1);
    }
  }
  let endRep = 0;
  for (const c of endings.values()) if (c > 1) endRep += c - 1;
  const dRepeat = clamp((rep / n) * 260 + endRep * 9);

  const led = sents.filter((s) => CONNECTIVES.some((c) => s.startsWith(c))).length;
  const lens = sents.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / ns;
  const variance = lens.reduce((a, l) => a + (l - mean) ** 2, 0) / ns;
  const sd = Math.sqrt(variance);
  const dMech = clamp((led / ns) * 90 + Math.max(0, 14 - sd) * 2.2);

  const buzzHits = countWords(text, BUZZ) + countOccurrences(text, "！") + countOccurrences(text, "!");
  const hedgeHits = countWords(text, HEDGE);
  const dBait = clamp(buzzHits * per1k * 11 + hedgeHits * per1k * 7);

  const scores: Record<DimensionKey, { score: number; hits: number }> = {
    cliche: { score: dCliche, hits: clicheHits },
    vague: { score: dVague, hits: Math.round(concrete) },
    abstract: { score: dAbstract, hits: abstractHits },
    repeat: { score: dRepeat, hits: rep + endRep },
    mechanical: { score: dMech, hits: led },
    bait: { score: dBait, hits: buzzHits + hedgeHits },
  };
  const dimensions: DimensionResult[] = DIMENSION_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    score: scores[def.key].score,
    weight: def.weight,
    hits: scores[def.key].hits,
  }));
  const total = clamp(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / 100);
  return { total, grade: grade(total), dimensions, evidence: collectEvidence(text, null, scores), thin: text.trim().length < THIN_TEXT_CHARS };
}

/**
 * ページ採点。本文の採点に、タイトル/ディスクリプションの煽りを混ぜる。
 * 配合: 本文 85% + タイトル側の煽り・定型 15%（タイトルは「看板」なので
 * 本文がまともでも看板が slop なら点は上がる、の意図）。
 */
export function scorePage(page: PageData): ViewScore {
  const base = scoreText(page.text);
  const signboard = `${page.title}\n${page.description}`;
  const signBait = clamp(
    countWords(signboard, BUZZ) * 40 + countWords(signboard, CLICHE) * 25 +
      (countOccurrences(signboard, "！") + countOccurrences(signboard, "!")) * 20,
  );
  const total = clamp(base.total * 0.85 + signBait * 0.15);
  const dimensions = base.dimensions.map((d) =>
    d.key === "bait" ? { ...d, score: clamp(d.score * 0.85 + signBait * 0.15) } : d,
  );
  return {
    total,
    grade: grade(total),
    dimensions,
    evidence: collectEvidence(page.text, page, null),
    thin: base.thin,
  };
}

function excerptAround(text: string, word: string): string {
  const idx = text.indexOf(word);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + word.length + 30);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 採点の根拠を原文から切り出す（診断の証拠）。各次元最大2件、全体最大10件。 */
export function collectEvidence(
  text: string,
  page: PageData | null,
  _scores: Record<DimensionKey, { score: number; hits: number }> | null,
): Evidence[] {
  const out: Evidence[] = [];
  const push = (dimension: DimensionKey, quote: string, detail: string) => {
    if (quote && out.filter((e) => e.dimension === dimension).length < 2 && out.length < 10) {
      out.push({ dimension, quote, detail });
    }
  };
  for (const w of CLICHE) {
    if (text.includes(w)) push("cliche", excerptAround(text, w), `定型句「${w}」`);
  }
  for (const w of ABSTRACT) {
    if (text.includes(w) && !/\d/.test(excerptAround(text, w))) {
      push("abstract", excerptAround(text, w), `数字の裏付けなく浮く抽象語「${w}」を含む一節`);
    }
  }
  for (const w of BUZZ) {
    if (text.includes(w)) push("bait", excerptAround(text, w), `バズワード「${w}」`);
  }
  const led = sentences(text).filter((s) => CONNECTIVES.some((c) => s.startsWith(c)));
  for (const s of led.slice(0, 2)) {
    push("mechanical", s.slice(0, 120), "接続表現で始まる文（機械的な列挙の型）");
  }
  if (page) {
    const sign = `${page.title} ${page.description}`;
    for (const w of [...BUZZ, ...CLICHE]) {
      if (sign.includes(w)) {
        push("bait", (page.title || page.description).slice(0, 120), `タイトル/説明文の「${w}」`);
        break;
      }
    }
  }
  return out;
}

const FIXES: Record<DimensionKey, string> = {
  cliche: "定型句を落とし、その文でしか言えない具体的な内容に置き換える。",
  vague: "数字・日付・固有名詞・単位を足し、検証できる形にする。",
  abstract: "抽象語の直後に実例か数値を置き、裸で浮かせない。",
  repeat: "繰り返されている表現を削り、文末と主語に変化をつける。",
  mechanical: "「まず／次に／最後に」の型を外し、文の長さと始まり方をばらす。",
  bait: "煽り語を落とし、立場を1つに決めて結論を逃げない。",
};
const WHYS: Record<DimensionKey, string> = {
  cliche: "誰が書いても同じになる定型句が多く、書き手の判断が見えない。",
  vague: "数字や固有の事実が少なく、内容を検証する手がかりがない。",
  abstract: "抽象語が数値や実例で裏付けされず、意味が浮いている。",
  repeat: "同じ言い回し・同じ文末の反復で、情報量に対して冗長。",
  mechanical: "接続表現で始まる文と均一な文長が続き、機械的な構成になっている。",
  bait: "煽り語や両論併記で、読み手の判断ではなく反応を狙っている。",
};

/** LLM が使えないときのルールベース診断。40点以上の次元だけを重い順に出す。 */
export function buildRuleDiagnosis(score: ViewScore): DiagnosisItem[] {
  const items: DiagnosisItem[] = [];
  const sorted = [...score.dimensions].sort((a, b) => b.score - a.score);
  for (const d of sorted) {
    if (d.score < 40) continue;
    const ev = score.evidence.find((e) => e.dimension === d.key);
    items.push({
      dimension: d.key,
      label: d.label,
      evidence: ev ? ev.quote : "",
      why: WHYS[d.key],
      fix: FIXES[d.key],
    });
  }
  if (score.thin) {
    items.push({
      dimension: "vague",
      label: "具体性の欠如",
      evidence: "",
      why: "抽出できた本文が短く、ページの中身自体が薄い可能性がある。",
      fix: "本文量を増やすか、薄い場合は診断対象として扱わない。",
    });
  }
  if (items.length === 0) {
    items.push({
      dimension: "vague",
      label: "総評",
      evidence: "",
      why: "定型句・抽象語・繰り返しの目立った兆候は検出されなかった。",
      fix: "現状の具体性を保つ。",
    });
  }
  return items.slice(0, 6);
}

/** LLM 診断用のメッセージ。スコアは渡すが変更させない。証拠は原文の引用のみ許可する。 */
export function buildDiagnosisMessages(page: PageData, score: ViewScore): ChatMessage[] {
  const dimLines = score.dimensions.map((d) => `- ${d.label}（${d.key}）: ${d.score}点`).join("\n");
  const evLines = score.evidence.map((e) => `- [${e.dimension}] ${e.detail}: 「${e.quote}」`).join("\n");
  const system = [
    "あなたは文章の slop（AI生成にありがちな、薄くて定型的な中身）を診断する専門家です。",
    "与えられた Slop Score と証拠をもとに、診断だけを書いてください。スコア自体を変えたり、新しいスコアを作ったりしないでください。",
    "証拠の引用は、渡された証拠か本文に実在する文字列をそのまま使ってください。存在しない文を引用しないでください。",
    '出力は JSON 配列のみ。前後に説明文やコードフェンスを付けないでください。',
    '各要素: {"dimension": 次元キー, "evidence": 原文の引用(最大120字), "why": なぜslopか(60字以内), "fix": 直し方(60字以内)}',
    "次元キーは cliche / vague / abstract / repeat / mechanical / bait のいずれか。最大6件、点数の高い次元から。",
  ].join("\n");
  const user = [
    `URL: ${page.url}`,
    `タイトル: ${page.title || "(なし)"}`,
    `説明文: ${page.description || "(なし)"}`,
    `Slop Score: ${score.total}（${score.grade}）`,
    "次元別スコア:",
    dimLines,
    "検出された証拠:",
    evLines || "(なし)",
    "本文（先頭3000字）:",
    page.text.slice(0, 3000),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---- LLM 主採点（2026-11-14 の設計変更） ----
// 辞書＋統計の決定的採点は、実ページでは次元の大半が0になり、合計が狭い範囲に
// 固まる（実測: 対象が全然違う4ページで 18/27/26/18）。そのため採点の判断は
// LLM に寄せ、コード側は「重み付け集計」と「形式の検証」だけを担う。
// 尺度を安定させるため、検証済みの基準サンプル（定型文=78、実記録=3）を
// プロンプトにアンカーとして渡す。LLM が使えない場合は従来の決定的採点に落ちる。

export type UxAxisKey = "flow" | "structure" | "firstview" | "readability";

export const UX_AXIS_DEFS: readonly { key: UxAxisKey; label: string; weight: number }[] = [
  { key: "flow", label: "導線", weight: 30 },
  { key: "structure", label: "見出し・構造", weight: 25 },
  { key: "firstview", label: "ファーストビュー", weight: 25 },
  { key: "readability", label: "読みやすさ", weight: 20 },
];

export type LlmDimensionScore = { key: DimensionKey; score: number; evidence: string; why: string; fix: string };
export type LlmUxScore = { key: UxAxisKey; score: number; evidence: string; why: string; fix: string };
export type LlmAssessment = { dimensions: LlmDimensionScore[]; ux: LlmUxScore[] };

const DIMENSION_RUBRIC: Record<DimensionKey, string> = {
  cliche: "定型句・決まり文句: 誰が書いても同じになる言い回し、AI生成に典型的な締めや導入の量",
  vague: "具体性の欠如: 数字・日付・固有名詞・実例で検証できる情報がどれだけ欠けているか",
  abstract: "抽象語の裸使い: 『価値』『可能性』等が実例や数値の裏付けなく浮いている度合い",
  repeat: "繰り返し・冗長: 同じ内容・同じ言い回しの反復で情報量が薄まっている度合い",
  mechanical: "構造の機械性: 『まず/次に/最後に』型の均一な構成、文長や始まりの単調さ",
  bait: "煽り・両論併記: バズワードや誇張、立場を取らずに逃げる両論併記の度合い",
};

/** LLM 主採点のメッセージ。決定的採点の数値は「参考値」として渡し、判断は本文でさせる。 */
export function buildAssessMessages(page: PageData, heuristic: ViewScore, uxSignals: UxSignals): ChatMessage[] {
  const dimLines = DIMENSION_DEFS.map((d) => `- ${d.key}（${d.label}）: ${DIMENSION_RUBRIC[d.key]}`).join("\n");
  const refLines = heuristic.dimensions.map((d) => `- ${d.key}: ${d.score}`).join("\n");
  const uxLines = [
    `viewport: ${uxSignals.hasViewport ? "あり" : "なし"} / lang: ${uxSignals.hasLang ? "あり" : "なし"}`,
    `h1: ${uxSignals.h1Count}個 / 見出しレベルの飛び: ${uxSignals.headingSkips}箇所`,
    `ナビ内リンク: ${uxSignals.navLinkCount}本 / 全リンク: ${uxSignals.totalLinks}本`,
    `画像: ${uxSignals.images}枚（alt無し ${uxSignals.imagesMissingAlt}、寸法指定無し ${uxSignals.imagesMissingSize}）`,
    `入力欄: ${uxSignals.inputs}件（ラベル無し ${uxSignals.inputsMissingLabel}）`,
    `最初の見出しまで: ${uxSignals.charsBeforeFirstHeading}字 / 冒頭CTA: ${uxSignals.hasEarlyCta ? "あり" : "なし"}`,
    `300字超の段落: ${uxSignals.longParagraphs}件 / 小さい文字の指定: ${uxSignals.smallFontCount}箇所 / モーダル類: ${uxSignals.modalCount}件`,
  ].join("\n");
  const system = [
    "あなたは Web ページの slop（薄くて定型的な中身）と UX・配置を採点する専門家です。",
    "各次元を 0–100 で採点してください（高いほど slop / 摩擦が大きい）。",
    "尺度のアンカー: 具体的な数字と固有名詞だけで書かれた実務記録は合計3点相当、定型句と抽象語だらけの典型的なAIブログ文は合計78点相当です。この尺度に合わせて判断してください。",
    "渡される決定的スコアは辞書ベースの参考値です。意味を読んで判断し、参考値に引きずられないでください。",
    "証拠は本文・タイトル・見出し・UXシグナルに実在する内容だけを使ってください。存在しない文を引用しないでください。",
    '出力は JSON オブジェクトのみ。前後に説明文やコードフェンスを付けないでください。',
    '{"dimensions":[{"key":次元キー,"score":0-100,"evidence":"根拠(最大120字)","why":"理由(60字以内)","fix":"直し方(60字以内)"} x6次元すべて],',
    '"ux":[{"key":UX軸キー,"score":0-100,"evidence":"根拠(最大120字)","why":"理由(60字以内)","fix":"直し方(60字以内)"} x4軸すべて]}',
    "次元キーは cliche / vague / abstract / repeat / mechanical / bait、UX軸キーは flow / structure / firstview / readability です。",
  ].join("\n");
  const user = [
    `URL: ${page.url}`,
    `タイトル: ${page.title || "(なし)"}`,
    `説明文: ${page.description || "(なし)"}`,
    `見出し: ${page.headings.join(" / ") || "(なし)"}`,
    `取得方法: ${page.rendered ? "描画経由（JavaScript実行後のテキスト）" : "直接取得"}`,
    "採点する次元:",
    dimLines,
    "決定的スコア（参考値）:",
    refLines,
    "UXシグナル（HTML構造から数えた事実）:",
    uxLines,
    "本文（先頭6000字）:",
    page.text.slice(0, 6000) || "(本文を取得できなかった。タイトル・説明文・見出しだけで判断すること)",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseScoreEntries<T extends string>(
  raw: unknown,
  defs: readonly { key: T }[],
): ({ key: T; score: number; evidence: string; why: string; fix: string }[] | null) {
  if (!Array.isArray(raw)) return null;
  const byKey = new Map<T, { key: T; score: number; evidence: string; why: string; fix: string }>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const key = rec.key as T;
    if (!defs.some((d) => d.key === key) || byKey.has(key)) continue;
    if (typeof rec.score !== "number" || !Number.isFinite(rec.score)) continue;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const why = str(rec.why, 200);
    const fix = str(rec.fix, 200);
    if (!why || !fix) continue;
    byKey.set(key, { key, score: clamp(rec.score), evidence: str(rec.evidence, 160), why, fix });
  }
  if (byKey.size !== defs.length) return null;
  return defs.map((d) => byKey.get(d.key)!);
}

/** LLM 主採点の応答を検証する。全次元・全軸が揃った場合だけ採用する。 */
export function parseAssessJson(raw: string): LlmAssessment | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  const dimensions = parseScoreEntries(rec.dimensions, DIMENSION_DEFS);
  const ux = parseScoreEntries(rec.ux, UX_AXIS_DEFS);
  if (!dimensions || !ux) return null;
  return { dimensions, ux };
}

/** LLM の次元スコアから合計と診断・UX所見を組み立てる（集計はコード側で決定的に行う）。 */
export function composeAssessed(
  assessment: LlmAssessment,
  heuristic: ViewScore,
): { total: number; grade: string; dimensions: DimensionResult[]; diagnosis: DiagnosisItem[]; uxFriction: number; uxGrade: string; uxFindings: UxFinding[] } {
  const labelByKey = new Map(DIMENSION_DEFS.map((d) => [d.key, d.label]));
  const hitsByKey = new Map(heuristic.dimensions.map((d) => [d.key, d.hits]));
  const dimensions: DimensionResult[] = assessment.dimensions.map((d) => {
    const def = DIMENSION_DEFS.find((x) => x.key === d.key)!;
    return { key: d.key, label: def.label, score: d.score, weight: def.weight, hits: hitsByKey.get(d.key) ?? 0 };
  });
  const total = clamp(dimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / 100);
  const diagnosis: DiagnosisItem[] = [...assessment.dimensions]
    .sort((a, b) => b.score - a.score)
    .filter((d) => d.score >= 25)
    .slice(0, 6)
    .map((d) => ({
      dimension: d.key,
      label: labelByKey.get(d.key)!,
      evidence: d.evidence,
      why: d.why,
      fix: d.fix,
    }));
  if (diagnosis.length === 0 && assessment.dimensions.length > 0) {
    const top = [...assessment.dimensions].sort((a, b) => b.score - a.score)[0];
    diagnosis.push({ dimension: top.key, label: labelByKey.get(top.key)!, evidence: top.evidence, why: top.why, fix: top.fix });
  }
  const uxFriction = clamp(assessment.ux.reduce((sum, a) => {
    const def = UX_AXIS_DEFS.find((x) => x.key === a.key)!;
    return sum + a.score * def.weight;
  }, 0) / 100);
  const uxLabelByKey = new Map(UX_AXIS_DEFS.map((d) => [d.key, d.label]));
  const uxFindings: UxFinding[] = [...assessment.ux]
    .sort((a, b) => b.score - a.score)
    .filter((a) => a.score >= 30)
    .slice(0, 6)
    .map((a) => ({
      axis: uxLabelByKey.get(a.key)!,
      severity: (a.score >= 70 ? "high" : a.score >= 45 ? "mid" : "low") as UxFinding["severity"],
      evidence: a.evidence,
      why: a.why,
      fix: a.fix,
    }));
  return { total, grade: grade(total), dimensions, diagnosis, uxFriction, uxGrade: uxGrade(uxFriction), uxFindings };
}

/** LLM 診断の応答 JSON を検証する。不正な要素は捨て、正しい要素だけ返す。 */
export function parseDiagnosisJson(raw: string): DiagnosisItem[] | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const labelByKey = new Map(DIMENSION_DEFS.map((d) => [d.key, d.label]));
  const items: DiagnosisItem[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const dim = rec.dimension;
    if (typeof dim !== "string" || !labelByKey.has(dim as DimensionKey)) continue;
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const why = str(rec.why, 200);
    const fix = str(rec.fix, 200);
    if (!why || !fix) continue;
    items.push({
      dimension: dim as DimensionKey,
      label: labelByKey.get(dim as DimensionKey)!,
      evidence: str(rec.evidence, 160),
      why,
      fix,
    });
    if (items.length >= 6) break;
  }
  return items.length > 0 ? items : null;
}
