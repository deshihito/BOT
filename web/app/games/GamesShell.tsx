"use client";
// /games 配下の共通シェル。Discord アクティビティ（iframe 埋め込み）で
// 開かれたことを検出したら、サイト共通ヘッダー/フッターを消す
// 埋め込みモード（data-activity-root、globals.css の既存仕組み）に切り替え、
// Embedded App SDK の ready() を呼ぶ。通常のブラウザではそのまま表示し、
// SDK の初期化に失敗しても白画面にはしない（フォールバックは通常表示）。
import { DiscordSDK } from "@discord/embedded-app-sdk";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  roomFromShareCustomId,
  shareCustomIdForRoom,
  type DiscordIdentity,
} from "@/lib/discord-activity";
import { authenticateDiscordIdentity } from "@/lib/discord-activity-client";

export type GamesNav = {
  /** Discord アクティビティ内かどうか。 */
  embedded: boolean;
  /** アクティビティのプロキシ配下では "/.proxy"、通常は ""。内部リンクの接頭辞。 */
  prefix: string;
  /** 本人確認で得た Discord 本人情報。未認証・通常ブラウザでは null。 */
  identity: DiscordIdentity | null;
  /**
   * Discord の共有モーダルでルーム招待を送る。Activity 内でのみ有効で、
   * それ以外は null。成功可否を返す（失敗時は呼び出し側がリンクコピーに倒す）。
   */
  shareRoomInvite: ((gameId: string, code: string) => Promise<boolean>) | null;
};

const GamesNavContext = createContext<GamesNav>({ embedded: false, prefix: "", identity: null, shareRoomInvite: null });

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

const ROUTED_CUSTOM_ID_KEY = "agobot:invite-routed-custom-id";

export default function GamesShell({ clientId, children }: { clientId: string; children: ReactNode }) {
  const [embedded, setEmbedded] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [identity, setIdentity] = useState<DiscordIdentity | null>(null);
  const sdkRef = useRef<DiscordSDK | null>(null);
  const sdkStartedRef = useRef(false);
  const authStartedRef = useRef(false);

  // Discord の共有モーダルでルーム招待を送る（custom_id に宛先を運ぶ）。
  const shareRoomInvite = useCallback(async (gameId: string, code: string): Promise<boolean> => {
    const sdk = sdkRef.current;
    const customId = shareCustomIdForRoom(gameId, code);
    if (!sdk || !customId) return false;
    try {
      const result = await sdk.commands.shareLink({
        message: `AGOBOT ゲームで対戦しよう（ルームコード: ${code}）`,
        custom_id: customId,
      });
      return Boolean(result.success);
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Discord のプロキシ配下（/.proxy/...）では内部リンクにも接頭辞が要る
    const proxyPrefix =
      window.location.pathname.startsWith("/.proxy/") || window.location.pathname === "/.proxy" ? "/.proxy" : "";
    if (proxyPrefix) setPrefix(proxyPrefix);
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
    // 共有リンクから起動された場合（custom_id にルーム宛先が入っている）は、
    // ハブに着地した時点でそのゲームの招待画面へ直行する。
    if (fromDiscord || stored) {
      const target = roomFromShareCustomId(new URLSearchParams(window.location.search).get("custom_id"));
      const barePath = proxyPrefix ? window.location.pathname.slice(proxyPrefix.length) || "/" : window.location.pathname;
      if (target && (barePath === "/games" || barePath === "/")) {
        let alreadyRouted = false;
        try {
          alreadyRouted = sessionStorage.getItem(ROUTED_CUSTOM_ID_KEY) === target.code;
          if (!alreadyRouted) sessionStorage.setItem(ROUTED_CUSTOM_ID_KEY, target.code);
        } catch {
          // 保存できなくても遷移自体は行う
        }
        if (!alreadyRouted) {
          window.location.assign(`${proxyPrefix}/games/${target.gameId}?room=${target.code}`);
          return;
        }
      }
    }
    if (!clientId || sdkStartedRef.current) return;
    if (!fromDiscord && !stored && !inIframe) return;
    sdkStartedRef.current = true;
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    sdkRef.current = sdk;
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("Discord SDK ready timeout")), SDK_READY_TIMEOUT_MS);
    });
    Promise.race([sdk.ready(), timeout])
      .then(() => {
        if (cancelled) return;
        setEmbedded(true);
        storeEmbedded();
        // 本人確認は ready の後に1回だけ。失敗しても表示は通常どおり続ける
        // （オンライン対戦の名前/アバター既定値が取れないだけ）。
        if (!authStartedRef.current) {
          authStartedRef.current = true;
          void authenticateDiscordIdentity(sdk, clientId).then((result) => {
            if (!cancelled && result) setIdentity(result);
          });
        }
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
    <GamesNavContext.Provider value={{ embedded, prefix, identity, shareRoomInvite: embedded ? shareRoomInvite : null }}>
      <div className="games-shell" {...(embedded ? { "data-activity-root": "" } : {})}>
        {embedded && (
          <nav className="games-embedded-bar" aria-label="ゲームメニュー">
            <span className="games-embedded-brand">AGOBOT ゲーム</span>
            <span className="games-embedded-links">
              <Link href={`${prefix}/games`}>ゲーム一覧</Link>
            </span>
            {identity && (
              <span className="games-embedded-identity">
                <img src={identity.avatarUrl} alt="" width={24} height={24} />
                {identity.name}
              </span>
            )}
          </nav>
        )}
        {children}
      </div>
    </GamesNavContext.Provider>
  );
}
