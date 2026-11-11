// A16フェーズの新規4本のロジック検証。
// - lib/samegame.ts: グループ除去・落下と左詰め・終了ボーナス
// - lib/tents.ts: 解先行生成の可解性・ルール検証・完全マッチング
// - lib/online/games/hagetaka.ts: 入札決着・同値無効と持ち越し・秘匿ビュー
// - lib/online/games/burst.ts: 配置規則・ペナルティ計算・強制引き取りの選択待ち
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

async function loadOnline(name, exports) {
  const src = fs.readFileSync(path.join(libDir, "online", "games", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { ${exports} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const sg = await loadLib("samegame.ts");
const tn = await loadLib("tents.ts");
const hg = await loadOnline("hagetaka.ts", "gameModule, hagetakaTaker, HG_PRIZE_VALUES, HG_TOTAL_ROUNDS");
const bu = await loadOnline("burst.ts", "gameModule, burstValue, burstTargetRow, burstRowPenalty, burstAutoRow");

function rngFrom(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `P${i + 1}` }));

// ---------------------------------------------------------------- セイムゲーム

test("セイムゲーム: 生成は決定的で盤面が色で埋まっている", () => {
  const a = sg.createSameGame(42);
  const b = sg.createSameGame(42);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.cells.length, sg.SG_COLS * sg.SG_ROWS);
  assert.ok(a.cells.every((c) => c !== null && c >= 0 && c < 5));
  assert.equal(a.status, "playing");
});

test("セイムゲーム: グループ除去で落ちて左詰めになりスコアが入る", () => {
  // 手組みの盤面: 左2列が同色（縦に2つ）、他は交互で単独になる色配置
  const cols = sg.SG_COLS;
  const rows = sg.SG_ROWS;
  const cells = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells[r * cols + c] = (r + c) % 2 === 0 ? 1 : 2;
    }
  }
  cells[9 * cols + 0] = 0; // 左下
  cells[8 * cols + 0] = 0; // その上 → 縦に2つつながる
  const base = { ...sg.createSameGame(1), cells, status: "playing", score: 0 };
  // 0 のグループは2個だけのはず（斜めはつながらない）
  const group = sg.sameGameGroupAt(base, 9 * cols + 0);
  assert.equal(group.length, 2);
  const after = sg.removeSameGameGroup(base, 9 * cols + 0);
  assert.equal(after.score, 2); // 2×1
  assert.equal(after.removed, 2);
  // 落下: 左列の一番下は、元はその上にあった色 (8行目の次=7行目... 落ちて下2つがずれる)
  // 消えた2マスの分、列0の残りは下詰めになる: 最下段は元の7行目の値
  assert.equal(after.cells[9 * cols + 0], cells[7 * cols + 0]);
  assert.equal(after.cells[8 * cols + 0], cells[6 * cols + 0]);
  assert.equal(after.cells[0 * cols + 0], null);
  assert.equal(after.cells[1 * cols + 0], null);
});

test("セイムゲーム: 1個だけのマスは消せない／空列は左詰めされる", () => {
  const cols = sg.SG_COLS;
  const rows = sg.SG_ROWS;
  const cells = new Array(cols * rows).fill(null);
  // 1列目だけ全部同色、他は空 → 消すと全列が空になり終了する特殊ケースを避け、
  // 2列目に残りを置く
  for (let r = 0; r < rows; r++) {
    cells[r * cols + 0] = 3;
    cells[r * cols + 1] = r % 2 === 0 ? 0 : 1;
  }
  const base = { ...sg.createSameGame(1), cells, status: "playing", score: 0 };
  // 単独マス（列1の最下段は周囲が空か異色）は消せない → チェス盤状の列1は斜めのみ同色
  const single = sg.removeSameGameGroup(base, 9 * cols + 1);
  assert.equal(single, base);
  // 列0の10個グループを消すと列1が左へ詰まる
  const after = sg.removeSameGameGroup(base, 0);
  assert.equal(after.score, 10 * 9);
  for (let r = 0; r < rows; r++) {
    assert.equal(after.cells[r * cols + 0], cells[r * cols + 1]);
    assert.equal(after.cells[r * cols + 1], null);
  }
});

