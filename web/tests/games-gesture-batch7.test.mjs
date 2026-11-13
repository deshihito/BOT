// 第7バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// pyramid / puttgolf / pong / nurikabe / minesweeper / lightsout / kwordle の
// 残りボタンはゲーム外 chrome（リセット操作）として例外リスト入り済みの
// ため、上限件数だけを固定する。numbercode は 0 件。
// - pong / kwordle / numbercode は window キーリスナーとタップ対象物の
//   二重発火防止ガードを固定する（reaction / falling / wordle / bowling の教訓）。
// - nurikabe は盤面・チェックの Enter とマスの Enter の二重発火防止ガードを
//   固定する（anagram / mastermind の教訓）。
// - 盤面内に子の onClick があるゲーム（nurikabe）は useGesture の
//   suppressClickAfterSwipe によるスワイプ直後の click 抑止が働くことを、
//   共通ヘルパーの利用で固定する（ヘルパー自体の動作は batch3 のテストで検証済み）。
//   puttgolf のコース面に子の onClick はないため対象外。
// - pyramid の非公開カード・ストックめくり、puttgolf のカップを狙う、
//   numbercode の使用済み数字・空入力時の操作は、旧ボタンの disabled 条件と
//   同等に無効化されていること（backgammon のバー復帰不能の教訓）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  pyramid: "PyramidClient.tsx",
  puttgolf: "PuttGolfClient.tsx",
  pong: "PongClient.tsx",
  nurikabe: "NurikabeClient.tsx",
  numbercode: "NumberCodeClient.tsx",
  minesweeper: "MinesweeperClient.tsx",
  lightsout: "LightsOutClient.tsx",
  kwordle: "KwordleClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { pyramid: 1, puttgolf: 1, pong: 1, nurikabe: 1, numbercode: 0, minesweeper: 1, lightsout: 1, kwordle: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch7: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch7: 残りボタンは chrome のリセット操作だけ", () => {
  for (const game of ["pyramid", "puttgolf", "pong", "nurikabe", "minesweeper", "lightsout", "kwordle"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
  }
  const code = read("numbercode");
  assert.equal((code.match(/<button/g) ?? []).length, 0, "numbercode: ボタンが残っている");
});

