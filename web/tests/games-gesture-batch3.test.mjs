// 第3バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// falling / solitaire / pentomino / wordle / tsume / sudoku / maze の
// 「もう一度」はゲーム外 chrome（リセット操作）として例外リスト入り済みの
// ため、上限件数だけを固定する。battleship は 0 件。
// - falling / wordle は window キーリスナーと div のキー対応が重なるため、
//   Space / Enter の二重発火防止ガードを固定する（reaction の教訓）。
// - solitaire は横スワイプだけの盤面のため touchAction が pan-y であり、
//   縦スクロールを奪わないことを固定する（他ゲームは none）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  falling: "FallingClient.tsx",
  solitaire: "SolitaireClient.tsx",
  pentomino: "PentominoClient.tsx",
  battleship: "BattleshipClient.tsx",
  wordle: "WordleClient.tsx",
  tsume: "TsumeClient.tsx",
  sudoku: "SudokuClient.tsx",
  maze: "MazeClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { falling: 1, solitaire: 1, pentomino: 1, battleship: 0, wordle: 1, tsume: 1, sudoku: 1, maze: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch3: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch3: 残りボタンは chrome のリセット操作「もう一度」だけ", () => {
  for (const game of ["falling", "solitaire", "pentomino", "wordle", "tsume", "sudoku", "maze"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
    assert.ok(
      buttons[0].includes("restart") || buttons[0].includes("startProblem"),
      `${game}: 残りボタンが再開に繋がっていない`,
    );
  }
});

test("gesture batch3: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch3: スワイプ系7ゲームは盤面に useGesture を使う", () => {
  for (const game of ["falling", "solitaire", "pentomino", "battleship", "tsume", "sudoku", "maze"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
});

test("gesture batch3: falling は盤面ジェスチャで移動・回転・落下・ホールド", () => {
  const src = read("falling");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("act(moveLeft)"), "左移動への接続が壊れている");
  assert.ok(src.includes("act(moveRight)"), "右移動への接続が壊れている");
  assert.ok(src.includes("act(softDrop)"), "ソフトドロップへの接続が壊れている");
  assert.ok(src.includes("actHardDrop()"), "ハードドロップへの接続が壊れている");
  assert.ok(src.includes("rotatePiece(s, 1)"), "回転への接続が壊れている");
  assert.ok(src.includes("actHold()"), "ホールドへの接続が壊れている");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});

test("gesture batch3 (review): falling の Space は1経路のみ（二重発火防止）", () => {
  const src = read("falling");
  // HOLD・一時停止の div にフォーカスがあるときの Space は tappableProps が受け、
  // window リスナー側は data-falling-ui ガードで無視する。両方が受けると
  // ホールドと同時にハードドロップが走る（reaction の Space 二重発火と同じ構図）。
  assert.ok(src.includes("data-falling-ui"), "二重発火防止の目印 data-falling-ui がない");
  assert.ok(src.includes('closest?.("[data-falling-ui]")'), "window リスナーに Space のガードがない");
  // 「もう一度」ボタンも目印を持つ（フォーカス時の Space でハードドロップが
  // 走ってから再開するのを防ぐ。Enter は window 側が扱わないため対象外）。
  const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 1, "もう一度ボタンが1件ではない");
  assert.ok(buttons[0].includes("data-falling-ui"), "もう一度ボタンに data-falling-ui がない");
});

test("gesture batch3: solitaire は盤面スワイプでもどる・自動移動、札はタップ対象", () => {
  const src = read("solitaire");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "もどるが左スワイプになっていない");
  assert.ok(src.includes('dir === "right"'), "自動移動が右スワイプになっていない");
  assert.ok(src.includes("undo()"), "もどるへの接続が壊れている");
  assert.ok(src.includes("autoAll()"), "自動移動への接続が壊れている");
  assert.ok(src.includes("autoFinishSolitaire(game)"), "自動で仕上げるへの接続が壊れている");
  assert.ok(src.includes("tappableProps(onClick)"), "札がタップ対象になっていない");
  // 横スワイプだけの盤面のため縦スクロールを奪わない（touchAction は pan-y）。
  assert.ok(src.includes('touchAction: "pan-y"'), "盤面の touchAction が pan-y になっていない");
});

test("gesture batch3: pentomino はプレビュー操作で回転・反転、盤マスはタップ対象", () => {
  const src = read("pentomino");
  assert.ok(src.includes("previewGesture"), "選択中ピースの表示に useGesture が繋がっていない");
  assert.ok(src.includes("rotatePentOrientation(selected, o)"), "回転への接続が壊れている");
  assert.ok(src.includes("flipPentOrientation(selected, o)"), "反転への接続が壊れている");
  assert.ok(src.includes("onCell(index)"), "盤マスのタップへの接続が壊れている");
  assert.ok(src.includes("selectPiece(def.id)"), "パレットの選択への接続が壊れている");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
});

test("gesture batch3: battleship は配置盤スワイプで全消し・ランダム・確定、攻撃マスはタップ対象", () => {
  const src = read("battleship");
  assert.ok(src.includes("placementGesture"), "配置盤に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "全消しが左スワイプになっていない");
  assert.ok(src.includes('dir === "right"'), "ランダム配置が右スワイプになっていない");
  assert.ok(src.includes('dir === "up"'), "確定が上スワイプになっていない");
  assert.ok(src.includes("confirmPlacement()"), "確定への接続が壊れている");
  assert.ok(src.includes("randomPlace()"), "ランダム配置への接続が壊れている");
  assert.ok(src.includes("setPlaced([])"), "全消しへの接続が壊れている");
  assert.ok(src.includes("fire(index)"), "射撃への接続が壊れている");
  assert.ok(src.includes('touchAction: "none"'), "配置盤に touchAction none がない");
});

test("gesture batch3: wordle は画面キーボードをタップ対象化、物理キーも残置", () => {
  const src = read("wordle");
  assert.ok(src.includes("data-wordle-key"), "画面キーに目印 data-wordle-key がない");
  assert.ok(src.includes('press("ENTER")'), "決定への接続が壊れている");
  assert.ok(src.includes('press("BACK")'), "1文字消すへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => press(letter))"), "文字キーがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => startGame("), "モード選択がタップ対象になっていない");
});

