# -*- coding: utf-8 -*-
"""パーティーゲームのサーバーごとの勝利数（docs/sql/party_game_ranking.sql）。

- 勝ったら ``record_win`` を呼ぶ。メモリの表には必ず足し、自前API の関数
  ``party_game_record_win`` にも送る。関数がまだ無い・通信に失敗したときは
  ログを 1 回だけ出して、以後はメモリだけで続ける（ゲームは止めない）。
- ``top`` はビュー ``party_game_ranking`` を読み、読めなければメモリの表を返す。
- 自前API クライアントの取り出しは ``_default_client`` の 1 か所だけ。
  共通の接続モジュール core/api_client.py（#59）があればそれを、無ければ config.db_api を使う。
"""
import asyncio
import logging

log = logging.getLogger(__name__)

KNOWN_GAMES = ("ngword", "shiritori", "wordwolf", "jinrou", "uno", "doubt", "janken", "wordle", "shinkei", "babanuki", "daifugo")
_MISSING = object()


def _default_client():
    try:  # #59 の共通モジュールがあればそれを使う
        from core import api_client
        return api_client.get_client()
    except ImportError:
        pass
    except Exception:
        return None
    try:
        import config
        return getattr(config, "db_api", None)
    except Exception:
        return None


class PartyRanking:
    def __init__(self, client=_MISSING, timeout: float = 5.0):
        self.client = _default_client() if client is _MISSING else client
        self.timeout = timeout
        self.memory: dict = {}          # (guild_id, game) -> {user_id: 勝利数}
        self.remote_disabled = False
        self._warned = False

    @property
    def remote_enabled(self) -> bool:
        return self.client is not None and not self.remote_disabled

    def _failed(self, action, error):
        text = f"{getattr(error, 'code', '')} {getattr(error, 'message', '')} {error}"
        missing = (
            "RPC_NOT_ALLOWED", "TABLE_NOT_ALLOWED", "TABLE_NOT_FOUND",
            "PGRST202", "PGRST205", "42883", "42P01", "does not exist", "Could not find",
        )
        if any(s in text for s in missing):
            self.remote_disabled = True   # 関数・ビューがまだ無い。再起動までメモリだけ
        if not self._warned:
            self._warned = True
            log.warning("party ranking: %s に失敗したのでメモリだけで続けます: %s", action, error)

    async def _run(self, fn):
        return await asyncio.wait_for(asyncio.to_thread(fn), self.timeout)

    async def record_win(self, guild_id, user_id, game: str) -> None:
        if game not in KNOWN_GAMES or not guild_id or not user_id:
            return
        board = self.memory.setdefault((int(guild_id), game), {})
        board[int(user_id)] = board.get(int(user_id), 0) + 1
        if not self.remote_enabled:
            return
        try:
            await self._run(lambda: self.client.rpc("party_game_record_win", {
                "p_guild_id": int(guild_id), "p_user_id": int(user_id), "p_game": game}).execute())
        except Exception as e:  # noqa: BLE001
            self._failed("勝利の記録", e)

    async def top(self, guild_id, game: str, limit: int = 10) -> list:
        """[(user_id, 勝利数), ...] を勝利数の多い順に返す。"""
        if self.remote_enabled:
            try:
                res = await self._run(lambda: self.client.table("party_game_ranking").select("user_id, wins")
                                      .eq("guild_id", int(guild_id)).eq("game", game)
                                      .order("wins", desc=True).limit(limit).execute())
                return [(int(r["user_id"]), int(r["wins"])) for r in (res.data or [])]
            except Exception as e:  # noqa: BLE001
                self._failed("ランキングの読み込み", e)
        board = self.memory.get((int(guild_id), game), {})
        return sorted(board.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]


# ランキングを記録しているゲーム。各ゲームの cog が import 時に register する
# （/game の「ランキング」ボタンを出すかどうかに使う。cogs/game.py の RANKED_GAMES と合わせて見る）
REGISTERED_GAMES: set = set()


def register(game: str) -> None:
    REGISTERED_GAMES.add(game)


def is_ranked(game: str) -> bool:
    return game in REGISTERED_GAMES


_shared = None


def shared() -> PartyRanking:
    global _shared
    if _shared is None:
        _shared = PartyRanking()
    return _shared
