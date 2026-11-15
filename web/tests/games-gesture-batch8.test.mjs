// 第8バッチ ジェスチャ移行（2026-11-16 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// hearts / dragrace / airhockey / watersort / touchnumber / spotdiff /
// rushhour / peg の残りボタンはゲーム外 chrome（リセット操作）として
// 例外リスト入り済みのため、上限件数だけを固定する（各1件）。
// - dragrace / airhockey は計測・操作の即時性が本質のため pointerdown
//   直結の意図的な例外（reaction / stopwatch / pong と同じ）。
// - watersort / peg は盤面の左スワイプ=1手戻す＋U キー（solitaire /
//   freecell と同じ）。rushhour は盤面スワイプ=車を1マス動かす＋矢印キー。
// - 盤面内に子の onClick があるゲーム（watersort / rushhour / peg）は
//   useGesture の suppressClickAfterSwipe によるスワイプ直後の click 抑止
//   が働くことを、共通ヘルパーの利用で固定する（ヘルパー自体の動作は
//   batch3 のテストで検証済み）。
// - hearts の出せない札・watersort / peg の履歴空の戻す・rushhour の
//   動けない方向は、旧ボタンの disabled 条件と同等に無効化されていること
//   （backgammon のバー復帰不能の教訓）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  hearts: "HeartsClient.tsx",
  dragrace: "DragRaceClient.tsx",
  airhockey: "AirHockeyClient.tsx",
  watersort: "WaterSortClient.tsx",
  touchnumber: "TouchNumberClient.tsx",
  spotdiff: "SpotDiffClient.tsx",
  rushhour: "RushHourClient.tsx",
  peg: "PegClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = {
  hearts: 1,
  dragrace: 1,
  airhockey: 1,
  watersort: 1,
  touchnumber: 1,
  spotdiff: 1,
  rushhour: 1,
  peg: 1,
};

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch8: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch8: 残りボタンは chrome のリセット操作だけ", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
  }
});

