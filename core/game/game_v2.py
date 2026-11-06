# -*- coding: utf-8 -*-
"""ラウンド4以降の新規ゲーム用 Components V2 パネル基盤。

方針（ユーザー指示 2026-11-06）:
- ゲーム系は基本 Components V2 で実装する。V2 メッセージに旧来 embed を混ぜない。
- 1メッセージのボタン数・行数は Discord 上限に余裕を持って収める
  （このモジュールの上限チェックで担保する: ActionRow は最大5行、各行最大5ボタン）。
- 格子状にボタンを並べる場合はラベル幅を均一にする前提で設計する
  （盤面そのものは表示側＝テキスト描画/画像に分離し、操作はボタン/セレクトで行う）。

``PanelLayoutView``（core/panel_v2.py）は /game ハブ等の既存 View を包むための
もので、ゲーム単体のセッションパネルはこの ``GamePanelView``（ネイティブ
LayoutView）を使う。秘匿情報の ephemeral ビューも同じ流儀で作る。
"""
import logging
import time

import discord

from core.game.game_guides import preview_notice_line

__all__ = [
    "GamePanelView",
    "LobbyView",
    "preview_notice_line",
    "text_panel",
]

logger = logging.getLogger(__name__)

MAX_ROWS = 5          # Discord の ActionRow 上限
MAX_BUTTONS_PER_ROW = 5

#: ゲームパネルのユーザー単位クールダウン (E-16 の部分実施)。
#: 盤面の PIL 再描画を伴う操作の連打で Pi の応答性が落ちるのを防ぐ。
#: 対象は GamePanelView 系パネル (ボードゲーム・ラウンド4以降のゲーム)。
#: panel_v2 側の汎用パネル全体への一律適用は、対象 View の種類が広く
#: 影響を切り分けられないため見送り (GamePanelView に限定する)。
PANEL_COOLDOWN_SECONDS = 1.0


