# web ゲーム ジェスチャ移行ブラッシュアップ 作業ログ

方針（ユーザー裁定 2026-11-13/14）: 実行操作は対象物へのタップ/スワイプ/ドラッグ/フリックに一本化し、並行ボタンを残さない。UIに絵文字を使わない。共通基盤（lib/gesture.ts、lib/sfx.ts、GameJuice）に寄せる。GitHub書き込み禁止（親が08:00に一括出荷）。

## テスト基準
- ベースライン（BOT-srank HEAD=main #793, 2ae30eb、npm ci 後）: web tests **1379 / 1379 pass**
- 計測方法: `cd web && npm test` / `npx tsc --noEmit`

## 共通基盤（新規）
- `web/lib/gesture.ts`: `swipeDirection(dx,dy,threshold)` 純粋関数 + `useGesture({onSwipe,onTap,onDoubleTap})` フック（pointer events、ダブルタップ時は単発タップを320ms遅延）+ `tappableProps()`（div role=button 用キーボード対応）。配置は既存慣習に合わせ lib 直下（lib/games ディレクトリは存在しなかった）。
- 既存SEは全ゲームとも lib/sfx.ts の合成音をジェスチャ実行時にもそのまま使用（新規アセットなし）。

## 第1バッチ（完了）— 2026-11-13
| ゲーム | マッピング | <button> |
|---|---|---|
| snake | 盤面スワイプ=方向転換、タップ=開始/ポーズ/再開（D-pad廃止、キーボード残置） | 7→0 |
| blackjack | 手札/テーブル: タップ=ヒット、下スワイプ=スタンド、ダブルタップ=ダブル。ベット中タップ=配る、結果中タップ=次ラウンド、チップ切れタップ=再支給。ベットチップはチップ自体のタップ（div化） | 7→0 |
| slot | レバー/リール下スワイプ=スピン（レバー描画追加、回転中ノブが下がる）。チップは div 化。チップ切れ時は筐体タップ=再支給 | 3→0 |
| highlow | カードエリア上スワイプ=高い、下スワイプ=低い（ボタンの見た目は非ボタンのヒント帯に置換） | 2→0 |
| diceroll | ※実物は「サイコロを転がしてゴールへ運ぶパズル」だった（個数選択式ダイスではない）。盤面スワイプ=その方向へ転がす（方向ボタン廃止、矢印キー残置） | 6→2（例外: リセット系 chrome） |
| chinchiro | 丼のサイコロ タップ/フリック=振る・振り直す。確定は役表示オブジェクトのタップ、次のラウンドは結果オブジェクトのタップ | 4→1（例外: もう一度 chrome） |
| roulette | ホイール フリック/スワイプ=スピン。賭け種別・金額はタップ対象物（div）化。チップ切れ時はホイールタップ=再支給 | 5→0 |
| janken | オンライン対戦。手の <button> を手カード（div role=button、Enter/Space対応）のタップに置換 | 1→0 |

- 新規テスト `web/tests/games-gesture-batch1.test.mjs`（11件）: swipeDirection 判定 + 8ゲームのボタン予算 + 共通ヘルパー利用の静的検査。
- 実施後: **1390 / 1390 pass**、tsc クリーン。
- 例外リスト（第1バッチ）: diceroll「もう一度/最初から」、chinchiro「もう一度」= ゲーム外 chrome のリセット操作。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。

## 第2バッチ（実施中）— 2026-11-14
対象選定（実コード確認済み、核アクションがボタンのオフライン単独ゲーム優先）:
dicequest / yahtzee / sugoroku / baccarat / drawpoker / reaction / stopwatch / montecarlo

| ゲーム | マッピング | <button> |
|---|---|---|
| dicequest | 変更済み（第1バッチ前から）。ダイス置き場タップ/フリック=振る・パス、光るマス タップ=チェック。残1件は「もう一度」chrome（例外） | 1（例外: もう一度 chrome） |
| yahtzee | 変更済み。ダイストレイ タップ/フリック=振る、ダイス タップ=保持、スコア行 タップ=記録。残1件は「もう一度」chrome（例外） | 1（例外: もう一度 chrome） |
| sugoroku | 変更済み。盤面タップ/フリック=サイコロ、自動進行トグルは div 化済み。残1件は「もう一度」chrome（例外）。本バッチで盤面に role="button" + Enter/Space キー対応を追加（元は role="img" でキーボードから振れなかった）、陳腐化した冒頭コメントを修正 | 1（例外: もう一度 chrome） |
| baccarat | テーブル（両ハンド）タップ/フリック: 賭け中=配る、チップ切れ=再支給、結果中=次のラウンドへ。賭け先3種・賭け金4額は div（tappableProps）化。配る/次へ/再支給ボタン廃止 | 5→0 |
| drawpoker | カード置き場タップ: 賭け中・確定後=配る/次ラウンド、チップ切れ=再支給。交換中は置き場の下スワイプ=交換確定（キーボードは置き場フォーカス時の Enter/Space）。札は div（tappableProps）化=交換選択、ベット額は div 化。配る/確定/再支給ボタン廃止。startRound がベット超過を弾くためタップ誤配なし | 5→0 |
| reaction | 変更済み（0件）。大エリア面の onPointerDown 直結で開始・待機・計測・再挑戦をすべてタップで実施。useGesture（pointerup 発火）には寄せていない — 反応計測は pointerdown の即時性が本質のため意図的に直結。死コードの未使用 btn/activeBtn スタイルを除去 | 0 |
| stopwatch | 変更済み（0件）。時計面の onPointerDown 直結で開始・停止。reaction と同じく計測の即時性のため useGesture には寄せていない。ブラインドモードのチェックボックスは設定用フォーム部品のため残置（実行操作ではない） | 0 |
| montecarlo | 札は div（role="gridcell"、Enter/Space 対応）化=タップで選択・ペア除去。盤面の下スワイプ=詰める（山札から補充）。詰めるボタン廃止。残1件は「もう一度」chrome（例外）。SE は lib/sfx.ts の合成音を追加（選択 sfxTap / 除去 sfxPop / 詰める sfxFlip） | 3→1（例外: もう一度 chrome） |

- 新規テスト `web/tests/games-gesture-batch2.test.mjs`（16件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続の静的検査。
- 例外リスト（第2バッチ追加）: dicequest / yahtzee / sugoroku / montecarlo の「もう一度」= ゲーム外 chrome のリセット操作。第1バッチと同じ扱い。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記: reaction / stopwatch の onPointerDown 直結は、計測ゲームの即時性（pointerup 待ちの遅延を入れない）が理由の意図的な例外。共通ヘルパー不使用だが、タップ主体の一本化という方針自体は満たしている。

## 第2バッチ（完了）— 2026-11-14 04:00〜05:00 JST
- 実施後: **1406 / 1406 pass**（第1バッチ後 1390 + 新規16件）、`npx tsc --noEmit` クリーン。
- 実施中の修正1件: drawpoker の aria-label 末尾でテンプレートリテラルの閉じバッククォートが `"` に化けて tsc エラー7件 → 修正して再実行でクリーン確認済み（静的検査テストのみでは検出できないため tsc が必須）。
- 変更ファイル: web/app/games/{baccarat,drawpoker,montecarlo,reaction,stopwatch,sugoroku}/各Client.tsx、web/tests/games-gesture-batch2.test.mjs（新規）、FINDINGS-gesture.md。dicequest / yahtzee は変更なし（残ボタンが chrome 例外であることを実コードで確認のみ）。
- 対象外（balku / lll / online / chess）には触れていない。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。

## 第2バッチ レビュー（Bレビュー）— 2026-11-14 05:00〜 JST
- 結論: **指摘あり（3件ともレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1408 / 1408 pass**（第2バッチ完了時 1406 + レビュー追加の回帰テスト2件）、`npx tsc --noEmit` クリーン。
- 観点別確認（実コード精査）:
  1. ボタン予算: baccarat 0 / drawpoker 0 / montecarlo 1（もう一度 chrome）/ sugoroku 1（同）/ reaction 0 / dicequest 1（同）/ yahtzee 1（同）/ stopwatch 0 — すべて予算通り。残ボタンは全て `onClick={restart}` の「もう一度」のみ。
  2. 絵文字: pictographic 絵文字なし。♠♥♦♣（baccarat/drawpoker/montecarlo のカード表記、HEAD から既存）および dicequest の ▶/◀（方向表示、既存）はテキスト記号として許容。
  3. 共通基盤: 6ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用。SE は `lib/sfx.ts` の合成音のみ。例外は reaction/stopwatch の onPointerDown 直結で、計測即時性のため意図的設計として承認（テストでも固定）。montecarlo の札だけ `tappableProps` ではなく onClick + onKeyDown 直書きだが、role="gridcell" には `tappableProps`（role="button" 固定）が使えないため妥当。
  4. キーボード: baccarat テーブル、drawpoker 置き場・札・ベット額、montecarlo 札（gridcell）、sugoroku 盤面、dicequest 置き場・マス、yahtzee トレイ・ダイス・スコア行、reaction/stopwatch の計測面 — すべて Enter/Space 対応あり。reaction は下記指摘1を修正。
  5. テスト: batch2 の16件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・pointerdown 直結を検証）。レビューで2件追加し 18件とした。
  6. ロジック: baccarat は `placeBaccaratBet` がベット超過を throw → エラー表示、`nextBaccaratRound`/`refillBaccarat` はフェーズ・残高ガード付き。drawpoker は `startRound` が不正ベットを同一 state 返却で弾く（タップ誤配なし）、`drawCards` はフェーズガード付き。montecarlo は `montecarloRemovePair`/`montecarloConsolidate` ともに `status !== "playing"` を返す。sugoroku/dicequest/yahtzee の状態遷移も読める範囲で正しい。