test("gesture batch8: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch8: スワイプ系3ゲームは盤面に useGesture を使う", () => {
  for (const game of ["watersort", "rushhour", "peg"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
  // hearts / dragrace / airhockey / touchnumber / spotdiff はタップ対象物化
  // のみ（盤面スワイプを持たない。dragrace / airhockey の即時操作は
  // pointerdown 直結の手書き判定で、reaction / stopwatch と同じ意図的な例外）。
});

test("gesture batch8: ジェスチャ面は touchAction none", () => {
  for (const game of ["watersort", "rushhour", "peg"]) {
    const src = read(game);
    assert.ok(src.includes('touchAction: "none"'), `${game}: ジェスチャ面に touchAction none がない`);
  }
  // airhockey の2D盤面は HEAD から touchAction none（パドル操作用）。
  const air = read("airhockey");
  assert.ok(air.includes('touchAction: "none"'), "airhockey: 盤面に touchAction none がない");
  // dragrace の操作面はタップのみでスワイプしないため manipulation のまま。
  const drag = read("dragrace");
  assert.ok(drag.includes('touchAction: "manipulation"'), "dragrace: 操作面の touchAction が変わっている");
});

test("gesture batch8: hearts は手札・パス・次のハンドがタップ対象物化", () => {
  const src = read("hearts");
  assert.ok(src.includes("tappableProps(() => handleCardTap(id))"), "手札がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => {\n              if (selectedPass.length !== 3) return;"), "パスするがタップ対象になっていない");
  assert.ok(src.includes("setState((s) => nextHand(s))"), "次のハンドへへの接続が壊れている");
  assert.ok(!src.includes("パスする（{selectedPass.length}/3）\n          </button>"), "パスするボタンが残っている");
  // 出せない札は旧ボタンの disabled と同等に無効化される。
  assert.ok(src.includes("aria-disabled={disabled || undefined}"), "出せない札の無効表示がない");
  assert.ok(src.includes("tabIndex={disabled ? -1 : 0}"), "出せない札がフォーカス可能なまま");
  assert.ok(src.includes('if (isPassPhase) togglePassCard(id);'), "パス選択への接続が壊れている");
  assert.ok(src.includes("else if (legal.includes(id)) {"), "合法手への接続が壊れている");
});

test("gesture batch8: dragrace は難易度がタップ対象物化し操作面タップで開始・発進・シフト", () => {
  const src = read("dragrace");
  assert.ok(src.includes("tappableProps(() => restart(d.key))"), "難易度がタップ対象になっていない");
  assert.ok(!src.includes(">スタート</button>"), "スタートボタンが残っている");
  assert.ok(!src.includes("onClick={startCountdown}"), "スタートボタンへの接続が残っている");
  // 計測の即時性のため操作面は pointerdown 直結（reaction と同じ意図的な例外）。
  assert.ok(src.includes("onPointerDown={handleActionArea}"), "操作面が pointerdown 直結になっていない");
  assert.ok(src.includes("if (state.phase === \"ready\") {\n      startCountdown();"), "ready 時のタップで開始しない");
  assert.ok(src.includes("onAction={onAction}"), "3Dシーンのタップが既存の onAction から外れている（3D batch5 の接続を維持する。ready 時のタップは従来どおり no-op で、開始は操作面が担う）");
  // 「もう一度」ボタン・難易度にフォーカスがあるときの Space / Enter は、
  // その要素のハンドラだけが走る（falling / wordle の教訓）。
  assert.ok(src.includes('data-dragrace-ui=""'), "難易度・もう一度に二重発火防止の目印がない");
  assert.ok(src.includes('closest?.("[data-dragrace-ui]")'), "window リスナーに二重発火防止のガードがない");
  // ガードは Space / Enter 分岐の中だけに置く。
  const spaceIdx = src.indexOf('e.key === " "');
  const guardIdx = src.indexOf('closest?.("[data-dragrace-ui]")');
  assert.ok(spaceIdx !== -1 && guardIdx !== -1 && spaceIdx < guardIdx, "二重発火防止ガードが Space / Enter 分岐の中にない");
});

test("gesture batch8: airhockey は難易度がタップ対象物化しフィールドタップで開始・ダブルタップでポーズ", () => {
  const src = read("airhockey");
  assert.ok(src.includes("tappableProps(() => {"), "難易度がタップ対象になっていない");
  assert.ok(!src.includes(">スタート</button>"), "スタートボタンが残っている");
  assert.ok(!src.includes(">ポーズ</button>"), "ポーズボタンが残っている");
  assert.ok(src.includes("onFieldPointerDown"), "フィールドタップへの接続がない");
  assert.ok(src.includes("lastFieldTapRef"), "ダブルタップ=ポーズの判定がない");
  assert.ok(src.includes('setPhase("paused")'), "ポーズへの接続が壊れている");
  // パドル位置調整の素早い2回タップがポーズになる誤発火を抑えるため、
  // ダブルタップ=ポーズは2回目が1回目とほぼ同じ高さのときにだけ発火する（pong と同じ）。
  assert.ok(src.includes("Math.abs(e.clientY - last.y) <= 48"), "ダブルタップ=ポーズが位置で分離されていない（パドル調整の誤ポーズ）");
  assert.ok(src.includes("now - last.t <= 320"), "ダブルタップ=ポーズの時間判定がない");
  // 「もう一度」ボタン・難易度にフォーカスがあるときの Space / Enter は、
  // その要素のハンドラだけが走る（falling / wordle の教訓）。
  assert.ok(src.includes('data-airhockey-ui=""'), "難易度・もう一度に二重発火防止の目印がない");
  assert.ok(src.includes('closest?.("[data-airhockey-ui]")'), "window リスナーに二重発火防止のガードがない");
  // ガードは Space / Enter 分岐の中だけに置く。P キーには div 側の
  // ハンドラがないため、難易度等にフォーカスがあっても P ポーズは動く（bowling の教訓）。
  const spaceIdx = src.indexOf('e.key === " "');
  const guardIdx = src.indexOf('closest?.("[data-airhockey-ui]")');
  const pIdx = src.indexOf('e.key === "p"');
  assert.ok(
    spaceIdx !== -1 && guardIdx !== -1 && pIdx !== -1 && spaceIdx < guardIdx && guardIdx < pIdx,
    "二重発火防止ガードが Space / Enter 分岐の中にない",
  );
});

test("gesture batch8: watersort はボトルがタップ対象物化し左スワイプ・Uキーで1手戻す", () => {
  const src = read("watersort");
  assert.ok(src.includes("tappableProps(() => onBottle(i))"), "ボトルがタップ対象になっていない");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('if (dir === "left") doUndo();'), "左スワイプ=1手戻すへの接続が壊れている");
  assert.ok(src.includes('if (e.key === "u" || e.key === "U") doUndo();'), "Uキー=1手戻すへの接続がない");
  assert.ok(!src.includes("1手戻す"), "1手戻すボタンが残っている");
  // 旧ボタンの disabled 条件と同等：履歴が空なら無音 no-op。
  assert.ok(src.includes("if (state.history.length === 0) return;"), "履歴空の戻すガードがない");
});

