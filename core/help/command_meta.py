"""コマンドカタログ（core/help/command_catalog.py）に合わせる、人が決める情報。

コマンドを追加したら、COMMAND_META に "/名前"（スラッシュ）か "!名前"（プレフィックス）の
キーで 1 行足してください。足し忘れると tests/test_command_catalog.py が知らせます。

各項目で使えるキー（category 以外は省略できる）
- category: CATEGORIES の id
- summary: 一覧に出す 1 行の説明（コマンドの description が空・分かりにくいときに上書き）
- usage: 使い方の例（省略すると引数から自動で作る）
- options: {"引数名": "説明"}（プレフィックスコマンドの引数には説明が付いていないので、ここで補う）
- permissions: 自動で読み取れない権限（コマンドの中で確かめている場合など）
- hidden: True にすると /help や Web の一覧に出さない（デバッグ用・持ち主専用など）
- guide: 詳しい説明（Markdown）
- guide_key: core/game/game/game_guides.py の GAME_GUIDES のキー。そのゲームのルール説明を guide として使う
"""

from __future__ import annotations

# ---------------------------------------------------------------- 国づくりの初回ガイド
# !nation を初めて使った人に出す 3 ステップのチュートリアル（cogs/nation_onboarding.py）。
# 同じ文章を /help と Web サイトのガイド（NATION_GUIDE）でも使う。
NATION_TUTORIAL = [
    {
        "title": "1. 国に入る・国をつくる",
        "body": (
            "国づくりは、サーバーごとに 1 つの国を育てる遊びです。\n"
            "- このサーバーに国があれば、参加機能から国民になれます（入れるのは 1 人 1 か国）。\n"
            "- まだ国がなければ、サーバーの管理者かオーナーが建国できます。"
            "建国した人が国王になり、首都が共有マップに置かれます。"
        ),
    },
    {
        "title": "2. 空腹度とコイン",
        "body": (
            "- **空腹度**: 参加したときは 100 です。これから時間とともに減っていくしくみが入る予定です。\n"
            "- **コイン（AGO）**: 所持金は `/general` の「プレイヤー状況」で確認できます。ほかのゲームで稼いだコインも国づくりで使えます。\n"
            "所属国・役職・所持金・空腹度は、状態確認機能で確認できます。"
        ),
    },
    {
        "title": "3. まずやること",
        "body": (
            "1. 国民参加または建国の機能を使う\n"
            "2. 状態確認機能で自分の情報を見る\n"
            "3. Web サイトの共有マップで、自分の国の場所と広さを見てみる\n"
            "操作方法はサーバー管理者に確認してください。"
        ),
    },
]

NATION_GUIDE = "\n\n".join(f"## {step['title']}\n{step['body']}" for step in NATION_TUTORIAL)


