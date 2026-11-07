# -*- coding: utf-8 -*-
"""「爆弾処理班」（Bomb Busters 系の協力推理ゲーム）の純ロジック。

ルール（AGO版 v1・原典からの適応は実装ログ参照）:
- 数字ワイヤー（1〜12・各4枚）と赤ワイヤー（爆弾）を全員に配る。
  各自のラックは数字が小さい順に並ぶ（赤ワイヤーの位置だけは分からない）。
  自分のタイルは自分だけが見える。他人のタイルは枚数と位置だけが公開。
- 手番の人は、他人のタイル1枚について「○番だ」と宣言し、自分の同じ数字の
  タイルと対でカットする。当たれば両方カット、外せばミス（ヒューズ減）。
- 情報トークン（1人2個）を使うと、他人のタイル1枚の偶奇（または赤）を公開できる。
- 赤ワイヤーを宣言で触るか、ヒューズが尽きたら失敗。
  数字ワイヤーを全部カットできれば成功。
"""
import random

NUMBERS = tuple(range(1, 13))
COPIES = 4
RED = 0  # 赤ワイヤーの内部表現（数字タイルは 1〜12）
MAX_MISS = 4
INFO_TOKENS = 2


class WireCutGame:
    def __init__(self, players: list[int], rng=None, *, red_count: int | None = None,
                 max_miss: int = MAX_MISS):
        if len(players) < 2:
            raise ValueError("2人以上必要です")
        self.players = list(players)
        self.rng = rng if rng is not None else random
        self.max_miss = max_miss
        reds = len(self.players) if red_count is None else red_count
        tiles: list[int] = [n for n in NUMBERS for _ in range(COPIES)] + [RED] * reds
        self.rng.shuffle(tiles)
        self.racks: dict[int, list[int]] = {uid: [] for uid in self.players}
        for i, tile in enumerate(tiles):
            self.racks[self.players[i % len(self.players)]].append(tile)
        for uid in self.players:
            self.racks[uid] = self._sort_rack(self.racks[uid])
        self.cut: set[tuple[int, int]] = set()       # (持ち主, 位置) カット済み
        self.notes: dict[tuple[int, int], dict] = {}  # 公開メモ {"parity": "even"/"odd"/"red", "not": set()}
        self.info_left: dict[int, int] = {uid: INFO_TOKENS for uid in self.players}
        self.misses = 0
        self.turn_index = 0
        self.failed = False
        self.cleared = False

    def _sort_rack(self, rack: list[int]) -> list[int]:
        """数字タイルは昇順に並べ、赤ワイヤーはランダムな位置に差し込む。"""
        numbers = sorted(t for t in rack if t != RED)
        out = list(numbers)
        for _ in range(rack.count(RED)):
            out.insert(self.rng.randrange(len(out) + 1), RED)
        return out

    # ------------------------------------------------------------------ 状態
    @property
    def current(self) -> int:
        return self.players[self.turn_index % len(self.players)]

    @property
    def finished(self) -> bool:
        return self.failed or self.cleared

    def rack(self, user_id: int) -> list[int]:
        return self.racks[user_id]

    def is_cut(self, user_id: int, pos: int) -> bool:
        return (user_id, pos) in self.cut

    def remaining_numbers(self) -> int:
        total = 0
        for uid in self.players:
            for i, tile in enumerate(self.racks[uid]):
                if tile != RED and not self.is_cut(uid, i):
                    total += 1
        return total

    def can_act(self, user_id: int) -> bool:
        """宣言（未カットの数字タイル所持）か情報トークンのどちらかが使えるか。"""
        if self.info_left.get(user_id, 0) > 0:
            return True
        return any(tile != RED and not self.is_cut(user_id, i)
                   for i, tile in enumerate(self.racks[user_id]))

    def _advance_turn(self) -> None:
        for _ in range(len(self.players)):
            self.turn_index = (self.turn_index + 1) % len(self.players)
            if self.can_act(self.current):
                return

    # ------------------------------------------------------------------ 行動
    def find_partner(self, target_id: int, pos: int, number: int, prefer: int) -> tuple[int, int] | None:
        """number のペア相手（未カットの同数タイル）を探す。

        宣言者のラックを優先し、次に他のプレイヤー（対象本人の別の位置を含む）
        を探す。残り2枚が同じラックに寄っていても詰まらないための AGO 適応。
        """
        order = [prefer] + [uid for uid in self.players if uid != prefer]
        for uid in order:
            for i, t in enumerate(self.racks[uid]):
                if t == number and not self.is_cut(uid, i) and not (uid == target_id and i == pos):
                    return uid, i
        return None

    def declare(self, user_id: int, target_id: int, pos: int, number: int) -> dict | None:
        """他人のタイル pos が number だと宣言し、同数タイルと対で切る。

        ペア相手は宣言者の同数タイルを優先し、無ければチーム内の同数タイル
        （対象本人の別の位置を含む）から自動で選ぶ。対象は自分のラックでも
        よい（残りペアが1人のラックに寄っても詰まらないための AGO 適応）。
        戻り値: {"result": "cut"/"miss"/"bomb", ...}。不正な宣言は None。
        """
        if self.finished or user_id != self.current:
            return None
        if target_id not in self.racks or not (0 <= pos < len(self.racks[target_id])):
            return None
        if self.is_cut(target_id, pos) or number not in NUMBERS:
            return None
        partner = self.find_partner(target_id, pos, number, user_id)
        if partner is None:
            return None
        tile = self.racks[target_id][pos]
        if tile == RED:
            self.failed = True
            return {"result": "bomb", "target": target_id, "pos": pos}
        if tile == number:
            partner_uid, partner_pos = partner
            self.cut.add((target_id, pos))
            self.cut.add((partner_uid, partner_pos))
            if self.remaining_numbers() == 0:
                self.cleared = True
            else:
                self._advance_turn()
            return {"result": "cut", "target": target_id, "pos": pos,
                    "partner": partner_uid, "own_pos": partner_pos,
                    "number": number}
        # 外れ: その位置が「その数字ではない」ことが公開情報になる
        self.misses += 1
        note = self.notes.setdefault((target_id, pos), {})
        note.setdefault("not", set()).add(number)
        if self.misses >= self.max_miss:
            self.failed = True
        else:
            self._advance_turn()
        return {"result": "miss", "target": target_id, "pos": pos, "number": number,
                "actual": tile}

    def use_info(self, user_id: int, target_id: int, pos: int) -> dict | None:
        """情報トークンを使い、他人のタイル1枚の偶奇（赤ならその旨）を公開する。"""
        if self.finished or user_id != self.current or target_id == user_id:
            return None
        if self.info_left.get(user_id, 0) <= 0:
            return None
        if target_id not in self.racks or not (0 <= pos < len(self.racks[target_id])):
            return None
        if self.is_cut(target_id, pos):
            return None
        if self.notes.get((target_id, pos), {}).get("parity"):
            return None
        self.info_left[user_id] -= 1
        tile = self.racks[target_id][pos]
        parity = "red" if tile == RED else ("even" if tile % 2 == 0 else "odd")
        note = self.notes.setdefault((target_id, pos), {})
        note["parity"] = parity
        self._advance_turn()
        return {"result": "info", "target": target_id, "pos": pos, "parity": parity}

    # ------------------------------------------------------------------ 表示補助
    def public_rack(self, user_id: int) -> list[str]:
        """他人から見えるラック表示（位置ごとの公開情報だけ）。"""
        out = []
        for i, _tile in enumerate(self.racks[user_id]):
            if self.is_cut(user_id, i):
                out.append("済")
                continue
            note = self.notes.get((user_id, i), {})
            marks = []
            if note.get("parity") == "red":
                marks.append("赤")
            elif note.get("parity") == "even":
                marks.append("偶")
            elif note.get("parity") == "odd":
                marks.append("奇")
            if note.get("not"):
                marks.append("≠" + "/".join(str(n) for n in sorted(note["not"])))
            out.append("・".join(marks) if marks else "?")
        return out
