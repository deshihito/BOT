// 第5バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// kenken / freecell / countdown / columns / backgammon / sokoban /
// nonogram / kakuro の残りボタンはゲーム外 chrome（リセット操作）として
// 例外リスト入り済みのため、上限件数だけを固定する。countdown は 0 件。
// - kenken / kakuro は盤面フォーカス時の Enter でチェックするため、
//   親子 onKeyDown の二重発火防止ガードを固定する（anagram / mastermind の教訓）。
// - backgammon は Space でのダイス振りとタップ対象物の二重発火防止ガードを固定する
//   （reaction / falling / wordle の教訓）。
// - sokoban はダブルタップ=1手戻すの誤発火防止（直近の操作記録ガード）を固定する
//   （anagram のヒント誤発火の教訓）。
// - columns は HEAD の doRotate 自己再帰バグの修正を固定する。
// - nonogram はドラッグ塗りが既存のポインタ直結のため useGesture を使わない
//   意図的な例外（reaction / stopwatch と同じ扱い）。
// - 盤面内に子の onClick があるゲーム（kenken / kakuro / freecell / countdown /
//   backgammon / sokoban）は useGesture の suppressClickAfterSwipe
//   によるスワイプ直後の click 抑止が働くことを、共通ヘルパーの利用で固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  kenken: "KenkenClient.tsx",
  freecell: "FreeCellClient.tsx",
  countdown: "CountdownClient.tsx",
  columns: "ColumnsClient.tsx",
  backgammon: "BackgammonClient.tsx",
  sokoban: "SokobanClient.tsx",
  nonogram: "NonogramClient.tsx",
  kakuro: "KakuroClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { kenken: 1, freecell: 2, countdown: 0, columns: 1, backgammon: 1, sokoban: 1, nonogram: 1, kakuro: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch5: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch5: 残りボタンは chrome のリセット操作だけ", () => {
  const chromeOnly = {
    kenken: ["もう一度"],
    columns: ["もう一度"],
    backgammon: ["もう一度"],
    sokoban: ["もう一度"],
    kakuro: ["もう一度"],
    nonogram: ["別の問題"],
  };
  for (const [game, labels] of Object.entries(chromeOnly)) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes(labels[0]), `${game}: 残りボタンがリセット操作ではない`);
  }
  const free = read("freecell");
  const freeButtons = free.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.equal(freeButtons.length, 2, `freecell: 残りボタンが ${freeButtons.length} 件`);
  assert.ok(freeButtons.some((b) => b.includes("同じ盤面でもう一度")), "freecell: 同じ盤面でもう一度がない");
  assert.ok(freeButtons.some((b) => b.includes("新しい盤面")), "freecell: 新しい盤面がない");
});

test("gesture batch5: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch5: スワイプ系7ゲームは盤面・対象物に useGesture を使う（nonogram はドラッグ塗りのため対象外）", () => {
  for (const game of ["kenken", "freecell", "countdown", "columns", "backgammon", "sokoban", "kakuro"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
  const nono = read("nonogram");
  assert.ok(!nono.includes("useGesture"), "nonogram: ドラッグ塗りなのに useGesture がある");
  assert.ok(nono.includes("onPointerDown"), "nonogram: ドラッグ塗りの起点がない");
  assert.ok(nono.includes("startPaint(index)"), "nonogram: ドラッグ塗りへの接続が壊れている");
});

test("gesture batch5: ジェスチャ面は touchAction none（freecell は横スワイプのみのため pan-y）", () => {
  for (const game of ["kenken", "countdown", "columns", "backgammon", "sokoban", "nonogram", "kakuro"]) {
    const src = read(game);
    assert.ok(src.includes('touchAction: "none"'), `${game}: ジェスチャ面に touchAction none がない`);
  }
  const free = read("freecell");
  assert.ok(free.includes('touchAction: "pan-y"'), "freecell: 盤面に touchAction pan-y がない");
});

test("gesture batch5: kenken は盤面下スワイプでチェック、パッドはタップ対象物化", () => {
  const src = read("kenken");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "down"'), "チェックが下スワイプになっていない");
  assert.ok(src.includes("onCheck()"), "チェックへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => input(n))"), "数字パッドがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => input(0))"), "消すがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => restart(s.key))"), "サイズ選択がタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  // 物理キーボードの数字入力（パッド div は Enter/Space のみのため二重発火なし）。
  assert.ok(src.includes("input(Number(e.key))"), "物理キーボードの数字入力がない");
  assert.ok(src.includes('e.key === "Backspace"'), "Backspace での消すがない");
});

test("gesture batch5: kenken / kakuro の Enter は1経路のみ（二重発火防止）", () => {
  for (const game of ["kenken", "kakuro"]) {
    const src = read(game);
    // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
    // ガードがないとマスにフォーカスして Enter を押したときに選択と
    // チェックが両方走る（anagram / mastermind と同じ構図）。
    assert.ok(src.includes("e.target !== e.currentTarget"), `${game}: 親子 onKeyDown のガードがない`);
    assert.ok(src.includes('e.key === "Enter"'), `${game}: Enter でのチェックがない`);
  }
});