CATEGORIES = [
    {
        "id": "support",
        "label": "サポート",
        "description": "ヘルプ、サーバーをまたぐグローバルチャット、匿名のつぶやき、生存確認など、サーバー生活を便利にする機能です。",
        "guide": (
            "## はじめに\n"
            "`/help` でカテゴリごとのコマンド一覧を見られます。`/help command:` にコマンド名を入れると、"
            "そのコマンドの使い方だけを表示します。\n\n"
            "## グローバルチャット\n"
            "つないだチャンネルの発言が、ほかのサーバーの接続先へ届きます。チャンネルの接続・解除と荒らし対策（NG ワード・ブロック）は `/support` の「グローバルチャット」から設定します。通話のルームの作成・参加は `/vc` の「グローバルVCルーム」から行います。\n\n"
            "## 隠し機能: 今北産業\n"
            "会話の途中で「今北産業」と送ると、直近の会話を最大3行で要約します。"
        ),
    },
    {
        "id": "economy",
        "label": "コイン",
        "description": "サーバー共通のコイン（AGO）を稼ぎ、使い、増やすための機能です。",
        "guide": (
            "## コインのしくみ\n"
            "はじめて `/general` の「プレイヤー状況」を使うと 10 AGO もらえます。残高の確認、ほかの人への送金、"
            "保有ランキングは、すべて `/general` の「マネー」から行います。\n\n"
            "## コインの使い道\n"
            "「マネー」では、アゴトークンを市場で売買したり、アイテムや宝箱の売買、工房での生産と合成ができます。"
            "採掘や宝くじで増やすこともできますが、宝くじは外れると賭けた分を失います。"
            "ほかの人から盗む機能もありますが、失敗すると罰金があるので注意してください。\n\n"
            "## 数字当て\n"
            "`/game` の「数字当て」は 1〜3 の数字を当てるゲームです。当たると賭け額の 2.8 倍がもらえ、外れると 1.5 倍が引かれます。"
            "負けても残高がマイナスにならない額までしか賭けられません。"
        ),
    },
    {
        "id": "game",
        "label": "パーティーゲーム",
        "description": "人狼・ワードウルフ・UNO・ダウト・NGワード・お題しりとり・じゃんけん・Wordle・神経衰弱・ババ抜き・大富豪など、チャンネルのみんなで遊べるゲームです。",
        "guide": (
            "## 遊び方\n"
            "それぞれのゲームのコマンドを実行すると参加者の募集が始まり、ボタンで参加できます。"
            "ルールは各コマンドの「ガイド」で確認できます。\n\n"
            "## 人数の目安\n"
            "人狼は 5 人以上、ワードウルフとダウトは 3 人以上、UNO は 2 人以上で遊べます。"
        ),
    },
    {
        "id": "voice",
        "label": "ボイス・音楽",
        "description": "ボイスチャンネルでの音楽再生と、録音・文字起こし・ボイスチェンジャー・他サーバーとの通話など、`/vc` の機能です。",
        "guide": (
            "## はじめに\n"
            "先に自分がボイスチャンネルに入ってから `/vc` を実行してください。音楽の再生は `/vc` の「音楽」にある音楽操作パネルから行い、URL・検索語・音声ファイルの再生、"
            "一時停止・キュー・音響設定・プレイリスト操作まで実行できます。パネルの自動再生を ON にすると、キューが尽きたときに VC にいる人のリクエスト履歴などから自動で曲を補充します。録音・やまびこ・文字起こし・カラオケ、"
            "ボイスチェンジャー、読み上げ、ランダム通話・グローバルVCも、すべて `/vc` のジャンルから選べます。\n\n"
            "## 注意\n"
            "音楽とボイスの機能は、どれも Bot の接続を 1 つ使います。ほかの機能が使用中のときは断られるので、"
            "`/vc` の「VC接続」にある「状態」で何が使っているかを確かめ、終わってから（または「退出」してから）実行してください。"
            "録音を始めると、チャンネルに「録音を開始しました」と表示されます。"
            "誰もいない状態が 3 分続くと Bot は自動で退出します。"
        ),
    },
    {
        "id": "fun",
        "label": "おたのしみ・AI",
        "description": "画像生成、AI との会話、チャンネルの雰囲気分析、検索リンク、暗算・ダンジョンなどのひとりで遊べる機能です。",
        "guide": None,
    },
    {
        "id": "admin",
        "label": "サーバー管理",
        "description": "認証パネル、メッセージの一括削除、ミュートなど、管理者向けの機能です。多くは管理用の権限が必要です。",
        "guide": (
            "## はじめに\n"
            "サーバー設定ウィザード（`/setup`）は廃止されました。グローバルチャットの接続・解除と荒らし対策は `/support` の「グローバルチャット」から設定できます。認証等は、既存の設定がある場合に限り引き続き動作します。"
        ),
    },
]


# このキーのコマンドは、環境によっては読み込まれない（無くてもテストで失敗にしない）
OPTIONAL_COMMANDS = {
    "/judge": "needle3 が入っている環境（ラズパイ）でだけ読み込まれる",
    "/game": "パーティーゲームの入口",
}