test("セイムゲーム: 消せるグループが無くなると終了しボーナスが入る", () => {
  const cols = sg.SG_COLS;
  const rows = sg.SG_ROWS;
  const cells = new Array(cols * rows).fill(null);
  // チェス盤模様（同色は斜めのみ）= 消せるグループなし
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells[r * cols + c] = (r + c) % 2;
  }
  // 1ペアだけ作る: これを消すと残りは全部単独 → 終了
  cells[0] = 4;
  cells[1] = 4;
  const base = { ...sg.createSameGame(1), cells, status: "playing", score: 0, bonus: 0 };
  const after = sg.removeSameGameGroup(base, 0);
  assert.equal(after.status, "finished");
  assert.equal(sg.sameGameRemaining(after), cols * rows - 2);
  // 残りが多いのでボーナスは0
  assert.equal(after.bonus, Math.max(0, 10 - (cols * rows - 2)) * 10);
  assert.equal(after.score, 2 + after.bonus);
  // 終了ボーナス式の確認（残り0→1000、残り3→70）
  assert.equal(sg.sameGameEndBonus(0), 1000);
  assert.equal(sg.sameGameEndBonus(3), 70);
});

// ---------------------------------------------------------------- テントと木

test("テントと木: 生成した問題は正解の配置で完成になる（可解性）", () => {
  for (const size of [6, 8]) {
    for (const seed of [1, 7, 42, 1234]) {
      const s = tn.createTentsGame(size, seed);
      assert.equal(s.trees.filter(Boolean).length, tn.tentsCountFor(size));
      assert.equal(s.solution.filter(Boolean).length, tn.tentsCountFor(size));
      // 行列カウントは正解と一致
      for (let r = 0; r < size; r++) {
        let n = 0;
        for (let c = 0; c < size; c++) if (s.solution[r * size + c]) n++;
        assert.equal(s.rowCounts[r], n);
      }
      for (let c = 0; c < size; c++) {
        let n = 0;
        for (let r = 0; r < size; r++) if (s.solution[r * size + c]) n++;
        assert.equal(s.colCounts[c], n);
      }
      // 正解のテント同士は隣接していない
      for (let i = 0; i < s.solution.length; i++) {
        if (!s.solution[i]) continue;
        const r = Math.floor(i / size);
        const c = i % size;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= size || nc >= size || (dr === 0 && dc === 0)) continue;
            assert.equal(s.solution[nr * size + nc], false, `seed=${seed} size=${size} 隣接テント`);
          }
        }
      }
      // 正解をマークとして置くと完成する
      const solved = { ...s, marks: s.solution.map((t) => (t ? 1 : 2)) };
      assert.equal(tn.isTentsComplete(solved), true, `seed=${seed} size=${size}`);
      assert.equal(tn.tentsViolations({ ...solved, status: "playing" }).length, 0);
    }
  }
});

test("テントと木: 生成は決定的で、木のマスはタップできない", () => {
  const a = tn.createTentsGame(6, 99);
  const b = tn.createTentsGame(6, 99);
  assert.deepEqual(a.trees, b.trees);
  assert.deepEqual(a.solution, b.solution);
  const treeIdx = a.trees.findIndex(Boolean);
  assert.equal(tn.cycleTentsMark(a, treeIdx), a);
  // 空きマスは 未定→テント→草→未定 と回る
  const emptyIdx = a.trees.findIndex((t, i) => !t && !a.solution[i]);
  const s1 = tn.cycleTentsMark(a, emptyIdx);
  assert.equal(s1.marks[emptyIdx], 1);
  const s2 = tn.cycleTentsMark(s1, emptyIdx);
  assert.equal(s2.marks[emptyIdx], 2);
  const s3 = tn.cycleTentsMark(s2, emptyIdx);
  assert.equal(s3.marks[emptyIdx], 0);
});

