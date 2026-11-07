"""Components V2で既存のセレクト系パネルを表示する補助。"""
from __future__ import annotations

import asyncio
import inspect
import logging
import traceback

import discord

logger = logging.getLogger(__name__)

__all__ = [
    "embed_text",
    "embed_media_gallery",
    "build_rows",
    "PanelLayoutView",
    "EmbedLayoutView",
    "as_embed_v2",
    "edit_panel_v2",
    "edit_message_v2",
    "as_panel_v2",
]

TEXT_DISPLAY_LIMIT = 4000
TRUNCATION_MARKER = "-# ⚠️ 表示が長いため、一部が省略されました"


def embed_text(embed: discord.Embed | None) -> str:
    """Embed相当の内容をComponents V2のTextDisplay用Markdownへ変換する。

    TextDisplay の上限（4,000字）を超える場合は黙って切らず、末尾に
    省略マーカーを付けて警告ログを残す（表示モダン化監査 §4.2-12）。
    """
    if embed is None:
        return "(表示内容がありません)"
    parts: list[str] = []
    if embed.title:
        parts.append(f"## {embed.title}")
    if embed.description:
        parts.append(embed.description)
    for field in embed.fields:
        parts.append(f"**{field.name}**\n{field.value}")
    if embed.footer and embed.footer.text:
        parts.append(f"-# {embed.footer.text}")
    if getattr(embed, "author", None) is not None and getattr(embed.author, "name", None) \
            or getattr(embed, "timestamp", None) is not None:
        # author / timestamp は TextDisplay 化で保持できない（画像は
        # embed_media_gallery が別途保持する）。欠落を黙認しないための記録。
        logger.debug("panel_v2: embed の author/timestamp は V2 変換で保持されません (title=%r)", embed.title)
    text = "\n\n".join(parts)
    if len(text) > TEXT_DISPLAY_LIMIT:
        logger.warning(
            "panel_v2: embed_text が %d 字を超えたため省略しました (title=%r)",
            TEXT_DISPLAY_LIMIT, embed.title,
        )
        text = text[: TEXT_DISPLAY_LIMIT - len(TRUNCATION_MARKER) - 2] + "\n\n" + TRUNCATION_MARKER
    return text or "(表示内容がありません)"


def embed_media_gallery(embed: discord.Embed | None) -> discord.ui.MediaGallery | None:
    """Embed の画像/サムネイルを V2 の MediaGallery で保持する。

    ラッパーの Markdown 化では embed の image / thumbnail が失われるため、
    URL があれば（http(s) でも attachment:// でも）ギャラリーとして
    Container に残す。attachment:// の実ファイルは送信側が
    edit_panel_v2(files=...) 等で再供給する必要がある（§4.2-8）。
    """
    if embed is None:
        return None
    urls: list[str] = []
    for holder in (getattr(embed, "image", None), getattr(embed, "thumbnail", None)):
        url = getattr(holder, "url", None)
        if url and url not in urls:
            urls.append(url)
    if not urls:
        return None
    gallery = discord.ui.MediaGallery()
    for url in urls:
        gallery.add_item(media=url)
    return gallery


def build_rows(items: list[discord.ui.Item]) -> list[list[discord.ui.Item]]:
    """V1のchildrenをComponents V2のActionRow規約へ分割する。

    - Selectは1つのActionRowに1つだけ
    - Button等は1つのActionRowに5つまで
    """
    explicit: dict[int, list[discord.ui.Item]] = {}
    auto: list[discord.ui.Item] = []
    for item in items:
        row = getattr(item, "row", None)
        if row is None:
            auto.append(item)
        else:
            explicit.setdefault(row, []).append(item)

    groups = [explicit[r] for r in sorted(explicit)]
    if auto:
        groups.append(auto)

    rows: list[list[discord.ui.Item]] = []
    buffer: list[discord.ui.Item] = []
    for group in groups:
        for item in group:
            if isinstance(item, discord.ui.Select):
                if buffer:
                    rows.append(buffer)
                    buffer = []
                rows.append([item])
            else:
                buffer.append(item)
                if len(buffer) >= 5:
                    rows.append(buffer)
                    buffer = []
        if buffer:
            rows.append(buffer)
            buffer = []
    return rows


