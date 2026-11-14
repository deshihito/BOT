// A11フェーズの新規4本のロジック検証。
// - lib/yahtzee.ts: 役の採点・振り直しと保持・カテゴリ記録・上段ボーナスと合計
// - lib/online/games/nanja.ts: めくり・命名（手動/時間切れ）・早叫びの正誤と山獲得・退出
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

const yz = await loadLib("yahtzee.ts");
const nanja = await loadOnline("nanja.ts", [ "gameModule", "NANJA_CREATURES", "NANJA_DEFAULT_NAMES", "NANJA_NAME_TIME_MS", "normalizeNanjaName", "nanjaStandings", ]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- ヤッツィー

test("ヤッツィー: 役の採点（数え役・ストレート・フルハウス・ヤッツィー）", () => {
  const score = yz.yahtzeeScoreFor;
  assert.equal(score([1, 1, 3, 4, 6], "ones"), 2);
  assert.equal(score([6, 6, 6, 6, 2], "sixes"), 24);
  assert.equal(score([4, 4, 4, 1, 2], "threeOfAKind"), 15);
  assert.equal(score([4, 4, 1, 1, 2], "threeOfAKind"), 0);
  assert.equal(score([5, 5, 5, 5, 1], "fourOfAKind"), 21);
  assert.equal(score([3, 3, 3, 2, 2], "fullHouse"), 25);
  assert.equal(score([5, 5, 5, 5, 5], "fullHouse"), 0); // 5つ揃いはフルハウスにしない
  assert.equal(score([1, 2, 3, 4, 4], "smallStraight"), 30);
  assert.equal(score([1, 2, 3, 5, 6], "smallStraight"), 0);
  assert.equal(score([2, 3, 4, 5, 6], "largeStraight"), 40);
  assert.equal(score([2, 3, 4, 5, 6], "smallStraight"), 30);
  assert.equal(score([6, 6, 6, 6, 6], "yahtzee"), 50);
  assert.equal(score([6, 6, 6, 6, 5], "yahtzee"), 0);
  assert.equal(score([1, 2, 3, 4, 5], "chance"), 15);
});

test("ヤッツィー: 振る・保持・振り直し・記録の流れと重複記録の拒否", () => {
  let st = yz.createYahtzee(42);
  assert.equal(yz.toggleYahtzeeHold(st, 0), st); // 振る前は保持できない
  st = yz.rollYahtzeeDice(st);
  assert.equal(st.rollsUsed, 1);
  assert.ok(st.dice.every((d) => d >= 1 && d <= 6));
  const kept = st.dice[0];
  st = yz.toggleYahtzeeHold(st, 0);
  assert.equal(st.held[0], true);
  st = yz.rollYahtzeeDice(st);
  assert.equal(st.dice[0], kept); // 保持したダイスは変わらない
  st = yz.rollYahtzeeDice(st);
  assert.equal(st.rollsUsed, 3);
  assert.equal(yz.rollYahtzeeDice(st), st); // 4回目は振れない
  // 記録するとターンが進み、振り直し回数がリセットされる
  const before = yz.yahtzeeScoreFor(st.dice, "chance");
  st = yz.applyYahtzeeScore(st, "chance");
  assert.equal(st.scores[yz.YAHTZEE_CATEGORIES.indexOf("chance")], before);
  assert.equal(st.turnsDone, 1);
  assert.equal(st.rollsUsed, 0);
  // 同じカテゴリには記録できない
  st = yz.rollYahtzeeDice(st);
  assert.equal(yz.applyYahtzeeScore(st, "chance"), st);
});

test("ヤッツィー: 決定的再現と、上段ボーナス・合計の計算", () => {
  const play = (seed) => {
    let st = yz.createYahtzee(seed);
    const seen = [];
    for (let t = 0; t < 3; t++) {
      st = yz.rollYahtzeeDice(st);
      seen.push([...st.dice]);
      st = yz.applyYahtzeeScore(st, yz.YAHTZEE_CATEGORIES[t]);
    }
    return seen;
  };
  assert.deepEqual(play(7), play(7));
  // 上段 63 で ボーナス 35
  const st = yz.createYahtzee(1);
  const scores = new Array(13).fill(null);
  scores[0] = 3;
  scores[1] = 6;
  scores[2] = 9;
  scores[3] = 12;
  scores[4] = 15;
  scores[5] = 18; // 上段 = 63
  scores[12] = 20;
  const totals = yz.yahtzeeTotals({ ...st, scores });
  assert.equal(totals.upper, 63);
  assert.equal(totals.upperBonus, 35);
  assert.equal(totals.total, 63 + 35 + 20);
});

test("ヤッツィー: 13カテゴリ記録で終了する", () => {
  let st = yz.createYahtzee(99);
  for (const category of yz.YAHTZEE_CATEGORIES) {
    st = yz.rollYahtzeeDice(st);
    st = yz.applyYahtzeeScore(st, category);
  }
  assert.equal(st.status, "finished");
  assert.equal(st.turnsDone, 13);
  const totals = yz.yahtzeeTotals(st);
  assert.equal(totals.recorded, 13);
  assert.ok(totals.total > 0);
});

// ---------------------------------------------------------------- ナンジャモンジャ風

const gm = nanja.gameModule;

test("ナンジャ: 山札は30種×4枚=120枚で、全種そろっている", () => {
  const st = gm.createState(seats(3), makeRng(5), {});
  assert.equal(st.deck.length, 120);
  const counts = new Array(30).fill(0);
  for (const c of st.deck) counts[c]++;
  assert.deepEqual(counts, new Array(30).fill(4));
  assert.equal(st.phase, "flip");
  assert.equal(st.current, 0);
});

test("ナンジャ: 手番以外はめくれない／初めての生き物は命名フェーズになる", () => {
  const st = gm.createState(seats(2), makeRng(5), {});
  assert.throws(() => gm.applyAction(st, 1, { type: "flip" }, makeRng(1)));
  const s2 = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  assert.equal(s2.pile.length, 1);
  assert.equal(s2.phase, "naming");
  assert.equal(s2.namingSeat, 0);
  assert.ok(typeof s2.namingEndsAt === "number");
  // 命名はめくった人だけ・12文字まで
  assert.throws(() => gm.applyAction(s2, 1, { type: "name", name: "ダメ" }, makeRng(1)));
  assert.throws(() => gm.applyAction(s2, 0, { type: "name", name: "あ".repeat(13) }, makeRng(1)));
  const s3 = gm.applyAction(s2, 0, { type: "name", name: "  モジャ太  " }, makeRng(1));
  const creature = s2.namingCreature;
  assert.equal(s3.names[creature], "モジャ太"); // 前後空白は正規化される
  assert.equal(s3.namedBy[creature], 0);
  assert.equal(s3.phase, "flip");
  assert.equal(s3.current, 1); // 手番は次へ
});

test("ナンジャ: 命名が時間切れになると自動名が付き、手番が進む", () => {
  const st = gm.createState(seats(2), makeRng(5), {});
  const s2 = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  const creature = s2.namingCreature;
  const same = gm.tick(s2, s2.namingEndsAt - 1);
  assert.equal(same, s2); // 締切前は何も起きない
  const s3 = gm.tick(s2, s2.namingEndsAt + 1);
  assert.equal(s3.names[creature], nanja.NANJA_DEFAULT_NAMES[creature]);
  assert.equal(s3.phase, "flip");
  assert.equal(s3.current, 1);
});

test("ナンジャ: 名前のある生き物が再び出たら、最初に正しく叫んだ人が山をもらう", () => {
  let st = gm.createState(seats(3), makeRng(5), {});
  // 山札を細工する: 一番上（末尾）から 3 → 5 → 3 の順で出るようにする
  st = { ...st, deck: [5, 3] };
  st.names[3] = "テスト";
  // まず 3 が出る（名前あり → 叫びフェーズ）
  let s = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "shout");
  assert.equal(s.pile.length, 1);
  // ハズレた人はその山でロックされる
  s = gm.applyAction(s, 1, { type: "shout", name: "チガウ" }, makeRng(1));
  assert.equal(s.shoutLocked[1], true);
  assert.throws(() => gm.applyAction(s, 1, { type: "shout", name: "テスト" }, makeRng(1)));
  // 別の人が正しく叫ぶと山（1枚）を獲得し、その人が次にめくる
  s = gm.applyAction(s, 2, { type: "shout", name: "テスト" }, makeRng(1));
  assert.equal(s.captured[2], 1);
  assert.equal(s.pile.length, 0);
  assert.equal(s.phase, "flip");
  assert.equal(s.current, 2);
  // ビューに山札の中身は含まれない
  const view = gm.viewFor(s, 0);
  assert.equal(view.deckCount, 1);
  assert.equal("deck" in view, false);
});