test("テントと木: 隣接テントと行オーバーが違反として検出される", () => {
  const s = tn.createTentsGame(6, 5);
  // 木でない隣り合う2マスにテントを置く
  let idxA = -1;
  let idxB = -1;
  outer: for (let i = 0; i < s.trees.length - 1; i++) {
    if (!s.trees[i] && !s.trees[i + 1] && i % 6 !== 5) {
      idxA = i;
      idxB = i + 1;
      break outer;
    }
  }
  assert.ok(idxA >= 0);
  const marks = [...s.marks];
  marks[idxA] = 1;
  marks[idxB] = 1;
  const marked = { ...s, marks };
  const violations = tn.tentsViolations(marked);
  assert.ok(violations.some((v) => v.type === "tentAdjacent"));
  assert.equal(tn.isTentsComplete(marked), false);
  // 行カウントを超える配置でも rowOver が出る行がある（どこかの行で上限超過）
  const full = {
    ...s,
    marks: s.trees.map((t) => (t ? 0 : 1)),
  };
  assert.ok(tn.tentsViolations(full).some((v) => v.type === "rowOver" || v.type === "tentAdjacent"));
});

// ---------------------------------------------------------------- ハゲタカ

test("ハゲタカ: 決着ルール（最高値が取る／マイナスは最低値／同値は無効）", () => {
  const bids = (arr) => arr.map(([seat, card]) => ({ seat, card }));
  // プラス: 最高値の単独者が取る
  assert.equal(hg.hagetakaTaker(bids([[1, 5], [2, 9], [3, 3]]), 7), 2);
  // 最高値が同値で潰れたら次の数字が繰り上がる
  assert.equal(hg.hagetakaTaker(bids([[1, 9], [2, 9], [3, 3]]), 7), 3);
  // マイナス: 最低値の単独者が引き取る
  assert.equal(hg.hagetakaTaker(bids([[1, 5], [2, 2], [3, 3]]), -4), 2);
  // マイナスで最低値が潰れたら次の小さい数字
  assert.equal(hg.hagetakaTaker(bids([[1, 2], [2, 2], [3, 5]]), -4), 3);
  // 全員同値なら決着なし（持ち越し）
  assert.equal(hg.hagetakaTaker(bids([[1, 7], [2, 7]]), 5), null);
  // 合計0は最高値扱い
  assert.equal(hg.hagetakaTaker(bids([[1, 4], [2, 8]]), 0), 2);
});

test("ハゲタカ: 全員提出で締め切り、入札は締切まで秘匿される", () => {
  const mod = hg.gameModule;
  let s = mod.createState(seats(3), rngFrom(11), {});
  assert.equal(s.table.length, 1);
  assert.ok(hg.HG_PRIZE_VALUES.includes(s.table[0]));
  assert.deepEqual([...s.prizeDeck].sort((a, b) => a - b), [...hg.HG_PRIZE_VALUES].sort((a, b) => a - b));
  // 2人だけ出す
  s = mod.applyAction(s, 1, { type: "bid", card: 15 }, rngFrom(1));
  s = mod.applyAction(s, 2, { type: "bid", card: 15 }, rngFrom(1));
  assert.equal(s.phase, "bidding");
  // 秘匿: 他人のビューに入札カードの値が含まれない（submitted だけ）
  const view3 = mod.viewFor(s, 3);
  assert.equal(view3.players.find((p) => p.seat === 1).submitted, true);
  assert.ok(view3.players.every((p) => !("card" in p)));
  assert.equal(view3.you.yourCard, null);
  const view1 = mod.viewFor(s, 1);
  assert.equal(view1.you.yourCard, 15);
  // 3人目が出すと締切: 15同士は無効、残った3人目の単独入札が取る（符号によらず候補は1人）
  s = mod.applyAction(s, 3, { type: "bid", card: 4 }, rngFrom(1));
  const last = s.history[s.history.length - 1];
  assert.equal(last.taker, 3);
  assert.equal(s.scores[3], last.prizeTotal);
  assert.equal(s.round, 1);
  // 出したカードは捨てられている
  assert.equal(s.hands[1].includes(15), false);
  assert.equal(s.hands[3].includes(4), false);
  assert.equal(s.hands[1].length, 14);
});

