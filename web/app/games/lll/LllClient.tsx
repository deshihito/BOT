"use client";
// LLL クライアント（フルビューポート独立シェル + 3D対応 + 拡張バトルギミック）。
// ハブ（整理された出撃拠点・属性共鳴・装備遺物サマリー）
// → 出撃（ラダー / 深淵 / 模擬PvP、フィールド地脈・属性反応・共鳴バースト・3D/2D切替・戦術カード）
// → 編成・遺物（3枚パーティ・属性共鳴・遺物鍛造＆2枠装備・強化・限界突破・覚醒・特性／技2調律）
// → スカウト（画像鑑定 & チケット召喚）
// → 図鑑・規則（属性相性循環図・属性反応・編成共鳴・フィールド地脈・共鳴バースト・ミッション＆実績）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ACHIEVEMENTS,
  ALL_TRAIT_KINDS,
  BATTLE_FIELD_BY_ID,
  DAILY_MISSIONS,
  MAX_EQUIPPED_RELICS,
  MAX_LEVEL,
  MAX_LIMIT_BREAK,
  RELICS,
  RELIC_BY_ID,
  RESONANCE_BURST_INFO,
  SKILL2_KIND_LABEL,
  SKILL_DESCRIPTION,
  TRAIT_DEFAULT_NAME,
  TRAIT_DESCRIPTION,
  TUNABLE_SKILL2_KINDS,
  TUNE_SKILL2_COST,
  TUNE_TRAIT_COST,
  awakenCost,
  cardPowerScore,
  detectElementalReaction,
  dismantleShards,
  effectiveStats,
  evaluatePartyResonance,
  fieldForAbyssFloor,
  fieldForLadderTier,
  fieldForPvpRival,
  levelUpCost,
  limitBreakCost,
  nextTier,
  predictDamageRange,
  type BattleFieldId,
  type LllElement,
  type LllSkillKind,
  type LllTier,
  type LllTraitKind,
  type RewardBundle,
} from "@/lib/lll/lll-game";
import LllCard, { ELEMENT_LABEL, TIER_LABEL } from "./LllCard";
import { buildPlaybackSteps, stepDurationMs, type PlaybackStep, type PlaybackVfx } from "@/lib/lll/lll-playback";
import {
  loadSoundSettings as loadSoundSettingsRaw,
  playSe as playSeRaw,
  saveSoundSettings as saveSoundSettingsRaw,
  setBgmScene as setBgmSceneRaw,
  startBgm as startBgmRaw,
  stopBgm as stopBgmRaw,
  unlockAudio,
  type BgmScene,
} from "@/lib/lll/lll-sound";
import { TACTIC_CARD_BY_ID, TACTIC_DECKS } from "@/lib/lll/lll-tactics";
import { useGamesNav } from "../GamesShell";
import LllCodexView from "./LllCodexView";
import LllHomeView from "./LllHomeView";
import {
  IconBack,
  IconBolt,
  IconCodex,
  IconCube,
  IconDeck,
  IconField,
  IconHub,
  IconLock,
  IconLumen,
  IconMusic,
  IconRelic,
  IconScout,
  IconShard,
  IconShield,
  IconStar,
  IconSwords,
  IconTicket,
  IconTune,
  IconVolume,
} from "./LllIcons";
import { CustomDeckModal, DropRatesModal, LoginBonusModal } from "./LllModals";
import {
  actorToView,
  cardToView,
  checkAchievementDone,
  type AppraiseResult,
  type ArenaMode,
  type Battle,
  type BattleActor,
  type CardT,
  type Profile,
  type PvpRival,
  type Tab,
} from "./LllTypes";
import type { BattleSceneActor } from "./LllBattleScene3D";
import type { ThreeCardInput } from "./LllThreeTextures";
import "./lll.css";

const LllBattleScene3D = dynamic(() => import("./LllBattleScene3D"), { ssr: false });
const LllCard3DViewer = dynamic(() => import("./LllCard3DViewer"), { ssr: false });

/* --- サウンド --- */
type SoundSettings = { bgm: boolean; se: boolean };
const loadSoundSettings = loadSoundSettingsRaw as unknown as () => SoundSettings;
const saveSoundSettings = saveSoundSettingsRaw as unknown as (s: SoundSettings) => void;
const startBgm = startBgmRaw as unknown as () => void;
const stopBgm = stopBgmRaw as unknown as () => void;
function setBgmScene(scene: BgmScene): void {
  try {
    setBgmSceneRaw(scene);
  } catch {
    // 音が出なくても進行は止めない
  }
}
function playSe(name: string): void {
  try {
    (playSeRaw as unknown as (n: string) => void)(name);
  } catch {
    // 音が出なくてもゲームは止めない
  }
}

type ImageFeatures = {
  hue: number;
  saturation: number;
  brightness: number;
  colorVariance: number;
  edgeComplexity: number;
  warmth: number;
  coolness: number;
};

const TOKEN_KEY = "lll-player-token";
const SPEED_KEY = "lll-battle-speed";
const TUTORIAL_KEY = "lll-tutorial-battle";
const VIEW3D_KEY = "lll-view-3d";

/* --- アリーナのラダー（仕様 §4.1 のローカル写し） --- */
const TIERS = [
  { name: "試し切り", enemyLv: 1, winShards: 10, winLumen: 30, loseShards: 2 },
  { name: "ブロンズ", enemyLv: 2, winShards: 14, winLumen: 45, loseShards: 3 },
  { name: "シルバー", enemyLv: 4, winShards: 20, winLumen: 65, loseShards: 4 },
  { name: "ゴールド", enemyLv: 6, winShards: 28, winLumen: 90, loseShards: 5 },
  { name: "プラチナ", enemyLv: 8, winShards: 38, winLumen: 120, loseShards: 6 },
  { name: "ダイヤ", enemyLv: 10, winShards: 50, winLumen: 160, loseShards: 8 },
  { name: "マスター", enemyLv: 10, winShards: 65, winLumen: 210, loseShards: 10 },
  { name: "レジェンド", enemyLv: 10, winShards: 85, winLumen: 280, loseShards: 12 },
] as const;

const ALLY_TARGET_KINDS = new Set(["heal", "shield"]);
const TIER_RANK: Record<LllTier, number> = { normal: 1, elite: 2, legend: 3 };
const RELIC_CAT_LABEL: Record<string, string> = {
  offense: "攻撃",
  defense: "防御",
  tactics: "戦術",
  resonance: "共鳴",
};

function cardToThreeInput(card: CardT): ThreeCardInput {
  const eff = effectiveStats(card);
  return {
    id: card.id,
    name: card.name,
    element: card.element,
    tier: card.tier,
    level: card.level,
    limitBreak: card.limitBreak ?? 0,
    glyph: card.glyph,
    imageDataUrl: card.imageDataUrl,
    hp: eff.hp,
    maxHp: eff.hp,
    atk: eff.atk,
    def: eff.def,
    spd: eff.spd,
    showHpBar: false,
  };
}

function actorToThreeInput(actor: BattleActor): BattleSceneActor {
  return {
    id: actor.key,
    key: actor.key,
    side: actor.side,
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
    shield: actor.shield,
    defending: actor.defending,
    alive: actor.alive,
    statuses: actor.statuses,
    showHpBar: true,
  };
}

/* --- 画像処理: 512px JPEG 化 + 特徴量抽出 --- */
function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

async function processImage(file: File): Promise<{ imageDataUrl: string; features: ImageFeatures }> {
  const img = await loadImageFromFile(file);
  const encodeJpeg = (maxDim: number, quality: number): string => {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  };
  let imageDataUrl = encodeJpeg(512, 0.82);
  if (imageDataUrl.length > 380_000) imageDataUrl = encodeJpeg(448, 0.7);
  if (imageDataUrl.length > 380_000) imageDataUrl = encodeJpeg(384, 0.6);
  if (imageDataUrl.length > 380_000) imageDataUrl = encodeJpeg(320, 0.55);

  const S = 48;
  const sample = document.createElement("canvas");
  sample.width = S;
  sample.height = S;
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("canvas unavailable");
  sctx.drawImage(img, 0, 0, S, S);
  const data = sctx.getImageData(0, 0, S, S).data;
  const count = S * S;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let sumBright = 0;
  let hueSin = 0;
  let hueCos = 0;
  const lums = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    sumR += r;
    sumG += g;
    sumB += b;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sumSat += mx === 0 ? 0 : (mx - mn) / mx;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lums[i] = lum;
    sumBright += lum;
    if (mx !== mn) {
      let hueDeg: number;
      if (mx === r) hueDeg = 60 * (((g - b) / (mx - mn)) % 6);
      else if (mx === g) hueDeg = 60 * ((b - r) / (mx - mn) + 2);
      else hueDeg = 60 * ((r - g) / (mx - mn) + 4);
      if (hueDeg < 0) hueDeg += 360;
      const rad = (hueDeg * Math.PI) / 180;
      hueSin += Math.sin(rad);
      hueCos += Math.cos(rad);
    }
  }
  const avgBright = sumBright / count;
  let varSum = 0;
  for (let i = 0; i < count; i++) varSum += (lums[i] - avgBright) ** 2;
  const variance = Math.sqrt(varSum / count);
  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S - 1; x++) {
      edgeSum += Math.abs(lums[y * S + x + 1] - lums[y * S + x]);
      edgeCount++;
    }
  }
  const edgeComplexity = Math.min(1, (edgeSum / edgeCount) * 2.5);
  const avgR = sumR / count;
  const avgB = sumB / count;
  const warmth = Math.max(0, Math.min(1, (avgR - avgB) / 255 + 0.5));
  const hueAvg = ((Math.atan2(hueSin / count, hueCos / count) * 180) / Math.PI + 360) % 360;
  const saturation = sumSat / count;
  return {
    imageDataUrl,
    features: {
      hue: hueAvg,
      saturation,
      brightness: avgBright,
      colorVariance: variance,
      edgeComplexity,
      warmth,
      coolness: 1 - warmth,
    },
  };
}

type PendingSkill = {
  skill: 0 | 1 | "basic" | "defend" | "burst";
  targetSide: "player" | "cpu" | null;
  label: string;
};
type FloatNum = { id: number; targetKey: string; text: string; kind: string };
type SpeedMode = "1x" | "2x" | "instant";
type BinderSort = "power" | "level" | "tier" | "recent";

