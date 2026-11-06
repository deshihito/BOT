import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.emojis import AGOMUNIMUNI, FAILED, LOADING, MASAI, MUSIC, REIBAI, SUCCESS, URANAI
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core.game import autoplay
from core.game import jinrou_review
from core.game import party_ranking
import math
import config

from core.game.jinrou.common import *  # noqa: F401,F403 - shared constants/helpers
from core.game.jinrou.common import reibai_color, uranai_color  # noqa: F401
from core.game.jinrou.game import JinrouGame  # noqa: F401
from core.game.jinrou.helpers import _get_display_role  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


class SetupView(discord.ui.View):
    """起動時エフェメラル設定パネル：モード選択と必須役職選定の第一段階"""
    # 基本職のみを配置（アホを追加）
    BASE_ROLES = [
        "一般通過あごむに", "占い師", "騎士", "霊媒師", "パン屋", "マサイ族",
        "入狼", "議長", "ビー玉ブレイカー", "陽キャ", "狂人", "ハゲ", "メンヘラ", "あごむに破道砲", "アホ"
    ]
    # 除外候補は全役職
    ALL_ROLES = BASE_ROLES + ["タフむに", "大霊媒師", "罠師", "ミュージシャン", "デカ狼", "狂信者", "コウモリむに", "ワンころ", "もくもく", "ネット民", "ヤンデレ"]

    def __init__(self, game, cog, channel):
        super().__init__(timeout=120)
        self.game = game
        self.cog = cog
        self.channel = channel

        # モード選択セレクト
        mode_sel = discord.ui.Select(
            placeholder="ゲームモードを選択（デフォルト: プロ）",
            options=[
                discord.SelectOption(label="ベーシック（発展職なし）", value="ベーシック"),
                discord.SelectOption(label="プロ（従来の発展職あり）", value="プロ")
            ],
            min_values=1, max_values=1, row=0
        )
        mode_sel.callback = self._mode_callback
        self.add_item(mode_sel)

        # 必須基本職セレクト
        req_sel = discord.ui.Select(
            placeholder="必須の【基本職】を選択（最大4つ）",
            options=[discord.SelectOption(label=r, value=r) for r in self.BASE_ROLES],
            min_values=0, max_values=4, row=1
        )
        req_sel.callback = self._req_callback
        self.add_item(req_sel)

        # 除外役職セレクト（全26役職を 25 件上限に収めるため 2 つに分割する）
        self._exc_values_a: list = []
        self._exc_values_b: list = []
        exc_sel = discord.ui.Select(
            placeholder="除外役職を選択（1/2・合計最大4つ）",
            options=[discord.SelectOption(label=r, value=r) for r in self.ALL_ROLES[:13]],
            min_values=0, max_values=4, row=2
        )
        exc_sel.callback = self._exc_callback_a
        self.add_item(exc_sel)
        exc_sel2 = discord.ui.Select(
            placeholder="除外役職を選択（2/2・合計最大4つ）",
            options=[discord.SelectOption(label=r, value=r) for r in self.ALL_ROLES[13:]],
            min_values=0, max_values=4, row=3
        )
        exc_sel2.callback = self._exc_callback_b
        self.add_item(exc_sel2)

    async def _mode_callback(self, interaction: discord.Interaction):
        self.game.game_mode = interaction.data.get("values", ["プロ"])[0]
        await interaction.response.defer()

    async def _req_callback(self, interaction: discord.Interaction):
        self.game.required_roles = list(interaction.data.get("values", []))
        await interaction.response.defer()

    def _sync_excluded_roles(self):
        merged = list(self._exc_values_a) + [r for r in self._exc_values_b if r not in self._exc_values_a]
        self.game.excluded_roles = merged[:4]

    async def _exc_callback_a(self, interaction: discord.Interaction):
        self._exc_values_a = list(interaction.data.get("values", []))
        self._sync_excluded_roles()
        await interaction.response.defer()

    async def _exc_callback_b(self, interaction: discord.Interaction):
        self._exc_values_b = list(interaction.data.get("values", []))
        self._sync_excluded_roles()
        await interaction.response.defer()

    # 後方互換: 単一セレクト時代の名前で呼ばれた場合は A 側として扱う
    async def _exc_callback(self, interaction: discord.Interaction):
        await self._exc_callback_a(interaction)

    @discord.ui.button(label="次へ進む", style=discord.ButtonStyle.primary, row=4)
    async def next_step(self, interaction: discord.Interaction, button: discord.ui.Button):
        # ベーシックモード、または既に4枠埋まっている場合は発展職指定をスキップして確定へ
        if self.game.game_mode == "ベーシック" or len(self.game.required_roles) >= 4:
            self.stop()
            await self._finalize_setup(interaction)
        else:
            # 発展職専用の選択パネルへ移行
            self.stop()
            next_view = AdvancedSetupView(self.game, self.cog, self.channel)
            embed = discord.Embed(
                title="人狼ゲーム設定 (2/2)",
                description=f"現在の指定数: {len(self.game.required_roles)}/4\n残りの枠で必須とする【発展職】を選んでください。",
                color=0xFFFFFF
            )
            await interaction.response.edit_message(embed=embed, view=next_view)

    async def _finalize_setup(self, interaction: discord.Interaction):
        req_str = "、".join(self.game.required_roles) if self.game.required_roles else "なし"
        exc_str = "、".join(self.game.excluded_roles) if self.game.excluded_roles else "なし"
        await interaction.response.edit_message(
            embed=discord.Embed(
                description=f"設定完了（モード: **{self.game.game_mode}**）\n必須: **{req_str}**\n除外: **{exc_str}**",
                color=0xFFFFFF
            ),
            view=None
        )
        view = RecruitView(self.game, self.cog)
        req_str2 = f" 【必須: {req_str}】" if self.game.required_roles else ""
        await game_panels.replace(self.channel, "party",
            f"{LOADING}人狼ゲーム募集開始！ モード:【{self.game.game_mode}】{req_str2}",
            view=view
        )

    async def on_timeout(self):
        self.game.is_running = False


