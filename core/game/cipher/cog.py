# -*- coding: utf-8 -*-
"""「暗号バトル」（Decrypto 系の2チーム対抗ワードゲーム）。

盤面表現: ヒント履歴とトークンは蓄積するテキスト情報で、空間的な盤面では
ないため V2 構造化テキストで表示する（判断は実装ログ参照）。
秘匿: 合言葉はチーム内だけ ephemeral で見せ、コードは暗号担当のモーダルに
だけ出す。回答（傍受/解読）は ephemeral のコードセレクトで行う。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core.game.game import party_ranking
from core.game.cipher.cipher import ALL_CODES, MAX_ROUNDS, WORDS, CipherGame, code_label
from core.game.game.game_v2 import GamePanelView, text_panel, lobby_auto_start_text, lobby_not_enough_text

logger = logging.getLogger(__name__)

party_ranking.register("cipher")

GAME_ID = "cipher"
RECRUIT_SECONDS = 60
HINT_SECONDS = 150
GUESS_SECONDS = 120
MIN_PLAYERS = 4
MAX_PLAYERS = 8
TEAM_NAMES = ("🔴 レッド", "🔵 ブルー")


def history_text(game: CipherGame) -> str:
    """両チームの公開ヒント履歴（番号ごとの蓄積）とトークン状況。"""
    lines = []
    for team in (0, 1):
        slots = game.hints_by_slot(team)
        lines.append(f"**{TEAM_NAMES[team]}チーム**（傍受 {game.intercept_tokens[team]}・失敗 {game.miscom_tokens[team]}）")
        for digit in (1, 2, 3, 4):
            hints = slots[digit]
            lines.append(f"　{digit}番: " + ("、".join(f"「{h}」" for h in hints) if hints else "―"))
    return "\n".join(lines)


class HintModal(discord.ui.Modal, title="暗号を作る"):
    def __init__(self, cog, game: CipherGame, team: int):
        super().__init__()
        self.cog = cog
        self.game = game
        self.team = team
        self.inputs = []
        code = game.codes[team]
        for pos, digit in enumerate(code):
            word = game.keywords[team][digit - 1]
            field = discord.ui.TextInput(
                label=f"{pos + 1}つ目: {digit}番「{word}」のヒント"[:45],
                max_length=30, placeholder="連想させる言葉")
            self.inputs.append(field)
            self.add_item(field)

    async def on_submit(self, interaction: discord.Interaction):
        hints = [str(f.value) for f in self.inputs]
        if self.game.submit_hints(self.team, interaction.user.id, hints):
            await interaction.response.send_message("ヒントを受け付けました。", ephemeral=True)
        else:
            await interaction.response.send_message("受け付けできませんでした。", ephemeral=True)


class CodeSelectView(discord.ui.View):
    """傍受/解読コードの選択（本人 ephemeral、24通りの順列セレクト）。"""

    def __init__(self, cog, game: CipherGame, team: int, kind: str):
        super().__init__(timeout=60)
        self.cog = cog
        self.game = game
        self.team = team
        self.kind = kind
        options = [discord.SelectOption(label=code_label(c), value=code_label(c)) for c in ALL_CODES]
        select = discord.ui.Select(
            placeholder="相手のコード（傍受）" if kind == "intercept" else "自チームのコード（解読）",
            options=options)

        async def on_pick(inter: discord.Interaction):
            code = tuple(int(d) for d in select.values[0].split("-"))
            if kind == "intercept":
                ok = game.submit_intercept(team, inter.user.id, code)
            else:
                ok = game.submit_decode(team, inter.user.id, code)
            await inter.response.send_message(
                "受け付けました。" if ok else "受け付けできませんでした（提出済み・対象外など）。",
                ephemeral=True)

        select.callback = on_pick
        self.add_item(select)


class Cipher(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, CipherGame | None] = {}

    # ------------------------------------------------------------------ 募集
    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}

        panel = GamePanelView("🔐 暗号バトル 参加者募集",
                              f"合言葉へのヒントで暗号を伝え合う2チーム対抗ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"{lobby_auto_start_text(RECRUIT_SECONDS)}\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"合言葉へのヒントで暗号を伝え合う2チーム対抗ゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                                   f"{lobby_auto_start_text(RECRUIT_SECONDS)}\n"
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
                await channel.send(view=text_panel("暗号バトル", f"{lobby_not_enough_text(MIN_PLAYERS)}"))
                return
            teams = [players[0::2], players[1::2]]
            sampled = random.sample(WORDS, 8)
            game = CipherGame(teams, {0: sampled[:4], 1: sampled[4:]})
            self.channels[channel.id] = game
            team_lines = "\n".join(
                f"{TEAM_NAMES[i]}チーム: " + " ".join(f"<@{p}>" for p in team)
                for i, team in enumerate(teams))
            await channel.send(view=text_panel(
                "🔐 暗号バトル 開始",
                team_lines + "\n「自チームの合言葉」で自分のチームの合言葉を確認してください。合言葉は相手チームには秘密です。"))
            await self._play(channel, game)
            await self._finish(channel, game)
        except Exception:  # noqa: BLE001
            logger.exception("Cipher: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)

    # ------------------------------------------------------------------ 進行
    def _keywords_button(self, game: CipherGame) -> discord.ui.Button:
        async def on_keywords(inter: discord.Interaction):
            team = game.team_of(inter.user.id)
            if team is None:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            words = "\n".join(f"{i + 1}番: **{w}**" for i, w in enumerate(game.keywords[team]))
            await inter.response.send_message(
                view=GamePanelView(f"{TEAM_NAMES[team]}チームの合言葉", words), ephemeral=True)

        btn = discord.ui.Button(label="自チームの合言葉", style=discord.ButtonStyle.secondary)
        btn.callback = on_keywords
        return btn

    async def _play(self, channel, game: CipherGame):
        while not game.finished:
            if not game.start_round():
                break
            number = game.round_index + 1
            # ---- ヒントフェーズ
            panel = GamePanelView(
                f"第{number}ラウンド / {MAX_ROUNDS} ヒント作成",
                history_text(game) + "\n\n"
                f"暗号担当は {TEAM_NAMES[0]}: <@{game.encryptor(0)}>、{TEAM_NAMES[1]}: <@{game.encryptor(1)}> です。\n"
                f"暗号担当は「暗号を作る」からコードを確認し、ヒントを3つ入力してください（{HINT_SECONDS}秒）。")

            async def on_create(inter: discord.Interaction):
                team = game.team_of(inter.user.id)
                if team is None or inter.user.id != game.encryptor(team):
                    return await inter.response.send_message("暗号を作れるのは暗号担当だけです。", ephemeral=True)
                if team in game.hints:
                    return await inter.response.send_message("すでにヒント済みです。", ephemeral=True)
                await inter.response.send_modal(HintModal(self, game, team))

            create_btn = discord.ui.Button(label="暗号を作る", style=discord.ButtonStyle.primary)
            create_btn.callback = on_create
            panel.add_row(self._keywords_button(game), create_btn)
            await channel.send(view=panel)
            for _ in range(HINT_SECONDS * 2):
                if game.all_hints_in():
                    break
                await asyncio.sleep(0.5)
            hint_timeout = not game.all_hints_in()
            if hint_timeout:
                # 時間切れのチームはヒントなしで回答フェーズへ（解読はほぼ不可能＝実質失敗扱い）
                for team in (0, 1):
                    if team not in game.hints:
                        game.hints[team] = ["（時間切れ）", "（時間切れ）", "（時間切れ）"]
                game.phase = "guesses"
            # ---- 回答フェーズ
            hint_lines = []
            for team in (0, 1):
                hint_lines.append(f"{TEAM_NAMES[team]}のヒント: " + "、".join(f"「{h}」" for h in game.hints[team]))
            panel = GamePanelView(
                f"第{number}ラウンド 回答フェーズ",
                "\n".join(hint_lines) + "\n\n"
                + ("" if game.round_index > 0 else "初ラウンドは傍受がありません。")
                + f"各チームはコードを回答してください（{GUESS_SECONDS}秒）。チームの誰か1人の回答で確定します。")

            async def on_intercept(inter: discord.Interaction):
                team = game.team_of(inter.user.id)
                if team is None:
                    return await inter.response.send_message("参加者だけが回答できます。", ephemeral=True)
                if game.round_index <= 0:
                    return await inter.response.send_message("初ラウンドは傍受がありません。", ephemeral=True)
                await inter.response.send_message(
                    view=CodeSelectView(self, game, team, "intercept"), ephemeral=True)

            async def on_decode(inter: discord.Interaction):
                team = game.team_of(inter.user.id)
                if team is None:
                    return await inter.response.send_message("参加者だけが回答できます。", ephemeral=True)
                await inter.response.send_message(
                    view=CodeSelectView(self, game, team, "decode"), ephemeral=True)

            intercept_btn = discord.ui.Button(label="傍受コードを選ぶ", style=discord.ButtonStyle.primary)
            intercept_btn.callback = on_intercept
            decode_btn = discord.ui.Button(label="解読コードを選ぶ", style=discord.ButtonStyle.success)
            decode_btn.callback = on_decode
            panel.add_row(self._keywords_button(game), intercept_btn, decode_btn)
            await channel.send(view=panel)
            for _ in range(GUESS_SECONDS * 2):
                if game.guesses_complete():
                    break
                await asyncio.sleep(0.5)
            events = game.resolve_round()
            await self._announce_round(channel, game, events, hint_timeout=hint_timeout)
            await asyncio.sleep(3)

    async def _announce_round(self, channel, game: CipherGame, events: dict, hint_timeout: bool = False):
        lines = []
        if hint_timeout:
            lines.append("⏰ ヒント作成で時間切れがありました（そのチームのヒントは空欄で進みました）。")
        for team in (0, 1):
            ev = events.get(team, {})
            code = game.history[team][-1]["code"] if game.history[team] else game.codes.get(team)
            lines.append(
                f"{TEAM_NAMES[team]}のコードは **{code_label(code)}** でした。"
                f"解読: {'✅ 成功' if ev.get('decoded') else '❌ 失敗'}／"
                f"傍受: {'😱 された' if ev.get('intercepted') else 'されなかった'}")
        lines.append(f"現在: {TEAM_NAMES[0]} 傍受{game.intercept_tokens[0]}・失敗{game.miscom_tokens[0]}"
                     f" ／ {TEAM_NAMES[1]} 傍受{game.intercept_tokens[1]}・失敗{game.miscom_tokens[1]}")
        await channel.send(view=text_panel(f"第{game.round_index + 1}ラウンド 結果", "\n".join(lines)))

    async def _finish(self, channel, game: CipherGame):
        if game.winner is None:
            return
        if game.winner == -1:
            body = "引き分けでした。\n" + history_text(game)
        else:
            winners = game.teams[game.winner]
            body = (f"勝者は **{TEAM_NAMES[game.winner]}チーム** です！\n"
                    + "勝者: " + " ".join(f"<@{p}>" for p in winners) + "\n\n" + history_text(game)
                    + "\n\n合言葉の答え合わせ:\n"
                    + "\n".join(f"{TEAM_NAMES[i]}: " + "、".join(f"{j + 1}番「{w}」" for j, w in enumerate(game.keywords[i]))
                                for i in (0, 1)))
            guild = getattr(channel, "guild", None)
            if guild is not None:
                for uid in winners:
                    await party_ranking.shared().record_win(guild.id, uid, GAME_ID)
        await channel.send(view=text_panel("🏆 暗号バトル 結果", body))


async def setup(bot):
    await bot.add_cog(Cipher(bot))
