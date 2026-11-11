// lib/one-prompter-download.ts の純粋ロジック（形式→ファイル名/MIME の対応と、
// 保存内容がテキストエリアの内容そのままであること）を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "one-prompter-download.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const clientSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "app", "one-prompter", "OnePrompterClient.tsx"),
  "utf8",
);

test("ファイル名は形式ごとに固定の名前になる", () => {
  assert.equal(m.promptDownloadFileName("txt"), "one-prompter-prompt.txt");
  assert.equal(m.promptDownloadFileName("md"), "one-prompter-prompt.md");
});

test("MIME タイプは txt が text/plain、md が text/markdown", () => {
  assert.equal(m.promptDownloadMimeType("txt"), "text/plain");
  assert.equal(m.promptDownloadMimeType("md"), "text/markdown");
});

test("buildPromptDownload は形式に対応するファイル名と MIME を返す", () => {
  const txt = m.buildPromptDownload("txt", "本文");
  assert.equal(txt.fileName, "one-prompter-prompt.txt");
  assert.equal(txt.mimeType, "text/plain");
  const md = m.buildPromptDownload("md", "本文");
  assert.equal(md.fileName, "one-prompter-prompt.md");
  assert.equal(md.mimeType, "text/markdown");
});

test("内容はそのまま渡る（見出し・前置き・メタ情報を付けない）", () => {
  const text = "# 依頼\n\n次の条件で書いてください。\n- 具体的に\n- 短く言い切る\n";
  assert.equal(m.buildPromptDownload("md", text).content, text);
  assert.equal(m.buildPromptDownload("txt", text).content, text);
  assert.equal(m.buildPromptDownload("txt", "").content, "");
});

test("改行コードは LF にそろえる", () => {
  assert.equal(m.buildPromptDownload("txt", "a\r\nb\rc\nd").content, "a\nb\nc\nd");
  assert.equal(m.buildPromptDownload("md", "a\r\nb").content, "a\nb");
});

test("結果画面に .txt / .md の保存ボタンがあり、現在の編集内容を書き出す", () => {
  assert.match(clientSrc, />\s*\.txt で保存\s*</);
  assert.match(clientSrc, />\s*\.md で保存\s*</);
  assert.match(clientSrc, /buildPromptDownload\(format, phase\.prompt\)/);
  assert.match(clientSrc, /new Blob\(\[content\]/);
});
