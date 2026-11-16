import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import {
  TAX_RATE_MAX, isPrivateNation, memberKeysOf, normalizeTaxRate, resolveMemberRole,
  type NationSettings,
} from "@/lib/worldbox/nation-settings";
import {
  isNationSettingsEnabled, loadNationSettings, updateNationSettings,
} from "@/lib/worldbox/nation-settings-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import type { NationsState } from "@/lib/worldbox/nations";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";

export const runtime = "nodejs";

// AGO WORLD BOX の国家設定（税率・公開/非公開・大臣の任命）。
// GET: 自分の国の設定と国民一覧（所属員なら誰でも読める読み取り表示）。
// POST: 変更は王のみ + ギルドボードの前（station "guild"）でのみ。
//   { action: "set_tax", taxRate } 税率は 0〜0.10。
//   { action: "set_visibility", visibility: "open" | "private" }
//   { action: "set_minister", targetKey, minister } 任命/解除。対象は
//   現在の国民のみで、Discord 由来の大臣はここでは外せない（任命一覧
//   に載っていないため、解除は任命分だけに効く）。
// 保存先は bot_kv（名前空間 worldbox_nation_settings、キー = ギルド ID）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

/** 所有者キーから表示名を作る: プレゼンスに居ればその名前、無ければ #末尾4桁。 */
function displayName(ownerKey: string, presenceNames: Map<string, string>): { name: string; tag: string } {
  const discordId = ownerKey.startsWith("discord:") ? ownerKey.slice("discord:".length) : ownerKey;
  const tag = `#${discordId.slice(-4)}`;
  const name = presenceNames.get(presenceIdFor(ownerKey));
  return { name: name || tag, tag };
}

async function buildView(state: NationsState, guildId: string, settings: NationSettings, selfKey: string) {
  const nation = state.nations[guildId];
  const memberKeys = memberKeysOf(state, guildId);
  const presenceNames = new Map<string, string>();
  try {
    for (const e of await listPresence()) {
      if (e.name) presenceNames.set(e.id, e.name);
    }
  } catch {
    // プレゼンスが読めなくても名前はタグで代替できる
  }
  const members = [...memberKeys].map((key) => {
    const stored = state.members[key];
    const resolved = nation
      ? resolveMemberRole(nation, settings, key, stored?.role ?? "citizen", memberKeys)
      : null;
    const { name, tag } = displayName(key, presenceNames);
    return {
      key,
      name,
      tag,
      role: resolved?.role ?? "citizen",
      appointed: resolved?.appointed ?? false,
      discordMinister: resolved?.discordMinister ?? false,
    };
  });
  const order = { king: 0, minister: 1, citizen: 2 } as const;
  members.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const mine = members.find((m) => m.key === selfKey);
  return {
    guildId,
    guildName: nation?.name ?? guildId,
    role: mine?.role ?? "citizen",
    taxRate: settings.taxRate,
    visibility: settings.visibility,
    isPrivate: isPrivateNation(settings),
    taxCollected: settings.taxCollected,
    members,
  };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isNationSettingsEnabled()) return err("nation_settings_unavailable", 503);
  const ownerKey = sessionOwnerKey(session);
  const state = await loadNationsState();
  const membership = state.members[ownerKey];
  if (!membership) return err("no_union", 409);
  const settings = await loadNationSettings(membership.nationId);
  const view = await buildView(state, membership.nationId, settings, ownerKey);
  return NextResponse.json(view, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isNationSettingsEnabled()) return err("nation_settings_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown; taxRate?: unknown; visibility?: unknown;
    targetKey?: unknown; minister?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  if ((await loadMyLobbyStation(ownerKey)) !== "guild") return err("not_at_guild_board", 409);
  const state = await loadNationsState();
  const membership = state.members[ownerKey];
  if (!membership) return err("no_union", 409);
  const guildId = membership.nationId;
  const nation = state.nations[guildId];
  if (!nation) return err("no_union", 409);
  if (ownerKey !== nation.kingKey) return err("king_only", 403);
  const now = Date.now();

  let next: NationSettings | null;
  if (fields.action === "set_tax") {
    const rate = fields.taxRate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > TAX_RATE_MAX) {
      return err("invalid_tax_rate", 400);
    }
    const taxRate = normalizeTaxRate(rate);
    next = await updateNationSettings(guildId, (cur) => ({ ...cur, taxRate, updatedAt: now }));
  } else if (fields.action === "set_visibility") {
    if (fields.visibility !== "open" && fields.visibility !== "private") {
      return err("invalid_visibility", 400);
    }
    const visibility = fields.visibility;
    next = await updateNationSettings(guildId, (cur) => ({ ...cur, visibility, updatedAt: now }));
  } else if (fields.action === "set_minister") {
    const targetKey = fields.targetKey;
    if (typeof targetKey !== "string" || typeof fields.minister !== "boolean") {
      return err("invalid_request", 400);
    }
    if (targetKey === nation.kingKey) return err("invalid_target", 400);
    if (state.members[targetKey]?.nationId !== guildId) return err("not_member", 409);
    const appoint = fields.minister;
    next = await updateNationSettings(guildId, (cur) => {
      const has = cur.ministers.includes(targetKey);
      if (appoint === has) return null;
      return {
        ...cur,
        ministers: appoint
          ? [...cur.ministers, targetKey]
          : cur.ministers.filter((k) => k !== targetKey),
        updatedAt: now,
      };
    });
  } else {
    return err("invalid_action", 400);
  }
  if (!next) return err("store_failed", 503);
  const view = await buildView(state, guildId, next, ownerKey);
  return NextResponse.json({ ok: true, ...view }, { headers: NO_STORE });
}
