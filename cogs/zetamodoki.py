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
from core import logfare
from core.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger(__name__)


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
    or (Path(__file__).resolve().parent.parent / "data" / "zetamodoki_custom.json")
)
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


class CustomSituationStore:
    """ユーザーごとの登録シチュエーションをJSONファイルへ保存する。"""

    def __init__(self, path: Path = CUSTOM_FILE):
        self.path = path
        self._data: dict | None = None
        self._lock: asyncio.Lock | None = None

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _root(self) -> dict:
        if self._data is None:
            data: dict = {}
            try:
                with self.path.open("r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
            except FileNotFoundError:
                pass
            except Exception:
                logger.exception("ZetaModoki: %s の読み込みに失敗しました。壊れたファイルを退避します", self.path)
                try:
                    os.replace(self.path, self.path.with_name(self.path.name + f".broken-{int(time.time())}"))
                except OSError:
                    pass
            self._data = data
        return self._data

    def _write(self, payload: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    async def _save(self) -> bool:
        try:
            payload = json.dumps(self._root(), ensure_ascii=False)
            await asyncio.to_thread(self._write, payload)
            return True
        except Exception:
            logger.exception("ZetaModoki: %s への保存に失敗しました", self.path)
            return False

    def list(self, user_id: int) -> list[dict]:
        entries = self._root().get(str(user_id), [])
        return [e for e in entries if isinstance(e, dict) and e.get("id")]

    def get(self, user_id: int, entry_id: str) -> dict | None:
        return next((e for e in self.list(user_id) if e["id"] == entry_id), None)

    def to_persona(self, entry: dict) -> BotPersona:
        return BotPersona(
            name=entry["name"],
            persona=entry["persona"],
            situation=entry["situation"],
            first_message=entry["first_message"],
            icon_url=entry.get("icon_url") or DEFAULT_ICON_URL,
        )

    async def _mutate(self, user_id: int, fn) -> tuple[object, str | None]:
        """fn(entries:list)->(result, error)。保存に失敗したら変更を巻き戻す。"""
        async with self._get_lock():
            root = self._root()
            snapshot = json.dumps(root, ensure_ascii=False)
            entries = list(self.list(user_id))
            result, error = fn(entries)
            if error:
                return None, error
            root[str(user_id)] = entries
            if not await self._save():
                self._data = json.loads(snapshot)
                return None, "保存に失敗しました。しばらくしてからもう一度お試しください。"
            return result, None

    async def add(self, user_id: int, fields: dict):
        def op(entries):
            if len(entries) >= MAX_CUSTOM_PER_USER:
                return None, f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。先に不要な登録を削除してください。"
            entry = {"id": uuid.uuid4().hex[:8], **fields}
            entries.append(entry)
            return entry, None
        return await self._mutate(user_id, op)

    async def update(self, user_id: int, entry_id: str, fields: dict):
        def op(entries):
            for entry in entries:
                if entry["id"] == entry_id:
                    entry.update(fields)
                    return entry, None
            return None, "対象の登録が見つかりません（すでに削除された可能性があります）。"
        return await self._mutate(user_id, op)

    async def delete(self, user_id: int, entry_id: str):
        def op(entries):
            for i, entry in enumerate(entries):
                if entry["id"] == entry_id:
                    return entries.pop(i), None
            return None, "対象の登録が見つかりません（すでに削除された可能性があります）。"
        return await self._mutate(user_id, op)


class CustomPersonaModal(discord.ui.Modal):
    """キャラクターとシチュエーションの登録・編集フォーム。"""

    def __init__(self, cog, owner_id: int, entry: dict | None = None, origin_view: "CustomManageView | None" = None):
        super().__init__(title="シチュエーションを編集" if entry else "シチュエーションを登録")
        self.cog = cog
        self.owner_id = owner_id
        self.entry = entry
        self.origin_view = origin_view
        entry = entry or {}

        self.name_input = discord.ui.TextInput(
            label="キャラクター名", placeholder="例: ミオ", max_length=32,
            default=entry.get("name"),
        )
        self.persona_input = discord.ui.TextInput(
            label="ペルソナ（性格・背景・口調）", style=discord.TextStyle.paragraph,
            placeholder="例: 世話焼きな幼馴染。一人称は「わたし」。素直になれず…", max_length=1000,
            default=entry.get("persona"),
        )
        self.situation_input = discord.ui.TextInput(
            label="シチュエーション（現在の状況）", style=discord.TextStyle.paragraph,
            placeholder="例: 夏祭りの帰り道、二人で人気のない神社の石段に座っている。", max_length=1000,
            default=entry.get("situation"),
        )
        self.first_message_input = discord.ui.TextInput(
            label="最初のセリフ", style=discord.TextStyle.paragraph,
            placeholder="例: （浴衣の袖をいじりながら）「……ねぇ、もう少しだけ、ここにいてもいい？」", max_length=1000,
            default=entry.get("first_message"),
        )
        self.icon_input = discord.ui.TextInput(
            label="アイコン画像URL（任意）", placeholder="https://… 空欄ならデフォルト画像",
            required=False, max_length=500, default=entry.get("icon_url") or None,
        )
        for item in (self.name_input, self.persona_input, self.situation_input,
                     self.first_message_input, self.icon_input):
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        fields, error = validate_custom_fields(
            self.name_input.value, self.persona_input.value, self.situation_input.value,
            self.first_message_input.value, self.icon_input.value,
        )
        if error:
            return await interaction.response.send_message(error, ephemeral=True)

        store = self.cog.custom
        if self.entry:
            saved, error = await store.update(self.owner_id, self.entry["id"], fields)
            verb = "更新"
        else:
            saved, error = await store.add(self.owner_id, fields)
            verb = "登録"
        if error:
            return await interaction.response.send_message(error, ephemeral=True)

        if self.origin_view is not None:
            view = CustomManageView(
                self.cog, self.owner_id, saved["id"],
                notice=f"「{saved['name']}」を{verb}しました。",
            )
            return await edit_panel_v2(interaction, as_panel_v2(view))
        await interaction.response.send_message(
            f"「{saved['name']}」を{verb}しました。`ZetaModoki` の「会話を開始」から選べます。", ephemeral=True,
        )


class CustomEntrySelect(discord.ui.Select):
    def __init__(self, parent_view: "CustomManageView"):
        self.parent_view = parent_view
        options = [
            discord.SelectOption(
                label=_clip(e["name"], 100), value=e["id"],
                description=_clip(e["situation"], 100), emoji="⭐",
                default=e["id"] == parent_view.selected_id,
            )
            for e in parent_view.entries
        ]
        super().__init__(placeholder="編集・削除する登録を選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        new_view = CustomManageView(view.cog, view.owner_id, self.values[0])
        await edit_panel_v2(interaction, as_panel_v2(new_view))


class CustomManageView(discord.ui.View):
    """登録済みシチュエーションの一覧・登録・編集・削除。"""

    def __init__(self, cog, owner_id: int, selected_id: str | None = None, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.owner_id = owner_id
        self.notice = notice
        self.entries = cog.custom.list(owner_id)
        ids = [e["id"] for e in self.entries]
        self.selected_id = selected_id if selected_id in ids else (ids[0] if ids else None)

        if self.entries:
            self.add_item(CustomEntrySelect(self))
        self.register_button.disabled = len(self.entries) >= MAX_CUSTOM_PER_USER
        self.edit_button.disabled = self.selected_id is None
        self.delete_button.disabled = self.selected_id is None

    def embed(self) -> discord.Embed:
        # Components V2 へ変換される前提で、本文(description)のみで構成する
        lines = []
        if self.notice:
            lines += [f"✅ {self.notice}", ""]
        if not self.entries:
            lines.append("まだ登録がありません。「新規登録」からキャラクターとシチュエーションを作成できます。")
        for e in self.entries:
            mark = "▶ " if e["id"] == self.selected_id else ""
            lines.append(f"**{mark}{_clip(e['name'], 60)}**")
            lines.append(_clip(f"状況: {e['situation']}", 300))
            lines.append("")
        lines.append("-# 登録したシチュエーションは、あなたの「会話を開始」の選択肢に追加されます。")
        return discord.Embed(
            title=f"登録済みシチュエーション（{len(self.entries)}/{MAX_CUSTOM_PER_USER}）",
            description="\n".join(lines),
            color=discord.Color.purple(),
        )

    async def _owner_only(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="新規登録", style=discord.ButtonStyle.success, emoji="➕", row=1)
    async def register_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        if len(self.cog.custom.list(self.owner_id)) >= MAX_CUSTOM_PER_USER:
            return await interaction.response.send_message(
                f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。", ephemeral=True)
        await interaction.response.send_modal(CustomPersonaModal(self.cog, self.owner_id, None, self))

    @discord.ui.button(label="編集", style=discord.ButtonStyle.primary, emoji="✏️", row=1)
    async def edit_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        entry = self.cog.custom.get(self.owner_id, self.selected_id) if self.selected_id else None
        if entry is None:
            return await interaction.response.send_message("編集する登録を選択してください。", ephemeral=True)
        await interaction.response.send_modal(CustomPersonaModal(self.cog, self.owner_id, entry, self))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger, emoji="🗑️", row=1)
    async def delete_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await self._owner_only(interaction):
            return
        entry = self.cog.custom.get(self.owner_id, self.selected_id) if self.selected_id else None
        if entry is None:
            return await interaction.response.send_message("削除する登録を選択してください。", ephemeral=True)
        confirm = CustomDeleteConfirmView(self.cog, self.owner_id, entry)
        await edit_panel_v2(interaction, as_panel_v2(confirm))


class CustomDeleteConfirmView(discord.ui.View):
    def __init__(self, cog, owner_id: int, entry: dict):
        super().__init__(timeout=60)
        self.cog, self.owner_id, self.entry = cog, owner_id, entry
        self.entry_id = entry["id"]

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="登録の削除",
            description=f"「{self.entry['name']}」を削除しますか？この操作は取り消せません。",
            color=discord.Color.red(),
        )

    @discord.ui.button(label="削除する", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        removed, error = await self.cog.custom.delete(self.owner_id, self.entry_id)
        notice = error or f"「{removed['name']}」を削除しました。"
        view = CustomManageView(self.cog, self.owner_id, notice=notice)
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view = CustomManageView(self.cog, self.owner_id, self.entry_id)
        await edit_panel_v2(interaction, as_panel_v2(view))


class ZetaInfoView(discord.ui.View):
    """ボタンを持たない、Embed相当の表示だけのパネル（V2変換用）。"""

    def __init__(self, embed: discord.Embed):
        super().__init__(timeout=None)
        self._embed = embed

    def embed(self) -> discord.Embed:
        return self._embed


# --- 行動入力用 Modal ---
class ResponseModal(discord.ui.Modal):
    def __init__(self, cog, channel_id: int):
        super().__init__(title="メッセージを入力")
        self.cog = cog
        self.channel_id = channel_id

        self.input_text = discord.ui.TextInput(
            label="発言や行動を入力してください",
            placeholder="例: 『手をつなぎ続けないと出られない』って書いてあるよ",
            style=discord.TextStyle.paragraph,
            max_length=500,
        )
        self.add_item(self.input_text)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer()
        user_text = self.input_text.value.strip()

        # ユーザーの発言を表示
        await interaction.channel.send(f"**{interaction.user.display_name}**: {user_text}")
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=self.channel_id,
                user_input=user_text,
                requester_id=interaction.user.id,
            )


# --- 返信ボタン View ---
class ChatButtonView(discord.ui.View):
    def __init__(
        self,
        cog,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        private_thread: bool = False,
    ):
        super().__init__(timeout=None)
        self.cog = cog
        self.retry_owner_id = retry_owner_id
        self.retry_input = retry_input
        if retry_owner_id is None or retry_input is None:
            self.remove_item(self.retry_button)
        if not private_thread:
            self.remove_item(self.delete_thread_button)

    @discord.ui.button(label="返信する", style=discord.ButtonStyle.primary, emoji="💬")
    async def reply_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel_id = interaction.channel_id
        if channel_id not in self.cog.active_personas:
            await interaction.response.send_message("このチャンネルではセッションが開始されていません。`/general` の「ZetaModoki」から会話を開始してください。", ephemeral=True)
            return

        modal = ResponseModal(self.cog, channel_id)
        await interaction.response.send_modal(modal)

    @discord.ui.button(label="再試行", style=discord.ButtonStyle.secondary, row=0)
    async def retry_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.retry_owner_id:
            await interaction.response.send_message("この発言を送信したユーザーだけが再試行できます。", ephemeral=True)
            return
        failed = self.cog.failed_requests.get(interaction.channel_id)
        if (
            not failed
            or failed["user_id"] != interaction.user.id
            or failed["user_input"] != self.retry_input
        ):
            await interaction.response.send_message("再試行できる失敗した発言が見つかりません。", ephemeral=True)
            return

        channel = interaction.channel
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        await interaction.response.edit_message(
            view=ChatButtonView(self.cog, private_thread=private_thread)
        )
        async with interaction.channel.typing():
            await self.cog._send_streamed_response(
                channel=interaction.channel,
                channel_id=interaction.channel_id,
                user_input=self.retry_input,
                requester_id=interaction.user.id,
            )

    @discord.ui.button(label="このスレッドを削除", style=discord.ButtonStyle.danger, row=0)
    async def delete_thread_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        channel = interaction.channel
        if not isinstance(channel, discord.Thread) or channel.type != discord.ChannelType.private_thread:
            await interaction.response.send_message("このボタンはプライベートスレッド内でのみ使えます。", ephemeral=True)
            return
        confirm = DeleteThreadConfirmView(self.cog, channel.id, interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(confirm), ephemeral=True)


class DeleteThreadConfirmView(discord.ui.View):
    def __init__(self, cog, thread_id: int, requester_id: int):
        super().__init__(timeout=60)
        self.cog = cog
        self.thread_id = thread_id
        self.requester_id = requester_id

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="プライベートスレッドの削除",
            description="このプライベートスレッドと会話履歴を削除しますか？この操作は取り消せません。",
            color=discord.Color.red(),
        )

    @discord.ui.button(label="削除する", style=discord.ButtonStyle.danger)
    async def confirm_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        if interaction.channel_id != self.thread_id or not isinstance(interaction.channel, discord.Thread):
            await interaction.response.send_message("対象のスレッドを確認できません。", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        try:
            await interaction.channel.delete(reason="ZetaModoki private conversation deleted by user")
        except discord.HTTPException:
            await interaction.followup.send(
                view=as_panel_v2(ZetaInfoView(discord.Embed(
                    title="スレッドを削除できませんでした",
                    description="Botのスレッド管理権限を確認してください。",
                    color=discord.Color.red()))),
                ephemeral=True,
            )
            return
        self.cog.active_personas.pop(self.thread_id, None)
        self.cog.chat_histories.pop(self.thread_id, None)
        self.cog.failed_requests.pop(self.thread_id, None)
        await interaction.followup.send(
            view=as_panel_v2(ZetaInfoView(discord.Embed(
                title="プライベートスレッドを削除しました", color=discord.Color.purple()))),
            ephemeral=True,
        )

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.requester_id:
            await interaction.response.send_message("削除を確認したユーザーだけが操作できます。", ephemeral=True)
            return
        await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(discord.Embed(
            title="削除をキャンセルしました", color=discord.Color.purple()))))


# --- 開始フロー: ① 会話モード選択 → ② キャラクター選択 ---
class ModeButton(discord.ui.Button):
    def __init__(self, parent_view: "CharacterSelectView", mode: str, label: str, emoji: str, disabled: bool = False):
        self.parent_view, self.mode = parent_view, mode
        super().__init__(label=label, emoji=emoji, style=discord.ButtonStyle.primary, disabled=disabled, row=0)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view.mode = self.mode
        view.rebuild()
        await edit_panel_v2(interaction, as_panel_v2(view))


class ModeBackButton(discord.ui.Button):
    def __init__(self, parent_view: "CharacterSelectView"):
        self.parent_view = parent_view
        super().__init__(label="会話モードを選び直す", emoji="↩️", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        view.mode = None
        view.rebuild()
        await edit_panel_v2(interaction, as_panel_v2(view))


class CharacterSelect(discord.ui.Select):
    def __init__(self, cog, parent_view):
        self.cog = cog
        self.parent_view = parent_view
        options = [
            discord.SelectOption(
                label="るなち（〇〇しないと出られない部屋）",
                value="luna",
                description="条件をプレイヤーが決めるツンデレ幼馴染との閉じ込めシチュ",
                emoji="🚪"
            ),
            discord.SelectOption(
                label="アリス（雨宿りの図書室）",
                value="alice",
                description="放課後の図書室で二人きりの雨宿りシチュ",
                emoji="📚"
            ),
            discord.SelectOption(
                label="エマ（崩壊したシェルター）",
                value="emma",
                description="アンドロイドのパートナーと過ごすサバイバルシチュ",
                emoji="🤖"
            ),
            discord.SelectOption(
                label="ユキ（雪の夜の駅）",
                value="yuki",
                description="終電を逃した駅で始発を待つ、静かな夜",
                emoji="❄️"
            ),
            discord.SelectOption(
                label="シオン（森の古代遺跡）",
                value="shion",
                description="見習い魔法使いと封印された遺跡を探索",
                emoji="✨"
            ),
            discord.SelectOption(
                label="ナオ（学園祭の前日）",
                value="nao",
                description="クラスメイトと学園祭の準備をする放課後",
                emoji="🎨"
            ),
            discord.SelectOption(
                label="レイ（流星群の天文台）",
                value="rei",
                description="天文部員と星空を観測する山頂の夜",
                emoji="🌠"
            ),
            discord.SelectOption(
                label="ハル（雨宿りの喫茶店）",
                value="haru",
                description="海辺の喫茶店で雨が止むのを待つ",
                emoji="☕"
            )
        ]
        # 自分が登録したシチュエーションを末尾に追加（本人にだけ表示される）
        for entry in cog.custom.list(parent_view.user_id):
            options.append(discord.SelectOption(
                label=_clip(f"{entry['name']}（登録）", 100),
                value=f"custom:{entry['id']}",
                description=_clip(entry["situation"], 100),
                emoji="⭐",
            ))
        super().__init__(placeholder="会話したいキャラクターを選択してください", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if interaction.user.id != view.user_id:
            return await interaction.response.send_message("この画面を開いたユーザーだけ操作できます。", ephemeral=True)
        if view.mode is None:
            return await interaction.response.send_message("先に会話モードを選択してください。", ephemeral=True)

        selected_key = self.values[0]
        if selected_key.startswith("custom:"):
            entry = self.cog.custom.get(interaction.user.id, selected_key.removeprefix("custom:"))
            if entry is None:
                return await interaction.response.send_message(
                    "その登録が見つかりません。削除された可能性があります。もう一度 `/general` から開始してください。",
                    ephemeral=True,
                )
            persona = self.cog.custom.to_persona(entry)
        else:
            persona = PRESETS[selected_key]

        target_channel = interaction.channel
        if view.mode == "private":
            if not isinstance(interaction.channel, discord.TextChannel):
                return await interaction.response.send_message(
                    "プライベートスレッドは通常のテキストチャンネルから開始してください。",
                    ephemeral=True,
                )
            thread = None
            try:
                thread = await interaction.channel.create_thread(
                    name=_clip(f"{persona.name}との会話", 100),
                    type=discord.ChannelType.private_thread,
                    invitable=False,
                    auto_archive_duration=1440,
                )
                await thread.add_user(interaction.user)
                target_channel = thread
            except discord.HTTPException:
                if thread is not None:
                    try:
                        await thread.delete(reason="Failed to add conversation starter")
                    except discord.HTTPException:
                        pass
                failed = discord.Embed(
                    title="プライベートスレッドを作成できませんでした",
                    description="Botに「プライベートスレッドの作成」「スレッドの管理」権限があるか確認してください。",
                    color=discord.Color.red(),
                )
                return await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(failed)))

        channel_id = target_channel.id
        self.cog.active_personas[channel_id] = persona
        self.cog.chat_histories[channel_id] = []
        self.cog.failed_requests.pop(channel_id, None)

        is_private_thread = (
            isinstance(target_channel, discord.Thread)
            and target_channel.type == discord.ChannelType.private_thread
        )
        mode_text = "プライベートスレッド" if is_private_thread else "公開チャンネル"
        started = discord.Embed(
            title=f"【{persona.name}】で会話を開始します",
            description=f"会話先: {target_channel.mention}（{mode_text}）",
            color=discord.Color.purple(),
        )
        await edit_panel_v2(interaction, as_panel_v2(ZetaInfoView(started)))

        # チャンネル(スレッド)全体に見えるお知らせ
        embed = discord.Embed(
            title=f"【{persona.name}】との会話を開始しました！",
            description=(
                f"**シチュエーション:**\n{persona.situation}\n\n"
                "-# 下の「返信する」ボタンから入力して対話を進めてください"
            ),
            color=discord.Color.purple()
        )
        await target_channel.send(view=as_panel_v2(ZetaInfoView(embed)))

        # キャラクターの初期メッセージを Webhook で送信
        first_msg_formatted = self.cog._format_narration(persona.first_message)
        try:
            await self.cog._send_webhook_message(
                channel=target_channel,
                channel_id=channel_id,
                content=first_msg_formatted
            )
        except Exception as e:
            await target_channel.send(
                f"**{persona.name}**: {first_msg_formatted}",
                view=ChatButtonView(self.cog, private_thread=is_private_thread),
                allowed_mentions=discord.AllowedMentions.none(),
            )
            logger.warning("Webhook送信エラー: %s", e)


class CharacterSelectView(discord.ui.View):
    """① 公開/プライベートを選ぶ → ② キャラクターを選ぶ。モード未選択ではキャラを選べない。"""

    def __init__(self, cog, user_id: int, private_ok: bool = True):
        super().__init__(timeout=120)
        self.cog = cog
        self.user_id = user_id
        self.private_ok = private_ok
        self.mode: str | None = None
        self.rebuild()

    def rebuild(self):
        self.clear_items()
        if self.mode is None:
            self.add_item(ModeButton(self, "public", "公開チャンネル", "📢"))
            self.add_item(ModeButton(self, "private", "プライベートスレッド", "🔒", disabled=not self.private_ok))
        else:
            self.add_item(CharacterSelect(self.cog, self))
            self.add_item(ModeBackButton(self))

    def embed(self) -> discord.Embed:
        if self.mode is None:
            lines = [
                "会話を行う場所を選んでください。",
                "",
                "**📢 公開チャンネル**",
                "このチャンネルで会話します。他のメンバーにも見えます。",
                "",
                "**🔒 プライベートスレッド**",
                "あなたとBotだけが見えるスレッドを作って会話します。",
            ]
            if not self.private_ok:
                lines += ["", "-# ここは通常のテキストチャンネルではないため、プライベートスレッドは選べません。"]
            return discord.Embed(title="ZetaModoki — 会話モードの選択",
                                 description="\n".join(lines), color=discord.Color.purple())
        label = "公開チャンネル" if self.mode == "public" else "プライベートスレッド"
        return discord.Embed(
            title="ZetaModoki — キャラクターの選択",
            description=f"会話モード: **{label}**\n会話したいキャラクターを選んでください。選ぶとすぐに開始します。",
            color=discord.Color.purple(),
        )


# --- Main Cog ---
class ZetaModoki(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        # ロールプレイ向けの会話品質を優先し、LogfareのGemma 4 26Bを既定にする。
        default_model = "gemma-4-26b"
        self.model_name = os.getenv("LOGFARE_ZETAMODOKI_MODEL", default_model).strip() or default_model

        # チャンネルID (int) をキーとして管理
        self.active_personas: Dict[int, BotPersona] = {}
        self.chat_histories: Dict[int, List[dict]] = {}
        self.failed_requests: Dict[int, dict] = {}
        # ユーザー登録シチュエーション（1人3個まで）
        self.custom = CustomSituationStore()

    async def start(self, interaction: discord.Interaction):
        view = CharacterSelectView(
            self, interaction.user.id,
            private_ok=isinstance(interaction.channel, discord.TextChannel),
        )
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def register(self, interaction: discord.Interaction):
        """キャラクター＋シチュエーションの新規登録フォームを開く。"""
        if not isinstance(interaction, discord.Interaction):
            return await interaction.response.send_message(
                "登録には入力フォームが必要なため、`/general` のパネルから実行してください。")
        if len(self.custom.list(interaction.user.id)) >= MAX_CUSTOM_PER_USER:
            return await interaction.response.send_message(
                f"登録できるのは1人{MAX_CUSTOM_PER_USER}個までです。「登録を管理」から不要な登録を削除してください。",
                ephemeral=True,
            )
        await interaction.response.send_modal(CustomPersonaModal(self, interaction.user.id))

    async def manage(self, interaction: discord.Interaction):
        """登録済みシチュエーションの管理画面（本人にだけ表示）。"""
        if not isinstance(interaction, discord.Interaction):
            return await interaction.response.send_message(
                "管理画面は本人にだけ表示する必要があるため、`/general` のパネルから実行してください。")
        view = CustomManageView(self, interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def reset(self, interaction: discord.Interaction):
        channel_id = interaction.channel_id
        if channel_id in self.chat_histories:
            self.chat_histories[channel_id] = []
            self.failed_requests.pop(channel_id, None)
            await interaction.response.send_message("このチャンネルの会話履歴をリセットしました。", ephemeral=True)
        else:
            await interaction.response.send_message("リセットする会話履歴がありません。", ephemeral=True)

    def _format_narration(self, text: str) -> str:
        """カッコ （） や () で囲まれたナレーション表現の前に -# を挿入して薄文字化する"""
        text = re.sub(r'（(.*?)）', r'\n-# （\1）\n', text)
        text = re.sub(r'\((.*?)\)', r'\n-# (\1)\n', text)
        text = re.sub(r'\n+', '\n', text).strip()
        return text

    async def _get_or_create_webhook(self, channel: discord.TextChannel | discord.Thread) -> discord.Webhook:
        """親テキストチャンネルから管理用Webhookを取得または作成する"""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        if not isinstance(parent, discord.TextChannel):
            raise RuntimeError("Webhookの親テキストチャンネルを取得できませんでした。")
        webhooks = await parent.webhooks()
        for wh in webhooks:
            if wh.name == "ZetaModoki_Webhook":
                return wh
        return await parent.create_webhook(name="ZetaModoki_Webhook")

    async def _send_webhook_message(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        content: str,
        *,
        retry_owner_id: int | None = None,
        retry_input: str | None = None,
        include_view: bool = True,
    ):
        """キャラクターの名前・アイコンを設定し、長文を分割して送る"""
        persona = self.active_personas.get(channel_id)
        if not persona:
            return

        webhook = await self._get_or_create_webhook(channel)
        private_thread = (
            isinstance(channel, discord.Thread)
            and channel.type == discord.ChannelType.private_thread
        )
        send_kwargs = {"thread": channel} if isinstance(channel, discord.Thread) else {}
        parts = self._split_long_message(content)
        sent_messages = []
        for index, part in enumerate(parts):
            view = None
            if include_view and index == len(parts) - 1:
                view = ChatButtonView(
                    self,
                    retry_owner_id=retry_owner_id,
                    retry_input=retry_input,
                    private_thread=private_thread,
                )
            message_kwargs = dict(
                content=part,
                username=persona.name,
                avatar_url=persona.icon_url,
                allowed_mentions=discord.AllowedMentions.none(),
                **send_kwargs,
                wait=True,
            )
            if view is not None:
                message_kwargs["view"] = view
            message = await webhook.send(**message_kwargs)
            if message is not None:
                sent_messages.append(message)
        return sent_messages

    async def _send_streamed_response(
        self,
        channel: discord.TextChannel | discord.Thread,
        channel_id: int,
        user_input: str,
        requester_id: int,
    ):
        """Logfareの生成差分を文単位で送り、失敗時は再試行ボタンを付ける。"""
        pending = ""
        last_message = None

        async def send_ready_text(delta: str):
            nonlocal pending, last_message
            pending += delta
            while True:
                cut = self._ready_stream_cut(pending)
                if cut is None:
                    break
                part, pending = pending[:cut], pending[cut:]
                sent = await self._send_webhook_message(
                    channel=channel,
                    channel_id=channel_id,
                    content=self._format_narration(part.strip()),
                    include_view=False,
                )
                if sent:
                    last_message = sent[-1]

        response_text = await self._generate_response(
            channel_id,
            user_input,
            on_delta=send_ready_text,
            requester_id=requester_id,
        )
        is_error = response_text.startswith(("（エラーが発生しました:", "（AIから返答がありませんでした"))
        if pending.strip():
            sent = await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(pending.strip()),
                include_view=not is_error,
            )
            if sent:
                last_message = sent[-1]
        if is_error:
            await self._send_webhook_message(
                channel=channel,
                channel_id=channel_id,
                content=self._format_narration(response_text),
                retry_owner_id=requester_id,
                retry_input=user_input,
            )
        elif pending.strip() == "" and last_message is not None:
            private_thread = (
                isinstance(channel, discord.Thread)
                and channel.type == discord.ChannelType.private_thread
            )
            await last_message.edit(
                view=ChatButtonView(self, private_thread=private_thread)
            )
        return response_text

    @staticmethod
    def _split_long_message(text: str, limit: int = 1800) -> list[str]:
        """Discordの本文上限を越えないよう、文境界を優先して分割する。"""
        chunks = []
        while len(text) > limit:
            candidates = [
                text.rfind(mark, 0, limit) + len(mark)
                for mark in ("\n", "。", "！", "？", "!", "?")
                if text.rfind(mark, 0, limit) >= 0
            ]
            cut = max(candidates, default=0)
            if cut < limit // 2:
                cut = limit
            chunks.append(text[:cut])
            text = text[cut:]
        if text:
            chunks.append(text)
        return chunks

    @staticmethod
    def _ready_stream_cut(text: str) -> int | None:
        """文末が届いたら送信し、長い未完文も上限内で順次表示する。"""
        limit = 1400
        search_text = text[:limit]
        boundaries = [
            search_text.rfind(mark) + len(mark)
            for mark in ("\n", "。", "！", "？", "!", "?", "…")
            if search_text.rfind(mark) >= 0
        ]
        boundary = max(boundaries, default=0)
        if boundary >= 60:
            return boundary
        if len(text) >= limit:
            return limit
        if len(text) >= 500:
            return 500
        return None

    async def _generate_response(
        self,
        channel_id: int,
        user_input: str,
        on_delta=None,
        requester_id: int | None = None,
    ) -> str:
        persona = self.active_personas[channel_id]
        history = self.chat_histories.get(channel_id, [])

        messages = [{"role": "system", "content": persona.build_system_instruction()}]
        # 最初の発言も含め、assistant/userの対話順をLogfareへ渡して人格と文脈を維持する。
        messages.append({"role": "assistant", "content": persona.first_message})
        for turn in history:
            messages.append({"role": "user", "content": turn["user"]})
            messages.append({"role": "assistant", "content": turn["bot"]})
        messages.append({"role": "user", "content": user_input})

        try:
            reply_parts = []
            async for delta in logfare.chat_stream(self.model_name, messages, max_tokens=2400):
                reply_parts.append(delta)
                if on_delta is not None:
                    await on_delta(delta)
            bot_reply = "".join(reply_parts).strip()
            if not bot_reply.strip():
                if requester_id is not None:
                    self.failed_requests[channel_id] = {
                        "user_id": requester_id,
                        "user_input": user_input,
                    }
                return "（AIから返答がありませんでした。少し待ってからもう一度試してください。）"

            # 履歴管理（直近20件）
            history.append({"user": user_input, "bot": bot_reply})
            if len(history) > 20:
                history = history[-20:]
            self.chat_histories[channel_id] = history
            self.failed_requests.pop(channel_id, None)

            return bot_reply

        except Exception as e:
            if requester_id is not None:
                self.failed_requests[channel_id] = {
                    "user_id": requester_id,
                    "user_input": user_input,
                }
            return f"（エラーが発生しました: {e}）"


async def setup(bot: commands.Bot):
    await bot.add_cog(ZetaModoki(bot))