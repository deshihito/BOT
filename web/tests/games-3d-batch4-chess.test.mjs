// 3D化 第4バッチ（chess 単独）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣う:
// - シーンが dynamic import (ssr:false) で遅延読み込みされていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - <button> 数が現行値（9: 盤マスはループ内1要素＋昇格4＋取消1＋難易度3…等）
//   から増えていないこと（3D盤のマスはレイキャストピックに置換）
// - シーンが three-kit の共通基盤を使うこと
// - ロジック（lib/chess-*.ts）へ three が混入していないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const countButtons = (src) => (src.match(/<button/g) ?? []).length;

const client = read("app", "games", "chess", "ChessClient.tsx");
const scene = read("app", "games", "chess", "ChessScene3D.tsx");

test("3D chess: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ", () => {
  assert.match(client, /dynamic\(\(\) => import\("\.\/ChessScene3D"\), \{ ssr: false \}\)/, "dynamic import");
  assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
  assert.match(scene, /from "three"/);
  assert.match(scene, /three-kit/, "共通基盤を使う");
  assert.match(scene, /createStage/, "ステージは共通基盤から作る");
  assert.match(scene, /attachPickPointer/, "入力は共通のレイキャスト橋渡しを使う");
  assert.match(scene, /SceneBox/, "WebGL 失敗時の枠を使う");
});

test("3D chess: WebGL 失敗時は既存 2D 盤へフォールバックする", () => {
  assert.match(client, /webglFailed/, "フォールバック分岐がある");
  assert.match(client, /board2d/, "フォールバック用の既存 2D 盤を保持する");
  assert.match(client, /onFail=\{\(\) => setWebglFailed\(true\)\}/, "シーン失敗を親が受ける");
  assert.match(client, /fallback=\{board2d\}/, "SceneBox の fallback にも 2D 盤を渡す");
  assert.match(scene, /onFail/, "シーン側が失敗を通知する");
});

test("3D chess: <button> 数が現行値（9）から増えていない", () => {
  assert.ok(countButtons(client) <= 9, `ChessClient buttons=${countButtons(client)}`);
  assert.equal(countButtons(scene), 0, "シーン側に DOM ボタンは置かない（マスはピックで置換）");
});

test("3D chess: 駒6種の生成関数があり、造形で判別できる", () => {
  for (const fn of ["createPawn", "createKnight", "createBishop", "createRook", "createQueen", "createKing", "createChessPiece"]) {
    assert.match(scene, new RegExp(`export function ${fn}\\b`), `${fn} が存在する`);
  }
  // 判別の手がかり（造形要素）
  assert.match(scene, /SphereGeometry/, "ポーンの球頭・クイーンの珠に球を使う");
  assert.match(scene, /ConeGeometry/, "ナイトの耳に円錐を使う");
  assert.match(scene, /TorusGeometry/, "縁取り・冠バンドにトーラスを使う");
  assert.match(scene, /crossV|crossH/, "キングは十字で判別する");
  assert.match(scene, /muzzle/, "ナイトは馬頭（鼻先）で判別する");
  assert.match(scene, /slit/, "ビショップは切り込みで判別する");
  assert.match(scene, /merlon/, "ルークは胸壁で判別する");
  assert.match(scene, /code & 7/, "種別は駒コードの下位ビットで決める（ロジック層の規約どおり）");
});

test("3D chess: 入力は既存 onSquareClick へ 0x88 マス番号で接続する", () => {
  assert.match(client, /onSquare=\{onSquareClick\}/, "入力は既存のマスクリック処理へ接続する");
  assert.match(scene, /pickId/, "当たり判定にマス ID を持たせる");
  assert.match(scene, /onSquare\(sq\)/, "タップでマス番号を親へ渡す");
});

test("3D chess: 盤の向き・選択・合法手・チェックの表現がある", () => {
  assert.match(scene, /playerColor/, "盤の向きは playerColor に追従する");
  assert.match(scene, /canvasTexture/, "盤面は市松テクスチャ＋座標ラベルで描く");
  assert.match(scene, /selRing/, "選択中はリング＋持ち上げで示す");
  assert.match(scene, /captureRings/, "取りマスはリングで示す");
  assert.match(scene, /checkGlow/, "チェック中のキングを赤く光らせる");
  assert.match(scene, /anim/, "駒移動はスライドアニメーションにする");
  assert.match(client, /chess-promo/, "昇格選択 UI は現行 DOM のまま");
});

test("3D chess: ロジック層（lib/chess-*.ts）に three が混入していない", () => {
  for (const f of ["chess-game.ts", "chess-engine.ts", "chess-perft.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
    assert.doesNotMatch(read("lib", f), /three-kit/, `lib/${f}`);
  }
  assert.match(client, /from "@\/lib\/chess-game"/, "クライアントは既存ロジック層を使う");
});
