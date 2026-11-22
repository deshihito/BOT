# AGO 側パッチ一覧（このバンドルだけの変更）

このディレクトリのプレイヤーは TACT-AIM-distilled のビルド成果物のコピーだが、
AGO 側の運用判断として以下のパッチを当てる。**TACT-AIM-distilled 本体には入れない**
（distilled は原作の純粋なコピーとして扱う方針、2026-11-22 ユーザー指示）。

バンドルを distilled の新しいビルドで差し替えたら、このパッチを再適用すること。

## 1. ペン描画を Scratch 寄りに（dist/src/runtime/pen.js）

`PenLayer.drawLine` を Canvas の stroke（丸キャップ＋丸ジョイント）から、
Scratch（WebGL PenSkin）と同じクアッド描画に変更:

- 線分を「ペンサイズ分の矩形」として fill する。端は平ら、継ぎ目は原作どおり
  重なりと欠けが出る。
- 同一点はペンサイズ四方の正方形（Scratch のペン下ろし点）。

理由: ゲーム内の文字・UI は全部ペン描画で、丸キャップだと縁の出方が原作と
違って見えたため（2026-11-22 ユーザー指摘）。

## 2. オンライン既定（dist/src/main.js）

既定で TurboWarp クラウドサーバー `wss://clouddata.turbowarp.org` に
`project_id=831274817`（本家 TACT-AIM）で接続し、クラウドデータを共有する。

- `?cloud=off` でオフライン（初期スナップショット）。
- `?cloud=wss://...` で別サーバー、`?project=` で project_id 上書き
  （その場合の既定 project は従来どおり `TACT-AIM-distilled`）。
- 接続可否は 2026-11-22 に実測済み: Origin `https://agobot.app` の
  ハンドシェイクで本家の ☁ CLOUD1〜10 初期データが返ることを確認。

合わせて index.html のクラウド注意ボックスの文面をオンライン前提に変更済み。

## 3. フェス日判定の無効化（dist/src/distilled/Title.js）

Title の `script6`（フェス日判定ブロック）を即 return に置換し、無効化:

- 原作は 2026-11-24〜12-24 の間、日数の偶奇（mod 2）で `Festival` フラグを
  切り替え、フェスの日はタイトルが「Festival!」表示になり MOD 側へ誘導する
  （ユーザー呼称「MODブロック（フェスデイ）」）。
- AGO 側ではこれを外し、`Festival` は初期値 0（通常モード）のままにする。
  2026-11-22 ユーザー指示。

## 4. スタンプ/描画への画像効果の適用（dist/src/runtime/runtime.js）

本作のフォントコスチュームは真っ赤 (#ff0000) で、ゲームは画像効果の
color（色相回転）と brightness（白/黒への加算シフト）で文字色を作る。
従来のプレイヤーはスタンプに効果を一切適用せず（alpha=1 固定）、スプライト
描画も CSS filter の brightness()（乗算）近似だったため、**全ての文字が
赤いまま**表示されていた（例: HP 表示は brightness 100 で白になるべき）。

- `_scratchTintedImage` を追加: Scratch (scratch-render) のシェーダと同じ
  計算（color = HSV 色相を 値/200 回転、brightness = RGB に 値/100*255 を
  加算）をピクセル単位で適用し、(画像, 効果値) でキャッシュする。
- `Sprite.stamp()` が color / brightness / ghost を引き継ぐよう変更。
- `Sprite.draw()` の CSS filter 近似を同じ計算に置換。
- fisheye / whirl / pixelate / mosaic は従来どおり未再現（値のみ保持）。
- 2026-11-22、ユーザーのスクリーンショット比較（正規版 TurboWarp との
  対比）で判明。TACT-AIM-distilled 本体のランタイムにも同修正が要るが、
  まずは AGO 側のみ（本体へ入れるかはユーザーの判断待ち）。
