// A41フェーズの検証（内容充実: バンク増量のみ）。
// - lib/online/games/wordwolf.ts: お題ペア増量（50→60組・全単語の重複なし・追加分の近接ペア）
// - lib/online/games/nanja.ts: 生き物増量（20→26種→A46で30種・山札120枚・Client 複製との一致）
// - lib/quiz.ts: 問題増量第2弾（120→140問→A46で160問→A49で180問・カテゴリ配分・形式・追加分の正解の妥当性）
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

const wordwolf = await loadOnline("wordwolf.ts", ["gameModule", "WORDWOLF_PAIRS"]);
const nanja = await loadOnline("nanja.ts", [
  "gameModule",
  "NANJA_CREATURES",
  "NANJA_DEFAULT_NAMES",
  "NANJA_COPIES_PER_CREATURE",
]);
const quiz = await loadLib("quiz.ts");

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- ワードウルフ増量

test("ワードウルフ増量(A41): お題ペアは80組で、全ての単語が重複しない", () => {
  const pairs = wordwolf.WORDWOLF_PAIRS;
  assert.equal(pairs.length, 80);
  const words = new Set();
  for (const p of pairs) {
    assert.equal(typeof p.majority, "string");
    assert.equal(typeof p.minority, "string");
    assert.ok(p.majority.length > 0 && p.minority.length > 0);
    assert.notEqual(p.majority, p.minority);
    assert.ok(!words.has(p.majority), `重複: ${p.majority}`);
    assert.ok(!words.has(p.minority), `重複: ${p.minority}`);
    words.add(p.majority);
    words.add(p.minority);
  }
  assert.equal(words.size, 160);
});

test("ワードウルフ増量(A41): 追加10組が近接ペアとして収録されている", () => {
  const pairs = wordwolf.WORDWOLF_PAIRS;
  const added = [
    ["チャーハン", "オムライス"],
    ["窓", "ドア"],
    ["朝ごはん", "夜ごはん"],
    ["サンダル", "スニーカー"],
    ["歯ブラシ", "歯磨き粉"],
    ["正月", "お盆"],
    ["カラオケ", "ボウリング"],
    ["ホテル", "旅館"],
    ["おにぎり", "サンドイッチ"],
    ["牛乳", "ジュース"],
  ];
  for (const [majority, minority] of added) {
    assert.ok(
      pairs.some((p) => p.majority === majority && p.minority === minority),
      `${majority} / ${minority} が収録されていること`,
    );
  }
});

// ---------------------------------------------------------------- ナンジャ増量

test("ナンジャ増量(A41): 生き物は30種で重複がなく、自動名も30件そろっている", () => {
  assert.equal(nanja.NANJA_CREATURES.length, 30);
  const pairs = nanja.NANJA_CREATURES.map((c) => `${c.face}|${c.deco}`);
  assert.equal(new Set(pairs).size, 30);
  const labels = nanja.NANJA_CREATURES.map((c) => c.label);
  assert.equal(new Set(labels).size, 30);
  for (const c of nanja.NANJA_CREATURES) {
    assert.ok(typeof c.face === "string" && c.face.length > 0);
    assert.ok(typeof c.deco === "string" && c.deco.length > 0);
    assert.ok(typeof c.label === "string" && c.label.length > 0);
  }
  assert.equal(nanja.NANJA_DEFAULT_NAMES.length, 30);
  assert.equal(new Set(nanja.NANJA_DEFAULT_NAMES).size, 30);
  // 追加分の代表例が含まれている
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🐭" && c.deco === "🧀"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🦖" && c.deco === "🍦"));
});

test("ナンジャ増量(A41): Client の表示用複製が lib と完全一致する", () => {
  const src = fs.readFileSync(path.join(webDir, "app", "games", "nanja", "NanjaClient.tsx"), "utf8");
  const start = src.indexOf("const CREATURES");
  assert.ok(start >= 0, "Client に CREATURES があること");
  const block = src.slice(start, src.indexOf("];", start));
  const entries = [...block.matchAll(/\{ face: "([^"]+)", deco: "([^"]+)", label: "([^"]+)" \}/g)].map(
    (m) => ({ face: m[1], deco: m[2], label: m[3] }),
  );
  assert.equal(entries.length, 30);
  assert.deepEqual(
    entries,
    nanja.NANJA_CREATURES.map((c) => ({ face: c.face, deco: c.deco, label: c.label })),
  );
});

