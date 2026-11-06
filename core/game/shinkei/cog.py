# -*- coding: utf-8 -*-
"""神経衰弱: 裏向きのカード（ボタン）を 2 枚ずつめくって、同じ絵のペアを集めるゲーム。

- スラッシュコマンドは増やさず、/game の「神経衰弱」から募集する（GameHub が start_recruit を呼ぶ）。
- カードは 24 枚（12 ペア）。Discord の 1 メッセージのボタン上限 25 個に収まるよう 5・5・5・5・4 で並べる。
- 1〜6 人。参加順に手番。そろえば得点してもう一度、外れたら少し見せてから裏に戻して次の人へ。
- 手番の時間切れでは core/autoplay.take_idle_turn で代わりにめくる（サーバー設定でオフなら手番を飛ばす）。
- 全部そろったら、ペアの数が一番多い人の勝ち（同点は全員勝ち）。
  勝利数は core/game/party_ranking.py に記録する（2 人以上の勝負のときだけ。ひとり遊びは数えない）。
"""
import asyncio
import logging
import random

import discord
from core.game import game_panels, game_restore
from core.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.emojis import CROCK

logger = logging.getLogger(__name__)
from core.messages import recruit_join_prompt
from discord.ext import commands

from core.game import autoplay, party_ranking

GAME_ID = "shinkei"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 30
REVEAL_SECONDS = 2
MIN_PLAYERS = 1
MAX_PLAYERS = 6
PAIRS = 12
ROW_SIZES = (5, 5, 5, 5, 4)       # 合計 24 枚（ボタン 25 個まで）
SYMBOLS = tuple("ABCDEFGHIJKL")   # カードの面（絵文字は使わない）
BACK = "?"


def deal(rng=random) -> list:
    cards = [s for s in SYMBOLS[:PAIRS] for _ in range(2)]
    rng.shuffle(cards)
    return cards


def row_of(index: int) -> int:
    total = 0
    for row, size in enumerate(ROW_SIZES):
        total += size
        if index < total:
            return row
    raise IndexError(index)


class ShinkeiGame:
    def __init__(self, channel_id, guild_id, host_id, cards=None):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}            # user_id -> member（参加順＝手番の順）
        self.cards = cards or deal()
        self.matched: dict = {}            # カード番号 -> そろえた user_id
        self.face_up: list = []            # この手番でめくったカード（0〜2 枚）
        self.scores: dict = {}
        self.turn_index = 0
        self.phase = "recruit"             # recruit / playing / done
        self.turn_done = False             # この手番が終わった（外れ・時間切れ）
        self.message = None
        self.last_notice = None            # 進行通知（常に最新1通だけ残す）

    @property
    def order(self) -> list:
        return list(self.players)

    @property
    def current(self):
        return self.order[self.turn_index % len(self.order)] if self.players else None

    @property
    def finished(self) -> bool:
        return len(self.matched) == len(self.cards)

    def hidden(self) -> list:
        """いまめくれるカードの番号。"""
        return [i for i in range(len(self.cards)) if i not in self.matched and i not in self.face_up]

    def flip(self, uid, index: int) -> str:
        """カードをめくる。結果: "first" / "match" / "miss" / "invalid"。"""
        if self.phase != "playing" or uid != self.current or len(self.face_up) >= 2 or index not in self.hidden():
            return "invalid"
        self.face_up.append(index)
        if len(self.face_up) == 1:
            return "first"
        a, b = self.face_up
        if self.cards[a] == self.cards[b]:
            self.matched[a] = self.matched[b] = uid
            self.scores[uid] = self.scores.get(uid, 0) + 1
            self.face_up = []
            return "match"
        return "miss"

    def next_turn(self):
        self.face_up = []
        self.turn_index = (self.turn_index + 1) % len(self.order)

    def winners(self) -> list:
        if not self.scores:
            return []
        best = max(self.scores.values())
        return [uid for uid in self.order if self.scores.get(uid, 0) == best]

    def score_text(self) -> str:
        return "\n".join(f"{'> ' if uid == self.current and self.phase == 'playing' else ''}"
                         f"{m.mention}: {self.scores.get(uid, 0)}ペア" for uid, m in self.players.items())


