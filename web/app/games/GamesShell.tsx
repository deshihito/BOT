"use client";
// /games 配下の共通シェル。Discord アクティビティ（iframe 埋め込み）で
// 開かれたことを検出したら、サイト共通ヘッダー/フッターを消す
// 埋め込みモード（data-activity-root、globals.css の既存仕組み）に切り替え、
// Embedded App SDK の ready() を呼ぶ。通常のブラウザではそのまま表示し、
// SDK の初期化に失敗しても白画面にはしない（フォールバックは通常表示）。
import { DiscordSDK } from "@discord/embedded-app-sdk";
import Link from "next/link";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type GamesNav = {
  /** Discord アクティビティ内かどうか。 */
  embedded: boolean;
  /** アクティビティのプロキシ配下では "/.proxy"、通常は ""。内部リンクの接頭辞。 */
  prefix: string;
};

const GamesNavContext = createContext<GamesNav>({ embedded: false, prefix: "" });

export function useGamesNav(): GamesNav {
  return useContext(GamesNavContext);
}

const STORAGE_KEY = "agobot:activity-embedded";
const SDK_READY_TIMEOUT_MS = 4000;

function hasActivityParams(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has("frame_id") && params.has("instance_id");
}

function readStoredEmbedded(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeEmbedded() {
  try {
    sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 保存できなくても表示は続けられる
  }
}

export default function GamesShell({ clientId, children }: { clientId: string; children: ReactNode }) {
  const [embedded, setEmbedded] = useState(false);
  const [prefix, setPrefix] = useState("");
  const sdkStartedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Discord のプロキシ配下（/.proxy/...）では内部リンクにも接頭辞が要る
    if (window.location.pathname.startsWith("/.proxy/") || window.location.pathname === "/.proxy") {
      setPrefix("/.proxy");
    }
    const fromDiscord = hasActivityParams();
    const stored = readStoredEmbedded();
    let inIframe = false;
    try {
      inIframe = window.self !== window.top;
    } catch {
      inIframe = true;
    }
    if (fromDiscord || stored) {
      setEmbedded(true);
      storeEmbedded();
    }
    if (!clientId || sdkStartedRef.current) return;
    if (!fromDiscord && !stored && !inIframe) return;
    sdkStartedRef.current = true;
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("Discord SDK ready timeout")), SDK_READY_TIMEOUT_MS);
    });
    Promise.race([sdk.ready(), timeout])
      .then(() => {
        if (cancelled) return;
        setEmbedded(true);
        storeEmbedded();
      })
      .catch(() => {
        if (cancelled) return;
        // 起動パラメータも保存済みフラグも無いのに ready できない場合は、
        // Discord 内ではないとみなして通常表示に戻す。
        if (!fromDiscord && !stored) setEmbedded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return (
    <GamesNavContext.Provider value={{ embedded, prefix }}>
      <div className="games-shell" {...(embedded ? { "data-activity-root": "" } : {})}>
        {embedded && (
          <nav className="games-embedded-bar" aria-label="ゲームメニュー">
            <span className="games-embedded-brand">AGOBOT ゲーム</span>
            <Link href={`${prefix}/games`}>ゲーム一覧</Link>
          </nav>
        )}
        {children}
      </div>
    </GamesNavContext.Provider>
  );
}
