"use client";

import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

type MusicSnapshot = {
  status: "idle" | "unsupported" | "loading" | "playing" | "paused";
  serverTime: number;
  videoId?: string;
  title?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  playbackRate?: number;
};

type TimedSnapshot = {
  value: MusicSnapshot;
  receivedAt: number;
  roundTripMs: number;
};

type PlayerEvent = { target: YouTubePlayer; data: number };
type PlayerOptions = {
  width: string;
  height: string;
  videoId?: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady: (event: PlayerEvent) => void;
    onStateChange: (event: PlayerEvent) => void;
    onError: (event: PlayerEvent) => void;
  };
};

type YouTubePlayer = {
  mute(): void;
  setVolume(volume: number): void;
  loadVideoById(options: { videoId: string; startSeconds: number }): void;
  cueVideoById(options: { videoId: string; startSeconds: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  setPlaybackRate(rate: number): void;
  getPlayerState(): number;
  destroy(): void;
};

type YouTubeApi = {
  Player: new (element: HTMLElement, options: PlayerOptions) => YouTubePlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; CUED: number };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeApi> | null = null;
let youtubeMappingsInstalledFor = "";

function loadYouTubeApi(clientId: string): Promise<YouTubeApi> {
  if (
    clientId &&
    window.location.hostname === `${clientId}.discordsays.com` &&
    youtubeMappingsInstalledFor !== clientId
  ) {
    patchUrlMappings([
      { prefix: "/youtube", target: "www.youtube.com" },
      { prefix: "/googlevideo/{subdomain}", target: "{subdomain}.googlevideo.com" },
      { prefix: "/ytimg", target: "i.ytimg.com" },
    ], { patchSrcAttributes: true });
    youtubeMappingsInstalledFor = clientId;
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const inDiscordProxy = clientId && window.location.hostname === `${clientId}.discordsays.com`;
    const timeout = window.setTimeout(() => reject(new Error("YouTubeプレイヤーの読み込みがタイムアウトしました。")), 15_000);
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      window.clearTimeout(timeout);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTubeプレイヤーを初期化できません。"));
    };
    const existing = document.querySelector<HTMLScriptElement>("script[data-activity-youtube-api]");
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.dataset.activityYoutubeApi = "true";
    if (!inDiscordProxy) {
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("YouTubeプレイヤーを読み込めません。"));
      };
    }
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function describeSnapshot(snapshot: MusicSnapshot | null) {
  if (!snapshot) return "Discordに接続しています…";
  if (snapshot.status === "idle") return "Musicの再生待ちです。";
  if (snapshot.status === "unsupported") return "この曲はYouTube動画を表示できません。";
  if (snapshot.status === "loading") return "動画を読み込んでいます…";
  if (snapshot.status === "paused") return "一時停止中";
  return "同期再生中";
}

function youtubeErrorMessage(code: number) {
  if (code === 101 || code === 150) return "この動画は外部プレイヤーでの再生が許可されていません。";
  if (code === 100) return "この動画は削除済み、非公開、または視聴できません。";
  if (code === 2) return "YouTube動画IDを確認できません。";
  return "YouTube動画を再生できません。";
}

export default function ActivityClient({ clientId }: { clientId: string }) {
  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerStateRef = useRef<YouTubeApi | null>(null);
  const playerReadyRef = useRef(false);
  const userStartedRef = useRef(false);
  const loadedVideoIdRef = useRef("");
  const latestSnapshotRef = useRef<TimedSnapshot | null>(null);
  const activityTokenRef = useRef("");
  const discordSdkRef = useRef<DiscordSDK | null>(null);
  const requestActivityAuthRef = useRef<(() => Promise<boolean>) | null>(null);
  const [snapshot, setSnapshot] = useState<MusicSnapshot | null>(null);
  const [statusMessage, setStatusMessage] = useState("Discordに接続しています…");
  const [playerReady, setPlayerReady] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [playerError, setPlayerError] = useState("");

  const startPlayer = useCallback(() => {
    const player = playerRef.current;
    const latest = latestSnapshotRef.current;
    if (!player || !latest?.value.videoId) return;
    const value = latest.value;
    const videoId = value.videoId;
    if (!videoId) return;
    userStartedRef.current = true;
    setHasStarted(true);
    player.mute();
    player.setVolume(0);
    const position = Math.max(0, value.positionSeconds || 0);
    if (value.status === "paused" || value.status === "loading") {
      player.cueVideoById({ videoId, startSeconds: position });
      loadedVideoIdRef.current = videoId;
    } else {
      player.loadVideoById({ videoId, startSeconds: position });
      loadedVideoIdRef.current = videoId;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;
    let pollMusic: () => Promise<void> = async () => {};

    const schedulePoll = (delayMs = 0) => {
      if (stopped || !activityTokenRef.current) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        pollTimer = undefined;
        void pollMusic();
      }, delayMs);
    };

    const applySnapshot = (value: MusicSnapshot, requestStartedAt: number) => {
      const receivedAt = performance.now();
      latestSnapshotRef.current = {
        value,
        receivedAt,
        roundTripMs: Math.max(0, receivedAt - requestStartedAt),
      };
      setSnapshot(value);
      setStatusMessage(describeSnapshot(value));
      if (playerRef.current && playerReadyRef.current && userStartedRef.current) {
        syncPlayer(playerRef.current, value, latestSnapshotRef.current, playerStateRef.current);
      }
    };

    const requestActivityAuth = async () => {
      const discordSdk = discordSdkRef.current;
      if (!discordSdk?.guildId || !discordSdk.channelId) {
        setStatusMessage("サーバーのボイスチャンネルからActivityを起動してください。");
        return false;
      }
      const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
      const verifier = encodeBase64Url(verifierBytes);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = encodeBase64Url(new Uint8Array(digest));
      const { code } = await discordSdk.commands.authorize({
        client_id: clientId,
        response_type: "code",
        scope: ["identify"],
        prompt: "none",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const response = await fetch("/api/activity/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          code,
          codeVerifier: verifier,
          guildId: discordSdk.guildId,
          channelId: discordSdk.channelId,
        }),
      });
      if (!response.ok) throw new Error("Discord認証を完了できませんでした。");
      const data = await response.json() as {
        accessToken?: string;
        activityToken?: string;
        expiresAt?: number;
      };
      if (!data.accessToken || !data.activityToken || typeof data.expiresAt !== "number") {
        throw new Error("Discord認証の応答が不正です。");
      }
      await discordSdk.commands.authenticate({ access_token: data.accessToken });
      activityTokenRef.current = data.activityToken;
      setAuthNeeded(false);
      setStatusMessage("Musicの再生状況を確認中…");
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        requestActivityAuth().catch(() => {
          if (stopped) return;
          activityTokenRef.current = "";
          setAuthNeeded(true);
          setStatusMessage("Discordとの接続を更新できませんでした。再接続してください。");
        });
      }, Math.max(30_000, data.expiresAt - Date.now() - 60_000));
      schedulePoll();
      return true;
    };
    requestActivityAuthRef.current = requestActivityAuth;

    pollMusic = async () => {
      if (stopped || !activityTokenRef.current) return;
      const requestStartedAt = performance.now();
      try {
        const response = await fetch("/api/activity/music-state", {
          headers: { Authorization: `Bearer ${activityTokenRef.current}` },
          cache: "no-store",
        });
        if (response.status === 401) {
          activityTokenRef.current = "";
          setAuthNeeded(true);
          setStatusMessage("認証の有効期限が切れました。Discordに再接続してください。");
          return;
        }
        if (response.status === 403) {
          applySnapshot({ status: "idle", serverTime: Date.now() / 1000 }, requestStartedAt);
          setStatusMessage("Music Botと同じボイスチャンネルに参加してください。");
        } else if (response.status === 429) {
          setStatusMessage("同期リクエストが混み合っています。少し待って再試行します。");
        } else if (!response.ok) {
          setStatusMessage("Musicの状態を取得できません。Botの接続を確認してください。");
        } else {
          applySnapshot(await response.json() as MusicSnapshot, requestStartedAt);
        }
      } catch {
        setStatusMessage("同期状態を取得できません。接続を確認しています…");
      } finally {
        schedulePoll(2_000);
      }
    };

    const connect = async () => {
      if (!clientId) throw new Error("DiscordアプリIDが設定されていません。");
      const discordSdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
      discordSdkRef.current = discordSdk;
      await discordSdk.ready();
      if (stopped) return;
      if (!discordSdk.guildId || !discordSdk.channelId) {
        setStatusMessage("サーバーのボイスチャンネルからActivityを起動してください。");
        return;
      }
      await requestActivityAuth();
    };

    connect().catch(() => {
      if (!stopped) {
        setAuthNeeded(true);
        setStatusMessage("Discord Activity内で起動し、接続を確認してください。");
      }
    });

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      activityTokenRef.current = "";
      requestActivityAuthRef.current = null;
      discordSdkRef.current = null;
    };
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    let player: YouTubePlayer | null = null;
    loadYouTubeApi(clientId).then((youtube) => {
      if (cancelled || !playerHostRef.current) return;
      playerStateRef.current = youtube;
      player = new youtube.Player(playerHostRef.current, {
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          fs: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (cancelled) {
              event.target.destroy();
              return;
            }
            playerRef.current = event.target;
            playerReadyRef.current = true;
            event.target.mute();
            event.target.setVolume(0);
            setPlayerReady(true);
            const latest = latestSnapshotRef.current;
            if (latest && userStartedRef.current) {
              syncPlayer(event.target, latest.value, latest, youtube);
            }
          },
          onStateChange: (event) => {
            if (cancelled) return;
            event.target.mute();
            event.target.setVolume(0);
          },
          onError: (event) => {
            if (!cancelled) setPlayerError(youtubeErrorMessage(event.data));
          },
        },
      });
      playerRef.current = player;
    }).catch((error: unknown) => {
      if (!cancelled) setPlayerError(error instanceof Error ? error.message : "YouTubeプレイヤーを読み込めません。");
    });
    return () => {
      cancelled = true;
      playerReadyRef.current = false;
      setPlayerReady(false);
      player?.destroy();
      playerRef.current = null;
      playerStateRef.current = null;
    };
  }, []);

  const reconnect = async () => {
    setStatusMessage("Discordに再接続しています…");
    setAuthNeeded(false);
    try {
      const requestAuth = requestActivityAuthRef.current;
      if (!requestAuth || !await requestAuth()) throw new Error("Discord認証を完了できませんでした。");
      setAuthNeeded(false);
      setStatusMessage("再接続しました。同期状態を取得します…");
    } catch {
      setAuthNeeded(true);
      setStatusMessage("再接続できませんでした。Activityを開き直してください。");
    }
  };

  return (
    <section className="activity-screen" data-activity-root="">
      <div className="activity-content">
        <div className="activity-heading">
          <span className="activity-eyebrow">AGOBOT</span>
          <h1>Music Video</h1>
        </div>
        <p className="activity-status" role="status" aria-live="polite">{statusMessage}</p>
        {snapshot?.title && <p className="activity-track-title">{snapshot.title}</p>}
        <div className="activity-player-frame" data-started={hasStarted ? "true" : "false"}>
          <div className="activity-player-host" ref={playerHostRef} aria-label="YouTube動画プレイヤー" />
          {!snapshot?.videoId && (
            <div className="activity-player-placeholder">
              {snapshot?.status === "unsupported" ? "YouTube動画を表示できません" : "Musicの再生を待っています"}
            </div>
          )}
        </div>
        <div className="activity-actions">
          <button
            type="button"
            className="activity-button"
            onClick={startPlayer}
            disabled={!playerReady || !snapshot?.videoId}
          >
            同期して再生
          </button>
          {authNeeded && <button type="button" className="activity-button activity-button-secondary" onClick={reconnect}>Discordに再接続</button>}
        </div>
        <p className="activity-note">映像は無音です。音声はボイスチャンネルのMusicから再生されます。</p>
        {playerError && <p className="activity-error" role="alert">{playerError}</p>}
      </div>
    </section>
  );

  function syncPlayer(
    player: YouTubePlayer,
    value: MusicSnapshot,
    timed: TimedSnapshot,
    youtube: YouTubeApi | null,
  ) {
    if (!userStartedRef.current) return;
    player.mute();
    player.setVolume(0);
    if (value.status === "idle" || value.status === "unsupported" || !value.videoId) {
      player.stopVideo();
      loadedVideoIdRef.current = "";
      return;
    }

    const rttCorrection = Math.max(0, timed.roundTripMs / 2);
    const timeSinceResponse = Math.max(0, performance.now() - timed.receivedAt);
    const rate = value.playbackRate || 1;
    const expectedPosition = Math.max(0, (value.positionSeconds || 0) +
      (value.status === "playing" ? ((rttCorrection + timeSinceResponse) / 1000) * rate : 0));
    const playerState = player.getPlayerState();

    if (loadedVideoIdRef.current !== value.videoId || (playerState === youtube?.PlayerState.ENDED && value.status === "playing")) {
      if (value.status === "playing") {
        player.loadVideoById({ videoId: value.videoId, startSeconds: expectedPosition });
      } else {
        player.cueVideoById({ videoId: value.videoId, startSeconds: expectedPosition });
      }
      loadedVideoIdRef.current = value.videoId;
      return;
    }

    if (value.status === "loading") {
      if (playerState === youtube?.PlayerState.PLAYING) player.pauseVideo();
      return;
    }
    if (value.status === "paused") {
      if (playerState === youtube?.PlayerState.PLAYING) player.pauseVideo();
    } else if (value.status === "playing" && playerState !== youtube?.PlayerState.PLAYING) {
      player.playVideo();
    }

    if (value.status === "playing" || value.status === "paused") {
      try {
        const availableRates = player.getAvailablePlaybackRates();
        const exactRate = availableRates.find((candidate) => Math.abs(candidate - rate) < 0.01);
        if (exactRate && Math.abs(player.getPlaybackRate() - exactRate) >= 0.01) {
          player.setPlaybackRate(exactRate);
        }
      } catch {
        // Some videos do not expose speed controls; drift correction below remains authoritative.
      }
      const actualPosition = player.getCurrentTime();
      if (Number.isFinite(actualPosition) && Math.abs(actualPosition - expectedPosition) > 1.75) {
        player.seekTo(expectedPosition, true);
      }
    }
  }
}
