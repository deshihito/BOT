"use client";
// LLL クライアント。画像スカウト（特徴量抽出+鑑定）→ バインダー（3枚編成+強化）
// → アリーナ（3v3 ターン制、サーバー権威）の3ビューを1枚のダークな
// テーブル面の上で切り替える。セッションは匿名トークン方式で
// localStorage["lll-player-token"] に保持する（BALKU 流儀）。
// サウンドは lib/lll-sound（Web Audio 合成、並行実装中）の公開関数だけを使う。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadSoundSettings as loadSoundSettingsRaw,
  playSe as playSeRaw,
  saveSoundSettings as saveSoundSettingsRaw,
  startBgm as startBgmRaw,
  stopBgm as stopBgmRaw,
  unlockAudio,
} from "@/lib/lll-sound";
import LllCard, { TIER_LABEL, type LllCardView } from "./LllCard";
import { buildPlaybackSteps, stepDurationMs, type PlaybackStep } from "@/lib/lll-playback";
import { TACTIC_CARD_BY_ID, TACTIC_DECKS } from "@/lib/lll-tactics";

/* --- サウンド（公開関数の型は並行実装側に合わせ、ここでは薄く包む） --- */
type SoundSettings = { bgm: boolean; se: boolean };
const loadSoundSettings = loadSoundSettingsRaw as unknown as () => SoundSettings;
const saveSoundSettings = saveSoundSettingsRaw as unknown as (s: SoundSettings) => void;
const startBgm = startBgmRaw as unknown as () => void;
const stopBgm = stopBgmRaw as unknown as () => void;
function playSe(name: string): void {
  try {
    (playSeRaw as unknown as (n: string) => void)(name);
  } catch {
    // 音が出なくてもゲームは止めない
  }
}

