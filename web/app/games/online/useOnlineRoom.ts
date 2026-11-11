"use client";
// オンライン対戦の共通クライアント基盤（BALKU の実績パターンの一般化）。
// ルーム作成・参加は REST、同期は SSE（GET /api/online/<game>/rooms/<code>/events）
// が主経路で、接続できない環境では1秒間隔ポーリングに自動フォールバックする。
// セッション（ルームコードとプレイヤートークン）は sessionStorage の
// `online:<gameId>` に保存し、再訪時に復帰を試みる。表示名は
// localStorage の "online-display-name" に全ゲーム共通で保持する。
// ビューは revision が新しいものだけを採用する（古い応答で巻き戻さない）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { OnlineRoomView } from "@/lib/online/server";

export type { OnlineRoomView };

export type OnlineSession = { code: string; token: string };

export type PublicOnlineRoom = {
  code: string;
  maxPlayers?: number;
  playerCount?: number;
  createdAt?: number;
  [key: string]: unknown;
};

export type CreateOnlineRoomInput = {
  displayName: string;
  maxPlayers?: number;
  isPublic: boolean;
  options?: unknown;
};

export type OnlineRoomApi = {
  gameId: string;
  session: OnlineSession | null;
  view: OnlineRoomView | null;
  error: string;
  notice: string;
  busy: boolean;
  syncMode: "sse" | "polling";
  publicRooms: PublicOnlineRoom[];
  displayName: string;
  setDisplayName: (value: string) => void;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
  createRoom: (input: CreateOnlineRoomInput) => Promise<boolean>;
  joinRoom: (code: string, displayName: string) => Promise<boolean>;
  start: () => Promise<boolean>;
  restart: () => Promise<boolean>;
  leave: () => Promise<void>;
  move: (action: unknown) => Promise<boolean>;
  postChat: (text: string) => Promise<boolean>;
  setCpu: (action: "add" | "remove", seat?: number) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  disconnect: () => void;
};

const NAME_KEY = "online-display-name";

function sessionKey(gameId: string): string {
  return `online:${gameId}`;
}

function loadSession(gameId: string): OnlineSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(gameId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnlineSession> & { playerToken?: string };
    const token = typeof parsed.token === "string" ? parsed.token : typeof parsed.playerToken === "string" ? parsed.playerToken : null;
    return typeof parsed.code === "string" && token ? { code: parsed.code, token } : null;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<{ res: Response; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, data };
}

function errorText(data: Record<string, unknown>, fallback: string): string {
  return typeof data.error === "string" ? data.error : fallback;
}

