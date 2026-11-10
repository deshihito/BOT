"use client";
// BALKU オンライン対戦クライアント。ルーム作成・参加は REST、同期は
// SSE（GET /api/balku/rooms/[code]/events）が主経路で、接続できない
// 環境では1秒間隔ポーリングに自動フォールバックする。手番タイマーと
// オークション期限はローカルで再計算して表示する。
// セッション（ルームコードとプレイヤートークン）は sessionStorage の
// "balku-room-session" に保存し、再訪時に復帰を試みる。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MARKET_MATERIALS,
  TARGETED_EFFECTS,
  getMarketPrice,
  getTotalPoints,
  isLegalSubmission,
  scoreBreakdown,
  selectLegalMaterials,
  type BalkuSnapshot,
  type GameAction,
  type MaterialCard,
  type MaterialKind,
  type ProjectCard,
  type SnapshotPlayer,
  type SnapshotSubmission,
} from "@/lib/balku-game";
import {
  loadSoundSettings,
  playSe,
  saveSoundSettings,
  unlockAudio,
  type BalkuSoundSettings,
} from "@/lib/balku-sound";
import { useGamesNav } from "../GamesShell";

const SESSION_KEY = "balku-room-session";
const NAME_KEY = "balku-display-name";

type Session = { code: string; playerToken: string };
type ChatMessage = { id: string; playerId: number; name: string; text: string; at: number };
type RoomView = {
  code: string;
  status: BalkuSnapshot["phase"];
  revision: number;
  maxPlayers: number;
  player: { seat: number; displayName: string; isHost: boolean };
  state: BalkuSnapshot;
  chat: ChatMessage[];
  cpuSeats: number[];
};
type PublicRoom = { code: string; maxPlayers: number; playerCount: number; createdAt: number };

type EventBanner = { logId: string; title: string; tone: "good" | "warning" | "danger" };

/* --- ドラッグ＆ドロップ（Pointer Events、マウス/タッチ共通） --- */
type DragPayload =
  | { source: "hand-project"; card: ProjectCard }
  | { source: "hand-material"; kind: MaterialKind }
  | { source: "attached-material"; kind: MaterialKind };
type DragState = { payload: DragPayload; x: number; y: number; label: string };
type DropZoneId = "build" | "sell" | "hand";
type FlyState = { name: string; x: number; y: number; w: number; h: number; dx: number; dy: number; go: boolean };

/* --- カード表現（ゲームの「物」は全部カードの見た目に統一する） --- */
const KIND_FACE: Record<string, string> = {
  木材: "wood",
  鉄骨: "steel",
  コンクリート: "concrete",
  ガラス: "glass",
  銅線: "copper",
  合金: "alloy",
  超伝導体: "super",
  ゴミ: "trash",
};

/** 素材カードの面。種類ごとの色面で、名前をそのまま読ませる。 */
function MatFace({ kind, premium = false, mini = false }: { kind: MaterialKind; premium?: boolean; mini?: boolean }) {
  return (
    <span className={`balku-matface balku-matface-${KIND_FACE[kind] ?? "trash"}${mini ? " balku-matface-mini" : ""}`}>
      {kind}
      {premium ? " ★" : ""}
    </span>
  );
}

/** カード裏面（AGOシアン）。 */
function CardBack({ mini = false }: { mini?: boolean }) {
  return (
    <span className={`balku-cardback${mini ? " balku-cardback-mini" : ""}`} aria-hidden="true">
      B
    </span>
  );
}

/** 裏面の束＋枚数（相手の手札や山札の表現）。 */
function BackStack({ count }: { count: number }) {
  return (
    <span className="balku-backstack" aria-label={`カード ${count}枚`}>
      <CardBack mini />
      <span className="balku-backstack-count">×{count}</span>
    </span>
  );
}

