"use client";
// オンライン対戦の共通枠組み。ルーム作成/参加・待機ロビー・チャット・
// サウンド設定・エラー表示を担い、対戦中/終了時の盤面は children の
// render prop（view, api）へ委ねる。サイト側クロームは出さない
// （GamesShell / ページ側の担当）ため、埋め込みでもそのまま動作する。
// ゲーム固有の作成オプションは createOptions 経由で差し込む:
//   - ReactNode を渡す場合、その中の入力部品は useOnlineCreateOptions()
//     フックで { options, setOptions } を読み書きし、作成時に options として送られる
//   - 関数（render prop）を渡す場合は同じ { options, setOptions } を引数で受け取る
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { loadSoundSettings, playSe, saveSoundSettings, unlockAudio, type BalkuSoundSettings } from "@/lib/balku-sound";
import { inviteUrlForGame, roomCodeFromSearch } from "@/lib/discord-activity";
import { useGamesNav } from "../GamesShell";
import { useOnlineRoom, type OnlineRoomApi, type OnlineRoomView } from "./useOnlineRoom";

export type OnlineCreateOptionsState = {
  options: unknown;
  setOptions: (next: unknown) => void;
};

const CreateOptionsContext = createContext<OnlineCreateOptionsState>({ options: undefined, setOptions: () => undefined });

/** createOptions の中から作成オプション値を読み書きするためのフック。 */
export function useOnlineCreateOptions(): OnlineCreateOptionsState {
  return useContext(CreateOptionsContext);
}

export type OnlineShellProps = {
  gameId: string;
  title: string;
  /** 人数セレクトを出すための作成可能レンジ（min<max のときだけ表示）。 */
  playerRange?: { min: number; max: number };
  createOptions?: ReactNode | ((state: OnlineCreateOptionsState) => ReactNode);
  children: (view: OnlineRoomView, api: OnlineRoomApi) => ReactNode;
};

