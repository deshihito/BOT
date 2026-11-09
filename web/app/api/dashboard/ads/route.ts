import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { isSnowflake } from "@/lib/dashboard-core";
import { loadGuildRegistry } from "@/lib/dashboard";
import {
  canCreateForGuild,
  effectiveStatus,
  newApplicationId,
  normalizeInviteUrl,
  validateAdText,
  type AdApplication,
} from "@/lib/ads-core";
import { authorizeAdsRequest, loadAllApplications, runScreening, saveApplication } from "@/lib/ads";

export const runtime = "nodejs";
export const maxDuration = 60;

// 広告申請（申請者側）: GET = 申請できるサーバーと自分の申請一覧、POST = 新規申請。
// 資格（管理ギルド ∩ Bot導入済み）は画面の出し分けに頼らず、ここでも毎回再検証する。

export async function GET(request: Request) {
  const auth = await authorizeAdsRequest(request);
  if ("error" in auth) return auth.error;
  const { context } = auth;

  let registry: Awaited<ReturnType<typeof loadGuildRegistry>>;
  let apps: AdApplication[];
  try {
    registry = await loadGuildRegistry();
    apps = await loadAllApplications();
  } catch {
    return NextResponse.json({ error: "申請情報を取得できませんでした" }, { status: 502 });
  }

  const manageableIds = new Set(context.guilds.map((guild) => guild.id));
  const guilds = context.guilds
    .filter((guild) => registry.has(guild.id))
    .map((guild) => {
      const entry = registry.get(guild.id)!;
      return {
        id: guild.id,
        name: entry.name || guild.name,
        icon: guild.icon ?? entry.icon,
        member_count: entry.member_count,
        can_create: canCreateForGuild(apps, guild.id),
      };
    });
  const nowMs = Date.now();
  const applications = apps
    .filter((app) => manageableIds.has(app.guild_id))
    .map((app) => ({ ...app, status: effectiveStatus(app, nowMs) }));
  return NextResponse.json({ guilds, applications });
}

export async function POST(request: Request) {
  const auth = await authorizeAdsRequest(request);
  if ("error" in auth) return auth.error;
  const { context } = auth;

  let body: { guildId?: unknown; text?: unknown; url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  const guildId = typeof body.guildId === "string" ? body.guildId : "";
  if (!isSnowflake(guildId)) {
    return NextResponse.json({ error: "サーバーIDの形式が正しくありません" }, { status: 400 });
  }
  const guild = context.guilds.find((item) => item.id === guildId);
  if (!guild) {
    return NextResponse.json({ error: "このサーバーの管理権限がありません" }, { status: 403 });
  }
  const text = validateAdText(body.text);
  if (!text.ok) return NextResponse.json({ error: text.error }, { status: 400 });
  const url = normalizeInviteUrl(body.url);
  if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 });

  let registry: Awaited<ReturnType<typeof loadGuildRegistry>>;
  let apps: AdApplication[];
  try {
    registry = await loadGuildRegistry();
    apps = await loadAllApplications();
  } catch {
    return NextResponse.json({ error: "申請情報を取得できませんでした" }, { status: 502 });
  }
  const entry = registry.get(guildId);
  if (!entry) {
    return NextResponse.json({ error: "このサーバーにはAGOBOTが導入されていません" }, { status: 404 });
  }
  if (!canCreateForGuild(apps, guildId)) {
    return NextResponse.json(
      { error: "このサーバーには審査中の申請が既にあります。そちらの編集で対応してください" },
      { status: 409 },
    );
  }

  const nowMs = Date.now();
  const guildName = entry.name || guild.name;
  const screening = await runScreening({
    guildName,
    memberCount: entry.member_count,
    text: text.value,
    url: url.value,
  });
  const app: AdApplication = {
    id: newApplicationId(nowMs, guildId, randomBytes(4).toString("hex")),
    guild_id: guildId,
    guild_name: guildName,
    applicant_user_id: context.user.id,
    text: text.value,
    url: url.value,
    status: "pending",
    screening,
    created_at: new Date(nowMs).toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    reject_reason: null,
    reject_note: null,
    revoke_reason: null,
    expires_at: null,
  };
  try {
    await saveApplication(app);
  } catch {
    return NextResponse.json({ error: "申請を保存できませんでした" }, { status: 502 });
  }
  return NextResponse.json({ application: app }, { status: 201 });
}
