// コマンド解説（/commands）のデータ。
//
// 機能の一覧・表示名・ジャンル構成は Bot 側レジストリから生成した
// web/data/action-guides.json を正とし、ここではサイト側のメタ情報
// （ルートの紹介文、ジャンル説明の補完、機能ごとの説明の上書き）だけを持つ。
// 機能の追加・削除・改名・ジャンル移動は、デプロイ時の再生成
// （deploy/deploy-web.sh → tools/export_action_guides）で自動で追従する。
// 上書きはアクション ID キーで、無い機能も生成データから自動で載る。
import actionGuidesData from "../data/action-guides.json";

export type FunctionGuide = {
  id: string;
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
  /** ホームページの機能紹介で使う、そのコマンドの紹介文。 */
  intro: string;
  guildOnly?: boolean;
  genres: GenreGuide[];
};

type ActionFunction = {
  id: string;
  value: string;
  title: string;
  description: string;
  note?: string;
};

type ActionGenre = {
  key: string;
  label: string;
  description: string;
  functions: ActionFunction[];
};

type ActionRoot = {
  root: string;
  command: string;
  genres: ActionGenre[];
};

type ActionGuidesFile = {
  total: number;
  game_count: number;
  roots: ActionRoot[];
};

const DATA = actionGuidesData as unknown as ActionGuidesFile;

/** レジストリの総機能数（生成データの件数から導出） */
export const TOTAL_FUNCTIONS = DATA.total;
/** ゲームのタイトル数（生成データの件数から導出） */
export const GAME_COUNT = DATA.game_count;

type RootMeta = {
  slug: string;
  title: string;
  summary: string;
  description: string;
  intro: string;
  guildOnly?: boolean;
};

// 表示順とルートの紹介文だけをサイト側で持つ（機能の増減では変わらない）。
const ROOT_META: RootMeta[] = [
  {
    slug: "game",
    title: "ゲーム",
    summary: "遊ぶゲームを選び、ルール確認と募集を始めます。",
    description: "ゲームを選ぶと、ルールを確認してこのチャンネルで参加者を募ります。",
    intro: "人狼・ワードウルフ・UNO・大富豪など、みんなで遊べるゲームの入口です。ゲームを選ぶとルール確認と参加者募集がその場で始まり、ボタンで参加できます。今月のゲーム王を競う要素もあります。",
  },
  {
    slug: "general",
    title: "一般機能",
    summary: "マネー、fujo status、AIや画像作成まで、日常的に使う機能をまとめて操作します。",
    description: "目的のジャンルを選ぶだけで、日常的に使う機能を呼び出せる操作パネルです。",
    intro: "コイン経済（AGO）を中心に、日常的に使う機能をまとめた操作パネルです。残高確認や送金、市場・工房・採掘・宝くじなどのマネー機能のほか、EXPとレベル、各種ランキング、栽培シミュレーション、占い、AIチャットや画像作成（MIQなど）まで、ここから呼び出せます。",
  },
  {
    slug: "vc",
    title: "VC・音楽",
    summary: "ボイスチャンネルへの接続、音楽、録音、通話を操作します。",
    description: "ボイスチャンネルで使う機能を、目的別のジャンルから選ぶ操作パネルです。",
    intro: "ボイスチャンネルで使う機能の操作パネルです。音楽再生（プレイリスト・立体音響・自動再生）、メッセージの読み上げ、録音・文字起こし・カラオケ、ボイスチェンジャーややまびこ、ほかのサーバーとつながるランダム通話とグローバルVCルームまで、VCまわりの遊びをまとめています。",
  },
  {
    slug: "support",
    title: "サポート",
    summary: "サーバー運用、通知、イベントに関する機能を操作します。",
    description: "サーバー内で使う管理・サポート機能の操作パネルです。必要な権限があるユーザーだけが実行できます。",
    intro: "サーバー運営のための管理・サポート機能です。ミュートやメッセージの一括削除、認証・ロールパネル、各種ログ、グローバルチャットの接続、bump系サービスの更新検知（boardNotify）やSNSの新着通知、即抜けRTAの計測設定などを扱います。実行に権限が要る機能が多く、サーバー内でのみ使えます。",
    guildOnly: true,
  },
  {
    slug: "help",
    title: "ヘルプ",
    summary: "カテゴリやコマンド名から、使い方とガイドを探します。",
    description: "迷ったときの入口です。カテゴリをたどるか、知りたいコマンドを直接指定します。",
    intro: "使い方の入口です。カテゴリをたどって機能を探したり、コマンド名を指定して、その使い方とガイドだけを表示したりできます。迷ったら、まず /help を開いてください。",
  },
];

