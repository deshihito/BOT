"""!ai 用の添付ファイル検査とOpenAI互換画像入力の生成。"""
from __future__ import annotations

import base64
from io import BytesIO
import mimetypes
import zipfile
import xml.etree.ElementTree as ET
from typing import Any

MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MAX_TEXT_CHARS = 24_000
MAX_ATTACHMENTS = 4
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml",
    ".log", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".sql", ".toml",
    ".ini", ".sh", ".java", ".c", ".h", ".cpp", ".rs", ".go",
}
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class AttachmentInputError(ValueError):
    """利用できない、または上限を超えた添付ファイル。"""


def attachment_mime(attachment: Any) -> str:
    content_type = (getattr(attachment, "content_type", None) or "").split(";", 1)[0].lower()
    if content_type:
        return content_type
    return mimetypes.guess_type(getattr(attachment, "filename", ""))[0] or "application/octet-stream"


def has_image_attachment(attachments: list[Any]) -> bool:
    return any(attachment_mime(item).startswith("image/") for item in attachments)


async def build_user_content(prompt: str, attachments: list[Any], *, images_supported: bool) -> str | list[dict[str, Any]]:
    """テキスト添付は本文化し、対応モデルに限り画像をdata URIで渡す。"""
    if len(attachments) > MAX_ATTACHMENTS:
        raise AttachmentInputError(f"添付は一度に{MAX_ATTACHMENTS}個までです。")
    image_attachments = [item for item in attachments if attachment_mime(item).startswith("image/")]
    if image_attachments and not images_supported:
        raise AttachmentInputError("選択中のモデルは画像入力に対応していません。画像対応モデルを選んでください。")

    sections = [prompt.strip()] if prompt.strip() else []
    image_parts: list[dict[str, Any]] = []
    text_size = 0
    total_bytes = 0
    for item in attachments:
        filename = getattr(item, "filename", "添付ファイル")
        mime = attachment_mime(item)
        declared_size = int(getattr(item, "size", 0) or 0)
        if declared_size > MAX_ATTACHMENT_BYTES:
            raise AttachmentInputError(f"{filename}: 添付サイズは8MBまでです。")
        if mime in IMAGE_TYPES:
            data = await item.read()
            if len(data) > MAX_ATTACHMENT_BYTES:
                raise AttachmentInputError(f"{filename}: 添付サイズは8MBまでです。")
            total_bytes += len(data)
            if total_bytes > MAX_TOTAL_BYTES:
                raise AttachmentInputError("添付ファイルの合計サイズは12MBまでです。")
            encoded = base64.b64encode(data).decode("ascii")
            image_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{encoded}"},
            })
            continue

        suffix = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
        is_pdf = suffix == ".pdf" or mime == "application/pdf"
        is_docx = suffix == ".docx" or mime == DOCX_MIME
        if suffix not in TEXT_EXTENSIONS and not mime.startswith("text/") and not is_pdf and not is_docx:
            raise AttachmentInputError(
                f"{filename}: 対応形式はJPG/PNG/WEBP画像、PDF、DOCX、テキスト系ファイルです。"
            )
        data = await item.read()
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise AttachmentInputError(f"{filename}: 添付サイズは8MBまでです。")
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_BYTES:
            raise AttachmentInputError("添付ファイルの合計サイズは12MBまでです。")
        if is_pdf:
            try:
                from pypdf import PdfReader
                text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(data)).pages)
            except Exception as exc:
                raise AttachmentInputError(f"{filename}: PDFからテキストを読み取れませんでした。") from exc
            if not text.strip():
                raise AttachmentInputError(f"{filename}: テキストを抽出できません。画像PDFは未対応です。")
        elif is_docx:
            try:
                with zipfile.ZipFile(BytesIO(data)) as archive:
                    if archive.getinfo("word/document.xml").file_size > MAX_TEXT_CHARS * 4:
                        raise AttachmentInputError(f"{filename}: DOCX本文のサイズが大きすぎます。")
                    xml_data = archive.read("word/document.xml")
                root = ET.fromstring(xml_data)
                text = "\n".join(
                    "".join(node.itertext())
                    for node in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p")
                )
            except Exception as exc:
                raise AttachmentInputError(f"{filename}: DOCXからテキストを読み取れませんでした。") from exc
        else:
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise AttachmentInputError(f"{filename}: UTF-8のテキストファイルを指定してください。") from exc
        if text_size + len(text) > MAX_TEXT_CHARS:
            raise AttachmentInputError("テキスト添付の合計は24,000文字までです。")
        text_size += len(text)
        sections.append(f"【添付ファイル: {filename}】\n{text}")

    sections.append("添付内容を確認して回答してください。" if not sections else "")
    text_content = "\n\n".join(section for section in sections if section)
    if not image_parts:
        return text_content
    return [{"type": "text", "text": text_content}, *image_parts]