- 指摘1（機能バグ・修正済み）reaction の Space 二重発火: 計測エリア div の `onKeyDown` が Space でも `handleTap()` を呼び、window の Space リスナーも同じキーで `handleTap()` を呼ぶため、エリアにフォーカスがある状態での Space が1回で2回走っていた。影響: 開始 Space → 開始直後にフライング判定、ready 最終回 Space → 結果記録直後にセッション再開（結果画面を飛ばす）、idle Space → 次ラウンド開始直後にフライング。バッチ2でエリアが `<button>`→`<div role="button">` 化＋`onKeyDown` 追加された際に発生した回帰。対応: エリア側は Enter のみ受け、Space は window リスナーに一本化（`ReactionClient.tsx` に理由コメント付き）。回帰テストを batch2 に追加（`e.key === " "` が0件＋window リスナー存続を検証）。
- 指摘2（軽微・修正済み）sugoroku の盤面に `touchAction: "none"` がなく、`useGesture` の用法（docstring に明記）と他ゲームと不一致。タッチ端末でフリックがページスクロールに奪われ pointercancel になり得る。対応: 盤面 style に追加。回帰テスト追加。
- 指摘3（軽微・修正済み）dicequest のダイス表示中の置き場 div（`{...diceGesture}`）に `touchAction: "none"` がなく、choice 局面のスワイプ＝パスが同じくスクロールに奪われ得る（空の置き場側にはあった）。対応: 追加。回帰テスト追加（置き場2面とも none であることを件数で検証）。
- 注記（修正せず・差し戻し対象外）: (a) montecarlo の札は `role="gridcell"` に `aria-pressed` を付与しているが ARIA 的には gridcell に無効な属性。role を変えるとテストも変わるため今回は注記のみ。 (b) drawpoker はベット超過時の置き場タップが無音・無表示の no-op になる（`startRound` が同一 state を返すため。警告文自体は表示済み）。旧ボタン時と同一の挙動のため許容。 (c) dicequest は choice 局面の置き場タップ＝パス（失敗+1）が意図設計。誤タップの余地はあるがヒント文で明示済みのため許容。
- 記録訂正: FINDINGS の第2バッチ表で reaction「死コード除去のみ」・sugoroku「キーボード対応＋コメント修正のみ」・dicequest/yahtzee/stopwatch「変更なし」とあるが、HEAD（2ae30eb）との差分では reaction は計測エリアの button→div 化＋開始ボタン廃止、sugoroku は「サイコロを振る」ボタン廃止＋自動進行の div 化（▶/⏸ の除去含む）、dicequest/yahtzee/stopwatch もジェスチャ移行そのものが未コミット差分に含まれていた。レビューは差分どおりの現状コードを対象に実施し、上記のとおり問題なし（修正3件を除く）。
- レビューでの変更ファイル: web/app/games/reaction/ReactionClient.tsx、web/app/games/sugoroku/SugorokuClient.tsx、web/app/games/dicequest/DiceQuestClient.tsx、web/tests/games-gesture-batch2.test.mjs（回帰テスト2件追加 → 18件）、FINDINGS-gesture.md（本節追記）。GitHub・Discord・Pi 操作なし。

## 第3バッチ（完了）— 2026-11-14 04:20〜05:30 JST
対象選定: 04:20 JST 時点の `<button>` 数実測でボタン最多のオフライン単独ゲーム8本（battleship はオンライン対戦だが janken と同じく自コンポーネントのみが対象で OnlineShell には触れていない）。wordle・sudoku のキーボード／数字パッドは核入力のため、パッド自体をタップ対象物化し物理キーも残置する形で置き換え（無理なジェスチャ化はしていない）。

| ゲーム | マッピング | <button> |
|---|---|---|
| falling | 盤面スワイプ: 左右=移動、下=ソフトドロップ、上=ハードドロップ、タップ=回転。HOLD 表示タップ=ホールド、一時停止表示タップ=一時停止。操作パッド6ボタン廃止 | 9→1（例外: もう一度 chrome） |
| solitaire | 札・空きスロットは div（tappableProps、ダブルタップ=組札へは onDoubleClick 維持）。盤面の左右スワイプ: 左=もどる、右=組札へ自動移動（仕上げ可能なら自動で仕上げる）。もどる／自動移動／仕上げるボタン廃止 | 8→1（例外: もう一度 chrome） |
| pentomino | パレット・盤マスは div 化。選択中ピース表示のタップ=回転、左右スワイプ=反転。外す／選択解除ボタンは廃止（外す=選択解除→配置済みマスをタップ、選択解除=パレット再タップで代替）。盤面サイズ選択は div 化 | 8→1（例外: もう一度 chrome） |
| battleship | 艦選択・向き切替は div 化。配置盤: マスタップ=配置／配置済み艦タップ=その艦を取り消し、左スワイプ=全消し、右スワイプ=ランダム配置、上スワイプ=配置を確定。1隻取り消し／全消し／ランダム／確定ボタン廃止。攻撃マスは div 化（タップ=射撃）。配置数をヒント文に表示 | 8→0 |
| wordle | モード選択・画面キーボード（26文字＋Enter＋⌫）・結果コピーは div（tappableProps）化。物理キーボードは window リスナーで残置。画面キーの Enter は div 側のみが受け、window 側はガードで無視（二重発火防止） | 7→1（例外: もう一度 chrome） |
| tsume | 問題選択・持ち駒・成り／不成／やめるは div 化。盤マスは div（gridcell）化。盤面の左スワイプ=1手戻す。1手戻すボタン廃止 | 7→1（例外: もう一度 chrome） |
| sudoku | 難易度選択・メモ切替は div 化。盤マス・数字パッド（1〜9＋消す）は div 化。盤面の上スワイプ=ヒント（ヒントボタン廃止、残り回数はステータス表示へ移行）。物理キーボードの 1〜9 / Backspace / Delete での入力を新規追加 | 7→1（例外: もう一度 chrome） |
| maze | サイズ選択・最短路ヒント切替は div 化。盤面スワイプ=移動（D-pad 4ボタン廃止）。ステータスの絵文字 ⏱ を「時間」に置換 | 7→1（例外: もう一度 chrome） |

- 新規テスト `web/tests/games-gesture-batch3.test.mjs`（22件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続 + falling/wordle の二重発火防止ガード + touchAction（solitaire は pan-y）+ ⏱ 残存なしの静的検査。
- 実施後: **1430 / 1430 pass**（第2バッチ＋レビュー後 1408 + 新規22件）、`npx tsc --noEmit` クリーン。
- 例外リスト（第3バッチ追加）: falling / solitaire / pentomino / wordle / tsume / sudoku / maze の「もう一度」= ゲーム外 chrome のリセット操作。第1・第2バッチと同じ扱い。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記:
  - 二重発火防止（reaction の教訓を先回り）: falling は HOLD・一時停止 div にフォーカスがあるときの Space を window リスナー側で `data-falling-ui` ガードにより無視（div 側の tappableProps のみが受ける）。wordle は画面キー div にフォーカスがあるときの Enter を window リスナー側で `data-wordle-key` ガードにより無視。両方とも回帰テストで固定。
  - solitaire の盤面は横スワイプだけのため `touchAction: "pan-y"`（縦スクロールを奪わない）。他ゲームのジェスチャ面は `touchAction: "none"`。レビュー指摘2・3の趣旨（フリックがスクロールに奪われないこと）は横方向について満たしており、縦方向は意図的にスクロールへ譲っている。
  - battleship の配置操作ヘルパー（tryPlace / randomPlace / confirmPlacement）と配置盤の useGesture は、フェーズ遷移でフック数が変わらないよう Board のトップレベルに置いた（placing 分岐内ではフックを呼ばない）。
  - pentomino のプレビュー面は useGesture＋手書き onKeyDown（Enter/Space=回転）。window リスナーが存在しないため二重発火の余地はない。montecarlo の札と同じ手書きパターン。
  - solitaire の札は `tappableProps`＋ネイティブ onDoubleClick（ダブルタップ=組札へ）。useGesture の onDoubleTap だと単発タップが320ms遅延するため、既存の即時タップ挙動を維持する選択。
  - sudoku は従来キーボード数字入力がなかったため、1〜9 / Backspace / Delete の window リスナーを新規追加した（パッド div は Enter/Space のみ受けるため数字キーとの二重発火なし）。
  - maze・sudoku のステータスにあった ⏱（絵文字）を「時間」に置換。♠♥♦♣（solitaire のカード表記）・●◎（maze の現在位置／ゴール）・↻（solitaire の再循環）・→（tsume の手順表示）はテキスト記号として既存のまま許容。
- 変更ファイル: web/app/games/{falling,solitaire,pentomino,battleship,wordle,tsume,sudoku,maze}/各Client.tsx、web/tests/games-gesture-batch3.test.mjs（新規）、FINDINGS-gesture.md。対象外（balku / lll / online / chess）には触れていない（battleship は自コンポーネントのみ変更し、online/OnlineShell には触れていない）。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。

## 第3バッチ レビュー（Bレビュー）— 2026-11-14 05:30〜 JST
- 結論: **指摘あり（3件ともレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1432 / 1432 pass**（第3バッチ完了時 1430 + レビュー追加の回帰テスト2件）、`npx tsc --noEmit` クリーン。
- 観点別確認（実コード精査）:
  1. ボタン予算: falling 1 / solitaire 1 / pentomino 1 / battleship 0 / wordle 1 / tsume 1 / sudoku 1 / maze 1 — すべて予算通り。残ボタンは全て `onClick={restart}` 系の「もう一度」のみ。
  2. 絵文字: pictographic 絵文字なし。←→↓↑（falling の操作説明など）・↻（solitaire の再循環）・✕（battleship の命中表示）・⌫（wordle の削除キー）・●◎（maze の現在位置／ゴール）・→（tsume の手順表示）はテキスト記号として許容。⏱ は8ゲームとも残存なし。
  3. 共通基盤: 8ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用。SE は `lib/sfx.ts` の合成音のみ（battleship のみ `lib/balku-sound` の playSe — HEAD から既存でバッチ3は変更していないため許容）。例外は pentomino の盤マス・battleship の攻撃マス等の手書き onClick + onKeyDown で、role="gridcell" には `tappableProps`（role="button" 固定）が使えないため montecarlo と同じく妥当。
  4. キーボード: falling（window 矢印キー等＋HOLD・一時停止 div）、solitaire（札・空きスロット・山札）、pentomino（パレット・盤サイズ・プレビュー・盤マス）、battleship（艦選択・向き・配置マス・攻撃マス）、wordle（画面キー・モード・コピー）、tsume（問題・持ち駒・盤マス・成り不成）、sudoku（難易度・メモ・盤マス・数字パッド）、maze（サイズ・ヒント・矢印キー/WASD）— すべて Enter/Space 対応あり。falling/wordle は下記指摘2・3を修正。ただし solitaire のもどる・自動移動、tsume の1手戻す、battleship の全消し・ランダム・確定にはキーボード経路がない（下記指摘4・要判断）。
  5. テスト: batch3 の22件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・二重発火ガード・touchAction・⏱ なしを検証）。レビューで2件追加し 24件とした。
  6. ロジック: falling は `act` が playing ガード、`actHardDrop`/`actHold` が statusRef ガード。solitaire は `attempt` が同一 state を弾き、ダブルクリックは単発タップ（選択切替）と共存して組札へ送れる（下記注記cで検証）。pentomino は `canPlacePent` が自ピースの占有を許容するため配置済みピースの選択→タップで移動できる。battleship はフックが Board トップレベルで無条件（配置盤の useGesture も含む）なためフェーズ遷移でフック数は変わらない。wordle は成績記録が gameKey ガードで二重記録なし。tsume は `doMove` が手数で正解方向を判定し終局ジングルと二重に鳴らさない。sudoku は新規の数字キー入力がパッド div（Enter/Space のみ）と衝突しない。maze は `doMove` が stateRef 経由で最新状態を読む。
