# -*- coding: utf-8 -*-
"""「めんどうパス」（Cockroach Poker 系の押し付け合いブラフゲーム）。

AGO読み替え: 害虫カードを「めんどうな用事」カード（宿題・残業など）に変更。
盤面表現: 状態は「各人の手札枚数・場のカード・いま回っている宣言」だけで
空間性がないため V2 構造化テキスト（判断は実装ログ参照）。手札と回ってきた
カードの中身は ephemeral でのみ表示する。
進行はセッションメッセージ1通を編集し続ける方式（レビュー対応 2026-11-06:
判定結果もパネル内の「直近の判定」に集約し、ゲーム中の新規投稿はしない）。
配布は1人5枚に絞って短縮した（山の残りは使わない）。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core.game.game import party_ranking
from core.game.game.game_v2 import GamePanelView, text_panel
from core.game.mendou.mendou import KINDS, MendouGame

logger = logging.getLogger(__name__)

party_ranking.register("mendou")

GAME_ID = "mendou"
RECRUIT_SECONDS = 60
MIN_PLAYERS = 2
MAX_PLAYERS = 6


def labels(game: MendouGame) -> dict[int, str]:
    return {uid: f"プレイヤー{i + 1}" for i, uid in enumerate(game.players)}


def status_text(game: MendouGame) -> str:
    names = labels(game)
    lines = []
    for uid in game.players:
        front = "、".join(f"{k}×{n}" for k, n in game.fronts[uid].items() if n > 0)
        lines.append(f"{names[uid]} <@{uid}>: 手札{game.hand_size(uid)}枚／場: {front or 'なし'}")
    if game.last_result is not None:
        r = game.last_result
        truth_text = "本当" if r["truth"] else "嘘"
        guess_text = "見抜きました！" if r["guessed_right"] else "騙されました…"
        lines.append(f"\n直近の判定: カードは『{r['card']}』、宣言は{truth_text}でした。{guess_text}"
                     f"{names[r['taker']]} <@{r['taker']}> が引き取りました。")
    if game.chain_active:
        lines.append(f"\n{names[game.passer]} <@{game.passer}> が {names[game.holder]} <@{game.holder}> に"
                     f"「これは『{game.declaration}』だ」と言ってカードを渡しました。")
    elif not game.finished:
        lines.append(f"\n次にカードを渡すのは {names[game.starter]} <@{game.starter}> です。")
    return "\n".join(lines)


class PassView(discord.ui.View):
    """カードを渡す/回すときの選択（本人 ephemeral）。"""

    def __init__(self, cog, game: MendouGame, mode: str):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.mode = mode  # "start"（チェーン開始） or "pass"（回す）
        self.kind: str | None = None
        self.target: int | None = None
        self.declaration: str | None = None
        names = labels(game)
        actor = game.starter if mode == "start" else game.holder

        if mode == "start":
            kind_options = [discord.SelectOption(label=f"{k}（{n}枚）", value=k)
                            for k, n in game.hands[actor].items() if n > 0]
            kind_select = discord.ui.Select(placeholder="出すカード", options=kind_options)

            async def on_kind(inter: discord.Interaction):
                self.kind = kind_select.values[0]
                await inter.response.send_message(f"出すカード: {self.kind}", ephemeral=True)

            kind_select.callback = on_kind
            self.add_item(kind_select)
            targets = [uid for uid in game.players if uid != actor]
        else:
            targets = game.pass_targets(actor)

        target_options = [discord.SelectOption(label=names[uid], value=str(uid)) for uid in targets]
        target_select = discord.ui.Select(placeholder="渡す相手", options=target_options)

        async def on_target(inter: discord.Interaction):
            self.target = int(target_select.values[0])
            await inter.response.send_message("相手を選びました。", ephemeral=True)

        target_select.callback = on_target
        self.add_item(target_select)

        decl_select = discord.ui.Select(
            placeholder="宣言する用事",
            options=[discord.SelectOption(label=k, value=k) for k in KINDS])

        async def on_decl(inter: discord.Interaction):
            self.declaration = decl_select.values[0]
            await inter.response.send_message(f"宣言: 『{self.declaration}』", ephemeral=True)

        decl_select.callback = on_decl
        self.add_item(decl_select)

        confirm = discord.ui.Button(label="渡す", style=discord.ButtonStyle.success)

        async def on_confirm(inter: discord.Interaction):
            if self.target is None or self.declaration is None or (mode == "start" and self.kind is None):
                return await inter.response.send_message("選択が不足しています。", ephemeral=True)
            if mode == "start":
                await cog.apply_start(inter, game, self.kind, self.target, self.declaration)
            else:
                await cog.apply_pass_on(inter, game, self.target, self.declaration)

        confirm.callback = on_confirm
        self.add_item(confirm)


class Mendou(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, MendouGame | None] = {}
        self.messages: dict[int, discord.Message] = {}

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}

        panel = GamePanelView("📨 めんどうパス 参加者募集",
                              f"めんどうな用事カードを嘘で押し付け合うゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"めんどうな用事カードを嘘で押し付け合うゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                                   f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n"
                                   f"参加者（{len(players)}名）: " + " ".join(f"<@{p}>" for p in players))
            await inter.response.edit_message(view=panel)

        async def on_start(inter: discord.Interaction):
            if inter.user.id != players[0]:
                return await inter.response.send_message("開始できるのはホストだけです。", ephemeral=True)
            state["started"] = True
            await inter.response.send_message("開始します！", ephemeral=True)

        join_btn = discord.ui.Button(label="参加する", style=discord.ButtonStyle.success)
        join_btn.callback = on_join
        start_btn = discord.ui.Button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
        start_btn.callback = on_start
        panel.add_row(join_btn, start_btn)
        await interaction.response.send_message(view=panel)
        asyncio.create_task(self._run(channel, players, state))

    async def _run(self, channel, players: list[int], state: dict):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if state["started"]:
                    break
                await asyncio.sleep(0.5)
            players = list(dict.fromkeys(players))
            if len(players) < MIN_PLAYERS:
                await channel.send(view=text_panel("めんどうパス", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = MendouGame(players)
            self.channels[channel.id] = game
            self.messages[channel.id] = await channel.send(view=self._panel(game))
            while not game.finished:
                await asyncio.sleep(1.0)
            await self._refresh(channel, game)
            winners = " ".join(f"<@{p}>" for p in game.winners)
            reason = ""
            if game.loser is not None and max(game.fronts[game.loser].values(), default=0) < 4:
                reason = "（手札が無くなったため）"
            await channel.send(view=text_panel(
                "🏆 めんどうパス 結果",
                f"<@{game.loser}> の負けです{reason}。勝者: {winners}\n" + status_text(game)))
            guild = getattr(channel, "guild", None)
            if guild is not None:
                for uid in game.winners:
                    await party_ranking.shared().record_win(guild.id, uid, GAME_ID)
        except Exception:  # noqa: BLE001
            logger.exception("Mendou: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    # ------------------------------------------------------------------ パネル
    def _panel(self, game: MendouGame) -> GamePanelView:
        panel = GamePanelView("📨 めんどうパス", status_text(game))

        async def on_hand(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.players:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            hand = "、".join(f"{k}×{n}" for k, n in game.hands[uid].items() if n > 0)
            await inter.response.send_message(
                view=GamePanelView("あなたの手札", hand or "（なし）"), ephemeral=True)

        async def on_pass(inter: discord.Interaction):
            if game.chain_active or inter.user.id != game.starter:
                return await inter.response.send_message("いまカードを渡せるのは開始者だけです。", ephemeral=True)
            await inter.response.send_message(view=PassView(self, game, "start"), ephemeral=True)

        async def on_peek(inter: discord.Interaction):
            card = game.peek(inter.user.id)
            if card is None:
                return await inter.response.send_message("いま中身を見られるカードはありません。", ephemeral=True)
            await inter.response.send_message(
                view=GamePanelView("カードの中身", f"本当は **『{card}』** です。"), ephemeral=True)

        async def on_accept_true(inter: discord.Interaction):
            await self.apply_accept(inter, game, True)

        async def on_accept_false(inter: discord.Interaction):
            await self.apply_accept(inter, game, False)

        async def on_pass_on(inter: discord.Interaction):
            if not game.chain_active or inter.user.id != game.holder:
                return await inter.response.send_message("いま回せるのは渡された人だけです。", ephemeral=True)
            if game.must_accept():
                return await inter.response.send_message("全員が一度持ったカードなので、回せません。引き取ってください。", ephemeral=True)
            await inter.response.send_message(view=PassView(self, game, "pass"), ephemeral=True)

        hand_btn = discord.ui.Button(label="手札を見る", style=discord.ButtonStyle.secondary)
        hand_btn.callback = on_hand
        pass_btn = discord.ui.Button(label="カードを渡す", style=discord.ButtonStyle.success)
        pass_btn.callback = on_pass
        panel.add_row(hand_btn, pass_btn)
        if game.chain_active:
            peek_btn = discord.ui.Button(label="中身を見る", style=discord.ButtonStyle.secondary)
            peek_btn.callback = on_peek
            true_btn = discord.ui.Button(label="本当だと思う", style=discord.ButtonStyle.primary)
            true_btn.callback = on_accept_true
            false_btn = discord.ui.Button(label="嘘だと思う", style=discord.ButtonStyle.primary)
            false_btn.callback = on_accept_false
            passon_btn = discord.ui.Button(label="回す", style=discord.ButtonStyle.success)
            passon_btn.callback = on_pass_on
            panel.add_row(peek_btn, true_btn, false_btn, passon_btn)
        return panel

    async def _refresh(self, channel, game: MendouGame):
        msg = self.messages.get(channel.id)
        if msg is not None:
            try:
                await msg.edit(view=self._panel(game))
            except Exception:  # noqa: BLE001
                logger.debug("Mendou: パネル更新に失敗", exc_info=True)

    # ------------------------------------------------------------------ 行動適用
    async def apply_start(self, interaction: discord.Interaction, game: MendouGame,
                          kind: str, target: int, declaration: str):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        if not game.start_chain(interaction.user.id, kind, target, declaration):
            return await interaction.response.send_message("渡せませんでした。", ephemeral=True)
        await interaction.response.send_message("カードを渡しました。", ephemeral=True)
        await self._refresh(interaction.channel, game)

    async def apply_pass_on(self, interaction: discord.Interaction, game: MendouGame,
                            target: int, declaration: str):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        if not game.pass_on(interaction.user.id, target, declaration):
            return await interaction.response.send_message("回せませんでした。", ephemeral=True)
        await interaction.response.send_message("カードを回しました。", ephemeral=True)
        await self._refresh(interaction.channel, game)

    async def apply_accept(self, interaction: discord.Interaction, game: MendouGame, guess_true: bool):
        if self.channels.get(interaction.channel.id) is not game or game.finished:
            return await interaction.response.send_message("このゲームは終了しています。", ephemeral=True)
        result = game.accept(interaction.user.id, guess_true)
        if result is None:
            return await interaction.response.send_message("いま引き取れるのは渡された人だけです。", ephemeral=True)
        await interaction.response.send_message("判定します！", ephemeral=True)
        # ログ流れ対策（レビュー対応 2026-11-06）: 判定結果は新規メッセージを
        # 投稿せず、セッションメッセージ（status_text の「直近の判定」）の
        # 編集だけで伝える。開始者が手札なしで負ける場合も同様で、
        # 終了通知は _run 側の結果メッセージが担う。
        if not game.finished:
            # 次の開始者が手札を持っていなければ、その人の負けで終了する
            game.check_starter_can_play()
        await self._refresh(interaction.channel, game)


async def setup(bot):
    await bot.add_cog(Mendou(bot))
