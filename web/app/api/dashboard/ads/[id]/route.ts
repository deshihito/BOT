import { NextResponse } from "next/server";
import { loadGuildRegistry } from "@/lib/dashboard";
import { normalizeInviteUrl, validateAdText } from "@/lib/ads-core";
import { authorizeAdsRequest, loadApplication, runScreening, saveApplication } from "@/lib/ads";

export const runtime = "nodejs";
export const maxDuration = 60;

// 申請の編集: pending の間だけ、申請者本人が紹介文と招待リンクを変更できる。
// 編集したらスクリーニングを通し直す。承認後の差し替えはできない（§2.3）。

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdsRequest(request);
  if ("error" in auth) return auth.error;
  const { context } = auth;
  const { id } = await params;

  let body: { text?: unknown; url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  const text = validateAdText(body.text);
  if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });
  const url = normalizeInviteUrl(body.url);
  if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 });

  let app: Awaited<ReturnType<typeof loadApplication>>;
  let registry: Awaited<ReturnType<typeof loadGuildRegistry>>;
  try {
    app = await loadApplication(id);
    registry = await loadGuildRegistry();
  } catch {
    return NextResponse.json({ error: "申請情報を取得できませんでした" }, { status: 502 });
  }
  if (!app) return NextResponse.json({ error: "申請が見つかりません" }, { status: 404 });
  if (!registry.has(app.guild_id)) {
    return NextResponse.json({ error: "このサーバーにはAGOBOTが導入されていません" }, { status: 404 });
  }
  if (!context.guilds.some((guild) => guild.id === app.guild_id)) {
    return NextResponse.json({ error: "このサーバーの管理権限がありません" }, { status: 403 });
  }
  if (app.applicant_user_id !== context.user.id) {
    return NextResponse.json({ error: "編集できるのは申請者本人だけです" }, { status: 403 });
  }
  if (app.status !== "pending") {
    return NextResponse.json({ error: "審査中（pending）の申請だけ編集できます" }, { status: 409 });
  }

  const entry = registry.get(app.guild_id)!;
  const screening = await runScreening({
    guildName: app.guild_name,
    memberCount: entry.member_count,
    text: text.value,
    url: url.value,
  });
  const updated = { ...app, text: text.value, url: url.value, screening };
  try {
    await saveApplication(updated);
  } catch {
    return NextResponse.json({ error: "申請を保存できませんでした" }, { status: 502 });
  }
  return NextResponse.json({ application: updated });
}
