// A49フェーズ: 内容充実3件（バンク増量のみ）の検証。
// - lib/quiz.ts: 問題増量第4弾（160→180問・各カテゴリ+4問・形式・追加分の正解の妥当性）
// - lib/flagquiz.ts: ペア増量第4弾（185→195組・重複なし・ISO 照合・追加分の収録）
// - lib/online/games/shiritori.ts: 辞書増量第3弾（1400→1600語・重複なし・
//   「ン」終わりの比率 約10%・行き止まり0件・増量語での実プレイ）
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
const fq = await loadLib("flagquiz.ts");
const shi = await loadOnline("shiritori.ts", [
  "SHIRITORI_WORDS",
  "isValidWordForm",
  "shiritoriTail",
  "isBankWord",
  "gameModule",
]);

// ---------------------------------------------------------------- クイズ増量第4弾

test("クイズ増量(A49): バンクは180問でカテゴリ配分と形式が作法どおり", () => {
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

test("クイズ増量(A49): 追加20問の正解が正しいこと", () => {
  const expected = new Map([
    ["世界で一番人口が多い国は？", "インド"],
    ["信号機で「進め」を表すランプの色は、日本では何色と呼ばれる？", "青"],
    ["七夕（たなばた）は何月何日？", "7月7日"],
    ["日本の祝日「海の日」があるのは何月？", "7月"],
    ["水素の元素記号はどれ？", "H"],
    ["人間の体で、血液の細胞を作る主な場所は？", "骨髄"],
    ["地震の揺れの強さを表す階級は？", "震度"],
    ["クモの脚は全部で何本？", "8本"],
    ["豊臣秀吉が行った、百姓や寺社から刀や鉄砲を取り上げた政策は？", "刀狩"],
    ["日本で最初の内閣総理大臣は？", "伊藤博文"],
    ["発明王エジソンが電球のフィラメントに使ったことで知られる、日本産の素材は？", "竹"],
    ["鎌倉時代、将軍に代わって政治の実権を握った北条氏の役職は？", "執権"],
    ["大相撲の本場所は、1年に何回開かれる？", "6回"],
    ["ゴルフで、規定打数より2打少なくホールを終えることを何という？", "イーグル"],
    ["バタフライ（蝶泳ぎ）は、もともとどの泳法の一部から生まれた？", "平泳ぎ"],
    ["野球で、走者のいない場面でホームランを打つと何点入る？", "1点"],
    ["『ドラえもん』の野比のび太の特技として知られるものは？", "あやとり"],
    ["『スーパーマリオブラザーズ』で、マリオがクッパから救い出すお姫様は？", "ピーチ姫"],
    ["『ドラゴンクエスト』シリーズで、HPを回復する呪文は？", "ホイミ"],
    ["漫画『ONE PIECE』の主人公ルフィが目指している称号は？", "海賊王"],
  ]);
  assert.equal(expected.size, 20);
  for (const [question, answerText] of expected) {
    const q = quiz.QUIZ_QUESTIONS.find((x) => x.question === question);
    assert.ok(q, `問題が収録されていること: ${question}`);
    assert.equal(q.choices[q.answer], answerText, question);
  }
});

test("クイズ増量(A49): 180問バンクでもゲームが完走する", () => {
  for (const seed of [1, 42, 20261112]) {
    let s = quiz.createQuizGame(seed);
    let guard = 0;
    while (s.phase !== "finished" && guard++ < 50) {
      if (s.phase === "answering") s = quiz.answerQuestion(s, 0);
      else s = quiz.nextQuestion(s);
    }
    assert.equal(s.phase, "finished");
    assert.equal(s.answers.length, quiz.QUIZ_TOTAL_QUESTIONS);
  }
});

// ---------------------------------------------------------------- フラッグ増量第4弾

function flagToIso(flag) {
  return [...flag]
    .map((ch) => String.fromCodePoint((ch.codePointAt(0) ?? 0) - 0x1f1e6 + 65))
    .join("");
}

test("フラッグ増量(A49): バンクは195組で重複がなく、全ての旗が regional indicator ペア", () => {
  assert.equal(fq.FLAG_PAIRS.length, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.flag)).size, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, 195);
  for (const p of fq.FLAG_PAIRS) {
    const cps = [...p.flag];
    assert.equal(cps.length, 2, p.name);
    for (const ch of cps) {
      const cp = ch.codePointAt(0) ?? 0;
      assert.ok(cp >= 0x1f1e6 && cp <= 0x1f1ff, p.name);
    }
    assert.ok(typeof p.name === "string" && p.name.length > 0);
  }
});

