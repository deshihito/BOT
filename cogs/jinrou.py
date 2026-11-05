import logging
from typing import Optional
import asyncio
import random
from collections import Counter

logger = logging.getLogger(__name__)
import os
import discord
from core import game_panels
from core.emojis import FAILED, SUCCESS
from core import jinrou_guide
from discord import app_commands
from discord.ext import commands

from core import autoplay, jinrou_review

from core import party_ranking

party_ranking.register("jinrou")
import math

import config

# ======================================================
#  自前DB APIクライアント（config.db_api を共有）
# ======================================================
db_api = config.db_api
RATINGS_TABLE = "jinrou_ratings"

# ======================================================
#  レート（Elo）システム定数
# ======================================================
ELO_STARTING_RATING = 1500
ELO_BASE_K = 32
ELO_WOLF_WIN_K = 48  # 人狼陣営勝利時は獲得レートを多めにする

# ======================================================
#  白黒判定ユーティリティ
# ======================================================
BLACK_ROLES_URANAI = {"人狼", "入狼", "ワンころ", "メンヘラ", "ヤンデレ"}
BLACK_ROLES_REIBAI = {"人狼", "デカ狼", "入狼", "ワンころ", "メンヘラ", "ヤンデレ"}

def uranai_color(role: str) -> str:
    return "黒" if role in BLACK_ROLES_URANAI else "白"

def reibai_color(role: str) -> str:
    return "黒" if role in BLACK_ROLES_REIBAI else "白"

# ======================================================
#  裏役職（隠し役職）システム
# ======================================================
# 裏役職は表向きには別の役職として処理され、判明トリガーが満たされるまで
# 役職構成表示・自身の役職確認（説明文・割当PNGを含む）のすべてで偽装される。
# 実際のゲーム効果（game.roles に格納される値）は一切変わらない。
#   "end"           … 勝敗決着時のみ判明
#   "death_or_end"  … 死亡時または勝敗決着時に判明
URA_YAKUSHOKU = {
    "入狼":             ("end",          "一般通過あごむに"),
    "もくもく":         ("death_or_end", "一般通過あごむに"),
    "ビー玉ブレイカー": ("end",          "一般通過あごむに"),
    "タフむに":         ("death_or_end", "一般通過あごむに"),
    "アホ":             ("end",          None),  # None＝メンヘラ/ハゲ/狂人からランダム表示
}
AHO_FAKE_CANDIDATES = ["メンヘラ", "ハゲ", "狂人"]

# ======================================================
#  ヘルプ用役職リスト（役職名, 陣営, 説明, 画像ファイル名, id）
#  id はサイトの URL などに使う ASCII のスラッグ（小文字・英数字とハイフンのみ・重複不可）
# ======================================================
HELP_ROLES = [
    ("一般通過あごむに", "村人陣営", "空気。", "NOMAL.PNG", "villager"),
    ("タフむに", "村人陣営", "殺された時に最後の一撃で相手を道連れにする根性の一般通過。", "TAHUMUNI.PNG", "tough-muni"),
    ("占い師", "村人陣営", "毎晩1人を占える。安物のビー玉を使って白か黒かを見抜く。", "URANAI.PNG", "seer"),
    ("霊媒師", "村人陣営", "昨日追放された者が白か黒か分かる。占い師とは商売敵なので中が悪い。", "REIBAI.PNG", "medium"),
    ("大霊媒師", "村人陣営", "霊媒師の上位職。追放者の白黒を自動通知に加え、夜に死者ならば誰でも調べられ役職まで判明する。", "DAIREIBAI.PNG", "great-medium"),
    ("騎士", "村人陣営", "毎晩1人をつまようじで守る。自分は守れない不器用なやつ。", "KISHI.PNG", "knight"),
    ("罠師", "村人陣営", "騎士の上位職。対象を守るだけでなく、狼が守った対象を襲撃した場合にその狼を返り討ちにする。", "WANASI.PNG", "trapper"),
    ("入狼", "村人陣営", "人狼のような名前の村人。占われると黒判定が出る不幸なやつ。", "NYUROU.PNG", "nyurou"),
    ("パン屋", "村人陣営", "生きていれば朝にパンを配る。飯を食え。", "PANYA.PNG", "baker"),
    ("マサイ族", "村人陣営", "夜に1人を観察する。もし対象が人狼なら襲撃を50%で回避する準備を整える。真偽は誰にもわからない。", "MASAI.PNG", "maasai"),
    ("議長", "村人陣営", "会議中に『スキップ』で議論を即終了→通常投票へ。ゲーム中一回だけ『強制投票』と発言すると議長専用の投票箱が設置され、議長が直接追放対象を選べる。", "GITYO.PNG", "chairman"),
    ("ビー玉ブレイカー", "村人陣営", "占い師の判定が30%の確率でひっくり返る。", "BI-BURE.PNG", "marble-breaker"),
    ("リア充", "村人陣営", "2人1組で存在し、お互いが誰かを知っている。片方が死ぬともう片方も道連れになる。実は片方が不倫しているが見た目が同じにしか見えないのでどちらかかは分からない", "RIAJUU.PNG", "lovers"),
    ("貴族", "村人陣営", "奴隷とセットで発生。死亡判定を自動的に奴隷に肩代わりさせることができる（奴隷が存在する場合）。奴隷が誰か分かる。", "KIZOKU.PNG", "noble"),
    ("奴隷", "村人陣営", "貴族とセットで発生。貴族が死ぬと代わりに死ぬ。貴族が誰か分かる。", "DOREI.PNG", "slave"),
    ("陽キャ", "村人陣営", "毎晩1人をℳ𝓎𝒽ℴ𝓂ℯに連れ込む。相手が人狼/デカ狼なら陽キャが死ぬ。相手がメンヘラなら2人ともリア充に変化。それ以外は酔い潰してそのプレイヤーの夜のアクションをキャンセルする。", "765f556c89af682d.png", "party-person"),
    ("ミュージシャン", "村人陣営", "陽キャの発展職。ゲーム中1度だけ夜にパーティを開催してランダムに4人を招待できる。招待者は殺されなくなり夜のアクションもキャンセル。ただし人狼/デカ狼が混じっていた場合30%で招待者の中の非狼陣営が1人死亡。", "246d72bdb68e5372.png", "musician"),
    ("人狼", "人狼陣営", "村人を食べる。仲間同士は誰が人狼か知っている。", "JINROU.PNG", "werewolf"),
    ("デカ狼", "人狼陣営", "占い師を賄賂で黙らせる人狼。占い師に白判定を出させる。霊媒師には黒と出る。", "DEKAROU.PNG", "big-wolf"),
    ("狂人", "人狼陣営", "人狼の味方をする人間。人狼が誰かは知らないが、とにかく場を乱す。", "KYOJIN.PNG", "madman"),
    ("狂信者", "人狼陣営", "人狼とデカ狼が誰かを知っている熱狂的なファン。人狼陣営の参謀。", "KYOUSINSYA.PNG", "fanatic"),
    ("ハゲ", "第三者陣営", "追放されたら勝利。髪の毛が観測できないバグのせいで目立ちすぎる。", "HAGE.PNG", "hage"),
    ("コウモリむに", "第三者陣営", "ハゲの上位職。ただし最後まで生き残れば追加勝利できる。", "KOUMORI.PNG", "bat-muni"),
    ("メンヘラ", "第三者陣営", "自分に関与した（占う、守る、食べる）者を物理的に消去する。占うと黒判定が出る。", "MENHERA.PNG", "menhera"),
    ("あごむに破道砲", "第三者陣営", "自爆して対象を道連れにする。さらにもう1人も誤発で巻き込む。（※3日目の夜以降に使用可能）", "AGOMUNIHADOHOU.PNG", "agomuni-cannon"),
    ("ワンころ", "第三者陣営", "最初に飼い主を決める。飼い主が死ぬかいない場合は野良化して人狼になる。占うと黒判定が出る。", "WANKORO.PNG", "wankoro"),
    ("もくもく", "第三者陣営", "ビー玉ブレイカーの発展職。3フェーズ全員の役職構成が非公開になる。死ぬと即時に役職構成が公開される。夜の行動ログももくもくになる", "cd60d2fa8afdb21f.png", "mokumoku"),
    ("ヤンデレ", "人狼陣営", "メンヘラの発展職、人狼1人をランダムに選びその人狼に夜干渉した人間を殺す。", "YANDERE.PNG", "yandere"),
    ("ネット民", "村人陣営", "一般の役職と違い夜に発言でき昼に発言できない。", "af863387bd48b0f5.png", "netizen"),
    ("アホ", "村人陣営", "役職効果はなく村人陣営。占うと白判定となる。表示上はメンヘラ、ハゲ、狂人のいずれかに偽装されている。", "NOMAL.PNG", "aho"),
]

