// AGO WORLD BOX の季節イベント / 期間ダンジョン運営基盤（バッチ10b）。
// イベントは「毎年繰り返す月日の窓」で定義し、現在時刻から開催中かどうかを
// 決定的に判定する（運営は定義を足すだけでよい）。期間ダンジョンは遺跡の
// 生成・宝箱・罠・週次リセットの仕組みをそのまま使い、入口座標だけを
// 予約済みの仮想座標に固定する: 開催中だけ入場データが返る（入場ゲートは
// instances ルート）。日付は他の仕組みと合わせて UTC で判定する。

export type WorldEventKind = "seasonal" | "limited_dungeon";

export interface WorldEventDef {
  id: string;
  name: string;
  kind: WorldEventKind;
  /** 開始（月, 日）UTC。 */
  startMonth: number;
  startDay: number;
  /** 終了（月, 日）UTC。この日いっぱいまで。 */
  endMonth: number;
  endDay: number;
}

/** 期間ダンジョンの予約入口座標（通常の入口生成では出ない番地）。 */
export const EVENT_DUNGEON_ENTRANCE = { x: -9999, y: -9999 };

export const WORLD_EVENTS: readonly WorldEventDef[] = [
  {
    id: "stardust_festival",
    name: "星屑祭り",
    kind: "seasonal",
    startMonth: 12, startDay: 20, endMonth: 1, endDay: 5,
  },
  {
    id: "stardust_ruins",
    name: "星屑の遺跡",
    kind: "limited_dungeon",
    startMonth: 12, startDay: 20, endMonth: 1, endDay: 5,
  },
];

/** 年をまたぐ窓でも正しく判定する（開始 <= 終了なら同一年内、逆なら年末年始）。 */
export function isEventActive(def: WorldEventDef, now: number): boolean {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const cur = month * 100 + day;
  const start = def.startMonth * 100 + def.startDay;
  const end = def.endMonth * 100 + def.endDay;
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

export function activeEvents(now: number): WorldEventDef[] {
  return WORLD_EVENTS.filter((def) => isEventActive(def, now));
}

export function activeLimitedDungeon(now: number): WorldEventDef | null {
  return WORLD_EVENTS.find((def) => def.kind === "limited_dungeon" && isEventActive(def, now)) ?? null;
}

/** その入口座標が期間ダンジョンの予約入口かどうか。 */
export function isEventDungeonEntrance(x: number, y: number): boolean {
  return x === EVENT_DUNGEON_ENTRANCE.x && y === EVENT_DUNGEON_ENTRANCE.y;
}

/** 開催中イベントの残り日数（終了日当日は 0）。非開催は -1。 */
export function eventDaysLeft(def: WorldEventDef, now: number): number {
  if (!isEventActive(def, now)) return -1;
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const start = def.startMonth * 100 + def.startDay;
  const end = def.endMonth * 100 + def.endDay;
  const cur = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const endYear = start <= end || cur <= end ? year : year + 1;
  const endDate = Date.UTC(endYear, def.endMonth - 1, def.endDay);
  const today = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
  return Math.round((endDate - today) / 86_400_000);
}
