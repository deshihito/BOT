# -*- coding: utf-8 -*-
"""にょっきゲーム（元ネタ: たけのこニョッキ）の進行ロジック（Discord 非依存）。

順番は決まっておらず、各プレイヤーが自分のタイミングで次の番号を
チャットで「1ニョッキ！」のように宣言する。宣言はこのモジュールの
``parse_declaration`` で全文一致のパターンとして判定する。

ルール:
- 対象番号への最初の正しい宣言が来たら、その人は勝ち抜け候補になる。
  最初の宣言から ``GRACE_SECONDS`` 以内に同じ番号をもう1人が宣言したら
  「同時宣言（カブり）」で両者とも1アウトを取り、ラウンドは終了する。
  猶予を過ぎれば最初の宣言者が勝ち抜け、対象番号が次へ進む。
- 対象でない番号を宣言した人は1アウトを取り、そのラウンドは退場
  （ラウンド自体は続く）。
- 宣言が無いままウィンドウ（``WINDOW_SECONDS``）が過ぎたら1回だけ
  延長し、それでも無ければアウト無しでラウンドを強制終了する。
- 勝ち抜けが進んで未宣言が1人だけ残ったら、その人が1アウトを取って
  ラウンド終了。3アウトで脱落。脱落者を除いて1人だけ残れば優勝、
  全員が同時に脱落条件に達したら引き分け。``MAX_ROUNDS`` ラウンドで
  決着しなければ、アウトの少ない人の勝ち（同数なら共同優勝）。

時刻は呼び出し側が単調時計の秒で渡す前提（テストで差し替え可能にする）。
"""
import random
import re
import unicodedata

MIN_PLAYERS = 2
MAX_PLAYERS = 8
MAX_OUTS = 3
MAX_ROUNDS = 10
WINDOW_SECONDS = 10.0
GRACE_SECONDS = 2.0

#: CPU が1ウィンドウで宣言を試みる確率と、そのうち番号を間違える割合。
CPU_DECLARE_CHANCE = 0.8
CPU_WRONG_CHANCE = 0.1

_DECLARATION_RE = re.compile(r"^(\d{1,2})\s*(?:ニョッキ|にょっき)[!。.…ー~]*$")


def parse_declaration(text) -> int | None:
    """発言が宣言なら番号を、そうでなければ None を返す。

    全文一致のみを宣言とみなす（雑談文への部分一致で誤爆しないため）。
    数字は半角/全角どちらでもよく、「3 ニョッキ」のような空白や
    語尾の「！」「。」は許容する。
    """
    if not isinstance(text, str):
        return None
    normalized = unicodedata.normalize("NFKC", text).strip()
    match = _DECLARATION_RE.match(normalized)
    if match is None:
        return None
    return int(match.group(1))


