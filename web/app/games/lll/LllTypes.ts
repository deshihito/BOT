import { effectiveStats, type LllCard } from "@/lib/lll/lll-game";
import type { LllCardView } from "./LllCard";

export type Skill = {
  name: string;
  kind: string;
  power: number;
  cooldown: number;
  ap: number;
  description: string;
};

export type CardT = LllCard;

export type DailyProgress = {
  scout: number;
  wins: number;
  tactics: number;
  weakHits: number;
};

export type Profile = {
  token?: string;
  cards: CardT[];
  teamIds: string[];
  shards: number;
  lumen: number;
  tickets: number;
  clearedTiers: number[];
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  tacticDeckId?: string;
  customTacticDeck?: Record<string, number> | null;
  playerName?: string;
  favoriteCardId?: string | null;
  lockedCardIds?: string[];
  loginStreak?: number;
  lastLoginDate?: string | null;
  dailyDate?: string;
  dailyProgress?: DailyProgress;
  dailyClaimed?: string[];
  achievementsClaimed?: string[];
  abyssBestFloor?: number;
  pvpRating?: number;
};

export type TacticSideView = {
  hand: string[];
  handCount?: number;
  deckCount: number;
  discard: string[];
  tp: number;
  reserves: string[];
  reserveCount?: number;
};

export type TacticsView = {
  player: TacticSideView;
  cpu: TacticSideView;
  turn: { actorKey: string; cardsPlayed: number; dmgCount: number };
};

export type BattleActor = {
  key: string;
  side: "player" | "cpu";
  name: string;
  element: LllCardView["element"];
  tier: LllCardView["tier"];
  level: number;
  limitBreak?: number;
  glyph?: string;
  imageDataUrl?: string;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  skills: Skill[];
  trait?: { name: string; kind: string; description: string };
  cooldowns: number[];
  statuses: { kind: string; turns: number }[];
  shield: number;
  defending: boolean;
  alive: boolean;
  buffMult?: number;
};

export type BattleLog = {
  type: string;
  text: string;
  actorKey?: string;
  targetKey?: string;
  amount?: number;
  hpAfter?: number;
  shieldAfter?: number;
  affinity?: number;
  statusKind?: string;
  element?: string;
  skillName?: string;
  skillPower?: number;
  cutIn?: boolean;
};

export type Battle = {
  id: string;
  mode?: "ladder" | "abyss" | "pvp";
  title?: string;
  floor?: number;
  rivalName?: string;
  tierIndex: number;
  round: number;
  actors: BattleActor[];
  queue: string[];
  queuePos: number;
  phase: "battle" | "finished";
  winner?: string | null;
  log: BattleLog[];
  tactics?: TacticsView;
};

export type PvpRival = {
  id: string;
  playerName: string;
  title: string;
  rating: number;
  tacticDeckId: string;
  powerScore: number;
  cards: CardT[];
};

export type AppraiseResult = {
  card: CardT | null;
  duplicated: boolean;
  shardsGained: number;
  limitBroken?: boolean;
  aiUsed: boolean;
};

export type Tab = "home" | "scout" | "binder" | "arena";

export function cardToView(card: CardT, profile?: Profile | null): LllCardView {
  const eff = effectiveStats(card);
  return {
    id: card.id,
    name: card.name,
    flavor: card.flavor,
    element: card.element,
    tier: card.tier,
    level: card.level,
    limitBreak: card.limitBreak ?? 0,
    awakened: card.awakened,
    locked: profile?.lockedCardIds?.includes(card.id),
    favorite: profile?.favoriteCardId === card.id,
    glyph: card.glyph,
    imageDataUrl: card.imageDataUrl,
    hp: eff.hp,
    maxHp: eff.hp,
    atk: eff.atk,
    def: eff.def,
    spd: eff.spd,
    skills: card.skills,
    trait: card.trait,
  };
}

export function actorToView(actor: BattleActor, forecastLabel?: string | null): LllCardView {
  return {
    id: actor.key,
    name: actor.name,
    element: actor.element,
    tier: actor.tier,
    level: actor.level,
    limitBreak: actor.limitBreak ?? 0,
    glyph: actor.glyph,
    imageDataUrl: actor.imageDataUrl,
    hp: actor.hp,
    maxHp: actor.maxHp,
    atk: actor.atk,
    def: actor.def,
    spd: actor.spd,
    skills: actor.skills,
    trait: actor.trait ?? null,
    hpBar: true,
    cooldowns: actor.cooldowns,
    statuses: actor.statuses,
    shield: actor.shield,
    defending: actor.defending,
    alive: actor.alive,
    forecastLabel: forecastLabel ?? null,
  };
}

export function checkAchievementDone(profile: Profile, id: string): boolean {
  switch (id) {
    case "ach_cards_5":
      return profile.cards.length >= 5;
    case "ach_cards_12":
      return profile.cards.length >= 12;
    case "ach_wins_5":
      return profile.wins >= 5;
    case "ach_legend_1":
      return profile.cards.some((c) => c.tier === "legend");
    case "ach_lv10_1":
      return profile.cards.some((c) => c.level >= 10);
    case "ach_abyss_5":
      return (profile.abyssBestFloor ?? 0) >= 5;
    default:
      return false;
  }
}
