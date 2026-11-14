// A28フェーズの検証。
// - lib/online/games/typerace.ts: 申告の検証（範囲・単調増加）・完走順の得点・締切・退出
// - lib/quiz.ts: 増量後のバンク（180問・カテゴリ配分・形式・正解の一貫性）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadOnline(name, exportsList) {
  const src = fs.readFileSync(path.join(libDir, "online", "games", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { ${exportsList.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const quiz = await loadLib("quiz.ts");
const tr = await loadOnline("typerace.ts", [ "gameModule", "TR_TEXTS", "TR_TOTAL_ROUNDS", "TR_TIME_LIMIT_MS", "TR_RANK_POINTS", ]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- typerace

const PLAYERS2 = [
  { seat: 0, name: "A" },
  { seat: 1, name: "B" },
];

test("タイピングレース: 人数検証と決定的な課題文", () => {
  assert.throws(() => tr.gameModule.createState([PLAYERS2[0]], makeRng(1), {}), /2〜6人/);
  const seven = Array.from({ length: 7 }, (_, i) => ({ seat: i, name: `P${i}` }));
  assert.throws(() => tr.gameModule.createState(seven, makeRng(1), {}), /2〜6人/);
  const a = tr.gameModule.createState(PLAYERS2, makeRng(7), {});
  const b = tr.gameModule.createState(PLAYERS2, makeRng(7), {});
  assert.deepEqual(a.texts, b.texts);
  assert.equal(a.texts.length, tr.TR_TOTAL_ROUNDS);
  assert.equal(new Set(a.texts).size, tr.TR_TOTAL_ROUNDS);
  assert.equal(a.phase, "racing");
  assert.equal(tr.TR_TEXTS.length >= 10, true);
  for (const t of tr.TR_TEXTS) assert.match(t, /^[a-z ]+$/);
});

test("タイピングレース: 申告は範囲と単調増加だけを検証する", () => {
  const m = tr.gameModule;
  let s = m.createState(PLAYERS2, makeRng(3), {});
  const len = s.texts[0].length;
  // 形式不正は parseAction が null を返す。
  assert.equal(m.parseAction(null), null);
  assert.equal(m.parseAction({ type: "progress" }), null);
  assert.equal(m.parseAction({ type: "progress", count: -1 }), null);
  assert.equal(m.parseAction({ type: "progress", count: 1.5 }), null);
  assert.equal(m.parseAction({ type: "other", count: 1 }), null);
  assert.deepEqual(m.parseAction({ type: "progress", count: 5 }), { type: "progress", count: 5 });
  // 範囲外・減少は throw。
  assert.throws(() => m.applyAction(s, 0, { type: "progress", count: len + 1 }, makeRng(1)), /範囲外/);
  assert.throws(() => m.applyAction(s, 0, { type: "progress", count: -1 }, makeRng(1)), /範囲外/);
  s = m.applyAction(s, 0, { type: "progress", count: 5 }, makeRng(1));
  assert.equal(s.progress[0], 5);
  assert.throws(() => m.applyAction(s, 0, { type: "progress", count: 4 }, makeRng(1)), /減らせません/);
  // 同値は無変更（同一参照）。
  assert.equal(m.applyAction(s, 0, { type: "progress", count: 5 }, makeRng(1)), s);
  // 非破壊: 元の状態は変わらない。
  const before = s.progress[0];
  m.applyAction(s, 0, { type: "progress", count: 6 }, makeRng(1));
  assert.equal(s.progress[0], before);
});

test("タイピングレース: 完走順に得点し、全員完走で即締切になる", () => {
  const m = tr.gameModule;
  let s = m.createState(PLAYERS2, makeRng(11), {});
  const len = s.texts[0].length;
  s = m.applyAction(s, 1, { type: "progress", count: len }, makeRng(1)); // B が先に完走
  assert.equal(s.phase, "racing");
  s = m.applyAction(s, 0, { type: "progress", count: len }, makeRng(1)); // A が2番目に完走
  assert.equal(s.phase, "reveal");
  assert.equal(s.scores[1], tr.TR_RANK_POINTS[0]);
  assert.equal(s.scores[0], tr.TR_RANK_POINTS[1]);
  const results = s.lastResults;
  assert.equal(results.find((r) => r.seat === 1).rank, 1);
  assert.equal(results.find((r) => r.seat === 0).rank, 2);
  // ビューには進捗数だけがあり、入力内容に相当する項目はない。
  const view = m.viewFor(s, 0);
  assert.equal(view.players.find((p) => p.seat === 1).progress, len);
  assert.equal("typed" in view, false);
  assert.equal(JSON.stringify(view).includes("typedText"), false);
});

test("タイピングレース: 時間切れでは未完走は0点、開示を経て最終順位まで進む", () => {
  const m = tr.gameModule;
  let s = m.createState(PLAYERS2, makeRng(21), {});
  const len = s.texts[0].length;
  s = m.applyAction(s, 0, { type: "progress", count: len }, makeRng(1)); // A だけ完走
  const afterLimit = Date.now() + tr.TR_TIME_LIMIT_MS + 1000;
  s = m.tick(s, afterLimit);
  assert.equal(s.phase, "reveal");
  assert.equal(s.scores[0], tr.TR_RANK_POINTS[0]);
  assert.equal(s.scores[1], 0);
  assert.equal(s.lastResults.find((r) => r.seat === 1).completed, false);
  // 変化がない tick は同一参照。
  assert.equal(m.tick(s, afterLimit + 100), s);
  // 開示 → 次ラウンド → … → 終了まで回す。
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 20) {
    const now = Date.now() + 100000 + guard * 100000;
    const next = m.tick(s, now);
    s = next === s ? m.tick(s, now + tr.TR_TIME_LIMIT_MS + 10000) : next;
    if (s.phase === "racing") {
      s = m.tick(s, Date.now() + tr.TR_TIME_LIMIT_MS + 10000 + guard);
    }
  }
  assert.equal(s.phase, "finished");
  assert.equal(m.isFinished(s), true);
  const view = m.viewFor(s, 0);
  assert.ok(Array.isArray(view.standings));
  assert.equal(view.standings[0].seat, 0);
  assert.equal(view.standings[0].rank, 1);
});

test("タイピングレース: 退出すると進捗は固定され完走扱いにならず、残り1人で終了", () => {
  const m = tr.gameModule;
  let s = m.createState(PLAYERS2, makeRng(31), {});
  s = m.applyAction(s, 1, { type: "progress", count: 3 }, makeRng(1));
  s = m.onPlayerLeft(s, 1);
  assert.equal(s.leftSeats.includes(1), true);
  assert.equal(s.progress[1], 3);
  assert.equal(s.phase, "finished"); // 生存者が A だけになった
  assert.throws(() => m.applyAction(s, 1, { type: "progress", count: 4 }, makeRng(1)), /終了/);
});

// ---------------------------------------------------------------- quiz bank

test("クイズ: バンクは180問でカテゴリ配分と形式が作法どおり", () => {
  assert.equal(quiz.QUIZ_QUESTIONS.length, 180);
  const counts = {};
  for (const q of quiz.QUIZ_QUESTIONS) counts[q.category] = (counts[q.category] ?? 0) + 1;
  assert.deepEqual(counts, {
    "雑学": 37,
    "科学": 37,
    "歴史": 35,
    "スポーツ": 35,
    "アニメ・ゲーム": 36,
  });
  const texts = quiz.QUIZ_QUESTIONS.map((q) => q.question);
  assert.equal(new Set(texts).size, texts.length, "問題文に重複なし");
  for (const q of quiz.QUIZ_QUESTIONS) {
    assert.equal(q.answer, 0);
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4, q.question);
  }
});

test("クイズ: 増量分の正解が正しいこと", () => {
  const expected = new Map([
    ["世界で一番小さい国は？", "バチカン市国"],
    ["日本の国歌のタイトルは？", "君が代"],
    ["トランプのカードは、ジョーカーを除いて全部で何枚？", "52枚"],
    ["ジャイアントパンダのしっぽの色は？", "白"],
    ["日本で一番人口が多い都道府県は？", "東京都"],
    ["世界で一番高い山は？", "エベレスト"],
    ["酸素の元素記号はどれ？", "O"],
    ["太陽の表面温度はおよそ何度？", "約6,000℃"],
    ["月の重力は地球のおよそ何分の1？", "約6分の1"],
    ["ダイヤモンドは主に何という元素でできている？", "炭素"],
    ["地球から一番近い恒星は？", "太陽"],
    ["地震の規模（大きさ）を表す単位は？", "マグニチュード"],
    ["大化の改新が起きたのは何年？", "645年"],
    ["ナポレオンが皇帝になった国は？", "フランス"],
    ["1877年に設立された、日本で最初とされる大学は？", "東京大学"],
    ["平安京に都を移した天皇は？", "桓武天皇"],
    ["ベルリンの壁が崩壊したのは何年？", "1989年"],
    ["バレーボール（屋内）で1チームがコートに出す選手の数は？", "6人"],
    ["卓球の試合で、1ゲームを取るために必要な点数（通常）は？", "11点"],
    ["ボウリングで全てのピンを1投目で倒すことを何という？", "ストライク"],
    ["剣道で使う、竹を束ねて作られた刀を何という？", "竹刀"],
    ["サッカーのワールドカップに日本代表が初出場したのは何年？", "1998年"],
    ["『スーパーマリオブラザーズ』で、踏んで倒せるキノコのような敵の名前は？", "クリボー"],
    ["アニメ『サザエさん』のサザエの名字（結婚後）は？", "フグ田"],
    ["『マインクラフト』で、ダイヤモンド鉱石を掘るために最低限必要なツルハシの素材は？", "鉄"],
    ["映画『千と千尋の神隠し』で、千尋が働くことになる場所は？", "湯屋"],
    ["『ポケットモンスター』のピカチュウの全国図鑑番号は？", "25番"],
    ["ボードゲーム『人生ゲーム』でマスを進めるために回すものは？", "ルーレット"],
  ]);
  assert.equal(expected.size, 28);
  for (const [question, answer] of expected) {
    const q = quiz.QUIZ_QUESTIONS.find((x) => x.question === question);
    assert.ok(q, `問題が存在する: ${question}`);
    assert.equal(q.choices[q.answer], answer, question);
  }
});
