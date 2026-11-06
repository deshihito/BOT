"""人狼ゲームの初心者ガイド（役職ごとの説明と、フェーズの「？」ボタンの説明）。

文章は cogs/jinrou.py の役職定義（HELP_ROLES）から組み立てる。HELP_ROLES に役職を足せば
ガイドも自動で出る。下の表に載っていない役職には、陣営から作った汎用の説明を使う。
"""
from __future__ import annotations

from typing import Iterable, Optional
from urllib.parse import quote

import discord

# 役職ガイドのページ（TYPETA が作成中）。URL はここだけで管理する。
ROLE_GUIDE_BASE_URL = "https://bot-deshihito.vercel.app/jinrou/roles"

# 役職ページの URL に ASCII の id を使うか（True: /jinrou/roles/werewolf など）。False にすると
# 日本語の役職名を URL エンコードしたもの（encodeURIComponent 相当）を使う。
# scripts/export_jinrou_roles.py もこの値を読んで、サイトの役職 ID をそろえる。
ROLE_URL_USE_SLUG = True

# 役職 ID（スラッグ）は cogs/jinrou.py の HELP_ROLES の 5 番目の値で管理し、register_roles で読み込む。

# 勝敗の判定・人数比べ・レートで人狼側として数える役職（cogs/jinrou.py もここを使う）
WOLF_SIDE = frozenset({"人狼", "デカ狼", "狂人", "狂信者", "ヤンデレ"})

# 勝利条件の個別の説明（載っていない役職は陣営から決める）
WIN_OVERRIDES = {
    "ハゲ": "投票で追放されたら、あなたの勝ち。陣営の勝敗には含まれません。",
    "コウモリむに": "最後まで生き残れば、どちらの陣営が勝っても追加で勝ち。追放では勝てません。",
    "ワンころ": "飼い主が生きていれば村人陣営と一緒に勝ちます。飼い主が死ぬかいないと人狼側になります。",
}

# 夜に「夜のアクション」ボタンから対象を選ぶ役職の、今夜やること
NIGHT_TODO = {
    "人狼": "「夜のアクション」から、襲う相手を 1 人選びます。仲間と相談しましょう。",
    "デカ狼": "「夜のアクション」から、襲う相手を 1 人選びます。仲間と相談しましょう。",
    "ヤンデレ": "「夜のアクション」から対象を 1 人選びます。",
    "占い師": "「夜のアクション」から占う相手を 1 人選びます。白か黒かが分かります。",
    "大霊媒師": "「夜のアクション」から死者を 1 人選ぶと、役職まで分かります（死者がいなければ待機）。",
    "騎士": "「夜のアクション」から守る相手を 1 人選びます（自分は守れません）。",
    "罠師": "「夜のアクション」から守る相手を 1 人選びます。そこを襲った狼を返り討ちにします。",
    "マサイ族": "「夜のアクション」から観察する相手を 1 人選びます。",
    "陽キャ": "「夜のアクション」から連れ込む相手を 1 人選びます。",
    "ミュージシャン": "「夜のアクション」を押すとパーティを開きます（ゲーム中 1 回だけ）。",
    "ワンころ": "最初の夜に「夜のアクション」から飼い主を 1 人選びます。",
    "あごむに破道砲": "第 3 夜から「夜のアクション」で道連れにする相手を選べます。それまでは待機です。",
    "ネット民": "夜のあいだも発言できます。昼は発言できないので、夜に情報を出しましょう。",
}
PASSIVE_TODO = "夜にやることはありません。「夜のアクション」を押しても何も起きないので、朝まで待ちましょう。"

PHASES = {
    "night": ("🌙 夜のフェーズ", (
        "・時間は 1 分です。ネット民以外は発言できません。\n"
        "・能力がある人は「夜のアクション」ボタンから対象を選びます。結果はあなたにだけ届きます。\n"
        "・人狼は 1 人を襲います。朝になると、夜に起きたことが発表されます。")),
    "day": ("☀️ 昼の議論", (
        "・全員で話し合って、人狼だと思う人を探します（ネット民は発言できません）。\n"
        "・占い師などは、結果を言うかどうか作戦を考えましょう。\n"
        "・議長は「スキップ」で議論を終えたり、1 回だけ「強制投票」ができます。\n"
        "・時間が来ると投票に移ります。")),
    "vote": ("🗳️ 投票フェーズ", (
        "・生きている人は、追放したい人を 1 人選びます。時間は 40 秒です。\n"
        "・いちばん票が多かった人が追放されます。投票がなければ追放はありません。\n"
        "・ハゲは追放されると勝ち。よく考えて投票しましょう。")),
}

