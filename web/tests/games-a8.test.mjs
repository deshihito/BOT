// A8フェーズの新規4本のロジック検証。
// - lib/pipe.ts: 解の存在する生成・回転・水の流れ判定・クリア
// - lib/drawpoker.ts: 役判定（ワンペア〜ロイヤル）・交換・配当・簡易戦略
// - lib/online/games/bombpass.ts: 爆発と失点・脱落と勝敗・秘匿（残り時間非表示）・退出
// - lib/online/games/shiritori.ts: 単語バンク妥当性・接続ルール・「ン」負け・時間切れ
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

const pipe = await loadLib("pipe.ts");
const dp = await loadLib("drawpoker.ts");
const bomb = await loadOnline("bombpass.ts", ["gameModule", "BOMB_MIN_MS", "BOMB_MAX_MS", "BOMB_LOSE_POINTS"]);
const shi = await loadOnline("shiritori.ts", [
  "gameModule",
  "SHIRITORI_WORDS",
  "normalizeShiritoriWord",
  "shiritoriTail",
  "isBankWord",
  "SHIRITORI_TURN_MS",
]);

const rngStub = () => 0.5;
const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

// ---------------------------------------------------------------- パイプ

/** タイル種別が、必要な方向集合を覆う回転を持つか。 */
function tileCanCover(lib, kind, dirs) {
  for (let r = 0; r < 4; r++) {
    const openings = lib.pipeOpenings({ kind, rotation: r });
    if (dirs.every((d) => openings.includes(d))) return true;
  }
  return false;
}

/** 回転の独立性を込めた DFS で「解ける配置か」を判定する（各タイルは経路上で最大2方向だけ要求される）。 */
function pipeSolvable(lib, state) {
  const size = state.size;
  const opp = (d) => (d + 2) % 4;
  const DR = [-1, 0, 1, 0];
  const DC = [0, 1, 0, -1];
  const visited = new Set([state.source]);
  const dfs = (cur, entryDir) => {
    if (cur === state.drain) {
      return entryDir === null || tileCanCover(lib, state.cells[cur].kind, [entryDir]);
    }
    const r = Math.floor(cur / size);
    const c = cur % size;
    for (let d = 0; d < 4; d++) {
      if (entryDir !== null && d === entryDir) continue; // 来た方向へは戻らない
      const nr = r + DR[d];
      const nc = c + DC[d];
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const ni = nr * size + nc;
      if (visited.has(ni)) continue;
      const need = entryDir === null ? [d] : [entryDir, d];
      if (!tileCanCover(lib, state.cells[cur].kind, need)) continue;
      if (!tileCanCover(lib, state.cells[ni].kind, [opp(d)])) continue;
      visited.add(ni);
      if (dfs(ni, opp(d))) return true;
      visited.delete(ni);
    }
    return false;
  };
  return dfs(state.source, null);
}

test("パイプ: 同じシードでは同じ配置になり、水源は左端・排水口は右端", () => {
  const a = pipe.createPipeGame(42);
  const b = pipe.createPipeGame(42);
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.source, b.source);
  assert.equal(a.drain, b.drain);
  assert.equal(a.source % a.size, 0);
  assert.equal(a.drain % a.size, a.size - 1);
  assert.equal(a.cells.length, 36);
});

test("パイプ: 生成直後は解けておらず、解が必ず存在する（複数シード）", () => {
  for (const seed of [1, 2, 3, 7, 42, 100, 999, 123456]) {
    const state = pipe.createPipeGame(seed);
    assert.equal(state.status, "playing");
    assert.equal(pipe.isPipeSolved(state), false, `seed=${seed} が初期状態で解けている`);
    assert.ok(pipeSolvable(pipe, state), `seed=${seed} に解が存在しない`);
  }
});