/** 大きなイベントのログだけをバナー表示用に拾う（通常の提出・ドローでは出さない）。 */
function toEventBanner(log: { id: string; text: string } | undefined): EventBanner | null {
  if (!log) return null;
  const { id, text } = log;
  if (text.includes("強制BALKU発動")) return { logId: id, title: "確定BALKU", tone: "danger" };
  if (text.includes("BALKU成功")) return { logId: id, title: "違法建築を接収", tone: "good" };
  if (text.includes("BALKU失敗")) return { logId: id, title: "BALKU 失敗", tone: "danger" };
  if (text.includes("自動オークション成立")) return { logId: id, title: "落札成立", tone: "good" };
  if (text.includes("山札消尽")) return { logId: id, title: "最終精算", tone: "warning" };
  if (text.includes("脱落")) return { logId: id, title: "施工者脱落", tone: "danger" };
  return null;
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return typeof parsed.code === "string" && typeof parsed.playerToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export default function BalkuClient() {
  const { prefix } = useGamesNav();
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [syncMode, setSyncMode] = useState<"sse" | "polling">("sse");
  const [name, setName] = useState("");
  const [createMax, setCreateMax] = useState(2);
  const [isPublic, setIsPublic] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // 提出時の添付素材は「種類ごとの枚数」で持つ。実カードIDは送信時に
  // 手札の先頭から割り当てる（エンジンの判定は種類カウントなので等価）。
  const [attachCounts, setAttachCounts] = useState<Record<string, number>>({});
  const [targetSeat, setTargetSeat] = useState<number | undefined>(undefined);
  const [sellMode, setSellMode] = useState(false);
  const [sellIds, setSellIds] = useState<string[]>([]);
  // 素材の売却選択も種類ごとの枚数で持つ（企画カードは sellIds）。
  const [sellMatCounts, setSellMatCounts] = useState<Record<string, number>>({});
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<EventBanner | null>(null);
  // BALKU で開示された束の一時フラッシュ（key = "seat:submissionId"）
  const [flashKeys, setFlashKeys] = useState<Record<string, true>>({});
  const viewRef = useRef<RoomView | null>(null);
  viewRef.current = view;
  const lastLogIdRef = useRef<string | null>(null);
  const prevSubsRef = useRef<Map<string, boolean>>(new Map());
  // --- サウンド（BGM / SE の個別ミュートは localStorage に保存） ---
  const [soundSettings, setSoundSettings] = useState<BalkuSoundSettings>({ bgm: true, se: true });
  const soundPrimedRef = useRef(false);
  const prevActiveSeatRef = useRef<number | null>(null);
  const finishSoundRef = useRef<string | null>(null);
  // --- ルーム内チャット（右下固定ウィジェット） ---
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const lastSeenChatIdRef = useRef<string | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  // --- ドラッグ＆ドロップ ---
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropHot, setDropHot] = useState<DropZoneId | null>(null);
  const [fly, setFly] = useState<FlyState | null>(null);
  const [hoverCard, setHoverCard] = useState<string | null>(null);
  const dragTrackRef = useRef<{ payload: DragPayload; label: string; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const buildZoneRef = useRef<HTMLElement | null>(null);
  const sellZoneRef = useRef<HTMLDivElement | null>(null);
  const handZoneRef = useRef<HTMLElement | null>(null);

  // --- セッション復元と表示名 ---
  useEffect(() => {
    setSession(loadSession());
    try {
      setName(sessionStorage.getItem(NAME_KEY) ?? "");
    } catch {
      // 保存名が無くてもよい
    }
  }, []);

  const saveSession = useCallback((next: Session | null) => {
    try {
      if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // 保存できなくても対戦は続けられる
    }
    setSession(next);
    if (!next) setView(null);
  }, []);

  const saveName = useCallback((value: string) => {
    setName(value);
    try {
      sessionStorage.setItem(NAME_KEY, value);
    } catch {
      // 保存できなくてもよい
    }
  }, []);

  // --- サウンド初期化（設定読み込み＋最初の操作で AudioContext を解放） ---
  useEffect(() => {
    setSoundSettings(loadSoundSettings());
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  const toggleSound = (key: keyof BalkuSoundSettings) => {
    unlockAudio();
    const next = { ...soundSettings, [key]: !soundSettings[key] };
    setSoundSettings(next);
    saveSoundSettings(next);
    if (next.se && key === "se") playSe("click");
  };

  // エラーが出たらエラー音
  useEffect(() => {
    if (error) playSe("error");
  }, [error]);

  // --- 同期 ---
  const fetchView = useCallback(
    async (target: Session): Promise<boolean> => {
      try {
        const res = await fetch(`/api/balku/rooms/${target.code}?token=${encodeURIComponent(target.playerToken)}`, { cache: "no-store" });
        if (res.status === 403 || res.status === 404) {
          setError("ルームから切断されました。");
          saveSession(null);
          return false;
        }
        if (!res.ok) return false;
        const data = (await res.json()) as RoomView;
        setView(data);
        return true;
      } catch {
        return false;
      }
    },
    [saveSession],
  );

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    void fetchView(session);
    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setSyncMode("polling");
      pollTimer = setInterval(() => {
        void fetchView(session);
      }, 1000);
    };
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/balku/rooms/${session.code}/events?token=${encodeURIComponent(session.playerToken)}`);
      es.onmessage = (event) => {
        try {
          setView(JSON.parse(event.data as string) as RoomView);
          setSyncMode("sse");
        } catch {
          // 壊れたイベントは無視する
        }
      };
      es.addEventListener("room-error", () => {
        es?.close();
        saveSession(null);
      });
      es.onerror = () => {
        // SSE が使えない環境では1秒ポーリングへ切り替える
        es?.close();
        startPolling();
      };
    } catch {
      startPolling();
    }
    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [session, fetchView, saveSession]);

  // 公開ルーム一覧（ロビー表示中だけ自動更新）
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/balku/rooms/public", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rooms: PublicRoom[] };
        if (!cancelled) setPublicRooms(data.rooms ?? []);
      } catch {
        // 一覧が取れなくても作成・参加はできる
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);

  // タイマー表示用のローカル刻み
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // --- 操作 ---
  const postJson = async (url: string, body: unknown): Promise<{ res: Response; data: Record<string, unknown> }> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  };

  const validName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("名前は2〜24文字で入力してください。");
      return null;
    }
    return trimmed;
  };

  const createRoom = async () => {
    const displayName = validName();
    if (!displayName || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/balku/rooms", { displayName, maxPlayers: createMax, isPublic });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "ルームを作成できませんでした。");
        return;
      }
      saveSession({ code: String(data.code), playerToken: String(data.playerToken) });
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (code: string) => {
    const displayName = validName();
    if (!displayName || busy) return;
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(normalized)) {
      setError("ルームコードは6文字で入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/balku/rooms/join", { code: normalized, displayName });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "参加できませんでした。");
        return;
      }
      saveSession({ code: String(data.code), playerToken: String(data.playerToken) });
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const doMove = async (action: GameAction) => {
    const current = viewRef.current;
    if (!session || !current || busy) return;
    setBusy(true);
    setError("");
    // 自分の操作には即座に SE を返す（結果系はログ連動で鳴らす）
    if (action.type === "submit") playSe("submit");
    else if (action.type === "buyMaterial") playSe("shop");
    else if (action.type === "sellCards") playSe("sell");
    else if (action.type === "bid") playSe("bid");
    else if (action.type === "endTurn") playSe("click");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/move`, {
        playerToken: session.playerToken,
        expectedRevision: current.revision,
        action,
      });
      if (res.status === 409) {
        setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。");
        await fetchView(session);
      } else if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "操作できませんでした。");
      } else {
        setConfirmKey(null);
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const doHostAction = async (kind: "start" | "restart") => {
    const current = viewRef.current;
    if (!session || !current || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/${kind}`, {
        playerToken: session.playerToken,
        expectedRevision: current.revision,
      });
      if (res.status === 409) {
        setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。");
        await fetchView(session);
      } else if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "操作できませんでした。");
      } else {
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const leaveRoom = async () => {
    if (!session || busy) return;
    const current = viewRef.current;
    setBusy(true);
    try {
      if (current) {
        const { res, data } = await postJson(`/api/balku/rooms/${session.code}/leave`, {
          playerToken: session.playerToken,
          expectedRevision: current.revision,
        });
        if (res.status === 409) {
          setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。もう一度退出してください。");
          await fetchView(session);
          return;
        }
      }
      saveSession(null);
      setView(null);
      setError("");
      setNotice("");
    } catch {
      // 通信できなくても手元のセッションは破棄する
      saveSession(null);
    } finally {
      setBusy(false);
    }
  };

  const sendChat = async () => {
    const text = chatText.trim();
    if (!session || !text || chatSending) return;
    setChatSending(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/chat`, {
        playerToken: session.playerToken,
        text,
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "メッセージを送信できませんでした。");
        return;
      }
      setChatText("");
      playSe("click");
      await fetchView(session);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setChatSending(false);
    }
  };

  const doCpu = async (action: "add" | "remove", seat?: number) => {
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/cpu`, {
        playerToken: session.playerToken,
        action,
        ...(seat !== undefined ? { seat } : {}),
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "CPUを操作できませんでした。");
      } else {
        playSe("click");
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice(`ルームコード: ${session.code}`);
    }
  };

  // --- 対戦中の選択状態の掃除 ---
  const state = view?.state;
  const mySeat = view?.player.seat ?? -1;
  const me: SnapshotPlayer | undefined = state?.players.find((p) => p.seat === mySeat);
  useEffect(() => {
    if (selectedProjectId && me && !me.hand.some((c) => c.id === selectedProjectId)) {
      setSelectedProjectId(null);
      setAttachCounts({});
      setTargetSeat(undefined);
    }
    if (me) {
      setSellIds((ids) => ids.filter((id) => me.hand.some((c) => c.id === id)));
    }
    // me の同一性はポーリングごとに変わるため、手札の中身で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.turn, state?.activeSeat, me?.hand.length]);

  // --- チャット: 未読管理と自動スクロール ---
  const chatMessages = view?.chat ?? [];
  const lastSeenIdx = chatMessages.findIndex((m) => m.id === lastSeenChatIdRef.current);
  const chatUnread =
    lastSeenChatIdRef.current === null
      ? 0
      : chatMessages.slice(lastSeenIdx + 1).filter((m) => m.playerId !== mySeat).length;
  // 初回表示では既存の履歴を未読にしない
  useEffect(() => {
    if (lastSeenChatIdRef.current === null && chatMessages.length > 0) {
      lastSeenChatIdRef.current = chatMessages[chatMessages.length - 1].id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.revision]);
  // 開いている間は既読にし続け、一番下へスクロールする
  useEffect(() => {
    if (!chatOpen) return;
    if (chatMessages.length > 0) {
      lastSeenChatIdRef.current = chatMessages[chatMessages.length - 1].id;
    }
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, chatMessages.length, view?.revision]);

  // --- 演出: イベントバナー（同じログでは二度出さない）＋ログ連動 SE ---
  const latestLog = state?.logs[0];
  useEffect(() => {
    if (!latestLog || lastLogIdRef.current === latestLog.id) return;
    lastLogIdRef.current = latestLog.id;
    // 最初のスナップショットでは音を鳴らさない（過去ログの再生防止）
    const primed = soundPrimedRef.current;
    soundPrimedRef.current = true;
    if (primed) {
      const text = latestLog.text;
      if (text.includes("強制BALKU発動")) playSe("forceBulk");
      else if (text.includes("BALKU成功")) playSe("bulkSuccess");
      else if (text.includes("BALKU失敗")) playSe("bulkFail");
      else if (text.includes("自動オークション成立")) {
        playSe("auctionWin");
        playSe("coin");
      } else if (text.includes("落札")) playSe("coin");
      else if (text.includes("公開で") || text.includes("伏せ企画を完成") || text.includes("伏せて")) playSe("play");
    }
    const event = toEventBanner(latestLog);
    if (!event) return;
    setBanner(event);
    const timer = setTimeout(() => setBanner((b) => (b?.logId === event.logId ? null : b)), 2200);
    return () => clearTimeout(timer);
  }, [latestLog]);

  // --- SE: 自分の手番が来たら知らせる ---
  useEffect(() => {
    if (!state || state.phase !== "active") return;
    const prev = prevActiveSeatRef.current;
    prevActiveSeatRef.current = state.activeSeat;
    if (prev !== null && prev !== state.activeSeat && state.activeSeat === mySeat) playSe("turn");
    // mySeat は view から決まる値なので state の変化だけで追う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.activeSeat, state?.phase]);

  // --- SE: 終局（勝ち/負けを一度だけ） ---
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    const key = `${state.turn}:${state.finalScores.map((s) => s.seat).join(",")}`;
    if (finishSoundRef.current === key) return;
    finishSoundRef.current = key;
    playSe(state.winnerSeats.includes(mySeat) ? "win" : "lose");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase]);

  // --- 演出: 伏せ束が BALKU で開示されたら対象の束を揺らす ---
  useEffect(() => {
    if (!state) return;
    const next = new Map<string, boolean>();
    const flashes: string[] = [];
    for (const p of state.players) {
      for (const sub of p.submitted) {
        const key = `${p.seat}:${sub.id}`;
        next.set(key, sub.faceUp);
        if (prevSubsRef.current.get(key) === false && sub.faceUp) flashes.push(key);
      }
    }
    prevSubsRef.current = next;
    if (flashes.length === 0) return;
    setFlashKeys((prev) => {
      const cp = { ...prev };
      for (const k of flashes) cp[k] = true;
      return cp;
    });
    const timer = setTimeout(() => {
      setFlashKeys((prev) => {
        const cp = { ...prev };
        for (const k of flashes) delete cp[k];
        return cp;
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [state]);

  const header = (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>BALKU</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>BALKU</h1>
        <p className="muted">素材を集めて企画を完成させる、オンライン建築ブラフ。</p>
      </div>
      <div className="balku-soundbar" role="group" aria-label="サウンド設定">
        <button
          type="button"
          className={`balku-snd-btn${soundSettings.bgm ? " balku-snd-on" : ""}`}
          aria-pressed={soundSettings.bgm}
          onClick={() => toggleSound("bgm")}
        >
          ♪ BGM {soundSettings.bgm ? "ON" : "OFF"}
        </button>
        <button
          type="button"
          className={`balku-snd-btn${soundSettings.se ? " balku-snd-on" : ""}`}
          aria-pressed={soundSettings.se}
          onClick={() => toggleSound("se")}
        >
          SE {soundSettings.se ? "ON" : "OFF"}
        </button>
      </div>
      {error && (
        <p className="balku-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="balku-notice">{notice}</p>}
    </>
  );

  // --- ロビー ---
  if (!session) {
    return (
      <>
        {header}
        <div className="balku-table balku-table-lobby">
        <ol className="balku-steps">
          <li>
            <strong>1.</strong> 素材を集めて企画を完成させる
          </li>
          <li>
            <strong>2.</strong> 伏せ提出でブラフ、怪しければ BALKU で暴く
          </li>
          <li>
            <strong>3.</strong> 山札が尽きたら最終精算。高得点の勝ち
          </li>
        </ol>
        <div className="balku-lobby-grid">
          <section className="balku-panel">
            <h2>ルームを作成 / 参加</h2>
            <label className="balku-field">
              <span>あなたの名前</span>
              <input
                className="balku-input"
                value={name}
                onChange={(e) => saveName(e.target.value)}
                placeholder="2〜24文字"
                maxLength={24}
              />
            </label>
            <div className="balku-field">
              <span>人数（作成時）</span>
              <div className="balku-segmented" role="group" aria-label="人数">
                {[2, 3, 4].map((n) => (
                  <button key={n} type="button" aria-pressed={createMax === n} className={createMax === n ? "balku-segmented-active" : ""} onClick={() => setCreateMax(n)}>
                    {n}人
                  </button>
                ))}
              </div>
            </div>
            <label className="balku-check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              公開ルームにする（一覧に載せる）
            </label>
            <button type="button" className="balku-btn balku-btn-primary" onClick={createRoom} disabled={busy}>
              ルームを作成
            </button>
            <div className="balku-join-row">
              <input
                className="balku-input balku-code-input"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="コード6文字"
                maxLength={6}
                aria-label="ルームコード"
              />
              <button type="button" className="balku-btn" onClick={() => joinRoom(joinCode)} disabled={busy}>
                参加
              </button>
            </div>
          </section>
          <section className="balku-panel">
            <h2>公開ルーム</h2>
            {publicRooms.length === 0 ? (
              <p className="muted">いま入れる公開ルームはありません。</p>
            ) : (
              <div className="balku-public-list">
                {publicRooms.map((room) => (
                  <div key={room.code} className="balku-public-row">
                    <span className="balku-public-code">{room.code}</span>
                    <span className="muted">
                      {room.playerCount} / {room.maxPlayers} 人
                    </span>
                    <button type="button" className="balku-btn" onClick={() => joinRoom(room.code)} disabled={busy || room.playerCount >= room.maxPlayers}>
                      参加
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        </div>
      </>
    );
  }

  if (!view || !state || !me) {
    return (
      <>
        {header}
        <p className="muted">ルーム {session.code} に接続中…</p>
        <button type="button" className="balku-btn balku-btn-ghost" onClick={() => saveSession(null)}>
          接続をやめる
        </button>
      </>
    );
  }

  const st = state;
  const isHost = view.player.isHost;

  // --- ルーム内チャット（右下固定。ロビー/対戦/終了の全画面で共通） ---
  const renderChat = () => (
    <div className="balku-chat">
      {chatOpen ? (
        <div className="balku-chat-panel" role="dialog" aria-label="ルームチャット">
          <div className="balku-chat-head">
            <span className="balku-plate">ルームチャット</span>
            <button type="button" className="balku-chat-close" onClick={() => setChatOpen(false)} aria-label="チャットを閉じる">
              ×
            </button>
          </div>
          <div className="balku-chat-list" ref={chatListRef}>
            {chatMessages.length === 0 ? (
              <p className="balku-chat-empty">まだメッセージはありません。</p>
            ) : (
              chatMessages.map((m) => (
                <div key={m.id} className={`balku-chat-msg${m.playerId === mySeat ? " balku-chat-mine" : ""}`}>
                  <span className="balku-chat-meta">
                    {m.name}
                    <span className="balku-chat-time">
                      {new Date(m.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                  <span className="balku-chat-text">{m.text}</span>
                </div>
              ))
            )}
          </div>
          <form
            className="balku-chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
          >
            <input
              className="balku-chat-input"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="メッセージ（200文字まで）"
              aria-label="チャットメッセージ"
            />
            <button type="submit" className="balku-btn balku-btn-primary balku-chat-send" disabled={chatSending || chatText.trim().length === 0}>
              送信
            </button>
          </form>
        </div>
      ) : (
        <button type="button" className="balku-chat-fab" onClick={() => setChatOpen(true)}>
          チャット
          {chatUnread > 0 && <span className="balku-chat-badge">{chatUnread}</span>}
        </button>
      )}
    </div>
  );

  // --- 待機画面 ---
  if (view.status === "lobby") {
    return (
      <>
        {header}
        <div className="balku-table">
        <section className="balku-panel">
          <h2>待機中</h2>
          <div className="balku-room-code-row">
            <span className="balku-room-code">{session.code}</span>
            <button type="button" className="balku-btn" onClick={copyCode}>
              {copied ? "コピーしました" : "コードをコピー"}
            </button>
          </div>
          <p className="muted">このコードを共有すると、他のプレイヤーが参加できます。</p>
          <div className="balku-player-list">
            {st.players.map((p) => {
              const isCpuSeat = view.cpuSeats.includes(p.seat);
              return (
                <div key={p.seat} className="balku-player-row">
                  <span>
                    {p.name}
                    {p.seat === mySeat ? "（あなた）" : ""}
                    {p.seat === 0 ? "（ホスト）" : ""}
                    {isCpuSeat && <span className="balku-badge balku-badge-cpu">CPU</span>}
                  </span>
                  {isHost && isCpuSeat && (
                    <button type="button" className="balku-btn balku-btn-ghost balku-cpu-remove" onClick={() => doCpu("remove", p.seat)} disabled={busy}>
                      外す
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="muted">
            {st.players.length} / {view.maxPlayers} 人
          </p>
          <div className="balku-actions">
            {isHost ? (
              <button type="button" className="balku-btn balku-btn-primary" onClick={() => doHostAction("start")} disabled={busy || st.players.length < 2}>
                対戦を開始
              </button>
            ) : (
              <p className="muted">ホストの開始を待っています…</p>
            )}
            {isHost && st.players.length < view.maxPlayers && (
              <button type="button" className="balku-btn" onClick={() => doCpu("add")} disabled={busy}>
                CPUを追加
              </button>
            )}
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出
            </button>
          </div>
          {isHost && st.players.length < 2 && <p className="muted">あと1席で開始できます。参加者を待つか、CPUを追加してください。</p>}
        </section>
        </div>
        {renderChat()}
      </>
    );
  }

  // --- 終了画面 ---
  if (view.status === "finished") {
    const winnerNames = st.finalScores.filter((s) => st.winnerSeats.includes(s.seat)).map((s) => s.name);
    return (
      <>
        {header}
        {banner && (
          <div className={`balku-banner balku-banner-${banner.tone}`} role="status" aria-live="polite">
            <strong>{banner.title}</strong>
            <span>{st.logs[0]?.id === banner.logId ? st.logs[0].text : ""}</span>
          </div>
        )}
        <div className="balku-table">
        <section className="balku-panel">
          <h2>最終精算</h2>
          <p className="balku-winner">
            {st.winnerSeats.length > 1 ? `共同勝利: ${winnerNames.join(" / ")}` : `勝者: ${winnerNames[0] ?? "—"}`}
            {st.winnerSeats.includes(mySeat) ? " 🎉" : ""}
          </p>
          <table className="balku-results">
            <thead>
              <tr>
                <th>順位</th>
                <th>会社</th>
                <th>提出点</th>
                <th>ボーナス</th>
                <th>合計</th>
              </tr>
            </thead>
            <tbody>
              {st.finalScores.map((score, index) => (
                <tr key={score.seat} className={st.winnerSeats.includes(score.seat) ? "balku-result-win" : ""}>
                  <td>{index + 1}</td>
                  <td>
                    {score.name}
                    {score.seat === mySeat ? "（あなた）" : ""}
                  </td>
                  <td>{score.submittedPoints}</td>
                  <td>{score.bonusPoints}</td>
                  <td>
                    <strong>{score.points} PT</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="balku-actions">
            {isHost && (
              <button type="button" className="balku-btn balku-btn-primary" onClick={() => doHostAction("restart")} disabled={busy}>
                再戦を準備
              </button>
            )}
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出
            </button>
          </div>
          {!isHost && <p className="muted">再戦の準備はホストが行います。</p>}
        </section>
        </div>
        {renderChat()}
      </>
    );
  }

  // --- 対戦画面 ---
  const activePlayer = st.players.find((p) => p.seat === st.activeSeat);
  const myTurn = st.activeSeat === mySeat && !me.eliminated;
  const turnSec = st.turnDeadlineAt ? Math.max(0, Math.ceil((st.turnDeadlineAt - now) / 1000)) : null;
  const auctionSec = st.auction ? Math.max(0, Math.ceil((st.auction.deadlineAt - now) / 1000)) : null;
  const deckPct = st.deckInitialCount > 0 ? Math.max(0, Math.min(100, Math.round((st.deckCount / st.deckInitialCount) * 100))) : 0;
  const myBreakdown = scoreBreakdown(me);
  const myCharges = me.forceBulkCharges.filter((c) => !c.used);
  const handProjects = me.hand.filter((c): c is ProjectCard => c.kind === "project");
  const handMaterials = me.hand.filter((c): c is MaterialCard => c.kind === "material");
  const selectedProject = handProjects.find((c) => c.id === selectedProjectId) ?? null;
  const needsTarget = selectedProject ? TARGETED_EFFECTS.includes(selectedProject.effect.type) : false;
  const opponents = st.players.filter((p) => p.seat !== mySeat);

  const ownedCount = (kind: MaterialKind) => handMaterials.filter((c) => c.material === kind).length;
  // 添付数は所持数でクランプして扱う（同期で手札が減っても壊れない）
  const attachOf = (kind: MaterialKind) => Math.min(attachCounts[kind] ?? 0, ownedCount(kind));
  // 種類ごとの添付数 → 実カードID（手札の先頭から割り当て）
  const buildMaterialIds = (counts: Record<string, number>): string[] => {
    const ids: string[] = [];
    for (const kind of MARKET_MATERIALS) {
      const n = Math.min(counts[kind] ?? 0, ownedCount(kind));
      ids.push(...handMaterials.filter((c) => c.material === kind).slice(0, n).map((c) => c.id));
    }
    return ids;
  };
  const selectedMaterialIds = selectedProject ? buildMaterialIds(attachCounts) : [];
  const selectedMaterialCards = handMaterials.filter((c) => selectedMaterialIds.includes(c.id));
  const selectedLegal = selectedProject ? isLegalSubmission(selectedProject, selectedMaterialCards) : false;

  /** 企画を施工ゾーンにセットする（タップ選択とドロップの共通入口）。 */
  const placeProject = (card: ProjectCard) => {
    setSellMode(false);
    setSellIds([]);
    setSellMatCounts({});
    setSelectedProjectId(card.id);
    // 正規完成に必要な数を初期値にする（足りない種類は所持ぶんまで）。
    // selectLegalMaterials が返す実カード集合と種類カウントで等価になる。
    const counts: Record<string, number> = {};
    for (const [kind, amount] of Object.entries(card.requirements)) {
      counts[kind] = Math.min(ownedCount(kind as MaterialKind), amount ?? 0);
    }
    setAttachCounts(counts);
    setTargetSeat(undefined);
  };

  const selectProject = (card: ProjectCard) => {
    if (suppressClickRef.current) return;
    playSe("select");
    if (selectedProjectId === card.id) {
      setSelectedProjectId(null);
      setAttachCounts({});
      setTargetSeat(undefined);
      return;
    }
    placeProject(card);
  };

  const toggleProjectSell = (card: ProjectCard) => {
    if (suppressClickRef.current) return;
    setSellIds((ids) => (ids.includes(card.id) ? ids.filter((id) => id !== card.id) : [...ids, card.id]));
  };

  // 素材グループの売却選択: タップのたびに +1、所持数に達したら 0 に戻る
  const cycleMatSell = (kind: MaterialKind) => {
    if (suppressClickRef.current) return;
    const owned = ownedCount(kind);
    setSellMatCounts((prev) => {
      const current = Math.min(prev[kind] ?? 0, owned);
      return { ...prev, [kind]: current >= owned ? 0 : current + 1 };
    });
  };
  const sellMatTotal = MARKET_MATERIALS.reduce((sum, kind) => sum + Math.min(sellMatCounts[kind] ?? 0, ownedCount(kind)), 0);
  const sellTotal = sellIds.length + sellMatTotal;

  const submitSelected = (faceUp: boolean) => {
    if (!selectedProject) return;
    // FLIP: 手札の企画カードの位置から施工ゾーンへカードを飛ばす
    try {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const src = document.querySelector(`[data-hand-project="${selectedProject.id}"]`)?.getBoundingClientRect();
      const dst = buildZoneRef.current?.getBoundingClientRect();
      if (src && dst && !reduced) {
        setFly({
          name: selectedProject.name,
          x: src.left,
          y: src.top,
          w: src.width,
          h: src.height,
          dx: dst.left + dst.width / 2 - (src.left + src.width / 2),
          dy: dst.top + 56 - (src.top + src.height / 2),
          go: false,
        });
        requestAnimationFrame(() => requestAnimationFrame(() => setFly((f) => (f ? { ...f, go: true } : f))));
        setTimeout(() => setFly(null), 300);
      }
    } catch {
      // FLIP は装飾なので失敗しても提出は続ける
    }
    void doMove({
      type: "submit",
      projectId: selectedProject.id,
      materialIds: selectedMaterialIds,
      faceUp,
      ...(needsTarget && targetSeat !== undefined ? { targetSeat } : {}),
    });
    setSelectedProjectId(null);
    setAttachCounts({});
    setTargetSeat(undefined);
  };

  /* --- ドラッグ＆ドロップの解決 ---
     タップ操作は従来どおり全て可能で、ドラッグはその入口を増やすだけ。
     ドロップ先は施工ゾーン（build）/ 売却ポケット（sell）/ 手札（hand）。 */
  const zoneAt = (x: number, y: number): DropZoneId | null => {
    const zones: [DropZoneId, HTMLElement | null][] = [
      ["build", buildZoneRef.current],
      ["sell", sellZoneRef.current],
      ["hand", handZoneRef.current],
    ];
    for (const [id, el] of zones) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  };

  const resolveDrop = (payload: DragPayload, zone: DropZoneId | null) => {
    if (!zone) return;
    if (zone === "build") {
      if (payload.source === "hand-project") {
        playSe("play");
        placeProject(payload.card);
      } else if (payload.source === "hand-material") {
        if (selectedProject && payload.kind in selectedProject.requirements) {
          playSe("play");
          setAttachCounts((prev) => ({ ...prev, [payload.kind]: Math.min(ownedCount(payload.kind), attachOf(payload.kind) + 1) }));
        } else {
          playSe("error");
        }
      } else if (payload.source === "attached-material") {
        playSe("error");
      }
      return;
    }
    if (zone === "sell") {
      if (payload.source === "hand-project") {
        void doMove({ type: "sellCards", cardIds: [payload.card.id] });
      } else if (payload.source === "hand-material") {
        const first = handMaterials.find((c) => c.material === payload.kind);
        if (first) void doMove({ type: "sellCards", cardIds: [first.id] });
      }
      return;
    }
    if (zone === "hand" && payload.source === "attached-material") {
      playSe("draw");
      setAttachCounts((prev) => ({ ...prev, [payload.kind]: Math.max(0, attachOf(payload.kind) - 1) }));
    }
  };

  const beginDrag = (payload: DragPayload, label: string) => (e: React.PointerEvent) => {
    if (!myTurn || busy || me.eliminated) return;
    if (e.button !== undefined && e.button > 0) return;
    dragTrackRef.current = { payload, label, startX: e.clientX, startY: e.clientY, active: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // キャプチャできなくても move/up は要素上で追える
    }
  };
  const moveDrag = (e: React.PointerEvent) => {
    const track = dragTrackRef.current;
    if (!track) return;
    if (!track.active) {
      if (Math.hypot(e.clientX - track.startX, e.clientY - track.startY) < 7) return;
      track.active = true;
      playSe("draw");
    }
    setDrag({ payload: track.payload, x: e.clientX, y: e.clientY, label: track.label });
    setDropHot(zoneAt(e.clientX, e.clientY));
  };
  const endDrag = (e: React.PointerEvent) => {
    const track = dragTrackRef.current;
    dragTrackRef.current = null;
    if (!track || !track.active) return;
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 60);
    const zone = zoneAt(e.clientX, e.clientY);
    setDropHot(null);
    if (zone) {
      setDrag(null);
      resolveDrop(track.payload, zone);
    } else {
      // 対象外で離したら元の位置へ戻る
      setDrag({ payload: track.payload, x: track.startX, y: track.startY, label: track.label });
      setTimeout(() => setDrag(null), 200);
    }
  };
  const cancelDrag = () => {
    dragTrackRef.current = null;
    setDrag(null);
    setDropHot(null);
  };
  const dragHandlers = (payload: DragPayload, label: string) => ({
    onPointerDown: beginDrag(payload, label),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: cancelDrag,
  });

  /** 提出束に添付された素材を、小さな素材カード（伏せなら裏面）の重なりで見せる。 */
  const renderBundleMats = (sub: SnapshotSubmission, visible: boolean) => {
    if (sub.materialCount === 0) return null;
    if (!visible) {
      const shown = Math.min(sub.materialCount, 6);
      return (
        <div className="balku-bundle-mats" aria-label={`添付素材 ${sub.materialCount}枚（裏向き）`}>
          {Array.from({ length: shown }, (_, i) => (
            <CardBack key={i} mini />
          ))}
          {sub.materialCount > shown && <span className="muted">+{sub.materialCount - shown}</span>}
        </div>
      );
    }
    const shownMats = sub.materials.slice(0, 8);
    return (
      <div className="balku-bundle-mats" aria-label={`添付素材 ${sub.materialCount}枚`}>
        {shownMats.map((m) => (
          <MatFace key={m.id} kind={m.material} premium={m.rarity === "premium"} mini />
        ))}
        {sub.materialCount > shownMats.length && <span className="muted">+{sub.materialCount - shownMats.length}</span>}
      </div>
    );
  };

  const renderBundle = (owner: SnapshotPlayer, sub: SnapshotSubmission) => {
    const isMine = owner.seat === mySeat;
    const keyBase = `${owner.seat}:${sub.id}`;
    if (!sub.faceUp) {
      return (
        <div key={sub.id} className={`balku-bundle balku-bundle-down${flashKeys[keyBase] ? " balku-bundle-flash" : ""}`}>
          <div className="balku-bundle-main">
            <span className="balku-bundle-name">{isMine ? sub.project.name : "伏せ企画"}</span>
            <span className="balku-badge balku-badge-hazard">伏せ</span>
            <span className="muted">素材 {sub.materialCount}枚</span>
            {isMine && <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>}
          </div>
          {renderBundleMats(sub, isMine)}
          {!isMine && !me.eliminated && renderBulkButtons(owner, sub, keyBase)}
        </div>
      );
    }
    return (
      <div key={sub.id} className={`balku-bundle${flashKeys[keyBase] ? " balku-bundle-flash" : ""}`}>
        {sub.legal && <span className="balku-stamp" aria-hidden="true">承認</span>}
        <div className="balku-bundle-main">
          <span className="balku-bundle-name">{sub.project.name}</span>
          <span>{sub.project.points} PT</span>
          <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>
          <span className="muted">素材 {sub.materialCount}枚</span>
        </div>
        <p className="balku-bundle-effect">{sub.project.effect.label}</p>
        {renderBundleMats(sub, true)}
        {!isMine && !me.eliminated && renderBulkButtons(owner, sub, keyBase)}
      </div>
    );
  };

  const renderBulkButtons = (owner: SnapshotPlayer, sub: SnapshotSubmission, keyBase: string) => {
    if (owner.eliminated) return null;
    const bulkKey = `bulk:${keyBase}`;
    const forceKey = `force:${keyBase}`;
    const riskText = sub.faceUp && !sub.legal ? "違法が確定している束です。そのまま接収できます。" : "正規だった場合、対象以上の点数の企画を手札からロストします。不足すると全ロストで脱落します。";
    return (
      <div className="balku-bulk-area">
        {confirmKey === bulkKey ? (
          <div className="balku-confirm">
            <p>{riskText}</p>
            <div className="balku-actions">
              <button type="button" className="balku-btn balku-btn-hazard" disabled={busy} onClick={() => doMove({ type: "bulkCall", targetSeat: owner.seat, submissionId: sub.id })}>
                本当にBALKUする
              </button>
              <button type="button" className="balku-btn balku-btn-ghost" onClick={() => setConfirmKey(null)}>
                やめる
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="balku-btn balku-btn-hazard" disabled={busy} onClick={() => setConfirmKey(bulkKey)}>
            BALKU
          </button>
        )}
        {myCharges.length > 0 &&
          (confirmKey === forceKey ? (
            <div className="balku-confirm">
              <p>強制BALKUは、正規・違法を問わず1回だけ接収できます（権利は消費されます）。</p>
              <div className="balku-actions">
                <button
                  type="button"
                  className="balku-btn balku-btn-hazard"
                  disabled={busy}
                  onClick={() => doMove({ type: "forceBulk", chargeId: myCharges[0].id, targetSeat: owner.seat, submissionId: sub.id })}
                >
                  本当に強制BALKUする
                </button>
                <button type="button" className="balku-btn balku-btn-ghost" onClick={() => setConfirmKey(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="balku-btn" disabled={busy} onClick={() => setConfirmKey(forceKey)}>
              強制BALKU
            </button>
          ))}
      </div>
    );
  };

  const latestLogEntry = st.logs[0];
  const sellCardIds = [...sellIds, ...buildMaterialIds(sellMatCounts)];
  // 手札ファンの重なり率（カードが多いほど深く重ねて横幅に収める）
  const projStep = handProjects.length <= 5 ? 118 : handProjects.length <= 8 ? 84 : handProjects.length <= 12 ? 60 : 44;
  const matKindsInHand = MARKET_MATERIALS.filter((kind) => ownedCount(kind) > 0);
  const matStep = matKindsInHand.length <= 5 ? 84 : matKindsInHand.length <= 8 ? 62 : 48;
  const dragProjectId = drag?.payload.source === "hand-project" ? drag.payload.card.id : null;
  const dragMatKind = drag?.payload.source === "hand-material" || drag?.payload.source === "attached-material" ? drag.payload.kind : null;

  const renderSeat = (p: SnapshotPlayer) => (
    <div key={p.seat} className={`balku-seat${st.activeSeat === p.seat ? " balku-seat-active" : ""}`}>
      <div className="balku-seat-head">
        <span className="balku-nameplate">{p.name}</span>
        {view.cpuSeats.includes(p.seat) && <span className="balku-badge balku-badge-cpu">CPU</span>}
        {p.eliminated ? (
          <span className="balku-badge balku-badge-bad">脱落</span>
        ) : (
          <span className="balku-seat-stats">
            <BackStack count={p.handCount} />
            <span>
              {p.coins}コイン / {getTotalPoints(p)} PT
              {st.activeSeat === p.seat && turnSec !== null ? ` / あと${turnSec}秒` : ""}
            </span>
          </span>
        )}
      </div>
      <div className="balku-bundles">
        {p.submitted.length === 0 ? <p className="balku-table-note">提出なし</p> : p.submitted.map((sub) => renderBundle(p, sub))}
      </div>
    </div>
  );

  return (
    <>
      {header}
      {banner && (
        <div className={`balku-banner balku-banner-${banner.tone}`} role="status" aria-live="polite">
          <strong>{banner.title}</strong>
          <span>{latestLogEntry?.id === banner.logId ? latestLogEntry.text : ""}</span>
        </div>
      )}
      <div className="balku-table balku-table-game">
        {/* 上段：他社席 */}
        <div className="balku-seats">{opponents.map((p) => renderSeat(p))}</div>

        {/* 中央：場（オークション／自分の提出／施工ゾーン）＋市場の棚 */}
        <div className="balku-fieldrow">
          <div className="balku-field">
            {st.auction && (
              <div key={`${st.auction.roundOpened}:${st.auction.card.id}`} className="balku-auction" role="status">
                <span className="balku-plate">オークション</span>
                {st.auction.card.kind === "project" ? (
                  <span className="balku-card balku-card-small balku-card-static">
                    <span className="balku-card-head">
                      <strong>{st.auction.card.name}</strong>
                      <span>{(st.auction.card as ProjectCard).points} PT</span>
                    </span>
                    <span className="balku-card-effect">{(st.auction.card as ProjectCard).effect.label}</span>
                  </span>
                ) : (
                  <MatFace kind={(st.auction.card as MaterialCard).material} premium={(st.auction.card as MaterialCard).rarity === "premium"} />
                )}
                <span className="balku-auction-info">
                  現在 {st.auction.highestBid}コイン
                  {st.auction.highestBidderSeat !== null ? `（${st.players.find((p) => p.seat === st.auction!.highestBidderSeat)?.name ?? ""}）` : "（入札なし）"}
                  <span className={auctionSec !== null && auctionSec <= 5 ? " balku-auction-danger" : ""}> ・ あと{auctionSec ?? 0}秒</span>
                </span>
                <span className="balku-actions">
                  {[1, 5].map((plus) => {
                    const amount = st.auction!.highestBid + plus;
                    return (
                      <button
                        key={plus}
                        type="button"
                        className="balku-btn"
                        disabled={busy || me.eliminated || me.coins < amount || st.auction!.highestBidderSeat === mySeat}
                        onClick={() => doMove({ type: "bid", amount })}
                      >
                        {amount}コインで入札
                      </button>
                    );
                  })}
                </span>
              </div>
            )}

            <div className="balku-myfield">
              <span className="balku-plate">あなたの提出</span>
              <div className="balku-bundles">
                {me.submitted.length === 0 ? <p className="balku-table-note">まだ提出していません。</p> : me.submitted.map((sub) => renderBundle(me, sub))}
              </div>
            </div>

            <section
              ref={buildZoneRef}
              data-drop="build"
              aria-label="施工ゾーン"
              className={`balku-buildzone${selectedProject ? " balku-buildzone-set" : ""}${drag ? " balku-drop-armed" : ""}${dropHot === "build" ? " balku-drop-hot" : ""}`}
            >
              {!selectedProject ? (
                <p className="balku-buildzone-empty">
                  施工ゾーン
                  <span>企画カードをここへドラッグ（または手札でタップ）</span>
                </p>
              ) : (
                <>
                  <div className="balku-build-head">
                    <strong>{selectedProject.name}</strong>
                    <span>{selectedProject.points} PT</span>
                    <span className="balku-build-effect">
                      {selectedProject.immediate ? "即時 / " : ""}
                      {selectedProject.effect.label}
                    </span>
                  </div>
                  {selectedMaterialCards.length > 0 && (
                    <div className="balku-attached" aria-label="添付中の素材">
                      {MARKET_MATERIALS.map((kind) => {
                        const n = attachOf(kind);
                        if (n === 0) return null;
                        return (
                          <span
                            key={kind}
                            className="balku-attached-item balku-draggable"
                            title="手札へドラッグで戻す"
                            {...dragHandlers({ source: "attached-material", kind }, kind)}
                          >
                            <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                            <span className="balku-attached-count">×{n}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {Object.entries(selectedProject.requirements).length === 0 ? (
                    <p className="balku-table-note">素材不要</p>
                  ) : (
                    <div className="balku-steppers">
                      {Object.entries(selectedProject.requirements).map(([kindRaw, needRaw]) => {
                        const kind = kindRaw as MaterialKind;
                        const need = needRaw ?? 0;
                        const owned = ownedCount(kind);
                        const attached = attachOf(kind);
                        return (
                          <div key={kind} className="balku-stepper-row">
                            <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                            <span className="balku-stepper-kind">{kind}</span>
                            <span className="balku-stepper-meta">
                              必要 {need} / 所持 {owned}
                            </span>
                            <span className="balku-stepper">
                              <button type="button" aria-label={`${kind}を減らす`} disabled={attached <= 0} onClick={() => setAttachCounts((prev) => ({ ...prev, [kind]: Math.max(0, attachOf(kind) - 1) }))}>
                                −
                              </button>
                              <span className="balku-stepper-count">{attached}</span>
                              <button type="button" aria-label={`${kind}を増やす`} disabled={attached >= owned} onClick={() => setAttachCounts((prev) => ({ ...prev, [kind]: Math.min(owned, attachOf(kind) + 1) }))}>
                                ＋
                              </button>
                            </span>
                            {attached >= need ? <span className="balku-badge balku-badge-ok">充足</span> : <span className="balku-badge balku-badge-bad">あと{need - attached}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className={selectedLegal ? "balku-legal-ok" : "balku-legal-ng"}>
                    {selectedLegal
                      ? "素材条件を満たしています（正規完成）。"
                      : `素材が不足しています（不足: ${Object.entries(selectedProject.requirements)
                          .map(([kind, need]) => {
                            const have = attachOf(kind as MaterialKind);
                            return have < (need ?? 0) ? `${kind} あと${(need ?? 0) - have}枚` : "";
                          })
                          .filter(Boolean)
                          .join(" / ")}）。公開すると違法建築になります。`}
                  </p>
                  {needsTarget && (
                    <div className="balku-field-input">
                      <span>効果の対象</span>
                      <div className="balku-target-chips">
                        {opponents
                          .filter((p) => !p.eliminated)
                          .map((p) => (
                            <button key={p.seat} type="button" className={`balku-target-chip${targetSeat === p.seat ? " balku-target-chip-selected" : ""}`} onClick={() => setTargetSeat(p.seat)}>
                              {p.name}（{p.coins}コイン / 手札{p.handCount}枚）
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                  <div className="balku-actions">
                    <button type="button" className="balku-btn balku-btn-primary" disabled={busy || !myTurn || (needsTarget && targetSeat === undefined)} onClick={() => submitSelected(true)}>
                      公開で提出
                    </button>
                    <button type="button" className="balku-btn" disabled={busy || !myTurn || (needsTarget && targetSeat === undefined)} onClick={() => submitSelected(false)}>
                      伏せて提出
                    </button>
                    <button
                      type="button"
                      className="balku-btn balku-btn-ghost"
                      onClick={() => {
                        setSelectedProjectId(null);
                        setAttachCounts({});
                        setTargetSeat(undefined);
                      }}
                    >
                      選択をやめる
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>

          <aside className="balku-shelf">
            <span className="balku-plate">調達市場</span>
            <div className="balku-market">
              {MARKET_MATERIALS.map((kind) => (
                <button key={kind} type="button" className="balku-market-card" disabled={busy || !myTurn || me.coins < getMarketPrice(kind)} onClick={() => doMove({ type: "buyMaterial", material: kind })}>
                  <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                  <span className="balku-price-tag">{getMarketPrice(kind)}コイン</span>
                </button>
              ))}
            </div>
            <div className="balku-logcorner" aria-label="ログ">
              {st.logs.slice(0, 4).map((log) => (
                <p key={log.id} className={`balku-logline balku-log-${log.tone}`}>
                  {log.text}
                </p>
              ))}
            </div>
          </aside>
        </div>

        {/* 下段：自分の領域（情報バー＋手札） */}
        <section ref={handZoneRef} className="balku-self" aria-label="あなたの領域">
          <div className="balku-infobar">
            <span className="balku-chip balku-chip-deck">
              <CardBack mini />
              <span className="balku-deckbar" aria-hidden="true">
                <span className="balku-deckbar-fill" style={{ width: `${deckPct}%` }} />
              </span>
              山札 {st.deckCount} / {st.deckInitialCount}
            </span>
            <span className="balku-chip">第{st.turn}ターン</span>
            <span key={myTurn ? `mine-${st.turn}` : "other"} className={`balku-chip${myTurn ? " balku-chip-now" : ""}`}>
              {me.eliminated ? "脱落（観戦中）" : myTurn ? `あなたの手番${turnSec !== null ? ` ・ あと${turnSec}秒` : ""}` : `${activePlayer?.name ?? ""}の手番${turnSec !== null ? ` ・ あと${turnSec}秒` : ""}`}
            </span>
            <span className="balku-chip">
              {me.coins}コイン / {myBreakdown.points} PT（提出{myBreakdown.submittedPoints}＋ボーナス{myBreakdown.bonusPoints}）
            </span>
            {myCharges.length > 0 && <span className="balku-chip">強制BALKU権 {myCharges.length}</span>}
            {syncMode === "polling" && <span className="balku-chip balku-sync-note">ポーリングで同期中</span>}
            <button type="button" className="balku-btn balku-btn-ghost balku-leave" onClick={leaveRoom} disabled={busy}>
              退出する
            </button>
          </div>

          <div className="balku-hand-tools">
            <button
              type="button"
              className={`balku-btn${sellMode ? " balku-btn-primary" : ""}`}
              disabled={!myTurn}
              onClick={() => {
                setSellMode((v) => !v);
                setSellIds([]);
                setSellMatCounts({});
                setSelectedProjectId(null);
                setAttachCounts({});
              }}
            >
              {sellMode ? "売却モードを終わる" : "売却モード"}
            </button>
            {sellMode && (
              <button type="button" className="balku-btn balku-btn-primary" disabled={busy || sellTotal === 0} onClick={() => doMove({ type: "sellCards", cardIds: sellCardIds })}>
                まとめて売却（{sellTotal}枚 → {sellTotal}コイン）
              </button>
            )}
            {!sellMode && myTurn && (
              <button type="button" className="balku-btn balku-btn-ghost" disabled={busy} onClick={() => doMove({ type: "endTurn" })}>
                パスする
              </button>
            )}
            <div
              ref={sellZoneRef}
              data-drop="sell"
              className={`balku-sellpocket${drag ? " balku-drop-armed" : ""}${dropHot === "sell" ? " balku-drop-hot" : ""}`}
            >
              売却ポケット
              <span>カードをドロップで +1コイン / 枚</span>
            </div>
          </div>

          <p className="balku-preview" aria-live="polite">
            {hoverCard ?? ""}
          </p>

          <div className="balku-fan" aria-label="企画カード">
            {handProjects.map((card, i) => {
              const ready = selectLegalMaterials(card, me.hand) !== null;
              const selected = selectedProjectId === card.id;
              const inSell = sellIds.includes(card.id);
              return (
                <button
                  key={card.id}
                  type="button"
                  data-hand-project={card.id}
                  style={i === 0 ? undefined : { marginLeft: projStep - 132 }}
                  className={`balku-card balku-fan-item balku-draggable${ready ? " balku-card-ready" : ""}${selected ? " balku-card-selected" : ""}${inSell ? " balku-card-sell" : ""}${dragProjectId === card.id ? " balku-card-ghost" : ""}`}
                  {...dragHandlers({ source: "hand-project", card }, card.name)}
                  onClick={() => (sellMode ? toggleProjectSell(card) : selectProject(card))}
                  onMouseEnter={() => setHoverCard(`${card.name}（${card.points} PT）：${card.effect.label}`)}
                  onMouseLeave={() => setHoverCard(null)}
                  onFocus={() => setHoverCard(`${card.name}（${card.points} PT）：${card.effect.label}`)}
                  onBlur={() => setHoverCard(null)}
                >
                  <span className="balku-card-head">
                    <strong>{card.name}</strong>
                    <span>{card.points} PT</span>
                  </span>
                  <span className="balku-card-effect">
                    {card.immediate ? "即時 / " : ""}
                    {card.effect.label}
                  </span>
                  <span className="balku-req-chips">
                    {Object.entries(card.requirements).length === 0 ? (
                      <span className="balku-req-chip balku-req-chip-ok">素材不要</span>
                    ) : (
                      Object.entries(card.requirements).map(([kind, need]) => {
                        const owned = ownedCount(kind as MaterialKind);
                        const ok = owned >= (need ?? 0);
                        return (
                          <span key={kind} className={`balku-req-chip${ok ? " balku-req-chip-ok" : " balku-req-chip-ng"}`}>
                            {kind} {owned}/{need}
                          </span>
                        );
                      })
                    )}
                  </span>
                  {ready && !sellMode && <span className="balku-badge balku-badge-ok">完成可能</span>}
                  {inSell && <span className="balku-badge balku-badge-hazard">売却選択中</span>}
                </button>
              );
            })}
            {handProjects.length === 0 && <p className="balku-table-note">企画カードはありません。</p>}
          </div>

          <div className="balku-fan balku-fan-mats" aria-label="素材カード">
            {matKindsInHand.map((kind, i) => {
              const owned = ownedCount(kind);
              const premium = handMaterials.some((c) => c.material === kind && c.rarity === "premium");
              const sellCount = Math.min(sellMatCounts[kind] ?? 0, owned);
              const attached = selectedProject && !sellMode ? attachOf(kind) : 0;
              return (
                <button
                  key={kind}
                  type="button"
                  style={i === 0 ? undefined : { marginLeft: matStep - 80 }}
                  className={`balku-matgroup balku-fan-item balku-draggable${sellMode && sellCount > 0 ? " balku-matgroup-sell" : ""}${attached > 0 ? " balku-matgroup-attached" : ""}${dragMatKind === kind && drag?.payload.source === "hand-material" ? " balku-card-ghost" : ""}`}
                  {...dragHandlers({ source: "hand-material", kind }, kind)}
                  onClick={() => {
                    if (suppressClickRef.current) return;
                    if (sellMode) cycleMatSell(kind);
                    else if (selectedProject && kind in selectedProject.requirements) {
                      playSe("play");
                      setAttachCounts((prev) => ({ ...prev, [kind]: Math.min(owned, attachOf(kind) + 1) }));
                    }
                  }}
                  onMouseEnter={() => setHoverCard(`${kind} ×${owned}${selectedProject ? "（タップ/ドロップで施工ゾーンへ添付）" : ""}`)}
                  onMouseLeave={() => setHoverCard(null)}
                  aria-label={`${kind} ${owned}枚${sellMode ? `（売却選択 ${sellCount}枚）` : ""}`}
                >
                  <MatFace kind={kind} premium={premium} />
                  <span className="balku-matgroup-count">×{owned}</span>
                  {sellMode && sellCount > 0 && <span className="balku-badge balku-badge-hazard">売却 {sellCount}</span>}
                  {attached > 0 && <span className="balku-badge balku-badge-ok">添付 {attached}</span>}
                </button>
              );
            })}
            {handMaterials.length === 0 && <p className="balku-table-note">素材はありません。</p>}
          </div>
        </section>
      </div>

      {drag && (
        <div
          className="balku-drag-clone"
          style={{ transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -72%) rotate(-3deg)` }}
          aria-hidden="true"
        >
          {drag.payload.source === "hand-project" ? (
            <span className="balku-card balku-card-small balku-card-static">
              <span className="balku-card-head">
                <strong>{drag.payload.card.name}</strong>
                <span>{drag.payload.card.points} PT</span>
              </span>
            </span>
          ) : (
            <MatFace kind={drag.payload.kind} premium={drag.payload.kind === "超伝導体"} />
          )}
        </div>
      )}
      {fly && (
        <div
          className="balku-fly-card"
          style={{
            left: fly.x,
            top: fly.y,
            width: fly.w,
            height: fly.h,
            transform: fly.go ? `translate(${fly.dx}px, ${fly.dy}px) scale(.55)` : "translate(0, 0)",
            opacity: fly.go ? 0.85 : 1,
          }}
          aria-hidden="true"
        >
          <strong>{fly.name}</strong>
        </div>
      )}
      {renderChat()}
    </>
  );
}
