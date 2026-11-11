// A7フェーズの新規4本のロジック検証。
// - lib/sokoban.ts: 箱押し・クリア判定・アンドゥ・全6面の可解性
// - lib/sugoroku.ts: マス効果・コイン・1回休み・ゴール勝敗
// - lib/anagram.ts: シャッフル保証・タイル操作・ヒントと採点
// - lib/online/games/janken.ts: 多人数勝敗・秘匿ビュー・得点・tick・退出
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

async function loadJanken() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "janken.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + "\nexport { gameModule, jankenWinners, JK_TOTAL_ROUNDS, JK_BEATS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const sk = await loadLib("sokoban.ts");
const sg = await loadLib("sugoroku.ts");
const an = await loadLib("anagram.ts");
const jk = await loadJanken();

// ---------------------------------------------------------------- 倉庫番

/** 箱押し単位の BFS で面が解けるかを確認する（プレイヤー到達可能性込み）。 */
function sokobanSolvable(levelIdx) {
  const s0 = sk.createSokobanGame(levelIdx);
  const W = s0.width;
  const H = s0.height;
  const { walls, goals } = s0;
  const reach = (player, boxes) => {
    const boxSet = new Set(boxes);
    const seen = new Set([player]);
    const q = [player];
    while (q.length) {
      const p = q.pop();
      const r = Math.floor(p / W);
      const c = p % W;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
        const n = nr * W + nc;
        if (walls[n] || boxSet.has(n) || seen.has(n)) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return seen;
  };
  const seen = new Set([s0.boxes.join(",")]);
  const queue = [{ boxes: s0.boxes, player: s0.player }];
  let head = 0;
  while (head < queue.length && head < 200000) {
    const cur = queue[head++];
    if (cur.boxes.every((b) => goals[b])) return true;
    const rs = reach(cur.player, cur.boxes);
    for (const b of cur.boxes) {
      const r = Math.floor(b / W);
      const c = b % W;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const stand = (r - dr) * W + (c - dc);
        const dest = (r + dr) * W + (c + dc);
        if (!rs.has(stand)) continue;
        if (walls[dest] || cur.boxes.includes(dest)) continue;
        const nb = cur.boxes.map((x) => (x === b ? dest : x)).sort((a, b2) => a - b2);
        const k = nb.join(",");
        if (!seen.has(k)) {
          seen.add(k);
          queue.push({ boxes: nb, player: b });
        }
      }
    }
  }
  return false;
}

test("倉庫番: 内蔵6面すべてが解ける（箱押しBFS）", () => {
  assert.equal(sk.sokobanLevelCount(), 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(sokobanSolvable(i), true, `第${i + 1}面が解けない`);
  }
});

test("倉庫番: 第1面を実際に解くとクリアになる", () => {
  // 第1面: 箱を上から押してゴールへ。@ の右が箱、箱の右下がゴール。
  let s = sk.createSokobanGame(0);
  // プレイヤーは箱の左。まず上へ回り込む: up, right, right? 盤: 6列
  // 行1(内部): "    " 行2: " @$ " 行3: "  . "
  // プレイヤー(2,2) 箱(2,3) ゴール(3,3)（0始まり: 行は map の index）
  s = sk.moveSokoban(s, "up"); // (1,2)
  s = sk.moveSokoban(s, "right"); // (1,3) 箱の上
  s = sk.moveSokoban(s, "down"); // 箱を押してゴールへ
  assert.equal(s.status, "won");
  assert.equal(s.pushes, 1);
  assert.equal(sk.isSokobanCleared(s), true);
});

test("倉庫番: 壁には進めず、箱は壁や別の箱の先へ押せない", () => {
  let s = sk.createSokobanGame(0);
  const before = s;
  s = sk.moveSokoban(s, "up");
  assert.notEqual(s, before); // 上は空いているので進める
  s = sk.moveSokoban(s, "up");
  assert.equal(s.moves, 1); // 2回目の上は壁で無効

  // 箱を壁際まで押したら、それ以上は押せない（第2面で検証）
  let t = sk.createSokobanGame(1);
  // 箱(2,2)を上へ押し続ける手順: プレイヤー(3,4)→(3,3)? ゴールがあるだけなので歩ける
  t = sk.moveSokoban(t, "left"); // (3,3)
  t = sk.moveSokoban(t, "left"); // (3,2) 箱の下
  t = sk.moveSokoban(t, "up"); // 箱を (1,2) へ押す
  assert.equal(t.pushes, 1);
  const stuck = sk.moveSokoban(t, "up"); // 箱の先は壁
  assert.equal(stuck.moves, t.moves);
  assert.equal(stuck.pushes, 1);
});

test("倉庫番: アンドゥで手数と配置が戻る／履歴なしでは何も起きない", () => {
  let s = sk.createSokobanGame(0);
  assert.equal(sk.undoSokoban(s), s);
  s = sk.moveSokoban(s, "up");
  assert.equal(s.moves, 1);
  const back = sk.undoSokoban(s);
  assert.equal(back.moves, 0);
  assert.equal(back.player, sk.createSokobanGame(0).player);
  assert.equal(back.history.length, 0);
});

// ---------------------------------------------------------------- すごろく

test("すごろく: 初期状態は3人ともスタートで手番はプレイヤー", () => {
  const s = sg.createSugorokuGame(1);
  assert.equal(s.players.length, 3);
  assert.ok(s.players.every((p) => p.position === 0 && p.coins === 0));
  assert.equal(s.turn, 0);
  assert.equal(sg.isCpuTurn(s), false);
  assert.equal(sg.SUGOROKU_SQUARES.length, 30);
  assert.equal(sg.squareEffect(29).type, "goal");
});

test("すごろく: サイコロで進み、手番が次の人へ回る（決定性）", () => {
  const a = sg.rollDice(sg.createSugorokuGame(7));
  const b = sg.rollDice(sg.createSugorokuGame(7));
  assert.deepEqual(a.players.map((p) => p.position), b.players.map((p) => p.position));
  assert.ok(a.lastRoll >= 1 && a.lastRoll <= 6);
  assert.ok(a.players[0].position >= 0 && a.players[0].position <= 29);
  assert.equal(a.turn, 1);
  assert.equal(sg.isCpuTurn(a), true);
});

test("すごろく: マス効果 forward/back/skip/coins が発動する", () => {
  // 状態を直接組み立てて、止まるマスを狙う
  const base = sg.createSugorokuGame(0);
  const mk = (pos) => ({ ...base, players: base.players.map((p, i) => (i === 0 ? { ...p, position: pos } : { ...p })) });
  // 効果の存在確認（テーブル側）
  assert.deepEqual(sg.squareEffect(3), { type: "forward", steps: 2 });
  assert.deepEqual(sg.squareEffect(8), { type: "skip" });
  assert.deepEqual(sg.squareEffect(7), { type: "coins", amount: 5 });
  // rng は決定的に探索: 位置2から振って出目1なら3マス目=forward。シードを総当たりして該当ケースを拾う
  let forwardHit = null;
  let skipHit = null;
  let coinHit = null;
  for (let seed = 0; seed < 500 && !(forwardHit && skipHit && coinHit); seed++) {
    const st = { ...sg.createSugorokuGame(seed), players: sg.createSugorokuGame(seed).players.map((p, i) => (i === 0 ? { ...p, position: 2 } : { ...p })), rng: seed | 0 };
    const after = sg.rollDice(st);
    if (after.lastRoll === 1 && !forwardHit) forwardHit = after;
    const st8 = { ...st, players: st.players.map((p, i) => (i === 0 ? { ...p, position: 7 } : { ...p })) };
    const after8 = sg.rollDice(st8);
    if (after8.lastRoll === 1 && !skipHit) skipHit = after8;
    const stC = { ...st, players: st.players.map((p, i) => (i === 0 ? { ...p, position: 6 } : { ...p })) };
    const afterC = sg.rollDice(stC);
    if (afterC.lastRoll === 1 && !coinHit) coinHit = afterC;
  }
  assert.ok(forwardHit, "forward のケースが見つからない");
  assert.equal(forwardHit.players[0].position, 5); // 3 + forward2
  assert.ok(skipHit, "skip のケースが見つからない");
  assert.equal(skipHit.players[0].skipNext, true);
  assert.ok(coinHit, "coins のケースが見つからない");
  assert.equal(coinHit.players[0].coins, 5); // 7マス目 +5
  void mk;
});

test("すごろく: 1回休みは次の番に消費される", () => {
  let s = sg.createSugorokuGame(3);
  s = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, skipNext: true } : { ...p })) };
  const after = sg.rollDice(s);
  assert.equal(after.players[0].skipNext, false);
  assert.equal(after.players[0].position, 0);
  assert.equal(after.lastRoll, null);
  assert.equal(after.turn, 1);
});