test("gesture batch8: touchnumber は盤マス・サイズがタップ対象物化", () => {
  const src = read("touchnumber");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes('e.key === "Enter" || e.key === " "'), "盤マスの Enter / Space 対応がない");
  assert.ok(src.includes("tappableProps(() => restart(s))"), "サイズ選択がタップ対象になっていない");
  // 旧ボタンの disabled={cleared} と同等：済みのマスは no-op。
  assert.ok(src.includes("if (isCleared(state, index)) return;"), "済みマスの no-op ガードがない");
  assert.ok(src.includes("tabIndex={cleared ? -1 : 0}"), "済みマスがフォーカス可能なまま");
});

test("gesture batch8: spotdiff は難易度・盤マスがタップ対象物化", () => {
  const src = read("spotdiff");
  assert.ok(src.includes("tappableProps(() => restart(level.key))"), "難易度がタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes('e.key === "Enter" || e.key === " "'), "盤マスの Enter / Space 対応がない");
  assert.ok(src.includes("onTap(i)"), "盤マスタップへの接続が壊れている");
});

test("gesture batch8: rushhour は車がタップ対象物化しスワイプ・矢印キーで1マス動かす", () => {
  const src = read("rushhour");
  assert.ok(src.includes('role="gridcell"'), "車が gridcell のタップ対象になっていない");
  assert.ok(src.includes('e.key === "Enter" || e.key === " "'), "車の Enter / Space 対応がない");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("slideBySwipe"), "スワイプ=スライドへの接続がない");
  assert.ok(src.includes("rushSlideOptions(state, car.id).includes(delta)"), "非法な方向へのスライド防止がない");
  assert.ok(src.includes('e.key === "ArrowLeft"'), "矢印キー=スライドへの接続がない");
  assert.ok(!src.includes('className="classic-btn classic-btn-active"'), "移動ボタンが残っている");
  assert.ok(src.includes("スワイプ（または矢印キー）で1マスずつ動かせます"), "スワイプのヒント表示がない");
});

test("gesture batch8: peg は盤マスがタップ対象物化し左スワイプ・Uキーで1手もどす", () => {
  const src = read("peg");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes('e.key === "Enter" || e.key === " "'), "盤マスの Enter / Space 対応がない");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('if (dir === "left") undo();'), "左スワイプ=1手もどすへの接続が壊れている");
  assert.ok(src.includes('if (e.key === "u" || e.key === "U") undo();'), "Uキー=1手もどすへの接続がない");
  assert.ok(!src.includes("1手もどす"), "1手もどすボタンが残っている");
});

test("gesture batch8: 8ゲームとも ⏱ が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: ⏱ が残っている`);
  }
});