class _Completed:
    """``await`` しても何も起きない完了済みawaitable（未awaitでも警告が出ない）。"""

    def __await__(self):
        return
        yield  # pragma: no cover


class PanelLayoutView(discord.ui.LayoutView):
    """既存のdiscord.ui.Viewを1つのContainerへ包むV2ビュー。

    既存Selectのcallbackから見える ``genre`` や ``refresh`` はこのクラスが
    プロキシし、状態変更時も同じV2メッセージを再構築する。
    """

    def __init__(self, panel: discord.ui.View):
        super().__init__(timeout=panel.timeout)
        self.panel = panel
        self._sync()

    # ------------------------------------------------------------------
    # 属性プロキシ
    # ------------------------------------------------------------------
    # 重要: discord.py内部の状態（_BaseView__timeout_expiry / __stopped /
    # __timeout_task / _children など）をpanelへ転送してはいけない。
    # 転送するとラッパー自身のタイムアウト管理が壊れ、登録直後に
    # 「終了済みView」扱いになってボタン/セレクトが一切応答しなくなる。
    # そのため「公開名（_で始まらない）かつ LayoutView 自体の属性ではない」
    # ものだけをpanelへ転送する。
    _OWN_NAMES = frozenset(dir(discord.ui.LayoutView)) | {"panel"}

    def __setattr__(self, name, value):
        panel = self.__dict__.get("panel")
        if (
            panel is not None
            and not name.startswith("_")
            and name not in PanelLayoutView._OWN_NAMES
            and hasattr(panel, name)
        ):
            setattr(panel, name, value)
            return
        super().__setattr__(name, value)

    def __getattr__(self, name):
        if name != "panel" and not name.startswith("__"):
            panel = self.__dict__.get("panel")
            if panel is not None and hasattr(panel, name):
                return getattr(panel, name)
        raise AttributeError(name)

    # ------------------------------------------------------------------
    def _sync(self):
        self.clear_items()
        rows = build_rows(list(self.panel.children))
        source_embed = self.panel.embed()
        if source_embed is None:
            source_embed = discord.Embed()
        items: list[discord.ui.Item] = [discord.ui.TextDisplay(embed_text(source_embed))]
        gallery = embed_media_gallery(source_embed)
        if gallery is not None:
            items.append(gallery)
        items.extend(discord.ui.ActionRow(*row) for row in rows)
        container = discord.ui.Container(
            *items,
            accent_colour=getattr(source_embed, "colour", None),
        )
        self.add_item(container)  # このときitem.viewがこのラッパーになる

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        # 元パネルに実行者制限などがあればそれを引き継ぐ
        return await self.panel.interaction_check(interaction)

    async def on_error(self, interaction: discord.Interaction, error: Exception, item=None) -> None:
        """例外を必ずACKして可視化する（無応答エラーの防止と原因特定用）。

        ただし ``InteractionResponded`` は可視化しない。その時点で
        panel_recovery か callback 自身の先行処理が既に応答を届けており、
        利用者への追加通知は誤報でしかない（生存中 callback が応答に
        遅れて recovery と競合した場合に「内部エラー: 40060」が利用者に
        見えてしまう事故の再発防止）。
        """
        if isinstance(error, discord.InteractionResponded):
            logger.debug("パネル: 応答済みのためエラーを握ります (%s)", error)
            return
        traceback.print_exception(type(error), error, error.__traceback__)
        try:
            if interaction.response.is_done():
                await interaction.followup.send(f"⚠️ 内部エラー: {error}", ephemeral=True)
            else:
                await interaction.response.send_message(f"⚠️ 内部エラー: {error}", ephemeral=True)
        except discord.HTTPException:
            logger.debug("パネル: エラー通知の送信に失敗しました", exc_info=True)

    def refresh(self, interaction: discord.Interaction | None = None, *args, **kwargs):
        """状態を更新する。戻り値は常に await 可能。

        - view.refresh()                  : 画面部品だけ再構築（await有無どちらでも可）。
        - await view.refresh(interaction) : 再構築 + メッセージ編集まで行う。

        サーバーアシストの設定画面は refresh(interaction, notice) のように
        notice を追加で渡す。その場合はラップしているパネル側の refresh に
        委譲する（このラッパー自身の refresh とシグネチャが衝突するため）。
        """
        if args or kwargs:
            return self.panel.refresh(interaction, *args, **kwargs)
        self.panel.genre = getattr(self, "genre", getattr(self.panel, "genre", None))
        pending = self.panel.refresh()

        if inspect.isawaitable(pending):
            async def _run():
                await pending
                self._sync()
                if interaction is not None:
                    await edit_panel_v2(interaction, self)

            if interaction is None:
                # 呼び出し側がawaitしなくても必ず実行されるようにする
                return asyncio.ensure_future(_run())
            return _run()

        self._sync()
        if interaction is None:
            return _Completed()
        return edit_panel_v2(interaction, self)

    def embed(self):
        # V2メッセージはEmbedを持てないため、callback互換の空値を返す。
        return None

    async def show(self, interaction, category_id, page):
        """/help のページ遷移をV2ビューのまま行う。"""
        if self.panel.__class__.__name__ != "HelpView":
            return await self.panel.show(interaction, category_id, page)
        next_panel = self.panel.__class__(
            self.panel.catalog, category_id, page,
            getattr(self.panel, "shortcut_mode", False),
            getattr(self.panel, "shortcut_item", None),
        )
        self.stop()
        return await edit_panel_v2(interaction, PanelLayoutView(next_panel))