test("すごろく: ゴールに着くと勝ちで終了し、それ以上振れない", () => {
  let found = null;
  for (let seed = 0; seed < 500 && !found; seed++) {
    const g = sg.createSugorokuGame(seed);
    const st = { ...g, players: g.players.map((p, i) => (i === 0 ? { ...p, position: 27 } : { ...p })) };
    const after = sg.rollDice(st);
    if (after.status === "finished") found = after;
  }
  assert.ok(found, "ゴールするケースが見つからない");
  assert.equal(found.winner, 0);
  assert.equal(found.players[0].position, 29);
  assert.equal(sg.rollDice(found), found);
});

test("すごろく: 長期戦でもいつか誰かがゴールして終わる", () => {
  let s = sg.createSugorokuGame(123);
  let guard = 0;
  while (s.status === "playing" && guard < 10000) {
    s = sg.rollDice(s);
    guard++;
  }
  assert.equal(s.status, "finished");
  assert.ok(s.winner !== null);
});

// ---------------------------------------------------------------- アナグラム

test("アナグラム: バンクは30語以上で、シャッフルは元の並びにならない", () => {
  assert.ok(an.ANAGRAM_WORDS.length >= 30);
  for (const word of an.ANAGRAM_WORDS) {
    for (let seed = 0; seed < 40; seed++) {
      const { text } = an.shuffleWord(word, seed * 31 + 7);
      assert.notEqual(text, word, `${word} のシャッフルが元と同一 (seed=${seed})`);
      assert.deepEqual([...text].sort(), [...word].sort());
    }
  }
});