test("ハゲタカ: 全員同値だと得点カードが次ラウンドへ持ち越される", () => {
  const mod = hg.gameModule;
  let s = mod.createState(seats(2), rngFrom(3), {});
  const firstPrize = s.table[0];
  s = mod.applyAction(s, 1, { type: "bid", card: 8 }, rngFrom(1));
  s = mod.applyAction(s, 2, { type: "bid", card: 8 }, rngFrom(1));
  const last = s.history[s.history.length - 1];
  assert.equal(last.carried, true);
  assert.equal(last.taker, null);
  // 次ラウンドの場には持ち越し分＋新しいカード
  assert.equal(s.table.length, 2);
  assert.ok(s.table.includes(firstPrize));
  assert.equal(s.scores[1], 0);
  assert.equal(s.scores[2], 0);
});

test("ハゲタカ: 15ラウンド完走すると順位が付き、合計得点と山が一致する", () => {
  const mod = hg.gameModule;
  let s = mod.createState(seats(4), rngFrom(77), {});
  const rng = rngFrom(5);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 200) {
    for (const p of s.players) {
      if (s.phase !== "bidding") break;
      if (s.bids.some((b) => b.seat === p.seat)) continue;
      const hand = s.hands[p.seat];
      const card = hand[Math.floor(rng() * hand.length)];
      s = mod.applyAction(s, p.seat, { type: "bid", card }, rng);
    }
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.history.length, hg.HG_TOTAL_ROUNDS);
  // 得点の総和 = 破棄されなかった得点カードの合計（持ち越し破棄分を除く全カード）
  const discarded = s.history
    .filter((h) => h.taker === null && !h.carried)
    .reduce((sum, h) => sum + h.prizeTotal, 0);
  const totalScore = Object.values(s.scores).reduce((a, b) => a + b, 0);
  const allPrizes = hg.HG_PRIZE_VALUES.reduce((a, b) => a + b, 0);
  assert.equal(totalScore, allPrizes - discarded);
  // 全員の手札は尽きている
  for (const p of s.players) assert.equal(s.hands[p.seat].length, 0);
  const view = mod.viewFor(s, 1);
  assert.ok(view.standings !== null && view.standings.length === 4);
  assert.equal(view.standings.filter((x) => x.rank === 1).length >= 1, true);
  // parseAction の検証
  assert.deepEqual(mod.parseAction({ type: "bid", card: 3 }), { type: "bid", card: 3 });
  assert.equal(mod.parseAction({ type: "bid", card: 16 }), null);
  assert.equal(mod.parseAction({ type: "bid" }), null);
  assert.equal(mod.parseAction("bid"), null);
});

test("ハゲタカ: 退出者は未提出扱いになり、残り全員の提出で締め切る", () => {
  const mod = hg.gameModule;
  let s = mod.createState(seats(3), rngFrom(9), {});
  s = mod.applyAction(s, 1, { type: "bid", card: 10 }, rngFrom(1));
  s = mod.applyAction(s, 2, { type: "bid", card: 6 }, rngFrom(1));
  s = mod.onPlayerLeft(s, 1);
  // seat1 の入札は無効化され、seat2 と seat3 の提出で締まる状態
  assert.equal(s.bids.length, 1);
  s = mod.applyAction(s, 3, { type: "bid", card: 7 }, rngFrom(1));
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].bids.find((b) => b.seat === 1).card, null);
});

// ---------------------------------------------------------------- バースト

test("バースト: バースト値の規則", () => {
  assert.equal(bu.burstValue(55), 7);
  assert.equal(bu.burstValue(11), 5);
  assert.equal(bu.burstValue(22), 5);
  assert.equal(bu.burstValue(99), 5);
  assert.equal(bu.burstValue(10), 3);
  assert.equal(bu.burstValue(100), 3);
  assert.equal(bu.burstValue(5), 2);
  assert.equal(bu.burstValue(95), 2);
  assert.equal(bu.burstValue(1), 1);
  assert.equal(bu.burstValue(104), 1);
  assert.equal(bu.burstValue(66), 5); // 11の倍数が優先（6の倍数でもあるが5点）
  assert.equal(bu.burstRowPenalty([55, 10, 3]), 7 + 3 + 1);
});