test("ナンジャ: 全員ハズレで山が流れ、退出者の命名は残り、生存1人で終了する", () => {
  let st = gm.createState(seats(2), makeRng(5), {});
  st = { ...st, deck: [3] };
  st.names[3] = "テスト";
  let s = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  s = gm.applyAction(s, 0, { type: "shout", name: "ハズレ1" }, makeRng(1));
  s = gm.applyAction(s, 1, { type: "shout", name: "ハズレ2" }, makeRng(1));
  // 全員ロック → 山は場に残ったまま、山札が尽きたので終了
  assert.equal(s.phase, "finished");
  assert.equal(s.pile.length, 1);

  // 命名中に退出すると自動名が付き、名前は残る
  const st2 = gm.createState(seats(3), makeRng(5), {});
  const f = gm.applyAction(st2, 0, { type: "flip" }, makeRng(1));
  const creature = f.namingCreature;
  const left = gm.onPlayerLeft(f, 0);
  assert.equal(left.names[creature], nanja.NANJA_DEFAULT_NAMES[creature]);
  assert.equal(left.namedBy[creature], 0);
  assert.ok(left.leftSeats.includes(0));
  // さらに1人退出すると生存1人 → 終了
  const end = gm.onPlayerLeft(left, 1);
  assert.equal(end.phase, "finished");
  assert.ok(Array.isArray(end.winners));
});

