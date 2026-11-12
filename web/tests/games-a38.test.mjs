// A38フェーズの検証（内容充実: バンク増量のみ）。
// - lib/flagquiz.ts: 増量後のバンク（120→150組・重複なし・旗は regional indicator ペア・追加分の ISO 一致）
// - lib/online/games/wordwolf.ts: お題ペア増量（40→50組→A41で60組・全単語の重複なし・追加分の近接ペア）
// - lib/quiz.ts: 問題増量（100→120問→A41で140問→A46で160問→A49で180問・カテゴリ配分・形式・追加分の正解の妥当性）
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

const fq = await loadLib("flagquiz.ts");
const quiz = await loadLib("quiz.ts");
const wordwolf = await loadOnline("wordwolf.ts", ["gameModule", "WORDWOLF_PAIRS"]);

// ---------------------------------------------------------------- フラッグクイズ増量

test("フラッグ増量(A38): バンクは195組で重複がなく、全ての国コードが ISO alpha-2 小文字", () => {
  assert.equal(fq.FLAG_PAIRS.length, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.code)).size, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, 195);
  for (const p of fq.FLAG_PAIRS) {
    assert.equal(typeof p.code, "string");
    assert.equal(typeof p.name, "string");
    assert.ok(p.name.length > 0);
    assert.ok(/^[a-z]{2}$/.test(p.code), `${p.name} の国コード ${p.code}`);
  }
});

test("フラッグ増量(A38): 追加30組の国名と国コード（ISO）が一致している", () => {
  const byName = new Map(fq.FLAG_PAIRS.map((p) => [p.name, p.code]));
  const added = [
    ["リビア", "LY"],
    ["スーダン", "SD"],
    ["マリ", "ML"],
    ["ザンビア", "ZM"],
    ["ナミビア", "NA"],
    ["ボツワナ", "BW"],
    ["コンゴ民主共和国", "CD"],
    ["モーリシャス", "MU"],
    ["イエメン", "YE"],
    ["バーレーン", "BH"],
    ["パレスチナ", "PS"],
    ["東ティモール", "TL"],
    ["ソロモン諸島", "SB"],
    ["バヌアツ", "VU"],
    ["サモア", "WS"],
    ["トンガ", "TO"],
    ["キリバス", "KI"],
    ["パラオ", "PW"],
    ["グアテマラ", "GT"],
    ["ホンジュラス", "HN"],
    ["ニカラグア", "NI"],
    ["コスタリカ", "CR"],
    ["パナマ", "PA"],
    ["ドミニカ共和国", "DO"],
    ["ハイチ", "HT"],
    ["ガイアナ", "GY"],
    ["スリナム", "SR"],
    ["リヒテンシュタイン", "LI"],
    ["アンドラ", "AD"],
    ["モナコ", "MC"],
  ];
  assert.equal(added.length, 30);
  for (const [name, iso] of added) {
    assert.equal(byName.get(name), iso.toLowerCase(), `${name} の国コードが ISO ${iso} と一致すること`);
  }
  // 増量後も出題が成立する（選択肢は全てバンク内・正解位置が choices と一致）
  for (const seed of [1, 7, 42]) {
    const game = fq.createFlagQuizGame(seed);
    assert.equal(game.questions.length, fq.FLAG_QUIZ_QUESTION_COUNT);
    const targets = new Set(game.questions.map((q) => q.target));
    assert.equal(targets.size, game.questions.length, "同一ゲーム内で出題が重複しない");
    for (const q of game.questions) {
      assert.equal(q.choices.length, 4);
      assert.equal(new Set(q.choices).size, 4);
      assert.ok(q.choices.every((i) => i >= 0 && i < fq.FLAG_PAIRS.length));
      assert.equal(q.choices[q.answerPos], q.target);
    }
  }
});

// ---------------------------------------------------------------- ワードウルフ増量