test("バースト: 配置先の列の決定（最も近い小さい末尾）", () => {
  const rows = [[10, 20], [5], [30, 40, 50], [90]];
  assert.equal(bu.burstTargetRow(rows, 25), 0); // 20 が最大の「自分より小さい末尾」
  assert.equal(bu.burstTargetRow(rows, 55), 2); // 50
  assert.equal(bu.burstTargetRow(rows, 95), 3); // 90
  assert.equal(bu.burstTargetRow(rows, 3), -1); // どの列にも置けない
  assert.equal(bu.burstAutoRow([[55], [1, 2], [10], [3]]), 3); // ペナルティ最小は [3]=1点… [1,2]も2点、[10]は3点、[55]は7点
});

test("バースト: 配布と秘匿ビュー（他人の手札が見えない）", () => {
  const mod = bu.gameModule;
  const s = mod.createState(seats(3), rngFrom(21), {});
  assert.equal(s.rows.length, 4);
  assert.ok(s.rows.every((r) => r.length === 1));
  for (const p of s.players) assert.equal(s.hands[p.seat].length, 10);
  const allCards = [
    ...Object.values(s.hands).flat(),
    ...s.rows.flat(),
  ];
  assert.equal(new Set(allCards).size, allCards.length);
  assert.ok(allCards.every((c) => c >= 1 && c <= 104));
  const view1 = mod.viewFor(s, 1);
  assert.equal(view1.you.hand.length, 10);
  assert.deepEqual(view1.you.hand, s.hands[1]);
  // 他人のビューに seat1 の手札の配列が含まれていないこと
  const view2 = mod.viewFor(s, 2);
  assert.equal(JSON.stringify(view2).includes(JSON.stringify(s.hands[1])), false);
  assert.equal(view2.players.find((p) => p.seat === 1).handCount, 10);
});

test("バースト: 6枚目で列を引き取り、ペナルティが加算される", () => {
  const mod = bu.gameModule;
  // 手組みの状態: 列0 は5枚で末尾 50。seat1 が 60 を出すと引き取りになる。
  const base = mod.createState(seats(2), rngFrom(4), {});
  const crafted = {
    ...base,
    rows: [[10, 20, 30, 40, 50], [70], [80], [90]],
    hands: { 1: [60, 100], 2: [65, 101] },
    plays: [],
    queue: [],
    pending: null,
    roundEndsAt: Date.now() + 30000,
  };
  let s = mod.applyAction(crafted, 1, { type: "play", card: 60 }, rngFrom(1));
  s = mod.applyAction(s, 2, { type: "play", card: 65 }, rngFrom(1));
  // 60 の処理: 列0（5枚）を引き取り [10,20,30,40,50] のペナルティ = 3×5 = 15（全部10の倍数）
  assert.equal(s.penalties[1], 15);
  assert.deepEqual(s.rows[0], [60, 65]); // 続いて 65 は 60 の後ろへ
  assert.equal(s.round, 1);
  assert.equal(s.history.length, 1);
  const step = s.history[0].steps.find((x) => x.seat === 1);
  assert.deepEqual(step.took, [10, 20, 30, 40, 50]);
  assert.equal(step.tookPenalty, 15);
});