test("gesture batch7: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch7: スワイプ系3ゲームは盤面・対象物に useGesture を使う", () => {
  for (const game of ["puttgolf", "nurikabe", "numbercode"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
  // pyramid / pong / minesweeper / lightsout / kwordle はタップ対象物化のみ
  // （盤面スワイプを持たない。pong のポーズ用ダブルタップは pointerdown 直結の
  // 手書き判定で、reaction / stopwatch と同じ意図的な例外）。
});

test("gesture batch7: ジェスチャ面は touchAction none", () => {
  for (const game of ["puttgolf", "nurikabe", "numbercode"]) {
    const src = read(game);
    assert.ok(src.includes('touchAction: "none"'), `${game}: ジェスチャ面に touchAction none がない`);
  }
  // pong のキャンバスは HEAD から touchAction none（パドル操作用）。
  const pong = read("pong");
  assert.ok(pong.includes('touchAction: "none"'), "pong: キャンバスに touchAction none がない");
});

test("gesture batch7: pyramid はカード・ストック・捨て山がタップ対象物化し無効条件が残る", () => {
  const src = read("pyramid");
  assert.ok(src.includes("tappableProps(() => {"), "カード・ストックがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => onTarget({ kind: \"waste\" }, wasteTop))"), "捨て山がタップ対象になっていない");
  // 旧ボタンの disabled 条件と同等に、覆われているカード・終局時・空のストックは無効。
  assert.ok(src.includes("cellDisabled"), "非公開カードの無効化がない");
  assert.ok(src.includes("stockDisabled"), "ストックめくりの無効条件がない");
  assert.ok(
    src.includes('state.status === "won" ||\n    state.status === "stuck" ||\n    (state.stock.length === 0 && state.waste.length === 0)'),
    "ストックめくりの無効条件が旧ボタンと一致しない",
  );
  assert.ok(src.includes("tabIndex={cellDisabled ? -1 : 0}"), "無効なカードがフォーカス対象のまま");
  assert.ok(src.includes("tabIndex={stockDisabled ? -1 : 0}"), "無効なストックがフォーカス対象のまま");
});

test("gesture batch7: puttgolf はコースタップで打つ・次のホールへ、カップを狙うはタップ対象物化", () => {
  const src = read("puttgolf");
  assert.ok(src.includes("courseGesture"), "コースに useGesture が繋がっていない");
  assert.ok(src.includes("onCourseTap"), "コースタップへの接続がない");
  assert.ok(src.includes("doShoot()"), "打つへの接続が壊れている");
  assert.ok(src.includes("setState((s) => nextHole(s))"), "次のホールへへの接続が壊れている");
  assert.ok(src.includes("tappableProps(aimAtCup)"), "カップを狙うがタップ対象になっていない");
  // 旧「打つ」「次のホールへ」ボタンはどちらも classic-btn-active だった。
  assert.ok(!src.includes("classic-btn-active"), "打つ・次のホールへボタンが残っている");
  // コース面はキーボードからも打てる（Enter / Space）。
  assert.ok(src.includes('role="button"'), "コース面に role=button がない");
  assert.ok(src.includes('e.key !== "Enter" && e.key !== " "'), "コース面の Enter / Space 対応がない");
  // カップを狙うは旧ボタンの disabled 条件と同等に無効化される。
  assert.ok(src.includes('if (state.phase !== "playing" || rolling) return;'), "カップを狙うの無効条件がない");
  assert.ok(src.includes('aria-disabled={state.phase !== "playing" || rolling}'), "カップを狙うの無効表示がない");
});

test("gesture batch7: pong は難易度がタップ対象物化しコートタップで開始・ダブルタップでポーズ", () => {
  const src = read("pong");
  assert.ok(src.includes("tappableProps(() => { sfxTap(); setDifficulty(d.key); diffRef.current = d; })"), "難易度がタップ対象になっていない");
  assert.ok(src.includes("onCanvasPointerDown"), "コートタップへの接続がない");
  assert.ok(src.includes("lastPlayTapAtRef"), "ダブルタップ=ポーズの判定がない");
  assert.ok(src.includes('setPhase("paused")'), "ポーズへの接続が壊れている");
  assert.ok(!src.includes("スタート"), "スタートボタンが残っている");
  assert.ok(!src.includes(">ポーズ</button>"), "ポーズボタンが残っている");
  // 「もう一度」ボタンにフォーカスがあるときはネイティブ click に任せ、
  // window 側の開始・ポーズと二重に走らせない（falling / wordle の教訓）。
  assert.ok(src.includes('data-pong-ui=""'), "難易度・もう一度に二重発火防止の目印がない");
  assert.ok(src.includes('closest?.("[data-pong-ui]")'), "window リスナーに二重発火防止のガードがない");
  // ガードは開始・ポーズ（スペース / Enter）分岐の中だけに置く。矢印・W/S・P
  // キーには div 側のハンドラがないため、難易度等にフォーカスがあっても
  // パドル操作・P ポーズは動く（bowling の教訓）。
  assert.ok(
    src.indexOf('closest?.("[data-pong-ui]")') > src.indexOf('e.key === "ArrowUp"'),
    "二重発火防止ガードが矢印キーまで塞いでいる",
  );
  // 待機中・停止中のタップは開始・再開のみで、直後のダブルタップによる即ポーズは起きない。
  assert.ok(src.includes("lastPlayTapAtRef.current = null;\n      setPhase(\"playing\")"), "開始・再開時のダブルタップ記録の消去がない");
  // パドル位置調整の素早い2回タップがポーズになる誤発火を抑えるため、
  // ダブルタップ=ポーズは2回目が1回目とほぼ同じ高さのときにだけ発火する。
  assert.ok(src.includes("Math.abs(clientY - last.y) <= 48"), "ダブルタップ=ポーズが位置で分離されていない（パドル調整の誤ポーズ）");
});

test("gesture batch7: nurikabe はサイズ選択・盤マスがタップ対象物化し盤面下スワイプでチェック", () => {
  const src = read("nurikabe");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "down"'), "チェックが下スワイプになっていない");
  assert.ok(src.includes("onCheck()"), "チェックへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => restart(s.key))"), "サイズ選択がタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes("aria-disabled={cellDisabled}"), "数字・終局時のマスの無効化がない");
  // 旧チェックボタンの disabled 条件と同等に、プレイ中でないときのチェックは no-op。
  assert.ok(src.includes('if (state.status !== "playing") return;\n    const result = checkNurikabe(state);'), "チェックの無効条件がない");
});

test("gesture batch7: numbercode はパッド・操作がタップ対象物化し入力枠スワイプで回答・クリア", () => {
  const src = read("numbercode");
  assert.ok(src.includes("slotsGesture"), "入力枠に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "up"'), "回答するが上スワイプになっていない");
  assert.ok(src.includes('dir === "left"'), "クリアが左スワイプになっていない");
  assert.ok(src.includes("tappableProps(() => pushDigit(d))"), "数字パッドがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(backspace)"), "消すがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(clearInput)"), "クリアがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(submit)"), "回答するがタップ対象になっていない");
  // 物理キーボードの数字・Backspace・Enter での入力がある。
  assert.ok(src.includes('e.key === "Backspace"'), "Backspace での入力がない");
  assert.ok(src.includes('/^[0-9]$/.test(e.key)'), "数字キーでの入力がない");
  assert.ok(src.includes('e.key === "Enter"'), "Enter での回答がない");
  // 旧ボタンの disabled 条件と同等に、使用済み数字・空入力時の操作は無効。
  assert.ok(src.includes("aria-disabled={input.includes(d)}"), "使用済み数字の無効表示がない");
  assert.ok(src.includes("aria-disabled={!isValidNcGuess(input)}"), "回答するの無効表示がない");
  assert.ok(src.includes("data-numbercode-key"), "Enter 二重発火防止の目印がない");
  assert.ok(src.includes('closest?.("[data-numbercode-key]")'), "window リスナーに二重発火防止のガードがない");
});

