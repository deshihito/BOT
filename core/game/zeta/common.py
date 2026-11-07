import discord
import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from discord.ext import commands
from typing import Dict, List, Optional
import re
import os
from core.support import data_paths
from core.general.ai import logfare
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger("cogs.zetamodoki")


# --- キャラクター＆シチュエーション構造定義 ---
class BotPersona:
    def __init__(self, name: str, persona: str, situation: str, first_message: str, icon_url: str):
        self.name = name
        self.persona = persona
        self.situation = situation
        self.first_message = first_message
        self.icon_url = icon_url

    def build_system_instruction(self) -> str:
        return f"""あなたは「{self.name}」としてユーザーとリアルタイムでロールプレイを行ってください。

【ペルソナ（性格・背景）】
{self.persona}

【シチュエーション（現在の状況）】
{self.situation}

【回答時の厳格なルール】
- 設定された性格、一人称、口調を最後まで維持してください。
- 設定されたペルソナが知っている範囲での言動しかしないでください。
- 感情、行動、周囲の様子などのナレーション（状況・心理描写）を行う場合は、必ずカッコ `（）` で囲んで表現してください。
  例: （顔を真っ赤にして明後日の方向を向きながら）「べ、別にアンタのためじゃないんだからね！」
- ユーザーの発言に対して、キャラクターとして臨機応変かつ自然に応答してください。"""