COMMAND_META: dict[str, dict] = {
    # ---------------------------------------------------------------- サポート
    "/help": {"category": "support"},
    "!help": {
        "category": "support",
        "summary": "コマンドの一覧と使い方を表示します（詳しくは /help）",
        "options": {"command": "使い方を見たいコマンド名"},
    },
    "/support": {"category": "support", "guild_only": True,
                  "usage": "/support（操作パネルを表示）"},
    "/quick": {"category": "support",
               "summary": "全機能から検索して直接実行します（クイックパレット）",
               "usage": "/quick action:<機能名>",
               "options": {"action": "実行する機能（入力すると候補が出ます）"}},
    # ---------------------------------------------------------------- コイン
    "!nation": {"category": "economy", "summary": "国づくり機能", "guild_only": True, "hidden": True},
    "!nation join": {"category": "economy", "guide": NATION_GUIDE, "guild_only": True,
                      "summary": "このサーバーの国に国民として参加します", "hidden": True},
    "!nation found": {"category": "economy", "guide": NATION_GUIDE, "guild_only": True,
                       "summary": "このサーバーの国を建国します（管理者かオーナーのみ）",
                       "permissions": ["administrator"], "hidden": True},
    "!nation status": {"category": "economy", "guide": NATION_GUIDE, "guild_only": True,
                       "summary": "所属国・役職・所持金・空腹度を表示します", "hidden": True},
    "!coin": {"category": "economy", "summary": "管理者が自分の残高を直接設定します", "permissions": ["bot_admin"],
              "hidden": True},

    # ---------------------------------------------------------------- パーティーゲーム
    "/game": {"category": "game"},
    "!doubt": {"category": "game", "summary": "ダウトの参加者を募集して始めます（3人以上）", "guild_only": True,
               "guide_key": "doubt"},

    # ---------------------------------------------------------------- ボイス・音楽
    "/vc": {"category": "voice", "usage": "/vc（操作パネルを表示）"},
    "!ffversion": {"category": "voice", "hidden": True},

    # ---------------------------------------------------------------- おたのしみ・AI
    "/judge": {"category": "fun"},
    "!ai": {"category": "fun"},
    "!aitools": {"category": "fun"},
    "!generate": {"category": "fun"},
    "!mood": {"category": "fun", "summary": "このチャンネルの直近3週間の雰囲気を AI が分析します"},
    "!ggrks": {"category": "fun", "options": {"keyword": "検索する言葉"}},

    # ---------------------------------------------------------------- サーバー管理
    "!dungeon_reset": {"category": "admin", "summary": "ダンジョンのマップを全サーバー分リセットします", "permissions": ["bot_admin"],
                       "hidden": True},
    "!logs": {"category": "admin", "summary": "サーバー側のログを取得します", "permissions": ["bot_admin"],
              "usage": "!logs [行数] [重要度]", "hidden": True},
    "!usage_stats": {"category": "admin", "summary": "コマンドと機能の利用統計を表示します", "permissions": ["bot_admin"],
                     "usage": "!usage_stats [reset]", "hidden": True},
    "!sttdebug": {"category": "admin", "summary": "文字起こしのデバッグ情報を表示します", "hidden": True},
    "!check_api": {"category": "admin", "summary": "入っているライブラリの一覧を表示します", "permissions": ["bot_admin"],
                   "hidden": True},
    "!d1ping": {"category": "admin", "summary": "d1 サーバーの応答を確かめ、止まっていれば起動します",
                "permissions": ["bot_admin"], "hidden": True},
    "!all_stats": {"category": "admin", "summary": "Bot とサーバーの状態を表示します", "hidden": True},
    "!terminal": {"category": "admin", "summary": "持ち主専用の操作パネルを表示します", "permissions": ["bot_admin"],
                  "hidden": True},
    "!guild": {"category": "admin", "summary": "Bot が入っているサーバーの一覧を表示します", "permissions": ["bot_admin"],
               "hidden": True},
}


def game_guides() -> dict:
    """core/game/game/game_guides.py があれば、そのルール説明を返す（無い環境では空）。"""
    try:
        from core.game.game import game_guides as module
    except ImportError:
        return {}
    return getattr(module, "GAME_GUIDES", {}) or {}


def resolve_guide(meta: dict) -> str | None:
    """guide（直接書いたもの）か guide_key（core/game/game/game_guides.py の項目）からガイドを返す。"""
    if meta.get("guide"):
        return meta["guide"]
    key = meta.get("guide_key")
    if key:
        guide = (game_guides().get(key) or {}).get("guide")
        if guide:
            return guide
    return None