// ジャンル説明の補完（Bot 側にジャンル説明がある場合はそちらが正）。
const GENRE_DESCRIPTIONS: Record<string, string> = {
  "general:money": "コイン残高の確認や送金、受け取り、クランなど、AGOコインの基本機能をまとめています。",
  "general:trade_craft": "市場でのトークン売買、アイテムの購入・使用・売却、工房での加工機や合成など、コインの取引と生産の機能をまとめています。",
  "general:play": "採掘や宝くじ、ギャンブルやガチャなど、コインで遊ぶ機能をまとめています。",
  "general:rta": "各種ランキングを確認します。",
  "general:boardnotify_rta": "boardNotify対応サービスのRTA記録をランキングで確認します。",
  "general:garden": "植物を育てる栽培シミュレーションです。",
  "general:fortune": "占いの機能です。",
  "general:custom": "ショートカットやAI、翻訳などの個人設定をまとめています。",
  "general:exp": "活動で貯まるEXPとレベルの確認、EXPランキング、サーバーの活動ボードです。",
  "general:survival": "生存確認の機能です。日々の活動から推定される「高度」で自分の状態を確認し、分析やランキングも見られます。",
  "general:zeta": "AIキャラクター「ZetaModoki」との会話です。シチュエーションやキャラクターを登録して会話できます。",
  "general:make_image": "メッセージや文章、HTMLなどから画像やコンテンツを作成します。",
  "vc:connection": "BotのVC接続と、現在の使用状況を確認します。",
  "vc:music": "音楽の再生と、プレイリストや音響などの関連機能です。",
  "vc:studio": "録音、やまびこ、文字起こし、カラオケを操作します。",
  "vc:community": "ほかの人とつながるランダム通話です。",
  "vc:tts": "VCでテキストを読み上げる機能です。読み上げの開始・停止や、声などの設定を行います。",
  "vc:effects": "自分の声にエフェクトをかけるボイスチェンジャーの開始・停止と状態確認です。",
  "vc:gvc_rooms": "サーバーをまたぐグローバルVCルームの作成・参加と、グロチャ接続の機能です。",
  "vc:trigger": "特定の音声で反応する音声トリガーを管理します。",
  "game:games": "遊ぶゲームを選び、ルール確認と募集を始めます。",
  "support:moderation": "会話やチャンネルを整えるための機能です。",
  "support:roles": "ロールの付与や、認証・ロールパネルを管理します。",
  "support:logs": "サーバー内の出来事の履歴・記録の設定です。",
  "support:automation": "通知や自動化など、サーバー運営を助ける設定をまとめています。",
  "support:rta": "即抜けRTAの計測設定です。",
  "support:boardnotify": "掲示板サービスの更新検知と、次回通知の設定です。",
  "support:sns": "YouTube・X・GitHub・RSSの新着通知を設定します。",
  "support:analysis": "サーバー内の交流を分析します。",
  "help:help": "カテゴリやコマンド名から、使い方とガイドを探します。",
};