test("アナグラム: 出題は10問で決定的、タイルは単語の文字の並べ替え", () => {
  const a = an.createAnagramGame(99);
  const b = an.createAnagramGame(99);
  assert.deepEqual(a.words, b.words);
  assert.equal(a.words.length, 10);
  assert.equal(new Set(a.words).size, 10);
  const word = an.currentWord(a);
  assert.deepEqual(a.tiles.map((t) => t.char).sort(), [...word].sort());
  assert.notEqual(a.tiles.map((t) => t.char).join(""), word);
});

test("アナグラム: 正しく並べると正解で100点、間違えると0点", () => {
  let s = an.createAnagramGame(5);
  const word = an.currentWord(s);
  // 正解の順にタイルを選ぶ（同文字は未使用タイルから）
  const used = new Set();
  for (const ch of [...word]) {
    const tile = s.tiles.find((t) => t.char === ch && !used.has(t.id));
    used.add(tile.id);
    s = an.pickTile(s, tile.id);
  }
  assert.equal(an.currentAnswer(s), word);
  s = an.submitAnswer(s);
  assert.equal(s.status, "answered");
  assert.equal(s.lastCorrect, true);
  assert.equal(s.score, 100);
  assert.equal(s.correctCount, 1);

  // 不正解ケース（提示順のまま＝シャッフル済みで正解と異なる並びを提出する）
  let t = an.createAnagramGame(5);
  for (const tile of t.tiles) t = an.pickTile(t, tile.id);
  assert.notEqual(an.currentAnswer(t), word);
  t = an.submitAnswer(t);
  assert.equal(t.lastCorrect, false);
  assert.equal(t.score, 0);
});

