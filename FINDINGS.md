# Webゲーム ブラッシュアップ監査所見（2026-11-12）

作業ツリー: ~/workspace/web-games-brushup（現行 main 0b42400 の clone）

## 遊べない監査・前半（38本、コード検証済み）

### 最優先（遊べない／詰む）
- **kanacross — 遊べない**: 画面パレットに濁点・半濁点カナが無く、14問中11問が完成不可能（対象文字を含むマスを埋められない）。代替は物理キーボードのみ。→ パレットに濁点・半濁点を追加（または゛゜トグル）
- **blackjack — 永続的に詰む**: 残チップ1〜9で再支給ボタンが空振り（refillChips は chips===0 のみ補充、nextRound も chips<=0 のみ）。localStorage 保存のため再読み込みでも復帰不能。→ 補充条件を「ベット可能額未満」に是正
- **stacker — 詰むことがある**: Space の二重発火（window keydown と盤面 onKeyDown の両方が drop を呼ぶ）。→ 片方に一本化/stopPropagation
- **numbermemory — 詰むことがある**: 正解31桁 vs 入力欄 slice(0,30)。→ 入力上限を問題桁数に追随

### 不便（強い）
- **wordle**: 辞書310語のみで一般語（HELLO/WORLD等）が拒否される。→ 辞書増量（推測許可リストを拡大）

### 不便
- fifteen / lightsout / nonogram（＋maze 軽微）: 経過タイマーの useEffect 依存に state.moves が入り、着手ごとにタイマーが張り直されてベスト記録が実時間より短くなる。→ 依存を [state.status] に（sudoku の形が正）
- reaction: フォーカス残りのスペースで計測がリスタート化
- aim: 当たり判定が表示の円と縦方向にずれる（座標正規化と描画の不一致）。上下端の的が欠ける
- slot: 停止済みリールが回転 interval で書き換わり続ける（結果・配当は正）
- dodge: blur 時にキー押しっぱなしが残る
- mole: ヒット済み再タップでコンボ切れ、+得点表示の残留
- breakout: タッチ移動にクランプなし／待機中キー移動不可（軽微）
- pong: 待機中キー移動不可（軽微）。lib/pong.ts が無く Client 内実装
- falling: ポーズ中もサイドのホールドボタンだけ効く（軽微）
- simon: 条件付きでパッド常時点灯（軽微）
- roulette: 回転中の賭け変更可・賭け金超過でもスピン可（押して初めてエラー）・列ベットの対象数字が画面に出ない（軽微3件）
- spotdiff: 0秒クリアでベスト未保存（軽微）
- touchnumber: クリアタイムが最大約0.1秒古くなりうる（軽微）

### OK（20本）
sudoku, snake, solitaire, typing, colormatch, maze, mastermind, hangman, peg, hanoi, bingo, amida, quiz, numbercode, stopwatch, darts, touchnumber, flagquiz, highlow ほか

## 元ネタ・競合リサーチ（完了、全文 ~/workspace/research_notes/web-games-differentiation-research-20261112-0212/report.md）

**基準の正体**: 画質ではなく「入力の手触り＋検証済みパズル＋アニメーションと音のフィードバック＋デイリー/連続記録＋終了画面」の5点。

**ジャンル必須の入力（現状に欠けているもの）**:
- 数独: メモ（候補数字）モード＋自動更新、重複ハイライト
- マインスイーパー: コード入力（両クリック同時押し）、推測不要（No-Guess）盤面が標準
- ソリティア: ドラッグ＆タップ移動、オートフィニッシュ、無制限 undo
- 倉庫番: 箱クリックで最短押し、undo、Moves と Pushes の別記録、デッドロック警告
- ノノグラム: 塗りと×印の両ツール、ドラッグ塗り、確定した手がかりの消し込み
- リバーシ/五目: 合法手ドット、反転プレビューと逐次反転アニメーション
- 2048: スライド/合体/出現のアニメーション（約100〜150ms）が基準そのもの
- ワードル: 全員共通デイリー、タイル反転の逐次開示、統計（勝率・連続・推測分布）
- 詰将棋: 手数帯別の大量・検証済み問題、1手ごとの正誤、棋譜再生
- 大富豪: ローカルルールのトグル群自体が商品、打てるカードのハイライト
- お絵かき当て: 出題者は3語から選択、最速正解が高得点、文字の段階開示、カスタム単語リストが再訪理由

