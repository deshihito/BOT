// WEB ゲームジャンル（/games）のカタログ。純粋データ＋参照だけのモジュール。
//
// ゲームを1本足すときは、ここに1エントリ追加し、対局コンポーネントを
// app/games/<slug>/ に置いて app/games/[id]/page.tsx の振り分けに足す。
// 一覧ハブ（/games）と sitemap はこのカタログから自動で生成される。

export type WebGameStatus = "playable" | "coming-soon";

export type WebGame = {
  /** URL スラッグ（/games/<slug>）。 */
  slug: string;
  /** 表示名。 */
  title: string;
  /** 一覧と詳細に出す短い説明。 */
  description: string;
  /** 遊べる状態か、準備中か。 */
  status: WebGameStatus;
  /** Discord アクティビティ（埋め込み）内でもプレイできるか。 */
  activity: boolean;
  /** プレイ人数の目安表示。 */
  players: string;
};

export const WEB_GAMES: WebGame[] = [
  {
    slug: "chess",
    title: "チェス",
    description:
      "ブラウザでそのまま遊べる CPU 対戦チェス。着手生成は perft で検証済みのエンジンを使い、重い探索計算はあなたの端末（ブラウザ）の中で実行します。難易度は3段階、サーバーに棋譜は送られません。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "balku",
    title: "BALKU",
    description:
      "素材を集めて企画を完成させる建築ブラフのカードゲーム。ルームコードで集まってオンライン対戦。伏せて提出された企画が怪しければ「BALKU」とコールして暴けます。",
    status: "playable",
    activity: true,
    players: "1〜4人（オンライン/CPU対戦）",
  },
  {
    slug: "minesweeper",
    title: "マインスイーパー",
    description:
      "地雷を避けてマスを全部開く定番パズル。数字は周囲の地雷の数で、最初のマスは必ず安全です。難易度は3段階、旗モードでスマホでも遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "2048",
    title: "2048",
    description:
      "同じ数字をぶつけて大きくしていくスライドパズル。矢印キー・ボタン・スワイプで操作して、2048 のタイルを目指します。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "memory",
    title: "メモリーマッチ",
    description:
      "裏返したカードの絵柄を当てる神経衰弱。8ペア16枚を、手数の少なさを目指してそろえます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "reversi",
    title: "リバーシ",
    description:
      "挟んでひっくり返す定番ボードゲーム。ルームコードや公開ルームでオンライン対戦ができ、CPU相手に1人で遊ぶこともできます。角を取る読み合いが勝負です。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "connect4",
    title: "四目並べ",
    description:
      "コマを落として縦・横・斜めのどれか4つを先にそろえる対戦パズル。ルームコードや公開ルームでオンライン対戦ができ、CPU相手にも遊べます。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "gomoku",
    title: "五目並べ",
    description:
      "石を交互に置いて5つ並べた方が勝ちの古典ボードゲーム。ルームコードや公開ルームでオンライン対戦ができ、CPU相手に1人でも遊べます。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "battleship",
    title: "海戦ゲーム",
    description:
      "艦隊を配置して相手の海域を砲撃し合う読み合いの対戦ゲーム。ルームコードや公開ルームで集まってオンライン対戦できます。命中と沈没の駆け引きが鍵です。",
    status: "playable",
    activity: true,
    players: "2人（オンライン）",
  },
  {
    slug: "daifugo",
    title: "大富豪",
    description:
      "手札を全て出し切る順位を競う定番トランプゲーム。ルームコードや公開ルームで2〜4人がオンライン対戦でき、空き席にはCPUも入れられます。革命や流れる場の読み合いが楽しめます。",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン/CPU対戦）",
  },
  {
    slug: "werewolf",
    title: "人狼",
    description:
      "村人の中に紛れた人狼を、夜の襲撃と昼の議論・投票で見抜く正体隠匿ゲーム。ルームコードや公開ルームで4〜8人がオンラインで遊べます。役職は各プレイヤーにだけ知らされます。",
    status: "playable",
    activity: true,
    players: "4〜8人（オンライン）",
  },
  {
    slug: "lll",
    title: "LLL",
    description:
      "画像をスカウトして世界に1枚のカードを作り、3枚チームで戦うカードゲーム。「想像を、切り札に。」あなたの画像が、属性・ステータス・技を持つ切り札になります。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "sudoku",
    title: "数独",
    description:
      "縦・横・3×3ブロックに1〜9を重ならないように入れる定番パズル。唯一解の問題だけを出題し、メモとヒントも使えます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "fifteen",
    title: "15パズル",
    description:
      "タイルをスライドさせて1から順番に並べる定番パズル。必ず解ける盤だけをシャッフルして出題します。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "lightsout",
    title: "ライツアウト",
    description:
      "押したマスと上下左右が反転するパズル。全部消灯できればクリアで、どの盤も必ず解けます。サイズと難易度が選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "snake",
    title: "スネーク",
    description:
      "餌を食べて長くなる定番ゲーム。壁と自分にぶつからないよう操作し、食べるほど速くなる中でハイスコアを目指します。矢印キー・スワイプ・ボタン対応。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "breakout",
    title: "ブロック崩し",
    description:
      "パドルでボールを跳ね返してブロックを全部壊す定番アクション。ライフは3つ、全3レベル。マウス・タッチ・キーで操作できます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "pong",
    title: "ピンポン",
    description:
      "CPUと打ち合う元祖ビデオゲーム。パドルでボールを返し、先に7点取れば勝ち。難易度は3段階、マウス・タッチ・キー対応です。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "mole",
    title: "モグラたたき",
    description:
      "30秒間でモグラを叩く反射ゲーム。金モグラは高得点、連続ヒットでコンボボーナス。タップでもクリックでも遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "solitaire",
    title: "ソリティア",
    description:
      "52枚を組札にそろえる定番のクロンダイク。場札は色を交互に降順で重ね、組札はAから同スート昇順。タップ操作だけで遊べて、自動組札と「もどる」も使えます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "wordle",
    title: "ワード当て",
    description:
      "隠れた5文字の英単語を6回以内に当てる推測ゲーム。緑は位置も一致、黄は文字が含まれます。重複文字の判定も標準ルール通りで、キーボード対応です。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "typing",
    title: "タイピング",
    description:
      "英文を60秒でどれだけ正確に打てるかを測るタイピング計測。正しく打った文字からWPMと正確率を出し、ベストWPMは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "blackjack",
    title: "ブラックジャック",
    description:
      "21に近づけてディーラーに勝つ定番カードゲーム。ブラックジャックの配当は3:2、ダブルダウンもできます。チップは端末内だけの遊び用ポイントです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "stacker",
    title: "スタッカー",
    description:
      "左右に動くブロックをタイミングよく止めて積み上げるゲーム。はみ出した部分は切り落とされてだんだん細くなります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "colormatch",
    title: "色文字マッチ",
    description:
      "色の名前が、その文字の色とあっているかを当てる反射ゲーム。30秒で何点取れるか挑戦できます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "numbermemory",
    title: "数字記憶",
    description:
      "一瞬だけ表示される数字を覚えて入力する記憶ゲーム。正解するたびに桁数が増えていきます。何桁まで覚えられるか挑戦できます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "maze",
    title: "めいろ",
    description:
      "スタートからゴールまでの道を探す完全迷路。行き止まりは必ずどこかにつながっていて、最短路ヒントも出せます。サイズは3段階、矢印キーと画面ボタンで遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "mastermind",
    title: "マスターマインド",
    description:
      "隠された4つの色の並びを、ヒット＆ブローの手がかりから10回以内に当てる推理ゲーム。色は重複します。難易度で色数が変わります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "hangman",
    title: "ハングマン",
    description:
      "英単語の文字を1文字ずつ当てていく定番ゲーム。ミス6回で終了、カテゴリがヒントになります。画面キーとキーボードの両方で遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "reaction",
    title: "反応速度",
    description:
      "緑になった瞬間にタップするまでの速さを5回計測して平均で競う反射神経ゲーム。フライングはやり直し。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "aim",
    title: "エイム",
    description:
      "現れては消える的を30秒で撃ち抜くエイム練習。小さい的ほど高得点、速く当てるほどボーナスが付きます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "dodge",
    title: "よけゲー",
    description:
      "上から落ちてくる障害物を左右に動いて避け続けるサバイバル。生き残った時間がスコアで、時間とともに速く多くなります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "falling",
    title: "フォーリングブロック",
    description:
      "落ちてくる7種のブロックをそろえてラインを消す落下パズル。レベルが上がると落下が速くなります。キー操作と画面ボタンの両方に対応し、ホールドやハードドロップも使えます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "simon",
    title: "サイモン",
    description:
      "光る色と音の順番を覚えて同じ順番で押していく記憶ゲーム。ラウンドごとにシーケンスが1つずつ長くなります。音が出ない環境でも色の点滅だけで遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "tictactoe",
    title: "三目並べ",
    description:
      "○と×を交互に置いて縦・横・斜めの3つを先にそろえる定番ゲーム。ルームコードや公開ルームでオンライン対戦ができ、CPUは最善手を指すので引き分けに持ち込めるかが勝負です。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "checkers",
    title: "チェッカー",
    description:
      "斜めに進んで相手のコマを飛び越えて取り合う古典ボードゲーム。取れる手があるときは必ず取る強制取りと連続取りがあり、最奥列でキングに昇格します。オンライン対戦とCPU対戦の両方に対応。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "babanuki",
    title: "ババ抜き",
    description:
      "ジョーカー1枚入りの53枚で遊ぶ定番トランプゲーム。ペアを捨てて手札をなくした人から上がり、最後までジョーカーを持っていた人が負け。隣の手札は枚数しか見えないので、引く位置の読み合いが勝負です。",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン/CPU対戦）",
  },
  {
    slug: "territory",
    title: "テリトリオ",
    description:
      "ポリオミノを自分の角から角接触だけで広げる2人用陣取りゲーム。辺で接する置き方は禁止、両者とも置けなくなったらマス数の多い方が勝ち。回転・反転を駆使して相手より広く埋めよう。",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "nonogram",
    title: "ノノグラム",
    description:
      "行と列の数字を手がかりにマスを塗るお絵かきロジック。塗る／×印の2モードとドラッグ塗りに対応し、間違えて塗ると分かります。完成すると絵が浮かび上がります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "peg",
    title: "ペグソリティア",
    description:
      "ペグが隣のペグを飛び越えると飛び越えられたペグが消える、英式33穴の一人パズル。最後に1つだけ残せれば完全クリアです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "hanoi",
    title: "ハノイの塔",
    description:
      "円盤を1枚ずつ動かして塔を右端の柱へ移し替える定番パズル。枚数は3〜8、最少手数への挑戦と自動解答の再生ができます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "speed",
    title: "スピード",
    description:
      "中央の札と±1つながりの場札を、相手より速く出し切る同時進行のトランプ対戦。ルームコードや公開ルームで2人がオンラインで遊べます。詰まったら両者の合意でつなぎ札が出ます。",
    status: "playable",
    activity: true,
    players: "2人（オンライン）",
  },
  {
    slug: "slot",
    title: "スロット",
    description:
      "3つのリールを揃える運試し。セブン3つで300倍、先頭2つのチェリーでも2倍の配当があります。チップは端末内だけの遊び用ポイントです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "bingo",
    title: "ビンゴ",
    description:
      "5×5カードでCPU 3人と対戦するビンゴ。数字を引いて縦・横・斜めの1ラインを先にそろえた方が勝ち。自動進行もできます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "amida",
    title: "あみだくじ",
    description:
      "参加者と景品を決めて作る定番のあみだくじ。名前と景品はその場で編集でき、経路はアニメーションでたどれます。2〜8人対応。",
    status: "playable",
    activity: true,
    players: "2〜8人",
  },
  {
    slug: "kanacross",
    title: "カナクロス",
    description:
      "ヒントからカタカナ単語を当てるクロスワード。交差する単語を読み解いて全マスを埋めます。問題は14問、チェック機能とタイマー付き。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "quiz",
    title: "クイズ",
    description:
      "雑学・科学・歴史・スポーツ・アニメ・ゲームから10問出題される4択クイズ。連続正解でボーナスが付き、結果ではカテゴリ別の正答率も分かります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "numbercode",
    title: "ナンバーコード",
    description:
      "重複のない3桁の数字を当てる推理ゲーム。10回までの回答でコードを解き明かそう。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "stopwatch",
    title: "ストップウォッチ",
    description:
      "ちょうど10.00秒で止める体内時計チャレンジ。5秒から表示が隠れるブラインドモードもあり、ベスト誤差は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "quizbattle",
    title: "クイズバトル",
    description:
      "2〜4人で早押し感覚のクイズ対戦。全8問、各問15秒の制限時間つきで、正解は速いほど高得点。ルームコードや公開ルームでオンライン対戦できます。",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン）",
  },
  {
    slug: "darts",
    title: "ダーツ",
    description:
      "ボードをクリックして投げるカウントアップ。3投×8ラウンドの合計点を競います。中心のブルは50点、手ブレのON/OFFも切り替えられます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "touchnumber",
    title: "タッチザナンバー",
    description:
      "1から順番に数字をタップしていく集中力ゲーム。ミス1回で+3秒のペナルティ。25マスと50マスが選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "roulette",
    title: "ルーレット",
    description:
      "欧式ルーレットにチップを賭けるカジノゲーム。赤黒や単数など9種の賭け方が選べます。チップは端末内だけの遊び用ポイントです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "wordwolf",
    title: "ワードウルフ",
    description:
      "1人だけ違うお題を持っている少数派を、議論と投票で当てる正体隠匿ゲーム。ルームコードや公開ルームで3〜6人がオンラインで遊べます。",
    status: "playable",
    activity: true,
    players: "3〜6人（オンライン）",
  },
  {
    slug: "spotdiff",
    title: "間違い探し",
    description:
      "左右の絵を見比べて、右の盤で違っているマスを全部見つけるパズル。間違いは3・5・7個から選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "flagquiz",
    title: "フラッグクイズ",
    description:
      "世界の国旗の4択クイズ全10問。旗から国名を当てる問題と、国名から旗を当てる問題が出ます。最後に復習リストで振り返れます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "highlow",
    title: "ハイ＆ロー",
    description:
      "次のカードが今より高いか低いかを当てる運試し。同数は引き分けで続行、外すと終了。連続正解のベスト記録が残ります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "drawguess",
    title: "お絵かき当て",
    description:
      "描き手がお題を絵で描いて、他の全員が当てるオンライン対戦。お題は描き手だけに3択で示され、正解は速いほど高得点。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "sokoban",
    title: "倉庫番",
    description:
      "箱を押して全部のゴールの上に運ぶ定番パズル。全6面、1手戻し対応。箱は引けないので詰まらない順番が大事です。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "sugoroku",
    title: "すごろく",
    description:
      "30マスのコースでCPU 2人と競争するレース。進む・戻る・1回休み・コインのマスをかいくぐり、先にゴールを目指します。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "anagram",
    title: "アナグラム",
    description:
      "バラバラになったカタカナの文字を並べ替えて元の単語を当てるクイズ。全10問、ヒントは1文字開示で-20点です。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "janken",
    title: "じゃんけん大会",
    description:
      "2〜8人で同時に出す多人数じゃんけん。全5ラウンド、出た手が2種類だけのとき勝つ手の全員に1点。ルームコードや公開ルームでオンライン対戦できます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "pipe",
    title: "パイプつなぎ",
    description:
      "タイルをタップで回転させて、水源から排水口まで水を通すパズル。水が届いたパイプは青くなります。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "drawpoker",
    title: "ドローポーカー",
    description:
      "5枚配って1回だけ交換し、役に応じて配当が付くビデオポーカー式。ワンペアはJ以上のペアだけ配当があります。チップは端末内だけの遊び用ポイントです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "bombpass",
    title: "爆弾パス",
    description:
      "爆弾をパスし合うオンライン対戦。爆発した瞬間に持っていた人が1失点、3失点で脱落、最後の1人が勝ち。爆発までの時間は誰にも分かりません。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "shiritori",
    title: "しりとり",
    description:
      "単語バンクの言葉だけでつなぐオンラインしりとり。「ン」で終わる言葉を出すと脱落、1ターンは30秒。最後の1人が勝ちです。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "nurikabe",
    title: "ぬりかべ",
    description:
      "数字は島の大きさ。島同士は離し、海は全部つなげて2x2の塊を作らないように塗り分けるロジックパズル。5×5と7×7が選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "freecell",
    title: "フリーセル",
    description:
      "4つのフリーセルを一時置き場に使い、全カードを組札へAからKまでそろえるソリティア。まとめて動かせる枚数は空きの数で変わります。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "columns",
    title: "コラムス",
    description:
      "3個縦の宝石を落として、縦・横・斜めに3つそろえて消すパズル。回転で並びを変え、連鎖で高得点を狙います。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "majority",
    title: "多数決ゲーム",
    description:
      "「○○といえば？」のお題に、みんなと同じ答えを選ぶオンライン対戦。最多得票の答えを選んだ人全員に得点が入ります。ルームコードや公開ルームで2〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "hashi",
    title: "橋をかけろ",
    description:
      "島と島を橋でつなぐロジックパズル。数字はその島から出る橋の総数で、橋は最大2本まで・交差禁止。全部の島が1つにつながればクリアです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "dicequest",
    title: "ダイスクエスト",
    description:
      "白と色のダイスを振って、4色の行に合計をチェックしていくソロダイスゲーム。行は一方向にしか進めず、失敗3回で終了。チェック数でスコアが伸びます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "pentomino",
    title: "ペントミノ",
    description:
      "5マスのピース12種を長方形の盤に全部はめるパズル。回転と反転を駆使して60マスをぴったり埋めます。盤は6×10と5×12から選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "texas",
    title: "テキサスポーカー",
    description:
      "レイズなしの簡易テキサスポーカー。全5ハンド、アンティと各ストリート固定10点の参加かフォールドだけ。ルームコードや公開ルームで2〜6人がオンラインで遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "numberlink",
    title: "ナンバーリンク",
    description:
      "同じ数字同士を線でつなぎ、盤の全マスを埋めるパズル。線同士は重なれないので、引き回しが大事です。5×5と6×6が選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "pyramid",
    title: "ピラミッド",
    description:
      "合計13になるペア、または K 単体を取り除くソリティア。下の2枚が無くなったカードから使え、ストックは捨て山を裏返して再利用できます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "yahtzee",
    title: "ヤッツィー",
    description:
      "ダイス5個で役を作る定番ダイスゲーム。振り直しは2回まで、13の役を1回ずつ記録して合計点を競います。上段ボーナス35点つき。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "nanja",
    title: "ナンジャモンジャ風",
    description:
      "初めて出た生き物に名前を付け、再び出たら名前を叫んで山を取り合うオンライン対戦。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "wordsearch",
    title: "ワードサーチ",
    description:
      "9×9の文字盤に隠れたカタカナ単語を8語探すパズル。単語の最初と最後の文字をタップして選ぶ2タップ式で、縦・横・斜めの逆向きでも見つかります。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "baccarat",
    title: "バカラ",
    description:
      "プレイヤーとバンカー、9に近い方の勝ちを予想するカジノゲーム。第3カードは正式ルールで決まり、バンカー勝利の配当には5%の手数料がかかります。チップは端末内だけの遊び用ポイントです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "liarsdice",
    title: "ライアーズダイス",
    description:
      "自分のダイスだけが見える読み合いのオンライン対戦。場全体のダイスの個数を宣言し合い、嘘だと思ったらチャレンジ。1の目はワイルドです。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "minority",
    title: "少数決ゲーム",
    description:
      "二択のお題で少数派を選んだ人だけが残るオンライン対戦。同数なら全員残り、無回答は脱落。最後の1〜2人が優勝です。ルームコードや公開ルームで3〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "3〜8人（オンライン）",
  },
  {
    slug: "mushoku",
    title: "虫食い算",
    description:
      "隠れた数字を推理して掛け算の筆算を完成させるパズル。部分積と積がすべて合えば正解で、整合する別の解でもクリアになります。2桁×2桁と3桁×2桁が選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "floodit",
    title: "フラッドフィル",
    description:
      "色を選んで左上から染め広げ、制限手数以内に盤全体を1色にするパズル。制限手数は必ず解ける範囲に設定され、ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "laser",
    title: "レーザーミラー",
    description:
      "鏡をタップで回転させて、発射口からの光を反射させて的に当てるパズル。おとりの鏡も混ざっています。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "countdown",
    title: "数字カウントダウン",
    description:
      "6つの数字と四則演算で目標の数に近づけるオンライン対戦。最も近い式を作った人が得点し、完全一致はボーナス。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "spider",
    title: "スパイダー",
    description:
      "1スート制の簡易版スパイダーソリティア。下降順にカードを重ね、KからAまでの13枚をそろえて取り除きます。8組そろえればクリアです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "golf",
    title: "ゴルフ",
    description:
      "台札の数字とプラスマイナス1のカードを場から取っていくソリティア。スートは不問で、KとAはつながりません。場札を全部取るのが目標です。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "backgammon",
    title: "バックギャモン",
    description:
      "ダイスでコマを進める古代のボードゲーム。相手の単独コマはヒットしてバーへ送れます。CPUとの対戦で、先に全部上がった方が勝ちです。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "domino",
    title: "ドミノ",
    description:
      "両端の目に合う牌をつないでいくオンライン対戦。手札を出し切るか、詰まったときに残りの目が一番少ない人が勝ち。ルームコードや公開ルームで2〜4人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン）",
  },
  {
    slug: "halma",
    title: "ハルマ",
    description:
      "星形の盤で対戦するチャイニーズチェッカー（2人戦）。隣のコマを飛び越えるジャンプ連鎖を駆使して、自分のコマ10個を相手の陣地へ先に移した方が勝ちです。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "rushhour",
    title: "ラッシュアワー",
    description:
      "車を前後にスライドさせて、赤い車を右端の出口から出すパズル。解けた配置から崩して作るので必ず解けます。ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "montecarlo",
    title: "モンテカルロ",
    description:
      "縦・横・斜めに隣り合う同じ数字のペアを取り除くソリティア。除去後は「詰める」で前へ寄せて山札から補充します。全52枚を取り除けばクリアです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "cheat",
    title: "ブラフ",
    description:
      "伏せ札を宣言して出し合う読み合いのオンライン対戦。嘘だと思ったら次の人がチャレンジ。手札を出し切れば上がりです。ルームコードや公開ルームで3〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "3〜6人（オンライン）",
  },
  {
    slug: "samegame",
    title: "セイムゲーム",
    description:
      "同色でつながったブロックをまとめて消すパズル。消すと上から落ちて列が詰まります。たくさんつながるほど高得点で、全部消すとボーナスです。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "tents",
    title: "テントと木",
    description:
      "木のそば（縦横）にテントを1つずつ張るロジックパズル。テント同士は斜めでも隣り合えず、行と列の端の数字がテントの数を示します。6×6と8×8が選べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "hagetaka",
    title: "ハゲタカ",
    description:
      "得点カードを競り合う読み合いのオンライン対戦。プラスのカードは一番高い数字、マイナスのカードは一番低い数字が出した人のもの。同じ数字同士は無効で持ち越しになります。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "burst",
    title: "バースト",
    description:
      "数字カードを同時に出し、小さい順に4つの列へ並べるオンライン対戦。列の6枚目を置いた人はその列を全部引き取ってペナルティ。ペナルティ最少の人が勝ちです。ルームコードや公開ルームで2〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "blockpuzzle",
    title: "ブロックスパズル",
    description:
      "9×9の盤にブロックを置き、縦・横の列や3x3をそろえて消すパズル。ブロックは回転できず、置けるものが無くなったら終了。ベストスコアは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "watersort",
    title: "ウォーターソート",
    description:
      "色の層をボトル間で注ぎ分けて、1本を1色にそろえるパズル。注げるのは同じ色の上か空のボトルだけ。必ず解ける問題だけが出題され、ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "mahjong",
    title: "麻雀ソリティア",
    description:
      "積み重なった牌から、フリーな同じ種類のペアを取り除いていくパズル。上に牌が無く、左右どちらかが空いている牌がフリー。必ず解ける配置だけが出題され、ヒントも使えます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "shikaku",
    title: "しかく",
    description:
      "盤面を長方形に切り分け、各長方形に数字を1つだけ入れ、その数字と面積が等しくなるようにするロジックパズル。5×5と6×6が選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "kenken",
    title: "ケンケン",
    description:
      "行と列に数字を1つずつ入れ、太線のケージは目標値と演算が合うようにする計算パズル。4×4と5×5が選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "binairo",
    title: "バイナリー",
    description:
      "0と1を埋めるロジックパズル。行と列で0/1は同数、同じ数字が3つ以上並ばず、埋まった行同士・列同士は同じ並びになりません。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "flashanzan",
    title: "フラッシュ暗算",
    description:
      "次々と表示される数字の合計を当てるオンライン対戦。ラウンドごとに数字の個数と桁数が増え、正解に一番近い人が得点、完全一致はボーナス。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "kakuro",
    title: "カックロ",
    description:
      "黒マスの右上の数字は右方向、左下の数字は下方向の列の合計。列の中で数字が重ならないように1〜9を埋める計算クロスパズル。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "cube",
    title: "2x2キューブ",
    description:
      "2×2のルービックキューブを展開図で見ながら回して6面をそろえるパズル。スクランブルは必ず解けます。ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "dartsbattle",
    title: "ダーツ対戦",
    description:
      "オンライン対戦のカウントアップダーツ。全8ラウンド×3投の合計点を競います。着弾点には全員同じ条件のブレが入ります。ルームコードや公開ルームで2〜4人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン）",
  },
  {
    slug: "skyscrapers",
    title: "ビルディング",
    description:
      "行と列に高さ1〜Nのビルを1つずつ置くロジックパズル。外側の数字は、その方向から見えるビルの数。高いビルの後ろは見えません。4×4と5×5が選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "slant",
    title: "スラント",
    description:
      "全部のマスに斜線を1本ずつ引くロジックパズル。点の数字は、その点につながる斜線の数と一致させ、斜線で輪を作らないようにします。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "stopbattle",
    title: "ストップウォッチ対戦",
    description:
      "目標タイムぴったりで止める体内時計のオンライン対戦。経過は表示されず、誤差が一番小さい人が得点。完全一致に近いほど高得点です。ルームコードや公開ルームで2〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "akari",
    title: "あかり",
    description:
      "電球を置いて全ての白マスを照らすロジックパズル。光は黒マスまで届き、電球同士は照らし合いません。数字のある黒マスは、接する電球の数がその数字と一致します。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "diceroll",
    title: "ダイスロール",
    description:
      "サイコロを転がしてゴールまで運ぶパズル。ゴールに止まったとき、上の目が指定の数字と一致すればクリア。転がすたびに目の向きが変わります。ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "bingobattle",
    title: "ビンゴ対戦",
    description:
      "抽選は全員共通、カードは各自専用のオンライン対戦ビンゴ。数字は自動で引かれてマスも自動で開き、縦・横・斜めの1ラインを最初にそろえた人が勝ち。ルームコードや公開ルームで2〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "alphametic",
    title: "覆面算",
    description:
      "カタカナの記号に数字を割り当てて、足し算の式を成立させるパズル。同じ記号は同じ数字、違う記号に同じ数字は使えず、先頭の記号に0は入りません。解は必ず1つだけです。ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "river",
    title: "川渡り",
    description:
      "農夫がボートで荷物を全て向こう岸へ運ぶ古典パズル。農夫のいない岸に危険なペアを残すと失敗。全12題、最短手数は全探索で計算済みです。あなたの最少の渡河回数は問題ごとに端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "simonbattle",
    title: "サイモン対戦",
    description:
      "光る色の並びをみんなで育てるオンライン対戦。手番の人は並びを再現して末尾に1色追加し、間違えた人は脱落。最後まで残った人が勝ち。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "knightstour",
    title: "ナイトツアー",
    description:
      "チェスのナイトの動きだけで盤の全マスを1回ずつ訪れるパズル。必ず解ける盤だけが出題され、行き詰まったら1手戻せます。5×5と6×6が選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "queens",
    title: "クイーン配置",
    description:
      "縦・横・斜めに利くクイーンを、互いに利き合わないように全部置く古典パズル。利き筋が見えるので、置ける場所を考えながら進められます。6×6と8×8が選べ、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "calcrace",
    title: "計算レース",
    description:
      "全員に同じ計算問題が出て、最初に正解した人だけが得点するオンライン対戦。速く解くほど高得点で、間違えるとその問題だけ少し待つ必要があります。全10問、後半ほど難しくなります。ルームコードや公開ルームで2〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜8人（オンライン）",
  },
  {
    slug: "cranegame",
    title: "クレーンゲーム",
    description:
      "動くクレーンを2回止めて景品を狙うゲーム。1回目で横、2回目で奥行きを決め、景品の中心に近いほど掴めます。重い景品ほどシビアです。取れた景品の累計は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "musicalchairs",
    title: "椅子取り",
    description:
      "音楽が止まったら椅子を取り合うオンライン対戦。一番遅かった人が1人ずつ脱落し、最後まで残った人が勝ち。反応の順位はサーバーが受け取った順で決まります。ルームコードや公開ルームで3〜8人が遊べます。",
    status: "playable",
    activity: true,
    players: "3〜8人（オンライン）",
  },
  {
    slug: "mergefruit",
    title: "フルーツマージ",
    description:
      "列にフルーツを落として、同じフルーツ同士をくっつけて大きくしていくパズル。2個以上くっつくと合体して次の段階になり、連鎖すると高得点。天井まで積み上がるとゲームオーバーです。ベストスコアは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "wordbasket",
    title: "ワードバスケット",
    description:
      "お題と頭文字に合う単語を一番早く出した人が得点するオンライン対戦。判定は頭文字と文字数などの形式だけで、意味の正しさは問いません。全8ラウンド。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "icemaze",
    title: "氷の迷路",
    description:
      "方向を選ぶと壁にぶつかるまで滑り続けるパズル。ゴールを通り過ぎずにぴったり止まれればクリア。必ず解ける盤面だけが出題され、最短手数も表示されます。ベスト手数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "typerace",
    title: "タイピングレース",
    description:
      "全員共通の課題文を正確に打ち、完走の速さを競うオンライン対戦。完走した順に得点し、全3ラウンドの合計で勝敗が決まります。ルームコードや公開ルームで2〜6人が遊べます。",
    status: "playable",
    activity: true,
    players: "2〜6人（オンライン）",
  },
  {
    slug: "hearts",
    title: "ハーツ",
    description:
      "CPU3人と対戦するトリックテイキング。ハートとスペードのQを取らないようにし、誰かが100点以上になった時点で一番点が低い人の勝ち。3枚パスの読み合いとシュート・ザ・ムーンもあります。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "puttgolf",
    title: "パットゴルフ",
    description:
      "角度と強さを決めて打つ9ホールのパッティング。壁は跳ね返り、傾斜でボールが流れ、カップにはゆっくり入らないと通り過ぎます。ベストスコアは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "tsume",
    title: "詰将棋",
    description:
      "王手を続けて玉を詰ませる詰将棋。1手詰めと3手詰めの全14題は、初手が1つに定まることを機械検証済み。玉方の応手は自動で指されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "bowling",
    title: "ボウリング",
    description:
      "10フレームの正式スコアで競うボウリング。狙いとパワーメーターのタイミングで球を投げ、ピンの倒れ方は毎回再現できます。ベストスコアは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "airhockey",
    title: "エアホッケー",
    description:
      "CPUとパックを打ち合うエアホッケー。下のパドルをポインタで動かし、先に7点取れば勝ち。難易度は3段階、通算勝利数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "penalty",
    title: "PK戦",
    description:
      "CPUとのPK戦。狙うゾーンとキーパーの読み合いが勝負で、隅は枠外が多くキーパーも多めに読み、中央は決めやすい代わりに読まれると止められます。5本で決まらなければサドンデス。通算勝利数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "missile",
    title: "ミサイル防衛",
    description:
      "降ってくるミサイルから6つの都市を守る防衛ゲーム。空をタップすると一番近い基地から迎撃弾が飛び、爆風に巻き込んだミサイルを破壊できます。ウェーブごとに敵は増えて速くなり、一部は途中で分裂します。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "dragrace",
    title: "ドラッグレース",
    description:
      "グリーンへの反応とシフトアップのタイミングだけで決まる短距離レース。メーターが最適点を指した瞬間にシフトすると加速ロスなし。フライングは失格、相手の強さは3段階、ベストタイムは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "billiards",
    title: "ビリヤード",
    description:
      "白い手球を打って的球6個を全てポケットに落とす簡易プール。角度と強さで狙い、スコアは打数とスクラッチの合計。少ないほど上手く、ベストスコアは端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "curling",
    title: "カーリング",
    description:
      "CPUと交互に4投ずつ投げ合うカーリング（全2エンド）。強さとカールで狙い、ハウスの中心に一番近い側が内側の石の数だけ得点。通算勝利数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "chesspuzzle",
    title: "詰めチェス",
    description:
      "王手をかけ続けて、指定の手数でチェックメイトにするパズル。全15題（1手詰め・2手詰め）は、初手が1つに定まることを機械検証済み。黒の応手は一番粘る手が自動で指されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "balancestack",
    title: "バランスタワー",
    description:
      "提示されたブロックを置く位置を決めて積み上げるバランスゲーム。各段の重心が下の段との接触範囲を外れると崩れます。広いブロックを下に、重心の位置を読みながら積むのがコツ。ベスト記録は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "chinchiro",
    title: "チンチロリン",
    description:
      "3つのサイコロの役勝負。親（CPU）より強い役を最大3回の投げで狙い、ピンゾロやアラシは高倍率。ヒフミで負けると2倍取られる点数制で、全10ラウンドの合計点を競います。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "crocodile",
    title: "ワニワニ",
    description:
      "ワニの歯13本のうち1本だけが当たり。CPUと交互に歯を押していき、当たりを押した方が負けの運試し。勝利数は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "worldbox",
    title: "AGO WORLD BOX",
    description:
      "横スクロールの2Dサンドボックス。生成された世界を歩いて地面を掘り、集めたブロックを置いて自分の世界を作ります。掘った世界はそのまま保存され、続きから遊べます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "kwordle",
    title: "カタカナワードル",
    description:
      "5文字のカタカナ語を6回以内に当てる言葉当て。緑は場所も一致、黄は文字が含まれます。同じ文字が複数ある場合は答えの出現回数までしか黄になりません。ベスト（最少推測回数）は端末に記録されます。",
    status: "playable",
    activity: true,
    players: "1人",
  },
];

export function getWebGame(slug: string): WebGame | undefined {
  return WEB_GAMES.find((game) => game.slug === slug);
}

export function playableGames(): WebGame[] {
  return WEB_GAMES.filter((game) => game.status === "playable");
}

/** 日付キー（Asia/Tokyo の YYYY-MM-DD）。ハブの「今日のデイリー」選出の基準。 */
export function jstDateKey(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 文字列から決定的なハッシュを作る（ワードルの日付シードと同じ FNV-1a）。 */
function dailyHash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * その日のおすすめ（日替わり選出）。JST の日付だけから決定的に選ぶため、
 * 同じ日は誰が見ても同じ顔ぶれになり、翌日には変わる。
 * デイリー帯で別枠表示するワードルは候補から除く。
 */
export function dailyPicksFor(date: Date, count = 3): WebGame[] {
  const pool = playableGames().filter((game) => game.slug !== "wordle");
  let seed = dailyHash(jstDateKey(date));
  // mulberry32: シード付き疑似乱数。選出の再現性だけが目的なので軽いもので足りる。
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.max(0, count));
}
