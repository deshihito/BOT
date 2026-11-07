# -*- coding: utf-8 -*-
"""ワードウルフ: 1 人だけ違うお題を持つ「ウルフ」を、会話から見つけ出すゲーム。

- 状態はチャンネルごとの WordWolfSession で持ち、Cog は channel_id -> session の
  dict だけを持つ。以前は Cog の単一フィールド（self.game_running 等）だったため、
  Bot 全体で同時に 1 ゲームしか開けなかった。
- 募集の 60 秒待ちと本編タイマー（1 分ごとの経過報告）はセッション側が担う。
- ルール・お題・勝利数記録（core/game/game/party_ranking.py）の挙動は従来どおり。
"""
import discord
from core.game.game import game_panels
from core.game.game.game_v2 import GamePanelView, LobbyView, original_response_or_none, safe_delete, text_panel
from discord.ext import commands

from core.game.game import party_ranking
party_ranking.register("wordwolf")
import asyncio
import logging
import random

logger = logging.getLogger(__name__)

#: お題・ウルフ抽選専用の CSPRNG (E-12)。グローバル random (MT) の状態を
#: 他機能と共有しないため SystemRandom を使う。
_RNG = random.SystemRandom()

RECRUIT_SECONDS = 60
CHAT_MINUTES = 5  # 本編の長さ（分）。タイマーが 1 分ごとに経過報告を出す
LIST_NAMES = {"standard": "標準", "starail": "崩壊：スターレイル", "genshin": "原神"}


class WordWolfSession:
    """1 チャンネル分のワードウルフの状態と進行。"""

    def __init__(self, cog, channel, wordlist: str = "standard"):
        self.cog = cog
        self.channel = channel
        self.channel_id = channel.id
        self.wordlist = wordlist
        self.game_running = False
        self.players = []
        self.alive_players = []
        self.wolf = None
        self.player_words = {}
        self.remaining_challenges = 3
        self.last_notice = None  # 最新の経過/判定表示（次で消す）

    @property
    def list_name(self) -> str:
        return LIST_NAMES.get(self.wordlist, "標準")

    async def notice(self, title: str, body: str):
        """経過・判定の表示。前の表示は役割を終えたので消し、常に最新1通だけ残す。"""
        old = self.last_notice
        if old is not None:
            self.last_notice = None
            await safe_delete(old)
        self.last_notice = await self.channel.send(view=text_panel(title, body))

    async def finish_recruitment(self, lobby, lobby_msg=None):
        """募集を締め切り、人数が揃えば本編を始める。足りなければ中止を告知して片付ける。"""
        for _ in range(RECRUIT_SECONDS * 2):
            if lobby.started or lobby.cancelled:
                break
            await asyncio.sleep(0.5)
        lobby.stop()
        # 募集パネルは締切時点で役割を終える。
        await safe_delete(lobby_msg)
        if lobby.cancelled:
            self.cog._discard(self)
            return
        self.players = [lobby.members[uid] for uid in lobby.players]

        if len(self.players) < 3:
            await self.channel.send(view=text_panel("", "人数不足（3人以上必要）のため中止します。"))
            self.cog._discard(self)
            return

        await self.begin()

    async def begin(self):
        pool = self.cog.word_pools.get(self.wordlist, self.cog.word_pools["standard"])
        selected_words = _RNG.sample(pool, 2)
        common_word, wolf_word = selected_words
        self.wolf = _RNG.choice(self.players)
        self.alive_players = self.players.copy()

        for p in self.players:
            self.player_words[p.id] = wolf_word if p == self.wolf else common_word

        check_view = CheckWordPanel(self)
        body = (
            f"参加者: {', '.join([p.display_name for p in self.players])}\n"
            f"リスト: **{self.list_name}** / 各自ボタンでワードを確認してください。\n"
            f"**【ルール】メンションで判定（全体で残り {self.remaining_challenges} 回まで）**"
        )
        check_view.set_content(title="ゲーム開始！", body=body)
        await game_panels.replace(self.channel, "party", view=check_view)

        self.game_running = True
        asyncio.create_task(self.game_timer())

    async def game_timer(self):
        for i in range(CHAT_MINUTES - 1, 0, -1):
            await asyncio.sleep(60)
            if not self.game_running:
                return
            alive_names = [p.display_name for p in self.alive_players]
            await self.notice(
                "経過報告",
                f"**残り {i} 分** / **チャレンジ残り: {self.remaining_challenges}回**\n"
                f"生存者: {', '.join(alive_names)}")

        await asyncio.sleep(60)
        if self.game_running:
            await self.cog.end_game(self.channel, "time_up", session=self)

    async def execute_challenge(self, challenger, target):
        self.remaining_challenges -= 1
        channel = self.channel
        role = discord.utils.get(channel.guild.roles, name="muted")

        if challenger == self.wolf:
            await self.notice(
                "判定",
                f"**ウルフの自爆！** {challenger.mention} はウルフでしたが、村人 {target.mention} を指名したため敗北しました。")
            await self.cog.end_game(channel, "villager_win", session=self)
            return

        if target == self.wolf:
            await self.notice(
                "判定",
                f"**チャレンジ成功！** {target.mention} はウルフでした！村人の勝利です。")
            await self.cog.end_game(channel, "villager_win", session=self)
        else:
            self.alive_players.remove(challenger)
            if role:
                try:
                    await challenger.add_roles(role)
                except Exception:
                    logger.debug("ワードウルフ: 脱落ロールの付与に失敗しました", exc_info=True)

            if self.remaining_challenges <= 0:
                await self.notice(
                    "判定",
                    f"**チャレンジ失敗！** {challenger.mention} は脱落。\n"
                    "チャレンジ回数が尽きました...")
                await self.cog.end_game(channel, "wolf_win", session=self)
            elif len(self.alive_players) <= 2:
                await self.notice(
                    "判定",
                    f"**チャレンジ失敗！** {challenger.mention} は脱落。\n"
                    f"**チャレンジ残り回数: {self.remaining_challenges}回**")
                await self.cog.end_game(channel, "wolf_win", session=self)
            else:
                alive_names = [p.display_name for p in self.alive_players]
                await self.notice(
                    "判定",
                    f"**チャレンジ失敗！** {challenger.mention} は脱落。\n"
                    f"**チャレンジ残り回数: {self.remaining_challenges}回**\n"
                    f"生存プレイヤー: {', '.join(alive_names)}")