**ポータルの継続ループ（CrazyGames/Poki/NYT の共通形）**: ログイン不要で遊べる → 1つの identity が全部を保持 → 今日の日付の理由（デイリー） → 蓄積の可視化 → 小さい比較集団（サーバー/フレンド。グローバル順位は意味が薄い） → 終了画面で次のゲームへ誘導。

**AGO だけができる差別化（一般ポータルには不可能）**:
1. Discord identity（Web 側も Discord OAuth/SDK 認証で Bot と同一プロフィールに。現状は捨てている）
2. VC 内プレイ（ワードウルフ公式ブラウザ版ですら音声なしで「Discord を併用して」と案内している＝AGO の土俣そのもの）
3. サーバー内ランキング（「サーバーで3位、上が知り合い2人」）＋週間シーズン
4. Bot が結果カードと朝のデイリー一覧をチャンネルへ投稿（共有は Discord ネイティブ形式で）
5. サーバーごとのカスタム単語パック（内輪ネタ＝他では遊べないコンテンツ）
6. Bot 経済との接続（上限は高いが AGO 側の通貨と消費先が前提条件）

**実装の優先順（リサーチの推奨）**:
基礎品質: (1) 共通の音＋演出キット（Web Audio 合成 SE、120〜180ms の遷移、勝利時のみ紙吹雪） (2) 看板ジャンルの必須入力 (3) ソルバー検証（一意解・No-Guess・詰み検証） (4) 共通フックでの永続化/再開/ベスト記録 (5) シード式デイリー基盤（seed=game+JST日付、記録対象は1回だけ） (6) 共通の終了画面（ベスト差分・統計・次のデイリーへの導線）
差別化: (1) Bot 投稿の結果カード＋デイリー一覧 (2) Discord identity 基盤 (3) サーバー別週間ランキング (4) デイリークエスト＋XP (5) シード式 1v1 チャレンジリンク

## 遊べない監査・後半（89本、コード検証＋実測裏取り済み）

集計: OK 61本 / 問題あり 28本（遊べない2・詰むことがある14・不便12、重複含む）

### 最優先（遊べない／詰む・実証済み）
- **shikaku — 遊べない**: 解に必要な1×1長方形を UI で描く手段がなく、400局面中311局面（数字1を含む）がクリア不能
- **nanja — 遊べない（ゲーム性崩壊）＋詰む**: 叫ぶフェーズで正解名が場と一覧に常時表示され記憶ゲームが成立しない。flip/shout フェーズに制限時間がなく放置で永久停止
- **hashi — 詰む（実証済み）**: edgeByCell が交差辺で上書きされ、約9%の盤面で解の辺が操作不能（7×7の5盤面は UI 経由クリア不能と確定）
- **airhockey — 詰む（実証済み）**: パドル衝突後に場内クランプがなく、パックが場外に固着して 0-0 のまま進行しない
- **dragrace — 詰む**: グリーン後5秒超過の launch が無言棄却され二度と発進できない。interval ハンドルのリークもあり
- **halma — 詰む（実証済み）**: 終局・反復検出がなく CPU 同士が4手周期ループで勝敗が付かない
- **spider — 詰む**: 詰み状態自体が存在せず、合法手が尽きても終了表示が出ない
- **オンライン基盤-1（横断・根本原因）**: タブ/ブラウザを閉じても「退出」にならない（pagehide/sendBeacon の離脱送信なし、プレゼンスタイムアウトなし）。手番制・全員提出待ちゲームで残った側が永遠に待つ。直接影響: checkers（反復引き分けなしも併発）, wordwolf（投票フェーズに締切なし）, texas（手番タイムアウトなし）, liarsdice / domino / cheat / hagetaka（tick 自体なし）, dartsbattle（tick が無く唯一手番タイムアウトの仕組み自体が存在しない）, tictactoe / babanuki / territory
- **typerace — 詰むことがある**: 完走時の最終進捗送信が基盤の busy ガードで捨てられると回復不能で「完走できず0点」になる
- **オンライン基盤-2**: useOnlineRoom の postWithRevision が busy 中の move を無言で捨てる（speed/drawguess/typerace で顕在化。drawguess は描いた線が消える、speed は札が出ない）