test("バースト: どの列にも置けないカードは列の選択待ちになり、選ぶと処理が進む", () => {
  const mod = bu.gameModule;
  const base = mod.createState(seats(2), rngFrom(4), {});
  const crafted = {
    ...base,
    rows: [[50], [60], [70], [80]],
    hands: { 1: [5, 100], 2: [55, 101] },
    plays: [],
    queue: [],
    pending: null,
    roundEndsAt: Date.now() + 30000,
  };
  let s = mod.applyAction(crafted, 1, { type: "play", card: 5 }, rngFrom(1));
  s = mod.applyAction(s, 2, { type: "play", card: 55 }, rngFrom(1));
  // 小さい順: 5 は置き場がなく選択待ちになる
  assert.equal(s.phase, "choosing");
  assert.equal(s.pending.seat, 1);
  assert.equal(s.pending.card, 5);
  // 秘匿: 選択待ちのカードは本人にだけ pendingCard として届く
  assert.equal(mod.viewFor(s, 1).you.pendingCard, 5);
  assert.equal(mod.viewFor(s, 2).you.pendingCard, null);
  // 違う人が選ぶことはできない
  assert.throws(() => mod.applyAction(s, 2, { type: "takeRow", row: 0 }, rngFrom(1)));
  // 列2（[70]）を選んで引き取る: 70 は10の倍数 → 3点
  s = mod.applyAction(s, 1, { type: "takeRow", row: 2 }, rngFrom(1));
  assert.equal(s.penalties[1], 3);
  assert.deepEqual(s.rows[2], [5]);
  // 続いて 55 は、末尾が自分より小さい列（50 と 5）のうち末尾が大きい列0の後ろへ
  assert.deepEqual(s.rows[0], [50, 55]);
  assert.equal(s.phase, "selecting");
  assert.equal(s.round, 1);
});

test("バースト: tick の制限時間で未提出者は最小の手札が自動提出される", () => {
  const mod = bu.gameModule;
  const base = mod.createState(seats(2), rngFrom(4), {});
  const crafted = {
    ...base,
    rows: [[50], [60], [70], [80]],
    hands: { 1: [3, 100], 2: [90, 101] },
    plays: [{ seat: 2, card: 90 }],
    roundEndsAt: 1000,
  };
  // seat2 は手札から 90 が抜けている状態にする
  crafted.hands = { 1: [3, 100], 2: [101] };
  const s = mod.tick(crafted, 2000);
  // seat1 の最小カード 3 が自動提出され、置き場がないため選択待ち（自動選択は choosing の tick）
  assert.equal(s.phase, "choosing");
  assert.equal(s.pending.card, 3);
  // choosing の制限時間を過ぎると自動で最小ペナルティの列を取る
  const s2 = mod.tick(s, (s.chooseEndsAt ?? 0) + 1);
  assert.equal(s2.phase, "selecting");
  assert.equal(s2.round, 1);
});

test("バースト: 完走するとペナルティ最少が1位になり順位が付く／parseAction", () => {
  const mod = bu.gameModule;
  let s = mod.createState(seats(3), rngFrom(31), {});
  const rng = rngFrom(8);
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 300) {
    if (s.phase === "choosing" && s.pending) {
      s = mod.applyAction(s, s.pending.seat, { type: "takeRow", row: Math.floor(rng() * 4) }, rng);
      continue;
    }
    if (s.phase === "selecting") {
      for (const p of s.players) {
        if (s.phase !== "selecting") break;
        if (s.plays.some((pl) => pl.seat === p.seat)) continue;
        const hand = s.hands[p.seat];
        if (!hand || hand.length === 0) continue;
        const card = hand[Math.floor(rng() * hand.length)];
        s = mod.applyAction(s, p.seat, { type: "play", card }, rng);
      }
      continue;
    }
    break;
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.history.length, 10);
  for (const p of s.players) assert.equal(s.hands[p.seat].length, 0);
  const view = mod.viewFor(s, 1);
  assert.ok(view.standings !== null && view.standings.length === 3);
  const minPenalty = Math.min(...Object.values(s.penalties));
  assert.ok(view.standings.some((x) => x.rank === 1 && x.penalty === minPenalty));
  assert.deepEqual(mod.parseAction({ type: "play", card: 42 }), { type: "play", card: 42 });
  assert.equal(mod.parseAction({ type: "play", card: 105 }), null);
  assert.deepEqual(mod.parseAction({ type: "takeRow", row: 2 }), { type: "takeRow", row: 2 });
  assert.equal(mod.parseAction({ type: "takeRow", row: 4 }), null);
  assert.equal(mod.parseAction(null), null);
});
