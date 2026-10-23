import unittest
from io import BytesIO
import zipfile

from core.ai_input import AttachmentInputError, build_user_content, has_image_attachment
from core.ai_provider_router import supports_images


class FakeAttachment:
    def __init__(self, filename, content_type, data):
        self.filename = filename
        self.content_type = content_type
        self.size = len(data)
        self.data = data

    async def read(self):
        return self.data


class AiInputTest(unittest.IsolatedAsyncioTestCase):
    async def test_image_is_encoded_as_data_uri_for_supported_models(self):
        image = FakeAttachment("picture.png", "image/png", b"png-bytes")
        content = await build_user_content("これ何？", [image], images_supported=True)
        self.assertEqual(content[0], {"type": "text", "text": "これ何？"})
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    async def test_image_is_rejected_for_unsupported_models(self):
        image = FakeAttachment("picture.png", "image/png", b"png-bytes")
        self.assertTrue(has_image_attachment([image]))
        with self.assertRaises(AttachmentInputError):
            await build_user_content("説明して", [image], images_supported=False)

    async def test_text_file_is_included_for_text_models(self):
        text_file = FakeAttachment("notes.md", "text/markdown", "内容です".encode())
        content = await build_user_content("要約", [text_file], images_supported=False)
        self.assertIn("【添付ファイル: notes.md】\n内容です", content)

    async def test_docx_text_is_extracted_locally(self):
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body><w:p><w:r><w:t>文書の内容</w:t></w:r></w:p></w:body></w:document>',
            )
        attachment = FakeAttachment("report.docx", None, buffer.getvalue())
        content = await build_user_content("要約", [attachment], images_supported=False)
        self.assertIn("【添付ファイル: report.docx】\n文書の内容", content)

    async def test_unsupported_binary_is_rejected(self):
        attachment = FakeAttachment("archive.zip", "application/zip", b"zip")
        with self.assertRaises(AttachmentInputError):
            await build_user_content("見て", [attachment], images_supported=False)

    def test_image_capability_requires_provider_evidence(self):
        self.assertTrue(supports_images("logfare", "vision-model", {
            "chat_capabilities": {"input_modalities": ["text", "image"]},
        }))
        self.assertTrue(supports_images("apinex", "free/gemini-3.8-flash"))
        self.assertFalse(supports_images("apinex", "free/muse-spark-1.3"))
        self.assertFalse(supports_images("kiosapi", "claude-example", {"id": "claude-example"}))


if __name__ == "__main__":
    unittest.main()