### 不便
- タイマー過小計測（useEffect 依存に手数系が入る同型）: kakuro / skyscrapers / slant / akari / knightstour / queens / hashi（前半の fifteen/lightsout/nonogram/maze と合わせて11本に同型）
- freecell: undo が存在せず、もう一度が別盤面になる（同じ盤面に再挑戦不可）
- pyramid: ウェイスト選択中にストックをめくると選択が別カードに移る／詰み表示後もストックをめくり続けられる
- chesspuzzle: 昇格パネルが選択変更後も残り、前のポーンが昇格する混乱
- flashanzan: 空欄で回答すると 0 が確定する
- liarsdice: 宣言フォーム初期値が現在の宣言に追随しない
- shiritori: 開始文字「ゼ」のバンク単語が2語のみ（時間切れで決着はつく）

### OK（61本）
sokoban, sugoroku, anagram, pipe, drawpoker, nurikabe, columns, dicequest, pentomino, numberlink, yahtzee, wordsearch, baccarat, mushoku, floodit, laser, golf, backgammon, rushhour, montecarlo, samegame, tents, blockpuzzle, watersort, mahjong, kenken, binairo, cube, diceroll, alphametic, river, cranegame, mergefruit, icemaze, hearts, puttgolf, tsume, bowling, penalty, missile, billiards, curling, balancestack, chinchiro, crocodile, kwordle, tictactoe, babanuki, territory, quizbattle, janken, bombpass, majority, minority, countdown, burst, stopbattle, bingobattle, simonbattle, calcrace, musicalchairs, wordbasket

## ユーザー追加指示（2026-11-12 11:19）
- ワニワニとボウリングは「本当に酷かった」（監査では機能面 OK だったが、体感品質の問題）。作り直し対象に格上げ
- 視覚表現を採用するなら **3D を採用**すること。特にボウリングは 3D でないと面白くない（ユーザー明言）
- 対応: three.js を新規依存に追加し、ボウリングは 3D レーン＋ピン＋投球物理で全面再構築、ワニワニも 3D のワニ頭部＋歯タップ＋顎が閉じる演出で再構築する

## ユーザー追加指示（2026-11-12 11:26）— 最重要
- 「遊べないのを直すだけじゃダメ」。動作しても「これ遊ぶん？」となるのが問題
- **最大の問題は演出の不在**: 入力に対して結果だけが単調に返っている。動き・音・期待感・結果の見せ方が無い
- 判定基準はコード監査ではなく「人間視点で実際に遊ぶかどうか」
- 対応: 優先順を組み替える。演出（共通キット＋全ゲーム適用）を本命に格上げし、「人間が遊ぶか」のプレイレビューを出荷前の関門にする。遊ばない判定のゲームは作り直すか落とす。遊べない修正と3D再構築は土台として継続

## 実施記録
- 3D 再構築（bowling / crocodile）完了: three@0.187 を追加（対象2ページのみ動的 import、共通 First Load JS は 103kB のまま）。bowling は木目レーン＋回転体ピン＋フリック投球（速さ・横速度・回転を算出）＋240Hz サブステップの 2D 円衝突物理（ピン連鎖・ガター・ピット片付け）、lib に throwPins（物理結果→既存スコア規則）を追加。crocodile は顎・目・歯をプリミティブ造形しレイキャストで歯タップ、外れ歯は約0.13秒で顎が閉じ画面シェイク。共通で lib/sfx.ts（Web Audio 合成 SE、ミュートは localStorage ago-sfx-muted で共通）を作成。絵文字は両ゲームから全廃。テスト33件パス、build 成功（234ページ）
- 統合検証（親）: バッチA＋B＋3D の全てが入った状態で npm test **1317/1317 パス**、tsc clean

## 実施記録（つづき）
- 絵文字排除E1（カタログ・ハブ・コンテンツ系）完了: games-catalog の glyph と accent を全廃しハブは「タイトル先頭文字＋ジャンル色タイル」表示に。nanja の絵柄は 6色×5形×カナの SVG バッジ（30種一意）へ、memory-match は形×色の SVG へ、river は漢字1字チップへ、flagquiz は flagcdn の国旗画像（ISO コードから全195組を機械導出、失敗時はコードタイルにフォールバック）へ、spotdiff はパレットがデータ駆動だったため形7×色4の図形トークンへ置換。対象テスト全パス、build 成功（検証は編集中の sokoban を除いたコピーで実施）。✓/✗ は機能的なテキスト記号として残置
- 並行チャットの出荷で main が前進している（PR #773 レベルアップ通知等）。本ブラッシュアップの出荷前に必ず現行 main と突き合わせること

