import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { WORLD_COORD_LIMIT, worldTileSource } from "@/lib/worldbox/mapgen";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { bumpProfileStat } from "@/lib/worldbox/profile";
import { dispatchProgressEffects } from "@/lib/worldbox/progress-online";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import {
  applyDisplayAction, applyDrawWater, applyFlowerAction, applyFortify, applyMineBlock, applyPlaceBlock, applySetGateAccess, applySetSign, applyTileAction, applyToggleGate, FORTIFY_COST, isGateItem, isOverrideActive, tileKey,
  type TileActionResult, type TileOverridesMap,
} from "@/lib/worldbox/tiles";
import { buildEconomyOp } from "@/lib/worldbox/economy-bridge";
import {
  isEconomyEnabled, readUserBalance, submitEconomyOp, waitForOpDone,
} from "@/lib/worldbox/economy-bridge-online";
import { canAccessScope, parseAccessScope } from "@/lib/worldbox/acl";
import { nationIdForPresenceId } from "@/lib/worldbox/nations";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { loadWarState } from "@/lib/worldbox/war-online";
import { canBreakOthersBlock } from "@/lib/worldbox/war";
import { containerIsEmpty, isContainerItem } from "@/lib/worldbox/containers";
import { isMachineItem, machineBufferCount } from "@/lib/worldbox/machines";
import { deleteMachine, loadMachine } from "@/lib/worldbox/machines-online";
import { isStallItem } from "@/lib/worldbox/stalls";
import { loadStall } from "@/lib/worldbox/stalls-online";
import { bumpMetric, recordFirstStep } from "@/lib/worldbox/metrics-online";
import { appendTileJournal, loadFrozen } from "@/lib/worldbox/ops-online";
import { loadContainer, storeContainer } from "@/lib/worldbox/containers-online";
import { withUserLock } from "@/lib/worldbox/user-lock";
import { isTilesEnabled, loadTileOverride, loadTileOverrides, storeTileOverride } from "@/lib/worldbox/tiles-online";
import { isSupplyConnected } from "@/lib/worldbox/rails";
import { weatherGrowthMult } from "@/lib/worldbox/weather";

export const runtime = "nodejs";

// AGO WORLD BOX のタイル行為（伐採・採掘・耕作・作付け・収穫・
// ブロック設置/採掘＝自由建築）。設置はユニオンマーク（首都）を避け、
// 採掘は設置者だけが行える。
// 地形の真値は生成マップ＋bot_kv の上書き（名前空間 worldbox_tiles、
// キー "x,y"）で、行為の可否はすべてサーバー側で検証する。
// 収納コンテナ（樽・宝箱）は中身が入っている間は掘れない（not_empty）。
// 隣接検証: サーバーが知る本人の位置（プレゼンス優先、無ければ
// オンラインセーブ）がある場合だけタイルとの距離を確かめる。
// GET ?x0&y0&x1&y1: その範囲（各辺128まで）の上書きだけを返す
// POST { action, x, y, seedId? }: 行為を適用し、更新後のタイルと
// プロフィール（収穫・種の消費を反映）を返す。
// Bot API 未設定なら 503（クライアントは上書きなしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET で返す範囲の上限（1辺のタイル数）。 */
const MAX_RECT_SPAN = 128;
/** 行為できるタイルと本人位置のチェビシェフ距離の上限（保存の遅れを許容）。 */
const MAX_ACTION_DISTANCE = 2;

const BAD_REQUEST_ERRORS = new Set(["invalid_action", "invalid_request", "invalid_tile", "unknown_seed", "unknown_block"]);

