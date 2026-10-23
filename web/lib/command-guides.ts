export type FunctionGuide = {
  title: string;
  description: string;
  note?: string;
};

export type GenreGuide = {
  slug: string;
  title: string;
  description: string;
  functions: FunctionGuide[];
};

export type CommandGuide = {
  slug: string;
  command: string;
  title: string;
  summary: string;
  description: string;
  guildOnly?: boolean;
  genres: GenreGuide[];
};

export const COMMAND_GUIDES: CommandGuide[] = [
  {
    slug: "game",
    command: "/game",
    title: "ゲーム",
    summary: "遊ぶゲームを選び、ルール確認と募集を始めます。",
    description: "ジャンルからゲームを選び、ルールを確認してこのチャンネルで参加者を募ります。",
    genres: [
      {
        slug: "party",
        title: "パーティーゲーム",
        description: "人狼、ワードウルフ、UNO、ダウトなど、チャンネルのみんなで遊ぶゲームです。",
        functions: [
          { title: "人狼", description: "5人以上で遊ぶ正体隠しゲームです。ローカル・グローバルと基本・プロのモードを選び、募集から開始します。" },
          { title: "ワードウルフ", description: "1人だけ違うお題を持つ人を会話で探します。標準・崩壊：スターレイル・原神のお題リストを選べます。" },
          { title: "UNO", description: "同じ色や数字のカードを出し、先に手札をなくすことを目指します。2人以上で募集できます。" },
          { title: "ダウト", description: "伏せたカードの宣言が本当かを見抜くカードゲームです。3人以上で募集します。" },
          { title: "NGワード・お題しりとり", description: "会話で遊ぶゲームです。NGワードは制限時間とモード、お題しりとりは参加者を選んで募集します。" },
          { title: "じゃんけん・ババ抜き", description: "短時間で遊べる定番ゲームです。じゃんけんは1人でもBotと対戦できます。" },
        ],
      },
      {
        slug: "solo",
        title: "ミニゲーム",
        description: "少人数やひとりでも始めやすい、短時間のゲームです。",
        functions: [
          { title: "Wordle", description: "5文字の単語を推理するゲームです。共有モードなどを選んで始めます。" },
          { title: "神経衰弱", description: "カードを裏返して同じ絵柄を揃えます。" },
          { title: "数字当て", description: "数字を予想して当てるミニゲームです。" },
          { title: "フラッシュ暗算", description: "素早く計算して答えるゲームです。" },
        ],
      },
      {
        slug: "board",
        title: "ボード・カードゲーム",
        description: "大富豪、オセロ、ポーカー、将棋、チェスを選べます。",
        functions: [
          { title: "大富豪・ポーカー", description: "トランプで遊ぶゲームです。人数を募ってスタートします。" },
          { title: "オセロ", description: "2人対戦またはCPU対戦を選べます。CPU対戦では難易度を指定できます。" },
          { title: "将棋", description: "2人対戦またはCPU対戦を選びます。CPUの難易度は1〜10です。" },
          { title: "チェス", description: "2人対戦またはCPU対戦を選びます。CPUの難易度は1〜10です。" },
        ],
      },
      {
        slug: "adventure",
        title: "アドベンチャー",
        description: "探索を進めるゲームです。",
        functions: [
          { title: "ダンジョン", description: "ダンジョンを探索するゲームです。ゲームを選んだあと、ルール確認と募集を行えます。" },
        ],
      },
    ],
  },
  {
    slug: "general",
    command: "/general",
    title: "一般機能",
    summary: "コイン・ランキング、生存確認、ショートカットをまとめて操作します。",
    description: "目的のジャンルを選ぶだけで、日常的に使う機能を呼び出せる操作パネルです。",
    genres: [
      {
        slug: "economy",
        title: "コイン・ランキング",
        description: "AGOの状況確認、送金、各種ランキングをまとめています。",
        functions: [
          { title: "プレイヤー状況", description: "自分の所持状況を確認します。" },
          { title: "コイン送金", description: "送金先のユーザーIDとAGOを入力して、ほかのユーザーへ送ります。" },
          { title: "コイン保有ランキング", description: "コインの保有状況をランキングで確認します。" },
          { title: "bump RTA・up RTAランキング", description: "bump / up の記録をランキングで確認します。" },
        ],
      },
      {
        slug: "survival",
        title: "生存確認",
        description: "追跡・アクティブ頻度・失踪警報に関する機能です。",
        functions: [
          { title: "追跡登録・解除", description: "生存確認の追跡対象を登録または解除します。" },
          { title: "アクティブ頻度", description: "対象ユーザーの活動頻度を確認します。" },
          { title: "生存確認ランキング", description: "生存確認の記録をランキングで見ます。" },
          { title: "フリーズ・失踪警報解除", description: "追跡状態の停止や失踪警報の解除を操作します。" },
        ],
      },
      {
        slug: "custom",
        title: "カスタムショートカット",
        description: "メッセージで機能を呼び出す個人用ショートカットを管理します。",
        functions: [
          { title: "ショートカットを管理", description: "機能を選び、空白を含まないトリガー名を付けて登録します。登録済みの内容は編集・削除できます。", note: "ショートカットはユーザーごとに最大10個までです。" },
        ],
      },
    ],
  },
  {
    slug: "help",
    command: "/help",
    title: "ヘルプ",
    summary: "カテゴリやコマンド名から、使い方とガイドを探します。",
    description: "迷ったときの入口です。カテゴリをたどるか、知りたいコマンドを直接指定します。",
    genres: [
      {
        slug: "category",
        title: "カテゴリから探す",
        description: "カテゴリを選び、その中のコマンドやガイドを順に確認します。",
        functions: [
          { title: "カテゴリ一覧", description: "最初のメニューからカテゴリを選ぶと、そのカテゴリで使えるコマンドの一覧が表示されます。" },
          { title: "コマンドの使い方", description: "カテゴリ内の機能を選ぶと、用途・使い方・必要な権限を確認できます。" },
          { title: "ガイドを読む", description: "ガイドがあるカテゴリやゲームでは、詳しい案内を開けます。" },
        ],
      },
      {
        slug: "command",
        title: "コマンド名で探す",
        description: "知りたいコマンドが決まっている場合はこちらです。",
        functions: [
          { title: "候補から選ぶ", description: "`/help` の command 欄に入力すると候補が出るので、選ぶだけで詳細を開けます。" },
          { title: "直接指定", description: "コマンド名を指定して、その機能だけの使い方を確認できます。" },
        ],
      },
    ],
  },
  {
    slug: "vc",
    command: "/vc",
    title: "VC・音楽",
    summary: "ボイスチャンネルへの接続、音楽、録音、通話を操作します。",
    description: "ボイスチャンネルで使う機能を、目的別のジャンルから選ぶ操作パネルです。",
    genres: [
      {
        slug: "connection",
        title: "VC接続",
        description: "Botの接続と現在の使用状況を確認します。",
        functions: [
          { title: "参加", description: "Botを参加中のボイスチャンネルへ接続します。" },
          { title: "退出", description: "Botをボイスチャンネルから退出させます。" },
          { title: "状態", description: "どの機能がVCを使っているか、開始した人や経過時間を確認します。" },
        ],
      },
      {
        slug: "music",
        title: "音楽",
        description: "音楽の再生・キュー操作を行うパネルを開きます。",
        functions: [
          { title: "音楽操作パネル", description: "URL・検索語・音声ファイルの再生、キューや音響設定などの操作を開きます。" },
        ],
      },
      {
        slug: "studio",
        title: "録音・音声制作",
        description: "録音、やまびこ、文字起こし、カラオケを操作します。",
        functions: [
          { title: "録音", description: "録音の開始・停止・状態確認・音程解析を行います。" },
          { title: "やまびこ", description: "やまびこの開始・停止と、遅延の変更を行います。" },
          { title: "文字起こし", description: "ボイスチャンネルの文字起こしを開始・停止します。" },
          { title: "カラオケ", description: "カラオケを開始・停止し、採点を行います。" },
        ],
      },
      {
        slug: "effects",
        title: "音声加工",
        description: "ボイスチェンジャーを使うための操作です。",
        functions: [
          { title: "ボイスチェンジャー", description: "開始・停止のほか、現在の状態や設定を確認・変更します。" },
        ],
      },
      {
        slug: "community",
        title: "通話ネットワーク",
        description: "ほかの人やサーバーとつながる通話機能です。",
        functions: [
          { title: "ランダム通話", description: "ランダム通話の開始・参加と、終了・退出を行います。" },
          { title: "グローバルVC", description: "ルーム名と必要ならパスワードを入力して参加し、終了・退出を行います。" },
        ],
      },
    ],
  },
  {
    slug: "support",
    command: "/support",
    title: "サポート",
    summary: "サーバー運用、通知、イベントに関する機能を操作します。",
    description: "サーバー内で使う管理・サポート機能の操作パネルです。必要な権限があるユーザーだけが実行できます。",
    guildOnly: true,
    genres: [
      {
        slug: "moderation",
        title: "モデレーション",
        description: "会話やチャンネルを整えるための機能です。",
        functions: [
          { title: "Muted設定", description: "Mutedに関する設定を開きます。", note: "ロールの管理権限が必要です。" },
          { title: "匿名つぶやきパネル", description: "匿名つぶやき用のパネルを開きます。", note: "チャンネルの管理権限が必要です。" },
          { title: "Stickyパネル", description: "固定表示するパネルの設置先・文言・オン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
          { title: "メッセージ削除", description: "削除する件数を入力してメッセージを削除します。", note: "メッセージの管理権限が必要です。" },
          { title: "モデレート履歴", description: "TO・KICK・BANの履歴を送るチャンネルと、各記録のオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
        ],
      },
      {
        slug: "server",
        title: "サーバー管理",
        description: "ロールやログ、リアクション設定を管理します。",
        functions: [
          { title: "一括ロール付与・剥奪", description: "対象ロールと対象アカウントを選び、確認して一括で付与または剥奪します。", note: "ロールの管理権限が必要です。" },
          { title: "絵文字便乗設定", description: "thinking と 👍 のオン／オフに加え、サーバー共通のカスタム便乗リアクションを追加・編集・削除します。", note: "サーバーの管理権限が必要です。" },
          { title: "VC入退室履歴", description: "VC入退室の履歴を送るチャンネルとオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
          { title: "メッセージ編集履歴", description: "メッセージ編集前後を記録する送信先とオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
        ],
      },
      {
        slug: "bumprta",
        title: "bump/up・RTA",
        description: "通知設定とRTAの状態を操作します。",
        functions: [
          { title: "bump/up通知・RTA状態", description: "現在の通知・RTAの状態を確認します。" },
          { title: "bump/up通知・RTAオン", description: "通知・RTAをオンにします。" },
          { title: "bump/up通知・RTAオフ", description: "通知・RTAをオフにします。" },
        ],
      },
      {
        slug: "event",
        title: "イベント",
        description: "サーバー内のイベントを作成します。",
        functions: [
          { title: "抽選（giveaway）", description: "賞品・当選人数・締切までの分数を入力して抽選を作成します。", note: "サーバーの管理権限が必要です。" },
        ],
      },
    ],
  },
];

export function getCommandGuide(slug: string) {
  return COMMAND_GUIDES.find((guide) => guide.slug === slug);
}

export function getGenreGuide(commandSlug: string, genreSlug: string) {
  return getCommandGuide(commandSlug)?.genres.find((genre) => genre.slug === genreSlug);
}