class CardButton(discord.ui.Button):
    def __init__(self, cog, game: ShinkeiGame, index: int):
        if index in game.matched:
            label, style, disabled = game.cards[index], discord.ButtonStyle.success, True
        elif index in game.face_up:
            label, style, disabled = game.cards[index], discord.ButtonStyle.primary, True
        else:
            label, style, disabled = BACK, discord.ButtonStyle.secondary, game.phase != "playing"
        super().__init__(label=label, style=style, disabled=disabled,
                         custom_id=f"shinkei:{game.channel_id}:{index}")
        self.cog, self.game, self.index = cog, game, index

    async def callback(self, interaction: discord.Interaction):
        await self.cog.on_flip(interaction, self.game, self.index)


class BoardView(GamePanelView):
    """神経衰弱の盤面パネル（V2）。

    24枚のカードボタンは盤面そのものが操作対象なのでボタン形式を維持し、
    ROW_SIZES の行分けで ActionRow に載せる。custom_id は従来どおり維持。
    """

    def __init__(self, cog, game: ShinkeiGame, body: str = ""):
        super().__init__("神経衰弱", body, timeout=None)
        self.cog, self.game = cog, game
        self.card_buttons = []
        index = 0
        for size in ROW_SIZES:
            row = []
            for _ in range(size):
                button = CardButton(cog, game, index)
                self.card_buttons.append(button)
                row.append(button)
                index += 1
            self.add_row(*row)


class JoinView(LobbyView):
    """共通ロビー。参加/退出は game.players（id→member）にも同期する。"""

    def __init__(self, cog, game: ShinkeiGame):
        self.cog, self.game = cog, game
        host = game.players.get(game.host_id)
        super().__init__(
            title="神経衰弱 参加者募集", host=host,
            min_players=MIN_PLAYERS, max_players=MAX_PLAYERS,
            note=(f"{host.mention if host else ''} さんが募集中です。\n"
                  f"{recruit_join_prompt(RECRUIT_SECONDS)}（ひとりでも遊べます）。"),
            timeout=RECRUIT_SECONDS + 30)

    async def _on_join(self, interaction: discord.Interaction):
        await super()._on_join(interaction)
        if interaction.user.id in self.players:
            self.game.players[interaction.user.id] = interaction.user

    async def _on_leave(self, interaction: discord.Interaction):
        await super()._on_leave(interaction)
        if interaction.user.id not in self.players:
            self.game.players.pop(interaction.user.id, None)