test("ワードウルフ増量(A38): お題ペアは80組で、全ての単語が重複しない", () => {
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

test("ワードウルフ増量(A38): 追加10組が近接ペアとして収録されている", () => {
  const pairs = wordwolf.WORDWOLF_PAIRS;
  const added = [
    ["そば", "そうめん"],
    ["タクシー", "レンタカー"],
    ["プール", "海水浴場"],
    ["将棋", "囲碁"],
    ["かき氷", "アイスクリーム"],
    ["花火大会", "お祭り"],
    ["金魚", "メダカ"],
    ["エレベーター", "エスカレーター"],
    ["パスポート", "運転免許証"],
    ["扇風機", "エアコン"],
  ];
  for (const [majority, minority] of added) {
    assert.ok(
      pairs.some((p) => p.majority === majority && p.minority === minority),
      `${majority} / ${minority} が収録されていること`,
    );
  }
});

// ---------------------------------------------------------------- クイズ増量

test("クイズ増量(A38): バンクは180問でカテゴリ配分と形式が作法どおり", () => {
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
    assert.equal(q.choices.length, 4, q.question);
    assert.equal(new Set(q.choices).size, 4, `${q.question} の選択肢に重複なし`);
    assert.ok(q.choices.every((c) => typeof c === "string" && c.length > 0), q.question);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, q.question);
  }
});

test("クイズ増量(A38): 追加20問の正解が正しいこと", () => {
  const expected = new Map([
    ["2024年に発行された新千円札の肖像になっている人物は？", "北里柴三郎"],
    ["世界で一番深い海溝は？", "マリアナ海溝"],
    ["日本で一番南にある都道府県は？", "沖縄県"],
    ["サイコロの向かい合う面の数字の合計は常にいくつ？", "7"],
    ["惑星の中で「赤い惑星」と呼ばれるのは？", "火星"],
    ["電流の単位は？", "アンペア"],
    ["青いリトマス試験紙が酸性で変化する色は？", "赤"],
    ["人間の歯で、食べ物をすりつぶす働きをする奥の歯を何という？", "臼歯"],
    ["1600年に起きた「天下分け目の戦い」と呼ばれる戦いは？", "関ヶ原の戦い"],
    ["『枕草子』の作者は？", "清少納言"],
    ["日本で最初の女性天皇とされるのは？", "推古天皇"],
    ["ペリーが黒船で浦賀に来航したのは何年？", "1853年"],
    ["バドミントンで打ち合う、羽根のついた球を何という？", "シャトル"],
    ["アイスホッケーで使う、硬いゴム製の円盤を何という？", "パック"],
    ["野球で打者がフォアボールで歩くのは、ボールが何個になったとき？", "4個"],
    ["夏季オリンピックは通常何年ごとに開催される？", "4年"],
    ["『ドラえもん』のドラえもんが大好物の食べ物は？", "どら焼き"],
    ["『ポケットモンスター 赤・緑』で最初に選べるポケモンは何匹？", "3匹"],
    ["漫画『SLAM DUNK』の主人公・桜木花道のポジションは？", "パワーフォワード"],
    ["『ファイナルファンタジー』シリーズで、騎乗できる黄色い大きな鳥は？", "チョコボ"],
  ]);
  assert.equal(expected.size, 20);
  for (const [question, correct] of expected) {
    const q = quiz.QUIZ_QUESTIONS.find((x) => x.question === question);
    assert.ok(q, `問題が存在する: ${question}`);
    assert.equal(q.choices[q.answer], correct, `${question} の正解は ${correct}`);
  }
  // 増量後もゲームが完走する（正解を選び続けると全問正解で終わる）
  let s = quiz.createQuizGame(123);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 50) {
    if (s.phase === "answering") {
      const cur = quiz.currentQuizQuestion(s);
      s = quiz.answerQuestion(s, cur.answer);
    } else {
      s = quiz.nextQuestion(s);
    }
  }
  assert.equal(s.phase, "finished");
  assert.equal(quiz.quizCorrectCount(s), quiz.QUIZ_TOTAL_QUESTIONS);
});
