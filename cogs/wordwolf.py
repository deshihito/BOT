# -*- coding: utf-8 -*-
import discord
from core import game_panels
from discord.ext import commands

from core import party_ranking

party_ranking.register("wordwolf")
from discord import app_commands
import asyncio
import random

class CustomWordWolf(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.game_running = False
        self.players = []
        self.alive_players = []
        self.wolf = None
        self.player_words = {}
        self.remaining_challenges = 3
        
        # 各種ワードリストの定義
        self.word_pools = {
            "standard": [
                "リンゴ", "ナシ", "バナナ", "イチゴ", "ブドウ", "メロン", "スイカ", "桃",
                "焼肉", "すき焼き", "寿司", "ラーメン", "カレー", "ハンバーグ", "パスタ", "牛丼",
                "学校", "塾", "会社", "公園", "図書館", "病院", "駅", "空港",
                "スマホ", "パソコン", "テレビ", "電子レンジ", "冷蔵庫", "洗濯機", "掃除機", "ドライヤー",
                "海", "プール", "山", "川", "砂漠", "森林", "湖", "滝",
                "ディズニーランド", "ユニバ", "富士急", "映画館", "水族館", "動物園", "美術館", "カラオケ",
                "シャンプー", "リンス", "石鹸", "洗剤", "歯磨き粉", "タオル", "ハンカチ", "ティッシュ",
                "犬", "猫", "うさぎ", "ハムスター", "ライオン", "ゾウ", "キリン", "ペンギン",
                "野球", "サッカー", "テニス", "バスケ", "バレー", "卓球", "水泳", "柔道",
                "数学", "英語", "国語", "理科", "社会", "音楽", "体育", "図工",
                "ピアノ", "ギター", "ドラム", "バイオリン", "フルート", "トランペット", "琴", "三味線",
                "教科書", "ノート", "鉛筆", "消しゴム", "定規", "コンパス", "筆箱", "ハサミ",
                "東京", "大阪", "名古屋", "福岡", "札幌", "沖縄", "京都", "横浜",
                "パン", "ごはん", "うどん", "そば", "餅", "ピザ", "サンドイッチ", "おにぎり"
            ],
            "starail": [
                "雪衣", "霊砂", "椒丘", "トパーズ", "愉悦", "調和", "ペラ", "ルカ",
                "青雀", "昼夜の狭間を駆ける鷹", "成り上がりチャンピオン", "星の如く輝く天才", "泥の如き眠り", "存護", "均衡", "貪欲",
                "壊滅", "姫子", "ジェパード", "ゴーナウス", "これがウチだよ！", "防衛", "彼女が観ると決めた時", "きらびやかな世界",
                "繁殖", "記憶", "タケタケ冒険記", "ルアン・メェイ", "停雲", "帰忘の流離人", "乱破", "アルジェンティ",
                "2度目の生に向かって", "フォローして！", "論剣", "夜の帷の中で", "燃え盛る黎明のように", "フレイムスティーラー", "フォフォ", "Dr.レイシオ",
                "獲物の視線", "彼女の炎を忘れずに", "待つのみ", "だが戦争は終わらない", "ヘルタ", "マダムヘルタ", "その一刻、目に焼き付けて", "ブートヒル",
                "初めてのクエストの前に", "星海巡行", "銀河鉄道の夜", "折れた竜骨", "天体階差機関", "ウェンワーク", "サルソット", "爻光",
                "セイバー", "サフェル", "アーチャー", "アーラン", "雲璃", "丹恒", "丹恒飲月", "丹恒騰荒",
                "刃", "銀狼", "開拓者", "羅刹", "サンポ", "アグライア", "黄泉", "カカワーシャ",
                "景元", "モゼ", "虚照", "花火", "火花", "フェルマータ", "輪形", "アベンチュリン",
                "トリビー", "ホタル", "ダリア", "空の虹が消えぬように", "生命、消滅すべし", "ダンスダンスダンス", "ライコス", "鉄墓",
                "ケリュドラ", "セイレンス", "ロビン", "ブラックスワン", "カフカ", "アキヴィリ", "薬師", "アッハ",
                "白露", "ゼーレ", "フック", "エリシア", "キュレネ", "長夜月", "三月なのか", "ヴェルト",
                "鏡流", "不死途", "飛霄", "ヒアンシー", "ファイノン", "キャストリス", "クラーラ", "彦"
            ],
            "genshin": [
                "パイモン", "空", "蛍", "ダインスレイヴ", "ジン", "アンバー", "リサ", "ガイア",
                "バーバラ", "ディルック", "レザー", "ウェンティ", "クレー", "ベネット", "ノエル", "フィッシュル",
                "スクロース", "モナ", "刻晴", "七七", "甘雨", "鍾離", "タルタリヤ", "胡桃",
                "魈", "神里綾華", "宵宮", "雷電将軍", "珊瑚宮心海", "荒瀧一斗", "八重神子", "夜蘭",
                "ニィロウ", "ナヒーダ", "セノ", "放浪者", "アルハイゼン", "ディシア", "フリーナ", "ヌヴィレット",
                "ナヴィア", "閑雲", "クロリンデ", "エミリエ", "ムアラニ", "キィニチ", "シロネン", "チャスカ",
                "モンド", "璃月", "稲妻", "スメール", "フォンテーヌ", "ナタ", "至冬", "カーンルイア",
                "セシリアの花", "清心", "鳴草", "サウマラクサ蓮", "ルエトワール", "火素", "燃晶の欠片", "夜魂の加護",
                "風龍廃墟", "望舒旅館", "鳴神大社", "オルモス港", "メロピデ要塞", "聖火競技場", "ドラゴンスパイン", "層岩巨淵",
                "風の翼", "神の目", "邪眼", "失われた瞳", "脆弱樹脂", "濃縮樹脂", "原石", "創世結晶",
                "翠緑の影", "燃え盛る緋炎の魔女", "旧貴族のしつけ", "絶縁の旗印", "深林の記憶", "黄金の劇団", "黒曜の典", "絵巻",
                "アビスの魔術師", "遺跡守衛", "ヒルチャール", "ファデュイ", "宝盗団", "野伏衆", "エルマイト旅団", "深罪の浸礼者",
                "天理の調停者", "執行官", "七神", "眷属", "降臨者", "元素反応", "蒸発", "溶解",
                "過負荷", "感電", "超電導", "開花", "激化", "結晶", "拡散", "凍結"
            ]
        }

    def _white_embed(self, description: str = None, title: str = None) -> discord.Embed:
        return discord.Embed(title=title, description=description, color=0xFFFFFF)
        
    async def start_recruit(self, interaction: discord.Interaction, wordlist: str = "standard"):
        """募集を始める（/game のハブから呼ぶ）。interaction にはまだ応答していないこと。"""
        if self.game_running:
            await interaction.response.send_message(embed=self._white_embed("既にゲームが進行中です。"), ephemeral=True)
            return

        self.game_running = False
        self.players = []
        self.alive_players = []
        self.player_words = {}
        self.remaining_challenges = 3 
        
        list_names = {"standard": "標準", "starail": "崩壊：スターレイル", "genshin": "原神"}
        current_list_name = list_names.get(wordlist, "標準")

        join_view = JoinView(self)
        embed = self._white_embed(
            f"**ワードウルフ参加者募集中！** (リスト: **{current_list_name}**)\n1分以内に【参加】ボタンを押してください。",
            title="ワードウルフ"
        )
        await interaction.response.send_message(embed=embed, view=join_view)
        
        await asyncio.sleep(60)
        join_view.stop()
        
        if len(self.players) < 3:
            await interaction.channel.send(embed=self._white_embed("人数不足（3人以上必要）のため中止します。"))
            return

        pool = self.word_pools.get(wordlist, self.word_pools["standard"])
        selected_words = random.sample(pool, 2)
        common_word, wolf_word = selected_words
        self.wolf = random.choice(self.players)
        self.alive_players = self.players.copy()
        
        for p in self.players:
            self.player_words[p.id] = wolf_word if p == self.wolf else common_word

        check_view = CheckWordView(self)
        embed = self._white_embed(
            f"参加者: {', '.join([p.display_name for p in self.players])}\n"
            f"リスト: **{current_list_name}** / 各自ボタンでワードを確認してください。\n"
            f"**【ルール】メンションで判定（全体で残り {self.remaining_challenges} 回まで）**",
            title="ゲーム開始！"
        )
        await game_panels.replace(interaction.channel, "party", embed=embed, view=check_view)

        self.game_running = True
        self.bot.loop.create_task(self.game_timer(interaction.channel))

    async def begin_game(self, channel, wordlist: str):
        await asyncio.sleep(60)

        if len(self.players) < 3:
            await channel.send(embed=self._white_embed("人数不足（3人以上必要）のため中止します。"))
            return

        list_names = {"standard": "標準", "starail": "崩壊：スターレイル", "genshin": "原神"}
        current_list_name = list_names.get(wordlist, "標準")

        pool = self.word_pools.get(wordlist, self.word_pools["standard"])
        selected_words = random.sample(pool, 2)
        common_word, wolf_word = selected_words
        self.wolf = random.choice(self.players)
        self.alive_players = self.players.copy()

        for p in self.players:
            self.player_words[p.id] = wolf_word if p == self.wolf else common_word

        check_view = CheckWordView(self)
        embed = self._white_embed(
            f"参加者: {', '.join([p.display_name for p in self.players])}\n"
            f"リスト: **{current_list_name}** / 各自ボタンでワードを確認してください。\n"
            f"**【ルール】メンションで判定（全体で残り {self.remaining_challenges} 回まで）**",
            title="ゲーム開始！"
        )
        await game_panels.replace(channel, "party", embed=embed, view=check_view)

        self.game_running = True
        self.bot.loop.create_task(self.game_timer(channel))

    async def game_timer(self, channel):
        for i in range(4, 0, -1):
            await asyncio.sleep(60)
            if not self.game_running: return
            alive_names = [p.display_name for p in self.alive_players]
            embed = self._white_embed(
                f"**残り {i} 分** / **チャレンジ残り: {self.remaining_challenges}回**\n"
                f"生存者: {', '.join(alive_names)}",
                title="経過報告"
            )
            await channel.send(embed=embed)
        
        await asyncio.sleep(60)
        if self.game_running:
            await self.end_game(channel, "time_up")

    @commands.Cog.listener()
    async def on_message(self, message):
        if not self.game_running or message.author.bot:
            return
        
        if message.mentions and message.author in self.alive_players:
            target = message.mentions[0]
            if target != message.author and target in self.alive_players:
                await self.execute_challenge(message.channel, message.author, target)

    async def execute_challenge(self, channel, challenger, target):
        self.remaining_challenges -= 1
        role = discord.utils.get(channel.guild.roles, name="muted")
        
        if challenger == self.wolf:
            embed = self._white_embed(
                f"**ウルフの自爆！** {challenger.mention} はウルフでしたが、村人 {target.mention} を指名したため敗北しました。",
                title="判定"
            )
            await channel.send(embed=embed)
            await self.end_game(channel, "villager_win")
            return

        if target == self.wolf:
            embed = self._white_embed(
                f"**チャレンジ成功！** {target.mention} はウルフでした！村人の勝利です。",
                title="判定"
            )
            await channel.send(embed=embed)
            await self.end_game(channel, "villager_win")
        else:
            embed = self._white_embed(
                f"**チャレンジ失敗！** {challenger.mention} は脱落。\n"
                f"**チャレンジ残り回数: {self.remaining_challenges}回**",
                title="判定"
            )
            await channel.send(embed=embed)
            
            self.alive_players.remove(challenger)
            if role:
                try: await challenger.add_roles(role)
                except: pass
            
            if self.remaining_challenges <= 0:
                await channel.send(embed=self._white_embed("チャレンジ回数が尽きました...", title="終了"))
                await self.end_game(channel, "wolf_win")
            elif len(self.alive_players) <= 2:
                await self.end_game(channel, "wolf_win")
            else:
                alive_names = [p.display_name for p in self.alive_players]
                await channel.send(embed=self._white_embed(f"生存プレイヤー: {', '.join(alive_names)}"))

    async def end_game(self, channel, result):
        self.game_running = False
        # サーバーごとのランキング（core/party_ranking.py）: チーム戦なので勝った側の全員に 1 勝。
        # 村人の勝ち → ウルフ以外の参加者全員（脱落した人も含む）、ウルフの勝ち → ウルフ 1 人
        guild = getattr(channel, "guild", None)
        if guild is not None:
            if result == "villager_win":
                winners = [p for p in self.players if p != self.wolf]
            else:
                winners = [self.wolf] if self.wolf is not None else []
            for p in winners:
                await party_ranking.shared().record_win(guild.id, p.id, "wordwolf")
        
        if result == "villager_win":
            msg = "**村人チームの勝利です！**"
        else:
            msg = f"**ウルフの勝利です！**\n正解は {self.wolf.mention} でした。"

        embed = self._white_embed(msg, title="ゲーム終了")
        await channel.send(embed=embed)
        
        role = discord.utils.get(channel.guild.roles, name="muted")
        if role:
            for p in self.players:
                try: await p.remove_roles(role)
                except: pass

class JoinView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=60)
        self.cog = cog
    @discord.ui.button(label="参加", style=discord.ButtonStyle.green)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user not in self.cog.players:
            self.cog.players.append(interaction.user)
            await interaction.response.send_message(embed=self.cog._white_embed("参加完了。"), ephemeral=True)
        else:
            await interaction.response.send_message(embed=self.cog._white_embed("参加済みです。"), ephemeral=True)

class CheckWordView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=None)
        self.cog = cog
    @discord.ui.button(label="自分のワードを確認", style=discord.ButtonStyle.secondary)
    async def check(self, interaction: discord.Interaction, button: discord.ui.Button):
        word = self.cog.player_words.get(interaction.user.id)
        if word:
            await interaction.response.send_message(
                embed=self.cog._white_embed(f"あなたのワードは【**{word}**】です。"),
                ephemeral=True,
                _agobot_skip_localization=True,
            )
        else:
            await interaction.response.send_message(embed=self.cog._white_embed("プレイヤーではありません。"), ephemeral=True)

async def setup(bot):
    await bot.add_cog(CustomWordWolf(bot))