class NyokkiSession:
    """にょっきゲーム1対戦分の状態機械。"""

    def __init__(self, player_ids, cpu_ids=(), rng: random.Random | None = None):
        self.players = list(player_ids)
        self.cpu_ids = set(cpu_ids)
        self.rng = rng if rng is not None else random.Random()
        self.outs = {uid: 0 for uid in self.players}
        self.eliminated: set = set()
        self.round_no = 0
        self.finished = False
        self.champions: list = []
        self.draw = False
        # ラウンド内状態
        self.active: list = []
        self.escaped: set = set()
        self.round_out: set = set()
        self.target = 1
        self.pending = None  # (user_id, deadline) 最初の宣言の保留
        self.window_start = 0.0
        self.extended = False
        self.round_over = True
        self._cpu_plans: dict = {}  # user_id -> 宣言予定時刻

    # ------------------------------------------------------------------
    # 状態参照
    # ------------------------------------------------------------------
    def remaining(self) -> list:
        """このラウンドでまだ宣言でき、勝ち抜けも退場もしていない人。"""
        return [uid for uid in self.active
                if uid not in self.escaped and uid not in self.round_out]

    def is_cpu(self, user_id) -> bool:
        return user_id in self.cpu_ids

    def result_rows(self) -> list:
        """最終結果表示用: (user_id, アウト数, 脱落したか) を成績順に。"""
        return sorted(
            ((uid, self.outs[uid], uid in self.eliminated) for uid in self.players),
            key=lambda row: (row[2], row[1], self.players.index(row[0])))

    # ------------------------------------------------------------------
    # ラウンド開始
    # ------------------------------------------------------------------
    def start_round(self, now: float) -> None:
        if self.finished:
            return
        self.round_no += 1
        self.active = [uid for uid in self.players if uid not in self.eliminated]
        self.escaped = set()
        self.round_out = set()
        self.target = 1
        self.pending = None
        self.window_start = float(now)
        self.extended = False
        self.round_over = False
        self._plan_cpu(now)

    # ------------------------------------------------------------------
    # 宣言の処理
    # ------------------------------------------------------------------
    def declare(self, user_id, number: int, now: float) -> list:
        """宣言を処理し、起きた出来事（イベント辞書）の列を返す。"""
        events: list = []
        if self.finished or self.round_over:
            return events
        # 猶予を過ぎた保留は先に確定させる（過ぎた後の同番号は番号違いになる）。
        if self.pending is not None and now >= self.pending[1]:
            events += self._confirm_escape(now)
            if self.round_over or self.finished:
                return events
        if user_id not in self.active or user_id in self.escaped or user_id in self.round_out:
            return events
        if self.pending is not None and self.pending[0] == user_id:
            return events  # 最初の宣言者本人の二重宣言は無視
        if number != self.target:
            events += self._wrong_number(user_id, number, now)
            return events
        if self.pending is None:
            self.pending = (user_id, float(now) + GRACE_SECONDS)
            events.append({"type": "first", "user": user_id, "number": number})
            return events
        # 猶予内にもう1人の正しい宣言 → カブり。両者アウトでラウンド終了。
        first_user = self.pending[0]
        self.pending = None
        for uid in (first_user, user_id):
            self.outs[uid] += 1
            self.round_out.add(uid)
        events.append({"type": "collision", "users": [first_user, user_id],
                       "number": number})
        events += self._finish_round()
        return events

    def _wrong_number(self, user_id, number: int, now: float) -> list:
        events = [{"type": "wrong_number", "user": user_id, "number": number,
                   "target": self.target}]
        self.outs[user_id] += 1
        self.round_out.add(user_id)
        if self.pending is None:
            events += self._last_one_check()
        # 保留がある場合は、勝ち抜け確定時に残り1人かどうかを判定する。
        return events

    def _last_one_check(self) -> list:
        """未宣言が1人だけ残っていたら、その人にアウトを付けてラウンドを終える。"""
        rem = self.remaining()
        if len(rem) != 1:
            return []
        last = rem[0]
        self.outs[last] += 1
        self.round_out.add(last)
        events = [{"type": "last_one_out", "user": last}]
        events += self._finish_round()
        return events

    def _confirm_escape(self, now: float) -> list:
        """保留中の最初の宣言者を勝ち抜けにし、対象番号を進める。"""
        user_id = self.pending[0]
        number = self.target
        self.pending = None
        self.escaped.add(user_id)
        events = [{"type": "escape", "user": user_id, "number": number}]
        self.target += 1
        self.window_start = float(now)
        self.extended = False
        if len(self.remaining()) == 1:
            events += self._last_one_check()
        elif not self.remaining():
            events += self._finish_round()
        else:
            self._plan_cpu(now)
        return events

    # ------------------------------------------------------------------
    # 時間経過の処理
    # ------------------------------------------------------------------
    def tick(self, now: float) -> list:
        """猶予の確定とウィンドウのタイムアウトを処理する。"""
        events: list = []
        if self.finished or self.round_over:
            return events
        if self.pending is not None:
            if now >= self.pending[1]:
                events += self._confirm_escape(now)
            return events
        if now - self.window_start >= WINDOW_SECONDS:
            if not self.extended:
                self.extended = True
                self.window_start = float(now)
                events.append({"type": "extended", "number": self.target})
            else:
                events.append({"type": "forced_end", "number": self.target})
                events += self._finish_round()
        return events

    # ------------------------------------------------------------------
    # ラウンド・対戦の終了
    # ------------------------------------------------------------------
    def _finish_round(self) -> list:
        self.round_over = True
        self.pending = None
        self._cpu_plans = {}
        newly = [uid for uid in self.active
                 if self.outs[uid] >= MAX_OUTS and uid not in self.eliminated]
        self.eliminated.update(newly)
        events = [{"type": "round_end", "round": self.round_no, "eliminated": newly}]
        alive = [uid for uid in self.players if uid not in self.eliminated]
        if len(alive) == 1:
            self.finished = True
            self.champions = list(alive)
            events.append({"type": "match_end", "champions": list(alive),
                           "draw": False, "reason": "last_alive"})
        elif not alive:
            self.finished = True
            self.draw = True
            self.champions = []
            events.append({"type": "match_end", "champions": [],
                           "draw": True, "reason": "all_out"})
        elif self.round_no >= MAX_ROUNDS:
            self.finished = True
            fewest = min(self.outs[uid] for uid in alive)
            self.champions = [uid for uid in alive if self.outs[uid] == fewest]
            events.append({"type": "match_end", "champions": list(self.champions),
                           "draw": False, "reason": "round_limit"})
        return events

    # ------------------------------------------------------------------
    # CPU の宣言スケジュール
    # ------------------------------------------------------------------
    def _plan_cpu(self, now: float) -> None:
        """現在の対象番号のウィンドウについて、CPU の宣言予定を作る。"""
        self._cpu_plans = {}
        for uid in self.remaining():
            if uid not in self.cpu_ids:
                continue
            if self.rng.random() < CPU_DECLARE_CHANCE:
                self._cpu_plans[uid] = float(now) + self.rng.uniform(
                    0.4, WINDOW_SECONDS - 1.0)

    def due_cpu(self, now: float) -> list:
        """宣言予定時刻を過ぎた CPU を返し、その予定を消す。"""
        if self.finished or self.round_over:
            return []
        due = [uid for uid, at in self._cpu_plans.items() if at <= now]
        for uid in due:
            self._cpu_plans.pop(uid, None)
        return [uid for uid in due if uid in self.remaining()]

    def cpu_number(self, user_id) -> int:
        """CPU が宣言する番号（大抵は対象番号、たまに間違える）。"""
        if self.rng.random() < CPU_WRONG_CHANCE:
            wrong = self.target + self.rng.choice((-1, 1))
            return max(1, wrong)
        return self.target
