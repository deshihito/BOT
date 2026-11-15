// AGO WORLD BOX の闘技場（ロビー北の半円アリーナ）。
// 剣の腕前で CPU の対戦相手とターンバトルし、勝てば賞金（earn の
// arena_prize、Plan A の原資ルール内）を得る。参加費は spend で払う。
// このファイルは純粋ロジックのみ（乱数は注入する）。

/** 対戦相手の階級。名前はモブカタログの種に寄せる。 */
export interface ArenaTier {
  id: string;
  name: string;
  enemyHp: number;
  enemyAttack: number;
  fee: number;
  prize: number;
}

export const ARENA_TIERS: readonly ArenaTier[] = [
  { id: "slime", name: "スライム", enemyHp: 40, enemyAttack: 6, fee: 50, prize: 120 },
  { id: "golem", name: "ゴーレム", enemyHp: 95, enemyAttack: 11, fee: 300, prize: 720 },
  { id: "dragon", name: "ワールドドラゴン", enemyHp: 170, enemyAttack: 17, fee: 1500, prize: 3600 },
];

export function arenaTier(id: string): ArenaTier | null {
  return ARENA_TIERS.find((t) => t.id === id) ?? null;
}

export const ARENA_PLAYER_HP = 100;
/** セッションの有効期限。これを過ぎた試合は無効（参加費は戻らない）。 */
export const ARENA_SESSION_TTL_MS = 10 * 60 * 1000;

/** プレイヤーの攻撃力: 素手 8 + 所持する最良の剣の（tier + 強化レベル）× 4。 */
export function playerAttack(
  inventory: Readonly<Record<string, number>>,
  enhance?: Readonly<Record<string, number>>,
): number {
  let bestTier = 0;
  for (const [itemId, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const m = /^(wooden|stone|iron|mithril)_sword$/.exec(itemId);
    if (!m) continue;
    const tier = ({ wooden: 1, stone: 2, iron: 3, mithril: 4 }[m[1]] ?? 0) + (enhance?.[itemId] ?? 0);
    if (tier > bestTier) bestTier = tier;
  }
  return 8 + bestTier * 4;
}

export type ArenaActionKind = "attack" | "heavy" | "guard";

export interface ArenaSession {
  kind: "arena";
  /** paying = 参加費の spend オプ適用待ち。fighting = 対戦中。 */
  state: "paying" | "fighting";
  tierId: string;
  fee: number;
  prize: number;
  feeOpId: string;
  playerHp: number;
  enemyHp: number;
  /** 次の敵攻撃を軽減するか（まもる）。 */
  guarding: boolean;
  turn: number;
  startedAt: number;
  /** 直近の経過（新しい順、最大6件）。 */
  log: string[];
}

export interface ArenaStepResult {
  session: ArenaSession;
  /** 試合が決着したか。 */
  outcome: "win" | "lose" | null;
  events: string[];
}

function dmg(base: number, rng: () => number): number {
  return Math.max(1, Math.round(base * (0.85 + rng() * 0.3)));
}

/** 1手進める。決着したら outcome が立つ（セッションは呼び出し側で破棄）。 */
export function arenaStep(session: ArenaSession, action: ArenaActionKind, attack: number, rng: () => number): ArenaStepResult {
  const tier = arenaTier(session.tierId);
  const enemyAttack = tier?.enemyAttack ?? 6;
  const s: ArenaSession = { ...session, turn: session.turn + 1 };
  const events: string[] = [];

  if (action === "guard") {
    s.guarding = true;
    events.push("身を守った");
  } else {
    const hitChance = action === "heavy" ? 0.6 : 0.85;
    if (rng() < hitChance) {
      const d = dmg(attack * (action === "heavy" ? 1.9 : 1), rng);
      s.enemyHp = Math.max(0, s.enemyHp - d);
      events.push(`${action === "heavy" ? "強攻撃" : "攻撃"} ${d}`);
    } else {
      events.push("外れた");
    }
  }

  if (s.enemyHp <= 0) {
    return { session: s, outcome: "win", events };
  }

  // 敵の反撃
  let ed = dmg(enemyAttack, rng);
  if (s.guarding) {
    ed = Math.max(1, Math.round(ed * 0.4));
    s.guarding = false;
  }
  s.playerHp = Math.max(0, s.playerHp - ed);
  events.push(`相手の攻撃 ${ed}`);

  if (s.playerHp <= 0) {
    return { session: s, outcome: "lose", events };
  }
  return { session: s, outcome: null, events };
}

/** クライアントへ出すセッション表示（秘匿情報はないが形を固定する）。 */
export function publicArenaView(s: ArenaSession) {
  const tier = arenaTier(s.tierId);
  return {
    state: s.state,
    tierId: s.tierId,
    tierName: tier?.name ?? s.tierId,
    fee: s.fee,
    prize: s.prize,
    playerHp: s.playerHp,
    playerHpMax: ARENA_PLAYER_HP,
    enemyHp: s.enemyHp,
    enemyHpMax: tier?.enemyHp ?? s.enemyHp,
    turn: s.turn,
    log: s.log,
  };
}