class EmbedLayoutView(discord.ui.LayoutView):
    """Embedを1つのContainerに包んだ、操作部品なしの表示専用V2ビュー。

    ロール一括操作の完了/キャンセル表示など、ボタンやセレクトを持たない
    メッセージ用。``followup.send(view=...)`` / ``edit_panel_v2`` の両方で使える。
    """

    def __init__(self, embed: discord.Embed | None):
        super().__init__(timeout=None)
        items: list[discord.ui.Item] = [discord.ui.TextDisplay(embed_text(embed))]
        gallery = embed_media_gallery(embed)
        if gallery is not None:
            items.append(gallery)
        self.add_item(
            discord.ui.Container(
                *items,
                accent_colour=getattr(embed, "colour", None),
            )
        )


def as_embed_v2(embed: discord.Embed | None) -> EmbedLayoutView:
    return EmbedLayoutView(embed)


async def edit_panel_v2(interaction: discord.Interaction, view: discord.ui.LayoutView,
                        files: list[discord.File] | None = None):
    """Edit a message with a V2 view, clearing legacy message payloads.

    V1メッセージ(content/embed付き)をV2へ置き換える編集では、
    content / embeds / attachments を明示的にクリアしないとDiscordに拒否され、
    ユーザーには「応答しませんでした」と見える。

    files を渡すと添付をクリアせず再供給する。embed の画像が
    attachment:// 参照の場合、V2 側の MediaGallery（embed_media_gallery）
    が参照する実ファイルはこの形で送り直す必要がある（§4.2-8）。
    """
    attachments = list(files) if files else []
    if interaction.response.is_done():
        return await interaction.edit_original_response(
            content=None, embed=None, attachments=attachments, view=view,
        )
    return await interaction.response.edit_message(
        content=None, embed=None, attachments=attachments, view=view,
    )


async def edit_message_v2(message: discord.Message, view: discord.ui.LayoutView,
                          files: list[discord.File] | None = None):
    """Replace a normal message with a Components V2 view safely."""
    attachments = list(files) if files else []
    return await message.edit(content=None, embed=None, attachments=attachments, view=view)


def as_panel_v2(panel: discord.ui.View) -> PanelLayoutView:
    return PanelLayoutView(panel)