test("パイプ: 回転で手数が増え、不正な index は無視される", () => {
  const s0 = pipe.createPipeGame(5);
  const s1 = pipe.rotatePipe(s0, 0);
  assert.equal(s1.moves, 1);
  assert.equal(s1.cells[0].rotation, (s0.cells[0].rotation + 1) % 4);
  assert.equal(pipe.rotatePipe(s0, -1), s0);
  assert.equal(pipe.rotatePipe(s0, 36), s0);
  // 元の状態は破壊されない
  assert.equal(s0.moves, 0);
});

test("パイプ: 一直線につなぐと水が排水口まで届いてクリアになる", () => {
  const cells = Array.from({ length: 36 }, () => ({ kind: "end", rotation: 0 }));
  // 0行目: 水源(東向き end) → straight(東西) ×4 → 排水口(西向き end)
  cells[0] = { kind: "end", rotation: 1 };
  for (const i of [1, 2, 3, 4]) cells[i] = { kind: "straight", rotation: 1 };
  cells[5] = { kind: "end", rotation: 3 };
  const base = { size: 6, cells, source: 0, drain: 5, moves: 0, status: "playing", seed: 0 };
  const flow = pipe.flowIndices(base);
  assert.ok(flow.includes(5));
  assert.equal(pipe.isPipeSolved(base), true);
  const after = pipe.rotatePipe(base, 10);
  assert.equal(after.status, "won");
  // クリア後は回転できない
  assert.equal(pipe.rotatePipe(after, 10), after);
});

// ---------------------------------------------------------------- ドローポーカー

const C = (suit, rank) => ({ suit, rank });

test("ドローポーカー: 役判定（ロイヤル〜スリーカード）", () => {
  const royal = dp.evaluateHand([C("spade", 10), C("spade", 11), C("spade", 12), C("spade", 13), C("spade", 1)]);
  assert.equal(royal.category, 9);
  assert.equal(royal.multiplier, 250);
  const sf = dp.evaluateHand([C("heart", 5), C("heart", 6), C("heart", 7), C("heart", 8), C("heart", 9)]);
  assert.equal(sf.category, 8);
  const four = dp.evaluateHand([C("spade", 9), C("heart", 9), C("diamond", 9), C("club", 9), C("spade", 2)]);
  assert.equal(four.category, 7);
  const fh = dp.evaluateHand([C("spade", 9), C("heart", 9), C("diamond", 9), C("club", 2), C("spade", 2)]);
  assert.equal(fh.category, 6);
  const flush = dp.evaluateHand([C("club", 2), C("club", 5), C("club", 7), C("club", 11), C("club", 13)]);
  assert.equal(flush.category, 5);
  const straight = dp.evaluateHand([C("spade", 5), C("heart", 6), C("diamond", 7), C("club", 8), C("spade", 9)]);
  assert.equal(straight.category, 4);
  const wheel = dp.evaluateHand([C("spade", 1), C("heart", 2), C("diamond", 3), C("club", 4), C("spade", 5)]);
  assert.equal(wheel.category, 4);
  const three = dp.evaluateHand([C("spade", 7), C("heart", 7), C("diamond", 7), C("club", 2), C("spade", 11)]);
  assert.equal(three.category, 3);
  const twoPair = dp.evaluateHand([C("spade", 7), C("heart", 7), C("diamond", 2), C("club", 2), C("spade", 11)]);
  assert.equal(twoPair.category, 2);
});

test("ドローポーカー: ワンペアは J 以上（A 含む）だけ配当があり、10以下は配当なし", () => {
  const jPair = dp.evaluateHand([C("spade", 11), C("heart", 11), C("diamond", 2), C("club", 5), C("spade", 8)]);
  assert.equal(jPair.category, 1);
  assert.equal(jPair.multiplier, 1);
  const aPair = dp.evaluateHand([C("spade", 1), C("heart", 1), C("diamond", 2), C("club", 5), C("spade", 8)]);
  assert.equal(aPair.category, 1);
  const lowPair = dp.evaluateHand([C("spade", 10), C("heart", 10), C("diamond", 2), C("club", 5), C("spade", 8)]);
  assert.equal(lowPair.category, 0);
  assert.equal(lowPair.multiplier, 0);
  assert.ok(lowPair.name.includes("ワンペア"));
  const high = dp.evaluateHand([C("spade", 2), C("heart", 5), C("diamond", 7), C("club", 11), C("spade", 9)]);
  assert.equal(high.category, 0);
  assert.equal(high.name, "役なし");
});