function errorStatus(error: string): number {
  if (error === "not_owner" || error === "not_allowed") return 403;
  return BAD_REQUEST_ERRORS.has(error) ? 400 : 409;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

type FortifyCharge = { ok: true } | { ok: false; error: string; status: number };

/**
 * 要塞化の価格徴収（即時 spend、入国料と同じ交付ゲート）:
 * done が確定したときだけ ok。残高不足は insufficient_coins、
 * 経済が使えない状態は economy_unavailable。
 */
async function chargeFortifyFee(
  ownerKey: string,
  session: { provider: string; id: string },
): Promise<FortifyCharge> {
  const discordId = session.provider === "discord" ? session.id : null;
  if (!discordId || !isEconomyEnabled()) return { ok: false, error: "economy_unavailable", status: 503 };
  const balance = await readUserBalance(discordId);
  if (balance === null) return { ok: false, error: "economy_unavailable", status: 503 };
  if (balance < FORTIFY_COST) return { ok: false, error: "insufficient_coins", status: 409 };
  const op = buildEconomyOp(
    { kind: "spend", userKey: ownerKey, discordId, amount: FORTIFY_COST, reason: "fortify_block" },
    crypto.randomUUID(),
    Date.now(),
  );
  if (!op) return { ok: false, error: "fee_failed", status: 409 };
  const submitted = await submitEconomyOp(op);
  if (submitted.state === "unavailable") return { ok: false, error: "economy_unavailable", status: 503 };
  if (submitted.state === "done") return { ok: true };
  if (submitted.state === "failed") return { ok: false, error: "fee_failed", status: 409 };
  const done = await waitForOpDone(ownerKey, submitted.op.id);
  if (done && done.status === "done") return { ok: true };
  if (done && done.status === "failed") return { ok: false, error: "fee_failed", status: 409 };
  return { ok: false, error: "fee_pending", status: 409 };
}

function intParam(raw: string | null, fallback: number): number {
  if (raw !== null && raw.trim() === "") return fallback;
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-WORLD_COORD_LIMIT, Math.min(WORLD_COORD_LIMIT, Math.floor(n)));
}

