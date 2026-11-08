"""複数ファイルで共用するユーザ向け定型文の単一の置き場（監査 #8）。

同じ文言が cog ごとにコピペされると、片方だけ直されるドリフトの温床になる。
ここにある文言を直すときは、このファイルだけを直すこと。

注意: 文言の内容は core/locales の翻訳キー（文字列そのもの）なので、
値を変更すると翻訳が追随しなくなる。内容を変える場合は locale 側も見ること。
"""

from __future__ import annotations

from core.support.emojis import FAILED

# ---------------------------------------------------------------- VC 系

#: VC に参加していない状態で VC 前提の機能を実行したときのエラー。
#: sio_globalVC / sio_karaoke / sio_rec / sio_voicechanger で共用。
VOICE_NOT_JOINED = f"{FAILED} ボイスチャンネルに参加してから実行してください。"

# インフラ未設定など、利用者側では直せない理由で機能が使えないときの定型（sweep2 VC-04）。
FEATURE_UNAVAILABLE_CONTACT = "この機能は現在利用できません。Botの運営に連絡してください。"

def room_not_found(room_name: str) -> str:
    """GVC ルーム不存在文の統一形（sweep2 VC-19）。"""
    return f"ルーム **{room_name}** は存在しません。"

def not_running(feature: str) -> str:
    """「現在〜は実行されていません。」の統一形（sweep2 VC-19）。"""
    return f"現在{feature}は実行されていません。"

# 音楽操作の同一VCチェック文（正は messages.py。music/common 側は別名で参照）。
MUSIC_VC_REQUIRED = "この操作は、Bot が接続しているボイスチャンネルに参加しているメンバーだけが行えます。"


def voice_connection_failed(error: object) -> str:
    """ボイス接続に失敗したときの文（末尾に例外をコード表記で付ける）。"""
    return f"{FAILED} ボイス接続に失敗しました: `{error}`"


# ---------------------------------------------------------------- 募集文

def recruit_join_prompt(seconds: int) -> str:
    """パーティーゲームの参加募集の締切文（6 cog で共用）。

    後ろに人数範囲などの括弧書きが続く使い方が前提で、括弧は含まない。
    """
    return f"募集時間: {seconds}秒"


# ------------------------------------------------------- サーバーアシスト

#: 保存済みのロールが Bot に扱えない位置にあるときのエラー。
ROLE_HIERARCHY_ALREADY_SET = "ロールの管理権限、または自分より上のロールが設定されています。"

#: 扱えない位置のロールを設定しようとしたときのエラー。
ROLE_HIERARCHY_CANNOT_SET = "ロールの管理権限、または自分より上のロールを設定しようとしています。"


# ---------------------------------------------------------------- マネーパネル系

#: マネーパネル cog が読み込まれていないときのエラー（/general の dispatch で共用）。
MONEY_PANEL_NOT_LOADED = "マネーパネルが読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"


# ---------------------------------------------------------------- 市場系

#: 市場 cog が読み込まれていないときのエラー（/general の dispatch で共用）。
MARKET_NOT_LOADED = "市場機能が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"

#: 売買モーダルの入力が解釈できないときのエラー。
MARKET_INVALID_AMOUNT = "数量が正しくありません。半角数字で入力してください。"


def market_trade_failed(reason: object) -> str:
    """売買が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


# ---------------------------------------------------------------- アイテム系

#: アイテム cog が読み込まれていないときのエラー（/general の dispatch で共用）。
ITEMS_NOT_LOADED = "アイテム機能が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"

#: アイテム操作モーダルの入力が解釈できないときのエラー。
ITEM_INVALID_INPUT = "入力が正しくありません。アイテム名と数量（半角数字）を確認してください。"

#: アイテム名が定義にないときのエラー。
ITEM_NOT_FOUND = "そのアイテムは存在しません。アイテムパネルで名前を確認してください。"


def item_action_failed(reason: object) -> str:
    """アイテム操作が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


# ---------------------------------------------------------------- 合成・工房系

#: 工房 cog が読み込まれていないときのエラー（/general の dispatch で共用）。
WORKSHOP_NOT_LOADED = "工房機能が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"



def craft_action_failed(reason: object) -> str:
    """合成が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


def workshop_action_failed(reason: object) -> str:
    """工房の操作が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


# ---------------------------------------------------------------- 循環系

#: 循環 cog が読み込まれていないときのエラー（/general の dispatch で共用）。
CIRCULATION_NOT_LOADED = "採掘・宝くじ・盗みの機能が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"


def circulation_action_failed(reason: object) -> str:
    """採掘・宝くじ・盗みの操作が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


# ---------------------------------------------------------------- ギャンブル系

#: ギャンブル cog が読み込まれていないときのエラー（/general の dispatch で共用）。
GAMBLING_NOT_LOADED = "ギャンブル機能が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"

#: ギャンブルの金額入力が解釈できないときのエラー。
GAMBLING_INVALID_AMOUNT = "入力が正しくありません。半角数字で入力してください。"


def gambling_action_failed(reason: object) -> str:
    """ギャンブルの操作が成立しなかったときの文（理由をそのまま続ける）。"""
    return f"{FAILED} {reason}"


# ------------------------------------------------------- 共用エラー文（一斉監査 2026-11-07 で集約）

#: コイン更新そのものが失敗したときの文（経済系 cog で共用）。
COIN_UPDATE_FAILED_RETRY = "コインの更新に失敗しました。時間をおいて再試行してください。"

#: コイン更新が失敗したが残高は変わっていないことを保証する文。
COIN_UPDATE_FAILED_UNCHANGED = "コインの更新に失敗しました。残高は変わっていません。"

#: 汎用の実行時エラー（経済系 cog で共用）。
ACTION_FAILED_RETRY = "実行中にエラーが発生しました。時間をおいて再試行してください。"

#: 購入処理中のエラー（経済系 cog で共用）。
PURCHASE_FAILED_RETRY = "購入中にエラーが発生しました。時間をおいて再試行してください。"

#: 設定保存が失敗したときの文（support 系パネルで共用）。
SETTINGS_UPDATE_FAILED = "設定の更新に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"
DESTINATION_UPDATE_FAILED = "送信先の更新に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"
MANAGE_GUILD_REQUIRED = "この設定にはサーバー管理権限が必要です。"

#: 受け取り処理が失敗したときの文。
CLAIM_FAILED_RETRY = "受け取りに失敗しました。時間をおいて再試行してください。"

def feature_not_loaded(feature: str) -> str:
    """未読込文の統一形（sweep2 GEN-04）。個別定数が無い機能はこちらを使う。"""
    return f"{feature}が読み込まれていません。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"

# 送金モーダルと送金実行部で同じ検証文を使う（sweep2 GEN-04）。
PAY_MIN_AMOUNT = "1コイン以上を指定してください。"
PAY_TO_SELF = "自分自身に送金することはできません。"
PAY_TO_BOT = "Bot には送金できません。"

#: 返金まで失敗したときの文（理由の後に続けて使う）。
REFUND_FAILED_CONTACT = "返金に失敗しました。Botの運営に連絡してください。"