- 指摘1（機能バグの芽・修正済み）スワイプ直後の click 二重発火: `useGesture` の盤面内に子の onClick があるゲーム（solitaire / tsume / sudoku / battleship）では、pointerdown/up が同一セルで終わる短いスワイプ（閾値24px以上・セル幅は battleship 約32px・tsume/sudoku 約44〜51px・solitaire 70pxで成立し得る）の直後にブラウザが click を dispatch し、スワイプ処理とタップ処理が両方走る。影響: solitaire/tsume は左スワイプのもどる直後に古い state クロージャの onCell が手を指して undo を上書き、battleship は右スワイプのランダム配置直後に古い placed への tryPlace が6隻目を追加して確定時に6隻送り得る。第1・第2バッチの montecarlo/dicequest/yahtzee/sugoroku/drawpoker にも同じ構図の潜在問題があった。対応: 共通ヘルパー側で修正 — `web/lib/gesture.ts` に `suppressClickAfterSwipe(el)` を新設し、useGesture のスワイプ分岐で `e.currentTarget` へ capture フェーズの1回限り click 抑止リスナーを付け、click が来なければ100msで解除する（タップ時は抑止しないため正規タップは奪わない）。回帰テストを batch3 に2件追加（静的検査＋transpile したヘルパーのモック要素での動作検証：抑止されること・click が来ない場合の解除・要素なしでも落ちないこと）。
- 指摘2（機能バグ・修正済み）wordle の Enter 二重発火ガードの穴: window リスナーの `data-wordle-key` ガードが画面キーボードにしか付いておらず、モード切替 div・結果コピー div・「もう一度」ボタンに目印がなかった。影響: モード div にフォーカスして Enter すると tappableProps の startGame と window 側の press("ENTER") が両方走り、5文字入力済みだと古い推測が submit されて開始したばかりの新規ゲームが上書きされる（コピー div は終局時のみ表示され press が status ガードするため実害なし）。対応: モード切替2 div・コピー div・「もう一度」ボタンに `data-wordle-key=""` を追加。回帰テストを拡張（`data-wordle-key` の件数を 8 件で固定：画面キーボードのテンプレート3＋ガード文字列1＋モード2＋コピー1＋もう一度1）。
- 指摘3（軽微・修正済み）falling の「もう一度」ボタンに `data-falling-ui` がなく、フォーカス時の Space で window 側のハードドロップが走ってからネイティブ click で再開していた（最終状態は新規ゲームのため実害は小さいが無駄な落下）。対応: ボタンに `data-falling-ui` を追加（Enter は window 側が扱わないため対象外）。回帰テストを拡張（もう一度ボタンが目印を持つことを検証）。あわせて陳腐化した冒頭コメントを修正（falling「キーボードと画面ボタン」→「キーボードと盤面のスワイプ／タップ」、maze「矢印キー／WASD／画面ボタン」→「矢印キー／WASD／盤面スワイプ」）。
- 指摘4（要判断・修正せず・差し戻し対象外）キーボードのみでの到達不能な操作: solitaire のもどる・自動移動、tsume の1手戻す、battleship の全消し・ランダム・確定はスワイプのみでキーボード経路がない。旧ボタンは Tab＋Enter で到達できたため、キーボード利用者には後退。対応はキー割当の設計判断（例: Uキーでもどる等）になるためレビュー側では付けず、親の判断に委ねる。sudoku のヒント（上スワイプ）も同様にキーボード経路はないが、ヒントは補助機能のため同列の注記とする。
- 注記（修正せず・差し戻し対象外）: (a) sudoku の盤マスは `role="gridcell"` に `aria-pressed` を付与しているが ARIA 的には gridcell に無効な属性。第2バッチレビューの montecarlo と同じ扱いで注記のみ。 (b) solitaire のダブルクリック共存を検証済み：捨て札は1回目で選択・2回目で選択解除・dblclick で組札へ、場札の末尾は2回とも選択維持・dblclick で組札へと動く（単発タップの即時性を保つため onDoubleClick 維持の選択は妥当）。 (c) battleship の配置盤は confirmed 後も `placementGesture` が残るが onSwipe が `confirmed` でガードされており、配置マスも `tabIndex={-1}`・`aria-disabled` で無効化されている。 (d) 指摘1の click 抑止は実ブラウザでのタッチ確認が未了（subagent はライブブラウザ不可）。静的テスト＋ヘルパー単体テストでは検証済みだが、親による実機でのスワイプ確認を推奨する。
- レビューでの変更ファイル: web/lib/gesture.ts（suppressClickAfterSwipe 新設＋useGesture のスワイプ分岐から呼ぶ）、web/app/games/wordle/WordleClient.tsx（data-wordle-key 4箇所追加）、web/app/games/falling/FallingClient.tsx（data-falling-ui 追加＋冒頭コメント修正）、web/app/games/maze/MazeClient.tsx（冒頭コメント修正）、web/tests/games-gesture-batch3.test.mjs（回帰テスト2件追加 → 24件、falling/wordle の既存テスト拡張）、FINDINGS-gesture.md（本節追記）。GitHub・Discord・Pi 操作なし。

## 第4バッチ（実施中）— 2026-11-14 04:50〜 JST
対象選定: 04:50 JST 時点の `<button>` 数実測でボタン最多のオフライン単独ゲーム8本（kanacross / chesspuzzle / anagram / 2048 / territory / skyscrapers / mushoku / mastermind）。territory は OnlineShell 経由のオンライン対戦だが、第3バッチの battleship と同じく自コンポーネント（TerritoryClient.tsx）のみを変更し OnlineShell には触れない。chesspuzzle は詰めチェス問題集であり、対象外の chess（対 CPU 対局）とは別ゲーム。

| ゲーム | マッピング | <button> |
|---|---|---|
| kanacross | 盤マス・ヒント行・問題選択・カナパレット・消すは div（tappableProps / gridcell）化。選んだ単語のチェックは盤面の下スワイプ（Enter キーでも可、data-kanacross-ui ガードで二重発火防止） | 7→1（例外: もう一度 chrome） |
| chesspuzzle | 問題選択・盤マス・昇格選択・やめるは div（tappableProps / gridcell）化。盤面の左スワイプ = 1手戻す、上スワイプ = ヒント。H / U キーでも同じ操作が可能（window リスナー、タップ対象物は Enter/Space のみのため二重発火なし） | 7→1（例外: もう一度 chrome） |
| anagram | 回答マス・文字タイルは div（tappableProps）化。回答欄の上スワイプ = 答える、左スワイプ = 並べ直す、ダブルタップ = ヒント。回答欄フォーカス時の Enter / Space・Backspace・H でも同じ操作が可能（window リスナーなしのため二重発火の余地なし）。判定後の「次の問題へ」もタップ対象物化 | 7→1（例外: もう一度 chrome） |
| 2048 | 方向ボタン4つを廃止し、盤面スワイプを旧来の TouchEvent 直書きから共通ヘルパー useGesture に寄せた（touchAction: "none" は既存）。ダブルタップ = 1手もどす（U キーでも可）。「このまま続ける」はタップ対象物化 | 7→1（例外: もう一度 chrome） |
| territory | 盤マスは div（gridcell）化：タップ = プレビュー位置の決定、合法プレビュー位置の再タップ = 置く。ピース選択は div（tappableProps）化。盤面の右スワイプ = 回転、左スワイプ = 反転、下スワイプ = パス。R / F / P キーでも同じ操作が可能（window リスナー、OnlineShell の入力欄では無視）。回転・反転・ここに置く・パスボタン廃止。OnlineShell には触れていない | 6→0 |
| skyscrapers | 盤マス・数字パッド・消す・サイズ選択・ヒント一部隠しは div（tappableProps / gridcell）化。物理キーボードの数字・Backspace / Delete での入力を新規追加（sudoku と同じ、パッド div は Enter/Space のみのため二重発火なし） | 6→1（例外: もう一度 chrome） |
| mushoku | レベル選択・隠しマス・数字パッド・消す・チェックは div（tappableProps）化。チェックは筆算面の下スワイプでも行える。物理キーボードの数字・Backspace は既存のまま残置 | 6→1（例外: もう一度 chrome） |
| mastermind | 難易度選択・予想スロット・色パレットは div（tappableProps）化。予想欄の上スワイプ = 判定する、左スワイプ = クリア。予想欄フォーカス時の Enter / Space・Backspace / Delete でも同じ操作が可能（window リスナーなしのため二重発火の余地なし） | 6→1（例外: もう一度 chrome） |

## 第4バッチ（完了）— 2026-11-14 04:50〜05:05 JST
- 新規テスト `web/tests/games-gesture-batch4.test.mjs`（22件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続 + kanacross の Enter 二重発火防止ガード + ジェスチャ面の touchAction + ⏱ 残存なしの静的検査。
- 実施後: **1454 / 1454 pass**（第3バッチ＋レビュー後 1432 + 新規22件）、`npx tsc --noEmit` クリーン。
- 例外リスト（第4バッチ追加）: kanacross / chesspuzzle / anagram / 2048 / skyscrapers / mushoku / mastermind の「もう一度」= ゲーム外 chrome のリセット操作。第1〜第3バッチと同じ扱い。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記:
  - キーボード経路: kanacross のチェックは Enter（data-kanacross-ui ガード付き）、chesspuzzle の1手戻す・ヒントは U / H キー、2048 の1手もどすは U キー、territory の回転・反転・パスは R / F / P キー、skyscrapers は数字キー新規追加、anagram・mastermind は対象物フォーカス時の Enter / Space・Backspace・H / Delete。いずれもスワイプのみの操作はないため、第3バッチレビュー指摘4の「キーボード到達不能」は本バッチでは発生していない。
  - territory は OnlineShell 経由のオンライン対戦だが、第3バッチの battleship と同じく自コンポーネントのみを変更し、OnlineShell・オンライン基盤には触れていない。territory の window リスナーは OnlineShell 側の入力欄（ルームコード等）でのキー入力を無視するガード付き。
  - chesspuzzle は詰めチェス問題集であり、対象外の chess（対 CPU 対局）とは別ゲーム。chess 本体には触れていない。
  - 2048 は旧来の TouchEvent 直書き（onTouchStart / onTouchEnd / touchRef）を撤去し useGesture に寄せた。方向ボタンの矢印記号（←↑↓→）はボタンとともに除去済み。
  - skyscrapers はスワイプ面を持たないパッド型ゲームのため useGesture・touchAction の対象外（wordle・sudoku と同じ扱い）。
  - 盤面内に子の onClick があるゲーム（kanacross / chesspuzzle / anagram / territory / mushoku / mastermind）は useGesture の suppressClickAfterSwipe がスワイプ直後の click 二重発火を抑止する（第3バッチレビュー指摘1の共通ヘルパー）。anagram の回答欄は onDoubleTap（ヒント）を使うが onTap を渡していないため単発タップの遅延は発生しない。
  - 対象外（balku / lll / online / chess）には触れていない。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。