export function useOnlineRoom(gameId: string): OnlineRoomApi {
  const [session, setSession] = useState<OnlineSession | null>(null);
  const [view, setView] = useState<OnlineRoomView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncMode, setSyncMode] = useState<"sse" | "polling">("sse");
  const [publicRooms, setPublicRooms] = useState<PublicOnlineRoom[]>([]);
  const [displayName, setDisplayNameState] = useState("");
  const viewRef = useRef<OnlineRoomView | null>(null);
  const sessionRef = useRef<OnlineSession | null>(null);
  sessionRef.current = session;

  const base = `/api/online/${encodeURIComponent(gameId)}`;

  const saveSession = useCallback(
    (next: OnlineSession | null) => {
      try {
        if (next) sessionStorage.setItem(sessionKey(gameId), JSON.stringify(next));
        else sessionStorage.removeItem(sessionKey(gameId));
      } catch {
        // 保存できなくても対戦は続けられる
      }
      sessionRef.current = next;
      setSession(next);
      if (!next) {
        viewRef.current = null;
        setView(null);
      }
    },
    [gameId],
  );

  // revision が新しいビューだけを採用する
  const adoptView = useCallback((next: OnlineRoomView) => {
    const current = viewRef.current;
    if (current && current.code === next.code && next.revision < current.revision) return;
    viewRef.current = next;
    setView(next);
  }, []);

  const setDisplayName = useCallback((value: string) => {
    setDisplayNameState(value);
    try {
      localStorage.setItem(NAME_KEY, value);
    } catch {
      // 保存できなくてもよい
    }
  }, []);

  // --- セッション復元と表示名 ---
  useEffect(() => {
    setSession(loadSession(gameId));
    try {
      setDisplayNameState(localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      // 保存名が無くてもよい
    }
  }, [gameId]);

  // --- 同期 ---
  const fetchView = useCallback(
    async (target: OnlineSession): Promise<boolean> => {
      try {
        const res = await fetch(`${base}/rooms/${target.code}?token=${encodeURIComponent(target.token)}`, { cache: "no-store" });
        if (res.status === 403 || res.status === 404) {
          setError("ルームから切断されました。");
          saveSession(null);
          return false;
        }
        if (!res.ok) return false;
        adoptView((await res.json()) as OnlineRoomView);
        return true;
      } catch {
        return false;
      }
    },
    [base, saveSession, adoptView],
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
      es = new EventSource(`${base}/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
      es.onmessage = (event) => {
        try {
          adoptView(JSON.parse(event.data as string) as OnlineRoomView);
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
  }, [session, base, fetchView, saveSession, adoptView]);

  // 公開ルーム一覧（セッションが無い間だけ4秒ごとに自動更新）
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${base}/rooms/public`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rooms?: PublicOnlineRoom[] };
        if (!cancelled) setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
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
  }, [session, base]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const target = sessionRef.current;
    if (!target) return false;
    return fetchView(target);
  }, [fetchView]);

  const disconnect = useCallback(() => {
    saveSession(null);
    setError("");
    setNotice("");
  }, [saveSession]);

  // --- 操作 ---
  const validName = useCallback((raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("名前は2〜24文字で入力してください。");
      return null;
    }
    return trimmed;
  }, []);

  const createRoom = useCallback(
    async (input: CreateOnlineRoomInput): Promise<boolean> => {
      const name = validName(input.displayName);
      if (!name || busy) return false;
      setBusy(true);
      setError("");
      try {
        const { res, data } = await postJson(`${base}/rooms`, {
          displayName: name,
          ...(input.maxPlayers !== undefined ? { maxPlayers: input.maxPlayers } : {}),
          isPublic: input.isPublic,
          ...(input.options !== undefined ? { options: input.options } : {}),
        });
        if (!res.ok) {
          setError(errorText(data, "ルームを作成できませんでした。"));
          return false;
        }
        const token = typeof data.playerToken === "string" ? data.playerToken : typeof data.token === "string" ? data.token : "";
        if (typeof data.code !== "string" || !token) {
          setError("ルームを作成できませんでした。");
          return false;
        }
        setDisplayName(name);
        saveSession({ code: data.code, token });
        return true;
      } catch {
        setError("通信に失敗しました。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, busy, validName, saveSession, setDisplayName],
  );

  const joinRoom = useCallback(
    async (code: string, rawName: string): Promise<boolean> => {
      const name = validName(rawName);
      if (!name || busy) return false;
      const normalized = code.trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(normalized)) {
        setError("ルームコードは6文字で入力してください。");
        return false;
      }
      setBusy(true);
      setError("");
      try {
        const { res, data } = await postJson(`${base}/rooms/join`, { code: normalized, displayName: name });
        if (!res.ok) {
          setError(errorText(data, "参加できませんでした。"));
          return false;
        }
        const token = typeof data.playerToken === "string" ? data.playerToken : typeof data.token === "string" ? data.token : "";
        if (typeof data.code !== "string" || !token) {
          setError("参加できませんでした。");
          return false;
        }
        setDisplayName(name);
        saveSession({ code: data.code, token });
        return true;
      } catch {
        setError("通信に失敗しました。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, busy, validName, saveSession, setDisplayName],
  );

  /** playerToken + expectedRevision を付けて POST する共通経路。409 では最新ビューを取り直す。 */
  const postWithRevision = useCallback(
    async (kind: string, extra: Record<string, unknown>, fallback: string): Promise<boolean> => {
      const target = sessionRef.current;
      const current = viewRef.current;
      if (!target || !current || busy) return false;
      setBusy(true);
      setError("");
      try {
        const { res, data } = await postJson(`${base}/rooms/${target.code}/${kind}`, {
          playerToken: target.token,
          expectedRevision: current.revision,
          ...extra,
        });
        if (res.status === 409) {
          setNotice(errorText(data, "盤面が更新されました。"));
          await fetchView(target);
          return false;
        }
        if (!res.ok) {
          setError(errorText(data, fallback));
          return false;
        }
        await fetchView(target);
        return true;
      } catch {
        setError("通信に失敗しました。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, busy, fetchView],
  );

  const start = useCallback(() => postWithRevision("start", {}, "対戦を開始できませんでした。"), [postWithRevision]);
  const restart = useCallback(() => postWithRevision("restart", {}, "再戦を準備できませんでした。"), [postWithRevision]);
  const move = useCallback((action: unknown) => postWithRevision("move", { action }, "操作できませんでした。"), [postWithRevision]);

  const leave = useCallback(async (): Promise<void> => {
    const target = sessionRef.current;
    if (!target || busy) return;
    const current = viewRef.current;
    setBusy(true);
    try {
      if (current) {
        const { res, data } = await postJson(`${base}/rooms/${target.code}/leave`, {
          playerToken: target.token,
          expectedRevision: current.revision,
        });
        if (res.status === 409) {
          setNotice(errorText(data, "盤面が更新されました。もう一度退出してください。"));
          await fetchView(target);
          return;
        }
      }
      saveSession(null);
      setError("");
      setNotice("");
    } catch {
      // 通信できなくても手元のセッションは破棄する
      saveSession(null);
    } finally {
      setBusy(false);
    }
  }, [base, busy, fetchView, saveSession]);

  const postChat = useCallback(
    async (text: string): Promise<boolean> => {
      const target = sessionRef.current;
      const trimmed = text.trim();
      if (!target || !trimmed || busy) return false;
      setBusy(true);
      setError("");
      try {
        const { res, data } = await postJson(`${base}/rooms/${target.code}/chat`, {
          playerToken: target.token,
          text: trimmed,
        });
        if (!res.ok) {
          setError(errorText(data, "メッセージを送信できませんでした。"));
          return false;
        }
        await fetchView(target);
        return true;
      } catch {
        setError("通信に失敗しました。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, busy, fetchView],
  );

  const setCpu = useCallback(
    async (action: "add" | "remove", seat?: number): Promise<boolean> => {
      const target = sessionRef.current;
      if (!target || busy) return false;
      setBusy(true);
      setError("");
      try {
        const { res, data } = await postJson(`${base}/rooms/${target.code}/cpu`, {
          playerToken: target.token,
          action,
          ...(seat !== undefined ? { seat } : {}),
        });
        if (res.status === 409) {
          setNotice(errorText(data, "盤面が更新されました。"));
          await fetchView(target);
          return false;
        }
        if (!res.ok) {
          setError(errorText(data, "CPUを操作できませんでした。"));
          return false;
        }
        await fetchView(target);
        return true;
      } catch {
        setError("通信に失敗しました。");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [base, busy, fetchView],
  );

  return {
    gameId,
    session,
    view,
    error,
    notice,
    busy,
    syncMode,
    publicRooms,
    displayName,
    setDisplayName,
    setError,
    setNotice,
    createRoom,
    joinRoom,
    start,
    restart,
    leave,
    move,
    postChat,
    setCpu,
    refresh,
    disconnect,
  };
}
