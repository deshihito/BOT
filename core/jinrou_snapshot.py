# -*- coding: utf-8 -*-
"""人狼のフェーズ境界スナップショット（再起動復旧・最低ライン）。

人狼はフェーズ内の入力収集（夜のアクション・投票の途中経過）が
プロセス前提で、そのままでは再起動復旧できない。そこで、入力が
集まりきった「フェーズ境界」でだけ状態を保存し、再起動後は
直近の境界から対局を再構築して続行できるようにする。

保存する境界:
- roles_assigned: 役職を配った直後（特別ディスカッション前）
- night_start: 夜フェーズ開始直前（その夜のアクションは未収集）
- day_start: 夜の結果が確定し、昼の議論に入る直前
- vote_done: 投票と処刑が確定した直後

復旧できるもの: 参加者・役職・生死・日数・モードと、境界までに確定した
補助状態（裏役職の判明状態、議長の決行使用済み、リア充ペアなど）。
復旧できないもの（正直な線引き）:
- フェーズの途中経過（その夜に集めかけたアクション、その日の発言、
  投票の途中経過）は失われる。境界の直前まで巻き戻る。
- 振り返り（review）の記録は復旧対象外。
- グローバルモード（複数チャンネルにまたがる）は対象外（ローカルのみ）。
- 死亡者の発言制限は silenced_players を境界時点で保存するため、
  夜開始時点の制限は再現されるが、議論中の制限変化は境界まで戻る。

保存先は他の対局中ゲームと同じ core/game_restore.py のストア
（game_id="jinrou"）。保存はすべて best-effort で、失敗しても対局は止めない。
"""
import logging

from core import game_restore

logger = logging.getLogger(__name__)

GAME_ID = "jinrou"
BOUNDARIES = ("roles_assigned", "night_start", "day_start", "vote_done")

# int キーの辞書を JSON 用に str キーへ / 復元時に int キーへ戻す対象
_INT_KEY_DICTS = ("roles", "display_roles", "ura_reveal_triggers", "aho_fake_role",
                  "wan_owner", "masai_evasion", "kizoku_slave", "yandere_targets")


def _member_id(member):
    return getattr(member, "id", None)


def build_state(game, boundary: str) -> dict | None:
    """JinrouGame から JSON 安全なスナップショットを作る。対象外なら None。"""
    if boundary not in BOUNDARIES:
        return None
    if getattr(game, "is_global", False):
        return None
    channel = getattr(game, "game_channel", None)
    channel_id = getattr(channel, "id", None)
    if channel_id is None:
        return None
    players = []
    for p in game.players:
        ref = game_restore.member_ref(p)
        if not ref.get("id"):
            return None
        players.append(ref)
    state = {
        "boundary": boundary,
        "channel_id": int(channel_id),
        "guild_id": getattr(getattr(channel, "guild", None), "id", None),
        "host_id": game.host_id,
        "game_mode": game.game_mode,
        "day_count": int(game.day_count),
        "players": players,
        "alive_ids": [p_id for p in game.alive_players if (p_id := _member_id(p)) is not None],
        "last_executed": game.last_executed,
        "silenced_ids": sorted(int(x) for x in game.silenced_players),
        "chairman_ketsugu_used": bool(game.chairman_ketsugu_used),
        "used_hadouhou": bool(game.used_hadouhou),
        "musician_party_used": bool(game.musician_party_used),
        "mokumoku_turns": int(game.mokumoku_turns),
        "required_roles": list(game.required_roles),
        "excluded_roles": list(game.excluded_roles),
        "riacchu_pairs": [list(pair) for pair in game.riacchu_pairs],
    }
    for name in _INT_KEY_DICTS:
        value = getattr(game, name, {}) or {}
        state[name] = {str(k): v for k, v in value.items()}
    return state


def save_boundary_safely(game, boundary: str) -> bool:
    """境界スナップショットを保存する。失敗しても対局は止めない。"""
    try:
        state = build_state(game, boundary)
        if state is None:
            return False
        game_restore.save_session(GAME_ID, state["channel_id"], state["guild_id"], state)
        game_restore.flush_store()
        return True
    except Exception:
        logger.debug("人狼: スナップショットの保存に失敗しました", exc_info=True)
        return False


def clear_safely(game) -> None:
    try:
        if getattr(game, "is_global", False):
            return
        channel_id = getattr(getattr(game, "game_channel", None), "id", None)
        if channel_id is not None:
            game_restore.clear_session(GAME_ID, int(channel_id))
            game_restore.flush_store()
    except Exception:
        logger.debug("人狼: スナップショットの削除に失敗しました", exc_info=True)


def apply_state(game, state: dict, resolve_member) -> bool:
    """保存済み state を JinrouGame に戻す。resolve_member(ref) -> Member/None。

    参加者を1人でも解決できなければ False（対局として成立しないため）。
    """
    players = []
    for ref in state.get("players") or []:
        member = resolve_member(ref)
        if member is None:
            return False
        players.append(member)
    if len(players) < 5:
        return False
    by_id = {m.id: m for m in players}
    game.players = players
    game.host_id = state.get("host_id")
    game.game_mode = state.get("game_mode") or game.game_mode
    game.day_count = int(state.get("day_count") or 0)
    game.alive_players = [by_id[i] for i in state.get("alive_ids") or [] if i in by_id]
    game.last_executed = state.get("last_executed")
    game.silenced_players = {int(x) for x in state.get("silenced_ids") or []}
    game.chairman_ketsugu_used = bool(state.get("chairman_ketsugu_used"))
    game.used_hadouhou = bool(state.get("used_hadouhou"))
    game.musician_party_used = bool(state.get("musician_party_used"))
    game.mokumoku_turns = int(state.get("mokumoku_turns") or 0)
    game.required_roles = list(state.get("required_roles") or [])
    game.excluded_roles = list(state.get("excluded_roles") or [])
    game.riacchu_pairs = [list(pair) for pair in state.get("riacchu_pairs") or []]
    for name in _INT_KEY_DICTS:
        raw = state.get(name) or {}
        setattr(game, name, {int(k): v for k, v in raw.items()})
    game.night_actions = {}
    game.voted_count = {}
    game.in_discussion = False
    game.is_running = True
    game.started = True
    return True
