// A27フェーズの検証。
// - lib/mergefruit.ts: 落下・合体・連鎖・天井ゲームオーバー・決定性
// - lib/online/games/wordbasket.ts: 形式検証・得点式・秘匿・ロック・退出・完走
// - lib/flagquiz.ts: 増量後のバンク（195組・重複なし・国コードは ISO alpha-2）
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

const mf = await loadLib("mergefruit.ts");
const fq = await loadLib("flagquiz.ts");
const wb = await loadOnline("wordbasket.ts", [
  "gameModule",
  "WB_PROMPTS",
  "WB_TOTAL_ROUNDS",
  "WB_TIME_LIMIT_MS",
  "WB_LOCK_MS",
  "validateBasketWord",
  "wbScoreFor",
  "toHiragana",
]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));
const idx = (r, c) => r * mf.MERGE_COLS + c;
const emptyBoard = () => new Array(mf.MERGE_CELLS).fill(null);

// ---------------------------------------------------------------- フルーツマージ

test("マージ: 同じシードでは同じ開始フルーツになり、落下列も決定的", () => {
  const a = mf.createMergeGame(42);
  const b = mf.createMergeGame(42);
  assert.equal(a.current, b.current);
  assert.equal(a.next, b.next);
  assert.ok(a.current >= 0 && a.current <= mf.MERGE_DROP_MAX_LEVEL);
  assert.deepEqual(a.board, emptyBoard());
  let sa = a;
  let sb = b;
  for (const col of [0, 1, 2, 3, 4, 5, 2, 2]) {
    sa = mf.dropFruit(sa, col);
    sb = mf.dropFruit(sb, col);
  }
  assert.deepEqual(sa, sb);
  assert.equal(sa.dropped, 8);
});

test("マージ: 落下は一番下の空きに止まり、元の状態を壊さない／不正な列は無効", () => {
  const st = mf.createMergeGame(5);
  assert.equal(mf.landingRow(st.board, 3), mf.MERGE_ROWS - 1);
  const after = mf.dropFruit(st, 3);
  assert.notEqual(after, st);
  assert.equal(after.board[idx(mf.MERGE_ROWS - 1, 3)], st.current);
  assert.deepEqual(st.board, emptyBoard()); // 非破壊
  assert.equal(after.current, st.next); // 次のフルーツが繰り上がる
  assert.equal(mf.dropFruit(st, -1), st);
  assert.equal(mf.dropFruit(st, mf.MERGE_COLS), st);
  assert.equal(mf.dropFruit(st, 1.5), st);
});

test("マージ: 横に接した2個が合体して1段階上がり、得点が入る", () => {
  const board = emptyBoard();
  board[idx(9, 0)] = 0;
  board[idx(9, 1)] = 0;
  const res = mf.resolveMergeBoard(board);
  assert.equal(res.merges, 1);
  assert.equal(res.chains, 1);
  assert.equal(res.bestLevel, 1);
  assert.equal(res.gained, mf.mergeScoreFor(1));
  // 合体先は「一番下・一番左」= (9,0)
  assert.equal(res.board[idx(9, 0)], 1);
  assert.equal(res.board[idx(9, 1)], null);
  assert.equal(res.board.filter((v) => v !== null).length, 1);
});

test("マージ: 3個つながっても1回の合体で1個になる（段階は1つだけ上がる）", () => {
  const board = emptyBoard();
  board[idx(9, 0)] = 2;
  board[idx(9, 1)] = 2;
  board[idx(9, 2)] = 2;
  const res = mf.resolveMergeBoard(board);
  assert.equal(res.merges, 1);
  assert.equal(res.board.filter((v) => v !== null).length, 1);
  assert.equal(res.board[idx(9, 0)], 3);
});

test("マージ: 合体でできた隣接が連鎖する（縦の積み重ね）", () => {
  const board = emptyBoard();
  board[idx(9, 0)] = 1;
  board[idx(8, 0)] = 0;
  board[idx(7, 0)] = 0;
  const res = mf.resolveMergeBoard(board);
  // 1連鎖目: 0同士が合体して (8,0) が 1 に → 落下して (9,0) の 1 と接する
  // 2連鎖目: 1同士が合体して 2 になる
  assert.equal(res.chains, 2);
  assert.equal(res.merges, 2);
  assert.equal(res.bestLevel, 2);
  assert.equal(res.gained, mf.mergeScoreFor(1) * 1 + mf.mergeScoreFor(2) * 2);
  assert.equal(res.board[idx(9, 0)], 2);
  assert.equal(res.board.filter((v) => v !== null).length, 1);
});

