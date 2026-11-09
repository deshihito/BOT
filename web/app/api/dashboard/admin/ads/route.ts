import { NextResponse } from "next/server";
import { guildIconUrl } from "@/lib/dashboard-core";
import { loadGuildRegistry } from "@/lib/dashboard";
import {
  AD_GLOBAL_APPROVED_LIMIT,
  countActiveApproved,
  effectiveStatus,
} from "@/lib/ads-core";
import { authorizeOwnerRequest, loadAllApplications } from "@/lib/ads";

export const runtime = "nodejs";

// 審査ページ用の一覧: pending 一覧＋掲載中一覧＋全体の掲載数。
// サーバー情報（名前・アイコン・メンバー数）は guild_registry の現在値を併記する。

export async function GET(request: Request) {
  const auth = await authorizeOwnerRequest(request);
  if ("error" in auth) return auth.error;

  let registry: Awaited<ReturnType<typeof loadGuildRegistry>>;
  let apps: Awaited<ReturnType<typeof loadAllApplications>>;
  try {
    registry = await loadGuildRegistry();
    apps = await loadAllApplications();
  } catch {
    return NextResponse.json({ error: "申請情報を取得できませんでした" }, { status: 502 });
  }

  const nowMs = Date.now();
  const registryIds = new Set(registry.keys());
  const withGuild = (app: (typeof apps)[number]) => {
    const entry = registry.get(app.guild_id);
    return {
      ...app,
      status: effectiveStatus(app, nowMs, registryIds),
      guild: entry
        ? {
            name: entry.name || app.guild_name,
            icon_url: guildIconUrl(app.guild_id, entry.icon),
            member_count: entry.member_count,
            installed: true,
          }
        : { name: app.guild_name, icon_url: null, member_count: null, installed: false },
    };
  };
  const pending = apps.filter((app) => app.status === "pending").map(withGuild);
  const approved = apps
    .filter((app) => app.status === "approved")
    .map(withGuild)
    .filter((app) => app.status === "approved");
  return NextResponse.json({
    pending,
    approved,
    approved_count: countActiveApproved(apps, nowMs, registryIds),
    approved_limit: AD_GLOBAL_APPROVED_LIMIT,
  });
}
