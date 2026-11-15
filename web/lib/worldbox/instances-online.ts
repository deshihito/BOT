// AGO WORLD BOX のインスタンス枯渇状態の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_instances"、キー = 空間 ID）。
// 値: { veins: { veinKey: 採取時刻 }, chest: 宝箱を開けた時刻 }。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";

export const WORLDBOX_INSTANCES_NAMESPACE = "worldbox_instances";

export type InstanceState = {
  veins: Record<string, number>;
  chest: number;
};

export function parseInstanceState(raw: unknown): InstanceState {
  const empty: InstanceState = { veins: {}, chest: 0 };
  if (typeof raw !== "string" || raw === "") return empty;
  try {
    const v = JSON.parse(raw) as { veins?: unknown; chest?: unknown };
    const veins: Record<string, number> = {};
    if (v.veins && typeof v.veins === "object") {
      for (const [k, val] of Object.entries(v.veins as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) veins[k] = val;
      }
    }
    return { veins, chest: typeof v.chest === "number" && Number.isFinite(v.chest) ? v.chest : 0 };
  } catch {
    return empty;
  }
}

export async function loadInstanceState(space: string): Promise<InstanceState> {
  if (!isBotApiConfigured()) return { veins: {}, chest: 0 };
  try {
    return parseInstanceState(await kvGet(WORLDBOX_INSTANCES_NAMESPACE, space));
  } catch {
    return { veins: {}, chest: 0 };
  }
}

export async function storeInstanceState(space: string, state: InstanceState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_INSTANCES_NAMESPACE, space, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function isInstancesEnabled(): boolean {
  return isBotApiConfigured();
}