class AdvancedSetupView(discord.ui.View):
    """プロモード専用の必須発展職選定パネル（第二段階）"""
    ADV_ROLES = [
        "タフむに", "大霊媒師", "罠師", "ミュージシャン", "デカ狼", "狂信者", "コウモリむに", "ワンころ", "もくもく", "ネット民", "ヤンデレ"
    ]

    def __init__(self, game, cog, channel):
        # 残り指定可能枠数を計算
        max_selectable = 4 - len(game.required_roles)
        super().__init__(timeout=120)
        self.game = game
        self.cog = cog
        self.channel = channel

        if max_selectable > 0:
            adv_sel = discord.ui.Select(
                placeholder=f"必須の【発展職】を選択（最大{max_selectable}つ）",
                options=[discord.SelectOption(label=r, value=r) for r in self.ADV_ROLES],
                min_values=0, max_values=max_selectable, row=0
            )
            adv_sel.callback = self._adv_callback
            self.add_item(adv_sel)

    async def _adv_callback(self, interaction: discord.Interaction):
        selected = list(interaction.data.get("values", []))
        # 既存の選択リストにマージ
        self.game.required_roles.extend(selected)
        await interaction.response.defer()

    @discord.ui.button(label="確定してパネルを送信", style=discord.ButtonStyle.success, row=1)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        self.stop()
        # SetupViewの確定ロジックと共通の処理
        req_str = "、".join(self.game.required_roles) if self.game.required_roles else "なし"
        exc_str = "、".join(self.game.excluded_roles) if self.game.excluded_roles else "なし"
        await interaction.response.edit_message(
            embed=discord.Embed(
                description=f"設定完了（モード: **{self.game.game_mode}**）\n必須: **{req_str}**\n除外: **{exc_str}**",
                color=0xFFFFFF
            ),
            view=None
        )
        view = RecruitView(self.game, self.cog)
        req_str2 = f" 【必須: {req_str}】" if self.game.required_roles else ""
        await game_panels.replace(self.channel, "party",
            f"{LOADING}人狼ゲーム募集開始！ モード:【{self.game.game_mode}】{req_str2}",
            view=view
        )

    async def on_timeout(self):
        self.game.is_running = False


