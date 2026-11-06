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
import discord

MAX_ROWS = 5          # Discord の ActionRow 上限
MAX_BUTTONS_PER_ROW = 5


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

    def __init__(self, title: str = "", body: str = "", *, timeout: float | None = 600):
        super().__init__(timeout=timeout)
        self._title = title
        self._body = body
        self._rows: list[discord.ui.ActionRow] = []
        self._extra: list[discord.ui.Item] = []
        self._rebuild()

    def _rebuild(self) -> None:
        self.clear_items()
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