test("gesture batch5: kakuro は盤面下スワイプでチェック、パッドはタップ対象物化", () => {
  const src = read("kakuro");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "down"'), "チェックが下スワイプになっていない");
  assert.ok(src.includes("handleCheck()"), "チェックへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => input(n))"), "数字パッドがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => input(0))"), "消すがタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "白マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes("input(Number(e.key))"), "物理キーボードの数字入力がない");
  assert.ok(src.includes('aria-disabled={cell.given'), "与え数字マスの無効化がない");
});

test("gesture batch5: freecell は盤面スワイプで1手戻す・自動送り、札はタップ対象", () => {
  const src = read("freecell");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "1手戻すが左スワイプになっていない");
  assert.ok(src.includes('dir === "right"'), "自動送りが右スワイプになっていない");
  assert.ok(src.includes("onUndo()"), "1手戻すへの接続が壊れている");
  assert.ok(src.includes("onAuto()"), "自動送りへの接続が壊れている");
  assert.ok(src.includes("tappableProps(onClick)"), "札・空きスロットがタップ対象になっていない");
  // U / A キーでも同じ操作ができる（札の div は Enter/Space のみのため二重発火なし）。
  assert.ok(src.includes('e.key === "u"'), "U キーでの1手戻すがない");
  assert.ok(src.includes('e.key === "a"'), "A キーでの自動送りがない");
});

test("gesture batch5: countdown は盤面スワイプで戻す・やり直す・提出、タイルはタップ対象", () => {
  const src = read("countdown");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "1つ戻すが左スワイプになっていない");
  assert.ok(src.includes('dir === "right"'), "やり直すが右スワイプになっていない");
  assert.ok(src.includes('dir === "up"'), "提出が上スワイプになっていない");
  assert.ok(src.includes("undo()"), "1つ戻すへの接続が壊れている");
  assert.ok(src.includes("freshBuilder(numbers)"), "やり直すへの接続が壊れている");
  assert.ok(src.includes("onSubmit()"), "提出への接続が壊れている");
  assert.ok(src.includes("tappableProps(() => tapTile(ref))"), "数字タイルがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(onSubmit)"), "提出がタップ対象になっていない");
  // U / R キーでも同じ操作ができる。OnlineShell の入力欄では無視する。
  assert.ok(src.includes('e.key === "u"'), "U キーでの1つ戻すがない");
  assert.ok(src.includes('e.key === "r"'), "R キーでのやり直すがない");
  assert.ok(src.includes("isContentEditable"), "入力欄でのキー無視ガードがない");
});

test("gesture batch5: columns は盤面スワイプで移動・落とす、タップで回転", () => {
  const src = read("columns");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("onSwipe: (dir) => {"), "スワイプが移動に繋がっていない");
  assert.ok(src.includes("doMove(-1)"), "左移動への接続が壊れている");
  assert.ok(src.includes("doMove(1)"), "右移動への接続が壊れている");
  assert.ok(src.includes("doStep()"), "ソフトドロップへの接続が壊れている");
  assert.ok(src.includes("doDrop()"), "ハードドロップへの接続が壊れている");
  assert.ok(src.includes("doRotate()"), "回転への接続が壊れている");
  assert.ok(!src.includes("← 左"), "左ボタンが残っている");
  assert.ok(!src.includes("⤓ 一気に落とす"), "一気に落とすボタンが残っている");
  // HEAD の doRotate 自己再帰バグの修正（回転は rotateColumns を呼ぶ）。
  assert.ok(src.includes("setState((s) => rotateColumns(s))"), "doRotate が rotateColumns を呼んでいない");
  const def = src.match(/const doRotate = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(def, "doRotate の定義が見つからない");
  assert.ok(!def[0].includes("doRotate();"), "doRotate が自己再帰している");
});

test("gesture batch5: backgammon は盤面タップでダイス、スワイプでパス・上がり", () => {
  const src = read("backgammon");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "パスが左スワイプになっていない");
  assert.ok(src.includes('dir === "up"'), "上がりが上スワイプになっていない");
  assert.ok(src.includes("passTurn()"), "パスへの接続が壊れている");
  assert.ok(src.includes("bearOff()"), "上がりへの接続が壊れている");
  assert.ok(src.includes("rollDice()"), "ダイス振りへの接続が壊れている");
  assert.ok(src.includes("tappableProps(rollDice)"), "ダイス対象物がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(onClick)"), "コマの山がタップ対象になっていない");
  assert.ok(!src.includes("パスする"), "パスするボタンが残っている");
  assert.ok(!src.includes("⬆ 上がる"), "上がるボタンが残っている");
  assert.ok(!src.includes("バーから復帰（"), "バーから復帰ボタンが残っている");
  // Space でのダイス振りはタップ対象物にフォーカスがあるとき window 側が無視する。
  assert.ok(src.includes('e.key === " "'), "Space でのダイス振りがない");
  assert.ok(src.includes('closest?.("[data-backgammon-ui]")'), "window リスナーに Space のガードがない");
  assert.ok(src.includes('e.key === "p"'), "P キーでのパスがない");
  assert.ok(src.includes('e.key === "b"'), "B キーでの上がりがない");
});

