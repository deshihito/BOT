"""グローバルチャットの荒らし対策（NG ワード・連投制限・サーバーごとのブロック）。

設定は core.guild_settings（bot_kv の namespace "guild_settings"）の "globalchat" セクションに保存する:
    {"ng_words": [...], "blocked_users": [user_id, ...], "blocked_guilds": [guild_id, ...]}
/setup のグローバルチャットの画面から編集する。新しい SQL は使わない。
"""
from __future__ import annotations

import time
import unicodedata
from collections import defaultdict, deque
from typing import Any, Iterable, Optional

from core.guild_settings import get_store

SECTION = "globalchat"
MAX_WORDS = 100
MAX_BLOCKS = 100

# どのサーバーでも転送しない既定の NG ワード（正規化後の形で比較する）
DEFAULT_NG_WORDS = (
    "死ね", "殺す", "消えろ", "ちんこ", "まんこ", "fuck", "nigger",
    "discord.gg/", "discord.com/invite/",
)


def normalize(text: str) -> str:
    """NFKC → 小文字 → カタカナをひらがなに。空白は取り除く（"し ね" 対策）。"""
    text = unicodedata.normalize("NFKC", text or "").lower()
    out = []
    for ch in text:
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:  # ァ〜ヶ → ぁ〜ゖ
            ch = chr(code - 0x60)
        if not ch.isspace():
            out.append(ch)
    return "".join(out)


def find_ng_word(text: str, words: Iterable[str]) -> Optional[str]:
    """最初に見つかった NG ワード（元の表記）を返す。なければ None。"""
    body = normalize(text)
    for word in words:
        w = normalize(word)
        if w and w in body:
            return word
    return None


def parse_words(text: str) -> list[str]:
    """改行・カンマ区切りの入力を NG ワードの一覧にする（重複は除く）。"""
    seen, result = set(), []
    for part in (text or "").replace("、", ",").replace("\n", ",").split(","):
        part = part.strip()
        if part and normalize(part) not in seen:
            seen.add(normalize(part))
            result.append(part[:50])
    return result[:MAX_WORDS]


def parse_ids(text: str) -> list[int]:
    """改行・カンマ・空白区切りの ID 一覧。数字でないものは無視する。"""
    result = []
    for part in (text or "").replace(",", " ").replace("、", " ").split():
        part = part.strip("<@!&>#")
        if part.isdigit() and int(part) not in result:
            result.append(int(part))
    return result[:MAX_BLOCKS]


def _int_list(value: Any) -> list[int]:
    return [v for v in value if isinstance(v, int)] if isinstance(value, list) else []


def settings(guild_id: int) -> dict[str, list]:
    raw = get_store().get(guild_id, SECTION)
    words = raw.get("ng_words")
    return {
        "ng_words": [w for w in words if isinstance(w, str)] if isinstance(words, list) else [],
        "blocked_users": _int_list(raw.get("blocked_users")),
        "blocked_guilds": _int_list(raw.get("blocked_guilds")),
    }


async def save(guild_id: int, *, ng_words: list[str], blocked_users: list[int], blocked_guilds: list[int]) -> dict:
    return await get_store().update(guild_id, SECTION, ng_words=ng_words or None,
                                    blocked_users=blocked_users or None, blocked_guilds=blocked_guilds or None)


def is_blocked_by(target_guild_id: int, *, user_id: int, source_guild_id: int) -> bool:
    """転送先のサーバーが、この送信者または送信元サーバーをブロックしているか。"""
    s = settings(target_guild_id)
    return user_id in s["blocked_users"] or source_guild_id in s["blocked_guilds"]


class RateLimiter:
    """ユーザーごと（サーバーをまたいで）の連投制限。

    window 秒の間に limit 件まで。超えたら cooldown 秒のあいだ転送しない。
    クールダウン中にさらに送ると、クールダウンが延びる（最大 max_cooldown 秒）。
    """

    def __init__(self, limit: int = 5, window: float = 10.0, cooldown: float = 30.0,
                 max_cooldown: float = 300.0, clock=time.monotonic):
        self.limit, self.window, self.cooldown, self.max_cooldown = limit, window, cooldown, max_cooldown
        self.clock = clock
        self._hits: dict[int, deque] = defaultdict(deque)
        self._until: dict[int, float] = {}
        self._strikes: dict[int, int] = defaultdict(int)

    def check(self, user_id: int) -> tuple[bool, float, bool]:
        """(転送してよいか, 残りクールダウン秒, 今回初めて制限にかかったか) を返す。"""
        now = self.clock()
        until = self._until.get(user_id, 0.0)
        if now < until:
            # 送り続けている: クールダウンを延ばす
            self._until[user_id] = min(until + self.cooldown / 2, now + self.max_cooldown)
            return False, self._until[user_id] - now, False
        hits = self._hits[user_id]
        while hits and now - hits[0] > self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            self._strikes[user_id] += 1
            length = min(self.cooldown * self._strikes[user_id], self.max_cooldown)
            self._until[user_id] = now + length
            hits.clear()
            return False, length, True
        if not hits and now - until > self.max_cooldown:
            self._strikes.pop(user_id, None)  # しばらくおとなしければ段階を戻す
        hits.append(now)
        return True, 0.0, False