- 変更ファイル: web/app/games/{kanacross,chesspuzzle,anagram,2048,territory,skyscrapers,mushoku,mastermind}/各Client.tsx（2048 は SliderClient.tsx）、web/tests/games-gesture-batch4.test.mjs（新規）、FINDINGS-gesture.md。未完了ゲームなし（代替候補の使用なし）。

## 第4バッチ レビュー（Bレビュー）— 2026-11-14 05:05〜 JST
- 結論: **指摘あり（4件ともレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1457 / 1457 pass**（第4バッチ完了時 1454 + レビュー追加の回帰テスト3件）、`npx tsc --noEmit` クリーン。修正前も 1454 / 1454 pass を確認済み。
- 観点別確認（実コード精査）:
  1. ボタン予算: kanacross 1 / chesspuzzle 1 / anagram 1 / 2048 1 / territory 0 / skyscrapers 1 / mushoku 1 / mastermind 1 — すべて予算通り。残ボタンは全て「もう一度」chrome。territory は `og-button`（回転・反転・ここに置く・パス）も含め完全廃止。
  2. 絵文字: pictographic 絵文字なし（Python による Unicode 範囲走査で確認）。✓（kanacross・chesspuzzle の正解表示）・♔♕♖♗♘♙♚♛♜♝♞♟（chesspuzzle の駒）・✕（anagram の不正解）・☆（territory の開始角）・○（anagram・mastermind の判定表示）・×（mushoku の掛け算記号）・・（skyscrapers の隠しヒント）はテキスト記号として許容。⏱ は8ゲームとも残存なし。
  3. 共通基盤: 8ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用（skyscrapers はパッド型のため useGesture なし・tappableProps のみ）。SE は `lib/sfx.ts` の合成音のみ。例外は territory の `lib/balku-sound` の playSe だが HEAD から既存（battleship と同じ）でバッチ4は変更していないため許容。2048 は旧来の TouchEvent 直書き（onTouchStart / onTouchEnd / touchRef・方向ボタン4つ）を撤去し useGesture に寄せたことを差分で確認（旧しきい値 24px は共通ヘルパーの既定値と同一のため挙動維持）。
  4. キーボード: kanacross（Enter チェック＋data-kanacross-ui ガード、6箇所）、chesspuzzle（H / U）、anagram（回答欄 Enter / Space・Backspace・H）、2048（矢印・U）、territory（R / F / P＋OnlineShell 入力欄ガード）、skyscrapers（数字・Backspace / Delete 新規追加）、mushoku（数字・Backspace / Delete・Escape、選択中のみ）、mastermind（予想欄 Enter / Space・Backspace / Delete）— すべて Enter/Space 対応あり。anagram・mastermind は下記指摘1・2を修正。territory の入力欄ガードは INPUT / TEXTAREA / SELECT / contentEditable を網羅し、OnlineShell 側のルームコード入力での R / F / P 誤発火を防ぐ。
  5. テスト: batch4 の22件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・kanacross ガード・touchAction・⏱ なしを検証）。レビューで3件追加し 25件とした。ただし指摘1〜4はいずれも静的検査テストだけでは検出できない種類の問題だった（従来どおり tsc＋実コード精査が必須）。
  6. ロジック: kanacross は onCell の方向切替・入力後自動送り・checkWord の分岐が読める範囲で正しい。chesspuzzle は onSquare の昇格分岐・undoMove / showHint のフェーズガードが正しい。2048 は doMove のアニメーション中キューイング（1手のみ）・undo の履歴ポップが正しい。territory はタップ2段階（プレビュー→合法再タップで置く）の分岐が正しい（非法プレビューの再タップはプレビュー維持のみ）。skyscrapers は setSkyValue 経由の入力・ベスト判定が正しい。mushoku は stateRef 経由の最新 state 参照・checkMushoku の評価分岐が正しい。mastermind は pickColor のスロット送り・canSubmit ガードが正しい。anagram は trySubmit / tryClear / tryHint のガードが正しい（下記指摘3を除く）。
- 指摘1（機能バグ・修正済み）anagram の Enter 二重発火: 回答欄（onKeyDown Enter/Space → trySubmit）の子の回答マスが tappableProps（Enter/Space → 外す）で、tappableProps の onKeyDown は stopPropagation しないため、キーボードでマスにフォーカスして Enter を押すと「外す」と「判定」が両方走る。全選択済みだと trySubmit が古い allPicked（true）を見て判定を送信し、外す操作が失われる。影響: 間違えた文字を外そうとしたつもりが回答を送信してしまう。対応: 回答欄の onKeyDown で Enter / Space のとき `e.target !== e.currentTarget` なら return（Backspace・H はマス側にハンドラがないため引き続き親が受ける）。回帰テスト追加。
- 指摘2（機能バグ・修正済み）mastermind の Enter 二重発火（指摘1と同一構図）: 予想欄（onKeyDown Enter/Space → onSubmit）の子の予想スロットが tappableProps（Enter/Space → スロット選択）で、予想が揃った状態でスロットに Enter を押すとスロット選択と判定が両方走り、判定が送信される。対応: 指摘1と同じガードを予想欄の onKeyDown に追加（Backspace / Delete はスロット側にハンドラがないため引き続き親が受ける）。回帰テスト追加（指摘1と共通のテスト）。
- 指摘3（機能バグ・修正済み）anagram のダブルタップ=ヒント誤発火: useGesture のダブルタップ判定は子のマスのタップも拾う（位置を見ない）。同じマスのダブルタップや2マスの連続タップ（320ms以内）で onDoubleTap → tryHint が走り、-20点のヒントが誤発火する。ヒントはコスト付き・不可逆（文字開示）の操作のため実害がある。対応: 外す操作の時刻を `lastUnpickAtRef` に記録し、onDoubleTap は直前400ms以内に外す操作があったらヒントにしない（外すの click は pointerup より後に発火するため、ダブルタップ判定時点では直前の外すが記録済み）。回帰テスト追加。残り: 空き→マスの順のダブルタップは外すの click が判定より後になるため防げない。頻度は低いが、完全な分離にはヒントのトリガー見直し（専用ターゲット等）が必要なため注記とする。
- 指摘4（軽微・修正済み）territory の送信中ガード欠落: 旧「ここに置く」/「パス」ボタンは `disabled={!previewLegal || api.busy}` / `disabled={!canPass || api.busy}` で送信中を無効化していたが、再タップでの置く・スワイプでのパスに置き換えた際に `api.busy` の参照が落ちていた。`api.move` 側の `postWithRevision` にも busy ガードがあるため二重送信自体は起きないが、ガードなしだと送信中のタップで選択がクリアされ、送信されなかった手が無言で消える。対応: `place()` / `pass()` に `api.busy` ガードを追加（HEAD のボタン無効化と同等の意味）。回帰テスト追加。
- 注記（修正せず・差し戻し対象外）: (a) 指摘3の残り（空き→マスの順のダブルタップ）は上記のとおり注記のみ。 (b) kanacross の window Enter リスナーは EndScreen の「もう一度」ボタンにフォーカスがあると onCheck も走るが、デフォルトアクションの click が後で再開するため最終状態は新規ゲームで実害なし。 (c) 第1〜第3バッチ側の onKeyDown を横断確認したところ、sudoku / tsume / pentomino の onKeyDown はいずれもセル自身のリーフハンドラで、tappableProps の子を持つ親コンテナの onKeyDown はなく、指摘1・2と同一構図の問題は見当たらなかった。 (d) 2048 の盤面ダブルタップ=もどすは単発タップが何もしない盤面のため誤発火の余地は小さい（意図しないダブルタップでのみ発動する設計どおりの動作）。 (e) chesspuzzle の盤面スワイプ=戻す/ヒントは、短いスワイプ直後の click が suppressClickAfterSwipe で抑止されるため誤操作（戻す直後に手を指す等）は起きない。
- レビューでの変更ファイル: web/app/games/anagram/AnagramClient.tsx（指摘1・3）、web/app/games/mastermind/MastermindClient.tsx（指摘2）、web/app/games/territory/TerritoryClient.tsx（指摘4）、web/tests/games-gesture-batch4.test.mjs（回帰テスト3件追加 → 25件）、FINDINGS-gesture.md（本節追記）。対象外（balku / lll / online / chess）・共有基盤（OnlineShell・useOnlineRoom・lib/gesture.ts）には触れていない。GitHub・Discord・Pi 操作なし。

## 第5バッチ（完了）— 2026-11-14 05:15〜06:10 JST
対象選定: 05:15 JST 時点の `<button>` 数実測でボタン最多のオフライン単独ゲーム8本（countdown は OnlineShell 経由のオンライン対戦だが、第3バッチの battleship・第4バッチの territory と同じく自コンポーネント（CountdownClient.tsx）のみを変更し OnlineShell には触れない）。

| ゲーム | マッピング | <button> |
|---|---|---|
| kenken | サイズ選択・数字パッド・消すは div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化。盤面の下スワイプ=チェック、盤面フォーカス時の Enter でもチェック（親子ガード付き）。物理キーボードの数字・Backspace / Delete での入力を新規追加（sudoku と同じ） | 6→1（例外: もう一度 chrome） |
| freecell | 札・空きスロットは div（tappableProps）化。盤面の左スワイプ=1手戻す、右スワイプ=自動送り（solitaire と同じ）。U / A キーでも同じ操作が可能。縦スクロールを残すため盤面は touchAction: "pan-y" | 6→2（例外: 同じ盤面でもう一度・新しい盤面 chrome） |
| countdown | 数字タイル・計算結果タイル・演算子・1つ戻す・やり直す・提出は div（tappableProps）化。盤面の左スワイプ=1つ戻す、右スワイプ=やり直す、上スワイプ=提出。U / R キーでも同じ操作が可能（OnlineShell の入力欄では無視） | 6→0 |
| columns | 方向・回転・落とすボタン5つを廃止し、盤面スワイプに一本化（falling と同じ対応：左右=移動、下=ソフトドロップ、上=ハードドロップ、タップ=回転）。未開始・ゲームオーバー時のタップ=開始。Enter / Space でも開始できる（ボタンにフォーカスがあるときはネイティブ click に任せて二重開始しない）。**HEAD の doRotate 自己再帰バグを修正**（回転ボタン・↑キーでスタックオーバーフローしていた。回転を盤面タップへ移す際に rotateColumns 呼び出しへ修正） | 6→1（例外: スタート/もう一度 chrome） |
| backgammon | コマの山は div（tappableProps）化。ダイスの出目を表示する対象物を盤上に置き、ロール局面ではタップして振る（盤面タップでも振れる）。盤面の左スワイプ=パス、上スワイプ=上がる（ベアオフ）。Space=振る、P=パス、B=上がる（data-backgammon-ui ガード付き）。バーから復帰ボタンは廃止（盤のマスタップが既に "bar" 選択を行うため代替不要） | 6→1（例外: もう一度 chrome） |
| sokoban | 面選択・次の面へは div（tappableProps）化。盤面スワイプで移動（十字ボタン廃止）。4方向すべてが移動のため戻すはダブルタップに割り当て（anagram 式の lastActionAtRef ガード付き：直前400ms以内の移動・箱押しがあったダブルタップは戻さない）。キーボードは従来どおり矢印/WASD・Ctrl+Z | 5→1（例外: もう一度 chrome） |
| nonogram | サイズ選択・塗る/×印モード切替は div（tappableProps）化。盤マスは button→div（gridcell）化し、ドラッグ塗り（onPointerDown / onPointerEnter / elementFromPoint）はそのまま。マスのキーボード操作（Enter/Space=塗る・消す）を新規追加。モード切替にスワイプは割り当てていない（ドラッグ塗りと衝突するため）。useGesture は使わない（reaction / stopwatch と同じく計測・描画の即時性が本質の意図的な例外。ドラッグ塗り自体がジェスチャ） | 5→1（例外: 別の問題 chrome） |
| kakuro | kenken と同型。チェックは盤面の下スワイプ＋盤面フォーカス時の Enter（親子ガード付き）。白マスは div（gridcell）化、与え数字マスはフォーカス対象外。数字パッド・消すは div（tappableProps）化。物理キーボードの数字・Backspace / Delete での入力を新規追加 | 5→1（例外: もう一度 chrome） |