jinrou_guide.register_roles(HELP_ROLES)


def _is_wolf_side(game, p_id) -> bool:
    """勝敗・人数比べで人狼側として数えるか（陣営の定義は core/jinrou_guide.WOLF_SIDE の 1 か所）。

    ワンころは、飼い主がいないか死んでいれば人狼側。
    """
    r = game.roles.get(p_id)
    if r in jinrou_guide.WOLF_SIDE:
        return True
    if r == "ワンころ":
        owner_id = game.wan_owner.get(p_id)
        return owner_id is None or owner_id not in {p.id for p in game.alive_players}
    return False


def _guide_role_lookup(game):
    """「？」ボタン用: 押した人の表示用役職（裏役職は偽装したまま）。参加していなければ None。"""
    return lambda uid: _get_display_role(game, uid, reveal_hidden=False) if game.roles.get(uid) else None

# ======================================================
#  ゲーム状態
# ======================================================
class JinrouGame:
    def __init__(self):
        self.is_running = False
        self.players = []
        self.roles = {}
        self.display_roles = {}  # 表示用役職（裏役職を考慮した偽装役職）
        self.ura_reveal_triggers = {}  # 裏役職の判明トリガー状態 {player_id: True/False}
        self.aho_fake_role = {}  # アホの偽装役職 {player_id: "偽装役職名"}
        self.alive_players = []
        self.last_speak_time = {}
        self.night_actions = {}
        self.voted_count = {}
        self.last_executed = None
        self.game_channel = None
        self.used_hadouhou = False
        self.day_count = 0
        self.wan_owner = {}
        self.masai_evasion = {}
        self.silenced_players = set()
        self.chairman_skip_event = None
        self.chairman_ketsugu_used = False
        self.chairman_ketsugu_target = None
        self.chairman_forced_vote = False
        self.chairman_vote_event = None
        self.in_discussion = False
        self.riacchu_pairs = []
        self.kizoku_slave = {}
        self.musician_party_used = False
        self.required_roles = []
        self.excluded_roles = []
        self.host_id = None
        self.game_mode = "プロ"
        self.mokumoku_turns = 0
        self.yandere_targets = {}
        self.is_global = False
        self.channels = []
        self._original_channel = None
        self.review = []          # 振り返り表の記録（core/jinrou_review.py）
        self.review_divines = {}  # その夜の占い結果 {占い師: (対象, 白/黒)}
        self.started = False  # 役職を配ってゲームループが動いている間 True（募集中は False）

    # 新しいゲームでも引き継ぐ項目（チャンネルの紐付け）。それ以外はすべて初期値に戻す。
    _KEEP_ON_RESET = ("is_global", "channels", "_original_channel", "game_channel")

    def reset_for_new_game(self):
        """前のゲームの状態（メンヘラの対象・もくもくのターン数など）を残さないよう、全項目を初期化する"""
        kept = {name: getattr(self, name) for name in self._KEEP_ON_RESET}
        self.__init__()
        for name, value in kept.items():
            setattr(self, name, value)

    def is_dead_player(self, user_id) -> bool:
        """ゲームに参加していて、既に死亡・追放された人か"""
        if not self.started:
            return False
        return any(p.id == user_id for p in self.players) and not any(p.id == user_id for p in self.alive_players)

# ======================================================
#  Eloレート計算関数
# ======================================================
def calculate_elo_change(winner_rating, loser_rating, winner_is_wolf: bool):
    """Elo式レート計算。人狼陣営の勝利時はK値を大きくする"""
    K = ELO_WOLF_WIN_K if winner_is_wolf else ELO_BASE_K

    expected_score = 1 / (1 + 10 ** ((loser_rating - winner_rating) / 400))
    rating_change = K * (1 - expected_score)

    return rating_change, -rating_change

def can_end_game(game, user) -> bool:
    """人狼を途中で終了できるか：参加者・ホスト・サーバー管理者（administrator / manage_guild）。"""
    perms = getattr(user, "guild_permissions", None)
    if perms and (perms.administrator or perms.manage_guild):
        return True
    return user.id == game.host_id or any(p.id == user.id for p in game.players)


async def get_player_rating(player_id: int) -> float:
    """Supabaseからプレイヤーのレートを取得"""
    try:
        response = db_api.table(RATINGS_TABLE).select("rating").eq("player_id", player_id).execute()
        if response.data and len(response.data) > 0:
            return float(response.data[0]["rating"])
        else:
            return ELO_STARTING_RATING
    except Exception as e:
        logger.exception("人狼のレート取得に失敗しました")
        return ELO_STARTING_RATING

async def update_player_rating(player_id: int, new_rating: float, won: Optional[bool] = None):
    """Supabaseにプレイヤーのレートを保存（won を渡すと勝敗数・試合数も数える）"""
    try:
        response = db_api.table(RATINGS_TABLE).select("id, wins, losses, games_played").eq("player_id", player_id).execute()
        row = response.data[0] if response.data else None
        values = {"rating": new_rating}
        if won is not None:
            values["wins"] = int((row or {}).get("wins") or 0) + (1 if won else 0)
            values["losses"] = int((row or {}).get("losses") or 0) + (0 if won else 1)
            values["games_played"] = int((row or {}).get("games_played") or 0) + 1
        if row:
            values["updated_at"] = "now()"
            db_api.table(RATINGS_TABLE).update(values).eq("player_id", player_id).execute()
        else:
            db_api.table(RATINGS_TABLE).insert({"player_id": player_id, **values}).execute()
    except Exception as e:
        logger.exception("人狼のレート更新に失敗しました")

async def get_top_ratings(limit: int = 10):
    """上位レーティングを取得"""
    try:
        response = db_api.table(RATINGS_TABLE).select("player_id, rating").order("rating", desc=True).limit(limit).execute()
        return response.data if response.data else []
    except Exception as e:
        logger.exception("人狼のランキング取得に失敗しました")
        return []

# ======================================================
#  表示用役職を取得（裏役職対応）
# ======================================================
def _get_display_role(game, player_id: int, reveal_hidden: bool = False) -> str:
    """
    プレイヤーの表示用役職を取得。
    裏役職の場合、判明トリガーが満たされていなければ偽装役職を返す。
    reveal_hidden=True の場合は、判明トリガーに関わらず本当の役職を返す（最終開示用）。
    """
    real_role = game.roles.get(player_id)
    if not real_role:
        return "不明"

    # 強制開示モード
    if reveal_hidden:
        return real_role

    # 裏役職の判明判定
    if real_role in URA_YAKUSHOKU:
        trigger, fake = URA_YAKUSHOKU[real_role]
        revealed = game.ura_reveal_triggers.get(player_id, False)

        if not revealed:
            # 未判明の場合、偽装役職を返す
            if real_role == "アホ":
                return game.aho_fake_role.get(player_id, "一般通過あごむに")
            else:
                return fake if fake else "一般通過あごむに"

    return real_role

# ======================================================
#  裏役職の判明トリガーをチェック
# ======================================================
async def _check_and_reveal_ura_yakushoku(game, player_id: int, trigger_type: str):
    """
    trigger_type: "death" or "end"
    該当するトリガーが満たされたプレイヤーの裏役職を判明させる。
    """
    real_role = game.roles.get(player_id)
    if not real_role or real_role not in URA_YAKUSHOKU:
        return

    ura_trigger, _ = URA_YAKUSHOKU[real_role]
    should_reveal = False

    if trigger_type == "death" and ura_trigger == "death_or_end":
        should_reveal = True
    elif trigger_type == "end":
        should_reveal = True

    if should_reveal:
        game.ura_reveal_triggers[player_id] = True