class Shinkei(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> ShinkeiGame

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既に神経衰弱が進行中です。", color=COLOR),
                ephemeral=True)
        g = ShinkeiGame(channel.id, interaction.guild_id, interaction.user.id)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            view=text_panel("", f"神経衰弱の募集を開始しました（{RECRUIT_SECONDS}秒）。"))
        try:
            lobby = JoinView(self, g)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                await asyncio.sleep(0.5)
                if lobby.started or lobby.cancelled:
                    break
            if lobby.cancelled:
                return
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    def board_text(self, g: ShinkeiGame, note: str = "") -> str:
        if g.phase == "playing":
            head = f"{g.players[g.current].mention} さんの番です（{TURN_SECONDS}秒）。? のカードを2枚めくってください。"
        else:
            head = "ゲーム終了"
        body = f"{head}\n{note}".strip()
        body += f"\n\n## ペア（残り {PAIRS - len(g.matched) // 2}）\n{g.score_text()[:1024]}"
        return body

    async def refresh(self, g: ShinkeiGame, note: str = ""):
        if g.message is not None:
            await g.message.edit(view=BoardView(self, g, body=self.board_text(g, note)))

    async def _notice(self, channel, g: ShinkeiGame, body: str):
        """進行通知は常に最新1通だけ残す。"""
        if g.last_notice is not None:
            await safe_delete(g.last_notice)
        g.last_notice = await channel.send(view=text_panel("", body))

    async def run_game(self, channel, g: ShinkeiGame):
        g.phase = "playing"
        order = " → ".join(m.display_name for m in g.players.values())
        g.message = await game_panels.replace(channel, "party", view=BoardView(self, g, body=self.board_text(g, f"順番: {order}")))
        await self._play_loop(channel, g)
        await self.finish(channel, g)

    async def _play_loop(self, channel, g: ShinkeiGame):
        idle_streak = 0
        while not g.finished:
            result = await self.play_turn(channel, g)
            if result == "timeout":
                idle_streak += 1
                if idle_streak >= 2 * len(g.players):
                    await self._notice(channel, g, "だれもめくらない状態が続いたので終了します。")
                    break
            else:
                idle_streak = 0

    async def play_turn(self, channel, g: ShinkeiGame) -> str:
        """1 人の手番。そろえ続けるあいだは同じ人。戻り値: "miss" / "done" / "timeout" / "auto"。"""
        # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
        self._save_snapshot(g)
        g.turn_done = False
        uid = g.current
        elapsed = 0
        while not g.turn_done and not g.finished and elapsed < TURN_SECONDS:
            await asyncio.sleep(1)
            elapsed += 1
            if g.current != uid:   # 念のため
                return "miss"
        if g.finished:
            return "done"
        if g.turn_done:      # 外れ: 少し見せてから戻す
            await asyncio.sleep(REVEAL_SECONDS)
            g.next_turn()
            await self.refresh(g)
            return "miss"
        return await self.idle_turn(channel, g, uid)

    async def idle_turn(self, channel, g: ShinkeiGame, uid) -> str:
        """時間切れ。代打ちでめくり、オフなら手番を飛ばす。"""
        member = g.players[uid]
        while not g.finished and g.current == uid:
            legal = [str(i + 1) for i in g.hidden()]
            result = await autoplay.take_idle_turn(
                None, guild_id=g.guild_id, player_name=member.display_name,
                state={"game": "神経衰弱", "cards": len(g.cards),
                       "face_up": {str(i + 1): g.cards[i] for i in g.face_up},
                       "matched": sorted(i + 1 for i in g.matched)},
                legal_actions=legal,
                instructions="神経衰弱で、めくるカードの番号を 1 つ選んでください",
                describe=lambda a: f"{a}番のカードをめく")
            if result is None or result.action is None:
                g.next_turn()
                await self._notice(channel, g, f"{member.mention} さんは時間切れのため、手番を飛ばします。")
                await self.refresh(g)
                return "timeout"
            await self._notice(channel, g, result.notice.lstrip(CROCK).strip())   # 絵文字を外して自分で送る
            outcome = g.flip(uid, int(result.action) - 1)
            await self.refresh(g)
            if outcome == "miss":
                await asyncio.sleep(REVEAL_SECONDS)
                g.next_turn()
                await self.refresh(g)
                return "timeout"
            if outcome == "invalid":   # 起きないはずだが、止まらないように
                g.next_turn()
                return "timeout"
        return "timeout"

    async def on_flip(self, interaction: discord.Interaction, g: ShinkeiGame, index: int):
        if g.phase != "playing":
            return await interaction.response.send_message("このゲームは終わりました。", ephemeral=True)
        if interaction.user.id != g.current:
            return await interaction.response.send_message("あなたの番ではありません。", ephemeral=True)
        if g.turn_done or len(g.face_up) >= 2:
            return await interaction.response.send_message("カードを戻しています。少し待ってください。", ephemeral=True)
        outcome = g.flip(interaction.user.id, index)
        if outcome == "invalid":
            return await interaction.response.send_message("そのカードはめくれません。", ephemeral=True)
        note = {"first": "", "match": "そろいました！ もう一度めくれます。",
                "miss": "残念、そろいませんでした。"}[outcome]
        if outcome == "miss":
            g.turn_done = True
        if g.finished:
            g.turn_done = True
        # めくった結果（ペア成立・得点）もチェックポイントに反映する
        self._save_snapshot(g)
        await interaction.response.edit_message(view=BoardView(self, g, body=self.board_text(g, note)))

    async def finish(self, channel, g: ShinkeiGame):
        g.phase = "done"
        g.face_up = []
        winners = g.winners() if g.finished else []
        if len(g.players) >= 2:
            for uid in winners:
                await party_ranking.shared().record_win(g.guild_id, uid, GAME_ID)
        # 盤面パネルは全カードを開示した表示専用にして残す（ボタンは残さない）
        grid_lines = []
        index = 0
        for size in ROW_SIZES:
            grid_lines.append(" ".join(g.cards[index + j] for j in range(size)))
            index += size
        if g.message is not None:
            await g.message.edit(view=text_panel(
                "神経衰弱", self.board_text(g) + "\n\n" + "\n".join(grid_lines)))
        if winners:
            text = "勝者: " + "、".join(g.players[u].mention for u in winners)
            if len(g.players) < 2:
                text = "全部そろいました！（ひとり遊びはランキングに数えません）"
        else:
            text = "勝者なし"
        if g.last_notice is not None:
            await safe_delete(g.last_notice)
            g.last_notice = None
        await channel.send(view=text_panel(
            "神経衰弱 終了", text + f"\n\n## 結果\n{g.score_text()[:1024] or '（なし）'}"))

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g: ShinkeiGame) -> None:
        if g.phase != "playing":
            return
        state = {
            "host_id": g.host_id,
            "players": [
                [uid, game_restore.member_ref(m) if m is not None else None]
                for uid, m in g.players.items()
            ],
            "cards": list(g.cards),
            "matched": [[idx, uid] for idx, uid in g.matched.items()],
            "scores": [[uid, n] for uid, n in g.scores.items()],
            "turn_index": g.turn_index,
            "message_id": getattr(g.message, "id", None),
        }
        game_restore.save_session("shinkei", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("shinkei", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だった神経衰弱を、手番の開始時点から再開する。

        手番の途中でめくっていたカード（face_up）は裏に戻して再開する。
        """
        entries = game_restore.session_entries("shinkei")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: 神経衰弱の復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("shinkei", channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.games:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        guild = getattr(channel, "guild", None)
        guild_id = entry.get("guild_id") or getattr(guild, "id", None)
        cards = state.get("cards")
        if not isinstance(cards, list) or not cards:
            return False
        g = ShinkeiGame(channel_id, guild_id, state.get("host_id"), cards=list(cards))
        players = {}
        for uid, ref in state["players"]:
            uid = int(uid)
            players[uid] = None if ref is None else game_restore.resolve_member(
                guild, ref.get("id"), ref.get("name"))
        if not players:
            return False
        g.players = players
        g.matched = {int(idx): int(uid) for idx, uid in state.get("matched") or []}
        g.scores = {int(uid): int(n) for uid, n in state.get("scores") or []}
        g.turn_index = int(state.get("turn_index") or 0)
        g.face_up = []
        g.turn_done = False
        g.phase = "playing"
        message_id = state.get("message_id")
        fetch = getattr(channel, "fetch_message", None)
        if message_id and callable(fetch):
            try:
                g.message = await fetch(message_id)
            except Exception:
                g.message = None
        self.games[channel_id] = g
        if g.message is not None:
            # 既存の盤面メッセージへ新しいパネルを付け直して復活させる
            await self.refresh(g)
        else:
            g.message = await game_panels.replace(
                channel, "party", view=BoardView(self, g, body=self.board_text(g)))
        asyncio.create_task(self._run_restored_session(channel, g))
        return True

    async def _run_restored_session(self, channel, g: ShinkeiGame):
        try:
            await self._play_loop(channel, g)
            await self.finish(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧した神経衰弱の進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)


async def setup(bot):
    await bot.add_cog(Shinkei(bot))
