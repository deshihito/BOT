# -*- coding: utf-8 -*-
"""人狼の「振り返り表」: ゲーム中の夜の行動と昼の追放を記録し、終了時に 1 つの埋め込みにまとめる。

- 記録はメモリだけ（``game.review``）。新しいゲームでは JinrouGame.__init__ で空に戻る。
- ゲームのルールや判定には一切関わらない。cogs/jinrou.py の決まった場所から呼ぶだけ。
- 名前は ``game.players`` の Member から取るので、グローバル（複数サーバー）のゲームでも
  ゲームのチャンネルのサーバーにいない人の名前が出せる。
"""
import discord

COLOR = 0xFFFFFF
WOLF_ROLES = ("人狼", "デカ狼")

# 夜の行動を表に出す役職と、その書き方（{a}=行動した人、{t}=対象）
ACTION_TEXT = {
    "騎士": "🛡 {a} が {t} を護衛",
    "罠師": "🪤 {a} が {t} に罠",
    "マサイ族": "👀 {a} が {t} を観察",
    "陽キャ": "🎉 {a} が {t} を誘う",
    "あごむに破道砲": "💥 {a} が {t} に破道砲",
    "ワンころ": "🐶 {a} が {t} を飼い主に",
    "大霊媒師": "🔮 {a} が {t} を霊視",
}

ATTACK_TEXT = {
    "success": "成功",
    "guarded": "護衛で失敗",
    "party": "パーティで失敗",
    "trapped": "罠で返り討ち",
    "evaded": "マサイ族が回避",
    "attacker_dead": "襲撃者が先に死亡",
}


def _log(game):
    if not hasattr(game, "review") or game.review is None:
        game.review = []
    return game.review


def name_of(game, uid) -> str:
    for p in getattr(game, "players", []):
        if p.id == uid:
            return getattr(p, "display_name", None) or str(uid)
    return "不明"


def note_divine(game, seer_id, target_id, result) -> None:
    """占い師が占ったとき（結果が出た時点）に呼ぶ。夜の記録で使う。"""
    if not hasattr(game, "review_divines") or game.review_divines is None:
        game.review_divines = {}
    game.review_divines[seer_id] = (target_id, result)


def record_night(game, night: int, actions: dict, cancelled: set, attacks: dict, died: list) -> None:
    """夜の結果を 1 行にまとめて記録する。

    actions: {行動した人: 対象}（game.night_actions の写し）
    cancelled: 陽キャ・パーティで行動が取り消された人
    attacks: {人狼: (対象, ATTACK_TEXT のキー)}
    died: この夜に死んだ人
    """
    divines = getattr(game, "review_divines", None) or {}
    lines = []
    for uid, tid in actions.items():
        role = game.roles.get(uid)
        cancel = "（取り消し）" if uid in cancelled else ""
        if role == "占い師" and uid in divines:
            t, res = divines[uid]
            lines.append(f"<:loupe:1563559480069853245> {name_of(game, uid)} が {name_of(game, t)} を占い →【{res}】{cancel}")
        elif role == "ミュージシャン" and tid == 0:
            lines.append(f"🎵 {name_of(game, uid)} がパーティを開催{cancel}")
        elif role in ACTION_TEXT and tid:
            lines.append(ACTION_TEXT[role].format(a=name_of(game, uid), t=name_of(game, tid)) + cancel)
        elif role in WOLF_ROLES and tid and uid in cancelled:
            lines.append(f"🐺 {name_of(game, uid)} が {name_of(game, tid)} を襲撃（取り消し）")
    for wid, (tid, outcome) in attacks.items():
        lines.append(f"🐺 {name_of(game, wid)} が {name_of(game, tid)} を襲撃 → {ATTACK_TEXT.get(outcome, outcome)}")
    if died:
        lines.append("💀 犠牲: " + "、".join(name_of(game, d) for d in died))
    else:
        lines.append("🌙 犠牲者なし")
    _log(game).append(("night", night, lines))
    game.review_divines = {}


def record_day(game, day: int, executed: list) -> None:
    """昼の投票の結果を記録する。executed: 追放（と道連れ）で死んだ人。"""
    if executed:
        text = "🗳 追放: " + "、".join(name_of(game, d) for d in executed)
    else:
        text = "🗳 追放なし"
    _log(game).append(("day", day, [text]))


def build_embed(game) -> discord.Embed:
    """振り返り表の埋め込み。夜・昼ごとに 1 欄、最後に全員の役職。"""
    embed = discord.Embed(title="振り返り表", color=COLOR)
    entries = list(_log(game))
    # 欄は最大 25 個。役職の欄に 1 つ残す
    if len(entries) > 24:
        entries = entries[-24:]
        embed.description = "（長いので最後の 24 件だけ表示しています）"
    for kind, n, lines in entries:
        title = f"第{n}夜" if kind == "night" else f"第{n}日 投票"
        embed.add_field(name=title, value="\n".join(lines)[:1024] or "-", inline=False)
    alive = {p.id for p in getattr(game, "alive_players", [])}
    roles = [f"{'<:success:1490985168100659322>' if p.id in alive else '💀'} {name_of(game, p.id)}: {game.roles.get(p.id, '不明')}"
             for p in game.players]
    embed.add_field(name="役職", value="\n".join(roles)[:1024] or "-", inline=False)
    if len(embed) > 6000:
        while len(embed) > 6000 and len(embed.fields) > 1:
            embed.remove_field(0)
        embed.description = "（長いので古い記録を省いています）"
    return embed
