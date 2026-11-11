// A46フェーズの検証（内容充実: バンク増量のみ）。
// - lib/quiz.ts: 問題増量第3弾（140→160問→A49で180問・各カテゴリ+4問・形式・追加分の正解の妥当性）
// - lib/flagquiz.ts: ペア増量第3弾（170→185組→A49で195組・重複なし・ISO 照合・追加分の収録）
// - lib/online/games/nanja.ts: 生き物増量第2弾（26→30種・自動名30件・山札120枚・Client 複製との一致）
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
const nanja = await loadOnline("nanja.ts", [
  "gameModule",
  "NANJA_CREATURES",
  "NANJA_DEFAULT_NAMES",
  "NANJA_COPIES_PER_CREATURE",
]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- クイズ増量第3弾

test("クイズ増量(A46): バンクは180問でカテゴリ配分と形式が作法どおり", () => {
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

test("クイズ増量(A46): 追加20問の正解が正しいこと", () => {
  const expected = new Map([
    ["うるう年でない年（365日）は、全部で何週間と何日？", "52週と1日"],
    ["ことわざ「石の上にも」で、石の上に座り続ける年数は？", "3年"],
    ["日本で一番北にある都道府県は？", "北海道"],
    ["トランプの4つのマーク（スート）に含まれないのはどれ？", "月（つき）"],
    ["太陽系で、太陽に一番近い惑星は？", "水星"],
    ["植物の葉が緑色に見えるのは、主にどの色素のはたらき？", "葉緑素（クロロフィル）"],
    ["氷が水に浮くのは、氷の密度が液体の水と比べてどうだから？", "小さいから"],
    ["音がまったく伝わらないのは、どんな空間？", "真空"],
    ["聖徳太子が制定したとされる憲法は、何条からなる？", "十七条"],
    ["大日本帝国憲法が発布されたのは何年？", "1889年"],
    ["鎌倉時代に日本へ2度にわたって来襲した外国の軍勢は？", "元（モンゴル）"],
    ["『古事記』と『日本書紀』が編まれたのは、主に何時代？", "奈良時代"],
    ["ラグビーで「トライ」を決めると何点入る？", "5点"],
    ["バレーボールで、通常のセットを取るために必要な点数は？", "25点"],
    ["将棋の駒で、成っても金と同じ動きにならないのはどれ？", "角"],
    ["ゴルフで、規定打数より1打少なくホールを終えることを何という？", "バーディー"],
    ["『どうぶつの森』シリーズで、品物を売って得られる通貨の単位は？", "ベル"],
    ["アニメ『ちびまる子ちゃん』の主人公・まる子の名字は？", "さくら"],
    ["『スーパーマリオ』シリーズで、マリオが大きくなるアイテムは？", "スーパーキノコ"],
    ["パズルゲーム『ぷよぷよ』で、消すために同じ色をいくつつなげる？", "4個"],
  ]);
  assert.equal(expected.size, 20);
  for (const [question, answerText] of expected) {
    const q = quiz.QUIZ_QUESTIONS.find((x) => x.question === question);
    assert.ok(q, `問題が収録されていること: ${question}`);
    assert.equal(q.choices[q.answer], answerText, question);
  }
});

test("クイズ増量(A46): 180問バンクでもゲームが完走する", () => {
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

// ---------------------------------------------------------------- フラッグクイズ増量第3弾

test("フラッグ増量(A46): バンクは195組で重複がなく、全ての旗が regional indicator ペア", () => {
  assert.equal(fq.FLAG_PAIRS.length, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.flag)).size, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, 195);
  for (const p of fq.FLAG_PAIRS) {
    assert.ok(typeof p.name === "string" && p.name.length > 0);
    const cps = [...p.flag];
    assert.equal(cps.length, 2, p.name);
    for (const ch of cps) {
      const cp = ch.codePointAt(0);
      assert.ok(cp >= 0x1f1e6 && cp <= 0x1f1ff, `${p.name} の旗が regional indicator`);
    }
  }
});

test("フラッグ増量(A46): 追加15組の ISO コードと国名が一致すること", () => {
  const isoOf = (flag) =>
    [...flag].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 65)).join("");
  const expected = new Map([
    ["グレナダ", "GD"],
    ["セントルシア", "LC"],
    ["セントビンセント・グレナディーン", "VC"],
    ["セントクリストファー・ネイビス", "KN"],
    ["ドミニカ国", "DM"],
    ["アンティグア・バーブーダ", "AG"],
    ["エリトリア", "ER"],
    ["中央アフリカ共和国", "CF"],
    ["コンゴ共和国", "CG"],
    ["ガボン", "GA"],
    ["ギニア", "GN"],
    ["ブルンジ", "BI"],
    ["ブルキナファソ", "BF"],
    ["トーゴ", "TG"],
    ["サンマリノ", "SM"],
  ]);
  assert.equal(expected.size, 15);
  const byName = new Map(fq.FLAG_PAIRS.map((p) => [p.name, p.flag]));
  for (const [name, iso] of expected) {
    assert.ok(byName.has(name), `${name} が収録されていること`);
    assert.equal(isoOf(byName.get(name)), iso, name);
  }
});

test("フラッグ増量(A46): 195組バンクでもゲームが完走する", () => {
  let s = fq.createFlagQuizGame(7);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 50) {
    if (s.phase === "question") {
      const q = fq.currentFlagQuestion(s);
      assert.ok(q.choices.every((i) => i >= 0 && i < fq.FLAG_PAIRS.length));
      s = fq.answerFlagQuestion(s, q.answerPos);
    } else {
      s = fq.nextFlagQuestion(s);
    }
  }
  assert.equal(s.phase, "finished");
  assert.equal(fq.flagQuizCorrectCount(s), fq.FLAG_QUIZ_QUESTION_COUNT);
});

// ---------------------------------------------------------------- ナンジャ増量第2弾

test("ナンジャ増量(A46): 生き物は30種で重複がなく、自動名も30件そろっている", () => {
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
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🐹" && c.deco === "🌻"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🦓" && c.deco === "🍉"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🦢" && c.deco === "💎"));
  assert.ok(nanja.NANJA_CREATURES.some((c) => c.face === "🐌" && c.deco === "🍃"));
});

test("ナンジャ増量(A46): Client の表示用複製が lib と完全一致する", () => {
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

test("ナンジャ増量(A46): 山札は30種×4枚=120枚で全種そろい、新種も自動名が付く", () => {
  const st = nanja.gameModule.createState(seats(3), makeRng(5), {});
  assert.equal(st.deck.length, 30 * nanja.NANJA_COPIES_PER_CREATURE);
  assert.equal(st.deck.length, 120);
  const counts = new Array(30).fill(0);
  for (const c of st.deck) counts[c]++;
  assert.deepEqual(counts, new Array(30).fill(nanja.NANJA_COPIES_PER_CREATURE));
  // 新種（id 29）をめくっても命名フェーズに進み、時間切れで自動名が付く
  let s = { ...st, deck: [29] };
  s = nanja.gameModule.applyAction(s, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "naming");
  assert.equal(s.namingCreature, 29);
  s = nanja.gameModule.tick(s, s.namingEndsAt + 1);
  assert.equal(s.names[29], nanja.NANJA_DEFAULT_NAMES[29]);
});
