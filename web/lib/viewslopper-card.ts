// viewslopper の診断結果を 16:9 カード画像（PNG）にする描画。
// 生成はブラウザ側（Canvas）で完結させ、サーバーには負荷をかけない（bgcut と同じ判断）。

export const CARD_WIDTH = 1280;
export const CARD_HEIGHT = 720;

export type CardData = {
  url: string;
  title: string;
  score: number;
  grade: string;
  dimensions: { label: string; score: number }[];
  uxFriction: number | null;
  uxGrade: string;
  appearanceScore: number | null;
  appearanceGrade: string;
  scoreSource?: "llm" | "rules";
  rendered?: boolean;
  /** 診断日（カード生成日ではなく診断した日） */
  date: Date;
};

export function cardScoreColor(score: number): string {
  if (score < 20) return "#46a758";
  if (score < 40) return "#8ece5a";
  if (score < 60) return "#e5b83b";
  if (score < 80) return "#e57c3b";
  return "#e5484d";
}

/** 保存ファイル名: viewslopper-<host>-<score>.png（host が取れなければ result） */
export function buildCardFileName(url: string, score: number): string {
  let host = "result";
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "") || "result";
  } catch {
    // URLとして解釈できない場合は既定名
  }
  return `viewslopper-${host}-${score}.png`;
}

/** 文字数ベースの省略（Canvas の実測が使えない場面の保険） */
export function ellipsize(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

const FONT = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > 0 && lines.length < maxLines) {
    let end = rest.length;
    while (end > 0 && ctx.measureText(rest.slice(0, end)).width > maxWidth) end--;
    if (end === 0) end = 1;
    if (end < rest.length) {
      lines.push(rest.slice(0, end));
      rest = rest.slice(end);
    } else {
      lines.push(rest);
      rest = "";
    }
  }
  if (rest.length > 0 && lines.length > 0) {
    lines[lines.length - 1] = fitText(ctx, lines[lines.length - 1] + rest, maxWidth);
  }
  return lines;
}

/** 16:9 カードを canvas に描く。呼び出し側で toDataURL / toBlob して保存する。 */
export function drawScoreCard(canvas: HTMLCanvasElement, data: CardData): void {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // 背景と枠
  ctx.fillStyle = "#0e0f11";
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.strokeStyle = "#23252a";
  ctx.lineWidth = 2;
  roundRect(ctx, 24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48, 24);
  ctx.stroke();

  // ヘッダー
  ctx.fillStyle = "#f2f3f5";
  ctx.font = `700 30px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("viewslopper", 56, 86);
  ctx.fillStyle = "#8a8f98";
  ctx.font = `22px ${FONT}`;
  const dateText = `${data.date.getFullYear()}/${String(data.date.getMonth() + 1).padStart(2, "0")}/${String(data.date.getDate()).padStart(2, "0")}`;
  ctx.fillText(dateText, CARD_WIDTH - 56 - ctx.measureText(dateText).width, 86);
  ctx.strokeStyle = "#23252a";
  ctx.beginPath();
  ctx.moveTo(56, 112);
  ctx.lineTo(CARD_WIDTH - 56, 112);
  ctx.stroke();

  // 左: スコア本体
  ctx.fillStyle = "#8a8f98";
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText("SLOP SCORE", 56, 168);
  ctx.fillStyle = cardScoreColor(data.score);
  ctx.font = `800 190px ${FONT}`;
  ctx.fillText(String(data.score), 52, 348);
  ctx.fillStyle = "#f2f3f5";
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText(data.grade, 56, 416);

  // タイトルと URL
  ctx.fillStyle = "#d6d9de";
  ctx.font = `30px ${FONT}`;
  const titleLines = wrapText(ctx, data.title || data.url, 500, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, 56, 478 + i * 42));
  ctx.fillStyle = "#8a8f98";
  ctx.font = `22px ${FONT}`;
  ctx.fillText(fitText(ctx, data.url, 500), 56, 478 + titleLines.length * 42 + 8);

  // 左下: サブスコアのチップ
  const chips: string[] = [];
  if (data.uxFriction !== null) chips.push(`UX摩擦 ${data.uxFriction} ${data.uxGrade}`);
  if (data.appearanceScore !== null) chips.push(`外観 ${data.appearanceScore} ${data.appearanceGrade}`);
  chips.push(data.scoreSource === "llm" ? "採点: AI" : "採点: ルール計算");
  if (data.rendered) chips.push("取得: 描画経由");
  ctx.font = `22px ${FONT}`;
  let chipX = 56;
  let chipY = 612;
  for (const chip of chips) {
    const w = ctx.measureText(chip).width + 32;
    // チップは1行に収める（右側のバーは y≈570 で終わるため、この帯は全面使える）。
    // 2行に折り返すとフッター（y=676）と衝突するので幅は画面端まで許す。
    if (chipX + w > CARD_WIDTH - 56) {
      chipX = 56;
      chipY += 54;
    }
    ctx.fillStyle = "#17191c";
    roundRect(ctx, chipX, chipY, w, 44, 22);
    ctx.fill();
    ctx.strokeStyle = "#2c2f36";
    ctx.lineWidth = 1;
    roundRect(ctx, chipX, chipY, w, 44, 22);
    ctx.stroke();
    ctx.fillStyle = "#d6d9de";
    ctx.fillText(chip, chipX + 16, chipY + 30);
    chipX += w + 12;
  }

  // 右: 次元の内訳バー
  ctx.fillStyle = "#8a8f98";
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText("内訳", 640, 168);
  const barX = 820;
  const barW = 300;
  data.dimensions.slice(0, 6).forEach((d, i) => {
    const y = 196 + i * 68;
    ctx.fillStyle = "#d6d9de";
    ctx.font = `24px ${FONT}`;
    ctx.fillText(fitText(ctx, d.label, 168), 640, y + 22);
    ctx.fillStyle = "#23252a";
    roundRect(ctx, barX, y + 6, barW, 16, 8);
    ctx.fill();
    if (d.score > 0) {
      ctx.fillStyle = cardScoreColor(d.score);
      roundRect(ctx, barX, y + 6, Math.max(16, (barW * d.score) / 100), 16, 8);
      ctx.fill();
    }
    ctx.fillStyle = "#f2f3f5";
    ctx.font = `700 26px ${FONT}`;
    const v = String(d.score);
    ctx.fillText(v, CARD_WIDTH - 56 - ctx.measureText(v).width, y + 24);
  });

  // フッター
  ctx.fillStyle = "#6d7278";
  ctx.font = `20px ${FONT}`;
  ctx.fillText("そのページ、どれだけ slop か。", 56, 676);
  const foot = "viewslopper.agobot.app";
  ctx.fillText(foot, CARD_WIDTH - 56 - ctx.measureText(foot).width, 676);
}