test("マージ: 最終段階同士は合体しない", () => {
  const board = emptyBoard();
  const maxLevel = mf.FRUIT_KINDS.length - 1;
  board[idx(9, 0)] = maxLevel;
  board[idx(9, 1)] = maxLevel;
  const res = mf.resolveMergeBoard(board);
  assert.equal(res.merges, 0);
  assert.equal(res.chains, 0);
  assert.deepEqual(res.board, board);
});

test("マージ: 落下したフルーツが既存と接すると合体し、スコアと最大段階が更新される", () => {
  const base = mf.createMergeGame(9);
  const board = emptyBoard();
  board[idx(9, 0)] = base.current; // 落とすフルーツと同じ段階を底に置く
  const st = { ...base, board };
  const after = mf.dropFruit(st, 0);
  assert.equal(after.dropped, 1);
  assert.equal(after.score, mf.mergeScoreFor(base.current + 1));
  assert.equal(after.maxLevel, base.current + 1);
  assert.equal(after.maxChain, 1);
  assert.equal(after.board[idx(9, 0)], base.current + 1);
  assert.equal(after.board.filter((v) => v !== null).length, 1);
});

test("マージ: 天井まで埋まった列に落とすとゲームオーバーになる", () => {
  const base = mf.createMergeGame(3);
  const board = emptyBoard();
  // 列2を交互の段階で埋める（同段階の隣接を作らない）
  for (let r = 0; r < mf.MERGE_ROWS; r++) board[idx(r, 2)] = r % 2;
  assert.equal(mf.landingRow(board, 2), -1);
  const st = { ...base, board };
  const over = mf.dropFruit(st, 2);
  assert.equal(over.status, "gameover");
  assert.equal(over.dropped, 0);
  // ゲームオーバー後の操作は無効（同一参照）
  assert.equal(mf.dropFruit(over, 0), over);
  // 別の列にはまだ落とせる状態だったことの確認（満杯列以外は -1 でない）
  assert.ok(mf.landingRow(board, 0) >= 0);
});

// ---------------------------------------------------------------- ワードバスケット

const wbMod = wb.gameModule;

test("バスケット: 2〜6人以外は開始できず、お題は8件でプール内から選ばれる", () => {
  assert.throws(() => wbMod.createState(seats(1), makeRng(1), {}));
  assert.throws(() => wbMod.createState(seats(7), makeRng(1), {}));
  const st = wbMod.createState(seats(3), makeRng(2), {});
  assert.equal(st.phase, "prompt");
  assert.equal(st.prompts.length, wb.WB_TOTAL_ROUNDS);
  for (const p of st.prompts) {
    assert.ok(wb.WB_PROMPTS.some((x) => x.category === p.category && x.initial === p.initial));
  }
  // 締切前は tick しても同一参照
  assert.equal(wbMod.tick(st, st.promptEndsAt - 1), st);
});

test("バスケット: 得点式は 100 + 残り秒×5", () => {
  assert.equal(wb.wbScoreFor(wb.WB_TIME_LIMIT_MS), 200);
  assert.equal(wb.wbScoreFor(0), 100);
  assert.equal(wb.wbScoreFor(1999), 105);
  assert.equal(wb.wbScoreFor(-500), 100);
});

test("バスケット: 形式検証（頭文字・文字数・かなのみ・重複）", () => {
  const prompt = { category: "食べ物", initial: "あ" };
  assert.deepEqual(wb.validateBasketWord("あめ", prompt, []), { ok: true });
  // カタカナ始まりはひらがなの頭文字と一致扱い
  assert.deepEqual(wb.validateBasketWord("アイスクリーム", prompt, []), { ok: true });
  assert.equal(wb.validateBasketWord("あ", prompt, []).ok, false); // 1文字
  assert.equal(wb.validateBasketWord("かめ", prompt, []).ok, false); // 頭文字違い
  assert.equal(wb.validateBasketWord("飴あめ", prompt, []).ok, false); // 漢字混じり
  assert.equal(wb.validateBasketWord("abc", prompt, []).ok, false); // 英字
  assert.equal(wb.validateBasketWord("あめ", prompt, ["あめ"]).ok, false); // 重複
  assert.equal(wb.validateBasketWord("アメ", prompt, ["あめ"]).ok, false); // 表記違いでも重複
  assert.equal(wb.validateBasketWord(123, prompt, []).ok, false);
  assert.equal(wb.toHiragana("カタカナ"), "かたかな");
});