class InteractionCooldown:
    """ユーザー単位の短いクールダウン判定 (純粋な時刻計算のみ)。

    ``check`` が True のときだけ通し、その時刻を記録する。通らなかった
    呼び出しは記録を更新しない (連打し続けても待ち時間が延びない)。
    """

    def __init__(self, window: float = PANEL_COOLDOWN_SECONDS):
        self.window = float(window)
        self._last: dict[int, float] = {}

    def check(self, user_id: int, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else float(now)
        last = self._last.get(user_id)
        if last is not None and now - last < self.window:
            return False
        self._last[user_id] = now
        return True

    def remaining(self, user_id: int, now: float | None = None) -> float:
        now = time.monotonic() if now is None else float(now)
        last = self._last.get(user_id)
        if last is None:
            return 0.0
        return max(0.0, self.window - (now - last))


def count_buttons(view) -> int:
    """View 内のボタン総数（テスト・上限チェック用）。"""
    total = 0
    for item in view.walk_children():
        if isinstance(item, discord.ui.Button):
            total += 1
    return total


def assert_within_limits(view) -> None:
    """ボタン行数・総数が上限の余裕内に収まっていることを検証する。"""
    rows = 0
    for item in view.children:
        if isinstance(item, discord.ui.ActionRow):
            rows += 1
            buttons = [c for c in item.children if isinstance(c, discord.ui.Button)]
            if len(buttons) > MAX_BUTTONS_PER_ROW:
                raise ValueError("1行のボタン数が上限を超えています")
    if rows > MAX_ROWS:
        raise ValueError("ActionRow の行数が上限を超えています")


class GamePanelView(discord.ui.LayoutView):
    """タイトル＋本文（TextDisplay）と操作行（ActionRow）を持つ V2 パネル。

    本文は ``set_content`` で差し替えでき、操作部品は ``add_row`` で
    ActionRow 単位で積む。編集時は呼び出し側が ``message.edit(view=...)``
    または ``edit_message_v2`` を使う（旧ペイロードのクリアはそちらが担う）。
    """

    def __init__(self, title: str = "", body: str = "", *, timeout: float | None = 600,
                 notice: str | None = None):
        super().__init__(timeout=timeout)
        self._title = title
        self._body = body
        # タイトル直下に常時出す注意行（開発先行公開の注意文など）。
        # set_content で本文を差し替えても残る。None なら従来どおりの表示。
        self._notice = notice
        self._rows: list[discord.ui.ActionRow] = []
        self._extra: list[discord.ui.Item] = []
        # パネル単位×ユーザー単位のクールダウン (E-16)。所有者チェック等を
        # 上書きしているサブクラスは、最後に super().interaction_check を
        # 呼ぶことでこの制限も受ける。
        self._cooldown = InteractionCooldown()
        self._rebuild()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        user = getattr(interaction, "user", None)
        user_id = getattr(user, "id", None)
        if user_id is None or self._cooldown.check(user_id):
            return True
        try:
            await interaction.response.send_message(
                "操作が速すぎます。少し待ってからもう一度押してください。",
                ephemeral=True)
        except Exception:
            pass
        return False

    def _rebuild(self) -> None:
        self.clear_items()
        if self._notice:
            text = (f"## {self._title}\n{self._notice}\n{self._body}" if self._title
                    else f"{self._notice}\n{self._body}")
        else:
            text = f"## {self._title}\n{self._body}" if self._title else self._body
        container = discord.ui.Container(discord.ui.TextDisplay(text or "​"))
        for extra in self._extra:
            container.add_item(extra)
        self.add_item(container)
        for row in self._rows:
            self.add_item(row)

    def set_content(self, title: str | None = None, body: str | None = None) -> None:
        if title is not None:
            self._title = title
        if body is not None:
            self._body = body
        self._rebuild()

    def set_notice(self, notice: str | None) -> None:
        """タイトル直下の注意行を差し替える（None で消す）。"""
        self._notice = notice
        self._rebuild()

    def add_row(self, *items: discord.ui.Item) -> discord.ui.ActionRow:
        row = discord.ui.ActionRow(*items)
        self._rows.append(row)
        self._rebuild()
        return row

    def clear_rows(self) -> None:
        self._rows = []
        self._rebuild()

    def add_extra(self, item: discord.ui.Item) -> None:
        """Container 内に足す表示部品（Separator / MediaGallery 等）。"""
        self._extra.append(item)
        self._rebuild()


def text_panel(title: str, body: str) -> GamePanelView:
    """操作部品なしの表示専用 V2 パネル（結果発表など）。"""
    return GamePanelView(title, body, timeout=None)


# ----------------------------------------------------------------------
# パネルの後片付け（残留クリーンアップ、ユーザー指示 2026-11-07）
# ----------------------------------------------------------------------

async def safe_delete(message) -> bool:
    """役割を終えたパネル/ログメッセージを安全に削除する。

    既に消えている (NotFound)・権限がない (Forbidden)・テスト用の偽
    メッセージなど、失敗は全て握りつぶして False を返す。進行中
    セッションのパネルには使わないこと（消すのは役割終了後のものだけ）。
    """
    if message is None:
        return False
    try:
        await message.delete()
        return True
    except Exception:
        logger.debug("game_v2: メッセージ削除に失敗しました", exc_info=True)
        return False


async def original_response_or_none(interaction):
    """interaction の応答メッセージを返す（取れなければ None）。

    募集パネルを interaction 応答として出した cog が、開始時にその
    メッセージを削除するために使う。フェイク等で取得できない環境では
    None を返し、削除を諦める（本体の進行は止めない）。
    """
    getter = getattr(interaction, "original_response", None)
    if getter is None:
        return None
    try:
        return await getter()
    except Exception:
        return None


async def refresh_panel(interaction: discord.Interaction, view: "GamePanelView") -> None:
    """ボタンの callback から自分のパネルをその場で編集し直す。"""
    if interaction.response.is_done():
        await interaction.edit_original_response(
            content=None, embed=None, attachments=[], view=view)
    else:
        await interaction.response.edit_message(
            content=None, embed=None, attachments=[], view=view)


# ----------------------------------------------------------------------
# 統一ロビー（参加・参加後の反応の規格統一、ユーザー指示 2026-11-07）
# ----------------------------------------------------------------------

#: 募集まわりの統一文面（各ゲームで文言をばらけさせない）
LOBBY_MSG_ALREADY_JOINED = "すでに参加しています。"
LOBBY_MSG_NOT_JOINED = "参加していません。"
LOBBY_MSG_HOST_CANNOT_LEAVE = "主催者は退出できません。募集をやめる場合は「募集をやめる」を押してください。"
LOBBY_MSG_NOT_HOST = "開始できるのは主催者だけです。"
LOBBY_MSG_ALREADY_STARTED = "すでに開始しています。"


def lobby_msg_full(max_players: int) -> str:
    return f"定員（{max_players}人）に達しました。"


def lobby_msg_not_enough(min_players: int, current: int) -> str:
    return f"参加者が足りません（{min_players}人以上必要です）。現在 {current}人です。"


class LobbyView(GamePanelView):
    """全ゲーム共通の募集ロビー。

    規格:
    - 構成は「タイトル／案内文／参加者一覧（人数・必要人数つき）」＋
      ボタン行 [参加] [退出] / [開始する（主催者）] [募集をやめる（主催者）]。
    - 参加/退出は新規メッセージを出さず、このパネルをその場編集して
      反映する。本人へのエラー通知だけ ephemeral。
    - 人数不足の開始は統一文面で ephemeral 拒否する。
    - 主催者は退出できない（やめる場合は募集ごと取り消す）。
    - 開発先行公開ゲームは ``notice=preview_notice_line(game_id)`` を渡すと
      タイトル直下に注意行が常時出る（フラグの真実源は game_guides）。

    進行側 (cog) は ``started`` / ``cancelled`` をポーリングするか、
    ``wait()`` で待ち、``players``（参加順の user id リスト）と
    ``members``（id -> 押したときの user オブジェクト）を読む。
    """

    def __init__(self, *, title: str, host, min_players: int, max_players: int,
                 note: str = "", timeout: float | None = 600, join_hook=None,
                 notice: str | None = None):
        self.host_id = host.id
        self.min_players = int(min_players)
        self.max_players = int(max_players)
        self.note = note
        # 任意の参加時チェック: user を受け取り、拒否理由の文字列か None を
        # 返す（同期・非同期どちらでも可）。例: 賭け金あり対局の逮捕チェック。
        self.join_hook = join_hook
        self.players: list[int] = [host.id]
        self.members: dict[int, object] = {host.id: host}
        self.started = False
        self.cancelled = False
        self._event = None  # asyncio.Event（wait() を使ったときだけ作る）
        super().__init__(title, "", timeout=timeout, notice=notice)
        self.join = discord.ui.Button(label="参加", style=discord.ButtonStyle.success)
        self.join.callback = self._on_join
        self.leave = discord.ui.Button(label="退出", style=discord.ButtonStyle.secondary)
        self.leave.callback = self._on_leave
        self.start = discord.ui.Button(label="開始する（主催者）", style=discord.ButtonStyle.primary)
        self.start.callback = self._on_start
        self.cancel = discord.ui.Button(label="募集をやめる（主催者）", style=discord.ButtonStyle.danger)
        self.cancel.callback = self._on_cancel
        self.add_row(self.join, self.leave)
        self.add_row(self.start, self.cancel)
        self._sync_body()

    # ------------------------------------------------------------------
    def _sync_body(self) -> None:
        lines = []
        if self.note:
            lines.append(self.note)
        lines.append(f"参加者（{len(self.players)}人／{self.min_players}〜{self.max_players}人）:")
        for uid in self.players:
            mark = "（主催者）" if uid == self.host_id else ""
            lines.append(f"- <@{uid}>{mark}")
        self.set_content(body="\n".join(lines))

    def _finish_ui(self, body: str) -> None:
        self.clear_rows()
        self.set_content(body=body)

    def _wake(self) -> None:
        if self._event is not None:
            self._event.set()

    async def wait(self) -> None:
        """開始/取消/タイムアウトまで待つ（ポーリングしたくない cog 用）。"""
        import asyncio
        if self._event is None:
            self._event = asyncio.Event()
        await self._event.wait()

    async def on_timeout(self) -> None:
        self._wake()

    # ------------------------------------------------------------------
    async def _on_join(self, interaction: discord.Interaction) -> None:
        uid = interaction.user.id
        if self.started or self.cancelled:
            return await interaction.response.send_message("募集は終わりました。", ephemeral=True)
        if uid in self.players:
            return await interaction.response.send_message(LOBBY_MSG_ALREADY_JOINED, ephemeral=True)
        if len(self.players) >= self.max_players:
            return await interaction.response.send_message(
                lobby_msg_full(self.max_players), ephemeral=True)
        if self.join_hook is not None:
            import inspect
            reason = self.join_hook(interaction.user)
            if inspect.isawaitable(reason):
                reason = await reason
            if reason:
                return await interaction.response.send_message(reason, ephemeral=True)
        self.players.append(uid)
        self.members[uid] = interaction.user
        self._sync_body()
        await refresh_panel(interaction, self)

    async def _on_leave(self, interaction: discord.Interaction) -> None:
        uid = interaction.user.id
        if self.started or self.cancelled:
            return await interaction.response.send_message("募集は終わりました。", ephemeral=True)
        if uid == self.host_id:
            return await interaction.response.send_message(LOBBY_MSG_HOST_CANNOT_LEAVE, ephemeral=True)
        if uid not in self.players:
            return await interaction.response.send_message(LOBBY_MSG_NOT_JOINED, ephemeral=True)
        self.players.remove(uid)
        self.members.pop(uid, None)
        self._sync_body()
        await refresh_panel(interaction, self)

    async def _on_start(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message(LOBBY_MSG_NOT_HOST, ephemeral=True)
        if self.started or self.cancelled:
            return await interaction.response.send_message(LOBBY_MSG_ALREADY_STARTED, ephemeral=True)
        if len(self.players) < self.min_players:
            return await interaction.response.send_message(
                lobby_msg_not_enough(self.min_players, len(self.players)), ephemeral=True)
        self.started = True
        self._finish_ui("開始します！")
        self._wake()
        await refresh_panel(interaction, self)
        self.stop()

    async def _on_cancel(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.host_id:
            return await interaction.response.send_message("取り消せるのは主催者だけです。", ephemeral=True)
        if self.started or self.cancelled:
            return await interaction.response.send_message("募集は終わりました。", ephemeral=True)
        self.cancelled = True
        self._finish_ui("募集は取り消されました。")
        self._wake()
        await refresh_panel(interaction, self)
        self.stop()
