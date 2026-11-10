import { NextResponse } from "next/server";
import { loadGuildRegistry } from "@/lib/dashboard";
import {
  canApprove,
  effectiveStatus,
  validateRejectInput,
  type AdApplication,
} from "@/lib/ads-core";
import { authorizeOwnerRequest, loadAllApplications, loadApplication, saveApplication } from "@/lib/ads";

export const runtime = "nodejs";

// 審査操作: approve（掲載開始・期限なし）/ reject（理由分類＋自由文）/ revoke（即時停止）。
// Bot は partner_ads を読み取り時に判定するため、ここで保存すれば次回読込（最長60秒）から反映される。

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeOwnerRequest(request);
  if ("error" in auth) return auth.error;
  const { context } = auth;
  const { id } = await params;

  let body: { action?: unknown; reason?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "revoke") {
    return NextResponse.json({ error: "操作が正しくありません" }, { status: 400 });
  }

  let app: AdApplication | null;
  let apps: AdApplication[];
  let registry: Awaited<ReturnType<typeof loadGuildRegistry>>;
  try {
    app = await loadApplication(id);
    apps = await loadAllApplications();
    registry = await loadGuildRegistry();
  } catch {
    return NextResponse.json({ error: "申請情報を取得できませんでした" }, { status: 502 });
  }
  if (!app) return NextResponse.json({ error: "申請が見つかりません" }, { status: 404 });

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const reviewer = { reviewed_at: nowIso, reviewed_by: context.user.id };
  let updated: AdApplication;

  if (action === "approve") {
    if (app.status !== "pending") {
      return NextResponse.json({ error: "審査中（pending）の申請だけ承認できます" }, { status: 409 });
    }
    if (!registry.has(app.guild_id)) {
      return NextResponse.json({ error: "対象サーバーにAGOBOTが導入されていないため承認できません" }, { status: 409 });
    }
    if (!canApprove(apps, nowMs, new Set(registry.keys()))) {
      return NextResponse.json({ error: "掲載中の広告が全体上限（20件）に達しています" }, { status: 409 });
    }
    updated = {
      ...app,
      ...reviewer,
      status: "approved",
      expires_at: null,
      reject_reason: null,
      reject_note: null,
      revoke_reason: null,
    };
  } else if (action === "reject") {
    if (app.status !== "pending") {
      return NextResponse.json({ error: "審査中（pending）の申請だけ却下できます" }, { status: 409 });
    }
    const rejected = validateRejectInput(body.reason, body.note);
    if (!rejected.ok) return NextResponse.json({ error: rejected.error }, { status: 400 });
    updated = {
      ...app,
      ...reviewer,
      status: "rejected",
      reject_reason: rejected.reason,
      reject_note: rejected.note,
    };
  } else {
    if (effectiveStatus(app, nowMs, new Set(registry.keys())) !== "approved") {
      return NextResponse.json({ error: "掲載中の広告だけ停止できます" }, { status: 409 });
    }
    updated = { ...app, ...reviewer, status: "revoked", revoke_reason: "manual" };
  }

  try {
    await saveApplication(updated);
  } catch {
    return NextResponse.json({ error: "審査結果を保存できませんでした" }, { status: 502 });
  }
  return NextResponse.json({ application: updated });
}
