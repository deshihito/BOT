"use client";
import { DiscordSDK } from "@discord/embedded-app-sdk";
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
type TimedSnapshot = { value: MusicSnapshot; receivedAt: number; roundTripMs: number };

declare global {
  interface Window { __activityToken?: string }
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function describeSnapshot(snapshot: MusicSnapshot | null) {
  if (!snapshot) return "Discordに接続しています…";
  if (snapshot.status === "idle") return "Musicの再生待ちです。";
  if (snapshot.status === "unsupported") return "この曲は動画を表示できません。";
  if (snapshot.status === "loading") return "動画を読み込んでいます…";
  if (snapshot.status === "paused") return "一時停止中";
  return "同期再生中";
}

export default function ActivityClient({ clientId }: { clientId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSnapshotRef = useRef<TimedSnapshot | null>(null);
  const activityTokenRef = useRef("");
  const discordSdkRef = useRef<DiscordSDK | null>(null);
  const requestActivityAuthRef = useRef<(() => Promise<boolean>) | null>(null);
  const startedRef = useRef(false);
  const loadedVideoIdRef = useRef("");
  const [snapshot, setSnapshot] = useState<MusicSnapshot | null>(null);
  const [statusMessage, setStatusMessage] = useState("Discordに接続しています…");
  const [hasStarted, setHasStarted] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [videoError, setVideoError] = useState("");

  const expectedPosition = useCallback((timed: TimedSnapshot) => {
    const value = timed.value;
    const correction = Math.max(0, timed.roundTripMs / 2) + Math.max(0, performance.now() - timed.receivedAt);
    return Math.max(0, (value.positionSeconds || 0) + (value.status === "playing" ? correction / 1000 * (value.playbackRate || 1) : 0));
  }, []);

  const syncVideo = useCallback((timed: TimedSnapshot) => {
    const video = videoRef.current;
    const value = timed.value;
    if (!video || !startedRef.current) return;
    if (!value.videoId || value.status === "idle" || value.status === "unsupported") {
      video.pause();
      return;
    }
    if (loadedVideoIdRef.current !== value.videoId) {
      loadedVideoIdRef.current = value.videoId;
      video.src = `/api/activity/music-video?token=${encodeURIComponent(activityTokenRef.current)}&videoId=${encodeURIComponent(value.videoId)}`;
      video.load();
      video.currentTime = expectedPosition(timed);
    }
    const position = expectedPosition(timed);
    if (Number.isFinite(video.currentTime) && Math.abs(video.currentTime - position) > 1.75) video.currentTime = position;
    if (value.playbackRate && video.playbackRate !== value.playbackRate) video.playbackRate = value.playbackRate;
    if (value.status === "paused" || value.status === "loading") video.pause();
    if (value.status === "playing") void video.play().catch(() => setStatusMessage("動画の再生には「同期して再生」を押してください。"));
  }, [expectedPosition]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;
    const schedulePoll = (delay = 0) => {
      if (stopped || !activityTokenRef.current) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => void pollMusic(), delay);
    };
    const applySnapshot = (value: MusicSnapshot, startedAt: number) => {
      const receivedAt = performance.now();
      const timed = { value, receivedAt, roundTripMs: Math.max(0, receivedAt - startedAt) };
      latestSnapshotRef.current = timed;
      setSnapshot(value);
      setStatusMessage(describeSnapshot(value));
      syncVideo(timed);
    };
    const requestActivityAuth = async () => {
      const sdk = discordSdkRef.current;
      if (!sdk?.guildId || !sdk.channelId) {
        setStatusMessage("サーバーのボイスチャンネルからActivityを起動してください。");
        return false;
      }
      const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
      const verifier = encodeBase64Url(verifierBytes);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = encodeBase64Url(new Uint8Array(digest));
      const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: "code", scope: ["identify"], prompt: "none", code_challenge: challenge, code_challenge_method: "S256" });
      const response = await fetch("/api/activity/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, codeVerifier: verifier, guildId: sdk.guildId, channelId: sdk.channelId }) });
      if (!response.ok) throw new Error("Discord認証を完了できませんでした。");
      const data = await response.json() as { accessToken?: string; activityToken?: string; expiresAt?: number };
      if (!data.accessToken || !data.activityToken || typeof data.expiresAt !== "number") throw new Error("Discord認証の応答が不正です。");
      await sdk.commands.authenticate({ access_token: data.accessToken });
      activityTokenRef.current = data.activityToken;
      setAuthNeeded(false);
      setStatusMessage("Musicの再生状況を確認中…");
      refreshTimer = window.setTimeout(() => { void requestActivityAuth().catch(() => { activityTokenRef.current = ""; setAuthNeeded(true); }); }, Math.max(30_000, data.expiresAt - Date.now() - 60_000));
      schedulePoll();
      return true;
    };
    requestActivityAuthRef.current = requestActivityAuth;
    const pollMusic = async () => {
      if (stopped || !activityTokenRef.current) return;
      const startedAt = performance.now();
      try {
        const response = await fetch("/api/activity/music-state", { headers: { Authorization: `Bearer ${activityTokenRef.current}` }, cache: "no-store" });
        if (response.status === 401) { activityTokenRef.current = ""; setAuthNeeded(true); setStatusMessage("認証の有効期限が切れました。Discordに再接続してください。"); }
        else if (response.status === 403) applySnapshot({ status: "idle", serverTime: Date.now() / 1000 }, startedAt);
        else if (response.ok) applySnapshot(await response.json() as MusicSnapshot, startedAt);
        else setStatusMessage("Musicの状態を取得できません。Botの接続を確認してください。");
      } catch { setStatusMessage("同期状態を取得できません。接続を確認しています…"); }
      finally { schedulePoll(2_000); }
    };
    const connect = async () => {
      if (!clientId) throw new Error("DiscordアプリIDが設定されていません。");
      const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
      discordSdkRef.current = sdk;
      await sdk.ready();
      if (!sdk.guildId || !sdk.channelId) { setStatusMessage("サーバーのボイスチャンネルからActivityを起動してください。"); return; }
      await requestActivityAuth();
    };
    void connect().catch(() => { if (!stopped) { setAuthNeeded(true); setStatusMessage("Discord Activity内で起動し、接続を確認してください。"); } });
    return () => { stopped = true; if (pollTimer) clearTimeout(pollTimer); if (refreshTimer) clearTimeout(refreshTimer); activityTokenRef.current = ""; requestActivityAuthRef.current = null; discordSdkRef.current = null; };
  }, [clientId, syncVideo]);

  const startPlayer = () => {
    const video = videoRef.current;
    const timed = latestSnapshotRef.current;
    if (!video || !timed?.value.videoId) return;
    startedRef.current = true;
    setHasStarted(true);
    loadedVideoIdRef.current = "";
    syncVideo(timed);
    void video.play().catch(() => setVideoError("動画を再生できません。"));
  };
  const reconnect = async () => {
    try { setStatusMessage("Discordに再接続しています…"); if (!requestActivityAuthRef.current || !await requestActivityAuthRef.current()) throw new Error(); }
    catch { setAuthNeeded(true); setStatusMessage("再接続できませんでした。Activityを開き直してください。"); }
  };

  return <section className="activity-screen" data-activity-root=""><div className="activity-content">
    <div className="activity-heading"><span className="activity-eyebrow">AGOBOT</span><h1>Music Video</h1></div>
    <p className="activity-status" role="status" aria-live="polite">{statusMessage}</p>
    {snapshot?.title && <p className="activity-track-title">{snapshot.title}</p>}
    <div className="activity-player-frame" data-started={hasStarted ? "true" : "false"}>
      <video ref={videoRef} className="activity-video" playsInline muted controls={false} onError={() => setVideoError("動画の取得または再生に失敗しました。")} />
      {!snapshot?.videoId && <div className="activity-player-placeholder">{snapshot?.status === "unsupported" ? "動画を表示できません" : "Musicの再生を待っています"}</div>}
    </div>
    <div className="activity-actions"><button type="button" className="activity-button" onClick={startPlayer} disabled={!snapshot?.videoId}>同期して再生</button>{authNeeded && <button type="button" className="activity-button activity-button-secondary" onClick={reconnect}>Discordに再接続</button>}</div>
    <p className="activity-note">映像は無音です。音声はボイスチャンネルのMusicから再生されます。</p>
    {videoError && <p className="activity-error" role="alert">{videoError}</p>}
  </div></section>;
}