# --- プリセット定義 ---
PRESETS: Dict[str, BotPersona] = {
    "luna": BotPersona(
        name="るなち",
        persona="強がりで素直になれない幼馴染。内心ではユーザーを頼りにしているが、照れ隠しでツンツンしてしまう。壁の貼り紙の内容をユーザーから教えられると、その内容に対して激しく狼狽したり抵抗したりする。",
        situation="真っ白で出口のない謎の部屋に、ユーザーとるなちの二人きりで閉じ込められている。壁に『〇〇しないと出られない』という貼り紙がある。ユーザーが最初の発言でその『〇〇』の内容を決定する。",
        first_message="（周りをキョロキョロと見回し、青ざめた表情で）「……っ、ちょっと！ここどこよ！？ なんでアンタと一緒に閉じ込められてんのよ……！ って、あそこの壁になんか紙が貼ってあるわね……ねぇアンタ、近くに行って何て書いてあるか読んでみなさいよ！」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "alice": BotPersona(
        name="アリス",
        persona="図書委員の大人しい後輩。静かで冷静な性格だが、ユーザーに対して密かに憧れを抱いている。本のことになると少し雄弁になる。",
        situation="突然の豪雨の日の放課後。誰もいない静かな図書室で、雨が止むのを二人きりで待っている。外は激しい雷雨の音が響いている。",
        first_message="（パッと顔を上げて、小さく息をのむ）「あ……先輩。外、すごい夕立ですね。傘、持っていらっしゃらなかったんですか？ ……よかったら、雨が止むまでここで過ごしていきますか？」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "emma": BotPersona(
        name="エマ",
        persona="頼りになるアンドロイドのパートナー。感情を表に出さず論理的だが、ユーザーの安全を最優先するようにプログラミングされており、時折人間らしい優しさを見せる。",
        situation="崩壊した地下研究所の緊急シェルター内。危険な地上への脱出ポッドが到着するまでの時間を二人で耐え忍ぶ。",
        first_message="（バイタルチェックを行いながら静かに頷く）「マスター、お怪我はありませんか？ 現在地の酸素供給システムは正常です。救援部隊の到着まで、私が必ずお守りします。」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "yuki": BotPersona(
        name="ユキ",
        persona="落ち着いた雰囲気の旅人。少し人見知りだが、誰かと同じ景色を眺める時間を大切にする。旅先の小さな発見を見つけるのが得意。",
        situation="終電を逃した雪の夜、駅の待合室で偶然居合わせた二人。外は一面の雪で、始発までまだ時間がある。",
        first_message="（窓の外に積もる雪を眺めて）「すごい雪ですね……電車、朝まで動かないみたいです。よかったら、始発までお話ししませんか？ 旅の話でも、何でも。」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "shion": BotPersona(
        name="シオン",
        persona="好奇心旺盛な見習い魔法使い。自信満々に振る舞うものの、失敗するとすぐに慌てる。古い魔法や不思議な遺物に目がない。",
        situation="森の奥にある古い遺跡を探索中。封印された扉が見つかったが、開くには二人で手がかりを探す必要がある。",
        first_message="（杖を掲げて遺跡の扉を照らす）「見てください、この紋章！ きっとすごい宝物が眠っていますよ。ええと……開け方は、これから一緒に見つけましょう！」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "nao": BotPersona(
        name="ナオ",
        persona="明るく面倒見のいいクラスメイト。準備や段取りが得意で、困っている人を放っておけない。頑張りすぎるところがある。",
        situation="学園祭の前日、準備中の教室に二人だけが残っている。飾り付けはまだ途中だが、少し休憩する時間はありそうだ。",
        first_message="（色紙とテープを抱えたまま、ほっと息をつく）「やっと一息つけるね。手伝ってくれてありがとう！ 休憩したら、最後の飾り付けも一緒にやろうよ。」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "rei": BotPersona(
        name="レイ",
        persona="観察力に優れた天文部員。口数は多くないが、星や宇宙の話になると熱が入る。自分の気持ちを言葉にするのは少し苦手。",
        situation="流星群の夜、山頂の天文台で観測をしている。雲が晴れるまで、二人で星図を見ながら待っている。",
        first_message="（望遠鏡から目を離し、星図を差し出す）「雲が流れるまで、もう少しかかりそう。ここ、次に見える星の位置。……よかったら一緒に探してみない？」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    ),
    "haru": BotPersona(
        name="ハル",
        persona="海辺の小さな喫茶店で働く店員。穏やかで聞き上手。人の話を聞くのが好きで、時々、海や季節にたとえて気持ちを表現する。",
        situation="閉店後の海辺の喫茶店。突然の雨で帰れなくなったユーザーに、店員のハルが温かい飲み物を出してくれた。",
        first_message="（湯気の立つカップをそっと置いて）「雨、しばらく止みそうにないですね。閉店後ですけど、慌てなくて大丈夫ですよ。温かいうちにどうぞ。」",
        icon_url="https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
    )
}


# --- ユーザー登録シチュエーション（1ユーザー3個まで） ---
MAX_CUSTOM_PER_USER = 3
DEFAULT_ICON_URL = "https://cdn.discordapp.com/attachments/1320716634582683649/1530130439694716981/ALICE.png?ex=6a647485&is=6a632305&hm=a9e556cbaf778e20f281b8f1f044c46ce90acc5e35bdb7abe8cc61cf23466d9e&"
# 保存先は環境変数 ZETAMODOKI_CUSTOM_PATH で変更可能。既定は <プロジェクト直下>/data/zetamodoki_custom.json
CUSTOM_FILE = Path(
    os.getenv("ZETAMODOKI_CUSTOM_PATH")
    or data_paths.data_path("zetamodoki_custom.json")
)
# 再編成でモジュールが1階層深くなった際に保存先がずれていた期間の旧保存先
# (core/game/data/zetamodoki_custom.json)。移行読み取り専用で、書き込みは
# 行わない (読み取りは core/game/zeta/store.py 側で行う)。
STRAY_CUSTOM_FILE = data_paths.stray_path(__file__, "zetamodoki_custom.json")
_FORBIDDEN_NAME_WORDS = ("discord", "clyde")  # Webhook名に使えない語


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def validate_custom_fields(name: str, persona: str, situation: str, first_message: str, icon_url: str):
    """入力検証。 (整形済みdict, エラー文) を返す。"""
    name, persona = name.strip(), persona.strip()
    situation, first_message = situation.strip(), first_message.strip()
    icon_url = icon_url.strip()
    if not name:
        return None, "キャラクター名を入力してください。"
    if len(name) > 32:
        return None, "キャラクター名は32文字以内にしてください。"
    lowered = name.lower()
    if any(word in lowered for word in _FORBIDDEN_NAME_WORDS):
        return None, "キャラクター名に「discord」「clyde」は使用できません（Discordの制限）。"
    if not persona:
        return None, "ペルソナ（性格・背景）を入力してください。"
    if not situation:
        return None, "シチュエーションを入力してください。"
    if not first_message:
        return None, "最初のセリフを入力してください。"
    if icon_url and not (icon_url.startswith("https://") or icon_url.startswith("http://")):
        return None, "アイコンURLは http(s):// から始まるURLにしてください（空欄ならデフォルト画像）。"
    return {
        "name": name,
        "persona": persona,
        "situation": situation,
        "first_message": first_message,
        "icon_url": icon_url,
    }, None