test("ドローポーカー: 配ると5枚の異なる札でベットが引かれ、交換で確定して配当が付く", () => {
  const s0 = dp.createDrawPokerGame(7, 1000);
  const s1 = dp.startRound(s0, 100);
  assert.equal(s1.phase, "draw");
  assert.equal(s1.chips, 900);
  assert.equal(s1.hand.length, 5);
  assert.equal(new Set(s1.hand.map((c) => `${c.suit}-${c.rank}`)).size, 5);
  // 同じシードでは同じ配布
  const again = dp.startRound(dp.createDrawPokerGame(7, 1000), 100);
  assert.deepEqual(again.hand, s1.hand);
  // 全交換
  const s2 = dp.drawCards(s1, [0, 1, 2, 3, 4]);
  assert.equal(s2.phase, "settled");
  assert.equal(s2.hand.length, 5);
  // 捨てた5枚は場から離れるため、手札＋山札は47枚で全て異なる
  const all = [...s2.hand, ...s2.deck];
  assert.equal(new Set(all.map((c) => `${c.suit}-${c.rank}`)).size, 47);
  const info = dp.evaluateHand(s2.hand);
  assert.equal(s2.result.hand.category, info.category);
  assert.equal(s2.result.payout, 100 * info.multiplier);
  assert.equal(s2.chips, 900 + s2.result.payout);
  // 交換なし（全残し）でも確定できる
  const s3 = dp.drawCards(s1, []);
  assert.deepEqual(s3.hand, s1.hand);
  // 確定後は再交換できない／ベット不足は開始できない
  assert.equal(dp.drawCards(s2, [0]), s2);
  assert.equal(dp.startRound(dp.createDrawPokerGame(1, 50), 100).phase, "betting");
});