# ======================================================
#  Cog 本体
# ======================================================
class JinrouCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games = {}

    def get_game(self, channel_id) -> JinrouGame:
        if channel_id not in self.games:
            self.games[channel_id] = JinrouGame()
        return self.games[channel_id]

    def get_wolves_names(self, game) -> str:
        wolves = []
        for p_id, role in game.roles.items():
            if role in ["人狼", "デカ狼"]:
                m = game.game_channel.guild.get_member(p_id)
                if m: wolves.append(m.display_name)
        return "、".join(wolves) if wolves else "なし"

    # ======================================================
    #  メッセージ監視（サイレンス＆議長コマンド）
    # ======================================================
    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return

        # 元のサーバーのチャンネルには、以前のローカル用のゲーム（止まっているもの）が残っていることがある。
        # それが動いていないときは、このチャンネルが入っているグローバルゲームを探す
        game = self.games.get(message.channel.id)
        if not game or not game.is_running:
            for g in self.games.values():
                if g.is_running and getattr(g, "is_global", False) and message.channel.id in [c.id for c in g.channels]:
                    game = g
                    break

        if not game or not game.is_running:
            return

        # 死亡・追放された参加者は、昼・夜・投票中を問わず発言できない
        if game.is_dead_player(message.author.id):
            try: await message.delete()
            except Exception:
                logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
            return

        player_role = game.roles.get(message.author.id)
        is_alive = any(p.id == message.author.id for p in game.alive_players)

        if is_alive and player_role == "ネット民":
            if game.in_discussion:
                try: await message.delete()
                except Exception:
                    logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                return
        else:
            if message.author.id in game.silenced_players:
                try: await message.delete()
                except Exception:
                    logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                return

        if game.in_discussion:
            if player_role == "議長" and is_alive:
                content = message.content.strip()

                if content == "スキップ":
                    if game.chairman_skip_event and not game.chairman_skip_event.is_set():
                        await game.game_channel.send("議長がスキップを宣言。議論を終了し投票フェーズに移行します。")
                        game.chairman_skip_event.set()

                elif content == "強制投票" and not game.chairman_ketsugu_used:
                    game.chairman_ketsugu_used = True
                    game.chairman_forced_vote = True
                    if game.chairman_skip_event and not game.chairman_skip_event.is_set():
                        game.chairman_skip_event.set()
                    await game.game_channel.send(
                        "議長が強制投票を宣言！ 議論を中断し、議長による投票に移行します。"
                    )

            if getattr(game, "is_global", False):
                import time
                now = time.time()
                last_time = game.last_speak_time.get(message.author.id, 0)
                if now - last_time < 1.0:
                    try: await message.delete()
                    except Exception:
                        logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
                    return
                game.last_speak_time[message.author.id] = now

                escaped_content = discord.utils.escape_mentions(message.content)

                if not hasattr(self, "webhook_cache"):
                    self.webhook_cache = {}

                for chan in game.channels:
                    if chan.id != message.channel.id:
                        try:
                            webhook = self.webhook_cache.get(chan.id)
                            if not webhook:
                                webhooks = await chan.webhooks()
                                webhook = discord.utils.get(webhooks, name="Jinrou-Global")
                                if not webhook:
                                    webhook = await chan.create_webhook(name="Jinrou-Global")
                                self.webhook_cache[chan.id] = webhook

                            await webhook.send(
                                content=escaped_content,
                                username=f"{message.author.display_name} ({message.guild.name})",
                                avatar_url=message.author.display_avatar.url,
                                allowed_mentions=discord.AllowedMentions.none()
                            )
                        except Exception:
                            logger.debug("人狼: グローバル対戦の発言転送に失敗しました", exc_info=True)
    # ======================================================
    #  役職割当
    # ======================================================
    def assign_roles(self, game):
        num = len(game.players)
        num_wolves = max(1, num // 4)

        # メンヘラの発展先としてヤンデレを追加
        promotion_map = {
            "人狼":             "デカ狼",
            "騎士":             "罠師",
            "一般通過あごむに": "タフむに",
            "狂人":             "狂信者",
            "入狼":             "ワンころ",
            "ハゲ":             "コウモリむに",
            "霊媒師":           "大霊媒師",
            "陽キャ":           "ミュージシャン",
            "ビー玉ブレイカー": "もくもく",
            "メンヘラ":         "ヤンデレ",
        }

        def maybe_promote(role):
            # ベーシックモード時は発展職（昇格）を発生させない
            if game.game_mode == "ベーシック":
                return role
            if role in promotion_map and random.random() < 0.35:
                return promotion_map[role]
            return role

        excluded = set(game.excluded_roles)
        required = list(game.required_roles)

        pool = list(required)

        wolf_in_req = sum(1 for r in required if r in ["人狼", "デカ狼"])
        additional_wolves = max(0, num_wolves - wolf_in_req)
        for _ in range(min(additional_wolves, num - len(pool))):
            pool.append(maybe_promote("人狼"))

        # 候補プールに「ネット民」と「アホ」を追加
        candidates = [
            r for r in [
                "占い師", "騎士", "霊媒師", "パン屋", "マサイ族", "入狼",
                "議長", "ビー玉ブレイカー", "陽キャ", "狂人", "ハゲ", "メンヘラ", "あごむに破道砲", "ネット民", "アホ"
            ]
            if r not in excluded and r not in required
        ]
        random.shuffle(candidates)
        ci = 0

        while len(pool) < num:
            if random.random() < 0.65 and ci < len(candidates):
                r = candidates[ci]; ci += 1
                pool.append(maybe_promote(r))
            else:
                pool.append(maybe_promote("一般通過あごむに"))

        pool = pool[:num]

        # 2人役職はプロモード時（発展職が有効な設定）のみ発生させる仕様に準拠
        if game.game_mode == "プロ" and num >= 8 and random.random() < 0.3:
            pair_type = random.choice(["リア充", "貴族奴隷"])
            pair_roles = ["リア充", "リア充"] if pair_type == "リア充" else ["貴族", "奴隷"]

            replaceable = [i for i, r in enumerate(pool) if r in ["一般通過あごむに", "タフむに"]]
            if len(replaceable) >= 2:
                idxs = random.sample(replaceable, 2)
                for i, idx in enumerate(idxs):
                    pool[idx] = pair_roles[i]
            elif len(replaceable) == 1:
                pool[replaceable[0]] = pair_roles[0]
                if len(pool) < num:
                    pool.append(pair_roles[1])
                else:
                    pool[-1] = pair_roles[1]
            else:
                safe = [i for i, r in enumerate(pool) if r not in ["人狼", "デカ狼", "占い師"]]
                if len(safe) >= 2:
                    idxs = random.sample(safe, 2)
                    for i, idx in enumerate(idxs):
                        pool[idx] = pair_roles[i]

        pool = pool[:num]
        random.shuffle(pool)

        for i, p in enumerate(game.players):
            game.roles[p.id] = pool[i]
            game.display_roles[p.id] = pool[i]  # 最初は表示用も本当の役職
            game.ura_reveal_triggers[p.id] = False  # 裏役職は未判明

            # アホの場合、偽装役職をランダムに選択
            if pool[i] == "アホ":
                game.aho_fake_role[p.id] = random.choice(AHO_FAKE_CANDIDATES)

        # ヤンデレが選択された場合、生存している人狼陣営からランダムで1人対象を選ぶ
        wolves_ids = [p_id for p_id, r in game.roles.items() if r in ["人狼", "デカ狼"]]
        for p_id, r in game.roles.items():
            if r == "ヤンデレ" and wolves_ids:
                game.yandere_targets[p_id] = random.choice(wolves_ids)

        riacchu_ids = []
        kizoku_id = dorei_id = None
        for p in game.players:
            role = game.roles[p.id]
            if role == "リア充":   riacchu_ids.append(p.id)
            elif role == "貴族":   kizoku_id = p.id
            elif role == "奴隷":   dorei_id = p.id

        if len(riacchu_ids) >= 2:
            game.riacchu_pairs.append((riacchu_ids[0], riacchu_ids[1]))
        if kizoku_id and dorei_id:
            game.kizoku_slave[kizoku_id] = dorei_id

    # ======================================================
    #  もくもく死亡時の役職構成公開
    # ======================================================
    async def _check_mokumoku_reveal(self, game, dead_id):
        if game.roles.get(dead_id) != "もくもく":
            return
        if any(game.roles.get(p.id) == "もくもく" for p in game.alive_players):
            return
        roles_for_display = []
        for r in game.roles.values():
            if r == "タフむに":         roles_for_display.append("一般通過あごむに")
            elif r == "入狼":           roles_for_display.append("一般通過あごむに")
            elif r == "大霊媒師":       roles_for_display.append("霊媒師")
            elif r == "ミュージシャン":  roles_for_display.append("陽キャ")
            elif r == "もくもく":       roles_for_display.append("一般通過あごむに")
            elif r == "ヤンデレ":       roles_for_display.append("メンヘラ")
            elif r == "ビー玉ブレイカー": roles_for_display.append("一般通過あごむに")
            elif r == "アホ":           roles_for_display.append(game.aho_fake_role.get(game.players[[p.id for p in game.players if game.roles.get(p.id) == "アホ"][0]].id if any(p.id for p in game.players if game.roles.get(p.id) == "アホ") else None, "一般通過あごむに"))
            else:                       roles_for_display.append(r)
        roles_list = " / ".join(set(roles_for_display))
        await game.game_channel.send(f"もくもくが姿を消した。役職構成が明らかになります！\n{roles_list}")

    # ======================================================
    #  コマンド
    # ======================================================
    async def force_end(self, interaction: discord.Interaction):
        """/game の人狼画面の「ゲームを終了」から呼ぶ。参加者・ホスト・管理者のみ（UNO の終了ボタンと同じ）。"""
        game = self.get_game(interaction.channel_id)
        if not game.is_running:
            embed = discord.Embed(description="このチャンネルで実行中のゲームはありません。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if not can_end_game(game, interaction.user):
            embed = discord.Embed(description="人狼を終了できるのは参加者・ホスト・管理者だけです。", color=0xFFFFFF)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        game.is_running = False
        game.silenced_players.clear()
        game.in_discussion = False
        if game.chairman_skip_event:
            game.chairman_skip_event.set()
        if game.chairman_vote_event:
            game.chairman_vote_event.set()
        embed = discord.Embed(description=f"<@{interaction.user.id}> さんがゲームを強制終了しました。", color=0xFFFFFF)
        await interaction.response.send_message(embed=embed)

    async def start_recruit(self, interaction: discord.Interaction, mode: str = "local"):
        """/game のハブから呼ぶ。このチャンネルで設定パネルを出す（mode は local / global）。"""
        await self.open_setup(interaction, mode if mode in ("local", "global") else "local")

    async def open_setup(self, interaction: discord.Interaction, mode: str = "local"):
        # 追加
        if mode == "global":
            game = self.games.get("global")
            if game and game.is_running:
                if all(c.id != interaction.channel.id for c in game.channels):
                    game.channels.append(interaction.channel)
                embed = discord.Embed(
                    title="グローバル人狼ゲーム（合流）",
                    description="既に他サーバーで起動中のグローバル人狼ゲームがあります。\n参加ボタンを押して合流してください。",
                    color=0xFFFFFF
                )
                await interaction.response.send_message(embed=embed, view=GlobalJoinView(self, game))
                return
            else:
                game = JinrouGame()
                self.games["global"] = game
                game.is_global = True
                game.channels = [interaction.channel]
                game._original_channel = interaction.channel
                game.game_channel = GlobalChannelProxy(game)
        else:
            game = self.get_game(interaction.channel_id)
            if game.is_running:
                embed = discord.Embed(description="このチャンネルでは既にゲームが進行中です。", color=0xFFFFFF)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            game._original_channel = interaction.channel
            game.game_channel = interaction.channel

        # 前のゲームの状態（yandere_targets・mokumoku_turns なども含む）をすべて初期化する
        game.reset_for_new_game()
        game.is_running = True
        game.host_id = interaction.user.id

        embed = discord.Embed(
            title="人狼ゲーム設定",
            description="必須役職・除外役職を設定してください。（各最大4つ）\n設定後「確定してパネルを送信」を押してください。",
            color=0xFFFFFF
        )
        await interaction.response.send_message(
            embed=embed,
            view=SetupView(game, self, game.game_channel),
            ephemeral=True
        )

    async def rating_embed(self, user) -> discord.Embed:
        """/game の人狼画面の「レート」から呼ぶ。自分のレートと、レート上位10人。"""
        rating = await get_player_rating(user.id)
        rankings = await get_top_ratings(10)
        lines = []
        for i, entry in enumerate(rankings or [], 1):
            player_id = entry["player_id"]
            try:
                fetched = await self.bot.fetch_user(player_id)
                name = fetched.display_name if fetched else f"ID: {player_id}"
            except Exception:
                logger.debug("人狼: プレイヤー名の解決に失敗しました", exc_info=True)
                name = f"ID: {player_id}"
            lines.append(f"{i}. **{name}**: {entry['rating']:.0f} pts")
        ranking_text = "\n".join(lines) if lines else "ランキングデータがまだありません。"
        return discord.Embed(
            title="人狼レーティング",
            description=f"**{user.display_name}** さんのレート: {rating:.0f} pts\n\n**レート上位10人**\n{ranking_text}",
            color=0xFFFFFF,
        )

    async def run_from_hub(self, game: JinrouGame, channel, host_id: int = None):
        """play.py から create_task で呼ぶ。60秒待機してゲームループを開始する。"""
        if host_id:
            game.host_id = host_id
        await asyncio.sleep(60)
        if not game.is_running:
            return
        await self._start_game_loop(game, channel)

    # ======================================================
    #  ゲームループ
    # ======================================================
    async def _start_game_loop(self, game: JinrouGame, channel):
        if len(game.players) < 5:
            game.is_running = False
            await channel.send(f"{FAILED}参加者が5人未満のため、ゲームを中止します。")
            return

        game.alive_players = game.players.copy()
        game.started = True
        self.assign_roles(game)

        mentions = " ".join([p.mention for p in game.players])

        is_mokumoku_active = any(game.roles.get(p.id) == "もくもく" for p in game.alive_players) and game.mokumoku_turns < 3
        if is_mokumoku_active:
            roles_list = "（もくもくにより非公開）"
        else:
            roles_for_display = []
            for p_id, r in game.roles.items():
                display_r = _get_display_role(game, p_id, reveal_hidden=False)
                roles_for_display.append(display_r)
            roles_list = " / ".join(set(roles_for_display))

        await game_panels.replace(channel, "party",
            f"{SUCCESS}{mentions}\nゲーム開始。今回の役職内訳: {roles_list}\n下のボタンで自分の役職確認を行ってください。",
            view=RoleCheckView(game, self)
        )

        for p in game.players:
            role = game.roles[p.id]
            if role == "リア充":
                for pair in game.riacchu_pairs:
                    if p.id in pair:
                        other_id = pair[1] if pair[0] == p.id else pair[0]
                        other_m = channel.guild.get_member(other_id)
                        name = other_m.display_name if other_m else "不明"
                        try: await p.send(f"【リア充】あなたの相方は {name} さんです。")
                        except Exception:
                            logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)
            elif role == "貴族":
                slave_id = game.kizoku_slave.get(p.id)
                if slave_id:
                    slave_m = channel.guild.get_member(slave_id)
                    name = slave_m.display_name if slave_m else "不明"
                    try: await p.send(f"【貴族】あなたの奴隷は {name} さんです。")
                    except Exception:
                        logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)
            elif role == "奴隷":
                for k_id, s_id in game.kizoku_slave.items():
                    if s_id == p.id:
                        k_m = channel.guild.get_member(k_id)
                        name = k_m.display_name if k_m else "不明"
                        try: await p.send(f"【奴隷】あなたのご主人様（貴族）は {name} さんです。")
                        except Exception:
                            logger.debug("人狼: 役職情報のDM送信に失敗しました", exc_info=True)

        try:
            await self.run_discussion(game, seconds=150, title="特別ディスカッション")

            while game.is_running:
                await self.run_night_phase(game)
                if not game.is_running or await self.check_victory(game): break

                game.chairman_ketsugu_target = None
                game.chairman_forced_vote = False
                await self.run_discussion(game, seconds=150, title="昼のディスカッション")
                if not game.is_running: break

                before_vote = {p.id for p in game.alive_players}
                if game.chairman_forced_vote:
                    game.chairman_forced_vote = False
                    await self.run_chairman_vote_phase(game)
                else:
                    await self.run_voting_phase(game)
                jinrou_review.record_day(game, game.day_count,
                                         [p.id for p in game.players if p.id in before_vote and p.id not in {a.id for a in game.alive_players}])

                if not game.is_running or await self.check_victory(game): break

        except Exception as e:
            logger.exception("人狼のゲームループでエラーが発生しました")
        finally:
            # 終了時は発言制限をすべて解除する（死亡者の制限も解く）
            game.silenced_players.clear()
            game.in_discussion = False
            game.started = False
            if game.roles:
                try: await self._announce_final_roles(game)
                except Exception:
                    logger.debug("人狼: 最終役職の発表に失敗しました", exc_info=True)
                if game.review:
                    try: await game.game_channel.send(embed=jinrou_review.build_embed(game))
                    except Exception:
                        logger.debug("人狼: 振り返りEmbedの送信に失敗しました", exc_info=True)
            game.is_running = False

    async def run_discussion(self, game, seconds, title):
        if not game.is_running: return
        game.chairman_skip_event = asyncio.Event()
        game.in_discussion = True

        game.silenced_players.clear()

        minutes_str = f"{seconds // 60}分{seconds % 60}秒" if seconds % 60 else f"{seconds // 60}分"
        await game_panels.replace(game.game_channel, "party", f"ーー {title}（{minutes_str}） ーー",
                                     view=jinrou_guide.PhaseHelpView("day", _guide_role_lookup(game), timeout=seconds + 30))
        if any(game.roles.get(p.id) == "パン屋" for p in game.alive_players):
            await game.game_channel.send("<:PANYA:1490254577558093944>パン屋がパンを焼きました")

        for _ in range(seconds):
            if game.chairman_skip_event.is_set():
                break
            await asyncio.sleep(1)
            if not game.is_running:
                game.in_discussion = False
                return

        game.in_discussion = False
        await game.game_channel.send(f"ーー {title}終了 ーー")

    async def run_night_phase(self, game):
        if not game.is_running: return
        game.day_count += 1
        await game.game_channel.send(f"ーー 第{game.day_count}夜（1分） ーー")

        game.silenced_players.clear()
        game.silenced_players.update(p.id for p in game.alive_players if game.roles.get(p.id) != "ネット民")

        game.night_actions = {}
        view = NightActionView(game)
        view.add_item(jinrou_guide.PhaseHelpButton("night", _guide_role_lookup(game)))
        msg = await game_panels.replace(game.game_channel, "party", "アクションを選択してください", view=view)

        req_roles_single = ["占い師", "騎士", "罠師", "あごむに破道砲", "マサイ族", "陽キャ"]
        if game.day_count == 1: req_roles_single.append("ワンころ")
        # 人狼・デカ狼以外の役職の生存者数を数える
        req = sum(1 for p in game.alive_players if game.roles.get(p.id) in req_roles_single)

        # 人狼・デカ狼が1人でも生存していれば、要求アクション数を +1 する
        if any(game.roles.get(p.id) in ["人狼", "デカ狼"] for p in game.alive_players):
            req += 1

        alive_ids = {p.id for p in game.alive_players}
        has_dead = any(p.id not in alive_ids for p in game.players)
        req += sum(1 for p in game.alive_players if game.roles.get(p.id) == "大霊媒師" and has_dead)
        req += sum(1 for p in game.alive_players if game.roles.get(p.id) == "ミュージシャン" and not game.musician_party_used)

        t = 0
        while len(game.night_actions) < req and t < 60:
            await asyncio.sleep(1)
            t += 1
            if not game.is_running: break

        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)

        if game.is_running:
            await self._autoplay_night(game)
        game.silenced_players.clear()
        await self.process_night_results(game)

    # ------------------------------------------------------------------ 放置した人の代打ち（core/autoplay）
    # 代わりに選ぶのは、選ぶだけで済む役職だけ（占い師・騎士・罠師・マサイ族・初日のワンころ・人狼の襲撃）。
    # 破道砲のように使うと取り返しがつかないものや、待機を選べる役職は放置のままにする。
    AUTOPLAY_NIGHT_ROLES = ("占い師", "騎士", "罠師", "マサイ族")

    def _member_name(self, game, p_id) -> str:
        guild = getattr(game.game_channel, "guild", None)
        m = guild.get_member(p_id) if guild else None
        return m.display_name if m else str(p_id)

    def _autoplay_state(self, game, p_id, phase: str) -> dict:
        return {"game": "jinrou", "phase": phase, "day": game.day_count,
                "my_role": game.roles.get(p_id),
                "alive": [self._member_name(game, p.id) for p in game.alive_players]}

    async def _autoplay_pick_target(self, game, p_id, phase, legal_ids, instructions, describe_verb, fallback=None):
        names = {}
        for t in legal_ids:  # 同名の人がいても選択肢が重ならないようにする
            n = self._member_name(game, t)
            names[t] = n if n not in names.values() else f"{n} ({t})"
        legal = list(names.values())
        result = await autoplay.take_idle_turn(
            game.game_channel, guild_id=getattr(getattr(game.game_channel, "guild", None), "id", None),
            player_name=self._member_name(game, p_id), game=game,
            state=self._autoplay_state(game, p_id, phase), legal_actions=legal, instructions=instructions,
            describe=describe_verb, fallback=names.get(fallback, None))
        if result is None or result.action is None:
            return result, None
        return result, next(t for t, n in names.items() if n == result.action)

    async def _autoplay_night(self, game):
        """夜のアクションをしなかった人の分を代わりに選ぶ（代打ちがオフのサーバーでは何もしない）。"""
        try:
            alive_ids = [p.id for p in game.alive_players]
            wolves = [pid for pid in alive_ids if game.roles.get(pid) in ("人狼", "デカ狼")]
            if wolves and not any(w in game.night_actions for w in wolves):
                targets = [pid for pid in alive_ids if not _is_wolf_side(game, pid)]
                if targets:
                    result, t_id = await self._autoplay_pick_target(
                        game, wolves[0], "night", targets, "人狼として今夜襲撃する相手を 1 人選んでください。",
                        lambda a: "夜のアクションを")
                    if result is None:
                        return
                    if t_id is not None and wolves[0] not in game.night_actions:
                        game.night_actions[wolves[0]] = t_id
            for pid in alive_ids:
                role = game.roles.get(pid)
                is_wan = role == "ワンころ" and game.day_count == 1
                if pid in game.night_actions or not (role in self.AUTOPLAY_NIGHT_ROLES or is_wan):
                    continue
                targets = [t for t in alive_ids if t != pid]
                if not targets:
                    continue
                result, t_id = await self._autoplay_pick_target(
                    game, pid, "night", targets, f"{role}として今夜の対象を 1 人選んでください。",
                    lambda a: "夜のアクションを")
                if result is None:
                    return
                if t_id is None or pid in game.night_actions:
                    continue
                game.night_actions[pid] = t_id
                await self._notify_autoplay_night(game, pid, role, t_id)
        except Exception:
            logger.exception("人狼の夜の代打ちでエラー（放置のまま続けます）")

    async def _notify_autoplay_night(self, game, pid, role, t_id):
        """代わりに選んだ結果を、本人にだけ DM で知らせる（占いの結果・マサイ族の回避など）。"""
        t_name = self._member_name(game, t_id)
        if role == "占い師":
            r = game.roles.get(t_id)
            res = "白" if r == "デカ狼" else uranai_color(r)
            if any(game.roles.get(p.id) == "ビー玉ブレイカー" for p in game.alive_players) and random.random() < 0.3:
                res = "白" if res == "黒" else "黒"
            jinrou_review.note_divine(game, pid, t_id, res)
            text = f"放置したため、代わりに {t_name} を占いました。占い結果: 【{res}】"
        elif role == "マサイ族":
            if game.roles.get(t_id) in ["人狼", "デカ狼"]:
                game.masai_evasion[pid] = True
            text = f"放置したため、代わりに {t_name} を観察しました。"
        else:
            text = f"放置したため、代わりに {t_name} を対象に選びました。"
        guild = getattr(game.game_channel, "guild", None)
        m = guild.get_member(pid) if guild else None
        try:
            if m is not None:
                await m.send(text)
        except Exception:
            logger.debug("人狼: 代打ち通知のDM送信に失敗しました", exc_info=True)

    async def _autoplay_votes(self, game):
        """投票しなかった生存者の分を代わりに選ぶ（d1 が使えないときはスキップ。オフのサーバーでは何もしない）。"""
        try:
            for p in list(game.alive_players):
                if p.id in game.voted_count:
                    continue
                legal = [t.id for t in game.alive_players if t.id != p.id]
                names = {}
                for t in legal:
                    n = self._member_name(game, t)
                    names[str(t)] = n if n not in names.values() else f"{n} ({t})"
                names["skip"] = "スキップ"
                result = await autoplay.take_idle_turn(
                    game.game_channel, guild_id=getattr(getattr(game.game_channel, "guild", None), "id", None),
                    player_name=self._member_name(game, p.id), game=game,
                    state=self._autoplay_state(game, p.id, "vote"), legal_actions=list(names.values()),
                    instructions="追放する人に投票してください。決められないときは「スキップ」を選んでください。",
                    describe=lambda a: "スキップに投票" if a == "スキップ" else f"{a} さんに投票",
                    fallback="スキップ")
                if result is None:
                    return
                if result.action is None or p.id in game.voted_count:
                    continue
                game.voted_count[p.id] = next(k for k, n in names.items() if n == result.action)
        except Exception:
            logger.exception("人狼の投票の代打ちでエラー（放置のまま続けます）")

    async def process_night_results(self, game):
        if not game.is_running: return

        # もくもくの効果適用判定
        is_mokumoku_active = any(game.roles.get(p.id) == "もくもく" for p in game.alive_players) and game.mokumoku_turns < 3

        # ログ送信用の内部関数（もくもく効果中ならコメントを差し替える）
        async def send_log(message: str):
            if is_mokumoku_active:
                await game.game_channel.send("もくもく")
            else:
                await game.game_channel.send(message)

        alive_before = [p.id for p in game.alive_players]
        actions_snapshot = dict(game.night_actions)
        attack_results = {}  # 振り返り表用 {人狼: (対象, 結果)}
        dead_ids = set()
        wolf_attacks   = {}
        knight_targets = set()
        trap_targets   = {}

        # メンヘラおよびヤンデレのIDを物理消去の判定用セットに格納
        psycho_killer_ids = {p.id for p in game.alive_players if game.roles.get(p.id) == "メンヘラ"}

        # ヤンデレに紐づいている人狼が夜に関与された場合、関与したプレイヤーを返り討ちにする
        yandere_triggered_by = set()
        for yandere_id, wolf_id in game.yandere_targets.items():
            if yandere_id in {p.id for p in game.alive_players}:
                yandere_triggered_by.add(wolf_id)

        menhera_triggered = False
        cancelled_ids = set()
        musician_protected = set()

        # ミュージシャンのパーティ処理
        for p_id, t_id in game.night_actions.items():
            role = game.roles.get(p_id)
            if role == "ミュージシャン" and t_id == 0 and not game.musician_party_used:
                game.musician_party_used = True
                candidates = [p for p in game.alive_players if p.id != p_id]
                party_count = min(4, len(candidates))
                if party_count > 0:
                    party_members = random.sample(candidates, party_count)
                    party_ids = {p.id for p in party_members}
                    party_names = []
                    for pid in party_ids:
                        m = game.game_channel.guild.get_member(pid)
                        if m: party_names.append(m.display_name)

                    await send_log(f"ミュージシャンがパーティを開催！ {', '.join(party_names)} が招待されました！")

                    for pid in party_ids:
                        cancelled_ids.add(pid)
                        musician_protected.add(pid)

                    wolf_in_party = [pid for pid in party_ids if game.roles.get(pid) in ["人狼", "デカ狼"]]
                    if wolf_in_party and random.random() < 0.3:
                        non_wolf_party = [pid for pid in party_ids if game.roles.get(pid) not in ["人狼", "デカ狼"]]
                        if non_wolf_party:
                            victim_id = random.choice(non_wolf_party)
                            dead_ids.add(victim_id)
                            victim_m = game.game_channel.guild.get_member(victim_id)
                            if victim_m:
                                await send_log(f"<:music:1561710964238450809> パーティに人狼が紛れ込んでいた！ {victim_m.display_name} が犠牲になりました...")
                break

        # 陽キャのアクション処理
        for p_id, t_id in list(game.night_actions.items()):
            role = game.roles.get(p_id)
            if role != "陽キャ" or p_id in cancelled_ids:
                continue

            t_role = game.roles.get(t_id)
            target_m = game.game_channel.guild.get_member(t_id)
            target_name = target_m.display_name if target_m else "不明"
            yoikya_m = game.game_channel.guild.get_member(p_id)
            yoikya_name = yoikya_m.display_name if yoikya_m else "不明"

            if t_role in ["人狼", "デカ狼"]:
                dead_ids.add(p_id)
                await send_log(f"{yoikya_name} が {target_name} をℳ𝓎𝒽ℴ𝓂ℯに誘ったが人狼に返り討ちにあった...")
            elif t_role == "メンヘラ":
                game.roles[p_id] = "リア充"
                game.roles[t_id] = "リア充"
                game.riacchu_pairs.append((p_id, t_id))
                psycho_killer_ids.discard(t_id)
                await send_log(f"{yoikya_name} が {target_name}（メンヘラ）を堕とした！ 2人はリア充へと変化しました！")
            else:
                cancelled_ids.add(t_id)
                await send_log(f"{yoikya_name} が {target_name} をℳ𝓎𝒽ℴ𝓂ℯに誘って酔い潰した！ {target_name} の夜のアクションはキャンセルされました。")

        # 各役職のアクションおよび関与の精査
        for p_id, t_id in game.night_actions.items():
            role = game.roles.get(p_id)
            if p_id in cancelled_ids or t_id == 0:
                continue

            # メンヘラへの直接関与、またはヤンデレ対象の人狼への夜の関与のチェック
            if t_id in psycho_killer_ids or t_id in yandere_triggered_by:
                dead_ids.add(p_id)
                menhera_triggered = True

            if role in ["人狼", "デカ狼"]:
                wolf_attacks[p_id] = t_id
            elif role == "騎士":
                knight_targets.add(t_id)
            elif role == "罠師":
                trap_targets[t_id] = p_id
            elif role == "あごむに破道砲":
                dead_ids.add(p_id); dead_ids.add(t_id)
                game.used_hadouhou = True
                others = [p.id for p in game.alive_players if p.id not in [p_id, t_id]]
                if others: dead_ids.add(random.choice(others))
                await send_log("あごむに破道砲が火を噴きました。")
            elif role == "ワンころ" and game.day_count == 1:
                game.wan_owner[p_id] = t_id

        if menhera_triggered:
            await send_log("<:MENHERA:1490254584739008522>誰かがメンヘラ（またはヤンデレの呪い）に返り討ちにされました。")

        # 人狼の襲撃処理
        for wolf_id, target_id in wolf_attacks.items():
            if wolf_id in dead_ids:
                attack_results[wolf_id] = (target_id, "attacker_dead")
                continue
            if target_id in trap_targets:
                dead_ids.add(wolf_id)
                attack_results[wolf_id] = (target_id, "trapped")
                await send_log("罠師の罠が発動！ 狼が罠にかかりました。")
                continue
            if target_id in knight_targets or target_id in musician_protected:
                attack_results[wolf_id] = (target_id, "guarded" if target_id in knight_targets else "party")
                continue
            if game.roles.get(target_id) == "マサイ族" and game.masai_evasion.get(target_id):
                if random.random() < 0.5:
                    attack_results[wolf_id] = (target_id, "evaded")
                    await send_log("<:MASAI:1490254590757572758>マサイ族は襲撃を回避しました。")
                    continue
            attack_results[wolf_id] = (target_id, "success")
            dead_ids.add(target_id)

        # 貴族・奴隷・リア充等の死亡連動処理（既存コードを維持）
        final_dead = set()
        already_substituted = set()
        for d_id in list(dead_ids):
            if d_id in already_substituted: continue
            if game.roles.get(d_id) == "貴族":
                slave_id = game.kizoku_slave.get(d_id)
                if slave_id and slave_id in {p.id for p in game.alive_players} and slave_id not in dead_ids:
                    await send_log("貴族の死亡判定が奴隷に肩代わりされました。")
                    final_dead.add(slave_id)
                    already_substituted.add(slave_id)
                    continue
            final_dead.add(d_id)

        for pair in game.riacchu_pairs:
            if pair[0] in final_dead or pair[1] in final_dead:
                final_dead.add(pair[0]); final_dead.add(pair[1])

        # 生存者リスト更新
        if final_dead:
            for d_id in list(final_dead):
                if d_id not in {p.id for p in game.alive_players}: continue
                m = game.game_channel.guild.get_member(d_id)
                if m:
                    await send_log(f"夜の結果: {m.display_name} さんが犠牲になりました。")

                    # 裏役職の判明トリガーチェック（死亡時）
                    await _check_and_reveal_ura_yakushoku(game, d_id, "death")

                    if game.roles.get(d_id) == "タフむに":
                        killers = [pid for pid, tid in game.night_actions.items() if tid == d_id and pid not in final_dead and pid in {p.id for p in game.alive_players}]
                        if killers:
                            k_id = random.choice(killers)
                            k_m = game.game_channel.guild.get_member(k_id)
                            if k_m:
                                await send_log(f"タフむにの反撃。 {k_m.display_name} を道連れにしました。")
                                game.alive_players = [p for p in game.alive_players if p.id != k_id]

                    game.alive_players = [p for p in game.alive_players if p.id != d_id]
                    await self._check_mokumoku_reveal(game, d_id)
        else:
            await send_log("<:KISHI:1490254592800456794>夜の結果: 昨晩の犠牲者はいないようです。")

        alive_after = {p.id for p in game.alive_players}
        jinrou_review.record_night(game, game.day_count, actions_snapshot, cancelled_ids, attack_results,
                                   [uid for uid in alive_before if uid not in alive_after])

        # もくもくの経過ターンカウントをインクリメント
        if any(game.roles.get(p.id) == "もくもく" for p in game.alive_players):
            game.mokumoku_turns += 1

        if game.alive_players:
            survivors_mention = " ".join(p.mention for p in game.alive_players)
            await game.game_channel.send(f"夜が明けました。生存者（{len(game.alive_players)}人）: {survivors_mention}")

    # ======================================================
    #  勝利判定
    # ======================================================
    async def check_victory(self, game):
        if not game.is_running: return True

        wolves_alive = [p for p in game.alive_players if game.roles.get(p.id) in ["人狼", "デカ狼"]]
        if not wolves_alive:
            await game.game_channel.send("人狼全滅。村人陣営の勝利です。")
            await self._check_koumorimuni_win(game)
            await self._record_team_win(game, winner_is_wolf=False)
            await self._process_elo_ratings(game, winner_is_wolf=False)
            game.is_running = False
            return True

        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        wolves    = [p for p in game.alive_players if is_wolf_side(p.id)]
        non_wolves = [p for p in game.alive_players if not is_wolf_side(p.id)]

        if len(wolves) >= len(non_wolves):
            await game.game_channel.send("人狼が支配した。人狼陣営の勝利です。")
            await self._check_koumorimuni_win(game)
            await self._record_team_win(game, winner_is_wolf=True)
            await self._process_elo_ratings(game, winner_is_wolf=True)
            game.is_running = False
            return True

        return False

    # ランキング（core/party_ranking.py）
    # - 村人・人狼の勝ち: 勝った陣営の参加者全員（死んだ人も含む）に 1 勝。陣営の分け方は Elo と同じ
    #   （人狼・デカ狼・狂人・狂信者・ヤンデレ・野良のワンころが人狼側、それ以外が村人側）
    # - ハゲ・コウモリむには勝ち方が別なので陣営の勝ちには入れない。ハゲは追放されたとき、
    #   コウモリむには陣営の勝負がついたときに生き残っていれば、その人だけ 1 勝
    async def _record_wins(self, game, user_ids):
        guild = getattr(getattr(game, "game_channel", None), "guild", None)
        if guild is None:
            return
        for uid in dict.fromkeys(user_ids):
            await party_ranking.shared().record_win(guild.id, uid, "jinrou")

    async def _record_team_win(self, game, winner_is_wolf: bool):
        alive_ids = {p.id for p in game.alive_players}

        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        winners = []
        for p in game.players:
            role = game.roles.get(p.id)
            if role == "ハゲ":
                continue
            if role == "コウモリむに":
                if p.id in alive_ids:
                    winners.append(p.id)
                continue
            if is_wolf_side(p.id) == winner_is_wolf:
                winners.append(p.id)
        await self._record_wins(game, winners)

    async def _check_koumorimuni_win(self, game):
        koumoris = [p for p in game.alive_players if game.roles.get(p.id) == "コウモリむに"]
        if not koumoris:
            return
        names_list = []
        for p in koumoris:
            m = game.game_channel.guild.get_member(p.id)
            if m: names_list.append(m.display_name)
        if names_list:
            await game.game_channel.send(f"さらに、{'、'.join(names_list)} は最後まで生き残り個人勝利しました！")

    async def _process_elo_ratings(self, game, winner_is_wolf: bool):
        """ゲーム結果をもとにEloレーティングを更新"""
        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        players = list(game.players)
        if not players:
            return
        try:
            # 先に全員の今のレートを読んでおき、平均も 1 回だけ計算する（更新の順番で結果が変わらないように）。
            # 以前は sum(await ... for ...) が非同期ジェネレーターになって TypeError で落ち、1 件も保存されていなかった。
            before = {p.id: await get_player_rating(p.id) for p in players}
            avg_rating = sum(before.values()) / len(before)
            for p in players:
                p_id = p.id
                player_is_wolf_side = is_wolf_side(p_id)
                rating = before[p_id]
                won = player_is_wolf_side == winner_is_wolf
                if won:
                    rating_change, _ = calculate_elo_change(rating, avg_rating, player_is_wolf_side)
                else:
                    _, rating_change = calculate_elo_change(avg_rating, rating, not player_is_wolf_side)
                new_rating = max(0, rating + rating_change)
                await update_player_rating(p_id, new_rating, won=won)
        except Exception:
            # レートの失敗でゲームの終了処理（最終役職の開示など）を止めない
            logging.getLogger(__name__).exception("人狼のレート更新に失敗しました")

    # ======================================================
    #  最終役職開示
    # ======================================================
    async def _announce_final_roles(self, game):
        if not game.game_channel or not game.roles:
            return

        # ゲーム終了時はすべての裏役職を判明させる
        for p_id in game.roles.keys():
            await _check_and_reveal_ura_yakushoku(game, p_id, "end")

        lines = []
        alive_ids = {p.id for p in game.alive_players}
        for p in game.players:
            m = game.game_channel.guild.get_member(p.id)
            name = m.display_name if m else "不明"
            role = game.roles.get(p.id, "不明")
            status = SUCCESS if p.id in alive_ids else "💀"
            lines.append(f"{status} **{name}**: {role}")
        embed = discord.Embed(
            title="最終役職開示",
            description="\n".join(lines),
            color=0xFFFFFF
        )
        await game_panels.replace(game.game_channel, "party", embed=embed, view=ReplayView(game, self))

    # ======================================================
    #  霊媒師への通知
    # ======================================================
    async def _notify_reibai(self, game, executed_id):
        role = game.roles.get(executed_id)
        if role is None:
            return
        result = reibai_color(role)
        ex_member = game.game_channel.guild.get_member(executed_id)
        ex_name = ex_member.display_name if ex_member else "不明"

        for p in game.alive_players:
            p_role = game.roles.get(p.id)
            if p_role not in ["霊媒師", "大霊媒師"]:
                continue
            member = game.game_channel.guild.get_member(p.id)
            if not member:
                continue
            try:
                if p_role == "霊媒師":
                    await member.send(
                        f"<:REIBAI:1490254585413148703>霊媒結果：**{ex_name}** は【{result}】でした。"
                    )
                elif p_role == "大霊媒師":
                    await member.send(
                        f"<:REIBAI:1490254585413148703>大霊媒師の霊媒結果：**{ex_name}** は【{result}】"
                        f"（役職：**{role}**）でした。"
                    )
            except Exception:
                logger.debug("人狼: 霊媒結果のDM送信に失敗しました", exc_info=True)

    # ======================================================
    #  議長の強制追放
    # ======================================================
    async def apply_forced_execution(self, game, target_id):
        if not game.is_running: return
        alive_ids = {p.id for p in game.alive_players}
        if target_id not in alive_ids:
            return

        actual_target_id = target_id

        if game.roles.get(actual_target_id) == "貴族":
            slave_id = game.kizoku_slave.get(actual_target_id)
            if slave_id:
                slave_m = game.game_channel.guild.get_member(slave_id)
                if slave_m and slave_id in alive_ids:
                    await game.game_channel.send(f"貴族の処刑判定が奴隷 {slave_m.display_name} に肩代わりされました。")
                    actual_target_id = slave_id

        target_m = game.game_channel.guild.get_member(actual_target_id)
        if not target_m: return

        game.last_executed = actual_target_id
        game.silenced_players.add(actual_target_id)
        game.alive_players = [p for p in game.alive_players if p.id != actual_target_id]

        # 裏役職の判明トリガーチェック（死亡時）
        await _check_and_reveal_ura_yakushoku(game, actual_target_id, "death")

        await game.game_channel.send(f"{target_m.display_name} さんが追放されました。")

        await self._notify_reibai(game, actual_target_id)
        await self._check_mokumoku_reveal(game, actual_target_id)

        executed_role = game.roles.get(actual_target_id)
        if executed_role == "ハゲ":
            await game.game_channel.send("<:f8cc0b1b5e501838:1491033609929490492>ハゲが追放された。ハゲの勝利です。")
            await self._record_wins(game, [actual_target_id])
            game.is_running = False
            return
        elif executed_role == "コウモリむに":
            await game.game_channel.send("コウモリむにが追放された。しかし追放ではコウモリむには勝利できない...")

        for pair in game.riacchu_pairs:
            if actual_target_id in pair:
                partner_id = pair[1] if pair[0] == actual_target_id else pair[0]
                if partner_id in {p.id for p in game.alive_players}:
                    partner_m = game.game_channel.guild.get_member(partner_id)
                    if partner_m:
                        await game.game_channel.send(f"リア充のパートナー {partner_m.display_name} も道連れになりました。")
                        game.silenced_players.add(partner_id)
                        game.alive_players = [p for p in game.alive_players if p.id != partner_id]
                break

    # ======================================================
    #  投票フェーズ
    # ======================================================
    async def run_voting_phase(self, game):
        if not game.is_running: return
        await game.game_channel.send("ーー 投票フェーズ（40秒） ーー")
        game.silenced_players.update(p.id for p in game.alive_players)

        opts = [discord.SelectOption(label=p.display_name, value=str(p.id)) for p in game.alive_players]
        opts.append(discord.SelectOption(label="スキップ", value="skip"))
        game.voted_count = {}
        view = PublicVoteView(game, opts)
        view.add_item(jinrou_guide.PhaseHelpButton("vote", _guide_role_lookup(game), row=1))
        msg = await game_panels.replace(game.game_channel, "party", "生存者は投票してください", view=view)
        for _ in range(40):
            await asyncio.sleep(1)
            if not game.is_running: break
        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)
        if game.is_running:
            await self._autoplay_votes(game)

        for p in game.alive_players:
            game.silenced_players.discard(p.id)

        if not game.voted_count:
            return await game.game_channel.send("投票なし。追放はありません。")

        counts = Counter(game.voted_count.values())
        most = counts.most_common()

        if len(most) > 1 and most[0][1] == most[1][1]:
            return await game.game_channel.send("同数票のためスキップされました。追放はありません。")

        target_id_str = most[0][0]
        if target_id_str == "skip":
            return await game.game_channel.send("投票の結果、スキップされました。追放はありません。")

        actual_target_id = int(target_id_str)
        target_m = game.game_channel.guild.get_member(actual_target_id)
        if not target_m:
            return

        if game.roles.get(actual_target_id) == "貴族":
            slave_id = game.kizoku_slave.get(actual_target_id)
            if slave_id:
                slave_m = game.game_channel.guild.get_member(slave_id)
                if slave_m and slave_id in {p.id for p in game.alive_players}:
                    await game.game_channel.send(f"貴族の処刑判定が奴隷 {slave_m.display_name} に肩代わりされました。")
                    actual_target_id = slave_id
                    target_m = slave_m

        await game.game_channel.send(f"{target_m.display_name} さんが追放されました。")
        game.last_executed = actual_target_id
        game.silenced_players.add(actual_target_id)
        game.alive_players = [p for p in game.alive_players if p.id != actual_target_id]

        # 裏役職の判明トリガーチェック（死亡時）
        await _check_and_reveal_ura_yakushoku(game, actual_target_id, "death")

        await self._notify_reibai(game, actual_target_id)
        await self._check_mokumoku_reveal(game, actual_target_id)

        executed_role = game.roles.get(actual_target_id)
        if executed_role == "ハゲ":
            await game.game_channel.send("<:f8cc0b1b5e501838:1491033609929490492>ハゲが追放された。ハゲの勝利です。")
            await self._record_wins(game, [actual_target_id])
            game.is_running = False
            return
        elif executed_role == "コウモリむに":
            await game.game_channel.send("コウモリむにが追放された。しかし追放ではコウモリむには勝利できない...")

        for pair in game.riacchu_pairs:
            if actual_target_id in pair:
                partner_id = pair[1] if pair[0] == actual_target_id else pair[0]
                if partner_id in {p.id for p in game.alive_players}:
                    partner_m = game.game_channel.guild.get_member(partner_id)
                    if partner_m:
                        await game.game_channel.send(f"リア充のパートナー {partner_m.display_name} も道連れになりました。")
                        game.silenced_players.add(partner_id)
                        game.alive_players = [p for p in game.alive_players if p.id != partner_id]
                break

    # ======================================================
    #  強制投票フェーズ（議長専用）
    # ======================================================
    async def run_chairman_vote_phase(self, game):
        if not game.is_running: return
        game.chairman_vote_event = asyncio.Event()
        game.chairman_ketsugu_target = None

        opts = [
            discord.SelectOption(label=p.display_name, value=str(p.id))
            for p in game.alive_players
            if game.roles.get(p.id) != "議長"
        ]
        if not opts:
            await game.game_channel.send("追放できる対象がいません。")
            return

        for p in game.alive_players:
            if game.roles.get(p.id) != "議長":
                game.silenced_players.add(p.id)

        view = ChairmanVoteView(game, opts)
        view.add_item(jinrou_guide.PhaseHelpButton("vote", _guide_role_lookup(game), row=1))
        msg = await game_panels.replace(game.game_channel, "party",
            "ーー 強制投票（60秒） ーー\n**議長のみ**が投票できます。追放する対象を選んでください。",
            view=view
        )

        t = 0
        while not game.chairman_vote_event.is_set() and t < 60:
            await asyncio.sleep(1)
            t += 1
            if not game.is_running: break

        try: await msg.delete()
        except Exception:
            logger.debug("人狼: メッセージの削除に失敗しました", exc_info=True)

        for p in game.alive_players:
            game.silenced_players.discard(p.id)

        if game.chairman_ketsugu_target:
            await self.apply_forced_execution(game, game.chairman_ketsugu_target)
            game.chairman_ketsugu_target = None
        else:
            await game.game_channel.send("議長が時間内に投票しなかった。追放はありません。")


