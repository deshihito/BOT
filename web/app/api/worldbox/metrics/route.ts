import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth";
import { kvList } from "@/lib/bot-api";
import { dayKeyOf, funnelRates, parseUserFirstSteps, retentionRate } from "@/lib/worldbox/metrics";
import {
  WORLDBOX_METRICS_USERS_NAMESPACE, loadDayMetrics, loadEconDay,
} from "@/lib/worldbox/metrics-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { worldboxAdminIds } from "@/lib/worldbox/ops-online";

export const runtime = "nodejs";

// AGO WORLD BOX の計測読み取り（運営用）。
// GET: 直近14日の日次指標（DAU・同時接続ピーク・設置・収穫・チャット・
// ギルドショップ取引量・ユニオンカバー率）、経済の日次集計（理由別の
// earn/spend とバンクロール、Bot ワーカーが記録）、初回5分ファネル、
// 7日継続率を返す。個人を特定する情報は含めない（件数と率だけ）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const DAYS = 14;

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  // 運営用データ（経済集計を含む）なので管理者のみ。ops ルートと同じ判定。
  if (session.provider !== "discord" || !worldboxAdminIds().has(session.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const now = Date.now();
  const dates: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) dates.push(dayKeyOf(now - i * 86_400_000));

  const [nations, usersRaw, ...rest] = await Promise.all([
    loadNationsState(),
    kvList(WORLDBOX_METRICS_USERS_NAMESPACE).catch(() => new Map<string, unknown>()),
    ...dates.map(async (date) => ({
      date,
      day: await loadDayMetrics(date),
      econ: await loadEconDay(date),
    })),
  ]);
  const memberKeys = new Set(Object.keys(nations.members ?? {}));

  const days = rest.map(({ date, day, econ }) => {
    const unionDau = day.dau.filter((k) => memberKeys.has(k)).length;
    return {
      date,
      dau: day.dau.length,
      peak: day.peak,
      blocksPlaced: day.blocksPlaced,
      harvests: day.harvests,
      chats: { near: day.chatsNear, global: day.chatsGlobal, union: day.chatsUnion },
      guildShopVolume: day.guildShopVolume,
      unionCoverage: day.dau.length > 0 ? unionDau / day.dau.length : 0,
      econ,
    };
  });

  const users = [...usersRaw.values()]
    .map((v) => parseUserFirstSteps(v))
    .filter((u): u is NonNullable<typeof u> => u !== null);
  const funnel = funnelRates(users);

  // 7日継続: 7日前の DAU が今日もいる割合
  const weekAgo = rest[DAYS - 8]?.day;
  const today = rest[DAYS - 1]?.day;
  const retention7d = weekAgo && today ? retentionRate(weekAgo, today) : null;

  return NextResponse.json({ days, funnel, retention7d }, { headers: NO_STORE });
}