- 新規テスト `web/tests/games-gesture-batch5.test.mjs`（22件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続 + kenken/kakuro の Enter 二重発火防止ガード + backgammon の Space ガード + sokoban のダブルタップ誤発火防止 + columns の doRotate 修正の回帰 + ジェスチャ面の touchAction + ⏱ 残存なしの静的検査。
- 実施後: **1479 / 1479 pass**（第4バッチ＋レビュー後 1457 + 新規22件）、`npx tsc --noEmit` クリーン。実施中に tsc エラー1件（columns の keydown effect が `restart` を宣言より前で参照し TDZ になるもの）を検出し、restart/do* 群を effect より前へ移動して修正（テストのみでは検出できないため tsc が必須。第2バッチの drawpoker と同じ構図）。
- 変更ファイル: web/app/games/{kenken,freecell,countdown,columns,backgammon,sokoban,nonogram,kakuro}/各Client.tsx、web/tests/games-gesture-batch5.test.mjs（新規）、FINDINGS-gesture.md。未完了ゲームなし（代替候補の使用なし）。
- 例外リスト（第5バッチ追加）: kenken / columns / backgammon / sokoban / kakuro の「もう一度」、nonogram の「別の問題」、freecell の「同じ盤面でもう一度」「新しい盤面」= ゲーム外 chrome のリセット操作。第1〜第4バッチと同じ扱い。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記:
  - キーボード経路: kenken/kakuro のチェックは盤面フォーカス時の Enter、freecell の戻す・自動送りは U / A、countdown の戻す・やり直すは U / R、columns は矢印・Space・Enter、backgammon は Space / P / B、sokoban は矢印/WASD・Ctrl+Z・（ダブルタップの代替）、nonogram はマスの Enter/Space。いずれもスワイプのみの操作はない（sokoban の戻すはダブルタップと Ctrl+Z の両経路あり）。
  - countdown の提出は上スワイプのほか提出のタップ対象物でも行える。提出 div は Tab+Enter で到達できるためキーボード経路あり。
  - backgammon のダイス表示はステータス行からダイス対象物へ移した（重複表示を避けるためステータス行のダイス出目は除去）。
  - sokoban のダブルタップ=戻すの残り: 床マスへのタップ→箱へのタップを320ms以内に行った場合、ダブルタップ判定時点では床タップに操作記録がないため戻すが誤発火し得る（anagram 指摘3の残りと同じ構図）。頻度は低いが、完全な分離には戻すのトリガー見直しが必要なため注記とする。
  - columns の doRotate 自己再帰は HEAD（2ae30eb）時点の既存バグであることを `git show HEAD` で確認済み（バッチ作業による混入ではない）。回転ボタン・↑キーは HEAD では押すたびにスタックオーバーフローしていた。
  - sokoban の盤面は touchAction: "none" のため、幅10マスの面（約438px）が 360px 級の狭い画面で横にはみ出す場合の横スクロールが奪われる（maze の盤面と同じ扱い。はみ出し自体は HEAD から既存のレイアウト）。
  - 対象外（balku / lll / online / chess）には触れていない（countdown は自コンポーネントのみ変更し、online/OnlineShell には触れていない）。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。

## 第5バッチ レビュー（Bレビュー）— 2026-11-14 05:35〜 JST
- 結論: **指摘あり（4件ともレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1482 / 1482 pass**（第5バッチ完了時 1479 + レビュー追加の回帰テスト3件）、`npx tsc --noEmit` クリーン。修正前も 1479 / 1479 pass を確認済み（テストは `node --test` で batch5 ファイル単体 25 / 25 も確認）。
- 観点別確認（実コード精査）:
  1. ボタン予算: kenken 1 / freecell 2 / countdown 0 / columns 1 / backgammon 1 / sokoban 1 / nonogram 1 / kakuro 1 — すべて予算通り（Python による実測）。残ボタンは全て「もう一度」/「別の問題」/「同じ盤面でもう一度・新しい盤面」の chrome。diff の対象は第5バッチの8ファイルのみで、online/OnlineShell・lib・balku・lll・chess には変更なし。
  2. 絵文字: pictographic 絵文字なし（Python による Unicode 範囲走査で確認）。⚀〜⚅（backgammon のダイス）・⚠（sokoban の詰み警告）・◎✓（sokoban のゴール／箱）・■×（nonogram のモード）・←↑→↓（columns の説明）はテキスト記号として許容（⚠・⚀〜⚅ は HEAD から既存）。⏱ は8ゲームとも残存なし。
  3. 共通基盤: 8ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用。SE は `lib/sfx.ts` の合成音のみ（countdown は HEAD から既存の `lib/balku-sound` の playSe、バッチ5は変更していないため許容）。nonogram の useGesture 不使用は妥当 — ドラッグ塗り（onPointerDown / onPointerEnter / elementFromPoint）自体がジェスチャであり、reaction / stopwatch と同じ意図的な例外。countdown のタイルの `touchAction: "manipulation"` は盤面の `none` との積集合で `none` になるため、タイル起点のスワイプも妨げない。
  4. キーボード: kenken/kakuro（盤面 Enter チェック＋親子ガード、数字・Backspace/Delete）、freecell（U/A）、countdown（U/R＋OnlineShell 入力欄ガード）、columns（矢印・Space・Enter、ボタン focus 時の二重開始防止）、backgammon（Space/P/B＋data-backgammon-ui ガード）、sokoban（矢印/WASD・Ctrl+Z）、nonogram（マス Enter/Space）— すべて Enter/Space 対応あり。kenken/kakuro の親子ガード（`e.target !== e.currentTarget`）と backgammon の Space ガードは実コードで網羅を確認。backgammon は下記指摘1を修正。
  5. テスト: batch5 の22件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・kenken/kakuro ガード・backgammon Space ガード・sokoban ダブルタップ防止・columns doRotate 修正・touchAction・⏱ なしを検証）。レビューで3件追加し 25件とした。ただし指摘1・2はいずれも静的検査テストだけでは検出できない種類の問題だった（従来どおり tsc＋実コード精査が必須）。
  6. ロジック: columns は doRotate 修正が正しい（`rotateColumns` は playing・active ガード付きで HEAD から import 済み、HEAD の自己再帰を `git show HEAD` で確認）。restart/do* 群の effect 前への移動も正しい（restart は useCallback 化、effect 依存 [started, state.status, restart]、do* 群は setState 関数更新のみで陳腐化なし）。sokoban は下記指摘2・3を修正。freecell はスワイプのもどる・自動送りが suppressClickAfterSwipe で子の onClick と分離され、U/A キーとも衝突しない（自動送りは安全な送りだけのため誤操作の実害は小さい）。backgammon は下記指摘1を修正（パス・上がりは HEAD のボタン表示条件と同一ガードのため parity あり）。countdown は tapTile / undo / onSubmit のロジックに diff なし（JSX の div 化＋ジェスチャ接続のみ）、OnlineShell 非接触を diff で確認。kenken/kakuro/nonogram のロジック関数にも diff なし。nonogram のドラッグ塗りは HEAD のまま（セル div 化＋キーボード対応のみ追加）。
- 指摘1（機能バグ・修正済み）backgammon のバー復帰ができず詰む: 旧「バーから復帰」ボタンは `setSelected("bar")` を直接呼んでいたが、バッチ5は「盤のマスタップが既に "bar" 選択を行うため代替不要」として廃止した。しかし `renderPoint` の `clickable` 条件（HEAD から変更なし）は `bar[0] > 0 && selected === null` のとき全マスを不可にしており、`onPointClick` に到達できないため `selected` は決して `"bar"` にならない。合法なバー復帰手がある状態ではパスもできない（`legal.length !== 0`）ため、コマがバーにあるとゲームが進行不能になり「もう一度」での再開しかなくなる。対応: `clickable` に `(state.bar[0] > 0 && legal.some((m) => m.from === "bar"))` を追加（復帰手があるときだけ全マスをタップ対象化。復帰手がない＝入口が塞がれているときは従来どおり不可で左スワイプのパスへ）。回帰テスト追加。FINDINGS 第5バッチ表の backgammon 行の「代替不要」は誤りだったため本節で訂正する。
- 指摘2（機能バグの芽・修正済み）sokoban のダブルタップ=戻すの誤発火の残り（FINDINGS 第5バッチ注記の残りを塞ぐ）: `lastActionAtRef` ガードは移動・箱押しの成功時しか記録しないため、床タップ→箱タップを320ms以内に行うと、ダブルタップ判定時点（pointerup）では2発目の箱押しの click がまだ発火しておらず、戻すが誤発火してから箱押しが走る。対応: `onDoubleTap` を 80ms 遅らせてから再判定する（click は pointerup の直後に発火するため、遅延中に箱押しがあれば記録が更新され戻すは抑止される。意図的な床ダブルタップは 80ms 遅れるだけで発火する）。あわせて `onBoxClick` の失敗分岐でもタップ自体を記録する（押せない箱へのタップも操作のため）。回帰テスト追加（遅延＋再判定＋記録箇所4箇所を固定）。
- 指摘3（軽微・修正済み）sokoban の「次の面へ」が `<p>` の中の `<div>` になっている: button→div 化の際に `<p style={{textAlign:"center"}}>` の中に div が入り、不正なネストになった（HEAD は `<button>` で valid）。ブラウザが p を自動で閉じるため中央揃えが崩れる。対応: 外側を `<div style={{textAlign:"center"}}>` に変更。回帰テスト追加（p の中に div がないことを検証）。
- 指摘4（軽微・修正済み）陳腐化した冒頭コメント: columns「ボタン操作とキーボード」、sokoban「十字ボタンとキーボード」が廃止済みのボタンを指したままだった。第3バッチレビュー指摘3と同じ対応で修正（columns「盤面のスワイプ／タップとキーボード」、sokoban「盤面のスワイプとキーボード」）。
- 注記（修正せず・差し戻し対象外）: (a) sokoban の盤面は `touchAction: "none"` のため、幅10マスの面が 360px 級の狭い画面ではみ出す場合の横スクロールが奪われる（第5バッチ注記のとおり。はみ出し自体は HEAD から既存）。 (b) countdown のタイル `touchAction: "manipulation"` は上記観点3のとおり盤面の `none` との積集合で問題なし。 (c) 指摘1のバー復帰は実ブラウザでの対局確認が未了（subagent はライブブラウザ不可）。静的テスト＋実コード精査では検証済みだが、親による実機でのバー復帰確認を推奨する。 (d) backgammon の上がり（上スワイプ）は HEAD のボタン表示条件と同じく選択済みのベアオフ手が必要（未選択時のスワイプは no-op）。旧ボタンと同一の挙動のため許容。
- レビューでの変更ファイル: web/app/games/backgammon/BackgammonClient.tsx（指摘1）、web/app/games/sokoban/SokobanClient.tsx（指摘2・3・4）、web/app/games/columns/ColumnsClient.tsx（指摘4）、web/tests/games-gesture-batch5.test.mjs（回帰テスト3件追加 → 25件）、FINDINGS-gesture.md（本節追記）。GitHub・Discord・Pi 操作なし。

