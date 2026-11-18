import { LOBBY_DISTRICTS, LOBBY_SECRET_ROOMS } from "./lobby";

export const DISCOVERY_STORAGE_KEY = "taka-worldbox-lobby-discovery-v1";

export type FortuneRecord = {
  rank: string;
  message: string;
  luckyItem: string;
  luckyDir: string;
  secretWhisper: string;
  tied?: boolean;
};

export type LobbyDiscoveryState = {
  districts: string[];
  secretRooms: string[];
  vaultClears: number;
  bestShootingScore: number;
  fortuneCount: number;
  lastFortune: FortuneRecord | null;
  quizClearedIds: string[];
};

export function emptyDiscoveryState(): LobbyDiscoveryState {
  return {
    districts: [],
    secretRooms: [],
    vaultClears: 0,
    bestShootingScore: 0,
    fortuneCount: 0,
    lastFortune: null,
    quizClearedIds: [],
  };
}

const VALID_DISTRICT_IDS = new Set(LOBBY_DISTRICTS.map((d) => d.id));
const VALID_SECRET_IDS = new Set(LOBBY_SECRET_ROOMS.map((r) => r.id));

function sanitizeStringArray(raw: unknown, allowed?: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || item.length > 64) continue;
    if (allowed && !allowed.has(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseDiscoveryState(raw: string | null | undefined): LobbyDiscoveryState {
  const base = emptyDiscoveryState();
  if (!raw || typeof raw !== "string") return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return base;
    let lastFortune: FortuneRecord | null = null;
    if (parsed.lastFortune && typeof parsed.lastFortune === "object") {
      const f = parsed.lastFortune as Record<string, unknown>;
      if (
        typeof f.rank === "string" &&
        typeof f.message === "string" &&
        typeof f.luckyItem === "string" &&
        typeof f.luckyDir === "string" &&
        typeof f.secretWhisper === "string"
      ) {
        lastFortune = {
          rank: f.rank.slice(0, 16),
          message: f.message.slice(0, 160),
          luckyItem: f.luckyItem.slice(0, 48),
          luckyDir: f.luckyDir.slice(0, 24),
          secretWhisper: f.secretWhisper.slice(0, 160),
          tied: f.tied === true,
        };
      }
    }
    return {
      districts: sanitizeStringArray(parsed.districts, VALID_DISTRICT_IDS),
      secretRooms: sanitizeStringArray(parsed.secretRooms, VALID_SECRET_IDS),
      vaultClears:
        typeof parsed.vaultClears === "number" && Number.isFinite(parsed.vaultClears)
          ? Math.max(0, Math.floor(parsed.vaultClears))
          : 0,
      bestShootingScore:
        typeof parsed.bestShootingScore === "number" && Number.isFinite(parsed.bestShootingScore)
          ? Math.max(0, Math.floor(parsed.bestShootingScore))
          : 0,
      fortuneCount:
        typeof parsed.fortuneCount === "number" && Number.isFinite(parsed.fortuneCount)
          ? Math.max(0, Math.floor(parsed.fortuneCount))
          : 0,
      lastFortune,
      quizClearedIds: sanitizeStringArray(parsed.quizClearedIds),
    };
  } catch {
    return base;
  }
}

export function loadDiscoveryState(): LobbyDiscoveryState {
  if (typeof window === "undefined") return emptyDiscoveryState();
  try {
    return parseDiscoveryState(window.localStorage.getItem(DISCOVERY_STORAGE_KEY));
  } catch {
    return emptyDiscoveryState();
  }
}

export function saveDiscoveryState(state: LobbyDiscoveryState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISCOVERY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore storage quota errors */
  }
}

export function recordDistrictDiscovery(
  state: LobbyDiscoveryState,
  districtId: string,
): { state: LobbyDiscoveryState; newlyDiscovered: boolean } {
  if (!VALID_DISTRICT_IDS.has(districtId) || state.districts.includes(districtId)) {
    return { state, newlyDiscovered: false };
  }
  return {
    state: { ...state, districts: [...state.districts, districtId] },
    newlyDiscovered: true,
  };
}

export function recordSecretRoomDiscovery(
  state: LobbyDiscoveryState,
  roomId: string,
): { state: LobbyDiscoveryState; newlyDiscovered: boolean } {
  if (!VALID_SECRET_IDS.has(roomId) || state.secretRooms.includes(roomId)) {
    return { state, newlyDiscovered: false };
  }
  return {
    state: { ...state, secretRooms: [...state.secretRooms, roomId] },
    newlyDiscovered: true,
  };
}

export function recordVaultClear(state: LobbyDiscoveryState): LobbyDiscoveryState {
  return { ...state, vaultClears: state.vaultClears + 1 };
}

export function recordShootingScore(
  state: LobbyDiscoveryState,
  score: number,
): LobbyDiscoveryState {
  const clean = Math.max(0, Math.floor(score));
  if (clean <= state.bestShootingScore) return state;
  return { ...state, bestShootingScore: clean };
}

export function recordFortuneDraw(
  state: LobbyDiscoveryState,
  fortune: FortuneRecord,
): LobbyDiscoveryState {
  return {
    ...state,
    fortuneCount: state.fortuneCount + 1,
    lastFortune: { ...fortune, tied: false },
  };
}

export function toggleFortuneTie(state: LobbyDiscoveryState): LobbyDiscoveryState {
  if (!state.lastFortune) return state;
  return {
    ...state,
    lastFortune: { ...state.lastFortune, tied: true },
  };
}

export function recordQuizClear(
  state: LobbyDiscoveryState,
  questionId: string,
): LobbyDiscoveryState {
  if (!questionId || state.quizClearedIds.includes(questionId)) return state;
  return { ...state, quizClearedIds: [...state.quizClearedIds, questionId] };
}

export function discoveryRank(state: LobbyDiscoveryState): {
  title: string;
  badge: string;
  discoveredTotal: number;
  totalTargets: number;
  progressPct: number;
} {
  const totalTargets = LOBBY_DISTRICTS.length + LOBBY_SECRET_ROOMS.length;
  const discoveredTotal = state.districts.length + state.secretRooms.length;
  const progressPct = totalTargets > 0 ? Math.round((discoveredTotal / totalTargets) * 100) : 0;

  if (
    state.secretRooms.length >= LOBBY_SECRET_ROOMS.length &&
    state.districts.length >= LOBBY_DISTRICTS.length
  ) {
    return {
      title: "グランド・ファントム探検王",
      badge: "👑",
      discoveredTotal,
      totalTargets,
      progressPct,
    };
  }
  if (discoveredTotal >= 20 || state.secretRooms.length >= 4) {
    return {
      title: "マスター・トレジャーハンター",
      badge: "💎",
      discoveredTotal,
      totalTargets,
      progressPct,
    };
  }
  if (discoveredTotal >= 12 || state.secretRooms.length >= 2) {
    return { title: "裏通路の案内人", badge: "🗝️", discoveredTotal, totalTargets, progressPct };
  }
  if (discoveredTotal >= 5) {
    return {
      title: "デパート見習い探検家",
      badge: "🧭",
      discoveredTotal,
      totalTargets,
      progressPct,
    };
  }
  return { title: "はじめての来館者", badge: "🎫", discoveredTotal, totalTargets, progressPct };
}
