# AGO 側パッチ台帳（tact-aim プレイヤー）

`web/public/tact-aim/` は TACT-AIM-distilled のビルド成果物のコピー。
ここに記録した差分だけが AGO 側で上乗せされている。バンドルを差し替える
ときは、最新のビルド成果物に「現行パッチ」を再適用すること。

## 現行パッチ（AGO 側のみ）

### 2. オンライン既定（dist/src/main.js）

既定で TurboWarp クラウドサーバー `wss://clouddata.turbowarp.org` に
`project_id=831274817`（本家 TACT-AIM）で接続し、クラウドデータを共有する。

- `?cloud=off` でオフライン（初期スナップショット）。
- `?cloud=wss://...` で別サーバー、`?project=` で project_id 上書き
  （その場合の既定 project は従来どおり `TACT-AIM-distilled`）。
- 接続可否は 2026-11-22 に実測済み: Origin `https://agobot.app` の
  ハンドシェイクで本家の ☁ CLOUD1〜10 初期データが返ることを確認。

合わせて index.html のクラウド注意ボックスの文面をオンライン前提に変更済み。

## 本体取り込み済み（旧 AGO パッチ）

以下は AGO 側で先行適用した後、TACT-AIM-distilled 本体に取り込まれた。
現在のバンドルは本体ビルドのまま入っているので再適用は不要。

### 旧1. ペン描画のクアッド化 → 本体 pen.ts（commit 111e659）

`PenLayer.drawLine` を丸キャップ stroke から Scratch (WebGL PenSkin) と
同じクアッド描画へ（線分＝ペンサイズ分の矩形を fill、同一点はペンサイズ
四方の正方形）。ゲーム内の文字・UI は全部ペン描画で、丸キャップだと縁の
出方が原作と違って見えたため（2026-11-22 ユーザー指摘）。

### 旧3. フェス日判定の無効化 → 本体 Title.ts（commit 084f8c7）

Title の `script6`（2026-11-24〜12-24 に日数の偶奇で Festival フラグを
切り替え MOD 側へ誘導する「MODブロック（フェスデイ）」）を無効化し、
Festival は初期値 0（通常モード）固定。2026-11-22 ユーザー指示で
本体側にも同じ変更が入った。

### 旧5. フェスアクセス表示の丸ごと削除 → 本体（commit 4e3a1b6）

Stage リスト「osamepurinフェス開催中！」（フェス会場への URL 入り）と、
Title script1 の Festival=="1" で同リストを表示する分岐を、2026-11-22
ユーザー指示で本体ごと削除（transpile.py の生成除外込み）。本バンドルは
本体ビルドの globals.js / Title.js をそのままコピーしている。

### 旧4. スタンプ/描画への画像効果＋スタンプの回転中心 → 本体 runtime.ts（commit 111e659）

ユーザーのスクショ比較（正規版 TurboWarp との対比）で判明した描画差分:

- フォントコスチュームは真っ赤 (#ff0000) で、ゲームは color（色相回転）と
  brightness（加算シフト）で文字色を作るが、スタンプが効果未適用・描画も
  CSS filter の乗算近似だったため全文字が赤かった。Scratch のシェーダ計算
  をピクセル単位で再現（scratchTintedImage、結果はキャッシュ）。
- スタンプがコスチュームの回転中心を無視していた。中心が画像外にある
  コスチューム（Tutorial 枠: rotationCenterY ≈ -122）が大きくずれ、
  チュートリアル表示が画面中央に出ていた（原作は右下）。マップのタイル系
  スタンプの区切りずれも同因。draw() と同じオフセット計算を stamp() に適用。