## 第6バッチ（完了）— 2026-11-14 05:47〜06:15 JST
対象選定: 05:47 JST 時点の `<button>` 数実測でボタン最多のオフライン単独ゲーム8本（drawguess は OnlineShell 経由のオンライン対戦だが、第3〜第5バッチの battleship / territory / countdown と同じく自コンポーネント（DrawGuessClient.tsx）のみを変更し OnlineShell には触れない）。

| ゲーム | マッピング | <button> |
|---|---|---|
| hanoi | 枚数選択・自動解答トグル・柱は div（tappableProps）化。柱の cursor は HEAD の `auto \|\| solved`（常に default）が実質バグのため `solved ? "default" : "pointer"` に整理 | 5→1（例外: もう一度 chrome） |
| drawguess | お題3択・色・太さ・全部消す・回答は div（tappableProps）化。回答フォームの onSubmit は残置し入力欄の Enter でも回答できる。描画キャンバス自体が既にポインタ描画（touchAction は描き手のときだけ none） | 5→0 |
| breakout | 発射/再開・ポーズ・次のレベルへボタン廃止。盤面タップ=発射・再開・クリア時は次のレベルへ、盤面の下スワイプ=ポーズ（プレイ中のみ）。Space/Enter にクリア時→次レベル・終了時→再開を追加。Space/Enter は data-breakout-ui ガード付き（「もう一度」ボタン focus 時はネイティブ click に任せる）。未使用の activeBtn を除去 | 5→1（例外: もう一度 chrome） |
| bowling | ◀/投げる/▶ ボタン廃止（3D シーンのドラッグ狙い＋上フリック投球が本体）。音トグルは div（tappableProps）化。矢印キーで狙い・Space/Enter で投げるを新規追加（シーン側の phase=aim ガードが可否を守る）。data-bowling-ui ガード付き（音トグル div・「もう一度」ボタン） | 5→1（例外: もう一度 chrome） |
| tents | サイズ選択は div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化（木・非プレイ中は tabIndex -1・aria-disabled）。盤面の下スワイプ=チェック、盤面フォーカス時の Enter でもチェック（親子ガード付き） | 4→1（例外: もう一度 chrome） |
| spider | 札・空き列は div（tappableProps）化（裏向き札はタップ対象外・aria-disabled）。山札から配るは div（tappableProps）化＋盤面の下スワイプ＋D キー。tryDeal が旧ボタンの disabled 条件（残り0回・プレイ中でない）と同等に無音 no-op | 4→1（例外: もう一度 chrome） |
| shikaku | tents と同型。サイズ選択は div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化。盤面の下スワイプ=チェック、盤面フォーカス時の Enter でもチェック（親子ガード付き） | 4→1（例外: もう一度 chrome） |
| river | 問題選択・荷物チップは div（tappableProps）化（荷物は向こう岸・非プレイ中は無効）。「わたる」ボタン廃止。ボートの対岸方向への横スワイプ=渡る（タップは荷物の乗せ降ろしのみで分離）。ボートフォーカス時の Enter/Space でも渡る（親子ガード付き） | 4→1（例外: もう一度 chrome） |

- 新規テスト `web/tests/games-gesture-batch6.test.mjs`（22件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続 + breakout/bowling の二重発火防止ガード + tents/shikaku/river の Enter 親子ガード + spider の配る無効条件 + ジェスチャ面の touchAction + ⏱ 残存なしの静的検査。
- 実施後: **1504 / 1504 pass**（第5バッチ＋レビュー後 1482 + 新規22件）、`npx tsc --noEmit` クリーン。
- 例外リスト（第6バッチ追加）: hanoi / breakout / bowling / tents / spider / shikaku / river の「もう一度」= ゲーム外 chrome のリセット操作。第1〜第5バッチと同じ扱い。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記:
  - キーボード経路: hanoi（柱・枚数・自動解答の Enter/Space）、drawguess（お題・色・太さ・全消し・回答の Enter/Space＋入力欄 Enter）、breakout（Space/Enter/P＋クリア時・終了時の Space/Enter）、bowling（←→・Space/Enter＋音トグルの Enter/Space）、tents/shikaku（マスの Enter/Space＋盤面 Enter）、spider（札・空き列・配るの Enter/Space＋D）、river（問題・荷物・ボートの Enter/Space）。スワイプのみの操作はない（breakout のポーズは Space/P キーでも可、tents/shikaku のチェックは盤面 Enter でも可、spider の配るは D キーでも可、river の渡河はボート Enter でも可）。第3バッチレビュー指摘4の「キーボード到達不能」は本バッチでは発生していない。
  - breakout のポーズ用下スワイプは、パドル操作の横ドラッグと軸が異なるため誤発火しにくい設計（縦方向が支配的かつ 24px 以上のときだけ）。横ドラッグ中の縦ブレが 24px を超えて縦支配になることは稀だが、実機での確認は親に委ねる。
  - spider の盤面は touchAction: "none" のため、盤面起点の縦スクロールは奪われる（tents/shikaku/kenken/kakuro の盤面と同じ扱い）。
  - spider の裏向きカードの「🂠」（U+1F0A0）は HEAD から既存のカード裏グリフ（♠ と同じテキスト記号扱い）。本バッチは変更していない。
  - bowling のキーボード投球はシーン側の phase=aim ガードに依存する（投球中・終了時は startRoll が早期 return）。シーンの API（adjustAim/throwStraight）自体は変更していない。
  - drawguess の回答 div はフォーム内にあり、入力欄の Enter はフォームの onSubmit 経由で従来どおり回答できる。div 自体の Enter/Space は tappableProps が受ける（フォーム送信とは別経路のため二重送信はない。submitGuess は canGuess ガード付き）。
  - river のボートは role="button" の中に荷物チップ（role="button"）を含む入れ子だが、Enter の二重発火は親子ガードで分離し、タップとスワイプは useGesture の 24px 閾値で分離している（anagram/mastermind・solitaire と同じ構図）。
  - 対象外（balku / lll / online / chess）には触れていない（drawguess は自コンポーネントのみ変更し、online/OnlineShell には触れていない）。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。
- 変更ファイル: web/app/games/{hanoi,drawguess,breakout,bowling,tents,spider,shikaku,river}/各Client.tsx、web/tests/games-gesture-batch6.test.mjs（新規）、FINDINGS-gesture.md。未完了ゲームなし（代替候補の使用なし）。

## 第6バッチ レビュー（Bレビュー）— 2026-11-14 06:05〜 JST
- 結論: **指摘あり（2件ともレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1504 / 1504 pass**（第6バッチ完了時と同数。回帰テストは新規テスト追加ではなく既存テストへの assertion 追加のため件数は変わらない）、`npx tsc --noEmit` クリーン。修正前も 1504 / 1504 pass を確認済み。
- 観点別確認（実コード精査）:
  1. ボタン予算: hanoi 1 / drawguess 0 / breakout 1 / bowling 1 / tents 1 / spider 1 / shikaku 1 / river 1 — すべて予算通り（実測）。残ボタンは全て「もう一度」chrome。drawguess の回答ボタンは HEAD で `type="submit"` だったものが div 化されており、フォーム送信経路は onSubmit に一本化されている。
  2. 絵文字: pictographic 絵文字なし（Python による Unicode 範囲走査で確認）。♥（breakout のライフ表示）・♠ / 🂠（spider のカード表記）はいずれも HEAD から既存のテキスト記号として許容。⏱ は8ゲームとも残存なし。
  3. 共通基盤: 8ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用（hanoi / drawguess / bowling はタップ対象物化のみで盤面スワイプなし）。SE は `lib/sfx.ts` の合成音のみ（drawguess は HEAD から既存の `lib/balku-sound` の playSe、バッチ6は変更していないため許容）。2048 と同じく bowling のジェスチャ面は 3D シーン側が担う。
  4. キーボード: hanoi（柱・枚数・自動解答）、drawguess（お題・色・太さ・全消し・回答＋入力欄 Enter）、breakout（Space/Enter/P＋クリア時・終了時）、bowling（←→・Space/Enter＋音トグル）、tents/shikaku（マス＋盤面 Enter）、spider（札・空き列・配る＋D）、river（問題・荷物・ボート）— すべて Enter/Space 対応あり。breakout・bowling の data 属性ガード、tents/shikaku/river の親子ガードを実コードで網羅確認。bowling は下記指摘2を修正。spider の D キー用 `useEffect` に依存配列がなく毎レンダー再登録されるが、クロージャが常に最新のため機能は正しい（性能上の微瑕として注記のみ）。
  5. テスト: batch6 の22件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・breakout/bowling ガード・tents/shikaku/river 親子ガード・spider 無効条件・touchAction・⏱ なしを検証）。レビューで既存テストに assertion を2件追加（件数は 22件のまま）。ただし指摘1・2はいずれも静的検査テストだけでは検出できない種類の問題だった（従来どおり tsc＋実コード精査が必須）。
  6. ロジック: breakout は盤面タップの多重役割がフェーズ分岐で正しい（ready/life-lost/paused=発射・再開、cleared=次レベルへ、gameover/all-cleared=no-op）。盤面タップでの発射は HEAD から onPointerDown 直結のまま（バッチ6の変更ではない）。bowling は矢印・投球ともシーン側の phase=aim ガードと整合（`adjustAim`/`startRoll` は aim 以外で早期 return。旧ボタンの `disabled={rolling || finished}` と同等）。river は「わたる」ボタンの表示条件・有効化条件と突き合わせて parity あり（HEAD のボタンは `disabled={status !== "playing"}` のみで空ボートでの渡河も可。スワイプ方向ゲート＋`crossRiver` の status ガードが同等。荷物の乗せ降ろしは `toggleRiverItem` のまま）。spider は `tryDeal` のガードが旧ボタンの disabled（`deals === 0 || status !== "playing"`）と完全一致（`git show HEAD` で確認）。`dealSpider` の空列ガードは `onDeal` 側で sfxWrong＋メッセージ付きで維持。hanoi は下記指摘1を修正。drawguess は回答フォームの onSubmit 残置と div 化が共存し二重送信なし（入力欄 Enter はフォーム経由のみ、div の Enter は tappableProps のみでフォーム送信を起こさない。`submitGuess` 自体も canGuess＋空文字ガード付き）。tents/shikaku は `onCheck` に status ガードがないが HEAD のチェックボタンにも disabled がなく parity あり（終局後のチェックは表示上無害）。tents/shikaku のマスは `cycleTentsMark`/`applyShikakuRect` 等のロジック関数に diff なし。