_roles: dict[str, tuple[str, str]] = {}
ROLE_IDS: dict[str, str] = {}


def register_roles(help_roles: Iterable[tuple]) -> None:
    """(役職名, 陣営, 説明, 画像, id) の一覧を登録する。cogs/jinrou.py が読み込み時に呼ぶ。"""
    for row in help_roles:
        _roles[row[0]] = (row[1], row[2])
        if len(row) > 4 and row[4]:
            ROLE_IDS[row[0]] = row[4]


def role_id(role: str, use_slug: Optional[bool] = None) -> str:
    """URL に使う役職 ID。use_slug を省くと ROLE_URL_USE_SLUG に従う。"""
    if ROLE_URL_USE_SLUG if use_slug is None else use_slug:
        if ROLE_IDS.get(role):
            return ROLE_IDS[role]
    return quote(role, safe="")


def role_url(role: Optional[str]) -> str:
    return f"{ROLE_GUIDE_BASE_URL}/{role_id(role)}" if role else ROLE_GUIDE_BASE_URL


def team_of(role: str) -> str:
    return _roles.get(role, ("不明", ""))[0]


def win_condition(role: str) -> str:
    if role in WIN_OVERRIDES:
        return WIN_OVERRIDES[role]
    if role in WOLF_SIDE:
        return "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。"
    if team_of(role) == "第三者陣営":
        return "人狼が全滅すれば勝ち（勝敗の判定では村人側として数えられます）。"
    return "人狼を全員追放・退治すれば、村人陣営の勝ちです。"


def night_todo(role: str) -> str:
    return NIGHT_TODO.get(role, PASSIVE_TODO)


def guide_fields(role: str) -> list[tuple[str, str]]:
    """役職ガイドの (見出し, 本文) の一覧。未知の役職でも汎用の文章を返す。"""
    team, desc = _roles.get(role, ("不明", "この役職の説明はまだありません。下のリンクを見てください。"))
    return [
        ("陣営", team),
        ("能力", desc),
        ("勝利条件", win_condition(role)),
        ("今夜やること", night_todo(role)),
        ("くわしく", role_url(role)),
    ]


def add_guide(embed: discord.Embed, role: str) -> discord.Embed:
    """既存の役職通知の埋め込みに、初心者ガイドを足す。"""
    for name, value in guide_fields(role):
        embed.add_field(name=f"🔰 {name}", value=value[:1024], inline=name == "陣営")
    return embed


def phase_embed(phase: str, role: Optional[str]) -> discord.Embed:
    title, body = PHASES.get(phase, ("❓ このフェーズ", "画面の案内に従ってください。"))
    embed = discord.Embed(title=title, description=body, color=0xFFFFFF)
    if role:
        embed.add_field(name=f"あなた（{role}）の今夜やること" if phase == "night" else f"あなたの役職: {role}",
                        value=night_todo(role) if phase == "night" else win_condition(role), inline=False)
    embed.add_field(name="役職ガイド", value=role_url(role), inline=False)
    return embed


class PhaseHelpButton(discord.ui.Button):
    """フェーズのメッセージに付ける「？」ボタン。押した人にだけ説明を出す。"""

    def __init__(self, phase: str, role_lookup, row: Optional[int] = None):
        super().__init__(label="？", style=discord.ButtonStyle.secondary, row=row)
        self.phase, self.role_lookup = phase, role_lookup

    async def callback(self, interaction: discord.Interaction):
        role = self.role_lookup(interaction.user.id)
        await interaction.response.send_message(embed=phase_embed(self.phase, role), ephemeral=True)


class PhaseHelpView(discord.ui.View):
    def __init__(self, phase: str, role_lookup, timeout: Optional[float] = None):
        super().__init__(timeout=timeout)
        self.add_item(PhaseHelpButton(phase, role_lookup))
