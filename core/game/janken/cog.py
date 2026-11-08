# -*- coding: utf-8 -*-
"""じゃんけん: チャンネルのみんなで（または Bot と）遊ぶじゃんけん。

- スラッシュコマンドは増やさず、/game の「じゃんけん」から募集する（GameHub が start_recruit を呼ぶ）。
- 手はボタンで選び、返事は本人にだけ見える（ephemeral）。全員そろうか時間切れで一斉に公開する。
- 参加者が 1 人だけなら Bot が相手になる。
- 3 種類の手がそろう／全員同じ手のときは「あいこ」で、同じ人でもう一度。
  勝った手の人だけが残り、最後の 1 人が勝ち。時間内に出さなかった人は負け。
- 勝利数は core/game/game/party_ranking.py に記録する（人間 2 人以上の勝負のときだけ。Bot 戦は数えない）。
- 放置した人の手を代わりに出す共通の仕組み（Lunancy さん担当）ができたら ``auto_hand`` を差し替えて使える。
- 賭け金は開始時に参加者から預かり、精算までメモリ上の ``escrow`` に置かれる。
  預かりは都度 data/janken_escrow.json の台帳にも記録し、精算前に Bot が
  再起動したら起動時に台帳から全額返金する（ポーカーのチップ台帳と同じ考え方）。
"""
import asyncio
import json
import logging
import os
import random
from pathlib import Path

from core.support.emojis import CROCK

import discord
from cogs.general import INSUFFICIENT
from core.game.game import game_panels
from core.game.game import prison as prison_core
from core.game.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.support import data_paths
from core.support.messages import recruit_join_prompt
from discord.ext import commands

from core.game.game import party_ranking

logger = logging.getLogger(__name__)

GAME_ID = "janken"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
HAND_SECONDS = 20
MAX_PLAYERS = 10
MAX_ROUNDS = 20
BOT_ID = 0

HANDS = ("rock", "scissors", "paper")
HAND_LABELS = {"rock": "✊ グー", "scissors": "✌ チョキ", "paper": "✋ パー"}
BEATS = {"rock": "scissors", "scissors": "paper", "paper": "rock"}


def judge(choices: dict) -> list:
    """{user_id: 手} から勝った人のリストを返す。あいこなら空リスト。"""
    kinds = set(choices.values())
    if len(kinds) != 2:
        return []
    a, b = kinds
    win = a if BEATS[a] == b else b
    return [uid for uid, h in choices.items() if h == win]


def auto_hand(rng=random) -> str:
    """Bot（や将来の放置対策）が出す手。"""
    return rng.choice(HANDS)


# ---------------------------------------------------------------------------
# 賭け金預かり台帳（再起動時の返金用）
# ---------------------------------------------------------------------------
def escrow_path() -> Path:
    return Path(os.environ.get("JANKEN_ESCROW_PATH") or data_paths.data_path("janken_escrow.json"))