- 指摘1（軽微・修正済み）hanoi の柱 cursor 整理が後退: バッチ6は HEAD の `auto || solved ? "default" : "pointer"` を「常に default の実質バグ」として `solved ? "default" : "pointer"` に整理したが、HEAD の式は `||` が `?:` より優先されるため常に default ではなく、auto 中・solved 時に default・それ以外で pointer の正しいものだった。バッチ6の変更により自動解答の再生中は柱が pointer カーソル（操作可の見た目）なのに `onPeg` が早期 return で無音 no-op になる不一致が生じていた。対応: `auto || solved ? "default" : "pointer"` に復旧。回帰テスト追加（hanoi テストに cursor 文字列の assertion）。FINDINGS 第6バッチ表の hanoi 行の「HEAD の `auto || solved`（常に default）が実質バグ」は誤りだったため本節で訂正する。
- 指摘2（軽微・修正済み）bowling の data-bowling-ui ガードが矢印キーまで塞ぐ: window リスナーのガードが全キーの先頭にあり、音トグル div・「もう一度」ボタンにフォーカスがある状態では ←→ の狙い調整も無視されていた。矢印キーには div 側のハンドラがないため二重発火の余地はなく、ガードは投球（Space/Enter）分岐の中だけで十分。対応: ガードを Space/Enter 分岐の中へ移動（falling / wordle と同じく必要な分岐だけを守る形）。回帰テスト追加（bowling テストにガードが ArrowLeft 分岐より後にあることの assertion）。
- 注記（修正せず・差し戻し対象外）: (a) breakout の下スワイプ=ポーズと pointerdown 発射の干渉: ready / life-lost / paused フェーズで下スワイプを始めると pointerdown が発射・再開してからスワイプがポーズするため、結果としてポーズ状態になる（ready での意図しない発射直後のポーズ、paused での再開直後の再ポーズ）。いずれもタップで再開できるため実害は小さいが、発射を onTap（pointerup 判定）へ移す等の分離は HEAD の pointerdown 直結からの変更になるため今回は注記のみ。 (b) breakout の横ドラッグ中の縦ブレが 24px を超えて縦支配になるとポーズが誤発火し得る（第6バッチ注記のとおり。実機での確認は親に委ねる）。 (c) spider の D キー用 `useEffect` に依存配列がなく毎レンダー再登録される（機能は正しい。性能上の微瑕）。 (d) river のボートは role="button" の中に荷物チップ（role="button"）を含む入れ子（ARIA 的には不正なネスト）。Enter は親子ガードで分離済みのため今回は注記のみ。 (e) batch6 テストの冒頭コメントに「breakout は盤面内に子の onClick があるゲーム」とあったが、breakout の canvas に子の onClick はないため誤りだった。コメントを修正し、suppressClickAfterSwipe 自体の動作は batch3 のテストで検証済みである旨を明記した。 (f) 指摘1・2の修正は実ブラウザでの確認が未了（subagent はライブブラウザ不可）。静的テスト＋実コード精査では検証済みだが、親による実機での自動解答中の柱カーソル・音トグルフォーカス時の矢印キー確認を推奨する。
- レビューでの変更ファイル: web/app/games/hanoi/HanoiClient.tsx（指摘1）、web/app/games/bowling/BowlingClient.tsx（指摘2）、web/tests/games-gesture-batch6.test.mjs（回帰 assertion 2件追加＋冒頭コメント修正）、FINDINGS-gesture.md（本節追記）。対象外（balku / lll / online / chess）・共有基盤（lib/gesture.ts・OnlineShell）には触れていない。GitHub・Discord・Pi 操作なし。

## 第7バッチ（実施中）— 2026-11-14 06:25〜 JST
対象選定: 06:20 JST 時点の `<button>` 数実測でボタン最多のオフライン単独ゲーム8本（pyramid / puttgolf / pong / nurikabe / numbercode / minesweeper / lightsout / kwordle、各4件）。

| ゲーム | マッピング | <button> |
|---|---|---|
| pyramid | カード（ピラミッド・捨て山）・ストックめくりは div（tappableProps）化。非公開カードは aria-disabled＋ハンドラ側で exposed ガード（旧 disabled と同等） | 4→1（例外: もう一度 chrome） |
| puttgolf | コースタップ=打つ（プレイ中）・次のホールへ（カップイン時）。カップを狙うはタップ対象物化。角度・強さのスライダーはフォーム部品のため残置。コース面は role="button"＋Enter/Space 対応、touchAction: "none" | 4→1（例外: もう一度 chrome） |
| pong | 難易度は div（tappableProps）化。キャンバスのタップ=開始・再開（既存の pointerdown を拡張）、プレイ中のダブルタップ=ポーズ（pointerdown 直結の手書き判定。useGesture の onTap 320ms 遅延を避け、パドル操作の即時性を保つ reaction / stopwatch と同じ意図的な例外）。Space/Enter/P キーは既存の window リスナー。data-pong-ui ガードは Space/Enter 分岐の中だけ（bowling の教訓） | 4→1（例外: もう一度 chrome） |
| nurikabe | サイズ選択は div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化。盤面の下スワイプ=チェック、盤面フォーカス時の Enter でもチェック（親子ガード付き） | 4→1（例外: もう一度 chrome） |
| numbercode | 数字パッド・消す・クリア・回答するは div（tappableProps）化。入力枠の上スワイプ=回答する、左スワイプ=クリア。物理キーボードの数字・Backspace・Enter での入力を新規追加（Enter 分岐のみ data-numbercode-key ガード付き） | 4→0 |
| minesweeper | 難易度・旗モードは div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化、右クリック旗立て（onContextMenu）はそのまま。`.ms-cell` はクラス指定のみで div でも表示は変わらない | 4→1（例外: もう一度 chrome） |
| lightsout | サイズ・難易度は div（tappableProps）化。盤マスは div（gridcell、手書き Enter/Space）化。ステータスの ⏱ を「時間」に置換 | 4→1（例外: もう一度 chrome） |
| kwordle | カタカナキー・決定・消すは div（tappableProps）化。物理キーボードは window リスナーで残置。画面キー div にフォーカスがあるときの Enter を window リスナー側で data-kwordle-key ガードにより無視（wordle と同じ。Backspace・カナキー分岐には div 側ハンドラがないためガードなし） | 4→1（例外: もう一度 chrome） |

## 第7バッチ（完了）— 2026-11-14 06:25〜06:50 JST
- 新規テスト `web/tests/games-gesture-batch7.test.mjs`（22件）: 8ゲームのボタン予算 + 残りボタンが chrome リセットのみであること + 共通ヘルパー利用 + 各ゲームの核アクション接続 + pong/kwordle/numbercode の二重発火防止ガード + nurikabe の Enter 親子ガード + pyramid/puttgolf/numbercode の旧 disabled 条件との parity + ジェスチャ面の touchAction + ⏱ 残存なしの静的検査。
- 実施後: **1526 / 1526 pass**（第6バッチ＋レビュー後 1504 + 新規22件）、`npx tsc --noEmit` クリーン。
- 例外リスト（第7バッチ追加）: pyramid / puttgolf / pong / nurikabe / minesweeper / lightsout / kwordle の「もう一度」= ゲーム外 chrome のリセット操作。第1〜第6バッチと同じ扱い。numbercode は自ファイルに「もう一度」がなく 0 件（EndScreen 共通部品のもののみ）。EndScreen（GameJuice共通）の「もう一度」ボタンは全ゲーム共通部品のため本バッチ対象外（別途共通部品として要判断）。
- 注記:
  - キーボード経路: pyramid（カード・ストック・捨て山の Enter/Space）、puttgolf（コース面の Enter/Space）、pong（Space/Enter/P＋矢印/W/S、data-pong-ui ガードは Space/Enter 分岐の中だけ）、nurikabe（マスの Enter/Space＋盤面 Enter）、numbercode（数字・Backspace・Enter を新規追加、Enter 分岐のみ data-numbercode-key ガード付き）、minesweeper（マスの Enter/Space）、lightsout（マスの Enter/Space）、kwordle（画面キー・決定・消すの Enter/Space＋物理キー、Enter 分岐のみ data-kwordle-key ガード付き）。スワイプのみの操作はない（nurikabe のチェックは盤面 Enter でも可、numbercode の回答・クリアは Enter/Backspace・操作チップでも可、puttgolf の打つ・次のホールへはコース面 Enter でも可）。第3バッチレビュー指摘4の「キーボード到達不能」は本バッチでは発生していない。
  - pong のポーズ用ダブルタップは reaction / stopwatch と同じ意図的な例外で、useGesture には寄せていない（パドル操作は pointerdown の即時性が本質で、useGesture の onTap はダブルタップ猶予 320ms 遅延するため開始が遅れる）。手書きの pointerdown 判定で、開始・再開のタップは遅延なし。待機中・停止中のタップでは記録を消すため、再開直後のダブルタップによる即ポーズは起きない。ただしダブルタップ判定は子の操作記録を見ないため、パドル位置調整のつもりの素早い2回タップ（300ms以内）がポーズになる余地がある（sokoban・anagram と同じ構図の残り。頻度は低いが注記とする）。
  - puttgolf のコース面は touchAction: "none" のため、コース起点の縦スクロールは奪われる（spider・tents 等の盤面と同じ扱い）。角度・強さのスライダーはフォーム部品のため残置（実行ボタンではない）。
  - pyramid のストック表示の 🂠（U+1F0A0）は HEAD から既存のカード裏グリフで、spider の 🂠 と同じテキスト記号扱い（本バッチは変更していない）。↩（捨て山を再利用）・⌫（numbercode・kwordle の消す）・〜/・（nurikabe の海・島）・●/·（lightsout の点灯・消灯）はテキスト記号として許容。
  - numbercode の物理キーボード入力は新規追加（sudoku / skyscrapers と同じ）。pushDigit / backspace / submit を useCallback 化し、window リスナーの依存配列を明示した（spider の D キー effect の無依存配列の微瑕は踏襲していない）。
  - minesweeper の `.ms-cell` はクラス指定のみ（app/globals.css）のため button→div でも表示は変わらない。右クリック旗立て（onContextMenu）は div でもそのまま動作する。
  - nurikabe のチェックは HEAD のボタンに disabled（プレイ中でないとき無効）があったため、onCheck に status ガードを追加して parity を保った。puttgolf の「カップを狙う」も aimAtCup に phase/rolling ガードを追加して旧 disabled と同等にした。numbercode のクリアも空入力時のガードを追加した。
  - 対象外（balku / lll / online / chess）には触れていない。GitHub・Discord・Pi 操作なし。08:00 の親による一括出荷待ち。