class CustomWordWolf(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions: dict[int, WordWolfSession] = {}
        # 旧インターフェース互換のための置き場（新規コードはセッションを使う）。
        # end_game がセッション無しで呼ばれた場合だけ、ここから状態を復元する。
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

    def _discard(self, session: WordWolfSession):
        if self.sessions.get(session.channel_id) is session:
            del self.sessions[session.channel_id]

    def _session_for(self, channel) -> WordWolfSession | None:
        """チャンネルのセッションを返す。無ければ旧フィールドから復元する（互換用）。"""
        session = self.sessions.get(getattr(channel, "id", None))
        if session is not None:
            return session
        if self.players:
            session = WordWolfSession(self, channel)
            session.players = self.players
            session.alive_players = self.alive_players
            session.wolf = self.wolf
            session.player_words = self.player_words
            session.remaining_challenges = self.remaining_challenges
            session.game_running = self.game_running
            return session
        return None

    async def start_recruit(self, interaction: discord.Interaction, wordlist: str = "standard"):
        """募集を始める（/game のハブから呼ぶ）。interaction にはまだ応答していないこと。"""
        channel = interaction.channel
        if channel.id in self.sessions:
            await interaction.response.send_message(embed=self._white_embed("既にゲームが進行中です。"), ephemeral=True)
            return

        session = WordWolfSession(self, channel, wordlist)
        self.sessions[channel.id] = session

        lobby = LobbyView(
            title="ワードウルフ 参加者募集", host=interaction.user,
            min_players=3, max_players=99,
            note=f"リスト: **{session.list_name}**\n{RECRUIT_SECONDS}秒以内に参加してください。",
            timeout=RECRUIT_SECONDS + 30)
        await interaction.response.send_message(view=lobby)
        lobby_msg = await original_response_or_none(interaction)

        await session.finish_recruitment(lobby, lobby_msg)

    async def begin_game(self, channel, wordlist: str):
        session = self.sessions.get(channel.id)
        if session is None:
            session = WordWolfSession(self, channel, wordlist)
            self.sessions[channel.id] = session

        await asyncio.sleep(RECRUIT_SECONDS)

        if len(session.players) < 3:
            await channel.send(view=text_panel("", "人数不足（3人以上必要）のため中止します。"))
            self._discard(session)
            return

        await session.begin()

    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return
        session = self.sessions.get(message.channel.id)
        if session is None or not session.game_running:
            return

        if message.mentions and message.author in session.alive_players:
            target = message.mentions[0]
            if target != message.author and target in session.alive_players:
                await session.execute_challenge(message.author, target)

    async def end_game(self, channel, result, session: WordWolfSession = None):
        session = session or self._session_for(channel)
        if session is None:
            return
        session.game_running = False
        self._discard(session)
        # サーバーごとのランキング（core/game/game/party_ranking.py）: チーム戦なので勝った側の全員に 1 勝。
        # 村人の勝ち → ウルフ以外の参加者全員（脱落した人も含む）、ウルフの勝ち → ウルフ 1 人
        guild = getattr(channel, "guild", None)
        if guild is not None:
            if result == "villager_win":
                winners = [p for p in session.players if p != session.wolf]
            else:
                winners = [session.wolf] if session.wolf is not None else []
            for p in winners:
                await party_ranking.shared().record_win(guild.id, p.id, "wordwolf")

        if result == "villager_win":
            msg = "**村人チームの勝利です！**"
        else:
            msg = f"**ウルフの勝利です！**\n正解は {session.wolf.mention} でした。"

        # ワード確認パネルと最後の経過/判定表示を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        if session.last_notice is not None:
            notice, session.last_notice = session.last_notice, None
            await safe_delete(notice)
        await channel.send(view=text_panel("ゲーム終了", msg))

        role = discord.utils.get(channel.guild.roles, name="muted")
        if role:
            for p in session.players:
                try:
                    await p.remove_roles(role)
                except Exception:
                    logger.debug("ワードウルフ: ロールの回収に失敗しました", exc_info=True)


class CheckWordPanel(GamePanelView):
    """自分のワードを本人だけに確認させるパネル（V2）。"""

    def __init__(self, session: WordWolfSession):
        super().__init__("", "", timeout=None)
        self.session = session
        # 互換: View から cog を辿れるようにしておく
        self.cog = session.cog
        self.check = discord.ui.Button(label="自分のワードを確認", style=discord.ButtonStyle.secondary)
        self.check.callback = self._check
        self.add_row(self.check)

    async def _check(self, interaction: discord.Interaction):
        word = self.session.player_words.get(interaction.user.id)
        if word:
            await interaction.response.send_message(
                embed=self.session.cog._white_embed(f"あなたのワードは【**{word}**】です。"),
                ephemeral=True,
                _agobot_skip_localization=True,
            )
        else:
            await interaction.response.send_message(embed=self.session.cog._white_embed("プレイヤーではありません。"), ephemeral=True)


CheckWordView = CheckWordPanel  # 互換名


async def setup(bot):
    await bot.add_cog(CustomWordWolf(bot))
