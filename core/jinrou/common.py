import logging
from typing import Optional
import asyncio
import random
from collections import Counter

logger = logging.getLogger("cogs.jinrou")
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