## 実施記録（つづき2）
- 絵文字排除E2（装飾の全掃討）完了: 実測217字/78ファイル → 絵文字プレゼンテーション文字 0。結果バナーの 🎉 やボタンの 🎲💡 等は除去/テキスト化、中身系は図形・文字へ置換（mergefruit=色＋カナの円バッジ、cranegame=色＋短ラベル、slot=漢字シンボル、sokoban=四角と円、minesweeper の地雷と旗は SVG、janken は手のテキスト化 等）。残したのは麻雀牌の文字表現、カード裏面グリフ、ゲーム外のデータ（dashboard-core の絵文字ロール設定値、command-guides の説明文中の言及）のみで、いずれも Web ゲーム UI の装飾ではない。対象テスト1125件パス、tsc clean
- 差別化D1（ハブのデイリー帯）完了: lib/games-catalog.ts に jstDateKey と dailyPicksFor（日付シードの決定的選出、playable のみ・wordle 除外）を追加し、ハブ先頭に「今日のデイリー」帯（今日のワードル枠＋日替わりおすすめ3本＋ago-wordle-stats の連勝バッジ、記録なしでは出ない）を実装。テスト24件パス、build 成功
- 看板ジャンル必須バッチG完了（全体 1349/1349 パス、tsc clean）: 数独は既存実装あり（ヒント時のメモ除去漏れのみ是正）、マインスイーパーは論理ソルバー検証つき推測不要盤面（初手レイテンシ最大93ms）＋コード入力、ソリティアはオートフィニッシュを追加（undo とダブルクリックは既存）、倉庫番はベストを手数/押し回数で分離＋デッドロック検出（角・壁沿い・2×2凍結の保守的3パターン）＋クリック押し、ノノグラムは手がかり消し込み（ドラッグ塗りは既存）、リバーシは反転アニメーション（合法手ドットは既存）、2048 は移動詳細 API を足して本物のスライドアニメーション化、Wordle はデイリー（JST 日付シードで全員共通、既定モード）＋成績記録＋ブロック文字シェア、大富豪はルールトグル4種（革命/8切り/スペ3返し/縛り、既定=現行挙動）、お絵かき3択は既存実装あり（回帰テストのみ追加）
- バッチC（横断パターンと不便16件）完了: タイマー依存を11本で [status] のみに統一、wordle 辞書 311→696語（正解プール不変）、freecell に undo＋同じ盤面でもう一度、pyramid の選択移りと詰み時ストック停止、chesspuzzle の昇格パネル残留、flashanzan の空欄ガード、slot の停止リール固定、aim の判定/描画座標の統一、reaction の blur 是正、mole の再タップと表示残留、dodge の blur リセット、simon の pressed リセット、roulette の回転中 disabled と列ラベル明示、spotdiff の0秒ベスト、liarsdice のフォーム同期、しりとり 1600→1610語（ゼ始まり10語、行き止まり0件を機械確認）。テスト519件パス、tsc clean
- バッチJ-online（オンライン36本への演出適用）完了: 音は OnlineShell の SE トグルに連動する balku-sound 側に統一（lib/sfx を混ぜない判断）、結果バナーは EndScreen 化せず juice-slide/pulse＋終局ジングルで代替（OnlineShell 側に再戦/退出導線が既にあるため二重導線を回避）。再戦後に終局 SE が鳴らなくなる問題を7本で是正、wordwolf/liarsdice/domino/cheat の4本は SE 自体が皆無だったため新規配線。全体 npm test 1327/1327 パス、tsc clean。これで演出の適用は全ゲーム完了。未着手として明示された残: オンライン結果バナー内の絵文字（絵文字排除バッチで対応）
- バッチJ-c（残りソロ27本への演出適用）完了: fifteen〜airhockey の全本に音と EndScreen（slot/roulette は継続型のため EndScreen なし、simon は独自トーンが演出の核のため音は既存のまま終了画面と shake のみ、SVG 盤面の slant/halma は CSS アニメーション干渉のため音と EndScreen のみ）。対象テスト548件パス、tsc clean
- バッチJ-b（アクション・カード・言葉系ソロ42本への演出適用）完了: 全本に効果音と juice、終了画面があるものは EndScreen 化（あみだ・クレーンゲームは勝敗のない設計のため音と juice のみ、drawpoker/baccarat/blackjack はチップ継続型のため EndScreen なしが正）。sfx の import は既存慣例どおり @/lib/sfx を使用。対象テスト全パス、tsc clean。要確認: games-a44 のしりとり語数アサーション（1610語化との整合）を全体実行で再確認する
- バッチJ-a（パズル・ボード系ソロ30本への演出適用）完了: 全本に効果音（操作・正誤・終局ジングルは遷移時に1回だけ）、EndScreen（ベスト連携は保存方式により可否を判断）、juice クラス（出現 pop・誤り shake・注目 pulse 等）を適用。対象テスト全パス、tsc clean
- 演出キット完了: lib/sfx.ts に汎用 SE 12種（tap/place/flip/deal/dice/correct/wrong/win/lose/tick/spawn/slide、全て Web Audio 合成、ミュート共通）を追加。app/games/GameJuice.tsx に EndScreen（勝利時の紙吹雪・スコアのカウントアップ・ベスト更新バッジ・もう一度/ハブ導線）/ ScorePop / useAnimatedNumber を新設。globals.css に juice-* の keyframes とクラス（遷移 120–180ms、イージング統一）を追記。テスト6件パス、build 成功
- バッチA（ソロ10本の遊べない修正）完了: kanacross パレットに濁点・半濁点3行追加（lib に KANA_PALETTE_ROWS を export し全問カバー検証）、blackjack 補充条件を「最小ベット未満」に是正（補充額は既存定数 1000 に統一、ボタン表記と一致）、shikaku は数字マスの同マス再タップで1×1確定、hashi はセル→候補辺の多重対応＋交互選択で交差セルでも解の辺に到達可能、airhockey は衝突後に場内再クランプ、stacker はキー経路1本化＋repeat ガード、numbermemory は入力上限を問題桁数に追随、dragrace は発進棄却の理由表示＋再スタート可＋interval リーク修正、halma は同一局面3回/300手で引き分け＋CPU の反復回避、spider は詰み検出と表示を追加。新規テスト19件＋関連216件全パス、tsc clean
- バッチB（オンライン基盤＋nanja）完了: pagehide/beforeunload で退出送信（sendBeacon 優先）、dartsbattle に tick＋1投30秒締切、wordwolf 投票に60秒締切、texas 手番に30秒締切＋自動フォールド、nanja は対局中 names を null 配布に変えて秘匿化＋flip/shout 各30秒の締切、typerace は送信成功時のみ sentRef を進め完走進捗を自動再送。テスト94件＋関連67件全パス、tsc clean。前提: リロードも退出扱いになる（再参加は新規参加フロー）

