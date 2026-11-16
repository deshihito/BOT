"use client";
// AGO WORLD BOX のアーケード筐体パネル（ロビー 2F/3F の筐体専用、L4）。
// 筐体の前に立つとそのゲームのパネルが出る。ルームの作成・参加は既存の
// オンライン基盤（/api/online/<game>/rooms）へそのまま投げ、セッションを
// sessionStorage（online:<gameId>、useOnlineRoom と同じ形式）に保存してから
// ゲームページへ遷移する。ゲームページ側の OnlineShell がセッションを復元し、
// 待機ロビーから対戦が始まる。新しいネットコードは作らない。
import { useEffect, useState } from "react";
import { getWebGame } from "@/lib/games-catalog";

type PublicRoom = { code: string; playerCount?: number; maxPlayers?: number };

const wrap: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 20px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  boxSizing: "border-box", padding: 16, borderRadius: 14,
  background: "rgba(12,14,22,0.94)", color: "#fff", zIndex: 6,
  boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
};
const btn: React.CSSProperties = {
  minHeight: 40, padding: "6px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 14, cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn, background: "#2f7fd0", border: "1px solid #2f7fd0", fontWeight: 700,
};
const input: React.CSSProperties = {
  minHeight: 40, padding: "6px 10px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, boxSizing: "border-box",
};

async function postJson(url: string, body: unknown): Promise<{ res: Response; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, data };
}

export default function WorldBoxArcadePanel({
  gameId,
  prefix,
  defaultName,
  avatarUrl,
  onClose,
}: {
  gameId: string;
  prefix: string;
  defaultName: string;
  avatarUrl?: string;
  onClose: () => void;
}) {
  const game = getWebGame(gameId);
  const title = game?.title ?? gameId;
  const [name, setName] = useState<string>(() => {
    try {
      return localStorage.getItem("online-display-name") || defaultName || "";
    } catch {
      return defaultName || "";
    }
  });
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const base = `/api/online/${encodeURIComponent(gameId)}`;

  // 公開ルーム一覧（OnlineShell と同じく4秒ごとに更新）
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${base}/rooms/public`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rooms?: PublicRoom[] };
        if (!cancelled) setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      } catch {
        // 一覧が取れなくても作成・コード参加はできる
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [base]);

  const enterRoom = (code: string, token: string) => {
    try {
      sessionStorage.setItem(`online:${gameId}`, JSON.stringify({ code, token }));
    } catch {
      // 保存できなくても遷移先でコード参加できる
    }
    window.location.assign(`${prefix}/games/${gameId}`);
  };

  const validName = (): string | null => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("名前は2〜24文字で入力してください。");
      return null;
    }
    try {
      localStorage.setItem("online-display-name", trimmed);
    } catch {
      // 保存できなくてもよい
    }
    return trimmed;
  };

  const createRoom = async () => {
    const displayName = validName();
    if (!displayName || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`${base}/rooms`, {
        displayName,
        isPublic: true,
        ...(avatarUrl ? { avatarUrl } : {}),
      });
      const token = typeof data.playerToken === "string" ? data.playerToken : typeof data.token === "string" ? data.token : "";
      if (!res.ok || typeof data.code !== "string" || !token) {
        setError(typeof data.error === "string" ? data.error : "ルームを作成できませんでした。");
        return;
      }
      enterRoom(data.code, token);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (rawCode: string) => {
    const displayName = validName();
    if (!displayName || busy) return;
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      setError("ルームコードは6文字で入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`${base}/rooms/join`, {
        code,
        displayName,
        ...(avatarUrl ? { avatarUrl } : {}),
      });
      const token = typeof data.playerToken === "string" ? data.playerToken : typeof data.token === "string" ? data.token : "";
      if (!res.ok || typeof data.code !== "string" || !token) {
        setError(typeof data.error === "string" ? data.error : "参加できませんでした。");
        return;
      }
      enterRoom(data.code, token);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap} role="dialog" aria-label={`${title} の筐体`}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
        {game?.players && <span style={{ fontSize: 12, opacity: 0.75 }}>{game.players}</span>}
        <button type="button" style={{ ...btn, minHeight: 32, marginLeft: "auto", padding: "2px 10px" }} onClick={onClose}>
          閉じる
        </button>
      </div>

      <label style={{ display: "block", marginTop: 14, fontSize: 13 }}>
        あなたの名前
        <input
          style={{ ...input, width: "100%", marginTop: 6 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="2〜24文字"
          maxLength={24}
          aria-label="あなたの名前"
        />
      </label>

      <button type="button" style={{ ...btnPrimary, width: "100%", marginTop: 12 }} disabled={busy} onClick={() => void createRoom()}>
        ルームを作成して遊ぶ
      </button>

      <h4 style={{ margin: "16px 0 8px", fontSize: 14 }}>公開ルーム</h4>
      {rooms.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>いま入れる公開ルームはありません。</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rooms.map((room) => {
            const full = room.maxPlayers !== undefined && room.playerCount !== undefined && room.playerCount >= room.maxPlayers;
            return (
              <div key={room.code} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 700, letterSpacing: 1 }}>{room.code}</span>
                {room.playerCount !== undefined && (
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                    {room.playerCount}
                    {room.maxPlayers !== undefined ? ` / ${room.maxPlayers}` : ""} 人
                  </span>
                )}
                <button
                  type="button"
                  style={{ ...btn, minHeight: 34, marginLeft: "auto", padding: "2px 12px" }}
                  disabled={busy || full}
                  onClick={() => void joinRoom(room.code)}
                >
                  参加
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input
          style={{ ...input, flex: 1, textTransform: "uppercase" }}
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="コード6文字"
          maxLength={6}
          aria-label="ルームコード"
        />
        <button type="button" style={btn} disabled={busy} onClick={() => void joinRoom(joinCode)}>
          参加
        </button>
      </div>

      {error && (
        <p role="alert" style={{ margin: "12px 0 0", fontSize: 13, color: "#ff9d9d" }}>
          {error}
        </p>
      )}
    </div>
  );
}
