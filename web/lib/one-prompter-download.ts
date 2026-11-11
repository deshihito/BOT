// One Prompter の完成プロンプトをファイルとして保存するための対応表。
// 保存はクライアント側（Blob + a[download]）だけで完結し、ここでは形式ごとの
// ファイル名・MIME タイプと、書き出す内容の整形だけを担う純粋関数を置く。

/** 保存形式。txt はプレーンテキスト、md は Markdown としてそのまま使える形。 */
export type PromptDownloadFormat = "txt" | "md";

const FILE_NAMES: Record<PromptDownloadFormat, string> = {
  txt: "one-prompter-prompt.txt",
  md: "one-prompter-prompt.md",
};

const MIME_TYPES: Record<PromptDownloadFormat, string> = {
  txt: "text/plain",
  md: "text/markdown",
};

export function promptDownloadFileName(format: PromptDownloadFormat): string {
  return FILE_NAMES[format];
}

export function promptDownloadMimeType(format: PromptDownloadFormat): string {
  return MIME_TYPES[format];
}

export type PromptDownload = {
  fileName: string;
  mimeType: string;
  /** 書き出す内容。テキストエリアにあるテキストそのまま（改行コードだけ LF にそろえる）。 */
  content: string;
};

/**
 * 保存に必要な一式を組み立てる。
 * 内容には見出し・前置き・メタ情報を一切付けず、改行コードを LF にそろえる以外は手を入れない。
 * Blob に文字列を渡せば UTF-8（BOM なし）で書き出される。
 */
export function buildPromptDownload(format: PromptDownloadFormat, text: string): PromptDownload {
  return {
    fileName: promptDownloadFileName(format),
    mimeType: promptDownloadMimeType(format),
    content: text.replace(/\r\n|\r/g, "\n"),
  };
}