test("バスケット: 最初の採用だけが得点し、締切まで他人の単語は秘匿される", () => {
  let st = wbMod.createState(seats(2), makeRng(4), {});
  const initial = st.prompts[0].initial;
  const wordA = `${initial}あ`;
  const wordB = `${initial}き`;
  st = wbMod.applyAction(st, 0, { type: "submit", word: wordA }, makeRng(1));
  assert.equal(st.phase, "prompt"); // もう1人がまだ
  assert.equal(st.submissions.length, 1);
  assert.equal(st.submissions[0].first, true);
  assert.ok(st.submissions[0].gained >= 185); // ほぼ満額の速度ボーナス
  assert.equal(st.scores[0], st.submissions[0].gained);
  // 秘匿: 相手のビューに単語が含まれない（キー自体がない）
  const viewB = wbMod.viewFor(st, 1);
  assert.equal(viewB.players[0].answered, true);
  assert.equal("word" in viewB.players[0], false);
  assert.ok(!JSON.stringify(viewB).includes(wordA));
  // 自分のビューには自分の単語が見える
  assert.equal(wbMod.viewFor(st, 0).you.yourWord, wordA);
  // 2人目の採用は0点で、全員出したので即締切→開示
  st = wbMod.applyAction(st, 1, { type: "submit", word: wordB }, makeRng(1));
  assert.equal(st.phase, "reveal");
  assert.equal(st.scores[1], 0);
  const reveal = wbMod.viewFor(st, 1);
  assert.equal(reveal.players[0].word, wordA);
  assert.equal(reveal.players[0].first, true);
  assert.equal(reveal.players[1].word, wordB);
  // 同じラウンドで同じ単語は使えない
  let st2 = wbMod.createState(seats(2), makeRng(4), {});
  const ini2 = st2.prompts[0].initial;
  st2 = wbMod.applyAction(st2, 0, { type: "submit", word: `${ini2}あ` }, makeRng(1));
  const dup = wbMod.applyAction(st2, 1, { type: "submit", word: `${ini2}あ` }, makeRng(1));
  assert.equal(dup.submissions.length, 1); // 採用されずロックされる
  assert.ok(dup.lockedUntil[1] > Date.now());
});

test("バスケット: 形式違いはロックされ、理由は本人にだけ通知される", () => {
  let st = wbMod.createState(seats(2), makeRng(6), {});
  const initial = st.prompts[0].initial;
  const wrongInitial = initial === "あ" ? "か" : "あ";
  st = wbMod.applyAction(st, 0, { type: "submit", word: `${wrongInitial}あ` }, makeRng(1));
  assert.equal(st.submissions.length, 0);
  assert.ok(st.lockedUntil[0] >= Date.now() + wb.WB_LOCK_MS - 100);
  assert.ok(st.notices[0].reason.includes("で始まる"));
  // ロック中は正しい単語でも送れない
  assert.throws(() => wbMod.applyAction(st, 0, { type: "submit", word: `${initial}あ` }, makeRng(1)));
  // 通知は本人だけ（相手のビューには理由が届かない）
  assert.ok(wbMod.viewFor(st, 0).you.notice.includes("で始まる"));
  assert.equal(wbMod.viewFor(st, 1).you.notice, null);
  // すでに採用済みの人は再送できない／parseAction の検証
  assert.deepEqual(wbMod.parseAction({ type: "submit", word: "あめ" }), { type: "submit", word: "あめ" });
  assert.equal(wbMod.parseAction({ type: "submit", word: 5 }), null);
  assert.equal(wbMod.parseAction({ type: "submit", word: "" }), null);
  assert.equal(wbMod.parseAction({ type: "peek" }), null);
  assert.equal(wbMod.parseAction(null), null);
});