test("ナンジャ増量(A41): 山札は30種×4枚=120枚で全種そろい、新種も自動名が付く", () => {
  const st = nanja.gameModule.createState(seats(3), makeRng(5), {});
  assert.equal(st.deck.length, 30 * nanja.NANJA_COPIES_PER_CREATURE);
  const counts = new Array(30).fill(0);
  for (const c of st.deck) counts[c]++;
  assert.deepEqual(counts, new Array(30).fill(nanja.NANJA_COPIES_PER_CREATURE));
  // 新種（id 25）をめくっても命名フェーズに進み、時間切れで自動名が付く
  let s = { ...st, deck: [25] };
  s = nanja.gameModule.applyAction(s, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "naming");
  assert.equal(s.namingCreature, 25);
  s = nanja.gameModule.tick(s, s.namingEndsAt + 1);
  assert.equal(s.names[25], nanja.NANJA_DEFAULT_NAMES[25]);
});

// ---------------------------------------------------------------- クイズ増量第2弾

test("クイズ増量(A41): バンクは180問でカテゴリ配分と形式が作法どおり", () => {
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
    assert.ok(typeof q.question === "string" && q.question.length > 0);
    assert.equal(q.answer, 0, q.question);
    assert.equal(q.choices.length, 4, q.question);
    assert.equal(new Set(q.choices).size, 4, `${q.question} の選択肢に重複なし`);
    assert.ok(q.choices.every((c) => typeof c === "string" && c.length > 0), q.question);
  }
});

test("クイズ増量(A41): 追加20問の正解が正しいこと", () => {
  const expected = new Map([
    ["日本で一番面積が小さい都道府県は？", "香川県"],
    ["虹の色は基本的に何色とされる？", "7色"],
    ["干支（えと）で、子（ね）の次に来る動物は？", "丑（うし）"],
    ["一般的なピアノの鍵盤は全部でいくつ？", "88鍵"],
    ["水が沸騰する温度は摂氏何度？（1気圧）", "100℃"],
    ["銀の元素記号はどれ？", "Ag"],
    ["昆虫の脚は全部で何本？", "6本"],
    ["地球が1回自転するのにかかる時間はおよそ何時間？", "約24時間"],
    ["織田信長が今川義元を破った戦いは？", "桶狭間の戦い"],
    ["日本で最初の鉄道が開通したのは、新橋とどこの間？", "横浜"],
    ["1590年に豊臣秀吉が攻め落とし、天下統一の仕上げとなった城は？", "小田原城"],
    ["第二次世界大戦が始まったのは何年？", "1939年"],
    ["競泳の個人メドレーで、最初に泳ぐ泳法は？", "バタフライ"],
    ["ボクシングで、相手を倒して勝つことを何という？", "ノックアウト"],
    ["アーチェリーで狙う的の、一番中心の部分の色は？", "黄色（金色）"],
    ["フィギュアスケートのジャンプで、3回転半回るジャンプは？", "トリプルアクセル"],
    ["『クレヨンしんちゃん』の主人公のフルネームは？", "野原しんのすけ"],
    ["ゲーム『あつまれ どうぶつの森』で、島の案内役をするタヌキは？", "たぬきち"],
    ["『鋼の錬金術師』で、錬金術の基本とされる原則は？", "等価交換"],
    ["初代『ポケットモンスター 赤・緑』が発売された携帯ゲーム機は？", "ゲームボーイ"],
  ]);
  assert.equal(expected.size, 20);
  for (const [question, answer] of expected) {
    const q = quiz.QUIZ_QUESTIONS.find((x) => x.question === question);
    assert.ok(q, `問題が収録されていること: ${question}`);
    assert.equal(q.choices[q.answer], answer, question);
  }
});