export default function OnlineShell({ gameId, title, playerRange, createOptions, children }: OnlineShellProps) {
  const api = useOnlineRoom(gameId);
  const { session, view } = api;
  const nav = useGamesNav();
  const identity = nav.identity;
  const [createMax, setCreateMax] = useState<number>(playerRange?.min ?? 2);
  const [isPublic, setIsPublic] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [options, setOptions] = useState<unknown>(undefined);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [soundSettings, setSoundSettings] = useState<BalkuSoundSettings>({ bgm: true, se: true });
  const [chatText, setChatText] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const chatListRef = useRef<HTMLDivElement | null>(null);

  const optionsState: OnlineCreateOptionsState = { options, setOptions: useCallback((next: unknown) => setOptions(next), []) };

  // --- サウンド（SE ミュート切替のみ。設定は balku-sound の保存形式を共有） ---
  useEffect(() => {
    setSoundSettings(loadSoundSettings());
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  const toggleSe = () => {
    unlockAudio();
    const next = { ...soundSettings, se: !soundSettings.se };
    setSoundSettings(next);
    saveSoundSettings(next);
    if (next.se) playSe("click");
  };

  useEffect(() => {
    if (api.error) playSe("error");
  }, [api.error]);

  // チャットは新しい順に追従して末尾へスクロール
  const chatMessages = view?.chat ?? [];
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages.length, view?.revision]);

  const copyCode = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      api.setNotice(`ルームコード: ${session.code}`);
    }
  };

  // 招待リンクは公開 URL（開くとそのまま参加フローに入る形）でコピーする。
  const copyInviteLink = async () => {
    if (!session) return;
    const url = inviteUrlForGame(gameId, session.code);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1500);
    } catch {
      api.setNotice(`招待リンク: ${url}`);
    }
  };

  // Discord 内では共有モーダルを優先し、使えなければリンクコピーに倒す。
  const shareInvite = async () => {
    if (!session) return;
    if (nav.shareRoomInvite && (await nav.shareRoomInvite(gameId, session.code))) return;
    await copyInviteLink();
  };

  // 招待リンク（?room=）から開かれたら、コード入力を経ずに参加パネルを出す。
  useEffect(() => {
    const code = roomCodeFromSearch(window.location.search);
    if (code) {
      setInviteCode(code);
      setJoinCode(code);
    }
  }, []);

  // Discord 本人確認が取れていて保存名が無いときだけ、表示名の既定値にする
  // （ユーザーが自分で決めた名前は上書きしない）。
  const identityAppliedRef = useRef(false);
  useEffect(() => {
    if (!identity || identityAppliedRef.current) return;
    identityAppliedRef.current = true;
    let stored = "";
    try {
      stored = localStorage.getItem("online-display-name") ?? "";
    } catch {
      // 読めなくても既定値の適用は試みる
    }
    if (!stored) api.setDisplayName(identity.name);
    // api は毎レンダー変わるため、identity の到着時だけに限定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const joinInvite = async () => {
    if (!inviteCode) return;
    if (await api.joinRoom(inviteCode, api.displayName, identity?.avatarUrl)) {
      setInviteCode(null);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("room");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // URL を戻せなくても参加自体は成立している
      }
    }
  };

  const sendChat = async () => {
    const text = chatText.trim();
    if (!text || chatSending) return;
    setChatSending(true);
    try {
      if (await api.postChat(text)) {
        setChatText("");
        playSe("click");
      }
    } finally {
      setChatSending(false);
    }
  };

  const renderChat = () => {
    if (!view?.chatEnabled) return null;
    const mySeat = view.player.seat;
    return (
      <section className="og-chat" aria-label="ルームチャット">
        <h3 className="og-chat-title">チャット</h3>
        <div className="og-chat-list" ref={chatListRef}>
          {chatMessages.length === 0 ? (
            <p className="og-chat-empty">まだメッセージはありません。</p>
          ) : (
            chatMessages.map((m) => (
              <div key={m.id} className={`og-chat-msg${m.playerId === mySeat ? " og-chat-mine" : ""}`}>
                <span className="og-chat-meta">
                  {m.name}
                  <span className="og-chat-time">{new Date(m.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
                </span>
                <span className="og-chat-text">{m.text}</span>
              </div>
            ))
          )}
        </div>
        <form
          className="og-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            void sendChat();
          }}
        >
          <input
            className="og-chat-input"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder="メッセージ（200文字まで）"
            aria-label="チャットメッセージ"
            maxLength={200}
          />
          <button type="submit" className="og-btn og-btn-primary og-chat-send" disabled={chatSending || chatText.trim().length === 0}>
            送信
          </button>
        </form>
      </section>
    );
  };

  const header = (
    <div className="og-header">
      <h2 className="og-title">{title}</h2>
      <div className="og-soundbar" role="group" aria-label="サウンド設定">
        <button
          type="button"
          className={`og-sound-btn${soundSettings.se ? " og-sound-on" : ""}`}
          aria-pressed={soundSettings.se}
          onClick={toggleSe}
        >
          SE {soundSettings.se ? "ON" : "OFF"}
        </button>
      </div>
      {session && (
        <div className="og-room-bar">
          <span className="og-room-code">{session.code}</span>
          <button type="button" className="og-btn og-btn-small" onClick={copyCode}>
            {copied ? "コピーしました" : "コードをコピー"}
          </button>
          <button type="button" className="og-btn og-btn-small" onClick={() => void copyInviteLink()}>
            {copiedLink ? "コピーしました" : "招待リンクをコピー"}
          </button>
          {nav.shareRoomInvite && (
            <button type="button" className="og-btn og-btn-small" onClick={() => void shareInvite()}>
              Discordで招待
            </button>
          )}
          <span className="og-sync">{api.syncMode === "sse" ? "接続中" : "接続中（ポーリング）"}</span>
        </div>
      )}
      {api.error && (
        <p className="og-error" role="alert">
          {api.error}
        </p>
      )}
      {api.notice && <p className="og-notice">{api.notice}</p>}
    </div>
  );

  // --- セッションなし: 作成 / 参加 / 公開ルーム ---
  if (!session) {
    const range = playerRange && playerRange.max > playerRange.min ? playerRange : null;
    const counts: number[] = [];
    if (range) for (let n = range.min; n <= range.max; n += 1) counts.push(n);
    return (
      <div className="og-shell">
        {header}
        <div className="og-entry">
          {inviteCode && (
            <section className="og-panel og-invite-panel">
              <h3>ルーム {inviteCode} への招待</h3>
              <label className="og-field">
                <span>あなたの名前</span>
                <input
                  className="og-input"
                  value={api.displayName}
                  onChange={(e) => api.setDisplayName(e.target.value)}
                  placeholder="2〜24文字"
                  maxLength={24}
                />
              </label>
              <div className="og-actions">
                <button type="button" className="og-btn og-btn-primary" disabled={api.busy} onClick={() => void joinInvite()}>
                  このルームに参加
                </button>
                <button type="button" className="og-btn og-btn-ghost" onClick={() => setInviteCode(null)}>
                  閉じる
                </button>
              </div>
            </section>
          )}
          <section className="og-panel">
            <h3>ルームを作成 / 参加</h3>
            <label className="og-field">
              <span>あなたの名前</span>
              <input
                className="og-input"
                value={api.displayName}
                onChange={(e) => api.setDisplayName(e.target.value)}
                placeholder="2〜24文字"
                maxLength={24}
              />
            </label>
            {range && (
              <div className="og-field">
                <span>人数（作成時）</span>
                <div className="og-segmented" role="group" aria-label="人数">
                  {counts.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={createMax === n}
                      className={createMax === n ? "og-segmented-active" : ""}
                      onClick={() => setCreateMax(n)}
                    >
                      {n}人
                    </button>
                  ))}
                </div>
              </div>
            )}
            <CreateOptionsContext.Provider value={optionsState}>
              {typeof createOptions === "function" ? (createOptions as (s: OnlineCreateOptionsState) => ReactNode)(optionsState) : createOptions}
            </CreateOptionsContext.Provider>
            <label className="og-check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              公開ルームにする（一覧に載せる）
            </label>
            <button
              type="button"
              className="og-btn og-btn-primary"
              disabled={api.busy}
              onClick={() =>
                void api.createRoom({
                  displayName: api.displayName,
                  ...(range ? { maxPlayers: createMax } : {}),
                  isPublic,
                  ...(options !== undefined ? { options } : {}),
                  ...(identity ? { avatarUrl: identity.avatarUrl } : {}),
                })
              }
            >
              ルームを作成
            </button>
            <div className="og-join-row">
              <input
                className="og-input og-code-input"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="コード6文字"
                maxLength={6}
                aria-label="ルームコード"
              />
              <button type="button" className="og-btn" disabled={api.busy} onClick={() => void api.joinRoom(joinCode, api.displayName, identity?.avatarUrl)}>
                参加
              </button>
            </div>
          </section>
          <section className="og-panel">
            <h3>公開ルーム</h3>
            {api.publicRooms.length === 0 ? (
              <p className="og-muted">いま入れる公開ルームはありません。</p>
            ) : (
              <div className="og-public-list">
                {api.publicRooms.map((room) => {
                  const full = room.maxPlayers !== undefined && room.playerCount !== undefined && room.playerCount >= room.maxPlayers;
                  return (
                    <div key={room.code} className="og-public-row">
                      <span className="og-public-code">{room.code}</span>
                      {room.playerCount !== undefined && (
                        <span className="og-muted">
                          {room.playerCount}
                          {room.maxPlayers !== undefined ? ` / ${room.maxPlayers}` : ""} 人
                        </span>
                      )}
                      <button type="button" className="og-btn" disabled={api.busy || full} onClick={() => void api.joinRoom(room.code, api.displayName, identity?.avatarUrl)}>
                        参加
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  // --- 接続中 ---
  if (!view) {
    return (
      <div className="og-shell">
        {header}
        <p className="og-muted og-connecting">ルーム {session.code} に接続中…</p>
        <button type="button" className="og-btn og-btn-ghost" onClick={api.disconnect}>
          接続をやめる
        </button>
      </div>
    );
  }

  const isHost = view.player.isHost;
  const mySeat = view.player.seat;
  const isCpuSeat = (seat: number) => view.cpuSeats.includes(seat) || view.players.find((p) => p.seat === seat)?.isCpu === true;

  // --- 待機ロビー ---
  if (view.status === "lobby") {
    const shortage = Math.max(0, view.minPlayers - view.players.length);
    return (
      <div className="og-shell">
        {header}
        <div className="og-main">
          <section className="og-panel og-lobby">
            <h3>待機中</h3>
            <p className="og-muted">招待リンクかコードを共有すると、他のプレイヤーが参加できます。</p>
            <div className="og-player-list">
              {view.players.map((p) => (
                <div key={p.seat} className={`og-player-row${p.seat === mySeat ? " og-player-me" : ""}`}>
                  <span className="og-player-name">
                    {p.avatar && <img className="og-avatar" src={p.avatar} alt="" width={24} height={24} />}
                    {p.name}
                    {p.seat === mySeat ? "（あなた）" : ""}
                    {p.isHost && <span className="og-badge og-badge-host">ホスト</span>}
                    {isCpuSeat(p.seat) && <span className="og-badge og-badge-cpu">CPU</span>}
                  </span>
                  {isHost && isCpuSeat(p.seat) && (
                    <button type="button" className="og-btn og-btn-ghost og-btn-small" disabled={api.busy} onClick={() => void api.setCpu("remove", p.seat)}>
                      外す
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="og-muted">
              {view.players.length} / {view.maxPlayers} 人
            </p>
            <div className="og-actions">
              {isHost ? (
                <button type="button" className="og-btn og-btn-primary" disabled={api.busy || shortage > 0} onClick={() => void api.start()}>
                  対戦を開始
                </button>
              ) : (
                <p className="og-muted">ホストの開始を待っています…</p>
              )}
              {isHost && view.cpuSupported && view.players.length < view.maxPlayers && (
                <button type="button" className="og-btn" disabled={api.busy} onClick={() => void api.setCpu("add")}>
                  CPUを追加
                </button>
              )}
              <button type="button" className="og-btn" onClick={() => void copyInviteLink()}>
                {copiedLink ? "コピーしました" : "招待リンクをコピー"}
              </button>
              {nav.shareRoomInvite && (
                <button type="button" className="og-btn" onClick={() => void shareInvite()}>
                  Discordで招待
                </button>
              )}
              <button type="button" className="og-btn og-btn-ghost" disabled={api.busy} onClick={() => void api.leave()}>
                退出
              </button>
            </div>
            {isHost && shortage > 0 && <p className="og-muted">あと{shortage}人で開始できます。参加者を待つか、CPUを追加してください。</p>}
          </section>
          {renderChat()}
        </div>
      </div>
    );
  }

  // --- 対戦中 / 終了: 盤面は children が描く ---
  const finished = view.status === "finished";
  return (
    <div className="og-shell">
      {header}
      <div className="og-main">
        <div className="og-game-area">{children(view, api)}</div>
        {renderChat()}
      </div>
      <div className="og-actions og-footer-actions">
        {finished && isHost && (
          <button type="button" className="og-btn og-btn-primary" disabled={api.busy} onClick={() => void api.restart()}>
            再戦（ロビーへ戻る）
          </button>
        )}
        {finished && !isHost && <p className="og-muted">再戦の準備はホストが行います。</p>}
        <button type="button" className="og-btn og-btn-ghost" disabled={api.busy} onClick={() => void api.leave()}>
          退出
        </button>
      </div>
    </div>
  );
}
