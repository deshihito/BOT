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
  type GameCard,
  type MaterialCard,
  type MaterialKind,
  type ProjectCard,
  type SnapshotPlayer,
  type SnapshotSubmission,
} from "@/lib/balku-game";
import { useGamesNav } from "../GamesShell";

const SESSION_KEY = "balku-room-session";
const NAME_KEY = "balku-display-name";

type Session = { code: string; playerToken: string };
type RoomView = {
  code: string;
  status: BalkuSnapshot["phase"];
  revision: number;
  maxPlayers: number;
  player: { seat: number; displayName: string; isHost: boolean };
  state: BalkuSnapshot;
};
type PublicRoom = { code: string; maxPlayers: number; playerCount: number; createdAt: number };

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
  const [selectedMats, setSelectedMats] = useState<string[]>([]);
  const [targetSeat, setTargetSeat] = useState<number | undefined>(undefined);
  const [sellMode, setSellMode] = useState(false);
  const [sellIds, setSellIds] = useState<string[]>([]);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  viewRef.current = view;

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
      setSelectedMats([]);
      setTargetSeat(undefined);
    }
    if (me) {
      setSellIds((ids) => ids.filter((id) => me.hand.some((c) => c.id === id)));
    }
    // me の同一性はポーリングごとに変わるため、手札の中身で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.turn, state?.activeSeat, me?.hand.length]);

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

  // --- 待機画面 ---
  if (view.status === "lobby") {
    return (
      <>
        {header}
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
            {st.players.map((p) => (
              <div key={p.seat} className="balku-player-row">
                <span>
                  {p.name}
                  {p.seat === mySeat ? "（あなた）" : ""}
                  {p.seat === 0 ? "（ホスト）" : ""}
                </span>
              </div>
            ))}
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
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出
            </button>
          </div>
          {isHost && st.players.length < 2 && <p className="muted">2人以上で開始できます。</p>}
        </section>
      </>
    );
  }

  // --- 終了画面 ---
  if (view.status === "finished") {
    const winnerNames = st.finalScores.filter((s) => st.winnerSeats.includes(s.seat)).map((s) => s.name);
    return (
      <>
        {header}
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
  const selectedMaterialCards = handMaterials.filter((c) => selectedMats.includes(c.id));
  const selectedLegal = selectedProject ? isLegalSubmission(selectedProject, selectedMaterialCards) : false;
  const needsTarget = selectedProject ? TARGETED_EFFECTS.includes(selectedProject.effect.type) : false;
  const opponents = st.players.filter((p) => p.seat !== mySeat);

  const ownedCount = (kind: MaterialKind) => handMaterials.filter((c) => c.material === kind).length;

  const selectProject = (card: ProjectCard) => {
    setSellMode(false);
    if (selectedProjectId === card.id) {
      setSelectedProjectId(null);
      setSelectedMats([]);
      return;
    }
    setSelectedProjectId(card.id);
    const legal = selectLegalMaterials(card, me.hand);
    if (legal) {
      setSelectedMats(legal.map((m) => m.id));
    } else {
      // 足りない場合は、条件に噛む手持ち素材をすべて仮選択する
      const partial: string[] = [];
      for (const [kind, amount] of Object.entries(card.requirements)) {
        const owned = handMaterials.filter((c) => c.material === kind);
        partial.push(...owned.slice(0, amount ?? 0).map((c) => c.id));
      }
      setSelectedMats(partial);
    }
    setTargetSeat(undefined);
  };

  const toggleCard = (card: GameCard) => {
    if (sellMode) {
      setSellIds((ids) => (ids.includes(card.id) ? ids.filter((id) => id !== card.id) : [...ids, card.id]));
      return;
    }
    if (card.kind === "material" && selectedProject) {
      setSelectedMats((ids) => (ids.includes(card.id) ? ids.filter((id) => id !== card.id) : [...ids, card.id]));
    }
  };

  const submitSelected = (faceUp: boolean) => {
    if (!selectedProject) return;
    void doMove({
      type: "submit",
      projectId: selectedProject.id,
      materialIds: selectedMats,
      faceUp,
      ...(needsTarget && targetSeat !== undefined ? { targetSeat } : {}),
    });
    setSelectedProjectId(null);
    setSelectedMats([]);
    setTargetSeat(undefined);
  };

  const renderBundle = (owner: SnapshotPlayer, sub: SnapshotSubmission) => {
    const isMine = owner.seat === mySeat;
    const keyBase = `${owner.seat}:${sub.id}`;
    if (!sub.faceUp) {
      return (
        <div key={sub.id} className="balku-bundle balku-bundle-down">
          <div className="balku-bundle-main">
            <span className="balku-bundle-name">{isMine ? sub.project.name : "伏せ企画"}</span>
            <span className="balku-badge balku-badge-hazard">伏せ</span>
            <span className="muted">素材 {sub.materialCount}枚</span>
            {isMine && <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>}
          </div>
          {!isMine && !me.eliminated && renderBulkButtons(owner, sub, keyBase)}
        </div>
      );
    }
    return (
      <div key={sub.id} className="balku-bundle">
        <div className="balku-bundle-main">
          <span className="balku-bundle-name">{sub.project.name}</span>
          <span>{sub.project.points} PT</span>
          <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>
          <span className="muted">素材 {sub.materialCount}枚</span>
        </div>
        <p className="balku-bundle-effect">{sub.project.effect.label}</p>
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

  return (
    <>
      {header}
      <div className="balku-topbar">
        <div className="balku-deck">
          <div className="balku-deckbar" aria-hidden="true">
            <div className="balku-deckbar-fill" style={{ width: `${deckPct}%` }} />
          </div>
          <span>
            山札 {st.deckCount} / {st.deckInitialCount}
          </span>
        </div>
        <span>第{st.turn}ターン</span>
        <span className={myTurn ? "balku-turn-now" : ""}>
          {me.eliminated ? "あなたは脱落しました（観戦中）" : myTurn ? `あなたの手番です${turnSec !== null ? `（あと${turnSec}秒）` : ""}` : `${activePlayer?.name ?? ""}の手番${turnSec !== null ? `（あと${turnSec}秒）` : ""}`}
        </span>
        <span>
          あなた: {me.coins}コイン / {myBreakdown.points} PT（提出{myBreakdown.submittedPoints}＋ボーナス{myBreakdown.bonusPoints}）
          {myCharges.length > 0 ? ` / 強制BALKU権 ${myCharges.length}` : ""}
        </span>
        {syncMode === "polling" && <span className="balku-sync-note">ポーリングで同期中</span>}
      </div>

      {st.auction && (
        <div className="balku-auction" role="status">
          <strong>オークション</strong>
          <span>
            「{st.auction.card.name}」
            {st.auction.card.kind === "project" ? `（${(st.auction.card as ProjectCard).points} PT / ${(st.auction.card as ProjectCard).effect.label}）` : "（素材）"}
          </span>
          <span>
            現在 {st.auction.highestBid}コイン
            {st.auction.highestBidderSeat !== null ? `（${st.players.find((p) => p.seat === st.auction!.highestBidderSeat)?.name ?? ""}）` : "（入札なし）"}
          </span>
          <span>あと{auctionSec ?? 0}秒</span>
          <div className="balku-actions">
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
          </div>
          <span className="muted">落札額の支払いは期限の決済時です。</span>
        </div>
      )}

      <h2 className="balku-section-title">他社</h2>
      <div className="balku-opponents">
        {opponents.map((p) => (
          <section key={p.seat} className={`balku-opponent${st.activeSeat === p.seat ? " balku-opponent-active" : ""}`}>
            <div className="balku-opponent-head">
              <strong>{p.name}</strong>
              {p.eliminated ? (
                <span className="balku-badge balku-badge-bad">脱落</span>
              ) : (
                <span className="muted">
                  手札 {p.handCount}枚 / {p.coins}コイン / {getTotalPoints(p)} PT
                  {st.activeSeat === p.seat && turnSec !== null ? ` / あと${turnSec}秒` : ""}
                </span>
              )}
            </div>
            <div className="balku-bundles">
              {p.submitted.length === 0 ? <p className="muted">提出なし</p> : p.submitted.map((sub) => renderBundle(p, sub))}
            </div>
          </section>
        ))}
      </div>

      <h2 className="balku-section-title">あなたの提出</h2>
      <div className="balku-bundles">
        {me.submitted.length === 0 ? <p className="muted">まだ提出していません。</p> : me.submitted.map((sub) => renderBundle(me, sub))}
      </div>

      <h2 className="balku-section-title">調達市場</h2>
      <div className="balku-market">
        {MARKET_MATERIALS.map((kind) => (
          <button key={kind} type="button" className="balku-market-chip" disabled={busy || !myTurn || me.coins < getMarketPrice(kind)} onClick={() => doMove({ type: "buyMaterial", material: kind })}>
            {kind} <span>{getMarketPrice(kind)}コイン</span>
          </button>
        ))}
      </div>
      <p className="muted">市場での購入は自分の手番中のみ。購入しても手番は進みません。</p>

      <h2 className="balku-section-title">あなたの手札</h2>
      <div className="balku-hand-tools">
        <button
          type="button"
          className={`balku-btn${sellMode ? " balku-btn-primary" : ""}`}
          disabled={!myTurn}
          onClick={() => {
            setSellMode((v) => !v);
            setSellIds([]);
            setSelectedProjectId(null);
          }}
        >
          {sellMode ? "売却モードを終わる" : "売却モード"}
        </button>
        {sellMode && (
          <>
            <span className="muted">カードをタップして選択（1枚1コイン、手番は進みません）</span>
            <button type="button" className="balku-btn balku-btn-primary" disabled={busy || sellIds.length === 0} onClick={() => doMove({ type: "sellCards", cardIds: sellIds })}>
              まとめて売却（{sellIds.length}枚 → {sellIds.length}コイン）
            </button>
          </>
        )}
        {!sellMode && myTurn && (
          <button type="button" className="balku-btn balku-btn-ghost" disabled={busy} onClick={() => doMove({ type: "endTurn" })}>
            パスする
          </button>
        )}
      </div>

      <div className="balku-proj-grid">
        {handProjects.map((card) => {
          const ready = selectLegalMaterials(card, me.hand) !== null;
          const selected = selectedProjectId === card.id;
          const inSell = sellIds.includes(card.id);
          return (
            <button
              key={card.id}
              type="button"
              className={`balku-card${ready ? " balku-card-ready" : ""}${selected ? " balku-card-selected" : ""}${inSell ? " balku-card-sell" : ""}`}
              onClick={() => (sellMode ? toggleCard(card) : selectProject(card))}
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
      </div>

      <div className="balku-mats" aria-label="素材">
        {handMaterials.map((card) => {
          const inSell = sellIds.includes(card.id);
          const inSubmit = selectedMats.includes(card.id);
          return (
            <button
              key={card.id}
              type="button"
              className={`balku-mat-chip${inSubmit ? " balku-mat-chip-selected" : ""}${inSell ? " balku-mat-chip-sell" : ""}`}
              onClick={() => toggleCard(card)}
            >
              {card.material}
              {card.rarity === "premium" ? " ★" : ""}
            </button>
          );
        })}
        {handMaterials.length === 0 && <span className="muted">素材はありません。</span>}
      </div>

      {selectedProject && !sellMode && (
        <section className="balku-submit-panel">
          <h3>
            提出: {selectedProject.name}（{selectedProject.points} PT）
          </h3>
          <p className="muted">
            {selectedProject.effect.label} / 添付素材 {selectedMaterialCards.length}枚（手札の素材をタップで付け外し）
          </p>
          <p className={selectedLegal ? "balku-legal-ok" : "balku-legal-ng"}>
            {selectedLegal
              ? "素材条件を満たしています（正規完成）。"
              : `素材が不足しています。不足: ${Object.entries(selectedProject.requirements)
                  .map(([kind, need]) => {
                    const have = selectedMaterialCards.filter((c) => c.material === kind).length;
                    return have < (need ?? 0) ? `${kind} あと${(need ?? 0) - have}枚` : "";
                  })
                  .filter(Boolean)
                  .join(" / ")}`}
          </p>
          {needsTarget && (
            <div className="balku-field">
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
          {!selectedLegal && <p className="balku-legal-ng">素材不足のまま公開すると違法建築になり、BALKUで接収されます。</p>}
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
                setSelectedMats([]);
                setTargetSeat(undefined);
              }}
            >
              選択をやめる
            </button>
          </div>
          {!myTurn && <p className="muted">提出は自分の手番中のみです。</p>}
        </section>
      )}

      <h2 className="balku-section-title">ログ</h2>
      <ul className="balku-log">
        {st.logs.slice(0, 6).map((log) => (
          <li key={log.id} className={`balku-log-${log.tone}`}>
            {log.text}
          </li>
        ))}
      </ul>
      <div className="balku-actions">
        <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
          退出する
        </button>
      </div>
    </>
  );
}