export default function LllClient() {
  const { prefix } = useGamesNav();
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>("hub");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState<SoundSettings>({ bgm: true, se: true });
  const [use3D, setUse3D] = useState(true);
  const [webglFailed, setWebglFailed] = useState(false);

  // プレイヤー名編集（トップバー内インライン）
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  // モーダル
  const [loginBonus, setLoginBonus] = useState<{ day: number; reward: RewardBundle } | null>(null);
  const [showRates, setShowRates] = useState(false);
  const [showDeckModal, setShowDeckModal] = useState(false);

  // スカウト
  const [dragOver, setDragOver] = useState(false);
  const [appraising, setAppraising] = useState(false);
  const [result, setResult] = useState<AppraiseResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // バインダー & 遺物工房 & 詳細調律
  const [pendingTeam, setPendingTeam] = useState<string[] | null>(null);
  const [pickedCardId, setPickedCardId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"grow" | "tune">("grow");
  const [showRelics, setShowRelics] = useState(true);
  const [binderDrag, setBinderDrag] = useState<{ cardId: string; x: number; y: number; name: string } | null>(null);
  const [hotSlot, setHotSlot] = useState<number | null>(null);
  const teamSlotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const binderTrackRef = useRef<{ cardId: string; name: string; startX: number; startY: number; active: boolean } | null>(null);
  const [filterElement, setFilterElement] = useState<"all" | LllElement>("all");
  const [filterTier, setFilterTier] = useState<"all" | LllTier>("all");
  const [sortBy, setSortBy] = useState<BinderSort>("power");
  const [dismantleMode, setDismantleMode] = useState(false);
  const [dismantleIds, setDismantleIds] = useState<string[]>([]);

  // アリーナ
  const [arenaMode, setArenaMode] = useState<ArenaMode>("ladder");
  const [selectedTier, setSelectedTier] = useState(0);
  const [abyssFloor, setAbyssFloor] = useState(1);
  const [pvpRivals, setPvpRivals] = useState<PvpRival[]>([]);
  const [selectedRivalId, setSelectedRivalId] = useState<string | null>(null);
  const [selectedDeck, setSelectedDeck] = useState<string>("chain");
  const [battle, setBattle] = useState<Battle | null>(null);
  const [pending, setPending] = useState<PendingSkill | null>(null);
  const [autoMode, setAutoMode] = useState(false);
  const [hitKeys, setHitKeys] = useState<Record<string, true>>({});
  const [floats, setFloats] = useState<FloatNum[]>([]);
  const battleRef = useRef<Battle | null>(null);
  battleRef.current = battle;
  const battleStartRef = useRef<{ shards: number; lumen: number; tickets: number; rating: number; clearedBefore: boolean } | null>(null);
  const finishSeRef = useRef<string | null>(null);
  const floatIdRef = useRef(0);
  const battleTrackRef = useRef<{ actorKey: string; startX: number; startY: number; active: boolean } | null>(null);
  const [battleDrag, setBattleDrag] = useState<{ actorKey: string; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  // 逐次再生 & 3D VFX & カットイン
  const [displayBattle, setDisplayBattle] = useState<Battle | null>(null);
  const [speed, setSpeed] = useState<SpeedMode>("1x");
  const speedRef = useRef<SpeedMode>("1x");
  const playbackRef = useRef<{ steps: PlaybackStep[]; index: number; next: Battle; nextProfile: Profile | null; prevLogLength: number } | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<{ index: number; total: number; actorKey: string | null } | null>(null);
  const [lungeKey, setLungeKey] = useState<string | null>(null);
  const [shieldFlashKeys, setShieldFlashKeys] = useState<Record<string, true>>({});
  const [cutInBanner, setCutInBanner] = useState<{ actorName: string; skillName: string; element: string } | null>(null);
  const [sceneVfx, setSceneVfx] = useState<PlaybackVfx | null>(null);
  const [sceneVfxNonce, setSceneVfxNonce] = useState(0);
  const [sceneShake, setSceneShake] = useState<0 | 1 | 2 | 3>(0);

  // 初回ガイド戦
  const [guideBattle, setGuideBattle] = useState(false);
  const guideBattleRef = useRef(false);
  const [guideTurnsUsed, setGuideTurnsUsed] = useState(0);
  const guideTurnsUsedRef = useRef(0);

  useEffect(() => {
    if (profile?.tacticDeckId && (profile.tacticDeckId in TACTIC_DECKS || profile.tacticDeckId === "custom")) {
      setSelectedDeck(profile.tacticDeckId);
    }
  }, [profile?.tacticDeckId]);

  useEffect(() => {
    if (profile && typeof profile.abyssBestFloor === "number") {
      setAbyssFloor((prev) => Math.max(prev, (profile.abyssBestFloor ?? 0) + 1));
    }
  }, [profile]);

  const postJson = useCallback(async (url: string, body: unknown): Promise<{ res: Response; data: Record<string, unknown> }> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  }, []);

  /* --- セッション --- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(TOKEN_KEY);
      } catch {
        // 読めなければ新規発行
      }
      try {
        const { res, data } = await postJson("/api/lll/session", stored ? { token: stored } : {});
        if (!res.ok) throw new Error("session failed");
        const nextToken = String(data.token ?? "");
        const nextProfile = data.profile as Profile;
        if (cancelled || !nextToken || !nextProfile) return;
        try {
          localStorage.setItem(TOKEN_KEY, nextToken);
        } catch {
          // 保存できなくてもセッション継続
        }
        setToken(nextToken);
        setProfile(nextProfile);
        if (data.loginBonus && typeof data.loginBonus === "object") {
          setLoginBonus(data.loginBonus as { day: number; reward: RewardBundle });
          playSe("claim");
        }
      } catch {
        if (!cancelled) setError("接続できませんでした。ページを再読み込みしてください。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postJson]);

  /* --- サウンド・設定の初期化 --- */
  useEffect(() => {
    try {
      setSound(loadSoundSettings());
    } catch {
      // 既定値のまま
    }
    try {
      const rawSpeed = localStorage.getItem(SPEED_KEY);
      if (rawSpeed === "2x" || rawSpeed === "instant" || rawSpeed === "1x") {
        setSpeed(rawSpeed);
        speedRef.current = rawSpeed;
      }
      const raw3d = localStorage.getItem(VIEW3D_KEY);
      if (raw3d === "0") setUse3D(false);
    } catch {
      // 既定値のまま
    }
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  /* --- BGM シーン同期 --- */
  useEffect(() => {
    if (tab === "arena" && battle?.phase === "battle") {
      setBgmScene(battle.mode === "abyss" || battle.tierIndex >= 6 ? "boss" : "battle");
    } else if (tab === "scout") {
      setBgmScene("scout");
    } else {
      setBgmScene("home");
    }
  }, [tab, battle?.phase, battle?.mode, battle?.tierIndex]);

  /* --- 逐次再生タイマーの後片付け --- */
  useEffect(() => {
    return () => {
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    };
  }, []);

  const canUse3D = use3D && !webglFailed;

  const toggle3D = () => {
    if (webglFailed) return;
    const next = !use3D;
    setUse3D(next);
    try {
      localStorage.setItem(VIEW3D_KEY, next ? "1" : "0");
    } catch {
      // 保存できなくても切替は適用
    }
    playSe("tap");
  };

  const handle3DFail = useCallback(() => {
    setWebglFailed(true);
    setUse3D(false);
  }, []);

  const changeSpeed = (next: SpeedMode) => {
    setSpeed(next);
    speedRef.current = next;
    try {
      localStorage.setItem(SPEED_KEY, next);
    } catch {
      // 保存できなくても適用
    }
    playSe("tap");
  };

  const toggleSound = (key: keyof SoundSettings) => {
    unlockAudio();
    const next = { ...sound, [key]: !sound[key] };
    setSound(next);
    try {
      saveSoundSettings(next);
    } catch {
      // 保存に失敗しても切り替え継続
    }
    if (key === "bgm") {
      if (next.bgm) startBgm();
      else stopBgm();
    }
    if (next.se && key === "se") playSe("tap");
  };

  const switchTab = (next: Tab) => {
    playSe("tap");
    setTab(next);
    setDetailCardId(null);
    setPickedCardId(null);
  };

  const launchArena = (mode: ArenaMode) => {
    playSe("tap");
    setArenaMode(mode);
    setTab("arena");
    setDetailCardId(null);
    setPickedCardId(null);
  };

  const openDetailCard = (cardId: string, subTab: "grow" | "tune" = "grow") => {
    setDetailCardId(cardId);
    setDetailTab(subTab);
    playSe("tap");
  };

  /* --- PvP ライバル一覧取得 --- */
  const fetchPvpRivals = useCallback(async () => {
    if (!token) return;
    try {
      const { res, data } = await postJson("/api/lll/pvp", { token });
      if (res.ok && Array.isArray(data.rivals)) {
        const list = data.rivals as PvpRival[];
        setPvpRivals(list);
        if (list.length > 0) {
          setSelectedRivalId((prev) => (prev && list.some((r) => r.id === prev) ? prev : list[0].id));
        }
      }
    } catch {
      // 失敗時は既存リストを維持
    }
  }, [postJson, token]);

  useEffect(() => {
    if (tab === "arena" && arenaMode === "pvp" && !battle && token) {
      void fetchPvpRivals();
    }
  }, [tab, arenaMode, battle, token, fetchPvpRivals]);

  /* --- プロフィール: 名前変更・ミッション受取 --- */
  const savePlayerName = async (name: string) => {
    const trimmed = name.trim();
    if (!token || busy || !trimmed) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/grow", { token, action: "playerName", name: trimmed });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "名前を変更できませんでした。");
        playSe("error");
        return;
      }
      setProfile(data.profile as Profile);
      setEditingName(false);
      playSe("claim");
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const claimMission = async (kind: "daily" | "achievement", id: string) => {
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/mission", { token, kind, id });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "報酬を受け取れませんでした。");
        playSe("error");
        return;
      }
      setProfile(data.profile as Profile);
      playSe("claim");
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  /* --- スカウト（画像 & チケット召喚） --- */
  const handleAppraiseResponse = (api: { res: Response; data: Record<string, unknown> }, errFallback: string) => {
    if (!api.res.ok) {
      setError(typeof api.data.error === "string" ? api.data.error : errFallback);
      playSe("error");
      return;
    }
    const nextProfile = api.data.profile as Profile;
    const nextResult: AppraiseResult = {
      card: (api.data.card as CardT | null) ?? null,
      duplicated: api.data.duplicated === true,
      shardsGained: typeof api.data.shardsGained === "number" ? api.data.shardsGained : 0,
      limitBroken: api.data.limitBroken === true,
      aiUsed: api.data.aiUsed === true,
    };
    setProfile(nextProfile);
    setResult(nextResult);
    if (nextResult.duplicated) playSe(nextResult.limitBroken ? "awaken" : "coin");
    else if (nextResult.card?.tier === "legend") playSe("legend");
    else playSe("stamp");
  };

  const appraiseFile = async (file: File) => {
    if (!token || !profile || appraising) return;
    if (!file.type.startsWith("image/")) {
      setError("画像ファイルを選んでください。");
      playSe("error");
      return;
    }
    unlockAudio();
    setAppraising(true);
    setResult(null);
    setError("");
    playSe("summon");
    try {
      const { imageDataUrl, features } = await processImage(file);
      const flipWait = new Promise((resolve) => setTimeout(resolve, 900));
      const [api] = await Promise.all([postJson("/api/lll/appraise", { token, features, imageDataUrl }), flipWait]);
      handleAppraiseResponse(api, "鑑定できませんでした。");
    } catch {
      setError("鑑定に失敗しました。別の画像で試してください。");
      playSe("error");
    } finally {
      setAppraising(false);
    }
  };

  const summonWithTicket = async () => {
    if (!token || !profile || appraising || (profile.tickets ?? 0) < 1) return;
    unlockAudio();
    setAppraising(true);
    setResult(null);
    setError("");
    playSe("summon");
    try {
      const flipWait = new Promise((resolve) => setTimeout(resolve, 900));
      const [api] = await Promise.all([postJson("/api/lll/appraise", { token, action: "ticket" }), flipWait]);
      handleAppraiseResponse(api, "チケット召喚に失敗しました。");
    } catch {
      setError("通信に失敗しました。");
      playSe("error");
    } finally {
      setAppraising(false);
    }
  };

  /* --- バインダー: チーム編成・強化・調律・遺物 --- */
  const effectiveTeamIds: string[] = pendingTeam ?? profile?.teamIds ?? [];
  const saveTeam = async (teamIds: string[]) => {
    if (!token || !profile) return;
    if (teamIds.length !== 3 || new Set(teamIds).size !== 3) {
      setPendingTeam(teamIds);
      return;
    }
    const prevProfile = profile;
    setProfile({ ...profile, teamIds });
    try {
      const { res, data } = await postJson("/api/lll/team", { token, teamIds });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "チームを保存できませんでした。");
        setProfile(prevProfile);
        setPendingTeam(teamIds);
        return;
      }
      setProfile(data.profile as Profile);
      setPendingTeam(null);
      playSe("tap");
    } catch {
      setError("通信に失敗しました。");
      setProfile(prevProfile);
      setPendingTeam(teamIds);
    }
  };

  const assignToSlot = (cardId: string, slot: number) => {
    if (!profile) return;
    const base = effectiveTeamIds.filter((id) => id !== cardId);
    const next = [...base];
    if (slot < next.length) next[slot] = cardId;
    else next.push(cardId);
    setPickedCardId(null);
    void saveTeam(next.slice(0, 3));
  };

  const removeFromTeam = (cardId: string) => {
    if (!profile) return;
    playSe("tap");
    setPendingTeam(effectiveTeamIds.filter((id) => id !== cardId));
  };

  const slotAt = (x: number, y: number): number | null => {
    for (let i = 0; i < 3; i++) {
      const el = teamSlotRefs.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
  };

  const binderDragHandlers = (card: CardT) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (dismantleMode) return;
      if (e.button !== undefined && e.button > 0) return;
      binderTrackRef.current = { cardId: card.id, name: card.name, startX: e.clientX, startY: e.clientY, active: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // capture不可でも追跡可能
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const track = binderTrackRef.current;
      if (!track || track.cardId !== card.id) return;
      if (!track.active) {
        if (Math.hypot(e.clientX - track.startX, e.clientY - track.startY) < 7) return;
        track.active = true;
        playSe("flip");
      }
      setBinderDrag({ cardId: card.id, x: e.clientX, y: e.clientY, name: card.name });
      setHotSlot(slotAt(e.clientX, e.clientY));
    },
    onPointerUp: (e: React.PointerEvent) => {
      const track = binderTrackRef.current;
      binderTrackRef.current = null;
      if (!track || !track.active) return;
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 60);
      const slot = slotAt(e.clientX, e.clientY);
      setBinderDrag(null);
      setHotSlot(null);
      if (slot !== null) assignToSlot(card.id, slot);
    },
    onPointerCancel: () => {
      binderTrackRef.current = null;
      setBinderDrag(null);
      setHotSlot(null);
    },
  });

  const toggleDismantleSelect = (card: CardT) => {
    if (!profile) return;
    const isProtected = effectiveTeamIds.includes(card.id) || profile.teamIds.includes(card.id) || (profile.lockedCardIds?.includes(card.id) ?? false);
    if (isProtected) {
      playSe("error");
      return;
    }
    playSe("tap");
    setDismantleIds((prev) => (prev.includes(card.id) ? prev.filter((id) => id !== card.id) : [...prev, card.id]));
  };

  const tapCollectionCard = (card: CardT) => {
    if (suppressClickRef.current) return;
    if (dismantleMode) {
      toggleDismantleSelect(card);
      return;
    }
    if (pickedCardId === card.id) {
      openDetailCard(card.id);
      return;
    }
    setPickedCardId(card.id);
    playSe("tap");
  };

  const runGrowAction = async (body: Record<string, unknown>, seName: string, fallbackErr: string) => {
    if (!token || busy) return false;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/grow", { token, ...body });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : fallbackErr);
        playSe("error");
        return false;
      }
      setProfile(data.profile as Profile);
      playSe(seName);
      return true;
    } catch {
      setError("通信に失敗しました。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const growCard = (card: CardT) => {
    if (card.level >= MAX_LEVEL) return;
    void runGrowAction({ cardId: card.id }, "levelup", "強化できませんでした。");
  };

  const limitBreakCard = (card: CardT) => {
    if ((card.limitBreak ?? 0) >= MAX_LIMIT_BREAK) return;
    void runGrowAction({ action: "limitBreak", cardId: card.id }, "levelup", "限界突破できませんでした。");
  };

  const awakenCard = (card: CardT) => {
    if (!nextTier(card.tier)) return;
    void runGrowAction({ action: "awaken", cardId: card.id }, "awaken", "覚醒できませんでした。");
  };

  const toggleLockCard = (cardId: string) => {
    void runGrowAction({ action: "lock", cardId }, "tap", "ロックを変更できませんでした。");
  };

  const setFavoriteCard = (cardId: string) => {
    void runGrowAction({ action: "favorite", cardId }, "claim", "主力カードに設定できませんでした。");
  };

  const craftRelicAction = (relicId: string) => {
    void runGrowAction({ action: "craftRelic", relicId }, "awaken", "遺物を鍛造できませんでした。");
  };

  const toggleEquipRelic = (relicId: string) => {
    if (!profile) return;
    const current = profile.equippedRelics ?? [];
    const next = current.includes(relicId)
      ? current.filter((id) => id !== relicId)
      : [...current, relicId].slice(0, MAX_EQUIPPED_RELICS);
    void runGrowAction({ action: "equipRelics", relicIds: next }, "tap", "遺物装備を変更できませんでした。");
  };

  const tuneTraitAction = (cardId: string, traitKind: LllTraitKind) => {
    void runGrowAction({ action: "tuneTrait", cardId, traitKind }, "awaken", "特性を調律できませんでした。");
  };

  const tuneSkill2Action = (cardId: string, skillKind: LllSkillKind) => {
    void runGrowAction({ action: "tuneSkill2", cardId, skillKind }, "awaken", "技2を調律できませんでした。");
  };

  const executeDismantle = async () => {
    if (dismantleIds.length === 0) return;
    const ok = await runGrowAction({ action: "dismantle", cardIds: dismantleIds }, "coin", "分解できませんでした。");
    if (ok) {
      setDismantleIds([]);
      setDismantleMode(false);
    }
  };

  const exchangeLumen = () => {
    if (!profile || profile.lumen < 50) return;
    void runGrowAction({ action: "exchange" }, "coin", "両替できませんでした。");
  };

  const saveCustomDeck = async (counts: Record<string, number>) => {
    const ok = await runGrowAction({ action: "customDeck", counts }, "claim", "カスタムデッキを保存できませんでした。");
    if (ok) {
      setSelectedDeck("custom");
      setShowDeckModal(false);
    }
  };

  /* --- アリーナ: バトル開始（ラダー / 深淵 / PvP） --- */
  const maxCleared = profile ? profile.clearedTiers.reduce((m, t) => Math.max(m, t), -1) : -1;

  const beginBattleRequest = async (opts: {
    mode: ArenaMode;
    tierIndex?: number;
    floor?: number;
    rivalId?: string;
    clearedBefore?: boolean;
  }) => {
    if (!token || !profile || busy) return;
    unlockAudio();
    setBusy(true);
    setError("");
    setPending(null);
    stopPlayback();
    battleStartRef.current = {
      shards: profile.shards,
      lumen: profile.lumen,
      tickets: profile.tickets ?? 0,
      rating: profile.pvpRating ?? 1000,
      clearedBefore: opts.clearedBefore ?? false,
    };

    let tutorialDone = false;
    try {
      tutorialDone = localStorage.getItem(TUTORIAL_KEY) === "done";
    } catch {
      // 既定のまま
    }
    const isGuide =
      opts.mode === "ladder" &&
      (opts.tierIndex ?? 0) === 0 &&
      profile.wins + profile.losses + profile.draws === 0 &&
      !tutorialDone;
    guideBattleRef.current = isGuide;
    setGuideBattle(isGuide);
    guideTurnsUsedRef.current = 0;
    setGuideTurnsUsed(0);

    try {
      const { res, data } = await postJson("/api/lll/battle/start", {
        token,
        mode: opts.mode,
        tierIndex: opts.tierIndex ?? 0,
        floor: opts.floor,
        rivalId: opts.rivalId,
        tacticDeckId: selectedDeck,
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "対戦を開始できませんでした。");
        playSe("error");
        return;
      }
      setBattle(data.battle as Battle);
      if (data.profile) setProfile(data.profile as Profile);
      playSe("flip");
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  /* --- 逐次再生（1イベント = 1拍） --- */
  const clearPlaybackTimer = () => {
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  };

  const stopPlayback = () => {
    clearPlaybackTimer();
    playbackRef.current = null;
    setPlaybackInfo(null);
    setDisplayBattle(null);
    setLungeKey(null);
    setCutInBanner(null);
  };

  const finishPlayback = useCallback(() => {
    const pb = playbackRef.current;
    clearPlaybackTimer();
    playbackRef.current = null;
    setPlaybackInfo(null);
    setDisplayBattle(null);
    setLungeKey(null);
    setCutInBanner(null);
    if (!pb) return;
    setBattle(pb.next);
    if (pb.nextProfile) setProfile(pb.nextProfile);
  }, []);

  const showPlaybackStep = useCallback(
    (index: number) => {
      const pb = playbackRef.current;
      if (!pb) return;
      if (index >= pb.steps.length) {
        finishPlayback();
        return;
      }
      const step = pb.steps[index];
      pb.index = index;
      setPlaybackInfo({ index, total: pb.steps.length, actorKey: step.event.actorKey ?? step.event.targetKey ?? null });
      setDisplayBattle((prevDisplay) => {
        const base = prevDisplay ?? battleRef.current;
        if (!base) return base;
        const byKey = new Map(step.actors.map((a) => [a.key, a]));
        return {
          ...pb.next,
          phase: "battle",
          round: base.round,
          queue: base.queue,
          queuePos: base.queuePos,
          winner: null,
          actors: pb.next.actors.map((nextActor) => {
            const mid = byKey.get(nextActor.key);
            if (!mid) return nextActor;
            return {
              ...nextActor,
              hp: mid.hp,
              shield: mid.shield,
              alive: mid.alive,
              statuses: mid.statuses.map((s) => ({ ...s })),
              cooldowns: (base.actors.find((a) => a.key === nextActor.key)?.cooldowns ?? nextActor.cooldowns) as number[],
              defending: base.actors.find((a) => a.key === nextActor.key)?.defending ?? nextActor.defending,
            };
          }),
          log: [...(battleRef.current?.log ?? []), ...pb.next.log.slice(pb.prevLogLength, pb.prevLogLength + index + 1)],
        };
      });

      if (step.cutIn) {
        const actorObj = pb.next.actors.find((a) => a.key === step.cutIn?.actorKey);
        setCutInBanner({
          actorName: actorObj?.name ?? "",
          skillName: step.cutIn.skillName,
          element: step.cutIn.element,
        });
      } else {
        setCutInBanner(null);
      }

      if (step.vfx || step.shakeIntensity > 0) {
        setSceneVfx(step.vfx);
        setSceneShake(step.shakeIntensity);
        setSceneVfxNonce((n) => n + 1);
      }

      const attackerKey = step.event.actorKey;
      if (attackerKey && (step.event.type === "damage" || step.event.type === "info")) {
        setLungeKey(attackerKey);
        setTimeout(() => setLungeKey((k) => (k === attackerKey ? null : k)), 260);
      }
      if (step.float && (step.event.type === "damage" || step.event.type === "trait" || step.event.type === "status") && step.float.targetKey) {
        const key = step.float.targetKey;
        setHitKeys({ [key]: true });
        setTimeout(() => setHitKeys((h) => (h[key] ? {} : h)), 480);
      }
      if (step.shieldFlashKey) {
        const key = step.shieldFlashKey;
        setShieldFlashKeys({ [key]: true });
        setTimeout(() => setShieldFlashKeys((h) => (h[key] ? {} : h)), 380);
      }
      if (step.float) {
        floatIdRef.current += 1;
        const id = floatIdRef.current;
        const entry: FloatNum = { id, targetKey: step.float.targetKey, text: step.float.text, kind: step.float.kind };
        setFloats((f) => [...f.slice(-8), entry]);
        setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1100);
      }
      if (step.se) playSe(step.se);
      if (step.vibrate) {
        try {
          navigator.vibrate?.(step.vibrate);
        } catch {
          // ignore
        }
      }
      const dur = speedRef.current === "2x" ? stepDurationMs(step, "2x") : step.durationMs;
      playbackTimerRef.current = setTimeout(() => showPlaybackStep(index + 1), dur);
    },
    [finishPlayback],
  );

  const advancePlayback = () => {
    const pb = playbackRef.current;
    if (!pb) return;
    clearPlaybackTimer();
    showPlaybackStep(pb.index + 1);
  };

  const startPlayback = useCallback(
    (prev: Battle, next: Battle, nextProfile: Profile | null): boolean => {
      if (speedRef.current === "instant") return false;
      const newEvents = next.log.slice(prev.log.length);
      if (newEvents.length < 2) return false;
      const steps = buildPlaybackSteps(prev.actors, newEvents);
      if (steps.length < 2) return false;
      playbackRef.current = { steps, index: 0, next, nextProfile, prevLogLength: prev.log.length };
      showPlaybackStep(0);
      return true;
    },
    [showPlaybackStep],
  );

  const applyBattleFx = useCallback((prev: Battle | null, next: Battle) => {
    if (!prev) return;
    const hits: Record<string, true> = {};
    const newFloats: FloatNum[] = [];
    for (const actor of next.actors) {
      const before = prev.actors.find((a) => a.key === actor.key);
      if (!before) continue;
      const diff = actor.hp - before.hp;
      if (diff !== 0) {
        hits[actor.key] = true;
        floatIdRef.current += 1;
        newFloats.push({
          id: floatIdRef.current,
          targetKey: actor.key,
          text: diff < 0 ? `-${-diff}` : `+${diff}`,
          kind: diff > 0 ? "heal" : "damage",
        });
      }
    }
    if (Object.keys(hits).length > 0) {
      setHitKeys(hits);
      setTimeout(() => setHitKeys({}), 480);
      const firstHit = Object.keys(hits)[0];
      setSceneVfx({ kind: "attack", element: "light", toKey: firstHit });
      setSceneShake(1);
      setSceneVfxNonce((n) => n + 1);
    }
    if (newFloats.length > 0) {
      setFloats((f) => [...f.slice(-8), ...newFloats]);
      const ids = newFloats.map((f) => f.id);
      setTimeout(() => setFloats((f) => f.filter((x) => !ids.includes(x.id))), 950);
    }
  }, []);

  const sendAction = async (action: { skill: 0 | 1 | "basic" | "defend" | "burst"; targetKey?: string }) => {
    const current = battleRef.current;
    if (!token || !current || busy || playbackRef.current || current.phase !== "battle") return;
    setBusy(true);
    setError("");
    setPending(null);
    if (guideBattleRef.current) {
      guideTurnsUsedRef.current += 1;
      setGuideTurnsUsed(guideTurnsUsedRef.current);
    }
    try {
      const actionPayload = {
        type:
          action.skill === "basic"
            ? "basic"
            : action.skill === "defend"
              ? "defend"
              : action.skill === "burst"
                ? "burst"
                : "skill",
        ...action,
      };
      const { res, data } = await postJson("/api/lll/battle/action", { token, battleId: current.id, action: actionPayload });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "行動できませんでした。");
        playSe("error");
        return;
      }
      const next = data.battle as Battle;
      const nextProfile = (data.profile as Profile | undefined) ?? null;
      if (!startPlayback(current, next, nextProfile)) {
        playSe("hit");
        applyBattleFx(current, next);
        setBattle(next);
        if (nextProfile) setProfile(nextProfile);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const sendTactic = async (cardId: string) => {
    const current = battleRef.current;
    if (!token || !current || busy || playbackRef.current || current.phase !== "battle") return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/battle/action", {
        token,
        battleId: current.id,
        action: { type: "tactic", cardId },
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "戦術カードを使えませんでした。");
        playSe("error");
        return;
      }
      playSe("flip");
      const next = data.battle as Battle;
      const nextProfile = (data.profile as Profile | undefined) ?? null;
      if (!startPlayback(current, next, nextProfile)) {
        applyBattleFx(current, next);
        setBattle(next);
        if (nextProfile) setProfile(nextProfile);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const currentActor: BattleActor | undefined =
    battle?.phase === "battle" ? battle.actors.find((a) => a.key === battle.queue[battle.queuePos]) : undefined;
  const isPlayerTurn = currentActor?.side === "player";
  const currentStunned = !!currentActor?.statuses.some((s) => s.kind === "stun");

  /* --- AUTO バトルループ --- */
  useEffect(() => {
    if (!autoMode || !token || !battle || battle.phase !== "battle" || !isPlayerTurn || displayBattle || busy) return;
    const timer = setTimeout(() => {
      const cur = battleRef.current;
      if (!cur || cur.phase !== "battle" || playbackRef.current) return;
      void (async () => {
        setBusy(true);
        setPending(null);
        try {
          const { res, data } = await postJson("/api/lll/battle/action", {
            token,
            battleId: cur.id,
            action: { type: "auto" },
          });
          if (!res.ok) {
            setAutoMode(false);
            return;
          }
          const next = data.battle as Battle;
          const nextProfile = (data.profile as Profile | undefined) ?? null;
          if (!startPlayback(cur, next, nextProfile)) {
            applyBattleFx(cur, next);
            setBattle(next);
            if (nextProfile) setProfile(nextProfile);
          }
        } catch {
          setAutoMode(false);
        } finally {
          setBusy(false);
        }
      })();
    }, 240);
    return () => clearTimeout(timer);
  }, [autoMode, token, battle, isPlayerTurn, displayBattle, busy, postJson, startPlayback, applyBattleFx]);

  const chooseSkill = (skill: 0 | 1 | "basic" | "defend" | "burst") => {
    if (!currentActor || !isPlayerTurn || busy || playbackRef.current) return;
    playSe("tap");
    if (skill === "defend") {
      void sendAction({ skill: "defend" });
      return;
    }
    if (skill === "burst") {
      if ((battle?.burst?.player ?? 0) < 100 || currentStunned) {
        playSe("error");
        return;
      }
      if (currentActor.element === "light") {
        setPending({ skill: "burst", targetSide: "cpu", label: RESONANCE_BURST_INFO.light.name });
        return;
      }
      void sendAction({ skill: "burst" });
      return;
    }
    if (skill === "basic") {
      setPending({ skill, targetSide: "cpu", label: "通常攻撃" });
      return;
    }
    const def = currentActor.skills[skill];
    if (!def) return;
    if ((currentActor.cooldowns[skill] ?? 0) > 0) {
      playSe("error");
      return;
    }
    setPending({ skill, targetSide: ALLY_TARGET_KINDS.has(def.kind) ? "player" : "cpu", label: def.name });
  };

  const tapActor = (actor: BattleActor) => {
    if (suppressClickRef.current) return;
    if (!pending || !isPlayerTurn || busy || playbackRef.current || !actor.alive) return;
    if (actor.side !== pending.targetSide) return;
    void sendAction({ skill: pending.skill, ...(pending.skill === "defend" ? {} : { targetKey: actor.key }) });
  };

  const tapActorByKey = useCallback(
    (key: string) => {
      if (displayBattle) {
        const pb = playbackRef.current;
        if (pb) {
          clearPlaybackTimer();
          showPlaybackStep(pb.index + 1);
        }
        return;
      }
      const cur = battleRef.current;
      const actor = cur?.actors.find((a) => a.key === key);
      if (!actor || !pending || !isPlayerTurn || busy || !actor.alive || actor.side !== pending.targetSide) return;
      void sendAction({ skill: pending.skill, ...(pending.skill === "defend" ? {} : { targetKey: actor.key }) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayBattle, pending, isPlayerTurn, busy, showPlaybackStep],
  );

  const battleDragHandlers = (actor: BattleActor) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!isPlayerTurn || busy || playbackRef.current || actor.key !== currentActor?.key || e.button > 0) return;
      battleTrackRef.current = { actorKey: actor.key, startX: e.clientX, startY: e.clientY, active: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const track = battleTrackRef.current;
      if (!track || track.actorKey !== actor.key) return;
      if (!track.active) {
        if (Math.hypot(e.clientX - track.startX, e.clientY - track.startY) < 7) return;
        track.active = true;
        playSe("flip");
      }
      setBattleDrag({ actorKey: actor.key, x: e.clientX, y: e.clientY });
    },
    onPointerUp: (e: React.PointerEvent) => {
      const track = battleTrackRef.current;
      battleTrackRef.current = null;
      setBattleDrag(null);
      if (!track || !track.active) return;
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 60);
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-actor-key]");
      const targetKey = el?.getAttribute("data-actor-key");
      const target = battleRef.current?.actors.find((a) => a.key === targetKey);
      if (target && target.side === "cpu" && target.alive) {
        void sendAction({ skill: "basic", targetKey: target.key });
      }
    },
    onPointerCancel: () => {
      battleTrackRef.current = null;
      setBattleDrag(null);
    },
  });

  // 終局 SE
  useEffect(() => {
    if (!battle || battle.phase !== "finished") return;
    if (finishSeRef.current === battle.id) return;
    finishSeRef.current = battle.id;
    playSe(battle.winner === "player" ? "win" : battle.winner === "draw" ? "tap" : "lose");
    if (guideBattleRef.current) {
      guideBattleRef.current = false;
      try {
        localStorage.setItem(TUTORIAL_KEY, "done");
      } catch {
        // ignore
      }
    }
  }, [battle]);

  /* --- バインダー絞り込み・並び替え --- */
  const filteredCards = useMemo(() => {
    if (!profile) return [];
    const list = profile.cards.filter((c) => {
      if (filterElement !== "all" && c.element !== filterElement) return false;
      if (filterTier !== "all" && c.tier !== filterTier) return false;
      return true;
    });
    return [...list].sort((a, b) => {
      if (sortBy === "power") return cardPowerScore(b) - cardPowerScore(a);
      if (sortBy === "level") return b.level - a.level || cardPowerScore(b) - cardPowerScore(a);
      if (sortBy === "tier") return (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || cardPowerScore(b) - cardPowerScore(a);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }, [profile, filterElement, filterTier, sortBy]);

  const dismantleGain = useMemo(() => {
    if (!profile || dismantleIds.length === 0) return 0;
    const set = new Set(dismantleIds);
    return profile.cards.filter((c) => set.has(c.id)).reduce((s, c) => s + dismantleShards(c), 0);
  }, [profile, dismantleIds]);

  const guideActive = guideBattle && guideTurnsUsed < 3 && !displayBattle;
  const guideRecommendation: { skill: 0 | 1 | "basic"; targetKey: string | null } | null = (() => {
    if (!guideActive || !currentActor || !battle || battle.phase !== "battle") return null;
    const allies = battle.actors.filter((a) => a.side === "player" && a.alive);
    const enemies = battle.actors.filter((a) => a.side === "cpu" && a.alive);
    const lowestEnemy = enemies.slice().sort((a, b) => a.hp - b.hp || a.key.localeCompare(b.key))[0] ?? null;
    for (const idx of [0, 1] as const) {
      const skill = currentActor.skills[idx];
      if (!skill || skill.kind !== "heal" || (currentActor.cooldowns[idx] ?? 0) > 0) continue;
      const wounded = allies.filter((a) => a.hp / a.maxHp < 0.5).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.key.localeCompare(b.key))[0];
      if (wounded) return { skill: idx, targetKey: wounded.key };
    }
    let best: { skill: 0 | 1 | "basic"; power: number } = { skill: "basic", power: 40 };
    for (const idx of [0, 1] as const) {
      const skill = currentActor.skills[idx];
      if (!skill || (currentActor.cooldowns[idx] ?? 0) > 0) continue;
      if (!["damage", "burn", "stun", "guard_break", "drain"].includes(skill.kind)) continue;
      if (skill.power > best.power) best = { skill: idx, power: skill.power };
    }
    return { skill: best.skill, targetKey: lowestEnemy?.key ?? null };
  })();

  const forecastForActor = (actor: BattleActor): string | null => {
    if (!pending || !currentActor || !isPlayerTurn || displayBattle || !actor.alive || actor.side !== pending.targetSide) return null;
    if (pending.targetSide === "cpu") {
      const power =
        pending.skill === "basic"
          ? 40
          : pending.skill === "burst"
            ? 115
            : currentActor.skills[pending.skill as 0 | 1]?.power ?? 40;
      const dmg = predictDamageRange(
        {
          atk: currentActor.atk,
          element: currentActor.element,
          traitKind: currentActor.trait?.kind,
          overdrive: currentActor.statuses.some((s) => s.kind === "overdrive"),
          buffMult: currentActor.buffMult,
        },
        {
          def: actor.def,
          element: actor.element,
          traitKind: actor.trait?.kind,
          defending: actor.defending,
          guardBreak: actor.statuses.some((s) => s.kind === "guard_break"),
        },
        power,
      );
      const tag = dmg.affinity >= 1.25 ? "弱点 " : dmg.affinity <= 0.8 ? "耐性 " : "";
      return `${tag}${dmg.min}〜${dmg.max}`;
    }
    return "味方対象";
  };

  const reactionForActor = (actor: BattleActor): string | null => {
    if (!pending || !currentActor || !isPlayerTurn || displayBattle || !actor.alive) return null;
    if (pending.targetSide !== "cpu" || actor.side !== "cpu") return null;
    const hit = detectElementalReaction(currentActor.element, actor.statuses);
    return hit ? hit.name : null;
  };

  const renderActor = (actor: BattleActor) => {
    const targetable = !!pending && pending.targetSide === actor.side && actor.alive && isPlayerTurn && !displayBattle;
    const guideTarget = !!pending && guideRecommendation?.skill === pending.skill && guideRecommendation?.targetKey === actor.key;
    const forecastLabel = forecastForActor(actor);
    const reactionLabel = reactionForActor(actor);
    return (
      <div key={actor.key} className="lll-actor-wrap">
        <LllCard
          view={actorToView(actor, forecastLabel, reactionLabel)}
          size="sm"
          dataKey={actor.key}
          current={currentActor?.key === actor.key && battle?.phase === "battle"}
          targetable={targetable}
          hit={!!hitKeys[actor.key]}
          guide={guideTarget}
          lunge={lungeKey === actor.key ? (actor.side === "player" ? "up" : "down") : null}
          shieldFlash={!!shieldFlashKeys[actor.key]}
          dimmed={!actor.alive}
          onClick={() => tapActor(actor)}
          draggableClass={actor.side === "player"}
          {...(actor.side === "player" ? battleDragHandlers(actor) : {})}
        />
        {floats
          .filter((f) => f.targetKey === actor.key)
          .map((f) => (
            <span key={f.id} className={`lll-dmg lll-dmg-${f.kind}`} aria-hidden="true">
              {f.text}
            </span>
          ))}
      </div>
    );
  };

  if (!profile) {
    return (
      <div className="lll-shell lll-table">
        <div className="lll-workspace">
          <p className="lll-loading">読み込み中…</p>
          {error && (
            <p className="lll-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  const detailCard = detailCardId ? profile.cards.find((c) => c.id === detailCardId) ?? null : null;
  const teamCards = effectiveTeamIds
    .map((id) => profile.cards.find((c) => c.id === id))
    .filter((c): c is CardT => !!c);
  const teamPower = teamCards.reduce((sum, c) => sum + cardPowerScore(c), 0);
  const teamResonance = evaluatePartyResonance(teamCards);
  const ownedRelics = profile.unlockedRelics ?? [];
  const equippedRelicIds = profile.equippedRelics ?? [];
  const equippedRelicDefs = equippedRelicIds
    .map((id) => RELIC_BY_ID[id])
    .filter((r): r is NonNullable<typeof r> => !!r);

  const homeBadgeCount =
    DAILY_MISSIONS.filter((m) => {
      const cur = profile.dailyProgress?.[m.metric] ?? 0;
      return cur >= m.target && !(profile.dailyClaimed?.includes(m.id) ?? false);
    }).length +
    ACHIEVEMENTS.filter(
      (a) => checkAchievementDone(profile, a.id) && !(profile.achievementsClaimed?.includes(a.id) ?? false),
    ).length;
  const scoutCue = profile.cards.length <= 3;
  const shownBattle = displayBattle ?? battle;

  // 選択中ステージの地脈プレビュー
  const previewFieldId: BattleFieldId =
    arenaMode === "abyss"
      ? fieldForAbyssFloor(abyssFloor)
      : arenaMode === "pvp"
        ? fieldForPvpRival(selectedRivalId ?? "")
        : fieldForLadderTier(selectedTier);
  const previewField = BATTLE_FIELD_BY_ID[previewFieldId];
  const activeField = BATTLE_FIELD_BY_ID[shownBattle?.fieldId ?? "neutral"];

  const targetableKeys =
    pending && isPlayerTurn && !displayBattle && shownBattle
      ? shownBattle.actors.filter((a) => a.alive && a.side === pending.targetSide).map((a) => a.key)
      : [];

  const playerBurst = Math.min(100, Math.max(0, shownBattle?.burst?.player ?? 0));
  const cpuBurst = Math.min(100, Math.max(0, shownBattle?.burst?.cpu ?? 0));
  const burstReady = playerBurst >= 100 && !currentStunned;

  const battleRecap = (() => {
    if (!battle || battle.phase !== "finished") return null;
    let totalDamage = 0;
    let maxHit = 0;
    let maxHitLabel = "";
    let lastSkillName = "通常攻撃";
    const perActor = new Map<string, number>();
    for (const entry of battle.log) {
      const skillMatch = entry.text.match(/「(.+?)」/);
      if (entry.type === "info" && skillMatch) lastSkillName = skillMatch[1];
      if (entry.type === "info" && entry.text.includes("通常攻撃")) lastSkillName = "通常攻撃";
      if ((entry.type === "damage" || entry.type === "trait") && entry.actorKey?.startsWith("player_") && typeof entry.amount === "number") {
        totalDamage += entry.amount;
        perActor.set(entry.actorKey, (perActor.get(entry.actorKey) ?? 0) + entry.amount);
        if (entry.type === "damage" && entry.amount > maxHit) {
          maxHit = entry.amount;
          maxHitLabel = lastSkillName;
        }
      }
    }
    let mvp: { name: string; total: number } | null = null;
    for (const [key, total] of perActor) {
      const actor = battle.actors.find((a) => a.key === key);
      if (actor && (!mvp || total > mvp.total)) mvp = { name: actor.name, total };
    }
    return { totalDamage, maxHit, maxHitLabel, mvp };
  })();

  const viewer3DForCard = (card: CardT, mode: "inspect" | "summon" = "inspect") => (
    <LllCard3DViewer
      key={`${card.id}-${mode}-${card.tier}-${card.level}-${card.limitBreak ?? 0}`}
      card={cardToThreeInput(card)}
      mode={mode}
      height={mode === "summon" ? 310 : 270}
      onFail={handle3DFail}
      fallback={<LllCard view={cardToView(card, profile)} size="lg" />}
    />
  );

  const render2DArenaBoard = () => (
    <>
      <div className="lll-battle-row">{(shownBattle ?? battle)!.actors.filter((a) => a.side === "cpu").map(renderActor)}</div>
      <div className="lll-battle-row">{(shownBattle ?? battle)!.actors.filter((a) => a.side === "player").map(renderActor)}</div>
    </>
  );

  const navItems: { key: Tab; label: string; badge: string | null; icon: React.ReactNode }[] = [
    { key: "hub", label: "ハブ", badge: homeBadgeCount > 0 ? String(homeBadgeCount) : null, icon: <IconHub size={15} /> },
    { key: "arena", label: "出撃", badge: battle?.phase === "battle" ? "進行" : null, icon: <IconSwords size={15} /> },
    { key: "binder", label: "編成・遺物", badge: pendingTeam ? `${pendingTeam.length}/3` : null, icon: <IconDeck size={15} /> },
    { key: "scout", label: "スカウト", badge: (profile.tickets ?? 0) > 0 ? String(profile.tickets) : null, icon: <IconScout size={15} /> },
    { key: "codex", label: "図鑑・規則", badge: null, icon: <IconCodex size={15} /> },
  ];

  return (
    <div className="lll-shell lll-table">
      {/* フルビューポート独立トップバー（AGOBOT クローム非表示に伴う専用操作帯） */}
      <header className="lll-appbar">
        <div className="lll-appbar-inner">
          <div className="lll-appbar-left">
            <Link href={`${prefix}/games`} className="lll-back-link">
              <IconBack size={15} />
              <span>ゲーム一覧</span>
            </Link>
            <button type="button" className="lll-brand-btn" onClick={() => switchTab("hub")}>
              LLL
            </button>
            {editingName ? (
              <form
                className="lll-name-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void savePlayerName(nameInput);
                }}
              >
                <input
                  type="text"
                  className="lll-name-input"
                  value={nameInput}
                  maxLength={16}
                  autoFocus
                  aria-label="プレイヤー名"
                  onChange={(e) => setNameInput(e.target.value)}
                />
                <button type="submit" className="lll-snd-btn lll-snd-on" disabled={busy || !nameInput.trim()}>
                  保存
                </button>
                <button type="button" className="lll-snd-btn" onClick={() => setEditingName(false)}>
                  ×
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="lll-player-pill"
                title="クリックして調律者名を変更"
                onClick={() => {
                  setNameInput(profile.playerName ?? "調律者");
                  setEditingName(true);
                }}
              >
                {profile.playerName ?? "調律者"}
              </button>
            )}
          </div>

          <nav className="lll-appbar-nav" aria-label="LLL メインナビゲーション">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`lll-nav-btn${tab === item.key ? " lll-nav-active" : ""}`}
                aria-current={tab === item.key ? "page" : undefined}
                onClick={() => switchTab(item.key)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge && <span className="lll-count-pill">{item.badge}</span>}
              </button>
            ))}
          </nav>

          <div className="lll-appbar-right">
            <div className="lll-res-group" aria-label="所持リソース">
              <span className="lll-chip lll-chip-shards" title="強化の欠片">
                <IconShard size={13} /> {profile.shards}
              </span>
              <span className="lll-chip lll-chip-lumen" title="ルーメン">
                <IconLumen size={13} /> {profile.lumen}
              </span>
              <span className="lll-chip lll-chip-ticket" title="スカウト券">
                <IconTicket size={13} /> {profile.tickets ?? 0}
              </span>
            </div>
            <div className="lll-soundbar" role="group" aria-label="表示とサウンド設定">
              <button
                type="button"
                className={`lll-snd-btn${canUse3D ? " lll-snd-on" : ""}`}
                aria-pressed={canUse3D}
                disabled={webglFailed}
                onClick={toggle3D}
                title={webglFailed ? "WebGL非対応のため2D表示中" : "3D / 2D 表示切替"}
              >
                <IconCube size={13} /> 3D
              </button>
              <button
                type="button"
                className={`lll-snd-btn${sound.bgm ? " lll-snd-on" : ""}`}
                aria-pressed={sound.bgm}
                onClick={() => toggleSound("bgm")}
                title="BGM 切替"
              >
                <IconMusic size={13} />
              </button>
              <button
                type="button"
                className={`lll-snd-btn${sound.se ? " lll-snd-on" : ""}`}
                aria-pressed={sound.se}
                onClick={() => toggleSound("se")}
                title="効果音 切替"
              >
                <IconVolume size={13} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="lll-workspace">
        {error && (
          <p className="lll-error" role="alert">
            {error}
          </p>
        )}

        {/* ===== ホームハブ ===== */}
        {tab === "hub" && (
          <LllHomeView
            profile={profile}
            busy={busy}
            canUse3D={canUse3D}
            viewer3D={(card) => viewer3DForCard(card, "inspect")}
            onClaimMission={(kind, id) => void claimMission(kind, id)}
            onSwitchTab={switchTab}
            onLaunchArena={launchArena}
            onOpenDeckModal={() => setShowDeckModal(true)}
            onInspectCard={(cardId) => openDetailCard(cardId)}
          />
        )}

        {/* ===== スカウト ===== */}
        {tab === "scout" && (
          <section className="lll-scout">
            <div className="lll-panel-head" style={{ width: "100%" }}>
              <span className="lll-chip">所持カード {profile.cards.length}/60</span>
              <button type="button" className="lll-btn" onClick={() => setShowRates(true)}>
                提供割合・仕様
              </button>
            </div>
            {scoutCue && !appraising && !result && (
              <ol className="lll-cue" aria-label="はじめの3ステップ">
                <li className="lll-cue-active">1 画像またはスカウト券</li>
                <li>2 鑑定召喚</li>
                <li>3 パーティ編成</li>
              </ol>
            )}
            {appraising ? (
              <div className="lll-flip-wrap" aria-live="polite">
                <div className="lll-cardback-flip">
                  <IconScout size={30} />
                  <span className="lll-cardback-logo">LLL</span>
                </div>
                <p className="lll-appraising">召喚鑑定中…</p>
              </div>
            ) : result ? (
              <div className="lll-reveal">
                {result.duplicated || !result.card ? (
                  <div className="lll-dup-box">
                    <span className="lll-stamp lll-stamp-dup">重複</span>
                    <p className="lll-dup-text">
                      {result.limitBroken ? "見覚えのある1枚。同名カードが自動で限界突破しました。" : "見覚えのある1枚だった。"}
                    </p>
                    <div className="lll-currencies">
                      <span className="lll-chip lll-chip-shards">
                        <IconShard size={13} /> 欠片 +{result.shardsGained}
                      </span>
                      {result.limitBroken && (
                        <span className="lll-chip lll-chip-picked">
                          <IconStar size={13} /> 限界突破 +1
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="lll-reveal-card" style={{ width: "100%", maxWidth: 320 }}>
                    {canUse3D ? (
                      viewer3DForCard(result.card, "summon")
                    ) : (
                      <LllCard view={cardToView(result.card, profile)} size="lg" />
                    )}
                    <span className={`lll-stamp lll-stamp-${result.card.tier}`}>{TIER_LABEL[result.card.tier]}</span>
                    {result.card.tier === "legend" && <span className="lll-legend-flash" aria-hidden="true" />}
                  </div>
                )}
                {!result.duplicated && result.card && (
                  <div className="lll-currencies">
                    <span className="lll-chip">{result.aiUsed ? "AI鑑定" : "召喚鑑定"}</span>
                    <span className="lll-chip">
                      {result.card.name} ({ELEMENT_LABEL[result.card.element]})
                    </span>
                  </div>
                )}
                <div className="lll-actions">
                  <button
                    type="button"
                    className="lll-btn lll-btn-primary"
                    onClick={() => {
                      setResult(null);
                      fileInputRef.current?.click();
                    }}
                  >
                    画像でもう一度
                  </button>
                  {(profile.tickets ?? 0) >= 1 && (
                    <button
                      type="button"
                      className="lll-btn lll-btn-primary"
                      onClick={() => void summonWithTicket()}
                    >
                      <IconTicket size={14} /> 券で召喚（残{profile.tickets}）
                    </button>
                  )}
                  {result.card && (
                    <button type="button" className="lll-btn" onClick={() => switchTab("binder")}>
                      編成・遺物へ
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="lll-scout-grid">
                <div
                  className={`lll-dropzone${dragOver ? " lll-dropzone-hot" : ""}${scoutCue ? " lll-dropzone-cue" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label="画像をドロップ、またはクリックして選択"
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void appraiseFile(file);
                  }}
                >
                  <span className="lll-dropzone-glyph" aria-hidden="true">
                    <IconScout size={22} />
                  </span>
                  <span className="lll-dropzone-label">画像スカウト（ドロップ / 選択）</span>
                  <span className="lll-dropzone-sub">手元の写真やイラストから固有ステータス・技を鑑定</span>
                </div>

                <div className="lll-ticket-card">
                  <span className="lll-dropzone-glyph" aria-hidden="true">
                    <IconTicket size={22} />
                  </span>
                  <strong>SR以上確定 スカウト券召喚</strong>
                  <span className="lll-mission-meta">エリート80% / レジェンド20%（重複時は限界突破）</span>
                  <span className="lll-chip lll-chip-ticket">
                    <IconTicket size={13} /> 所持スカウト券：{profile.tickets ?? 0}枚
                  </span>
                  <button
                    type="button"
                    className="lll-btn lll-btn-primary"
                    disabled={appraising || (profile.tickets ?? 0) < 1}
                    onClick={() => void summonWithTicket()}
                  >
                    <IconTicket size={14} /> 1枚使って召喚
                  </button>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void appraiseFile(file);
              }}
            />
          </section>
        )}

        {/* ===== バインダー・編成・遺物工房 ===== */}
        {tab === "binder" && (
          <section className="lll-binder">
            <div className="lll-binder-head">
              <span className="lll-chip">チーム {teamCards.length}/3 ・ 総戦力 {teamPower}</span>
              {pendingTeam && <span className="lll-chip lll-chip-picked">編成中：あと{3 - pendingTeam.length}枚で確定</span>}
              <span className="lll-chip">所持 {profile.cards.length}/60</span>
              {pickedCardId && <span className="lll-chip lll-chip-picked">置くスロットを選択（再タップで詳細・調律）</span>}
              <button type="button" className="lll-btn lll-btn-exchange" onClick={exchangeLumen} disabled={busy || profile.lumen < 50}>
                ルーメン両替 50 → 欠片5
              </button>
            </div>

            <div className="lll-team-panel">
              <div className="lll-team-slots">
                {[0, 1, 2].map((i) => {
                  const card = teamCards[i];
                  return (
                    <div
                      key={i}
                      ref={(el) => {
                        teamSlotRefs.current[i] = el;
                      }}
                      className={`lll-slot${hotSlot === i ? " lll-slot-hot" : ""}${pickedCardId ? " lll-slot-armed" : ""}`}
                      onClick={() => {
                        if (pickedCardId) assignToSlot(pickedCardId, i);
                      }}
                    >
                      {card ? (
                        <LllCard view={cardToView(card, profile)} size="md" onClick={() => openDetailCard(card.id)}>
                          <button
                            type="button"
                            className="lll-remove-chip"
                            aria-label={`${card.name}をチームから外す`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFromTeam(card.id);
                            }}
                          >
                            ×
                          </button>
                        </LllCard>
                      ) : (
                        <div className="lll-slot-empty">
                          <span className="lll-slot-num">{i + 1}</span>
                          <span>空き</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="lll-resonance-bar">
                <div className="lll-resonance-title">
                  <span className="lll-chip lll-chip-lumen">属性共鳴：{teamResonance.name}</span>
                  <span className="lll-chip">{teamResonance.shortLabel}</span>
                </div>
                <span className="lll-mission-meta">{teamResonance.description}</span>
              </div>
            </div>

            {/* 遺物工房（鍛造＆最大2枠装備） */}
            <div className="lll-panel">
              <div className="lll-panel-head">
                <h2 className="lll-panel-title">
                  <IconRelic size={15} /> 遺物工房（装備 {equippedRelicIds.length}/{MAX_EQUIPPED_RELICS}）
                </h2>
                <div className="lll-currencies">
                  {equippedRelicDefs.map((r) => (
                    <span key={r.id} className="lll-chip lll-chip-lumen">
                      {r.name}
                    </span>
                  ))}
                  <button type="button" className="lll-snd-btn" onClick={() => setShowRelics((v) => !v)}>
                    {showRelics ? "折りたたむ" : "遺物一覧を開く"}
                  </button>
                </div>
              </div>

              {showRelics && (
                <div className="lll-relic-grid">
                  {RELICS.map((relic) => {
                    const owned = ownedRelics.includes(relic.id);
                    const equipped = equippedRelicIds.includes(relic.id);
                    const canAfford = profile.shards >= relic.craftShards && profile.lumen >= relic.craftLumen;
                    const slotsFull = !equipped && equippedRelicIds.length >= MAX_EQUIPPED_RELICS;
                    return (
                      <div key={relic.id} className={`lll-relic-card${equipped ? " lll-relic-equipped" : ""}`}>
                        <div className="lll-relic-head">
                          <strong>{relic.name}</strong>
                          <span className="lll-chip">{RELIC_CAT_LABEL[relic.category] ?? relic.category}</span>
                        </div>
                        <p className="lll-mission-meta">{relic.summary}</p>
                        <div className="lll-relic-foot">
                          {owned ? (
                            <button
                              type="button"
                              className={`lll-btn${equipped ? " lll-btn-primary" : ""}`}
                              disabled={busy || slotsFull}
                              onClick={() => toggleEquipRelic(relic.id)}
                            >
                              {equipped ? "装備中（外す）" : slotsFull ? "枠満杯 (2/2)" : "装備する"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="lll-btn"
                              disabled={busy || !canAfford}
                              onClick={() => craftRelicAction(relic.id)}
                            >
                              鍛造（欠片{relic.craftShards} / L{relic.craftLumen}）
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 絞り込み・並び替え・一括分解ツールバー */}
            <div className="lll-filterbar">
              <select
                className="lll-select"
                aria-label="属性で絞り込み"
                value={filterElement}
                onChange={(e) => setFilterElement(e.target.value as "all" | LllElement)}
              >
                <option value="all">全属性</option>
                {(["fire", "water", "wind", "earth", "light", "dark"] as LllElement[]).map((el) => (
                  <option key={el} value={el}>
                    {ELEMENT_LABEL[el]}属性
                  </option>
                ))}
              </select>
              <select
                className="lll-select"
                aria-label="ティアで絞り込み"
                value={filterTier}
                onChange={(e) => setFilterTier(e.target.value as "all" | LllTier)}
              >
                <option value="all">全ティア</option>
                <option value="legend">レジェンド</option>
                <option value="elite">エリート</option>
                <option value="normal">ノーマル</option>
              </select>
              <select
                className="lll-select"
                aria-label="並び替え"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as BinderSort)}
              >
                <option value="power">戦力順</option>
                <option value="level">Lv順</option>
                <option value="tier">ティア順</option>
                <option value="recent">入手順</option>
              </select>
              <button
                type="button"
                className={`lll-btn${dismantleMode ? " lll-btn-danger" : ""}`}
                onClick={() => {
                  setDismantleMode((v) => !v);
                  setDismantleIds([]);
                  setPickedCardId(null);
                  playSe("tap");
                }}
              >
                {dismantleMode ? "分解モード終了" : "一括分解"}
              </button>
            </div>

            {dismantleMode && (
              <div className="lll-dismantle-bar">
                <span>分解するカードを選択（チーム内・保護ロック中は除外）: {dismantleIds.length}枚選択中</span>
                <span className="lll-chip lll-chip-shards">
                  <IconShard size={13} /> 獲得予定 +{dismantleGain}
                </span>
                <button
                  type="button"
                  className="lll-btn lll-btn-danger"
                  disabled={busy || dismantleIds.length === 0}
                  onClick={() => void executeDismantle()}
                >
                  選択を分解する
                </button>
              </div>
            )}

            <div className="lll-collection">
              {filteredCards.map((card) => {
                const inTeam = effectiveTeamIds.includes(card.id);
                const dismantleSelected = dismantleMode && dismantleIds.includes(card.id);
                return (
                  <LllCard
                    key={card.id}
                    view={cardToView(card, profile)}
                    size="sm"
                    selected={dismantleSelected || (!dismantleMode && pickedCardId === card.id)}
                    dimmed={inTeam}
                    draggableClass={!dismantleMode}
                    onClick={() => tapCollectionCard(card)}
                    {...binderDragHandlers(card)}
                  >
                    {inTeam && <span className="lll-team-badge">チーム内</span>}
                    {dismantleSelected && <span className="lll-team-badge">分解選択</span>}
                  </LllCard>
                );
              })}
            </div>
          </section>
        )}

        {/* ===== アリーナ（出撃＆バトル） ===== */}
        {tab === "arena" && (
          <section className="lll-arena">
            {!battle ? (
              <>
                <div className="lll-arena-top">
                  <div className="lll-seg" role="tablist" aria-label="対戦モード">
                    {(
                      [
                        ["ladder", "ラダー戦"],
                        ["abyss", "深淵の試練"],
                        ["pvp", "模擬PvP"],
                      ] as [ArenaMode, string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={arenaMode === m}
                        className={`lll-seg-btn${arenaMode === m ? " lll-seg-active" : ""}`}
                        onClick={() => {
                          setArenaMode(m);
                          playSe("tap");
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="lll-currencies">
                    <span className="lll-chip">
                      {profile.wins}勝 {profile.losses}敗 {profile.draws}分
                    </span>
                    <span className="lll-chip lll-chip-rating">Rate {profile.pvpRating ?? 1000}</span>
                    <span className="lll-chip">深淵 {profile.abyssBestFloor ?? 0}F</span>
                  </div>
                </div>

                {/* 出撃ブリーフィング（地脈・共鳴・装備遺物の一覧確認） */}
                <div className="lll-briefing">
                  <div className="lll-briefing-cell">
                    <span className="lll-briefing-label">
                      <IconField size={13} /> 戦場地脈
                    </span>
                    <strong className="lll-briefing-val">
                      <span className="lll-field-dot" style={{ background: previewField.accentHex }} />
                      {previewField.name}（{previewField.shortTag}）
                    </strong>
                    <span className="lll-mission-meta">{previewField.description}</span>
                  </div>
                  <div className="lll-briefing-cell">
                    <span className="lll-briefing-label">属性共鳴（編成 {teamCards.length}/3）</span>
                    <strong className="lll-briefing-val">{teamResonance.name}</strong>
                    <span className="lll-mission-meta">{teamResonance.description}</span>
                  </div>
                  <div className="lll-briefing-cell">
                    <span className="lll-briefing-label">
                      <IconRelic size={13} /> 装備遺物 ({equippedRelicDefs.length}/{MAX_EQUIPPED_RELICS})
                    </span>
                    {equippedRelicDefs.length > 0 ? (
                      <>
                        <strong className="lll-briefing-val">{equippedRelicDefs.map((r) => r.name).join(" / ")}</strong>
                        <span className="lll-mission-meta">{equippedRelicDefs.map((r) => r.summary).join(" ・ ")}</span>
                      </>
                    ) : (
                      <button type="button" className="lll-inline-link" onClick={() => switchTab("binder")}>
                        未装備（編成・遺物タブで装備）
                      </button>
                    )}
                  </div>
                </div>

                {arenaMode === "ladder" && (
                  <div className="lll-ladder">
                    {TIERS.map((tier, i) => {
                      const unlocked = i <= maxCleared + 1;
                      const cleared = profile.clearedTiers.includes(i);
                      const field = BATTLE_FIELD_BY_ID[fieldForLadderTier(i)];
                      return (
                        <button
                          key={tier.name}
                          type="button"
                          className={`lll-tier-row${selectedTier === i ? " lll-tier-selected" : ""}${unlocked ? "" : " lll-tier-locked"}`}
                          disabled={!unlocked}
                          aria-pressed={selectedTier === i}
                          onClick={() => {
                            setSelectedTier(i);
                            playSe("tap");
                          }}
                        >
                          <span className="lll-tier-name">
                            {tier.name}
                            {cleared && <span className="lll-tier-clear">クリア済</span>}
                            {!unlocked && <span aria-hidden="true">（未開放）</span>}
                          </span>
                          <span className="lll-tier-meta">敵 Lv{tier.enemyLv}</span>
                          <span className="lll-chip">
                            <span className="lll-field-dot" style={{ background: field.accentHex }} />
                            {field.name}
                          </span>
                          <span className="lll-tier-reward">
                            勝利 欠片{tier.winShards} / L{tier.winLumen}
                            {cleared ? "" : "（初回2倍）"} ・ 敗北 欠片{tier.loseShards}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {arenaMode === "abyss" && (
                  <div className="lll-abyss-card">
                    <div className="lll-mission-info">
                      <strong>
                        深淵の試練 — 第 {abyssFloor} 階層{abyssFloor % 5 === 0 ? "（BOSS）" : ""}
                      </strong>
                      <span className="lll-mission-meta">
                        5階層ごとに強敵ボス登場（スカウト券確定ドロップ）。到達済み最大 {(profile.abyssBestFloor ?? 0) + 1}F まで挑戦可能。
                      </span>
                    </div>
                    <div className="lll-soundbar">
                      <button
                        type="button"
                        className="lll-snd-btn"
                        disabled={abyssFloor <= 1}
                        onClick={() => setAbyssFloor((f) => Math.max(1, f - 1))}
                      >
                        －1F
                      </button>
                      <button
                        type="button"
                        className="lll-snd-btn lll-snd-on"
                        disabled={abyssFloor >= (profile.abyssBestFloor ?? 0) + 1}
                        onClick={() => setAbyssFloor((f) => Math.min((profile.abyssBestFloor ?? 0) + 1, f + 1))}
                      >
                        ＋1F
                      </button>
                    </div>
                  </div>
                )}

                {arenaMode === "pvp" && (
                  <div className="lll-ladder">
                    {pvpRivals.map((rival) => {
                      const field = BATTLE_FIELD_BY_ID[fieldForPvpRival(rival.id)];
                      return (
                        <button
                          key={rival.id}
                          type="button"
                          className={`lll-pvp-card${selectedRivalId === rival.id ? " lll-pvp-selected" : ""}`}
                          onClick={() => {
                            setSelectedRivalId(rival.id);
                            playSe("tap");
                          }}
                        >
                          <div className="lll-mission-info" style={{ textAlign: "left" }}>
                            <strong>
                              {rival.playerName}（{rival.title}）
                            </strong>
                            <span className="lll-mission-meta">
                              {rival.cards.map((c) => `${c.name}(Lv${c.level})`).join(" / ")}
                            </span>
                          </div>
                          <div className="lll-currencies">
                            <span className="lll-chip">
                              <span className="lll-field-dot" style={{ background: field.accentHex }} />
                              {field.name}
                            </span>
                            <span className="lll-chip lll-chip-rating">Rate {rival.rating}</span>
                            <span className="lll-chip">戦力 {rival.powerScore}</span>
                          </div>
                        </button>
                      );
                    })}
                    {pvpRivals.length === 0 && <p className="lll-mission-meta">対戦相手を読み込み中…</p>}
                  </div>
                )}

                <div className="lll-deckpick" role="group" aria-label="戦術デッキ">
                  <div className="lll-panel-head" style={{ gridColumn: "1 / -1" }}>
                    <span className="lll-actionbar-label" style={{ width: "auto", textAlign: "left" }}>
                      戦術デッキ（30枚）
                    </span>
                    <button type="button" className="lll-btn" onClick={() => setShowDeckModal(true)}>
                      <IconDeck size={14} /> カスタムデッキ編成
                    </button>
                  </div>
                  {Object.entries(TACTIC_DECKS).map(([deckId, deck]) => (
                    <button
                      key={deckId}
                      type="button"
                      className={`lll-deck-btn${selectedDeck === deckId ? " lll-deck-selected" : ""}`}
                      aria-pressed={selectedDeck === deckId}
                      onClick={() => {
                        setSelectedDeck(deckId);
                        playSe("tap");
                      }}
                    >
                      <span className="lll-deck-name">{deck.name}</span>
                      <span className="lll-deck-desc">{deck.description}</span>
                    </button>
                  ))}
                  {profile.customTacticDeck && (
                    <button
                      type="button"
                      className={`lll-deck-btn${selectedDeck === "custom" ? " lll-deck-selected" : ""}`}
                      aria-pressed={selectedDeck === "custom"}
                      onClick={() => {
                        setSelectedDeck("custom");
                        playSe("tap");
                      }}
                    >
                      <span className="lll-deck-name">マイカスタム 30枚</span>
                      <span className="lll-deck-desc">自作の30枚戦術デッキで出撃する。</span>
                    </button>
                  )}
                </div>

                <div className="lll-actions">
                  <button
                    type="button"
                    className="lll-btn lll-btn-primary lll-btn-big"
                    disabled={busy || teamCards.length < 3 || (arenaMode === "pvp" && !selectedRivalId)}
                    onClick={() => {
                      if (arenaMode === "abyss") {
                        void beginBattleRequest({ mode: "abyss", floor: abyssFloor });
                      } else if (arenaMode === "pvp" && selectedRivalId) {
                        void beginBattleRequest({ mode: "pvp", rivalId: selectedRivalId });
                      } else {
                        void beginBattleRequest({
                          mode: "ladder",
                          tierIndex: selectedTier,
                          clearedBefore: profile.clearedTiers.includes(selectedTier),
                        });
                      }
                    }}
                  >
                    <IconSwords size={16} />
                    {arenaMode === "abyss"
                      ? `深淵 第${abyssFloor}階層へ出撃`
                      : arenaMode === "pvp"
                        ? "ゴーストライバルと対戦"
                        : "対戦開始"}
                  </button>
                  {teamCards.length < 3 && <span className="lll-chip">編成タブで3枚編成してください</span>}
                </div>
              </>
            ) : (
              <div
                className="lll-battle"
                onClick={() => {
                  if (displayBattle) advancePlayback();
                }}
              >
                <div className="lll-battle-side-label">
                  <span className="lll-chip lll-chip-enemy">
                    {battle.title ?? `CPU ・ ${TIERS[battle.tierIndex]?.name ?? ""}`}
                  </span>
                  <span className="lll-chip" title={activeField.description}>
                    <span className="lll-field-dot" style={{ background: activeField.accentHex }} />
                    地脈：{activeField.name}
                  </span>
                  {shownBattle?.resonance?.player && (
                    <span className="lll-chip lll-chip-lumen" title={shownBattle.resonance.player.description}>
                      共鳴：{shownBattle.resonance.player.name}
                    </span>
                  )}
                  {battle.tactics && battle.tactics.cpu.deckCount + (battle.tactics.cpu.handCount ?? 0) > 0 && (
                    <span className="lll-chip">
                      敵手札 {battle.tactics.cpu.handCount ?? 0} ・ 山札 {battle.tactics.cpu.deckCount}
                      {(battle.tactics.cpu.reserveCount ?? 0) > 0 ? ` ・ 設置 ${battle.tactics.cpu.reserveCount}` : ""}
                    </span>
                  )}
                  <div className="lll-speedbar" role="group" aria-label="再生・オート操作">
                    <button
                      type="button"
                      className={`lll-snd-btn${autoMode ? " lll-snd-on" : ""}`}
                      aria-pressed={autoMode}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAutoMode((v) => !v);
                        playSe("tap");
                      }}
                    >
                      AUTO {autoMode ? "ON" : "OFF"}
                    </button>
                    <button
                      type="button"
                      className={`lll-snd-btn${canUse3D ? " lll-snd-on" : ""}`}
                      aria-pressed={canUse3D}
                      disabled={webglFailed}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle3D();
                      }}
                    >
                      {canUse3D ? "3D" : "2D"}
                    </button>
                    {(["1x", "2x", "instant"] as SpeedMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`lll-snd-btn${speed === mode ? " lll-snd-on" : ""}`}
                        aria-pressed={speed === mode}
                        onClick={(e) => {
                          e.stopPropagation();
                          changeSpeed(mode);
                        }}
                      >
                        {mode === "instant" ? "一斉" : mode}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 地脈効果 + 共鳴バーストゲージ */}
                <div className="lll-battle-hud">
                  <div className="lll-field-banner">
                    <span className="lll-field-dot" style={{ background: activeField.accentHex }} />
                    <span className="lll-mission-meta">{activeField.description}</span>
                  </div>
                  <div className={`lll-burst-meter${playerBurst >= 100 ? " lll-burst-ready" : ""}`} aria-label="共鳴バーストゲージ">
                    <div className="lll-burst-head">
                      <span>
                        <IconBolt size={13} /> 共鳴バースト {playerBurst}%
                      </span>
                      <span className="lll-mission-meta">敵 {cpuBurst}%</span>
                    </div>
                    <div className="lll-burst-track">
                      <span className="lll-burst-fill" style={{ width: `${playerBurst}%` }} />
                    </div>
                  </div>
                </div>

                <div className="lll-battle-stage">
                  {cutInBanner && (
                    <div className="lll-cutin-banner" aria-live="polite">
                      <span className="lll-cutin-actor">{cutInBanner.actorName}</span>
                      <span className="lll-cutin-skill">{cutInBanner.skillName}</span>
                    </div>
                  )}

                  {canUse3D ? (
                    <>
                      <LllBattleScene3D
                        actors={(shownBattle ?? battle).actors.map(actorToThreeInput)}
                        currentActorKey={
                          displayBattle
                            ? playbackInfo?.actorKey ?? null
                            : currentActor?.key ?? null
                        }
                        targetableKeys={targetableKeys}
                        guideTargetKey={
                          pending && guideRecommendation?.skill === pending.skill
                            ? guideRecommendation.targetKey
                            : null
                        }
                        vfx={sceneVfx}
                        vfxNonce={sceneVfxNonce}
                        shakeIntensity={sceneShake}
                        isBossOrAbyss={battle.mode === "abyss" || battle.tierIndex >= 6}
                        fieldId={(shownBattle ?? battle).fieldId ?? "neutral"}
                        onActorTap={tapActorByKey}
                        onFail={handle3DFail}
                        fallback={render2DArenaBoard()}
                      />
                      {pending && targetableKeys.length > 0 && (
                        <div className="lll-actions" aria-label="対象クイック選択">
                          {(shownBattle ?? battle).actors
                            .filter((a) => targetableKeys.includes(a.key))
                            .map((a) => {
                              const fc = forecastForActor(a);
                              const rx = reactionForActor(a);
                              return (
                                <button
                                  key={a.key}
                                  type="button"
                                  className="lll-btn lll-btn-primary"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    tapActor(a);
                                  }}
                                >
                                  {a.name} (HP {a.hp}/{a.maxHp})
                                  {fc ? ` [${fc}]` : ""}
                                  {rx ? ` [反応:${rx}]` : ""}
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </>
                  ) : (
                    render2DArenaBoard()
                  )}
                </div>

                <div className="lll-queue" aria-label="行動順">
                  {(shownBattle ?? battle).queue.map((key, i) => {
                    const actor = (shownBattle ?? battle).actors.find((a) => a.key === key);
                    if (!actor) return null;
                    const nowKey = displayBattle
                      ? playbackInfo?.actorKey ?? key
                      : (shownBattle ?? battle).queue[(shownBattle ?? battle).queuePos];
                    const done = !displayBattle && i < (shownBattle ?? battle).queuePos;
                    return (
                      <span
                        key={`${key}-${i}`}
                        className={`lll-queue-chip${key === nowKey ? " lll-queue-chip-now" : ""}${done ? " lll-queue-chip-done" : ""}${actor.alive ? "" : " lll-queue-chip-dead"}`}
                      >
                        {actor.name}
                      </span>
                    );
                  })}
                </div>

                <div className="lll-logstrip" aria-live="polite">
                  <span className="lll-chip">R{(shownBattle ?? battle).round}</span>
                  {[...(shownBattle ?? battle).log]
                    .slice(-3)
                    .reverse()
                    .map((entry, i) => (
                      <p key={`${(shownBattle ?? battle).log.length}-${i}`} className={`lll-logline${i === 0 ? " lll-logline-latest" : ""}`}>
                        {entry.text}
                      </p>
                    ))}
                  {(shownBattle ?? battle).log.length === 0 && <p className="lll-logline">対戦開始</p>}
                </div>

                {battle.phase === "finished" ? (
                  <div className="lll-result">
                    <span className={`lll-result-stamp lll-result-${battle.winner === "player" ? "win" : battle.winner === "draw" ? "draw" : "lose"}`}>
                      {battle.winner === "player" ? "勝利" : battle.winner === "draw" ? "引分" : "敗北"}
                    </span>
                    {battleStartRef.current && (
                      <div className="lll-currencies">
                        {profile.shards - battleStartRef.current.shards !== 0 && (
                          <span className="lll-chip lll-chip-shards">
                            <IconShard size={13} /> 欠片 +{profile.shards - battleStartRef.current.shards}
                          </span>
                        )}
                        {profile.lumen - battleStartRef.current.lumen !== 0 && (
                          <span className="lll-chip lll-chip-lumen">
                            <IconLumen size={13} /> ルーメン +{profile.lumen - battleStartRef.current.lumen}
                          </span>
                        )}
                        {(profile.tickets ?? 0) - battleStartRef.current.tickets > 0 && (
                          <span className="lll-chip lll-chip-ticket">
                            <IconTicket size={13} /> 券 +{(profile.tickets ?? 0) - battleStartRef.current.tickets}
                          </span>
                        )}
                        {battle.mode === "pvp" && (profile.pvpRating ?? 1000) !== battleStartRef.current.rating && (
                          <span className="lll-chip lll-chip-rating">
                            Rate {(profile.pvpRating ?? 1000) - battleStartRef.current.rating >= 0 ? "+" : ""}
                            {(profile.pvpRating ?? 1000) - battleStartRef.current.rating}
                          </span>
                        )}
                      </div>
                    )}
                    {battleRecap && battleRecap.totalDamage > 0 && (
                      <div className="lll-currencies" aria-label="戦績">
                        <span className="lll-chip">与ダメージ {battleRecap.totalDamage}</span>
                        {battleRecap.maxHit > 0 && (
                          <span className="lll-chip">
                            最大の一撃 {battleRecap.maxHitLabel} {battleRecap.maxHit}
                          </span>
                        )}
                        {battleRecap.mvp && (
                          <span className="lll-chip">
                            MVP {battleRecap.mvp.name}（{battleRecap.mvp.total}）
                          </span>
                        )}
                      </div>
                    )}
                    <div className="lll-actions">
                      {battle.mode === "abyss" ? (
                        <>
                          {battle.winner === "player" && (
                            <button
                              type="button"
                              className="lll-btn lll-btn-primary"
                              disabled={busy}
                              onClick={() => {
                                const nextFloor = (battle.floor ?? abyssFloor) + 1;
                                setAbyssFloor(nextFloor);
                                void beginBattleRequest({ mode: "abyss", floor: nextFloor });
                              }}
                            >
                              次の階層（{(battle.floor ?? abyssFloor) + 1}F）へ
                            </button>
                          )}
                          <button
                            type="button"
                            className="lll-btn"
                            disabled={busy}
                            onClick={() => void beginBattleRequest({ mode: "abyss", floor: battle.floor ?? abyssFloor })}
                          >
                            同じ階層へ
                          </button>
                        </>
                      ) : battle.mode === "pvp" ? (
                        <button
                          type="button"
                          className="lll-btn lll-btn-primary"
                          disabled={busy || !selectedRivalId}
                          onClick={() => selectedRivalId && void beginBattleRequest({ mode: "pvp", rivalId: selectedRivalId })}
                        >
                          もう一度対戦
                        </button>
                      ) : battle.winner === "player" && battleStartRef.current && !battleStartRef.current.clearedBefore && battle.tierIndex < TIERS.length - 1 ? (
                        <>
                          <button
                            type="button"
                            className="lll-btn lll-btn-primary"
                            disabled={busy}
                            onClick={() =>
                              void beginBattleRequest({
                                mode: "ladder",
                                tierIndex: battle.tierIndex + 1,
                                clearedBefore: profile.clearedTiers.includes(battle.tierIndex + 1),
                              })
                            }
                          >
                            次のティア（{TIERS[battle.tierIndex + 1].name}）へ
                          </button>
                          <button
                            type="button"
                            className="lll-btn"
                            disabled={busy}
                            onClick={() => void beginBattleRequest({ mode: "ladder", tierIndex: battle.tierIndex, clearedBefore: true })}
                          >
                            もう一度
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="lll-btn lll-btn-primary"
                          disabled={busy}
                          onClick={() =>
                            void beginBattleRequest({
                              mode: "ladder",
                              tierIndex: battle.tierIndex,
                              clearedBefore: profile.clearedTiers.includes(battle.tierIndex),
                            })
                          }
                        >
                          {guideBattle && battle.winner === "cpu" ? "もう一度（同じ相手）" : "もう一度"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="lll-btn"
                        onClick={() => {
                          setBattle(null);
                          setPending(null);
                          setAutoMode(false);
                          playSe("tap");
                        }}
                      >
                        出撃画面へ
                      </button>
                    </div>
                  </div>
                ) : displayBattle ? (
                  <div className="lll-actionbar lll-playbackbar">
                    <span className="lll-chip">
                      再生中 {playbackInfo ? playbackInfo.index + 1 : 1}/{playbackInfo?.total ?? ""}
                    </span>
                    <span className="lll-chip">タップで次の拍へ</span>
                    <button
                      type="button"
                      className="lll-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        finishPlayback();
                      }}
                    >
                      全表示
                    </button>
                  </div>
                ) : isPlayerTurn && currentActor ? (
                  <>
                    {battle.tactics && (
                      <div className="lll-tactics" aria-label="戦術カード">
                        <span className="lll-chip lll-chip-tp">TP {battle.tactics.player.tp} / 5</span>
                        <span className="lll-chip">
                          山札 {battle.tactics.player.deckCount} ・ 捨札 {battle.tactics.player.discard.length}
                        </span>
                        {battle.tactics.player.reserves.map((cardId, i) => (
                          <span key={`res-${cardId}-${i}`} className="lll-chip lll-chip-reserve">
                            設置中：{TACTIC_CARD_BY_ID.get(cardId)?.name ?? cardId}
                          </span>
                        ))}
                        <div className="lll-hand">
                          {battle.tactics.player.hand.length === 0 && <span className="lll-chip">手札なし（行動のみ）</span>}
                          {battle.tactics.player.hand.map((cardId, i) => {
                            const def = TACTIC_CARD_BY_ID.get(cardId);
                            if (!def) return null;
                            const unaffordable = def.cost > (battle.tactics?.player.tp ?? 0);
                            return (
                              <button
                                key={`${cardId}-${i}`}
                                type="button"
                                className="lll-tactic-btn"
                                disabled={busy || unaffordable}
                                title={def.text}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void sendTactic(cardId);
                                }}
                              >
                                <span className="lll-tactic-name">{def.name}</span>
                                <span className="lll-tactic-meta">
                                  {def.reserve ? "設置" : def.tags.join("・")} ・ TP{def.cost}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <span className="lll-tactics-hint">戦術カードは行動の前に TP の範囲で何枚でも使用可能。カード名にカーソルを合わせると効果を表示。</span>
                      </div>
                    )}
                    <div className="lll-actionbar">
                      <span className="lll-actionbar-label">
                        {currentStunned ? `${currentActor.name} はスタン中：戦術のみ使用可（下のボタンで手番終了）` : `${currentActor.name} の行動`}
                      </span>
                      {guideActive && <span className="lll-chip lll-chip-picked">ガイド中 あと{3 - guideTurnsUsed}手</span>}
                      <button
                        type="button"
                        className={`lll-btn${pending?.skill === "basic" ? " lll-btn-primary" : ""}${guideRecommendation?.skill === "basic" ? " lll-btn-guide" : ""}`}
                        disabled={busy}
                        onClick={() => chooseSkill("basic")}
                      >
                        通常攻撃
                      </button>
                      {([0, 1] as const).map((idx) => {
                        const skill = currentActor.skills[idx];
                        if (!skill) return null;
                        const cd = currentActor.cooldowns[idx] ?? 0;
                        return (
                          <button
                            key={idx}
                            type="button"
                            className={`lll-btn${pending?.skill === idx ? " lll-btn-primary" : ""}${guideRecommendation?.skill === idx ? " lll-btn-guide" : ""}`}
                            disabled={busy || cd > 0}
                            onClick={() => chooseSkill(idx)}
                            title={skill.description}
                          >
                            {skill.name}
                            <span className="lll-btn-meta">{cd > 0 ? `CD ${cd}` : `威力${skill.power}`}</span>
                          </button>
                        );
                      })}
                      {burstReady && (
                        <button
                          type="button"
                          className={`lll-btn lll-btn-burst${pending?.skill === "burst" ? " lll-btn-primary" : ""}`}
                          disabled={busy}
                          title={RESONANCE_BURST_INFO[currentActor.element].summary}
                          onClick={() => chooseSkill("burst")}
                        >
                          <IconBolt size={14} />
                          共鳴バースト：{RESONANCE_BURST_INFO[currentActor.element].name}
                        </button>
                      )}
                      <button type="button" className="lll-btn lll-btn-danger" disabled={busy} onClick={() => chooseSkill("defend")}>
                        <IconShield size={14} /> 防御
                      </button>
                      {pending && (
                        <>
                          <span className="lll-chip lll-chip-picked">{pending.label}: 対象を選択</span>
                          <button type="button" className="lll-btn" onClick={() => setPending(null)}>
                            やめる
                          </button>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="lll-loading">相手の行動中…</p>
                )}
              </div>
            )}
          </section>
        )}

        {/* ===== 図鑑・戦闘規則・ミッション ===== */}
        {tab === "codex" && (
          <LllCodexView
            profile={profile}
            teamCards={teamCards}
            busy={busy}
            onClaimMission={(kind, id) => void claimMission(kind, id)}
          />
        )}
      </main>

      {/* ===== カード詳細オーバーレイ（強化・管理 / 特性・技2調律） ===== */}
      {detailCard && (
        <div
          className="lll-overlay"
          role="dialog"
          aria-label={`${detailCard.name}の詳細`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDetailCardId(null);
          }}
        >
          <div className="lll-detail">
            <div style={{ width: "100%", maxWidth: 260 }}>
              {canUse3D ? (
                viewer3DForCard(detailCard, "inspect")
              ) : (
                <LllCard view={cardToView(detailCard, profile)} size="lg" />
              )}
            </div>
            <div className="lll-detail-info">
              <div className="lll-panel-head">
                <div className="lll-currencies">
                  <span className="lll-chip">{TIER_LABEL[detailCard.tier]}</span>
                  <span className="lll-chip">{ELEMENT_LABEL[detailCard.element]}</span>
                  <span className="lll-chip">戦力 {cardPowerScore(detailCard)}</span>
                  <span className="lll-chip">限界突破 +{detailCard.limitBreak ?? 0}/{MAX_LIMIT_BREAK}</span>
                </div>
                <div className="lll-seg" role="tablist" aria-label="カード詳細タブ">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailTab === "grow"}
                    className={`lll-seg-btn${detailTab === "grow" ? " lll-seg-active" : ""}`}
                    onClick={() => setDetailTab("grow")}
                  >
                    成長・管理
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailTab === "tune"}
                    className={`lll-seg-btn${detailTab === "tune" ? " lll-seg-active" : ""}`}
                    onClick={() => setDetailTab("tune")}
                  >
                    <IconTune size={13} /> 特性・技2調律
                  </button>
                </div>
              </div>

              {detailTab === "grow" ? (
                <>
                  <p className="lll-flavor-lg">{detailCard.flavor}</p>
                  <ul className="lll-detail-skills">
                    {detailCard.skills.map((skill, i) => (
                      <li key={`${skill.name}-${i}`}>
                        <strong>
                          技{i + 1}：{skill.name}
                        </strong>
                        <span>
                          威力{skill.power} ・ CD{skill.cooldown} ・ AP{skill.ap}
                        </span>
                        <p>{skill.description}</p>
                      </li>
                    ))}
                    <li>
                      <strong>特性：{detailCard.trait.name}</strong>
                      <p>{detailCard.trait.description}</p>
                    </li>
                  </ul>
                  <div className="lll-actions lll-detail-actions">
                    <button
                      type="button"
                      className="lll-btn lll-btn-primary"
                      disabled={busy || detailCard.level >= MAX_LEVEL || profile.shards < levelUpCost(detailCard.level)}
                      onClick={() => growCard(detailCard)}
                    >
                      {detailCard.level >= MAX_LEVEL ? "Lv MAX" : `強化（欠片 ${levelUpCost(detailCard.level)}）`}
                    </button>
                    <button
                      type="button"
                      className="lll-btn lll-btn-primary"
                      disabled={
                        busy ||
                        (detailCard.limitBreak ?? 0) >= MAX_LIMIT_BREAK ||
                        profile.shards < limitBreakCost(detailCard.limitBreak ?? 0)
                      }
                      onClick={() => limitBreakCard(detailCard)}
                    >
                      {(detailCard.limitBreak ?? 0) >= MAX_LIMIT_BREAK
                        ? "限界突破 MAX"
                        : `限界突破 +1（欠片 ${limitBreakCost(detailCard.limitBreak ?? 0)}）`}
                    </button>
                    {(() => {
                      const nTier = nextTier(detailCard.tier);
                      const cost = awakenCost(detailCard.tier);
                      if (!nTier || !cost) return null;
                      return (
                        <button
                          type="button"
                          className="lll-btn lll-btn-primary"
                          disabled={busy || profile.shards < cost.shards || profile.lumen < cost.lumen}
                          onClick={() => awakenCard(detailCard)}
                        >
                          {TIER_LABEL[nTier]}へ覚醒（欠片{cost.shards} / L{cost.lumen}）
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      className="lll-btn"
                      disabled={busy}
                      onClick={() => toggleLockCard(detailCard.id)}
                    >
                      <IconLock size={13} />
                      {profile.lockedCardIds?.includes(detailCard.id) ? "ロック解除" : "保護ロック"}
                    </button>
                    <button
                      type="button"
                      className="lll-btn"
                      disabled={busy || profile.favoriteCardId === detailCard.id}
                      onClick={() => setFavoriteCard(detailCard.id)}
                    >
                      <IconStar size={13} />
                      {profile.favoriteCardId === detailCard.id ? "主力表示中" : "主力に設定"}
                    </button>
                    {effectiveTeamIds.includes(detailCard.id) ? (
                      <button type="button" className="lll-btn lll-btn-danger" onClick={() => removeFromTeam(detailCard.id)}>
                        チームから外す
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="lll-btn"
                        disabled={effectiveTeamIds.length >= 3}
                        onClick={() => assignToSlot(detailCard.id, effectiveTeamIds.length)}
                      >
                        チームに入れる
                      </button>
                    )}
                    <button type="button" className="lll-btn" onClick={() => setDetailCardId(null)}>
                      閉じる
                    </button>
                  </div>
                </>
              ) : (
                <div className="lll-tune-panel">
                  <div className="lll-tune-block">
                    <div className="lll-panel-head">
                      <strong>特性の調律</strong>
                      <span className="lll-chip">
                        費用：欠片 {TUNE_TRAIT_COST.shards} / L {TUNE_TRAIT_COST.lumen}
                      </span>
                    </div>
                    <div className="lll-tune-grid">
                      {ALL_TRAIT_KINDS.map((kind) => {
                        const isCur = detailCard.trait.kind === kind;
                        const canAfford = profile.shards >= TUNE_TRAIT_COST.shards && profile.lumen >= TUNE_TRAIT_COST.lumen;
                        return (
                          <button
                            key={kind}
                            type="button"
                            className={`lll-tune-opt${isCur ? " lll-tune-opt-cur" : ""}`}
                            disabled={busy || isCur || !canAfford}
                            onClick={() => tuneTraitAction(detailCard.id, kind)}
                          >
                            <strong>
                              {TRAIT_DEFAULT_NAME[kind]}
                              {isCur ? "（現在）" : ""}
                            </strong>
                            <span>{TRAIT_DESCRIPTION[kind]}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="lll-tune-block">
                    <div className="lll-panel-head">
                      <strong>技2の種別調律</strong>
                      <span className="lll-chip">
                        費用：欠片 {TUNE_SKILL2_COST.shards} / L {TUNE_SKILL2_COST.lumen}
                      </span>
                    </div>
                    <div className="lll-tune-grid">
                      {TUNABLE_SKILL2_KINDS.map((kind) => {
                        const isCur = detailCard.skills[1]?.kind === kind;
                        const canAfford = profile.shards >= TUNE_SKILL2_COST.shards && profile.lumen >= TUNE_SKILL2_COST.lumen;
                        return (
                          <button
                            key={kind}
                            type="button"
                            className={`lll-tune-opt${isCur ? " lll-tune-opt-cur" : ""}`}
                            disabled={busy || isCur || !canAfford}
                            onClick={() => tuneSkill2Action(detailCard.id, kind)}
                          >
                            <strong>
                              {SKILL2_KIND_LABEL[kind]}
                              {isCur ? "（現在）" : ""}
                            </strong>
                            <span>{SKILL_DESCRIPTION[kind]}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="lll-actions lll-detail-actions">
                    <button type="button" className="lll-btn" onClick={() => setDetailCardId(null)}>
                      閉じる
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* モーダル群 */}
      {loginBonus && <LoginBonusModal bonus={loginBonus} onClose={() => setLoginBonus(null)} />}
      {showRates && <DropRatesModal onClose={() => setShowRates(false)} />}
      {showDeckModal && (
        <CustomDeckModal
          initialCounts={profile.customTacticDeck ?? {}}
          busy={busy}
          onSave={(counts) => void saveCustomDeck(counts)}
          onClose={() => setShowDeckModal(false)}
        />
      )}

      {/* 独立フッター（AGOBOT と同様に余白を確保し、設定・規則・離脱のみを整理配置） */}
      <footer className="lll-footer" aria-label="LLL フッター">
        <div className="lll-footer-inner">
          <div className="lll-footer-brand">
            <span className="lll-footer-logo">LLL</span>
            <p className="lll-footer-meta">
              調律者 {profile.playerName ?? "調律者"} ・ 総戦力 {teamPower} ・ 遺物 {ownedRelics.length}/{RELICS.length}
            </p>
            <div className="lll-footer-stats">
              <span>
                戦績 {profile.wins}勝 {profile.losses}敗
              </span>
              <span>Rate {profile.pvpRating ?? 1000}</span>
              <span>深淵 {profile.abyssBestFloor ?? 0}F</span>
              <span>所持 {profile.cards.length}/60</span>
            </div>
          </div>

          <div className="lll-footer-groups">
            <nav className="lll-footer-group" aria-label="規則・編成">
              <p className="lll-footer-group-title">規則・編成</p>
              <button type="button" className="lll-footer-link" onClick={() => switchTab("codex")}>
                戦闘規則・属性反応図鑑
              </button>
              <button type="button" className="lll-footer-link" onClick={() => setShowDeckModal(true)}>
                カスタム戦術デッキ（30枚）
              </button>
              <button type="button" className="lll-footer-link" onClick={() => setShowRates(true)}>
                提供割合・鑑定仕様
              </button>
            </nav>

            <nav className="lll-footer-group" aria-label="表示・サウンド">
              <p className="lll-footer-group-title">表示・サウンド</p>
              <button type="button" className="lll-footer-link" disabled={webglFailed} onClick={toggle3D}>
                3D表示：{canUse3D ? "ON" : "OFF"}
              </button>
              <button type="button" className="lll-footer-link" onClick={() => toggleSound("bgm")}>
                BGM：{sound.bgm ? "ON" : "OFF"}
              </button>
              <button type="button" className="lll-footer-link" onClick={() => toggleSound("se")}>
                効果音：{sound.se ? "ON" : "OFF"}
              </button>
            </nav>

            <nav className="lll-footer-group" aria-label="AGOBOT">
              <p className="lll-footer-group-title">AGOBOT</p>
              <Link className="lll-footer-link" href={`${prefix}/games`}>
                ゲーム一覧へ戻る
              </Link>
            </nav>
          </div>
        </div>

        <div className="lll-footer-bottom">
          <span>LLL — Loci / Lumen / Legacy</span>
          <span>連続ログイン {profile.loginStreak ?? 1}日目</span>
        </div>
      </footer>

      {/* モバイル専用コンパクトボトムナビ（760px 以下のみ表示） */}
      <nav className="lll-mobile-nav" aria-label="モバイルメニュー">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`lll-mobile-btn${tab === item.key ? " lll-mobile-active" : ""}`}
            aria-current={tab === item.key ? "page" : undefined}
            onClick={() => switchTab(item.key)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge && <span className="lll-mobile-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>

      {/* ドラッグ中の飛行体 */}
      {binderDrag && (
        <div className="lll-drag-clone" style={{ transform: `translate(${binderDrag.x + 10}px, ${binderDrag.y + 10}px)` }}>
          {binderDrag.name}
        </div>
      )}
      {battleDrag && (
        <div className="lll-drag-clone" style={{ transform: `translate(${battleDrag.x + 10}px, ${battleDrag.y + 10}px)` }}>
          通常攻撃
        </div>
      )}
    </div>
  );
}