/** サーバーが知る本人のワールド位置（プレゼンス → セーブの順）。無ければ null。 */
async function actorWorldPosition(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

export async function GET(request: Request) {
  if (!isTilesEnabled()) {
    return NextResponse.json({ error: "tiles_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const url = new URL(request.url);
  // ワールドに境界は無い: 旧マップの外（負座標含む）でも範囲を返せる。
  // 1リクエストの上限面積（各辺 MAX_RECT_SPAN）だけは維持する。
  const x0 = intParam(url.searchParams.get("x0"), 0);
  const y0 = intParam(url.searchParams.get("y0"), 0);
  const x1 = Math.min(Math.max(intParam(url.searchParams.get("x1"), x0), x0), x0 + MAX_RECT_SPAN - 1);
  const y1 = Math.min(Math.max(intParam(url.searchParams.get("y1"), y0), y0), y0 + MAX_RECT_SPAN - 1);
  const all = await loadTileOverrides();
  const now = Date.now();
  const overrides: TileOverridesMap = {};
  for (const [key, ov] of Object.entries(all)) {
    const m = /^(-?\d+),(-?\d+)$/.exec(key);
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (!isOverrideActive(ov, now)) continue; // 失効分は地形どおり
    overrides[key] = ov;
  }
  return NextResponse.json(
    {
      overrides,
      loggedIn: session !== null,
      // 自分のブロック判定用に、本人の不透明 ID（プレゼンス ID）を返す
      selfId: session ? presenceIdFor(sessionOwnerKey(session)) : null,
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isTilesEnabled()) {
    return NextResponse.json({ error: "tiles_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const fields = (body ?? {}) as {
    action?: unknown;
    x?: unknown;
    y?: unknown;
    seedId?: unknown;
    itemId?: unknown;
    text?: unknown;
    access?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);
  // 運用凍結中はタイルの書き換えを止める（荒らし対策）
  if (await loadFrozen()) {
    return NextResponse.json({ error: "world_frozen" }, { status: 423, headers: NO_STORE });
  }

  // 隣接検証。位置がサーバー側で分からない場合は検証を素通りさせず
  // 拒否する（釣り・マシンと同じ規則）。素通しだと、セーブの空間を
  // world 以外にしておくだけで距離検証が消え、遠隔で掘る/置けた。
  if ((typeof fields.x === "number" && !Number.isFinite(fields.x)) || (typeof fields.y === "number" && !Number.isFinite(fields.y))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  if (typeof fields.x === "number" && typeof fields.y === "number") {
    const pos = await actorWorldPosition(ownerKey);
    if (!pos) {
      return NextResponse.json({ error: "position_unknown" }, { status: 409, headers: NO_STORE });
    }
    const dist = Math.max(
      Math.abs(Math.floor(pos.x) - Math.floor(fields.x)),
      Math.abs(Math.floor(pos.y) - Math.floor(fields.y)),
    );
    if (dist > MAX_ACTION_DISTANCE) {
      return NextResponse.json({ error: "too_far" }, { status: 409, headers: NO_STORE });
    }
  }

  const tx = typeof fields.x === "number" ? Math.floor(fields.x) : -1;
  const ty = typeof fields.y === "number" ? Math.floor(fields.y) : -1;
  const hasCoord = typeof fields.x === "number" && typeof fields.y === "number";

  // 同一タイル・同一ユーザーへの並行リクエストを直列化する（S4）。
  // ロック無しだと二重タップ/リトライで同じブロックを2回掘って
  // 2回分の獲得を返したり、プロフィールの lost update が起きる。
  // タイル単位（他者との同タイル競合）とユーザー単位（自分の
  // プロフィール RMW）の二重で直列化する。
  return withUserLock(`tile:${tx},${ty}`, () =>
    withUserLock(ownerKey, async () => {
        const current = hasCoord ? await loadTileOverride(tx, ty) : null;
        const profile = await loadProfile(ownerKey);
        const map = worldTileSource();
        let result: TileActionResult;
        /** 掘り出す対象が収納コンテナなら、そのアイテム ID（回収後に状態を消す）。 */
        let minedContainerItem: string | null = null;
        /** 掘り出す対象が装置なら true（回収後に状態を消す）。 */
        let minedMachine = false;
        if (fields.action === "place_block") {
          // ユニオンマーク（首都）の保護はルート側の真値で判定する
          const nationsState = await loadNationsState();
          const capitals = Object.values(nationsState.nations).map((n) => n.capital);
          result = applyPlaceBlock(
            current, profile, map, ownerKey, fields.x, fields.y, fields.itemId, Date.now(),
            {
              onCapital: hasCoord && capitals.some((c) => c.x === tx && c.y === ty),
            },
          );
        } else if (fields.action === "mine_block") {
          // 収納コンテナ（樽・宝箱）は中身が入っている間は回収できない
          const nowMs = Date.now();
          const activeBlock = current && isOverrideActive(current, nowMs) ? current.block : undefined;
          const blockItemId = activeBlock?.itemId;
          let containerState = null;
          if (blockItemId && isContainerItem(blockItemId)) {
            containerState = await loadContainer("world", tx, ty, blockItemId);
            if (containerState && !containerIsEmpty(containerState)) {
              return NextResponse.json({ error: "not_empty" }, { status: 409, headers: NO_STORE });
            }
            minedContainerItem = blockItemId;
          }
          // 装置（自動収穫機）はバッファに作物が残っている間は回収できない
          if (blockItemId && isMachineItem(blockItemId)) {
            const machineState = await loadMachine(tx, ty);
            if (machineState && machineBufferCount(machineState) > 0) {
              return NextResponse.json({ error: "not_empty" }, { status: 409, headers: NO_STORE });
            }
            minedMachine = true;
          }
          // 屋台は出品が残っている間は回収できない（預かり品の消失防止）
          if (blockItemId && isStallItem(blockItemId)) {
            const stallState = await loadStall(tx, ty);
            if (stallState && stallState.count > 0) {
              return NextResponse.json({ error: "not_empty" }, { status: 409, headers: NO_STORE });
            }
          }
          // 戦争中の他者ブロック破壊: 攻撃側の国民が、防衛側の首都の
          // WAR_TERRITORY_RADIUS 以内にある防衛側国民のブロックだけ掘れる。
          // ブロック所有者の国は、所属マップの所有者キーから不透明 ID を
          // 逆引きして求める（プレゼンスに居ない所有者にも届く）。
          const selfId = presenceIdFor(ownerKey);
          const containerAccess = parseAccessScope(containerState?.access);
          const needNationLookup =
            activeBlock && (activeBlock.ownerId !== selfId) && (containerAccess !== "owner");
          let warBreakAllowed = false;
          let containerBreakAllowed = Boolean(blockItemId && isContainerItem(blockItemId) && containerAccess === "public");
          if (activeBlock && activeBlock.ownerId !== selfId) {
            const [warState, nationsState] = await Promise.all([
              needNationLookup ? loadWarState() : Promise.resolve({ v: 1 as const, wars: {}, history: [], lastDeclaredAt: {} }),
              loadNationsState(),
            ]);
            const members = nationsState.members ?? {};
            const mine = members[ownerKey];
            const ownerNationId = nationIdForPresenceId(nationsState, activeBlock.ownerId);
            const defender = ownerNationId ? (nationsState.nations ?? {})[ownerNationId] : undefined;
            // 期限も見る: この経路は expireWars を走らせないため、期限切れで
            // status が "active" のまま残った戦争でも掘れてしまう。
            warBreakAllowed = Boolean(
              mine && defender &&
              canBreakOthersBlock(warState, mine.nationId, defender.guildId, tx, ty, defender.capital, Date.now()),
            );
            if (blockItemId && isContainerItem(blockItemId) && containerAccess !== "public") {
              containerBreakAllowed = canAccessScope(containerAccess, {
                actorId: selfId,
                ownerId: activeBlock.ownerId,
                actorNationId: mine?.nationId ?? null,
                ownerNationId,
              });
            }
          }
          result = applyMineBlock(
            current, profile, map, ownerKey, fields.x, fields.y, nowMs,
            {
              warBreakAllowed,
              containerBreakAllowed,
            },
          );
        } else if (fields.action === "set_sign") {
          // 看板テキストの設定（所有者だけ、サーバー検証）
          result = applySetSign(
            current, profile, map, ownerKey, fields.x, fields.y, fields.text, Date.now(),
          );
        } else if (fields.action === "set_display" || fields.action === "clear_display") {
          // 棚への展示/回収（所有者だけ、サーバー検証）
          result = applyDisplayAction(
            current, profile, map, ownerKey, fields.x, fields.y, fields.action, fields.itemId, Date.now(),
          );
        } else if (fields.action === "draw_water") {
          // 井戸で水を汲む（バケツ→水入りバケツ）
          result = applyDrawWater(
            current, profile, map, ownerKey, fields.x, fields.y, Date.now(),
          );
        } else if (fields.action === "plant_flower" || fields.action === "remove_flower") {
          // 植木鉢・プランターへの花の植え付け/取り除き（所有者だけ、サーバー検証）
          result = applyFlowerAction(
            current, profile, map, ownerKey, fields.x, fields.y, fields.action, Date.now(),
          );
        } else if (fields.action === "toggle_gate") {
          // 門の開閉（gateAccess に応じてアクセス制御）
          const nowMs = Date.now();
          let gateAllowed = true;
          if (current && isOverrideActive(current, nowMs) && current.block && isGateItem(current.block.itemId)) {
            const scope = parseAccessScope(current.gateAccess);
            if (scope !== "public") {
              const selfId = presenceIdFor(ownerKey);
              const nationsState = await loadNationsState();
              gateAllowed = canAccessScope(scope, {
                actorId: selfId,
                ownerId: current.block.ownerId,
                actorNationId: nationsState.members?.[ownerKey]?.nationId ?? null,
                ownerNationId: nationIdForPresenceId(nationsState, current.block.ownerId),
              });
            }
          }
          result = applyToggleGate(
            current, profile, map, ownerKey, fields.x, fields.y, nowMs,
            { gateAllowed },
          );
        } else if (fields.action === "set_gate_access") {
          result = applySetGateAccess(
            current, profile, map, ownerKey, fields.x, fields.y, fields.access, Date.now(),
          );
        } else if (fields.action === "fortify") {
          // 要塞化（仕様書 §8.4）: 状態遷移は applyFortify、価格の徴収は
          // ここで即時 spend し、払えた場合だけ保存へ進む。
          result = applyFortify(
            current, profile, map, ownerKey, fields.x, fields.y, Date.now(),
          );
          if (result.ok) {
            const charged = await chargeFortifyFee(ownerKey, session);
            if (!charged.ok) {
              return NextResponse.json({ error: charged.error }, { status: charged.status, headers: NO_STORE });
            }
          }
        } else {
          // サプライライン: 収穫・採掘のときだけ、自国の首都と線路で
          // つながっているかを全上書きから判定して渡す（ボーナス用）。
          let supplyConnected = false;
          if (fields.action === "harvest" || fields.action === "mine") {
            const [allOverrides, nationsState] = await Promise.all([
              loadTileOverrides(),
              loadNationsState(),
            ]);
            const members = nationsState.members ?? {};
            const myNation = members[ownerKey];
            const capital = myNation ? (nationsState.nations ?? {})[myNation.nationId]?.capital : undefined;
            if (capital) {
              const nowMs = Date.now();
              const activeOverrides: TileOverridesMap = {};
              for (const [k, ov] of Object.entries(allOverrides)) {
                if (isOverrideActive(ov, nowMs)) activeOverrides[k] = ov;
              }
              supplyConnected = isSupplyConnected(activeOverrides, capital, tx, ty);
            }
          }
          const nowMs = Date.now();
          result = applyTileAction(
            current, profile, map, ownerKey,
            fields.action, fields.x, fields.y, fields.seedId, nowMs,
            { supplyConnected, growthMult: weatherGrowthMult(Math.floor(nowMs / 1000)) },
          );
        }
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: errorStatus(result.error), headers: NO_STORE });
        }
        let nextProfile = result.profile;
        let goalDelta = 0;
        if (fields.action === "chop" && (result.gained.wood ?? 0) > 0) {
          nextProfile = bumpProfileStat(nextProfile, "chops", 1);
          goalDelta = 1;
        } else if (fields.action === "mine" && (result.gained.stone ?? 0) > 0) {
          nextProfile = bumpProfileStat(nextProfile, "mines", 1);
          goalDelta = 1;
        } else if (fields.action === "harvest" && Object.keys(result.gained).length > 0) {
          nextProfile = bumpProfileStat(nextProfile, "harvests", 1);
          goalDelta = 1;
        } else if (fields.action === "place_block") {
          nextProfile = bumpProfileStat(nextProfile, "places", 1);
          goalDelta = 1;
        } else if (fields.action === "fortify") {
          nextProfile = bumpProfileStat(nextProfile, "fortifies", 1);
        }
        if (!(await storeTileOverride(tx, ty, result.override))) {
          return NextResponse.json({ error: "tiles_failed" }, { status: 500, headers: NO_STORE });
        }
        if (!(await storeProfile(ownerKey, nextProfile))) {
          await storeTileOverride(tx, ty, current);
          return NextResponse.json({ error: "tiles_failed" }, { status: 500, headers: NO_STORE });
        }
        // 差分ジャーナル（巻き戻し用、ベストエフォート）
        void appendTileJournal({
          key: tileKey(tx, ty), prev: current, next: result.override, actor: ownerKey, at: Date.now(),
        });
        // 計測（ベストエフォート）: 設置数・収穫数・初回ステップ
        if (fields.action === "place_block") {
          void bumpMetric("blocksPlaced", 1, Date.now());
          void recordFirstStep(ownerKey, "place", Date.now());
        }
        if (fields.action === "chop" || fields.action === "mine" || fields.action === "harvest") {
          void bumpMetric("harvests", 1, Date.now());
          void recordFirstStep(ownerKey, "gather", Date.now());
        }
        if (nextProfile !== profile) {
          dispatchProgressEffects({
            ownerKey,
            actorName: session.username?.trim() || "冒険者",
            before: profile,
            after: nextProfile,
            ...(goalDelta > 0 ? { goalKind: "gather" as const, goalDelta } : {}),
          });
        }
        // コンテナ/装置の状態は、ブロックが壊れて回収されたときだけ消す
        // （HP制のヒットではブロックが残るので状態も残す）
        const blockBroken = fields.action === "mine_block" && !result.override?.block;
        if (minedContainerItem && blockBroken) await storeContainer("world", tx, ty, null);
        // 装置を回収したら状態も消す
        if (minedMachine && blockBroken) await deleteMachine(tx, ty);
        return NextResponse.json(
          {
            ok: true,
            tile: result.view,
            override: result.override,
            key: tileKey(tx, ty),
            profile: nextProfile,
            gained: result.gained,
            ...(result.broke ? { broke: result.broke } : {}),
          },
          { headers: NO_STORE },
        );
    }),
  );
}
