# -*- coding: utf-8 -*-
"""常設グローバルVCルームの「テーマ」（話の話題）のプールと日替わり決定。

常設ルームはテーマを定期的に変えられる。自動テーマのルームは JST の日付が
変わるたびに、このプールからその日そのルームのテーマを決める。決定は
ルーム名と日付だけから決まる純粋関数なので、再起動しても同じ日は同じ
テーマになり、ルームごとに違うテーマが割り当たる。
"""
from __future__ import annotations

import datetime
import hashlib

# 自動テーマの候補（雑談の話題）。並び順が回り順になる。
THEME_POOL: tuple[str, ...] = (
    "好きな食べ物",
    "最近ハマっていること",
    "旅行の思い出",
    "子供の頃の夢",
    "おすすめの映画・ドラマ",
    "休日の過ごし方",
    "最近買ってよかったもの",
    "好きな音楽",
    "地元自慢",
    "今週の小さな幸せ",
    "もし宝くじが当たったら",
    "好きなゲーム",
    "最近気になったニュース",
    "得意料理・好きな料理",
    "会ってみたい有名人",
    "今年の目標",
    "好きな季節とその理由",
    "懐かしい遊び",
    "最近笑ったこと",
    "おすすめの本・漫画",
)

JST = datetime.timezone(datetime.timedelta(hours=9))


def theme_day(now: datetime.datetime | None = None) -> datetime.date:
    """テーマの区切りになる「今日」（JST の日付）。"""
    now = now or datetime.datetime.now(JST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=JST)
    return now.astimezone(JST).date()


def _room_offset(room_name: str) -> int:
    """ルーム名から決まる安定したオフセット（プロセスが変わっても同じ値）。"""
    digest = hashlib.md5(room_name.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big")


def theme_for(room_name: str, day: datetime.date, pool: tuple[str, ...] = THEME_POOL) -> str:
    """その日のそのルームの自動テーマを返す。日が進むとプールを順に回る。"""
    if not pool:
        return ""
    index = (day.toordinal() + _room_offset(room_name)) % len(pool)
    return pool[index]