test("ナンジャ: parseAction の形式検証と standings の順位", () => {
  assert.deepEqual(gm.parseAction({ type: "flip" }), { type: "flip" });
  assert.deepEqual(gm.parseAction({ type: "shout", name: "モジャ" }), { type: "shout", name: "モジャ" });
  assert.equal(gm.parseAction({ type: "shout" }), null);
  assert.equal(gm.parseAction({ type: "unknown" }), null);
  assert.equal(gm.parseAction("flip"), null);
  const st = gm.createState(seats(3), makeRng(5), {});
  const crafted = { ...st, captured: [10, 10, 4] };
  const standings = nanja.nanjaStandings(crafted);
  assert.deepEqual(
    standings.map((x) => [x.seat, x.rank]),
    [
      [0, 1],
      [1, 1],
      [2, 3],
    ],
  );
});

test("ナンジャ: ビューでは対局中は名前が伏せられ、終了時に開示される", () => {
  let st = gm.createState(seats(2), makeRng(5), {});
  st = { ...st, deck: [3] };
  st.names[3] = "テスト";
  const s = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "shout");
  const view = gm.viewFor(s, 0);
  // 命名済みであることは分かるが、名前そのものは対局中は配られない。
  assert.equal(view.named[3], true);
  assert.equal(view.names[3], null);
  assert.ok(!JSON.stringify(view).includes("テスト"), "対局中のビューに正解名が漏れている");
  // 終了したビューでは開示される。
  const finView = gm.viewFor({ ...s, phase: "finished" }, 0);
  assert.equal(finView.names[3], "テスト");
});

test("ナンジャ: めくる番が放置すると tick が代わりにめくる", () => {
  const st = gm.createState(seats(2), makeRng(5), {});
  assert.equal(st.phase, "flip");
  assert.equal(typeof st.phaseEndsAt, "number");
  // 締切前は同一参照。
  assert.equal(gm.tick(st, st.phaseEndsAt - 1), st);
  const s = gm.tick(st, st.phaseEndsAt + 1);
  assert.equal(s.pile.length, 1);
  assert.equal(s.phase, "naming"); // 初めての生き物なので命名フェーズへ
  assert.equal(s.namingSeat, 0);
});

test("ナンジャ: 叫ぶフェーズが時間切れになると山が流れて次の手番になる", () => {
  let st = gm.createState(seats(2), makeRng(5), {});
  st = { ...st, deck: [5, 3] };
  st.names[3] = "テスト";
  let s = gm.applyAction(st, 0, { type: "flip" }, makeRng(1));
  assert.equal(s.phase, "shout");
  assert.equal(typeof s.phaseEndsAt, "number");
  s = gm.tick(s, s.phaseEndsAt + 1);
  assert.equal(s.phase, "flip");
  assert.equal(s.pile.length, 1); // 山は場に残る
  assert.equal(s.current, 1); // 手番はめくった人の次へ
  assert.equal(s.lastEvent.type, "dead");
});