## 実施計画（統合）
1. バッチ1 遊べない修正（ソロ）: kanacross / blackjack / shikaku / hashi / airhockey / stacker / numbermemory / dragrace / halma / spider
2. バッチ2 遊べない修正（オンライン）: nanja（名前秘匿＋フェーズタイマー）、基盤の離脱検知（pagehide で退出）＋手番タイムアウト（dartsbattle/wordwolf 投票/texas）、typerace の完走進捗の再送、基盤-2 の move 失敗時の扱い
3. バッチ3 横断パターンと不便: タイマー依存の是正（11本同型）、wordle 辞書増量、freecell の undo＋同盤面再挑戦、pyramid / chesspuzzle / flashanzan / slot / aim / reaction / mole / dodge / simon / roulette / spotdiff / liarsdice の各是正、しりとり「ゼ」等のバンク補強
4. バッチ4 絵文字排除: カタログ glyph 廃止＋ハブの見せ方再設計、各ゲーム内の装飾・駒絵文字を描画/文字へ置換（国旗は問題コンテンツとして扱いを明示）
5. バッチ5 基礎品質の共通基盤: 音＋演出キット、共通の終了画面、記録/再開の共通フック
6. バッチ6 看板ジャンルの必須入力: 数独メモ、マインスイーパーのコード入力＋推測不要盤面、ソリティアのドラッグ＋オートフィニッシュ、倉庫番のクリック押し＋Pushes 記録、ノノグラムの×印＋ドラッグ塗り、リバーシの合法手ドット＋反転アニメーション、2048 のアニメーション
7. バッチ7 差別化: シード式デイリー、Discord identity、サーバー別週間ランキング、Bot 投稿の結果カード/デイリー一覧、チャレンジリンク