class RecruitView(discord.ui.View):
    def __init__(self, game, cog):
        super().__init__(timeout=None)
        self.game = game
        self.cog = cog

    @discord.ui.button(label="参加する", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user in self.game.players:
            embed = discord.Embed(description="既に参加しています。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if len(self.game.players) >= MAX_PLAYERS:
            embed = discord.Embed(description=f"定員（{MAX_PLAYERS}人）に達しました。これ以上参加できません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        self.game.players.append(interaction.user)
        await interaction.response.send_message(
            f"{AGOMUNIMUNI}{interaction.user.display_name} さんが参加しました。"
        )

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.danger)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user not in self.game.players:
            embed = discord.Embed(description="参加していません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        self.game.players.remove(interaction.user)
        await interaction.response.send_message(
            f"{interaction.user.display_name} さんが参加をキャンセルしました。"
        )

    @discord.ui.button(label="スタート", style=discord.ButtonStyle.primary)
    async def start(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.game.host_id:
            embed = discord.Embed(description="スタートできるのはゲームを起動した人のみです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        self.stop()
        await interaction.response.send_message("ゲームを開始します！")
        asyncio.create_task(self.cog._start_game_loop(self.game, self.game.game_channel))


class ReplayView(discord.ui.View):
    """最終役職開示後の再戦ボタン"""
    def __init__(self, game, cog):
        super().__init__(timeout=300)
        self.game = game
        self.cog = cog

    @discord.ui.button(label="再戦", style=discord.ButtonStyle.primary)
    async def replay(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.game.host_id:
            embed = discord.Embed(description="再戦を開始できるのはゲームを起動した人のみです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        channel = interaction.channel
        current = self.cog.games.get(channel.id)
        if current is not None and current is not self.game and current.is_running:
            embed = discord.Embed(description="このチャンネルでは既に別のゲームが進行中です。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        old_required = self.game.required_roles[:]
        old_excluded = self.game.excluded_roles[:]
        host_id = self.game.host_id

        new_game = JinrouGame()
        new_game.is_running = True
        new_game.host_id = host_id
        new_game.game_channel = channel
        new_game._original_channel = channel
        new_game.game_mode = self.game.game_mode  # 前回と同じモードで再戦する
        new_game.required_roles = old_required
        new_game.excluded_roles = old_excluded
        self.cog.games[channel.id] = new_game

        self.stop()
        req_str = "、".join(old_required) if old_required else "なし"
        exc_str = "、".join(old_excluded) if old_excluded else "なし"
        await interaction.response.send_message(
            f"{LOADING}再戦開始！ モード:【{new_game.game_mode}】 必須: {req_str} / 除外: {exc_str}",
            view=RecruitView(new_game, self.cog)
        )


class GlobalChannelProxy:
    def __init__(self, game):
        self.game = game

    def __getattr__(self, name):
        return getattr(self.game._original_channel, name)

    async def send(self, *args, **kwargs):
        # 追加：デフォルトでメンションを無効化
        if "allowed_mentions" not in kwargs:
            kwargs["allowed_mentions"] = discord.AllowedMentions.none()

        if getattr(self.game, "is_global", False):
            res = None
            for chan in self.game.channels:
                try:
                    msg = await chan.send(*args, **kwargs)
                    if chan.id == self.game._original_channel.id:
                        res = msg
                except Exception:
                    logger.debug("人狼: グローバルチャンネルへの送信に失敗しました", exc_info=True)
            return res
        else:
            return await self.game._original_channel.send(*args, **kwargs)


class GlobalJoinView(discord.ui.View):
    """グローバル人狼の合流パネル。別サーバーで募集中のゲームに、このチャンネルから参加する。"""
    def __init__(self, cog, game):
        super().__init__(timeout=None)
        self.cog = cog
        self.game = game

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        game = self.game
        # 合流したあとに新しいグローバルゲームへ入れ替わっていたら、そちらは別のパネルから参加してもらう
        if self.cog.games.get("global") is not game or not game.is_running:
            return await interaction.response.send_message("このグローバル人狼の募集は終わりました。", ephemeral=True)
        if game.started:
            return await interaction.response.send_message("ゲームが既に進行中のため、途中参加できません。", ephemeral=True)
        if any(p.id == interaction.user.id for p in game.players):
            return await interaction.response.send_message("既にゲームに参加しています。", ephemeral=True)
        if len(game.players) >= MAX_PLAYERS:
            return await interaction.response.send_message(f"定員（{MAX_PLAYERS}人）に達しました。これ以上参加できません。", ephemeral=True)
        if interaction.channel is not None and all(c.id != interaction.channel.id for c in game.channels):
            game.channels.append(interaction.channel)
        game.players.append(interaction.user)
        # 参加の知らせは、元のサーバーを含む全チャンネルに届ける
        await interaction.response.send_message(f"{interaction.user.display_name} さんが参加しました。")
        for chan in [c for c in game.channels if interaction.channel is None or c.id != interaction.channel.id]:
            try:
                await chan.send(f"{AGOMUNIMUNI}{interaction.user.display_name} さんが別のサーバーから参加しました。",
                                allowed_mentions=discord.AllowedMentions.none())
            except discord.HTTPException:
                logger.debug("人狼: 参加通知の送信に失敗しました", exc_info=True)


class RoleCheckView(discord.ui.View):
    def __init__(self, game, cog):
        super().__init__(timeout=None)
        self.game, self.cog = game, cog

    @discord.ui.button(label="役職確認", style=discord.ButtonStyle.primary)
    async def check(self, interaction: discord.Interaction, button: discord.ui.Button):
        real_role = self.game.roles.get(interaction.user.id)
        if real_role is None:
            embed = discord.Embed(description="あなたはゲームに参加していません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        # 表示用役職を取得（裏役職を考慮）
        display_role = _get_display_role(self.game, interaction.user.id, reveal_hidden=False)

        wolves = self.cog.get_wolves_names(self.game)
        partner_name = "なし"
        slave_name = "なし"
        kizoku_name = "なし"

        if hasattr(self.game, "riacchu_pairs"):
            for pair in self.game.riacchu_pairs:
                if interaction.user.id in pair:
                    other_id = pair[1] if pair[0] == interaction.user.id else pair[0]
                    other_m = interaction.guild.get_member(other_id)
                    if other_m:
                        partner_name = other_m.display_name

        if hasattr(self.game, "kizoku_slave"):
            slave_id = self.game.kizoku_slave.get(interaction.user.id)
            if slave_id:
                slave_m = interaction.guild.get_member(slave_id)
                if slave_m:
                    slave_name = slave_m.display_name

            for k_id, s_id in self.game.kizoku_slave.items():
                if s_id == interaction.user.id:
                    k_m = interaction.guild.get_member(k_id)
                    if k_m:
                        kizoku_name = k_m.display_name

        # 新役職の解説テキストを追加
        descs = {
            # 既存の役職解説...
            "一般通過あごむに": "【村人陣営】一般通過あごむに。空気より存在感が薄い。",
            "占い師":           "【村人陣営】毎晩1人を占える。白か黒か結果が出る。金がないのでビー玉で占っている。",
            "霊媒師":           "【村人陣営】昨日追放された者が白か黒かを昼に通知される仕事。",
            "大霊媒師":         "【村人陣営】霊媒師の上位職。追放者の白黒+役職を通知される。さらに夜に死者ならば誰でも選んで調べることができ役職まで判明する。",
            "人狼":             f"【人狼陣営】村人を食べる。仲間: {wolves}",
            "騎士":             "【村人陣営】毎晩一人をつまようじで守る。",
            "罠師":             "【村人陣営】毎晩一人を守る。狼が守った対象を攻撃した場合、その狼を返り討ちにする。騎士の上位職。",
            "狂人":             "【人狼陣営】人狼の味方。基本的に無能である。",
            "ハゲ":             "【第三者陣営】追放されたら勝てる。髪の毛が観測できないバグが発生している。",
            "コウモリむに":     "【第三者陣営】ハゲの上位職。追放されても勝利できない。ただし最後まで生き残れば個人追加勝利できる。",
            "メンヘラ":         "【第三者陣営】自分に関与した者を物理的に消す。占うと黒判定が出る。",
            "あごむに破道砲":   "【第三者陣営】自らを弾にして1人を狙い撃ちできるが、誤発してもう1人殺す。（※3日目の夜以降に使用可能）",
            "デカ狼":           f"【人狼陣営】占い師に賄賂を払って白判定にする（霊媒師には黒と出る）。仲間: {wolves}",
            "パン屋":           "【村人陣営】生きているうちは朝にパンを配る。死んでいてもなぜかパンが届く。",
            "マサイ族":         "【村人陣営】夜に1人を観察する。もし対象が人狼なら襲撃を50%で回避する準備を整える。真偽は誰にもわからない。",
            "入狼":             "【村人陣営】生まれた名前が悪かった。ビー玉で占ってるやつに黒と誤解される哀れな村陣営。",
            "ワンころ":         "【第三者陣営】最初の夜に飼い主を決める。飼い主がいないと野生化して人狼になる。占うと黒判定が出る。",
            "タフむに":         "【村人陣営】殺された時に殺し返す根性のある一般通過あごむに。",
            "狂信者":           f"【人狼陣営】人狼とデカ狼を知っている熱狂的な人狼ファン。 仲間: {wolves}",
            "議長":             "【村人陣営】会議中に『スキップ』で議論を即終了→通常投票へ。ゲーム中一回だけ『強制投票』と発言すると議長専用の投票箱が設置され、議長が直接追放対象を選べる。",
            "ビー玉ブレイカー": "【村人陣営】あなたが生きているだけで占い師の判定が30%の確率で逆転する。パッシブ効果のため夜は何もしなくていい。",
            "リア充":           f"【村人陣営】リア充。パートナー: {partner_name}。片方が死ぬと両方道連れになる。",
            "貴族":             f"【村人陣営】貴族。奴隷が生きている間は死を自動的に肩代わりさせることができる。奴隷: {slave_name}",
            "奴隷":             f"【村人陣営】奴隷。貴族が死亡判定を受けると代わりに死ぬ運命。貴族: {kizoku_name}",
            "陽キャ":           "【村人陣営】毎晩1人をℳ𝓎𝒽ℴ𝓂ℯに連れ込む。相手が人狼/デカ狼なら自分が死ぬ。相手がメンヘラなら2人ともリア充に変化。それ以外は夜のアクションを酔い潰してキャンセルする。",
            "ミュージシャン":   "【村人陣営】陽キャの発展職。ゲーム中1度だけ夜にランダム4人をパーティに招待できる。招待者は狼から守られ夜のアクションもキャンセル。人狼が混じっていたら30%で村人側の1人が死亡。",
            "もくもく":         "【第三者陣営】ビー玉ブレイカーの発展職。あなたが生きている間（最大3ターン）は全員の役職構成が非公開になる。死ぬか3ターン経過すると役職構成が公開される。占い師の判定30%逆転効果も継承。",
            "ネット民":         "【村人陣営】ネット弁慶。一般の役職と異なり、発言できるタイミングが昼と夜で完全に逆転する変人。",
            "ヤンデレ":         f"【人狼陣営】メンヘラの発展職。ランダムに選ばれた人狼に夜関わった人間をすべて物理的に消去する。仲間: {wolves}",
            "アホ":             "【村人陣営】役職効果なく村人陣営。占うと白判定となる。",
        }

        role_image_map = {
            # 既存のマップに加え新役職の画像を追加
            "一般通過あごむに": "NOMAL.PNG",    "人狼": "JINROU.PNG",         "マサイ族": "MASAI.PNG",
            "メンヘラ": "MENHERA.PNG",          "入狼": "NYUROU.PNG",          "騎士": "KISHI.PNG",
            "占い師": "URANAI.PNG",              "霊媒師": "REIBAI.PNG",        "パン屋": "PANYA.PNG",
            "狂人": "KYOJIN.PNG",               "ハゲ": "HAGE.PNG",            "デカ狼": "DEKAROU.PNG",
            "あごむに破道砲": "AGOMUNIHADOHOU.PNG", "ワンころ": "WANKORO.PNG",
            "タフむに": "TAHUMUNI.PNG",          "狂信者": "KYOUSINSYA.PNG",
            "罠師": "WANASI.PNG",               "議長": "GITYO.PNG",
            "ビー玉ブレイカー": "BI-BURE.PNG",  "リア充": "RIAJUU.PNG",
            "貴族": "KIZOKU.PNG",               "奴隷": "DOREI.PNG",           "コウモリむに": "KOUMORI.PNG",
            "大霊媒師": "DAIREIBAI.PNG",
            "陽キャ": "765f556c89af682d.png",             "ミュージシャン": "246d72bdb68e5372.png",
            "もくもく": "cd60d2fa8afdb21f.png",         "ネット民": "af863387bd48b0f5.png",       "ヤンデレ": "YANDERE.PNG",
            "アホ": "NOMAL.PNG"
        }

        embed = discord.Embed(
            title=f"あなたの役職は 【{display_role}】 です",
            description=descs.get(display_role, "詳細なし"),
            color=0xFFFFFF
        )
        # 初心者ガイド（陣営・能力・勝利条件・今夜やること）。裏役職は表示用の役職で案内する
        jinrou_guide.add_guide(embed, display_role)

        # 表示用役職に対応した画像ファイルを取得
        filename = role_image_map.get(display_role)
        if filename:
            file_path = f"Assets/{filename}"
            if os.path.exists(file_path):
                file = discord.File(file_path, filename="role_img.png")
                embed.set_image(url="attachment://role_img.png")
                return await interaction.response.send_message(embed=embed, file=file, ephemeral=True)

        await interaction.response.send_message(embed=embed, ephemeral=True)


class NightActionView(discord.ui.View):
    def __init__(self, game):
        super().__init__(timeout=60)
        self.game = game

    @discord.ui.button(label="夜のアクション", style=discord.ButtonStyle.success)
    async def action(self, interaction: discord.Interaction, button: discord.ui.Button):
        p_id = interaction.user.id
        if p_id not in [p.id for p in self.game.alive_players]: return

        if p_id in self.game.night_actions:
            embed = discord.Embed(description="アクションは既に完了しています。欲張らないでください。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        role = self.game.roles.get(p_id)

        if role == "あごむに破道砲" and self.game.day_count < 3:
            embed = discord.Embed(description=f"あごむに破道砲は第3夜からしか使用できません。(現在は第{self.game.day_count}夜)", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if role == "大霊媒師":
            alive_ids = {p.id for p in self.game.alive_players}
            dead_players = [p for p in self.game.players if p.id not in alive_ids and p.id != p_id]
            if not dead_players:
                embed = discord.Embed(description="調べられる死者がいません。今夜は待機です。", color=0xFFFFFF)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            opts = [discord.SelectOption(label=p.display_name, value=str(p.id)) for p in dead_players]
            embed = discord.Embed(description="調べる死者を選択してください：", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, view=ActionSelectView(self.game, opts, role, actor_id=p_id), ephemeral=True)

        if role == "ミュージシャン":
            if self.game.musician_party_used:
                embed = discord.Embed(description="パーティは既に開催済みです。今夜は待機してください。", color=0xFFFFFF)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            self.game.night_actions[p_id] = 0
            embed = discord.Embed(description=MUSIC + ' パーティを開催します！ランダムに4人を招待します。', color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        passive_roles = [
            "一般通過あごむに", "霊媒師", "狂人", "ハゲ", "コウモリむに",
            "メンヘラ", "パン屋", "入狼", "タフむに", "狂信者",
            "ビー玉ブレイカー", "もくもく", "リア充", "貴族", "奴隷", "議長", "アホ"
        ]
        if role in passive_roles:
            embed = discord.Embed(description="お前は寝てろ。明日の朝までじっとしてなさい。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        opts = [discord.SelectOption(label=p.display_name, value=str(p.id)) for p in self.game.alive_players if p.id != p_id]
        if not opts:
            embed = discord.Embed(description="対象がいません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        embed = discord.Embed(description="対象を選択してください：", color=0xFFFFFF)
        await interaction.response.send_message(embed=embed, view=ActionSelectView(self.game, opts, role, actor_id=p_id), ephemeral=True)


class ActionSelectView(discord.ui.View):
    def __init__(self, game, options, role, actor_id=None):
        super().__init__(timeout=60)
        self.game, self.role = game, role
        self.actor_id = actor_id
        s = discord.ui.Select(options=options)
        s.callback = self.callback
        self.add_item(s)

    async def callback(self, interaction: discord.Interaction):
        p_id = interaction.user.id
        # B-5: 配信方法（ephemeral）に頼らず、View 自体で実行者を検証する
        if self.actor_id is not None and p_id != self.actor_id:
            embed = discord.Embed(description="このアクションはあなた宛ではありません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if p_id not in [p.id for p in self.game.alive_players]:
            embed = discord.Embed(description="生存者だけが夜のアクションを行えます。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if self.game.roles.get(p_id) != self.role:
            embed = discord.Embed(description="あなたの役職と一致しないアクションです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        # 夜フェーズ判定: 明示フラグがあればそれを優先し、無い旧状態では
        # 「開始済み・議論中でない」ことを最低条件にする
        in_night = getattr(self.game, "in_night_phase", None)
        if in_night is None:
            in_night = bool(getattr(self.game, "started", False)) and not getattr(self.game, "in_discussion", False)
        if not in_night:
            embed = discord.Embed(description="今は夜フェーズではありません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if p_id in self.game.night_actions:
            embed = discord.Embed(description="既にアクションは受理されています。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        t_id = int(self.children[0].values[0])
        self.game.night_actions[p_id] = t_id

        if self.role == "占い師":
            r = self.game.roles.get(t_id)
            if r == "デカ狼":
                res = "白"
            else:
                res = uranai_color(r)
            # ビー玉ブレイカー/もくもく生存で30%逆転
            if any(self.game.roles.get(p.id) == "ビー玉ブレイカー" for p in self.game.alive_players):
                if random.random() < 0.3:
                    res = "白" if res == "黒" else "黒"
            jinrou_review.note_divine(self.game, p_id, t_id, res)
            embed = discord.Embed(description=f"{URANAI}占い結果: 【{res}】", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)

        elif self.role == "大霊媒師":
            r = self.game.roles.get(t_id)
            color = reibai_color(r)
            embed = discord.Embed(
                description=f"{REIBAI}大霊媒師の結果: 【{color}】 役職: 【{r}】",
                color=0xFFFFFF
            )
            await interaction.response.send_message(embed=embed, ephemeral=True)

        elif self.role == "マサイ族":
            r = self.game.roles.get(t_id)
            if r in ["人狼", "デカ狼"]:
                self.game.masai_evasion[p_id] = True
            embed = discord.Embed(description=MASAI + '対象の観察を完了しました。人狼であれば回避の準備を整える。', color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        elif self.role == "罠師":
            embed = discord.Embed(description="対象に罠を設置しました。狼が攻撃した場合、返り討ちにします。", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        elif self.role == "ワンころ" and self.game.day_count == 1:
            master_m = self.game.game_channel.guild.get_member(t_id) if self.game.game_channel else None
            master_name = master_m.display_name if master_m else "不明"
            embed = discord.Embed(description=f"飼い主を **{master_name}** に決めました。飼い主が生きている間はあなたも村人陣営です。", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        elif self.role == "陽キャ":
            t_m = self.game.game_channel.guild.get_member(t_id)
            t_name = t_m.display_name if t_m else "不明"
            embed = discord.Embed(description=f"🎉 {t_name} をℳ𝓎𝒽ℴ𝓂ℯに誘います。", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)
        else:
            embed = discord.Embed(description="完了。", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)


class PublicVoteView(discord.ui.View):
    def __init__(self, game, options):
        super().__init__(timeout=60)
        self.game = game
        s = discord.ui.Select(options=options)
        s.callback = self.callback
        self.add_item(s)

    async def callback(self, interaction: discord.Interaction):
        p_id = interaction.user.id
        if p_id not in [p.id for p in self.game.alive_players]:
            embed = discord.Embed(description="死人に口なし。墓場で大人しくしていなさい。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if p_id in self.game.voted_count:
            embed = discord.Embed(description="既に投票済みです。意志を何度も変えることはできません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        self.game.voted_count[p_id] = self.children[0].values[0]
        await interaction.response.send_message(f"{SUCCESS} {interaction.user.display_name} さんが投票を完了しました。")


class ChairmanVoteView(discord.ui.View):
    def __init__(self, game, options):
        super().__init__(timeout=60)
        self.game = game
        self.voted = False
        s = discord.ui.Select(options=options, placeholder="追放する対象を選んでください")
        s.callback = self.callback
        self.add_item(s)

    async def callback(self, interaction: discord.Interaction):
        p_id = interaction.user.id

        if self.game.roles.get(p_id) != "議長":
            embed = discord.Embed(description="この投票は議長のみ行えます。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        if self.voted:
            embed = discord.Embed(description="既に投票済みです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        self.voted = True
        t_id = int(self.children[0].values[0])
        self.game.chairman_ketsugu_target = t_id

        if self.game.chairman_vote_event:
            self.game.chairman_vote_event.set()

        target_m = self.game.game_channel.guild.get_member(t_id)
        target_name = target_m.display_name if target_m else "不明"
        await interaction.response.send_message(
            f"議長が **{target_name}** を選びました。強制投票完了。"
        )