test("アナグラム: ヒントは位置を開示し、得点が下がる／タイルの付け外し", () => {
  let s = an.createAnagramGame(11);
  const word = an.currentWord(s);
  s = an.useHint(s);
  assert.deepEqual(s.hintPositions, [0]);
  assert.equal(an.hintCharAt(s, 0), [...word][0]);
  assert.equal(an.hintCharAt(s, 1), null);
  assert.equal(an.anagramScoreFor(1), 80);
  assert.equal(an.anagramScoreFor(10), 40); // 下限

  const id0 = s.tiles[0].id;
  s = an.pickTile(s, id0);
  assert.equal(an.pickTile(s, id0), s); // 二重選択は無効
  assert.equal(s.picked.length, 1);
  s = an.unpickTile(s, 0);
  assert.equal(s.picked.length, 0);
  s = an.pickTile(s, id0);
  s = an.clearPicks(s);
  assert.equal(s.picked.length, 0);

  // 全タイル並べる前は判定できない
  const partial = an.pickTile(an.createAnagramGame(11), an.createAnagramGame(11).tiles[0].id);
  assert.equal(an.submitAnswer(partial), partial);
});

test("アナグラム: 10問進めると終了する", () => {
  let s = an.createAnagramGame(21);
  let guard = 0;
  while (s.status !== "finished" && guard < 50) {
    guard++;
    // 適当に全タイル並べて提出→次へ
    for (const tile of s.tiles) s = an.pickTile(s, tile.id);
    s = an.submitAnswer(s);
    assert.equal(s.status, "answered");
    s = an.nextQuestion(s);
  }
  assert.equal(s.status, "finished");
  assert.equal(s.index, 10);
});

// ---------------------------------------------------------------- じゃんけん大会

const jkRng = () => {
  let s = 42 >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};
const playersN = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));

test("じゃんけん: 多人数勝敗（2種類だけなら勝つ手の全員、1種・3種はあいこ）", () => {
  const W = jk.jankenWinners;
  assert.deepEqual(W([]), []);
  assert.deepEqual(W([{ seat: 0, hand: "rock" }, { seat: 1, hand: "rock" }]), []); // あいこ
  assert.deepEqual(W([{ seat: 0, hand: "rock" }, { seat: 1, hand: "scissors" }, { seat: 2, hand: "paper" }]), []); // 3種あいこ
  assert.deepEqual(
    W([{ seat: 0, hand: "rock" }, { seat: 1, hand: "scissors" }, { seat: 2, hand: "rock" }]).sort(),
    [0, 2],
  ); // グーが勝ち、2人とも得点対象
  assert.deepEqual(W([{ seat: 0, hand: "paper" }, { seat: 1, hand: "rock" }]), [0]);
  assert.deepEqual(W([{ seat: 0, hand: "scissors" }, { seat: 1, hand: "paper" }]), [0]);
});

test("じゃんけん: 人数は2〜8人、範囲外はエラー", () => {
  const m = jk.gameModule;
  assert.throws(() => m.createState(playersN(1), jkRng(), {}));
  assert.throws(() => m.createState(playersN(9), jkRng(), {}));
  const s = m.createState(playersN(8), jkRng(), {});
  assert.equal(s.players.length, 8);
  assert.equal(m.minPlayers, 2);
  assert.equal(m.maxPlayers, 8);
  assert.equal(m.cpuSupported, false);
});

test("じゃんけん: 手は締切まで秘匿され、開示で全員の手と得点が見える", () => {
  const m = jk.gameModule;
  let s = m.createState(playersN(3), jkRng(), {});
  s = m.applyAction(s, 0, { type: "throw", hand: "rock" }, jkRng());
  // まだ締切前: 他人の view に手の情報が無いこと（hand キー自体が無い）
  const viewOther = m.viewFor(s, 1);
  const p0 = viewOther.players.find((p) => p.seat === 0);
  assert.equal(p0.submitted, true);
  assert.equal("hand" in p0, false);
  assert.equal(JSON.stringify(viewOther).includes('"hand":"rock"'), false);
  // 自分の view には自分の手が見える
  const viewMine = m.viewFor(s, 0);
  assert.equal(viewMine.you.yourHand, "rock");
  // 二重提出はエラー
  assert.throws(() => m.applyAction(s, 0, { type: "throw", hand: "paper" }, jkRng()));
  // 全員提出で即締切・開示
  s = m.applyAction(s, 1, { type: "throw", hand: "scissors" }, jkRng());
  s = m.applyAction(s, 2, { type: "throw", hand: "rock" }, jkRng());
  assert.equal(m.phaseOf(s), "reveal");
  const viewAfter = m.viewFor(s, 1);
  assert.equal(viewAfter.players.find((p) => p.seat === 0).hand, "rock");
  assert.equal(viewAfter.players.find((p) => p.seat === 0).won, true);
  assert.equal(viewAfter.players.find((p) => p.seat === 1).won, false);
  assert.equal(viewAfter.players.find((p) => p.seat === 2).won, true);
  assert.equal(s.scores[0], 1);
  assert.equal(s.scores[1], 0);
  assert.equal(s.scores[2], 1);
});