class EscrowLedger:
    """チャンネル単位で預かっている賭け金の台帳。金額が動くたびに書き出す。

    {channel_id: {"guild_id": int, "wager": int, "users": [user_id, ...]}}。
    じゃんけんの賭け金は全員同額 (g.wager) なので、預かり額は
    wager × users で表せる。変わるのは 徴収（users への追加）/
    精算・返金（消滅）だけなので、その都度書き出せば台帳は常に実態と一致する。
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else escrow_path()
        self.data = {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for ch, entry in raw.items():
                    if not isinstance(entry, dict):
                        continue
                    wager = int(entry.get("wager", 0))
                    users = [int(u) for u in entry.get("users", []) if int(u) > 0]
                    if wager > 0 and users:
                        self.data[str(ch)] = {
                            "guild_id": int(entry.get("guild_id", 0)),
                            "wager": wager,
                            "users": users,
                        }
        except FileNotFoundError:
            pass
        except Exception:
            logger.exception("janken: 預かり台帳の読み込みに失敗しました（空として開始）")

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except Exception:
            logger.exception("janken: 預かり台帳の保存に失敗しました")

    def record(self, channel_id, guild_id, wager, user_id):
        """1人分の徴収を台帳に記録する（残高減算の成功直後に同期で呼ぶ）。"""
        if wager <= 0:
            return
        entry = self.data.setdefault(str(channel_id), {
            "guild_id": int(guild_id), "wager": int(wager), "users": []})
        entry["guild_id"], entry["wager"] = int(guild_id), int(wager)
        if int(user_id) not in entry["users"]:
            entry["users"].append(int(user_id))
        self._save()

    def remove_user(self, channel_id, user_id):
        """1人分の預かりを消し込む（返金が成功した分だけ呼ぶ）。"""
        entry = self.data.get(str(channel_id))
        if not entry:
            return
        if int(user_id) in entry["users"]:
            entry["users"].remove(int(user_id))
        if not entry["users"]:
            self.data.pop(str(channel_id), None)
        self._save()

    def clear_channel(self, channel_id):
        """チャンネル分の預かりを全て消し込む（精算完了時に呼ぶ）。"""
        if self.data.pop(str(channel_id), None) is not None:
            self._save()

    def entries(self):
        """{channel_id(int): {"guild_id": int, "wager": int, "users": [int]}} のコピーを返す。"""
        return {int(ch): {"guild_id": e["guild_id"], "wager": e["wager"],
                          "users": list(e["users"])}
                for ch, e in self.data.items() if e["users"]}


class JankenGame:
    def __init__(self, channel_id: int, guild_id: int, host_id: int):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}     # user_id -> member（BOT_ID は Bot）
        self.alive: list = []
        self.choices: dict = {}     # この回の手
        self.phase = "recruit"      # recruit / choosing / done
        self.round = 0
        self.log: list = []         # 各回の結果テキスト
        self.wager = 0
        self.escrow = []
        self.last_reveal = None     # 最新の「ぽん！」表示（次で消す）

    @property
    def vs_bot(self) -> bool:
        return BOT_ID in self.players

    def name(self, uid) -> str:
        return "Bot" if uid == BOT_ID else self.players[uid].mention


class JoinView(LobbyView):
    """じゃんけんのロビー（共通規格）。参加は game.players にも同期する。"""

    def __init__(self, cog, game: JankenGame):
        self.cog, self.game = cog, game
        host = game.players.get(game.host_id)
        super().__init__(
            title="じゃんけん 参加者募集", host=host,
            min_players=1, max_players=MAX_PLAYERS,
            note=(f"{host.mention if host else ''} さんが募集中です。\n"
                  f"{recruit_join_prompt(RECRUIT_SECONDS)}\n"
                  + (f"勝敗コイン: 1人 {game.wager} AGO（勝者へ配分）\n" if game.wager else "")
                  + "だれも来なければ Bot が相手をします。"),
            timeout=RECRUIT_SECONDS + 30, join_hook=_janken_join_hook(game))

    def on_members_changed(self, interaction: discord.Interaction):
        uid = interaction.user.id
        if uid in self.players:
            self.game.players[uid] = interaction.user
        else:
            self.game.players.pop(uid, None)


def _janken_join_hook(game: JankenGame):
    """賭け金ありの対局はマネー系操作 (E-7): 逮捕中の参加を拒否する。"""
    def hook(user):
        if game.wager:
            return prison_core.block_message(str(user.id))
        return None
    return hook


class HandPanel(GamePanelView):
    """手を選ぶパネル（V2）。押した手は本人にだけ見える。公開までは何度でも変えられる。"""

    def __init__(self, game: JankenGame, title: str = "", body: str = ""):
        super().__init__(title, body, timeout=HAND_SECONDS + 30)
        self.game = game
        self.rock = discord.ui.Button(label="✊ グー", style=discord.ButtonStyle.primary)
        self.rock.callback = self._rock
        self.scissors = discord.ui.Button(label="✌ チョキ", style=discord.ButtonStyle.primary)
        self.scissors.callback = self._scissors
        self.paper = discord.ui.Button(label="✋ パー", style=discord.ButtonStyle.primary)
        self.paper.callback = self._paper
        self.add_row(self.rock, self.scissors, self.paper)

    async def _choose(self, interaction, hand: str):
        g = self.game
        if g.phase != "choosing" or interaction.user.id not in g.alive:
            return await interaction.response.send_message("いまは手を出せません。", ephemeral=True)
        g.choices[interaction.user.id] = hand
        await interaction.response.send_message(f"{HAND_LABELS[hand]} を出しました（公開まで変えられます）。",
                                                ephemeral=True)

    async def _rock(self, interaction: discord.Interaction):
        await self._choose(interaction, "rock")

    async def _scissors(self, interaction: discord.Interaction):
        await self._choose(interaction, "scissors")

    async def _paper(self, interaction: discord.Interaction):
        await self._choose(interaction, "paper")


HandView = HandPanel  # 互換名


class Janken(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> JankenGame
        self.escrow_ledger = EscrowLedger()
        self._refunded = False

    def _wallet(self):
        return self.bot.get_cog("WalletCog") if hasattr(self.bot, "get_cog") else None

    async def start_recruit(self, interaction: discord.Interaction, wager: int = 0):
        await self._refund_orphaned()
        channel = interaction.channel
        # 賭け金ありの募集開始はマネー系操作 (E-7): 逮捕中は拒否する。
        blocked = prison_core.block_message(str(interaction.user.id)) if wager else None
        if blocked:
            return await interaction.response.send_message(blocked, ephemeral=True)
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既にじゃんけんが進行中です。", color=COLOR),
                ephemeral=True)
        g = JankenGame(channel.id, interaction.guild_id, interaction.user.id)
        g.wager = max(0, min(int(wager), 500))
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"じゃんけんの募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            lobby = JoinView(self, g)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            g.players = dict(lobby.members)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    async def run_game(self, channel, g: JankenGame, rng=random):
        if len(g.players) < 2:
            g.players[BOT_ID] = None
        if g.wager and not await self._collect_wagers(g):
            await game_panels.clear(channel, "party")
            await channel.send("コインを賭けたじゃんけんを開始できませんでした（残高不足または更新エラー）。賭けコインは全額返金しました。")
            return
        g.alive = list(g.players)
        names = "、".join(g.name(uid) for uid in g.alive)
        await channel.send(view=text_panel("じゃんけん スタート！", f"参加者: {names}"))
        winners = []
        while len(g.alive) > 1 and g.round < MAX_ROUNDS:
            await self.play_round(channel, g, rng)
        if len(g.alive) == 1:
            winners = g.alive
        await self.finish(channel, g, winners)

    async def play_round(self, channel, g: JankenGame, rng=random):
        g.round += 1
        g.choices = {}
        if BOT_ID in g.alive:
            g.choices[BOT_ID] = auto_hand(rng)
        g.phase = "choosing"
        humans = [uid for uid in g.alive if uid != BOT_ID]
        await game_panels.replace(channel, "party", view=HandPanel(
            g,
            title=f"第{g.round}回 じゃん けん…",
            body=(f"{'、'.join(g.name(u) for u in g.alive)}\n"
                  f"{HAND_SECONDS}秒以内に下のボタンで手を選んでください（ほかの人には見えません）。")))
        elapsed = 0
        while elapsed < HAND_SECONDS and any(u not in g.choices for u in humans):
            await asyncio.sleep(1)
            elapsed += 1
        g.phase = "reveal"
        missing = [u for u in g.alive if u not in g.choices]
        shown = "\n".join(f"{g.name(u)}: {HAND_LABELS[h]}" for u, h in g.choices.items()) or "（だれも出しませんでした）"
        if missing:
            shown += "\n" + "\n".join(f"{g.name(u)}: {CROCK} 時間切れ（負け）" for u in missing)
        if not g.choices:
            g.alive = []
            result = "全員時間切れのため終了です。"
        elif len(g.choices) == 1:
            g.alive = list(g.choices)
            result = f"{g.name(g.alive[0])} さんだけが手を出しました。"
        else:
            won = judge(g.choices)
            if won:
                g.alive = won
                result = f"勝ち: {'、'.join(g.name(u) for u in won)}"
            else:
                g.alive = list(g.choices)
                result = "あいこ！ もう一度。" if not missing else "あいこ！ 出した人でもう一度。"
        g.log.append(f"第{g.round}回: {result}")
        # 公開表示は次の回（または終了表示）が出たら役割を終えるので、
        # 前回の分を消してから新しい分を出す（常に最新の1通だけ残る）。
        old_reveal = getattr(g, "last_reveal", None)
        if old_reveal is not None:
            await safe_delete(old_reveal)
        g.last_reveal = await channel.send(view=text_panel("ぽん！", f"{shown}\n\n**{result}**"))

    async def _collect_wagers(self, g):
        wallet = self._wallet()
        if wallet is None:
            return False
        # 二層防御 (E-7): 募集後に逮捕された参加者がいても、徴収前に
        # 全員分を再チェックする (誰からも引く前に止める)。
        for uid in g.players:
            if uid != BOT_ID and prison_core.block_message(str(uid)):
                return False
        debited = []
        for uid in g.players:
            if uid == BOT_ID:
                continue
            result = await wallet._change_balance(str(uid), -g.wager, require_funds=True)
            if result is INSUFFICIENT or result is None:
                for paid_uid in debited:
                    refunded = await wallet._change_balance(str(paid_uid), g.wager)
                    if refunded is INSUFFICIENT or refunded is None:
                        # 巻き戻しに失敗した分は台帳に残し、起動時返金で戻す。
                        logger.critical("janken: 徴収の巻き戻し返金に失敗しました。台帳に残し再起動時に返金します user=%s amount=%s", paid_uid, g.wager)
                        continue
                    self.escrow_ledger.remove_user(g.channel_id, paid_uid)
                return False
            debited.append(uid)
            # 減算が確定した直後 (他の await を挟まず) に同期で台帳へ記録する。
            # 先に台帳へ書くと減算失敗時に「預かっていない返金」が生まれるため、
            # 順序はポーカーのチップ台帳と同じく 減算 → 即時記録 とする。
            self.escrow_ledger.record(g.channel_id, g.guild_id, g.wager, uid)
        g.escrow = debited
        return True

    async def _pay_winners(self, g, winners):
        if not g.escrow:
            return
        wallet = self._wallet()
        if wallet is None:
            return
        prize = len(g.escrow) * g.wager
        recipients = [uid for uid in winners if uid in g.escrow]
        if not recipients:
            recipients = g.escrow
        each, remainder = divmod(prize, len(recipients))
        try:
            for index, uid in enumerate(recipients):
                await wallet._change_balance(str(uid), each + (1 if index < remainder else 0))
        except Exception:
            # 精算が途中で死んだら台帳を残す (二重配分を避け、残りは
            # 起動時返金の対象として手動確認できる状態にする)。
            logger.critical("janken: 精算に失敗しました。台帳に残します channel=%s", g.channel_id)
            logger.exception("janken: 精算の例外")
            return
        g.escrow = []
        self.escrow_ledger.clear_channel(g.channel_id)

    async def _refund_orphaned(self):
        """起動時: 前回の未精算の預かり金を台帳から全額返金する（初回のみ）。"""
        if self._refunded:
            return
        wallet = self._wallet()
        if wallet is None:
            return
        entries = self.escrow_ledger.entries()
        live = set(self.games)
        self._refunded = True
        for channel_id, entry in entries.items():
            if channel_id in live:
                continue
            for uid in entry["users"]:
                # 起動時返金はユーザー操作ではないため、逮捕中チェック等の
                # マネー系ブロックの対象外とする (ポーカー _refund_orphaned と同じ)。
                try:
                    result = await wallet._change_balance(str(uid), entry["wager"])
                    if result is None or result is INSUFFICIENT:
                        logger.critical("janken: 未精算の預かり金の返金に失敗しました。手動対応が必要です user=%s amount=%s", uid, entry["wager"])
                        continue
                    self.escrow_ledger.remove_user(channel_id, uid)
                    logger.info("janken: 未精算の預かり金を返金しました user=%s amount=%s", uid, entry["wager"])
                except Exception:
                    logger.exception("janken: 未精算の預かり金の返金で例外 user=%s", uid)

    @commands.Cog.listener()
    async def on_ready(self):
        await self._refund_orphaned()

    async def finish(self, channel, g: JankenGame, winners: list):
        g.phase = "done"
        await self._pay_winners(g, winners)
        humans = [u for u in g.players if u != BOT_ID]
        if len(humans) >= 2:
            for uid in winners:
                await party_ranking.shared().record_win(g.guild_id, uid, GAME_ID)
        if winners:
            text = f"🏆 勝者: {g.name(winners[0])}"
            if g.vs_bot:
                text += "（Bot 戦はランキングに数えません）"
        else:
            text = "勝者なし" if g.round < MAX_ROUNDS or not g.alive else f"{MAX_ROUNDS}回あいこが続いたので引き分けです。"
        lines = [text, "", "経過:", "\n".join(g.log)[-3900:] or "（なし）"]
        if g.wager:
            lines += ["", "勝敗コイン: " + (f"各人 {g.wager} AGO を預かり、勝者へ配分しました。" if winners else "勝者がいないため、預かり分は参加者へ返金しました。")]
        # 手選択パネルと最後の公開表示を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        old_reveal = getattr(g, "last_reveal", None)
        if old_reveal is not None:
            g.last_reveal = None
            await safe_delete(old_reveal)
        await channel.send(view=text_panel("じゃんけん 終了", "\n".join(lines)))


async def setup(bot):
    await bot.add_cog(Janken(bot))