test("フラッグ増量(A49): 追加10組の ISO コードと国名が一致する", () => {
  const expected = new Map([
    ["VA", "バチカン"],
    ["GW", "ギニアビサウ"],
    ["SL", "シエラレオネ"],
    ["LR", "リベリア"],
    ["MR", "モーリタニア"],
    ["KM", "コモロ"],
    ["SZ", "エスワティニ"],
    ["ST", "サントメ・プリンシペ"],
    ["GL", "グリーンランド"],
    ["CK", "クック諸島"],
  ]);
  assert.equal(expected.size, 10);
  for (const [iso, name] of expected) {
    const pair = fq.FLAG_PAIRS.find((p) => flagToIso(p.flag) === iso);
    assert.ok(pair, `ISO ${iso} のペアが収録されていること`);
    assert.equal(pair.name, name, iso);
  }
});

test("フラッグ増量(A49): 195組バンクでもゲームが完走する", () => {
  for (const seed of [7, 99, 20261112]) {
    let s = fq.createFlagQuizGame(seed);
    let guard = 0;
    while (s.phase !== "finished" && guard++ < 50) {
      if (s.phase === "question") s = fq.answerFlagQuestion(s, 0);
      else s = fq.nextFlagQuestion(s);
    }
    assert.equal(s.phase, "finished");
    assert.equal(s.records.length, fq.FLAG_QUIZ_QUESTION_COUNT);
  }
});

// ---------------------------------------------------------------- しりとり増量第3弾

test("しりとり増量(A49): 辞書は1600語・重複なし・全語が正しい形式", () => {
  const words = shi.SHIRITORI_WORDS;
  assert.equal(words.length, 1600);
  assert.equal(new Set(words).size, 1600, "単語に重複なし");
  for (const w of words) {
    assert.ok(shi.isValidWordForm(w), `形式が正しいこと: ${w}`);
  }
});

test("しりとり増量(A49): 「ン」終わりの脱落語の比率は約10%", () => {
  const words = shi.SHIRITORI_WORDS;
  const nWords = words.filter((w) => w.endsWith("ン"));
  assert.equal(nWords.length, 159);
  const ratio = nWords.length / words.length;
  assert.ok(ratio >= 0.09 && ratio <= 0.11, `比率 ${ratio}`);
});

test("しりとり増量(A49): 行き止まりは0件（全ての非ン語に接続先がある）", () => {
  const words = shi.SHIRITORI_WORDS;
  const starts = new Set(words.map((w) => w.charAt(0)));
  const dead = words.filter((w) => !w.endsWith("ン") && !starts.has(shi.shiritoriTail(w)));
  assert.deepEqual(dead, []);
});

test("しりとり増量(A49): 増量分の代表語がバンクに収録され、増量語だけで接続できる", () => {
  for (const added of [
    "ハシビロコウ", "ヘラクレスオオカブト", "ティラミス", "サーモン", "アカショウビン",
    "スコーン", "チャンポン", "シアン", "ホルン", "カルカン",
  ]) {
    assert.ok(shi.isBankWord(added), `増量語 ${added} がない`);
  }
  // 増量語だけのチェーン: ハシビロコウ(ウ)→ウミネコ(コ)→コンドル(ル)→ルリビタキ(キ)→キス(ス)→スコーン(ンで脱落)
  const players = [
    { seat: 0, name: "P1" },
    { seat: 1, name: "P2" },
  ];
  let s = shi.gameModule.createState(players, () => 0.5, {});
  const plays = [
    [0, "ハシビロコウ"],
    [1, "ウミネコ"],
    [0, "コンドル"],
    [1, "ルリビタキ"],
    [0, "キス"],
    [1, "スコーン"],
  ];
  for (const [seat, word] of plays) {
    s = shi.gameModule.applyAction(s, seat, { type: "submit", word }, () => 0.5);
  }
  assert.equal(s.history.length, 6);
  assert.equal(s.history[5].foul, true);
  assert.equal(s.finished, true);
  assert.equal(s.winner, 0);
});