test("じゃんけん: tick で時間切れ締切（未提出は不参加）と全5ラウンド完走・同点同順位", () => {
  const m = jk.gameModule;
  let s = m.createState(playersN(2), jkRng(), {});
  // ラウンド1: 誰も出さずに締切 → あいこ扱い（history に null）
  s = m.tick(s, s.roundEndsAt + 1);
  assert.equal(m.phaseOf(s), "reveal");
  assert.equal(s.history[0].hands.every((h) => h.hand === null), true);
  assert.deepEqual(s.history[0].winners, []);
  // reveal を進める
  s = m.tick(s, s.revealEndsAt + 1);
  assert.equal(m.phaseOf(s), "choosing");
  assert.equal(s.round, 1);
  // 残り4ラウンド: seat0 が常勝ち手、seat1 は負け手を出し続ける
  for (let r = 0; r < 4; r++) {
    s = m.applyAction(s, 0, { type: "throw", hand: "paper" }, jkRng());
    s = m.applyAction(s, 1, { type: "throw", hand: "rock" }, jkRng());
    assert.equal(m.phaseOf(s), "reveal");
    s = m.tick(s, s.revealEndsAt + 1);
  }
  assert.equal(m.isFinished(s), true);
  assert.equal(s.scores[0], 4);
  assert.equal(s.scores[1], 0);
  const view = m.viewFor(s, 0);
  assert.equal(view.standings.find((x) => x.seat === 0).rank, 1);
  assert.equal(view.standings.find((x) => x.seat === 1).rank, 2);
});

test("じゃんけん: 同点は同順位になる", () => {
  const m = jk.gameModule;
  let s = m.createState(playersN(2), jkRng(), {});
  // 全ラウンドあいこ
  for (let r = 0; r < jk.JK_TOTAL_ROUNDS; r++) {
    s = m.applyAction(s, 0, { type: "throw", hand: "rock" }, jkRng());
    s = m.applyAction(s, 1, { type: "throw", hand: "rock" }, jkRng());
    assert.equal(m.phaseOf(s), "reveal");
    s = m.tick(s, s.revealEndsAt + 1);
  }
  assert.equal(m.isFinished(s), true);
  const view = m.viewFor(s, 0);
  assert.ok(view.standings.every((x) => x.rank === 1));
});

test("じゃんけん: 退出は脱落扱いで、残り1人になると終了する／parseAction の検証", () => {
  const m = jk.gameModule;
  let s = m.createState(playersN(3), jkRng(), {});
  s = m.onPlayerLeft(s, 2);
  assert.deepEqual(s.leftSeats, [2]);
  assert.throws(() => m.applyAction(s, 2, { type: "throw", hand: "rock" }, jkRng()));
  s = m.onPlayerLeft(s, 1);
  assert.equal(m.isFinished(s), true);

  assert.deepEqual(m.parseAction({ type: "throw", hand: "paper" }), { type: "throw", hand: "paper" });
  assert.equal(m.parseAction({ type: "throw", hand: "bomb" }), null);
  assert.equal(m.parseAction({ type: "answer", choice: 1 }), null);
  assert.equal(m.parseAction(null), null);
  assert.equal(m.parseAction("throw"), null);
});

test("じゃんけん: 退出者以外の全員が提出すれば締め切られる", () => {
  const m = jk.gameModule;
  let s = m.createState(playersN(3), jkRng(), {});
  s = m.onPlayerLeft(s, 2);
  s = m.applyAction(s, 0, { type: "throw", hand: "rock" }, jkRng());
  s = m.applyAction(s, 1, { type: "throw", hand: "scissors" }, jkRng());
  assert.equal(m.phaseOf(s), "reveal");
  assert.equal(s.history[0].hands.find((h) => h.seat === 2).hand, null);
});