# ======================================================
#  UI Components
# ======================================================

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

        # 除外役職セレクト
        exc_sel = discord.ui.Select(
            placeholder="除外役職を選択（最大4つ）",
            options=[discord.SelectOption(label=r, value=r) for r in self.ALL_ROLES[:25]],
            min_values=0, max_values=4, row=2
        )
        exc_sel.callback = self._exc_callback
        self.add_item(exc_sel)

    async def _mode_callback(self, interaction: discord.Interaction):
        self.game.game_mode = interaction.data.get("values", ["プロ"])[0]
        await interaction.response.defer()

    async def _req_callback(self, interaction: discord.Interaction):
        self.game.required_roles = list(interaction.data.get("values", []))
        await interaction.response.defer()

    async def _exc_callback(self, interaction: discord.Interaction):
        self.game.excluded_roles = list(interaction.data.get("values", []))
        await interaction.response.defer()

    @discord.ui.button(label="次へ進む", style=discord.ButtonStyle.primary, row=3)
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
            f"<a:POYOPOYO:1490724627805110392>人狼ゲーム募集開始！ モード:【{self.game.game_mode}】{req_str2}",
            view=view
        )

    async def on_timeout(self):
        self.game.is_running = False


class AdvancedSetupView(discord.ui.View):
    """プロモード専用の必須発展職選定パネル（第二段階）"""
    ADV_ROLES = [
        "タフむに", "大霊媒師", "罠師", "ミュージシャン", "デカ狼", "狂信者", "コウモリむに", "ワンころ", "もくもく", "ヤンデレ"
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
            f"<a:POYOPOYO:1490724627805110392>人狼ゲーム募集開始！ モード:【{self.game.game_mode}】{req_str2}",
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
        self.game.players.append(interaction.user)
        await interaction.response.send_message(
            f"<a:AGOMUNIMUNI:1490255555632037909>{interaction.user.display_name} さんが参加しました。"
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
            f"<a:POYOPOYO:1490724627805110392>再戦開始！ モード:【{new_game.game_mode}】 必須: {req_str} / 除外: {exc_str}",
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
        if interaction.channel is not None and all(c.id != interaction.channel.id for c in game.channels):
            game.channels.append(interaction.channel)
        game.players.append(interaction.user)
        # 参加の知らせは、元のサーバーを含む全チャンネルに届ける
        await interaction.response.send_message(f"{interaction.user.display_name} さんが参加しました。")
        for chan in [c for c in game.channels if interaction.channel is None or c.id != interaction.channel.id]:
            try:
                await chan.send(f"<a:AGOMUNIMUNI:1490255555632037909>{interaction.user.display_name} さんが別のサーバーから参加しました。",
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
            return await interaction.response.send_message(embed=embed, view=ActionSelectView(self.game, opts, role), ephemeral=True)

        if role == "ミュージシャン":
            if self.game.musician_party_used:
                embed = discord.Embed(description="パーティは既に開催済みです。今夜は待機してください。", color=0xFFFFFF)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            self.game.night_actions[p_id] = 0
            embed = discord.Embed(description="<:music:1561710964238450809> パーティを開催します！ランダムに4人を招待します。", color=0xFFFFFF)
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
        await interaction.response.send_message(embed=embed, view=ActionSelectView(self.game, opts, role), ephemeral=True)

class ActionSelectView(discord.ui.View):
    def __init__(self, game, options, role):
        super().__init__(timeout=60)
        self.game, self.role = game, role
        s = discord.ui.Select(options=options)
        s.callback = self.callback
        self.add_item(s)

    async def callback(self, interaction: discord.Interaction):
        p_id = interaction.user.id
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
            embed = discord.Embed(description=f"<:URANAI:1490255412837093568>占い結果: 【{res}】", color=0xFFFFFF)
            await interaction.response.send_message(embed=embed, ephemeral=True)

        elif self.role == "大霊媒師":
            r = self.game.roles.get(t_id)
            color = reibai_color(r)
            embed = discord.Embed(
                description=f"<:REIBAI:1490254585413148703>大霊媒師の結果: 【{color}】 役職: 【{r}】",
                color=0xFFFFFF
            )
            await interaction.response.send_message(embed=embed, ephemeral=True)

        elif self.role == "マサイ族":
            r = self.game.roles.get(t_id)
            if r in ["人狼", "デカ狼"]:
                self.game.masai_evasion[p_id] = True
            embed = discord.Embed(description="<:MASAI:1490254590757572758>対象の観察を完了しました。人狼であれば回避の準備を整える。", color=0xFFFFFF)
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


async def setup(bot):
    await bot.add_cog(JinrouCog(bot))