/* --- API 契約の型（サーバー JSON と一致させる） --- */
type Skill = { name: string; kind: string; power: number; cooldown: number; ap: number; description: string };
type CardT = {
  id: string;
  name: string;
  flavor: string;
  element: LllCardView["element"];
  tier: LllCardView["tier"];
  stats: { hp: number; atk: number; def: number; spd: number };
  skills: Skill[];
  trait: { name: string; kind: string; description: string };
  imageDataUrl?: string;
  glyph?: string;
  level: number;
};
type Profile = {
  token?: string;
  cards: CardT[];
  teamIds: string[];
  shards: number;
  lumen: number;
  clearedTiers: number[];
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  tacticDeckId?: string;
};
/** 戦術カード層の表示用ビュー（サーバーの publicBattle がマスクした形）。 */
type TacticSideView = {
  hand: string[];
  handCount?: number;
  deckCount: number;
  discard: string[];
  tp: number;
  reserves: string[];
  reserveCount?: number;
};
type TacticsView = {
  player: TacticSideView;
  cpu: TacticSideView;
  turn: { actorKey: string; cardsPlayed: number; dmgCount: number };
};
type BattleActor = {
  key: string;
  side: "player" | "cpu";
  name: string;
  element: LllCardView["element"];
  tier: LllCardView["tier"];
  level: number;
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
};
type BattleLog = {
  type: string;
  text: string;
  actorKey?: string;
  targetKey?: string;
  amount?: number;
  hpAfter?: number;
  shieldAfter?: number;
  affinity?: number;
  statusKind?: string;
};
type Battle = {
  id: string;
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
type AppraiseResult = { card: CardT | null; duplicated: boolean; shardsGained: number; aiUsed: boolean };
// サーバー（lll-server parseFeatures）の検証に合わせ、数値フィールドのみで送る。
// 画素ハッシュはサーバーが画像バイト列の SHA-256 から決定的に導出する（仕様 §2）。
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

/* --- 正規化（所持カード / バトルアクター → 統一カード表示） --- */
function cardToView(card: CardT): LllCardView {
  return {
    id: card.id,
    name: card.name,
    flavor: card.flavor,
    element: card.element,
    tier: card.tier,
    level: card.level,
    glyph: card.glyph,
    imageDataUrl: card.imageDataUrl,
    hp: card.stats.hp,
    maxHp: card.stats.hp,
    atk: card.stats.atk,
    def: card.stats.def,
    spd: card.stats.spd,
    skills: card.skills,
    trait: card.trait,
  };
}
function actorToView(actor: BattleActor): LllCardView {
  return {
    id: actor.key,
    name: actor.name,
    element: actor.element,
    tier: actor.tier,
    level: actor.level,
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
  // 長辺 512px に縮小して JPEG 化（カードアートとして保持する data URL）。
  // サーバー上限（data URL 400,000文字）に収まるよう段階的に落とす。
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

  // 特徴量は 48x48 のサンプル面で抽出する
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
    // 色相（円平均で赤の折り返しを避ける）
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
  const variance = Math.sqrt(varSum / count); // 明度の標準偏差 0..1
  // エッジ複雑度: 右隣との明度差の平均
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

type Tab = "scout" | "binder" | "arena";
type PendingSkill = { skill: 0 | 1 | "basic" | "defend"; targetSide: "player" | "cpu" | null; label: string };
type FloatNum = { id: number; targetKey: string; text: string; kind: string };
type SpeedMode = "1x" | "2x" | "instant";
const SPEED_KEY = "lll-battle-speed";
const TUTORIAL_KEY = "lll-tutorial-battle";

export default function LllClient() {
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>("scout");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState<SoundSettings>({ bgm: true, se: true });
  // スカウト
  const [dragOver, setDragOver] = useState(false);
  const [appraising, setAppraising] = useState(false);
  const [result, setResult] = useState<AppraiseResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // バインダー
  // サーバーの /team は「3枚の異なるカード」ちょうどの編成だけを受け付けるため、
  // 3枚未満の編成変更（外す/入れ替え途中）は pendingTeam として手元に保持し、
  // 3枚そろった時点で初めて POST する。
  const [pendingTeam, setPendingTeam] = useState<string[] | null>(null);
  const [pickedCardId, setPickedCardId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [binderDrag, setBinderDrag] = useState<{ cardId: string; x: number; y: number; name: string } | null>(null);
  const [hotSlot, setHotSlot] = useState<number | null>(null);
  const teamSlotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const binderTrackRef = useRef<{ cardId: string; name: string; startX: number; startY: number; active: boolean } | null>(null);
  // アリーナ
  const [selectedTier, setSelectedTier] = useState(0);
  const [selectedDeck, setSelectedDeck] = useState<string>("chain");
  const [battle, setBattle] = useState<Battle | null>(null);
  const [pending, setPending] = useState<PendingSkill | null>(null);
  const [hitKeys, setHitKeys] = useState<Record<string, true>>({});
  const [floats, setFloats] = useState<FloatNum[]>([]);
  const battleRef = useRef<Battle | null>(null);
  battleRef.current = battle;
  const battleStartRef = useRef<{ shards: number; lumen: number; clearedBefore: boolean } | null>(null);
  const finishSeRef = useRef<string | null>(null);
  const floatIdRef = useRef(0);
  const battleTrackRef = useRef<{ actorKey: string; startX: number; startY: number; active: boolean } | null>(null);
  const [battleDrag, setBattleDrag] = useState<{ actorKey: string; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  // 逐次再生（1イベント=1拍）。displayBattle が表示中の間は入力をロックする
  const [displayBattle, setDisplayBattle] = useState<Battle | null>(null);
  const [speed, setSpeed] = useState<SpeedMode>("1x");
  const speedRef = useRef<SpeedMode>("1x");
  const playbackRef = useRef<{ steps: PlaybackStep[]; index: number; next: Battle; nextProfile: Profile | null; prevLogLength: number } | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<{ index: number; total: number; actorKey: string | null } | null>(null);
  const [lungeKey, setLungeKey] = useState<string | null>(null);
  const [shieldFlashKeys, setShieldFlashKeys] = useState<Record<string, true>>({});
  // 初回ガイド戦（戦績0の Tier0 初戦、最初の3手だけ）
  const [guideBattle, setGuideBattle] = useState(false);
  const guideBattleRef = useRef(false);
  const [guideTurnsUsed, setGuideTurnsUsed] = useState(0);
  const guideTurnsUsedRef = useRef(0);

  // 戦術デッキの選択はプロフィール保存値に追随する（対戦開始時にサーバーへ送る）
  useEffect(() => {
    if (profile?.tacticDeckId && profile.tacticDeckId in TACTIC_DECKS) {
      setSelectedDeck(profile.tacticDeckId);
    }
  }, [profile?.tacticDeckId]);

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
        // 保存が無くても新規発行される
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
          // 保存できなくても今回のセッションでは遊べる
        }
        setToken(nextToken);
        setProfile(nextProfile);
      } catch {
        if (!cancelled) setError("接続できませんでした。ページを再読み込みしてください。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postJson]);

  /* --- サウンド初期化 --- */
  useEffect(() => {
    try {
      setSound(loadSoundSettings());
    } catch {
      // 既定値のまま
    }
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  /* --- 逐次再生タイマーの後片付け --- */
  useEffect(() => {
    return () => {
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    };
  }, []);

  /* --- 再生速度の読み込み --- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SPEED_KEY);
      if (raw === "2x" || raw === "instant" || raw === "1x") {
        setSpeed(raw);
        speedRef.current = raw;
      }
    } catch {
      // 既定の1倍のまま
    }
  }, []);

  const changeSpeed = (next: SpeedMode) => {
    setSpeed(next);
    speedRef.current = next;
    try {
      localStorage.setItem(SPEED_KEY, next);
    } catch {
      // 保存できなくても今回の対戦では有効
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
      // 保存に失敗しても切り替え自体は続ける
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

  /* --- スカウト --- */
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
    playSe("flip");
    try {
      const { imageDataUrl, features } = await processImage(file);
      // 裏面フリップ（約900ms）と鑑定リクエストを並行させ、両方揃ってから開ける
      const flipWait = new Promise((resolve) => setTimeout(resolve, 900));
      const [api] = await Promise.all([
        postJson("/api/lll/appraise", { token, features, imageDataUrl }),
        flipWait,
      ]);
      if (!api.res.ok) {
        setError(typeof api.data.error === "string" ? api.data.error : "鑑定できませんでした。");
        playSe("error");
        return;
      }
      const nextProfile = api.data.profile as Profile;
      const nextResult: AppraiseResult = {
        card: (api.data.card as CardT | null) ?? null,
        duplicated: api.data.duplicated === true,
        shardsGained: typeof api.data.shardsGained === "number" ? api.data.shardsGained : 0,
        aiUsed: api.data.aiUsed === true,
      };
      setProfile(nextProfile);
      setResult(nextResult);
      if (nextResult.duplicated) playSe("coin");
      else if (nextResult.card?.tier === "legend") playSe("win");
      else playSe("stamp");
    } catch {
      setError("鑑定に失敗しました。別の画像で試してください。");
      playSe("error");
    } finally {
      setAppraising(false);
    }
  };

  /* --- バインダー: チーム編成 --- */
  const effectiveTeamIds: string[] = pendingTeam ?? profile?.teamIds ?? [];
  const saveTeam = async (teamIds: string[]) => {
    if (!token || !profile) return;
    if (teamIds.length !== 3 || new Set(teamIds).size !== 3) {
      // 3枚そろうまではサーバーへ送らず、手元の編成として保持する
      setPendingTeam(teamIds);
      return;
    }
    const prevProfile = profile;
    setProfile({ ...profile, teamIds }); // 楽観的に先に反映する
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
    // 外す操作は3枚未満になるため即POSTせず、再編成が3枚そろうまで手元保持
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

  // バインダーのポインタドラッグ（タップ操作はフォールバックとして全て残す）
  const binderDragHandlers = (card: CardT) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== undefined && e.button > 0) return;
      binderTrackRef.current = { cardId: card.id, name: card.name, startX: e.clientX, startY: e.clientY, active: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // キャプチャできなくても要素上で追える
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

  const tapCollectionCard = (card: CardT) => {
    if (suppressClickRef.current) return;
    if (pickedCardId === card.id) {
      // 2回目のタップで詳細を開く
      setDetailCardId(card.id);
      playSe("tap");
      return;
    }
    setPickedCardId(card.id);
    playSe("tap");
  };

  /* --- 強化 / 両替 --- */
  const growCard = async (card: CardT) => {
    if (!token || busy || card.level >= 10) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/grow", { token, cardId: card.id });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "強化できませんでした。");
        playSe("error");
        return;
      }
      setProfile(data.profile as Profile);
      playSe("levelup");
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const exchangeLumen = async () => {
    if (!token || busy || !profile || profile.lumen < 50) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/lll/grow", { token, action: "exchange" });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "両替できませんでした。");
        playSe("error");
        return;
      }
      setProfile(data.profile as Profile);
      playSe("coin");
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  /* --- アリーナ --- */
  const maxCleared = profile ? profile.clearedTiers.reduce((m, t) => Math.max(m, t), -1) : -1;

  const startBattle = async (tierIndex: number) => {
    if (!token || !profile || busy) return;
    setBusy(true);
    setError("");
    setPending(null);
    stopPlayback();
    battleStartRef.current = { shards: profile.shards, lumen: profile.lumen, clearedBefore: profile.clearedTiers.includes(tierIndex) };
    // ガイド戦の判定: 戦績が全て0で、まだガイドを終えていないプレイヤーの Tier0 初戦だけ
    let tutorialDone = false;
    try {
      tutorialDone = localStorage.getItem(TUTORIAL_KEY) === "done";
    } catch {
      // 読めなければガイドなし扱いにしない（戦績0の判定が残る）
    }
    const isGuide = tierIndex === 0 && profile.wins + profile.losses + profile.draws === 0 && !tutorialDone;
    guideBattleRef.current = isGuide;
    setGuideBattle(isGuide);
    guideTurnsUsedRef.current = 0;
    setGuideTurnsUsed(0);
    try {
      const { res, data } = await postJson("/api/lll/battle/start", { token, tierIndex, tacticDeckId: selectedDeck });
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
  };

  /** 再生を終え、サーバーの最終状態と報酬をそのまま反映する。 */
  const finishPlayback = useCallback(() => {
    const pb = playbackRef.current;
    clearPlaybackTimer();
    playbackRef.current = null;
    setPlaybackInfo(null);
    setDisplayBattle(null);
    setLungeKey(null);
    if (!pb) return;
    setBattle(pb.next);
    if (pb.nextProfile) setProfile(pb.nextProfile);
  }, []);

  /** step を1拍ぶん表示する（数字・シェイク・SE・振動はこのタイミングで発火）。 */
  const showPlaybackStep = useCallback((index: number) => {
    const pb = playbackRef.current;
    if (!pb) return;
    if (index >= pb.steps.length) {
      finishPlayback();
      return;
    }
    const step = pb.steps[index];
    pb.index = index;
    setPlaybackInfo({ index, total: pb.steps.length, actorKey: step.event.actorKey ?? step.event.targetKey ?? null });
    // 表示状態: アクターはステップ適用後、ログはこのイベントまで、phase は再生中は battle 固定
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
            // CD と防御表示はこのイベント列では追わない（最終状態で確定する）
            cooldowns: (base.actors.find((a) => a.key === nextActor.key)?.cooldowns ?? nextActor.cooldowns) as number[],
            defending: base.actors.find((a) => a.key === nextActor.key)?.defending ?? nextActor.defending,
          };
        }),
        log: [...(battleRef.current?.log ?? []), ...pb.next.log.slice(pb.prevLogLength, pb.prevLogLength + index + 1)],
      };
    });
    // 攻撃側の前進（info の技宣言と damage の着弾で出す）
    const attackerKey = step.event.actorKey;
    if (attackerKey && (step.event.type === "damage" || step.event.type === "info")) {
      setLungeKey(attackerKey);
      setTimeout(() => setLungeKey((k) => (k === attackerKey ? null : k)), 260);
    }
    // 被弾シェイク
    if (step.float && (step.event.type === "damage" || step.event.type === "trait" || step.event.type === "status") && step.float.targetKey) {
      const key = step.float.targetKey;
      setHitKeys({ [key]: true });
      setTimeout(() => setHitKeys((h) => (h[key] ? {} : h)), 480);
    }
    // シールド/防御バッジの点滅
    if (step.shieldFlashKey) {
      const key = step.shieldFlashKey;
      setShieldFlashKeys({ [key]: true });
      setTimeout(() => setShieldFlashKeys((h) => (h[key] ? {} : h)), 380);
    }
    // フロート（数字・状態名・撃破）
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
        // 振動できない環境では何もしない
      }
    }
    const dur = speedRef.current === "2x" ? stepDurationMs(step, "2x") : step.durationMs;
    playbackTimerRef.current = setTimeout(() => showPlaybackStep(index + 1), dur);
  }, [finishPlayback]);

  /** 盤面タップ: 現在の拍を即時完了して次の拍へ進める。 */
  const advancePlayback = () => {
    const pb = playbackRef.current;
    if (!pb) return;
    clearPlaybackTimer();
    showPlaybackStep(pb.index + 1);
  };

  /** 前状態→次状態をイベント単位で再生する。再生しない場合は false。 */
  const startPlayback = (prev: Battle, next: Battle, nextProfile: Profile | null): boolean => {
    if (speedRef.current === "instant") return false;
    const newEvents = next.log.slice(prev.log.length);
    if (newEvents.length < 2) return false;
    const steps = buildPlaybackSteps(prev.actors, newEvents);
    if (steps.length < 2) return false;
    playbackRef.current = { steps, index: 0, next, nextProfile, prevLogLength: prev.log.length };
    showPlaybackStep(0);
    return true;
  };

  /** 新しいバトル状態に対して被弾シェイクとダメージ数字を付ける（一斉表示モード用）。 */
  const applyBattleFx = (prev: Battle | null, next: Battle) => {
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
    }
    if (newFloats.length > 0) {
      setFloats((f) => [...f.slice(-8), ...newFloats]);
      const ids = newFloats.map((f) => f.id);
      setTimeout(() => setFloats((f) => f.filter((x) => !ids.includes(x.id))), 950);
    }
  };

  const sendAction = async (action: { skill: 0 | 1 | "basic" | "defend"; targetKey?: string }) => {
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
      // 契約フィールド（skill/targetKey）に加え、サーバー検証が要求する type も併記する
      const actionPayload = {
        type: action.skill === "basic" ? "basic" : action.skill === "defend" ? "defend" : "skill",
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
      // 逐次再生が始まったら、最終状態と報酬は再生完了時に反映する
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

  /** 戦術カードのプレイ。手番は進まないので、再生後に同じアクターの戦術フェイズが続く。 */
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

  const chooseSkill = (skill: 0 | 1 | "basic" | "defend") => {
    if (!currentActor || !isPlayerTurn || busy || playbackRef.current) return;
    playSe("tap");
    if (skill === "defend") {
      void sendAction({ skill: "defend" });
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

  // 現在アクターを敵へドラッグ → 通常攻撃（タップ列の代替導線）
  const battleDragHandlers = (actor: BattleActor) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!isPlayerTurn || busy || playbackRef.current || actor.key !== currentActor?.key || e.button > 0) return;
      battleTrackRef.current = { actorKey: actor.key, startX: e.clientX, startY: e.clientY, active: false };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // キャプチャできなくても追える
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

  // 終局SE（勝ち/負け/引分を一度だけ）
  useEffect(() => {
    if (!battle || battle.phase !== "finished") return;
    if (finishSeRef.current === battle.id) return;
    finishSeRef.current = battle.id;
    playSe(battle.winner === "player" ? "win" : battle.winner === "draw" ? "click" : "lose");
    if (guideBattleRef.current) {
      guideBattleRef.current = false;
      try {
        localStorage.setItem(TUTORIAL_KEY, "done");
      } catch {
        // 保存できなくても戦績が付くため、次回は戦績判定でガイド対象から外れる
      }
    }
  }, [battle]);

  /* --- 描画部品 --- */
  const detailCard = detailCardId ? profile?.cards.find((c) => c.id === detailCardId) ?? null : null;

  // ガイド戦の推奨手（最初の3手だけ）: 回復が要る味方がいれば回復技、
  // なければ使用可能な最大威力の攻撃技、どちらも無ければ通常攻撃。
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

  const renderActor = (actor: BattleActor) => {
    const targetable = !!pending && pending.targetSide === actor.side && actor.alive && isPlayerTurn && !displayBattle;
    const guideTarget = !!pending && guideRecommendation?.skill === pending.skill && guideRecommendation?.targetKey === actor.key;
    return (
      <div key={actor.key} className="lll-actor-wrap">
        <LllCard
          view={actorToView(actor)}
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
      <div className="lll-table">
        <p className="lll-loading">読み込み中…</p>
        {error && (
          <p className="lll-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const teamCards = effectiveTeamIds
    .map((id) => profile.cards.find((c) => c.id === id))
    .filter((c): c is CardT => !!c);
  const scoutCue = profile.cards.length <= 3;
  const shownBattle = displayBattle ?? battle;
  // 結果画面の戦績3項目（バトルログのイベント集計）
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

  return (
    <div className="lll-table">
      {/* ヘッダーストリップ（タイトル/通貨/サウンド/タブは全てテーブルの上） */}
      <div className="lll-head">
        <div className="lll-title-group">
          <span className="lll-logo">LLL</span>
          <span className="lll-hero">想像を、切り札に。</span>
        </div>
        <div className="lll-currencies">
          <span className="lll-chip lll-chip-shards">◆ 欠片 {profile.shards}</span>
          <span className="lll-chip lll-chip-lumen">● ルーメン {profile.lumen}</span>
        </div>
        <div className="lll-soundbar" role="group" aria-label="サウンド設定">
          <button
            type="button"
            className={`lll-snd-btn${sound.bgm ? " lll-snd-on" : ""}`}
            aria-pressed={sound.bgm}
            onClick={() => toggleSound("bgm")}
          >
            ♪ BGM {sound.bgm ? "ON" : "OFF"}
          </button>
          <button
            type="button"
            className={`lll-snd-btn${sound.se ? " lll-snd-on" : ""}`}
            aria-pressed={sound.se}
            onClick={() => toggleSound("se")}
          >
            SE {sound.se ? "ON" : "OFF"}
          </button>
        </div>
      </div>
      <nav className="lll-tabs" aria-label="ビュー切替">
        {(
          [
            ["scout", "🔍 スカウト"],
            ["binder", "🗂 バインダー"],
            ["arena", "⚔ アリーナ"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`lll-tab${tab === key ? " lll-tab-active" : ""}`}
            aria-pressed={tab === key}
            onClick={() => switchTab(key)}
          >
            {label}
            {key === "arena" && battle?.phase === "battle" ? " ●" : ""}
          </button>
        ))}
      </nav>
      {error && (
        <p className="lll-error" role="alert">
          {error}
        </p>
      )}

      {/* ===== スカウト ===== */}
      {tab === "scout" && (
        <section className="lll-scout">
          {scoutCue && !appraising && !result && (
            <ol className="lll-cue" aria-label="はじめの3ステップ">
              <li className="lll-cue-active">1 画像を置く</li>
              <li>2 鑑定</li>
              <li>3 切り札完成</li>
            </ol>
          )}
          {appraising ? (
            <div className="lll-flip-wrap" aria-live="polite">
              <div className="lll-cardback-flip">
                <span>✦</span>
                <span className="lll-cardback-logo">LLL</span>
              </div>
              <p className="lll-appraising">鑑定中…</p>
            </div>
          ) : result ? (
            <div className="lll-reveal">
              {result.duplicated || !result.card ? (
                <div className="lll-dup-box">
                  <span className="lll-stamp lll-stamp-dup">重複</span>
                  <p className="lll-dup-text">見覚えのある1枚だった。</p>
                  <span className="lll-chip lll-chip-shards">◆ 欠片 +{result.shardsGained}</span>
                </div>
              ) : (
                <div className="lll-reveal-card">
                  <LllCard view={cardToView(result.card)} size="lg" />
                  <span className={`lll-stamp lll-stamp-${result.card.tier}`}>{TIER_LABEL[result.card.tier]}</span>
                  {result.card.tier === "legend" && <span className="lll-legend-flash" aria-hidden="true" />}
                </div>
              )}
              {!result.duplicated && result.card && (
                <span className="lll-chip">{result.aiUsed ? "AI鑑定" : "自動鑑定"}</span>
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
                  もう一度スカウト
                </button>
                {result.card && (
                  <button type="button" className="lll-btn" onClick={() => switchTab("binder")}>
                    バインダーで編成
                  </button>
                )}
              </div>
            </div>
          ) : (
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
                ✦
              </span>
              <span className="lll-dropzone-label">画像をここにドロップ</span>
              <span className="lll-dropzone-sub">タップで選択もできます</span>
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

      {/* ===== バインダー ===== */}
      {tab === "binder" && (
        <section className="lll-binder">
          <div className="lll-binder-head">
            <span className="lll-chip">チーム {teamCards.length}/3</span>
            {pendingTeam && <span className="lll-chip lll-chip-picked">編成中：あと{3 - pendingTeam.length}枚で確定</span>}
            <span className="lll-chip">所持 {profile.cards.length}/60</span>
            {pickedCardId && <span className="lll-chip lll-chip-picked">置くスロットを選んでください（もう一度タップで詳細）</span>}
            <button type="button" className="lll-btn lll-btn-exchange" onClick={() => void exchangeLumen()} disabled={busy || profile.lumen < 50}>
              ルーメン両替 50 → 欠片5
            </button>
          </div>
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
                    <LllCard view={cardToView(card)} size="md" onClick={() => setDetailCardId(card.id)}>
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
          <div className="lll-collection">
            {profile.cards.map((card) => {
              const inTeam = effectiveTeamIds.includes(card.id);
              return (
                <LllCard
                  key={card.id}
                  view={cardToView(card)}
                  size="sm"
                  selected={pickedCardId === card.id}
                  dimmed={inTeam}
                  draggableClass
                  onClick={() => tapCollectionCard(card)}
                  {...binderDragHandlers(card)}
                >
                  {inTeam && <span className="lll-team-badge">チーム内</span>}
                </LllCard>
              );
            })}
          </div>
        </section>
      )}

      {/* ===== アリーナ ===== */}
      {tab === "arena" && (
        <section className="lll-arena">
          {!battle ? (
            <>
              <div className="lll-binder-head">
                <span className="lll-chip">⚔ {profile.wins}勝</span>
                <span className="lll-chip">敗北 {profile.losses}</span>
                <span className="lll-chip">引分 {profile.draws}</span>
                <span className="lll-chip">チーム {teamCards.length}/3</span>
              </div>
              <div className="lll-ladder">
                {TIERS.map((tier, i) => {
                  const unlocked = i <= maxCleared + 1;
                  const cleared = profile.clearedTiers.includes(i);
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
                        {cleared && <span className="lll-tier-clear">✓ クリア</span>}
                        {!unlocked && <span aria-hidden="true"> 🔒</span>}
                      </span>
                      <span className="lll-tier-meta">敵 Lv{tier.enemyLv}</span>
                      <span className="lll-tier-reward">
                        勝利 ◆{tier.winShards} / ●{tier.winLumen}
                        {cleared ? "" : "（初回2倍）"} ・ 敗北 ◆{tier.loseShards}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="lll-deckpick" role="group" aria-label="戦術デッキ">
                <span className="lll-actionbar-label">戦術デッキ（30枚）</span>
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
                <p className="lll-deck-note">
                  対戦中は各アクターの行動前に戦術カードを切れる。手札4枚で始まり、ラウンドごとに2枚引いて TP は5に戻る（Tier4以上の敵も戦術デッキを持つ）。
                </p>
              </div>
              <div className="lll-actions">
                <button
                  type="button"
                  className="lll-btn lll-btn-primary lll-btn-big"
                  disabled={busy || teamCards.length < 3}
                  onClick={() => void startBattle(selectedTier)}
                >
                  対戦開始
                </button>
                {teamCards.length < 3 && <span className="lll-chip">バインダーで3枚編成してください</span>}
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
                <span className="lll-chip lll-chip-enemy">CPU ・ {TIERS[battle.tierIndex]?.name ?? ""}</span>
                {battle.tactics && battle.tactics.cpu.deckCount + (battle.tactics.cpu.handCount ?? 0) > 0 && (
                  <span className="lll-chip">
                    CPU 手札 {battle.tactics.cpu.handCount ?? 0} ・ 山札 {battle.tactics.cpu.deckCount}
                    {(battle.tactics.cpu.reserveCount ?? 0) > 0 ? ` ・ 設置 ${battle.tactics.cpu.reserveCount}` : ""}
                  </span>
                )}
                <div className="lll-speedbar" role="group" aria-label="再生速度">
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
              <div className="lll-battle-row">{(shownBattle ?? battle).actors.filter((a) => a.side === "cpu").map(renderActor)}</div>
              <div className="lll-queue" aria-label="行動順">
                {(shownBattle ?? battle).queue.map((key, i) => {
                  const actor = (shownBattle ?? battle).actors.find((a) => a.key === key);
                  if (!actor) return null;
                  const nowKey = displayBattle
                    ? (playbackInfo?.actorKey ?? key)
                    : (shownBattle ?? battle).queue[(shownBattle ?? battle).queuePos];
                  const done = !displayBattle && i < (shownBattle ?? battle).queuePos;
                  return (
                    <span key={`${key}-${i}`} className={`lll-queue-chip${key === nowKey ? " lll-queue-chip-now" : ""}${done ? " lll-queue-chip-done" : ""}${actor.alive ? "" : " lll-queue-chip-dead"}`}>
                      {actor.name}
                    </span>
                  );
                })}
              </div>
              <div className="lll-logstrip" aria-live="polite">
                <span className="lll-chip">R{(shownBattle ?? battle).round}</span>
                {[...(shownBattle ?? battle).log].slice(-3).reverse().map((entry, i) => (
                  <p key={`${(shownBattle ?? battle).log.length}-${i}`} className={`lll-logline${i === 0 ? " lll-logline-latest" : ""}`}>
                    {entry.text}
                  </p>
                ))}
                {(shownBattle ?? battle).log.length === 0 && <p className="lll-logline">対戦開始</p>}
              </div>
              <div className="lll-battle-row">{(shownBattle ?? battle).actors.filter((a) => a.side === "player").map(renderActor)}</div>

              {battle.phase === "finished" ? (
                <div className="lll-result">
                  <span className={`lll-result-stamp lll-result-${battle.winner === "player" ? "win" : battle.winner === "draw" ? "draw" : "lose"}`}>
                    {battle.winner === "player" ? "勝利" : battle.winner === "draw" ? "引分" : "敗北"}
                  </span>
                  {battleStartRef.current && (
                    <div className="lll-currencies">
                      {profile.shards - battleStartRef.current.shards !== 0 && (
                        <span className="lll-chip lll-chip-shards">◆ 欠片 +{profile.shards - battleStartRef.current.shards}</span>
                      )}
                      {profile.lumen - battleStartRef.current.lumen !== 0 && (
                        <span className="lll-chip lll-chip-lumen">● ルーメン +{profile.lumen - battleStartRef.current.lumen}</span>
                      )}
                    </div>
                  )}
                  {battleRecap && battleRecap.totalDamage > 0 && (
                    <div className="lll-currencies" aria-label="戦績">
                      <span className="lll-chip">与ダメージ {battleRecap.totalDamage}</span>
                      {battleRecap.maxHit > 0 && <span className="lll-chip">最大の一撃 {battleRecap.maxHitLabel} {battleRecap.maxHit}</span>}
                      {battleRecap.mvp && <span className="lll-chip">最もダメージを出したカード {battleRecap.mvp.name}（{battleRecap.mvp.total}）</span>}
                    </div>
                  )}
                  <div className="lll-actions">
                    {battle.winner === "player" && battleStartRef.current && !battleStartRef.current.clearedBefore && battle.tierIndex < TIERS.length - 1 ? (
                      <>
                        <button type="button" className="lll-btn lll-btn-primary" disabled={busy} onClick={() => void startBattle(battle.tierIndex + 1)}>
                          次のティア（{TIERS[battle.tierIndex + 1].name}）へ
                        </button>
                        <button type="button" className="lll-btn" disabled={busy} onClick={() => void startBattle(battle.tierIndex)}>
                          もう一度
                        </button>
                      </>
                    ) : (
                      <button type="button" className="lll-btn lll-btn-primary" disabled={busy} onClick={() => void startBattle(battle.tierIndex)}>
                        {guideBattle && battle.winner === "cpu" ? "もう一度（同じ相手）" : "もう一度"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="lll-btn"
                      onClick={() => {
                        setBattle(null);
                        setPending(null);
                        playSe("tap");
                      }}
                    >
                      アリーナへ
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
                    <span className="lll-chip">山札 {battle.tactics.player.deckCount} ・ 捨札 {battle.tactics.player.discard.length}</span>
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
                    <span className="lll-tactics-hint">戦術カードは行動の前に何枚でも切れる（TP の範囲で）。カード名に触れると効果文が出る。</span>
                  </div>
                )}
                <div className="lll-actionbar">
                  <span className="lll-actionbar-label">
                    {currentStunned ? `${currentActor.name} はスタン中：戦術のみ使える（下のボタンは手番を渡す）` : `${currentActor.name} の行動`}
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
                  <button type="button" className="lll-btn lll-btn-danger" disabled={busy} onClick={() => chooseSkill("defend")}>
                    防御
                  </button>
                  {pending && (
                    <>
                      <span className="lll-chip lll-chip-picked">{pending.label}: 対象を選んでください</span>
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

      {/* ===== 詳細オーバーレイ（テーブルの上に開く） ===== */}
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
            <LllCard view={cardToView(detailCard)} size="lg" />
            <div className="lll-detail-info">
              <p className="lll-flavor-lg">{detailCard.flavor}</p>
              <ul className="lll-detail-skills">
                {detailCard.skills.map((skill, i) => (
                  <li key={`${skill.name}-${i}`}>
                    <strong>{skill.name}</strong>
                    <span>
                      威力{skill.power} ・ CD{skill.cooldown} ・ AP{skill.ap}
                    </span>
                    <p>{skill.description}</p>
                  </li>
                ))}
                <li>
                  <strong>✦ {detailCard.trait.name}</strong>
                  <p>{detailCard.trait.description}</p>
                </li>
              </ul>
              <div className="lll-actions lll-detail-actions">
                <button
                  type="button"
                  className="lll-btn lll-btn-primary"
                  disabled={busy || detailCard.level >= 10 || profile.shards < 8 * detailCard.level}
                  onClick={() => void growCard(detailCard)}
                >
                  {detailCard.level >= 10 ? "Lv MAX" : `強化（欠片 ${8 * detailCard.level}）`}
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
            </div>
          </div>
        </div>
      )}

      {/* ドラッグ中の飛行体 */}
      {binderDrag && (
        <div className="lll-drag-clone" style={{ transform: `translate(${binderDrag.x + 10}px, ${binderDrag.y + 10}px)` }}>
          {binderDrag.name}
        </div>
      )}
      {battleDrag && (
        <div className="lll-drag-clone" style={{ transform: `translate(${battleDrag.x + 10}px, ${battleDrag.y + 10}px)` }}>
          ⚔ 通常攻撃
        </div>
      )}
    </div>
  );
}