test("ドローポーカー: 簡易戦略はペアとフラッシュを残す", () => {
  const pairHolds = dp.suggestHolds([C("spade", 11), C("heart", 11), C("diamond", 2), C("club", 5), C("spade", 8)]);
  assert.deepEqual([...pairHolds].sort((a, b) => a - b), [0, 1]);
  const flushHolds = dp.suggestHolds([C("club", 2), C("club", 5), C("club", 7), C("club", 11), C("club", 13)]);
  assert.deepEqual([...flushHolds].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------- 爆弾パス

test("爆弾パス: 生成とパスの基本（保持者だけが任意の生存者へパスできる）", () => {
  const m = bomb.gameModule;
  const s0 = m.createState(seats(3), rngStub, {});
  assert.ok(s0.holder >= 0 && s0.holder < 3);
  assert.deepEqual(Object.values(s0.losses), [0, 0, 0]);
  const holder = s0.holder;
  const target = (holder + 1) % 3;
  const s1 = m.applyAction(s0, holder, { type: "pass", target }, rngStub);
  assert.equal(s1.holder, target);
  assert.equal(s1.lastEvent.kind, "pass");
  // 保持者以外はパスできない／自分にはパスできない
  assert.throws(() => m.applyAction(s0, target, { type: "pass", target: holder }, rngStub));
  assert.throws(() => m.applyAction(s0, holder, { type: "pass", target: holder }, rngStub));
  // 人数外は生成できない
  assert.throws(() => m.createState(seats(1), rngStub, {}));
  assert.throws(() => m.createState(seats(9), rngStub, {}));
});

test("爆弾パス: 爆発までの時間は15〜40秒で、ビューに残り時間情報が含まれない", () => {
  const m = bomb.gameModule;
  const before = Date.now();
  const s0 = m.createState(seats(4), rngStub, {});
  const span = s0.explodeAt - before;
  assert.ok(span >= bomb.BOMB_MIN_MS - 1000 && span <= bomb.BOMB_MAX_MS + 1000, `span=${span}`);
  const view = m.viewFor(s0, 0);
  const json = JSON.stringify(view);
  assert.ok(!json.includes("explodeAt"));
  assert.ok(!json.includes("rngState"));
  assert.ok(!("explodeAt" in view));
  // 爆発前は tick で変化しない（同一参照）
  assert.equal(m.tick(s0, s0.explodeAt - 1), s0);
});

test("爆弾パス: 爆発で保持者が1失点し、次の生存者へ移る", () => {
  const m = bomb.gameModule;
  const s0 = m.createState(seats(3), rngStub, {});
  const victim = s0.holder;
  const s1 = m.tick(s0, s0.explodeAt);
  assert.equal(s1.losses[victim], 1);
  assert.equal(s1.holder, (victim + 1) % 3);
  assert.equal(s1.lastEvent.kind, "explode");
  assert.equal(s1.round, 2);
  assert.equal(s1.finished, false);
});

test("爆弾パス: 2人で爆発を繰り返すと3失点した方が脱落し、残った方が勝つ", () => {
  const m = bomb.gameModule;
  let s = m.createState(seats(2), rngStub, {});
  let guard = 0;
  while (!s.finished && guard < 20) {
    s = m.tick(s, s.explodeAt);
    guard++;
  }
  assert.equal(s.finished, true);
  assert.ok(s.winner === 0 || s.winner === 1);
  const loser = s.winner === 0 ? 1 : 0;
  assert.equal(s.losses[loser], bomb.BOMB_LOSE_POINTS);
  assert.ok(s.eliminated.includes(loser));
});

test("爆弾パス: 保持者が退出したら爆弾は次の生存者へ移り、2人では退出で決着する", () => {
  const m = bomb.gameModule;
  const s0 = m.createState(seats(3), rngStub, {});
  const s1 = m.onPlayerLeft(s0, s0.holder);
  assert.equal(s1.holder, (s0.holder + 1) % 3);
  assert.equal(s1.finished, false);
  // 脱落者へはパスできない
  assert.throws(() => m.applyAction(s1, s1.holder, { type: "pass", target: s0.holder }, rngStub));
  const t0 = m.createState(seats(2), rngStub, {});
  const t1 = m.onPlayerLeft(t0, 0);
  assert.equal(t1.finished, true);
  assert.equal(t1.winner, 1);
});

// ---------------------------------------------------------------- しりとり

test("しりとり: 単語バンクは150語以上で全てカタカナ・重複なし", () => {
  assert.ok(shi.SHIRITORI_WORDS.length >= 150, `words=${shi.SHIRITORI_WORDS.length}`);
  assert.equal(new Set(shi.SHIRITORI_WORDS).size, shi.SHIRITORI_WORDS.length);
  for (const w of shi.SHIRITORI_WORDS) {
    assert.ok(/^[ァ-ヶー]+$/.test(w), `バンク外の文字: ${w}`);
    assert.ok(w.length >= 2 && w.length <= 10, `長さ不正: ${w}`);
  }
});

test("しりとり: 正規化（ひらがな→カタカナ・空白除去）と最後の文字ルール", () => {
  assert.equal(shi.normalizeShiritoriWord("りんご"), "リンゴ");
  assert.equal(shi.normalizeShiritoriWord(" ゴ リ ラ "), "ゴリラ");
  assert.equal(shi.normalizeShiritoriWord(123), null);
  // 末尾の「ー」は除く
  assert.equal(shi.shiritoriTail("コーヒー"), "ヒ");
  assert.equal(shi.shiritoriTail("セーター"), "タ");
  // 小さい文字は大きい文字として扱う
  assert.equal(shi.shiritoriTail("ホッ"), "ツ");
  assert.equal(shi.shiritoriTail("ミャ"), "ヤ");
  assert.equal(shi.shiritoriTail("リンゴ"), "ゴ");
  assert.ok(shi.isBankWord("ゴリラ"));
  assert.ok(!shi.isBankWord("ゴリラッパ"));
});

test("しりとり: 接続チェーンが進み、違う文字・重複・バンク外は弾かれる", () => {
  const m = shi.gameModule;
  let s = m.createState(seats(2), rngStub, {});
  assert.equal(s.turn, 0);
  assert.equal(s.requiredStart, null);
  s = m.applyAction(s, 0, { type: "submit", word: "リンゴ" }, rngStub);
  assert.equal(s.requiredStart, "ゴ");
  assert.equal(s.turn, 1);
  // 違う文字から始まる単語は不可
  assert.throws(() => m.applyAction(s, 1, { type: "submit", word: "サカナ" }, rngStub), /「ゴ」/);
  // バンク外は不可
  assert.throws(() => m.applyAction(s, 1, { type: "submit", word: "ゴリラッパ" }, rngStub));
  // ひらがな入力も正規化されて通る
  s = m.applyAction(s, 1, { type: "submit", word: "ごりら" }, rngStub);
  assert.equal(s.requiredStart, "ラ");
  assert.equal(s.turn, 0);
  s = m.applyAction(s, 0, { type: "submit", word: "ランプ" }, rngStub);
  assert.equal(s.requiredStart, "プ");
  s = m.applyAction(s, 1, { type: "submit", word: "プール" }, rngStub);
  assert.equal(s.requiredStart, "ル");
  s = m.applyAction(s, 0, { type: "submit", word: "ルビー" }, rngStub);
  assert.equal(s.requiredStart, "ビ");
  s = m.applyAction(s, 1, { type: "submit", word: "ビル" }, rngStub);
  // 重複は不可（ルール: ルビーは使用済み）
  assert.throws(() => m.applyAction(s, 0, { type: "submit", word: "ルビー" }, rngStub));
  // 番でない人は出せない
  assert.throws(() => m.applyAction(s, 1, { type: "submit", word: "ルール" }, rngStub));
  assert.equal(s.finished, false);
  assert.equal(s.history.length, 6);
});

test("しりとり: 「ン」で終わる単語を出すと脱落し、2人では相手の勝ちになる", () => {
  const m = shi.gameModule;
  let s = m.createState(seats(2), rngStub, {});
  s = m.applyAction(s, 0, { type: "submit", word: "ライオン" }, rngStub);
  assert.equal(s.finished, true);
  assert.equal(s.winner, 1);
  assert.ok(s.eliminated.includes(0));
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].foul, true);
  // 3人ではゲームが続き、接続先は前のまま（初回なので自由）
  let t = m.createState(seats(3), rngStub, {});
  t = m.applyAction(t, 0, { type: "submit", word: "ミカン" }, rngStub);
  assert.equal(t.finished, false);
  assert.equal(t.requiredStart, null);
  assert.equal(t.turn, 1);
});

test("しりとり: 時間切れで手番の人が脱落し、ビューに全履歴が見える", () => {
  const m = shi.gameModule;
  let s = m.createState(seats(2), rngStub, {});
  s = m.applyAction(s, 0, { type: "submit", word: "リンゴ" }, rngStub);
  const before = s.turnEndsAt;
  // 締切前は変化しない
  assert.equal(m.tick(s, before - 1), s);
  const s2 = m.tick(s, before);
  assert.equal(s2.finished, true);
  assert.equal(s2.winner, 0);
  assert.ok(s2.eliminated.includes(1));
  assert.equal(s2.lastEvent.kind, "timeout");
  const view = m.viewFor(s2, 0);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].word, "リンゴ");
  // 制限時間の定数が30秒
  assert.equal(shi.SHIRITORI_TURN_MS, 30000);
});