test("gesture batch3 (review): wordle の Enter は1経路のみ（二重発火防止）", () => {
  const src = read("wordle");
  // 画面キー div にフォーカスがあるときの Enter は tappableProps が受け、
  // window リスナー側は data-wordle-key ガードで無視する。両方が受けると
  // 1回の Enter で2回 submit される（reaction の Space 二重発火と同じ構図）。
  assert.ok(src.includes('closest?.("[data-wordle-key]")'), "window リスナーに Enter のガードがない");
  // Enter を受ける要素はすべて目印を持つこと。モード切替・コピー・もう一度に
  // 目印がないと、フォーカス時の Enter で div/button の処理と window 側の
  // press("ENTER") が両方走り、開始したばかりの新規ゲームが古い推測で上書きされる。
  // 内訳: 画面キーボードのテンプレート3 + ガード文字列1 + モード2 + コピー1 + もう一度1 = 8。
  const count = (src.match(/data-wordle-key/g) ?? []).length;
  assert.equal(count, 8, `data-wordle-key が ${count} 件（期待 8 件）`);
});

test("gesture batch3: tsume は盤面左スワイプで1手戻す、駒・持ち駒はタップ対象", () => {
  const src = read("tsume");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "1手戻すが左スワイプになっていない");
  assert.ok(src.includes("undoAttackerMove(s)"), "1手戻すへの接続が壊れている");
  assert.ok(src.includes("onCell(i)"), "盤マスのタップへの接続が壊れている");
  assert.ok(src.includes("doMove(m)"), "成り・不成の選択への接続が壊れている");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});

test("gesture batch3: sudoku は盤面上スワイプでヒント、数字パッドはタップ対象", () => {
  const src = read("sudoku");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "up"'), "ヒントが上スワイプになっていない");
  assert.ok(src.includes("onHint()"), "ヒントへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => onPad(n))"), "数字パッドがタップ対象になっていない");
  assert.ok(src.includes("onPad(Number(e.key))"), "物理キーボードの数字入力がない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});

test("gesture batch3: maze は盤面スワイプで移動、D-pad 廃止", () => {
  const src = read("maze");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("doMove(dir)"), "スワイプが移動に繋がっていない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
  assert.ok(!src.includes("padBtn"), "D-pad の残骸がある");
});

test("gesture batch3: 対象8ゲームに絵文字の時計記号が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: 絵文字の時計記号が残っている`);
  }
});

// ---- レビュー追加（第3バッチレビュー）: スワイプ直後の click 抑止 ----
// useGesture の盤面内に子の onClick があるゲーム（solitaire / tsume / sudoku /
// battleship）では、pointerdown/up が同一セルで終わる短いスワイプ（閾値24px以上・
// セル幅32〜70px以内で成立し得る）の直後にブラウザが click を dispatch し、
// スワイプ処理とタップ処理が両方走る。古い state クロージャの onClick が
// undo/ランダム配置の結果を上書きするため、共通ヘルパー側で抑止する。
import ts from "typescript";

async function loadGestureHelper() {
  const src = fs.readFileSync(path.join(webDir, "lib", "gesture.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const body = js
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
  const code = body + "\nexport { suppressClickAfterSwipe };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

test("gesture batch3 (review): useGesture はスワイプ直後の click を抑止する", () => {
  const src = fs.readFileSync(path.join(webDir, "lib", "gesture.ts"), "utf8");
  assert.ok(src.includes("export function suppressClickAfterSwipe"), "click 抑止ヘルパーがない");
  assert.ok(
    src.includes("suppressClickAfterSwipe(e.currentTarget)"),
    "useGesture のスワイプ分岐が click 抑止を呼んでいない",
  );
});

test("gesture batch3 (review): スワイプ直後の click 抑止が1回だけ働き、無ければ解除される", async () => {
  const { suppressClickAfterSwipe } = await loadGestureHelper();
  const mockElement = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn, opts) {
        listeners.set(type, { fn, opts });
      },
      removeEventListener(type, fn) {
        if (listeners.get(type)?.fn === fn) listeners.delete(type);
      },
    };
  };
  // スワイプ直後の click は preventDefault + stopPropagation で抑止される。
  const el = mockElement();
  suppressClickAfterSwipe(el);
  const entry = el.listeners.get("click");
  assert.ok(entry, "click 抑止リスナーが付いていない");
  assert.equal(entry.opts?.capture, true, "capture フェーズで抑止していない");
  let prevented = false;
  let stopped = false;
  entry.fn({
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.ok(prevented && stopped, "click が抑止されていない");
  // click が来ない場合もタイマーで解除され、後続の正規タップを奪わない。
  const el2 = mockElement();
  suppressClickAfterSwipe(el2);
  assert.equal(el2.listeners.size, 1, "抑止リスナーが付いていない");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(el2.listeners.size, 0, "click が来なかった場合の解除がない");
  // 要素なしでも落ちない。
  assert.doesNotThrow(() => suppressClickAfterSwipe(null));
  assert.doesNotThrow(() => suppressClickAfterSwipe(undefined));
});
