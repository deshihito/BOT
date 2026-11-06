import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import { isSnowflake, mergeGuildSettings, sanitizeSectionInput, sectionSpec, validateSectionGuards, SETTING_SECTIONS } from "@/lib/dashboard-core";
import { getDashboardContext, loadGuildRegistry, loadGuildSettings, saveGuildSettingsObject } from "@/lib/dashboard";

export const runtime = "nodejs";

async function authorize(request: Request, guildId: string) {
  const session = getRequestSession(request);
  if (!session) return { error: NextResponse.json({ error: "ログインが必要です" }, { status: 401 }) };
  if (!session.sid) return { error: NextResponse.json({ error: "再ログインが必要です" }, { status: 401 }) };
  if (!isSnowflake(guildId)) return { error: NextResponse.json({ error: "サーバーIDの形式が正しくありません" }, { status: 400 }) };
  const context = await getDashboardContext(session);
  if (!context) return { error: NextResponse.json({ error: "セッションを確認できませんでした。再ログインしてください" }, { status: 401 }) };
  const guild = context.guilds.find((item) => item.id === guildId);
  if (!guild) return { error: NextResponse.json({ error: "このサーバーの管理権限がありません" }, { status: 403 }) };
  return { guild };
}

export async function GET(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const auth = await authorize(request, guildId);
  if ("error" in auth) return auth.error;

  try {
    const registry = await loadGuildRegistry();
    if (!registry.has(guildId)) {
      return NextResponse.json({ error: "このサーバーにはAGOBOTが導入されていません" }, { status: 404 });
    }
    const all = await loadGuildSettings(guildId);
    const settings: Record<string, unknown> = {};
    for (const spec of SETTING_SECTIONS) {
      const value = all[spec.section];
      settings[spec.section] =
        typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
    }
    return NextResponse.json({ guild: { id: guildId, name: auth.guild.name }, settings });
  } catch {
    return NextResponse.json({ error: "設定を取得できませんでした" }, { status: 502 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const auth = await authorize(request, guildId);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  const { section, values } = body as { section?: unknown; values?: unknown };
  const spec = typeof section === "string" ? sectionSpec(section) : undefined;
  if (!spec) {
    return NextResponse.json({ error: "扱えない設定です" }, { status: 400 });
  }
  const sanitized = sanitizeSectionInput(spec, values);
  if (!sanitized.ok) {
    return NextResponse.json({ errors: sanitized.errors }, { status: 400 });
  }

  try {
    const registry = await loadGuildRegistry();
    if (!registry.has(guildId)) {
      return NextResponse.json({ error: "このサーバーにはAGOBOTが導入されていません" }, { status: 404 });
    }
    const current = await loadGuildSettings(guildId);
    const merged = mergeGuildSettings(current, spec.section, sanitized.values);
    const guardErrors = validateSectionGuards(spec, merged?.[spec.section]);
    if (guardErrors.length > 0) {
      return NextResponse.json({ errors: guardErrors }, { status: 400 });
    }
    await saveGuildSettingsObject(guildId, merged);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "保存できませんでした" }, { status: 502 });
  }
}