test("gesture batch7: minesweeper は難易度・旗モード・盤マスがタップ対象物化", () => {
  const src = read("minesweeper");
  assert.ok(src.includes("tappableProps(() => restart(level.key))"), "難易度がタップ対象になっていない");
  assert.ok(src.includes("aria-pressed={flagMode}"), "旗モードの表示がない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes("onContextMenu"), "右クリックでの旗立てが壊れている");
  assert.ok(src.includes('e.key !== "Enter" && e.key !== " "'), "盤マスの Enter / Space 対応がない");
});

test("gesture batch7: lightsout はサイズ・難易度・盤マスがタップ対象物化し ⏱ がない", () => {
  const src = read("lightsout");
  assert.ok(src.includes("tappableProps(() => restart(s.key, difficulty))"), "サイズ選択がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => restart(size, d.key))"), "難易度がタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes('e.key !== "Enter" && e.key !== " "'), "盤マスの Enter / Space 対応がない");
  assert.ok(!src.includes("⏱"), "⏱ が残っている");
  assert.ok(src.includes("時間 {formatTime(seconds)}"), "⏱ の置換（時間表示）がない");
});

test("gesture batch7: kwordle はカタカナキー・決定・消すがタップ対象物化", () => {
  const src = read("kwordle");
  assert.ok(src.includes("tappableProps(() => press(ch))"), "カタカナキーがタップ対象になっていない");
  assert.ok(src.includes('tappableProps(() => press("ENTER"))'), "決定がタップ対象になっていない");
  assert.ok(src.includes('tappableProps(() => press("BACK"))'), "消すがタップ対象になっていない");
  // 画面キー・決定・消す・「もう一度」にフォーカスがあるときの Enter は、
  // その要素のハンドラだけが走る（wordle の教訓）。
  assert.equal((src.match(/data-kwordle-key=""/g) ?? []).length, 4, "data-kwordle-key の目印が 4 箇所ではない");
  assert.ok(src.includes('closest?.("[data-kwordle-key]")'), "window リスナーに二重発火防止のガードがない");
  // ガードは Enter 分岐の中だけに置く。Backspace・カナキーには div 側の
  // ハンドラがないため、画面キー等にフォーカスがあっても物理キーは動く。
  const enterIdx = src.indexOf('e.key === "Enter"');
  const guardIdx = src.indexOf('closest?.("[data-kwordle-key]")');
  const backIdx = src.indexOf('e.key === "Backspace"');
  assert.ok(
    enterIdx !== -1 && guardIdx !== -1 && backIdx !== -1 && enterIdx < guardIdx && guardIdx < backIdx,
    "二重発火防止ガードが Enter 分岐の中にない",
  );
});

test("gesture batch7: nurikabe の Enter は1経路のみ（二重発火防止）", () => {
  const src = read("nurikabe");
  // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
  // ガードがないとマスにフォーカスして Enter を押したときに切り替えと
  // チェックが両方走る（anagram / mastermind と同じ構図）。
  assert.ok(src.includes("e.target !== e.currentTarget"), "親子 onKeyDown のガードがない");
  assert.ok(src.includes('e.key !== "Enter"'), "盤面 Enter でのチェックがない");
});

test("gesture batch7: 8ゲームとも ⏱ が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: ⏱ が残っている`);
  }
});