// 機能ごとの説明の上書き（アクション ID キー）。
// Bot 側に固有の説明がある機能（ゲームの概要、アシスト機能の説明など）は
// 生成データ側が正で、ここにはサイト側で補う分だけを書く。
const FUNCTION_OVERRIDES: Record<string, { description?: string; note?: string }> = {
  // /general マネー
  "general:money_panel": { description: "残高やレート、所持アイテム、加工機や宝くじの状況を見ながら、その場で売買や合成、採掘やギャンブルまで実行できる統合パネルです。" },
  "general:daily_report": { description: "毎日の活動まとめをDMで受け取る設定を切り替えます。" },
  "general:status": { description: "自分の所持コインやアイテム、借金などの状況を確認します。" },
  "general:pay": { description: "送金先と金額を指定して、ほかのユーザーへコインを送ります。" },
  "general:market": { description: "アゴトークンの現在レートとチャート、市場の状況を確認します。" },
  "general:token_buy": { description: "AGOを使ってアゴトークンを買います。" },
  "general:token_sell": { description: "アゴトークンを売ってAGOに替えます。" },
  "general:items": { description: "所持アイテムとショップ、発動中の効果を確認します。" },
  "general:item_buy": { description: "AGOで素材や消費アイテム、宝箱を買います。" },
  "general:item_use": { description: "使う効果のある所持アイテムを発動します。" },
  "general:box_open": { description: "所持している宝箱を開けます。" },
  "general:workshop": { description: "所有する加工機の生産状況や、委託加工の進み具合を確認します。" },
  "general:machine_buy": { description: "AGOで加工機を買います。時間経過で合成素材が生産されます。" },
  "general:workshop_claim": { description: "加工機が生産した素材をまとめて受け取ります。" },
  "general:craft": { description: "素材を組み合わせて別のアイテムを作ります。" },
  "general:mining": { description: "1時間に1回、合成素材を中心に掘り出します。コインも少し出ます。" },
  "general:lottery": { description: "賞金プールと締切、自分のチケットと前回の抽選結果を確認します。" },
  "general:lottery_buy": { description: "チケットを買って毎日の抽選に参加します。" },
  "general:steal": { description: "同じサーバーのメンバーからコインを盗む勝負をします。失敗すると罰金や逮捕があります。" },
  "general:slot": { description: "スロットを回してコインを賭けます。" },
  "general:double": { description: "GOで倍率を伸ばすか、CASHOUTで確定するかを選ぶダブルアップです。" },
  "general:blackjack": { description: "ディーラーとブラックジャックで対戦します。" },
  "general:bj_duel": { description: "ほかのプレイヤーとブラックジャックで対決します。" },
  "general:dice": { description: "範囲内の数字を当てるダイスベットで遊びます。" },
  "general:coin_leaderboard": { description: "コインの保有量をランキングで確認します。" },
  "general:role_shop": { description: "コインで買えるロールの一覧と購入を行います。" },
  "general:gacha": { description: "コインを消費してガチャを引きます。" },
  "general:clan": { description: "クランの作成・参加と、クランの情報を確認します。" },
  "general:starter_claim": { description: "初回のスターターパックを受け取ります。" },
  "general:daily_bonus_claim": { description: "1日1回のデイリーボーナスを受け取ります。" },
  "general:jailbreak": { description: "逮捕中に脱獄を試みます。" },
  "general:item_sell": { description: "所持アイテムを売却してAGOに替えます。" },
  "general:role_shop_manage": { description: "ロールショップの商品を管理します。" },
  "general:craft_commission": { description: "時間をかけて素材を加工する委託加工を依頼し、生産物を受け取ります。" },
  "general:gacha_party": { description: "ガチャの編成を設定します。" },
  "general:clan_manage": { description: "クランのリーダー向け管理を行います。" },
  // /general ランキング・RTA
  "general:rankings": { description: "各種ランキングへの入口です。" },
  "general:asset_leaderboard": { description: "コインと資産の総合ランキングを確認します。" },
  "general:sokunuke_board": { description: "即抜けRTAの記録をランキングで確認します。" },
  "general:rta_board": { description: "対応サービスのbump / up記録を、全サービス一括の統合ランキング（最速／最遅）で表示します。" },
  // /general EXP・レベル
  "general:exp_status": { description: "自分のEXPとレベル、進捗を確認します。" },
  "general:exp_ranking": { description: "EXPのランキングを画像ボードで確認します。" },
  "general:activity_board": { description: "サーバーの活動量を軸別に集計したボードです。" },
  // /general fujo status
  "general:fujo_register": { description: "fujo statusの追跡対象を登録または解除します。" },
  "general:fujo_hindo": { description: "対象ユーザーの現在の高度を確認します。高度は活動が検知されるたびに上がり、時間とともに下がります。" },
  "general:fujo_analysis": { description: "過去30日の検知記録を、時間帯ごとのグラフで確認します。" },
  "general:fujo_ranking": { description: "高度ランキングと化石ランキングを確認します。" },
  "general:fujo_freeze": { description: "追跡状態を一時停止します。" },
  "general:fujo_panic_disable": { description: "失踪警報を解除します。" },
  "general:fujo_status": { description: "自分の生存ステータスを確認します。" },
  // /general 栽培・占い
  "general:garden": { description: "草・木・盆栽を3つのプランターで育てる栽培シミュレーションです。" },
  "general:omikuji": { description: "おみくじを引きます。同じ日の結果は変わりません。" },
  // /general 設定・AI
  "general:shortcut_manage": { description: "機能を選び、空白を含まないトリガー名を付けて登録します。登録済みの内容は編集・削除できます。", note: "ショートカットはユーザーごとに最大10個までです。" },
  "general:aitools": { description: "AIツール（fastooler）の稼働状態を確認します。" },
  "general:ai_default": { description: "チャットAIのモデルを設定します。" },
  "general:image_default": { description: "画像生成AIのモデルを設定します。" },
  "general:reasoning_default": { description: "AIの思考の強さを設定します。" },
  "general:translation_settings": { description: "自動翻訳のオン／オフと言語を設定します。" },
  "general:ai_chat": { description: "「!ai」に続けて話しかけるとAIが応答します。" },
  "general:ai_generate": { description: "「!generate」に続けて指示するとAIが画像を生成します。" },
  // /general ZetaModoki
  "general:zetamodoki": { description: "ZetaModokiとロールプレイ会話をします。" },
  "general:zeta_reset": { description: "ZetaModokiとの会話履歴を消去します。" },
  "general:zeta_register": { description: "シチュエーションやキャラクターを登録します。" },
  "general:zeta_manage": { description: "登録したシチュエーション・キャラクターを編集・削除します。" },
  // /general 画像作成
  "general:story54": { description: "入力した文章を54字の物語として、1080×1080の画像にします。" },
  "general:fast_html": { description: "HTMLファイルを送ると、60分間だけ公開されるプレビューURLを発行します。" },
  "general:bg_cutout": { description: "画像やGIFの背景を透過し、カスタム絵文字（256KB以下）やスタンプ（512KB以下・320×320）として使えるサイズに変換します。処理は、発行される一時リンク先のページで、あなたのブラウザの中で行われます。" },
  "general:meme_create": { description: "画像と文字からミーム画像を作成します。" },
  "general:meme_help": { description: "画像作成機能の使い方を表示します。" },
  "general:miq_settings": { description: "MIQの見た目と引用拒否を設定します。" },
  "general:miq_refuse": { description: "自分のメッセージをMIQで引用されたくない場合の拒否設定です。" },
  "general:miq_create": { description: "メッセージを画像化して引用カードを作ります。右クリックメニューの「Make it a Quote」からも使えます。" },
  // /vc VC接続
  "vc:join": { description: "Botを参加中のボイスチャンネルへ接続します。" },
  "vc:leave": { description: "Botをボイスチャンネルから退出させます。" },
  "vc:status": { description: "どの機能がVCを使っているか、開始した人や経過時間を確認します。" },
  // /vc 音楽
  "vc:music_panel": { description: "URL・検索語・音声ファイルの再生、キューや音響設定などの操作を開きます。" },
  "vc:music_playlist": { description: "プレイリストの作成・保存・読み込みを行います。" },
  "vc:music_spatial": { description: "立体音響の設定を行います。" },
  "vc:music_autoplay": { description: "自動再生のオン／オフと、再生履歴の管理を行います。" },
  "vc:music_queue": { description: "再生待ちのキューを確認します。" },
  "vc:music_search": { description: "楽曲を検索してキューに追加します。" },
  "vc:music_files": { description: "アップロードされた音声ファイルのID一覧を確認します。" },
  // /vc 読み上げ
  "vc:tts_start": { description: "このチャンネルのメッセージ読み上げを開始します。" },
  "vc:tts_stop": { description: "読み上げを停止します。" },
  "vc:tts_say": { description: "入力した文を1回だけ読み上げます。" },
  "vc:tts_config": { description: "話者・ピッチ・話速を設定します。" },
  // /vc 録音・音声制作
  "vc:record_start": { description: "VCの録音を開始します。" },
  "vc:record_stop": { description: "録音を停止します。" },
  "vc:record_status": { description: "録音の状態を確認します。" },
  "vc:record_pitch": { description: "録音の音程を解析します。" },
  "vc:echo_start": { description: "やまびこ（エコー再生）を開始します。" },
  "vc:echo_stop": { description: "やまびこを停止します。" },
  "vc:echo_status": { description: "やまびこの状態を確認します。" },
  "vc:echo_delay": { description: "やまびこの遅延時間を変更します。" },
  "vc:transcribe_start": { description: "VCの発言の文字起こしを開始します。結果は選んだテキストチャンネルに投稿されます。", note: "音声は外部サービスで処理されます。" },
  "vc:transcribe_stop": { description: "文字起こしを停止します。" },
  "vc:karaoke_start": { description: "歌詞を入力してカラオケを開始します。" },
  "vc:karaoke_stop": { description: "カラオケを停止します。" },
  "vc:karaoke_score": { description: "カラオケの採点結果を表示します。" },
  // /vc 音声加工
  "vc:changer_start": { description: "ボイスチェンジャーを開始します。" },
  "vc:changer_stop": { description: "ボイスチェンジャーを停止します。" },
  "vc:changer_status": { description: "ボイスチェンジャーの状態確認と、ピッチなどの設定変更を行います。" },
  // /vc 音声トリガー
  "vc:trigger_register": { description: "このチャンネルの音声から選んで、音声トリガーを登録します。" },
  "vc:trigger_panel": { description: "登録済みの音声トリガーの一覧と削除を行います。" },
  // /vc ランダム通話
  "vc:match_start": { description: "ランダム通話を開始・参加します。" },
  "vc:match_stop": { description: "ランダム通話を終了・退出します。" },
  // /vc グローバルVCルーム
  "vc:global_start": { description: "ルーム名と、必要ならパスワードを入力してグローバルVCに参加します。" },
  "vc:global_stop": { description: "グローバルVCを終了・退出します。" },
  "vc:gvc_room_list": { description: "参加できるグローバルVCルームの一覧を表示します。" },
  "vc:gvc_room_create": { description: "グローバルVCルームを作成します。" },
  "vc:gvc_room_theme": { description: "常設ルームのテーマを変更します。" },
  "vc:gvc_room_info": { description: "ルームの情報を表示します。" },
  "vc:gvc_room_delete": { description: "ルームを削除します。" },
  "vc:gvc_lang_setting": { description: "グローバルVCの表示言語を設定します。" },
  "vc:gvc_chat_connect": { description: "このテキストチャンネルをグローバルVCルームに接続します。" },
  "vc:gvc_chat_disconnect": { description: "このチャンネルのグロチャ接続を解除します。" },
  "vc:gvc_auto_connect": { description: "指定したルームへの自動接続を設定します。" },
  // /support モデレーション
  "support:muted": { description: "メンバーにMutedを付与します。", note: "ロールの管理権限が必要です。" },
  "support:muted_settings": { description: "Muted用のロールや隔離チャンネルを設定します。", note: "サーバーの管理権限が必要です。" },
  "support:whisper": { description: "匿名つぶやき用のパネルを開きます。", note: "チャンネルの管理権限が必要です。" },
  "support:sticky": { description: "固定表示するパネルの設置先・文言・オン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
  "support:clear": { description: "削除する件数を入力してメッセージを削除します。", note: "メッセージの管理権限が必要です。" },
  "support:giveaway": { description: "賞品・当選人数・締切までの分数を入力して抽選を作成します。", note: "サーバーの管理権限が必要です。" },
  "support:honeypot": { description: "荒らし対策のハニーポットを設定します。" },
  "support:ticket": { description: "チケットの受付パネルと設定を開きます。" },
  "support:ticket_types": { description: "チケットの種別（カテゴリ・担当ロール）を設定します。" },
  "support:ticket_transcript": { description: "チケットの記録（トランスクリプト）の保存先を設定します。" },
  "support:ticket_assign": { description: "チケットの担当アサインに関する案内と、設定への導線です。" },
  "support:bot_fixer": { description: "BOT fixerのコマンド制限を設定します。" },
  "support:bot_fixer_bots": { description: "ほかのBotの活動を制限する設定です。" },
  "support:bot_fixer_rates": { description: "コマンドのレート制限を設定します。" },
  // /support ロール・認証
  "support:role_bulk": { description: "対象ロールと対象アカウントを選び、確認して一括で付与または剥奪します。", note: "ロールの管理権限が必要です。" },
  "support:auth_panel": { description: "認証パネルを作成します。" },
  "support:auth_questions": { description: "認証フォームの質問を編集します。" },
  "support:role_panel": { description: "ロールパネルを作成します。" },
  // /support 履歴・ログ
  "support:vc_log": { description: "VC入退室の履歴を送るチャンネルとオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
  "support:message_log": { description: "メッセージ編集前後を記録する送信先とオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
  "support:moderation_log": { description: "TO・KICK・BANの履歴を送るチャンネルと、各記録のオン／オフを設定します。", note: "サーバーの管理権限が必要です。" },
  // /support 自動化・通知
  "support:binjou": { description: "thinking と 👍 の便乗リアクションのオン／オフに加え、サーバー共通のカスタム便乗リアクションを設定します。", note: "サーバーの管理権限が必要です。" },
  "support:binjou_custom": { description: "サーバー共通のカスタム便乗リアクションを追加・編集・削除します。" },
  "support:language": { description: "サーバーの表示言語を設定します。" },
  "support:globalchat": { description: "グローバルチャットの接続チャンネルを登録・解除します。" },
  "support:globalchat_mod": { description: "グローバルチャットのNGワードやブロックを設定します。" },
  "support:auto_react": { description: "チャンネルを選び、投稿時に自動で付ける絵文字を複数設定します。設定した絵文字を空欄にすると、そのチャンネルの設定を解除できます。", note: "サーバーの管理権限が必要です。" },
  "support:quest_notify": { description: "Discord Questの新着を通知する設定です。" },
  "support:quest_manual": { description: "Questの情報を手入力して投稿します。" },
  "support:levelup_notify": { description: "レベルアップ通知の送信先やオン／オフを設定します。" },
  "support:levelup_card_theme": { description: "自分のレベルアップカードのテーマを設定します。" },
  "support:assist_goodbye": { description: "メンバーの退出を、選んだチャンネルへお知らせします。" },
  "support:tempvoice_panel": { description: "一時VCの操作パネルを開きます。" },
  "support:assist_embed_templates": { description: "埋め込みビルダーのテンプレートを管理します。" },
  "support:assist_reminder": { description: "「10分後」などの一回限りのリマインダーを設定します。" },
  "support:assist_warning_escalation": { description: "警告の累積による自動処罰を設定します。" },
  "support:assist_events_link": { description: "Discordの予定イベントとの連携を設定します。" },
  "support:assist_application_review": { description: "スタッフ応募の審査を行います。" },
  "support:voice_trigger": { description: "音声トリガーのサーバー側設定を行います。" },
  "support:vc_auto_start": { description: "BotがVCに参加したとき、読み上げや文字起こしなどを自動で始める設定です。" },
  // /support RTA設定
  "support:sokunuke_settings": { description: "即抜けRTAの計測・VC自動参加のオン/オフと、記録の送信先チャンネルを設定します。" },
  // /support boardNotify
  "support:bumprta_bump": { description: "DISBOARDの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_up": { description: "ディス速の更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_vote": { description: "鯖ちゃんねるの投票検知と、次回通知の状態を確認します。" },
  "support:bumprta_takasumi": { description: "TakasumiBOTの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_dicoall": { description: "Dicoallの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_dcafe": { description: "Discord Cafeの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_sharkbot": { description: "SharkBotの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_dsio": { description: "DiscordServers.ioの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_discom": { description: "DISCOMの更新検知と、次回通知の状態を確認します。" },
  "support:bumprta_settings": { description: "通知のオン／オフとメンションロールなど、全サービス共通の設定を行います。" },
  // /support SNS通知
  "support:sns_youtube": { description: "YouTubeチャンネルの新着動画を通知します。" },
  "support:sns_x": { description: "Xアカウントの新着ポストを通知します。" },
  "support:sns_github": { description: "GitHubリポジトリのPR・Issue・コミットを通知します。" },
  "support:sns_rss": { description: "RSSフィードの新着を通知します。" },
  "support:sns_youtube_live": { description: "YouTubeのライブ配信開始を通知します。" },
  // /support 分析
  "support:person_analysis": { description: "サーバー内の返信・メンションの関係を集計し、交流グラフで分析します。", note: "サーバーで収集をオンにしている場合のみ表示されます。" },
  // /help
  "help:overview": { description: "カテゴリやコマンド名から、使い方とガイドを探します。" },
};

function buildCommandGuides(): CommandGuide[] {
  const rootsBySlug = new Map(DATA.roots.map((root) => [root.root, root]));
  return ROOT_META.flatMap((meta) => {
    const root = rootsBySlug.get(meta.slug);
    if (!root) return [];
    return [{
      slug: meta.slug,
      command: root.command,
      title: meta.title,
      summary: meta.summary,
      description: meta.description,
      intro: meta.intro,
      ...(meta.guildOnly ? { guildOnly: true } : {}),
      genres: root.genres.map((genre) => ({
        slug: genre.key,
        title: genre.label,
        description: genre.description || GENRE_DESCRIPTIONS[`${meta.slug}:${genre.key}`] || "",
        functions: genre.functions.map((fn) => {
          const override = FUNCTION_OVERRIDES[fn.id];
          return {
            id: fn.id,
            // ゲームの表示名はレジストリ側の「ゲーム開始: 」接頭辞を外す
            title: meta.slug === "game" ? fn.title.replace(/^ゲーム開始: /, "") : fn.title,
            description: override?.description ?? fn.description,
            note: override?.note ?? fn.note,
          };
        }),
      })),
    }];
  });
}

export const COMMAND_GUIDES: CommandGuide[] = buildCommandGuides();

export function getCommandGuide(slug: string) {
  return COMMAND_GUIDES.find((guide) => guide.slug === slug);
}

export function getGenreGuide(commandSlug: string, genreSlug: string) {
  return getCommandGuide(commandSlug)?.genres.find((genre) => genre.slug === genreSlug);
}