test("バスケット: 時間切れで締め切られ、全8ラウンド完走すると順位が付く", () => {
  let st = wbMod.createState(seats(2), makeRng(11), {});
  for (let guard = 0; guard < 100 && st.phase !== "finished"; guard++) {
    if (st.phase === "prompt") {
      const initial = st.prompts[st.index].initial;
      st = wbMod.applyAction(st, 0, { type: "submit", word: `${initial}あ` }, makeRng(1));
      st = wbMod.tick(st, st.promptEndsAt); // seat1 は無回答のまま締切
      assert.equal(st.phase, "reveal");
    } else if (st.phase === "reveal") {
      st = wbMod.tick(st, st.revealEndsAt);
    }
  }
  assert.equal(st.phase, "finished");
  assert.equal(st.history.length, wb.WB_TOTAL_ROUNDS);
  assert.ok(st.scores[0] > 0);
  assert.equal(st.scores[1], 0);
  const view = wbMod.viewFor(st, 1);
  assert.equal(view.standings.find((s) => s.seat === 0).rank, 1);
  assert.equal(view.standings.find((s) => s.seat === 1).rank, 2);
});

test("バスケット: 退出は脱落扱いだがスコアは順位に残り、残り全員の提出で締め切る", () => {
  let st = wbMod.createState(seats(3), makeRng(15), {});
  const initial = st.prompts[0].initial;
  st = wbMod.applyAction(st, 2, { type: "submit", word: `${initial}あ` }, makeRng(1));
  const kept = st.scores[2];
  assert.ok(kept > 0);
  st = wbMod.onPlayerLeft(st, 2);
  assert.ok(st.leftSeats.includes(2));
  assert.equal(st.phase, "prompt");
  // 残り2人が出せば締切（退出者は待たない）
  st = wbMod.applyAction(st, 0, { type: "submit", word: `${initial}き` }, makeRng(1));
  st = wbMod.applyAction(st, 1, { type: "submit", word: `${initial}く` }, makeRng(1));
  assert.equal(st.phase, "reveal");
  // 全員退出で終了し、退出者のスコアも順位表に残る
  st = wbMod.onPlayerLeft(st, 0);
  st = wbMod.onPlayerLeft(st, 1);
  assert.equal(st.phase, "finished");
  const view = wbMod.viewFor(st, 2);
  assert.equal(view.standings.find((s) => s.seat === 2).score, kept);
});

// ---------------------------------------------------------------- フラッグクイズ増量

test("フラッグ増量: バンクは195組で重複がなく、全ての国コードが ISO alpha-2 小文字", () => {
  assert.equal(fq.FLAG_PAIRS.length, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.code)).size, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, 195);
  for (const p of fq.FLAG_PAIRS) {
    assert.ok(/^[a-z]{2}$/.test(p.code), `${p.name} の国コード ${p.code}`);
    assert.ok(p.name.length > 0);
  }
});

test("フラッグ増量: 追加分の国名と国コード（ISO）が一致している", () => {
  const byName = new Map(fq.FLAG_PAIRS.map((p) => [p.name, p.code]));
  const added = [
    ["キューバ", "CU"],
    ["ジャマイカ", "JM"],
    ["ガーナ", "GH"],
    ["オマーン", "OM"],
    ["キルギス", "KG"],
    ["フィジー", "FJ"],
    ["マルタ", "MT"],
    ["北マケドニア", "MK"],
    ["セルビア", "RS"],
    ["ジョージア", "GE"],
    ["モザンビーク", "MZ"],
    ["ボスニア・ヘルツェゴビナ", "BA"],
  ];
  for (const [name, iso] of added) {
    assert.equal(byName.get(name), iso.toLowerCase(), `${name} の国コードが ISO ${iso} と一致すること`);
  }
  // 増量後も出題が成立する（選択肢は全てバンク内）
  const game = fq.createFlagQuizGame(7);
  assert.equal(game.questions.length, fq.FLAG_QUIZ_QUESTION_COUNT);
  for (const q of game.questions) {
    assert.equal(q.choices.length, 4);
    assert.ok(q.choices.every((i) => i >= 0 && i < fq.FLAG_PAIRS.length));
    assert.equal(q.choices[q.answerPos], q.target);
  }
});