test("gesture batch5: sokoban は盤面スワイプで移動、ダブルタップで1手戻す", () => {
  const src = read("sokoban");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("onSwipe: (dir) => {"), "スワイプが移動に繋がっていない");
  assert.ok(src.includes("move(dir)"), "移動への接続が壊れている");
  assert.ok(src.includes("onDoubleTap"), "1手戻すがダブルタップになっていない");
  assert.ok(src.includes("undoSokoban(s)"), "1手戻すへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => startLevel(i))"), "面選択がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => startLevel(level + 1))"), "次の面へがタップ対象になっていない");
  assert.ok(!src.includes("padButton"), "十字ボタンが残っている");
  assert.ok(!src.includes("↩ 1手戻す"), "1手戻すボタンが残っている");
  // 直近の操作があったダブルタップは戻すにしない（anagram の誤発火防止と同じ構図）。
  assert.ok(src.includes("lastActionAtRef"), "ダブルタップ誤発火防止の記録がない");
  assert.ok(src.includes("Date.now() - lastActionAtRef.current < 400"), "ダブルタップ誤発火防止のガードがない");
});

test("gesture batch5: nonogram はマスを div 化し、モード切替はタップ対象物化", () => {
  const src = read("nonogram");
  assert.ok(src.includes("tappableProps(() => restart(s.key))"), "サイズ選択がタップ対象になっていない");
  assert.ok(src.includes('tappableProps(() => setMode("fill"))'), "塗るモードがタップ対象になっていない");
  assert.ok(src.includes('tappableProps(() => setMode("cross"))'), "×印モードがタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes("onPointerEnter"), "ドラッグ塗りの継続がない");
  assert.ok(src.includes("elementFromPoint"), "タッチでのドラッグ塗りの位置引きがない");
  // マスのキーボード操作（Enter/Space=塗る・消す）。
  assert.ok(src.includes("startPaint(index)"), "マスのキーボード操作への接続が壊れている");
});

test("gesture batch5: 8ゲームとも ⏱ が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: ⏱ が残っている`);
  }
});

// --- 第5バッチ Bレビュー追加（2026-11-14） ---

test("gesture batch5 review: backgammon はバーあり時に盤マスをタップして復帰できる", () => {
  const src = read("backgammon");
  // 旧「バーから復帰」ボタンは setSelected("bar") を直接呼んでいたが、
  // 盤マスの clickable 条件は bar[0] > 0 のときに全マスを不可にしていた。
  // この条件がないと onPointClick に到達できず、合法手があるのにパスも
  // できない詰みになる（第5バッチの回帰）。
  assert.ok(
    src.includes('state.bar[0] > 0 && legal.some((m) => m.from === "bar")'),
    "バーあり時にマスがタップ対象になっていない",
  );
});

test("gesture batch5 review: sokoban のダブルタップ=戻すは click 到着を待って再判定する", () => {
  const src = read("sokoban");
  const def = src.match(/onDoubleTap: \(\) => \{[\s\S]*?\n    \},/);
  assert.ok(def, "onDoubleTap の定義が見つからない");
  // click は pointerup の直後に発火するため、即判定では2発目の箱押しが
  // まだ記録されていない（床→箱の順のダブルタップで戻すが誤発火する）。
  assert.ok(def[0].includes("setTimeout"), "ダブルタップ=戻すが click 到着を待っていない");
  assert.ok(
    def[0].includes("Date.now() - lastActionAtRef.current < 400"),
    "遅延後の再判定ガードがない",
  );
  // 押せなかった箱タップも操作として記録する（移動・箱押しの成功時と
  // ダブルタップ自体の計4箇所）。
  assert.equal(
    (src.match(/lastActionAtRef\.current = Date\.now\(\);/g) ?? []).length,
    4,
    "lastActionAtRef の記録箇所が 4 箇所ではない",
  );
});

test("gesture batch5 review: sokoban の「次の面へ」は p の中に div を置かない", () => {
  const src = read("sokoban");
  // button→div 化の際に p の中に div が入り、不正なネストになっていた。
  // ブラウザが p を自動で閉じて中央揃えが崩れるため div に置き換えた。
  const pBlocks = src.match(/<p[\s\S]*?<\/p>/g) ?? [];
  assert.ok(pBlocks.every((b) => !b.includes("<div")), "p の中に div がある");
});