- 変更ファイル: web/app/games/{pyramid,puttgolf,pong,nurikabe,numbercode,minesweeper,lightsout,kwordle}/各Client.tsx、web/tests/games-gesture-batch7.test.mjs（新規）、FINDINGS-gesture.md。未完了ゲームなし（代替候補の使用なし）。

## 第7バッチ レビュー（Bレビュー）— 2026-11-14 06:35〜 JST
- 結論: **指摘あり（1件をレビュー側で軽微修正済み）・差し戻しなし**。修正後に `npm test` **1526 / 1526 pass**（第7バッチ完了時と同数。回帰テストは新規テスト追加ではなく既存テストへの assertion 追加のため件数は変わらない）、`npx tsc --noEmit` クリーン。修正前も 1526 / 1526 pass を確認済み（batch7 ファイル単体 22 / 22 も確認）。
- 観点別確認（実コード精査・HEAD との `git show` 照合）:
  1. ボタン予算: pyramid 1 / puttgolf 1 / pong 1 / nurikabe 1 / numbercode 0 / minesweeper 1 / lightsout 1 / kwordle 1 — すべて予算通り（実測）。残ボタンは全て「もう一度」chrome。numbercode は 0 件。
  2. 絵文字: pictographic 絵文字なし（Python による Unicode 範囲走査で確認）。🂠（pyramid のストック表示、HEAD から既存）・↩（同・捨て山再利用）・⌫（numbercode・kwordle の消す）・〜/・（nurikabe の海・島）・●/·（lightsout の点灯・消灯）・→←↓↑（puttgolf の傾斜）はテキスト記号として許容。⏱ は8ゲームとも残存なし。
  3. 共通基盤: 8ゲームとも `lib/gesture` の `useGesture`/`tappableProps` を使用（pyramid / pong / minesweeper / lightsout / kwordle はタップ対象物化のみで盤面スワイプなし）。SE は `lib/sfx.ts` の合成音のみ。pong の手書きダブルタップ判定は reaction / stopwatch と同じ意図的な例外として妥当（useGesture の onTap はダブルタップ猶予 320ms 遅延するため、パドル操作の即時性を保つには pointerdown 直結が必要）。下記指摘1を修正。
  4. キーボード: pyramid（カード・ストック・捨て山）、puttgolf（コース面 Enter/Space）、pong（Space/Enter/P＋矢印/W/S、data-pong-ui ガードは Space/Enter 分岐の中だけ）、nurikabe（マス＋盤面 Enter、親子ガード付き）、numbercode（数字・Backspace・Enter 新規追加、Enter 分岐のみ data-numbercode-key ガード付き）、minesweeper（マス Enter/Space＋右クリック）、lightsout（マス Enter/Space）、kwordle（画面キー・決定・消す＋物理キー、Enter 分岐のみ data-kwordle-key ガード付き）— すべて Enter/Space 対応あり。pong・kwordle・numbercode のガードが Enter/Space（numbercode・kwordle は Enter のみ）分岐の中だけにあること、nurikabe の親子ガード（`e.target !== e.currentTarget`）を実コードで網羅確認。kwordle の `data-kwordle-key` は4箇所（画面キー1テンプレート＋決定＋消す＋もう一度）でテストが件数を固定。
  5. テスト: batch7 の22件は実コードと一致（ボタン予算・chrome 例外・各アクション接続・pong/kwordle/numbercode ガード・nurikabe 親子ガード・pyramid/puttgolf/numbercode の旧 disabled parity・touchAction・⏱ なしを検証）。レビューで既存テストに assertion を1件追加（件数は 22件のまま）。ただし指摘1は静的検査テストだけでは検出できない種類の問題だった（従来どおり tsc＋実コード精査が必須）。
  6. ロジック: pyramid は `cellDisabled`（`!isExposed || status !== "playing"`）・`stockDisabled`（won/stuck/ stock・waste ともに空）・捨て山の `onTarget` 内 status ガードが HEAD のボタン disabled と完全一致（`git show HEAD` で確認）。puttgolf はコースタップの多重役割がフェーズ分岐で正しい（playing→doShoot は phase/rolling ガード付き、holed→nextHole、finished は no-op。HEAD の「打つ」disabled・「次のホールへ」表示条件と同一）。aimAtCup の phase/rolling ガードも HEAD の disabled と一致。角度・強さスライダーの残置はフォーム部品のため妥当（実行ボタンではない）。pong はコートタップの拡張が正しい（ready/paused→playing、finished は no-op。HEAD のスタート/再開ボタン・ポーズボタンと同一の到達範囲）。nurikabe は `onCheck` の status ガードが HEAD のチェックボタン disabled（`status !== "playing"`）と一致し、マスの `cellDisabled` も HEAD と一致。numbercode は `pushDigit`/`backspace`/`clearInput`/`submit` の useCallback 化が正しい（依存配列 [input, playing] / [input] / [input] / [input]、window リスナーの依存配列 [pushDigit, backspace, submit] に漏れなし。spider の D キー effect の無依存配列の微瑕は踏襲していない）。入力枠の上スワイプ=回答・左スワイプ=クリアは useGesture の方向判定（支配軸）で分離される。minesweeper は右クリック旗立て（onContextMenu）が div でもそのまま動作し、`.ms-cell` はクラス指定のみ（globals.css 確認）のため表示は変わらない。`revealCell`/`chordCell` が won/lost を返すため終局後のマス操作は no-op（HEAD のボタンも disabled なしで同一）。lightsout は `pressCell` が won を返すため終局後の押下は no-op（HEAD のボタンも disabled なしで同一）。
- 指摘1（機能バグの芽・修正済み）pong のダブルタップ=ポーズの誤発火: 手書き判定は時刻だけを見ており、パドル位置調整のつもりの素早い2回タップ（300ms以内、タッチではボールを追ってタップ位置が動く）がポーズになる。FINDINGS 第7バッチ注記の残り。対応: 2回目のタップが1回目とほぼ同じ高さ（clientY 差 48px以内）のときにだけポーズする位置ガードを追加（`lastPlayTapAtRef` を `{t, y} | null` に変更。意図的なダブルタップはその場で2回叩くため残る）。回帰テスト追加（batch7 の pong テストに位置ガードの assertion を追加。開始・再開時の記録消去の assertion も `null` へ更新）。FINDINGS 第7バッチ注記の pong 行の残りは本修正で塞いだため訂正する。
- 注記（修正せず・差し戻し対象外）: (a) lightsout の盤マスは `role="gridcell"` に `aria-pressed` を付与しているが ARIA 的には gridcell に無効な属性。第2バッチレビューの montecarlo・第3バッチレビューの sudoku と同じ扱いで注記のみ。 (b) puttgolf のコース面は touchAction: "none" のため、コース起点の縦スクロールは奪われる（spider・tents 等の盤面と同じ扱い）。 (c) minesweeper・lightsout の盤マスは終局後も tabIndex={0} のままフォーカス可能だが、操作は lib 側のガードで no-op（HEAD のボタンも disabled なしで同一のため parity あり）。 (d) 指摘1の修正は実ブラウザでのタッチ確認が未了（subagent はライブブラウザ不可）。静的テスト＋実コード精査では検証済みだが、親による実機でのダブルタップ=ポーズ確認を推奨する。
- レビューでの変更ファイル: web/app/games/pong/PongClient.tsx（指摘1）、web/tests/games-gesture-batch7.test.mjs（回帰 assertion 1件追加）、FINDINGS-gesture.md（本節追記）。対象外（balku / lll / online / chess）・共有基盤（lib/gesture.ts・OnlineShell）には触れていない。GitHub・Discord・Pi 操作なし。

## 07:30 フリーズ（2026-11-14）— コーディネーター最終確認
- 最終フルテスト（07:30前、コーディネーター実施）: `cd web && npm test` **1526 / 1526 pass**、`npx tsc --noEmit` クリーン。
- ベースライン 1379 → 1526（+147件：バッチ1 +11、バッチ2 +16→レビューで+2、バッチ3 +22→レビューで+2、バッチ4 +22→レビューで+3、バッチ5 +22→レビューで+3、バッチ6 +22、バッチ7 +22）。
- 変更ファイル: 修正56件＋新規9件（FINDINGS-gesture.md、web/lib/gesture.ts、tests/games-gesture-batch1〜7.test.mjs）= 計65ファイル。diffstat: 2470 insertions(+), 1896 deletions(-)。
- 完了バッチ: 第1（8本）・第2（8本）・第3（8本）・第4（8本）・第5（8本）・第6（8本）・第7（8本）= 計56ゲーム。対象外（balku / lll / online / chess）・GitHub・Discord・Pi には触れていない。
- 親への委ね事項（各バッチレビューからの申し送り）:
  - 第3バッチレビュー指摘4: solitaire のもどる・自動移動、tsume の1手戻す、battleship の全消し・ランダム・確定、sudoku のヒントはスワイプのみでキーボード経路なし。キー割当は設計判断のため未対応。
  - suppressClickAfterSwipe（第3バッチレビュー指摘1）の実ブラウザでのタッチ確認が未了。08:00出荷前の実機スワイプ確認を推奨。
  - backgammon のバー復帰修正（第5バッチレビュー指摘1）、pong のダブルタップ=ポーズ位置ガード（第7バッチレビュー指摘1）、breakout の下スワイプ=ポーズの誤発火は実ブラウザでの確認が未了。
  - anagram のヒント誤発火の残り（空き→マスの順のダブルタップ）、sokoban の戻す誤発火の残り（床→箱の順）は頻度低として注記のみ。
  - montecarlo / sudoku / lightsout の `role="gridcell"` に `aria-pressed`（ARIA的に無効）は注記のみ。
- 未完了: なし（第1〜第7バッチすべて完了・レビュー済み）。残りのゲーム（<button> 4件以下が多数）は未着手。08:00の一括出荷待ち。
