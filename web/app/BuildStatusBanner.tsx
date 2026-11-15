"use client";

import { useEffect, useState } from "react";
import {
  isActivelyBuilding,
  prUrl,
  type BuildStatus,
} from "@/lib/build-status";

const POLL_MS = 15_000;

/**
 * ビルド中だけ全ページ上部に出る帯。デプロイスクリプトが書く状態ファイルを
 * /api/build-status 経由でポーリングし、ビルド中の PR 番号を表示する。
 * ビルドが終われば（状態が deployed/failed になれば）帯は消える。
 * 共通クローム内（SiteChrome）に置くため、分離画面には出ない。
 */
export default function BuildStatusBanner() {
  const [status, setStatus] = useState<BuildStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/build-status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { status?: BuildStatus | null };
        if (!cancelled) setStatus(data.status ?? null);
      } catch {
        // 取得失敗時は帯を出さない（前回値も残さない）
        if (!cancelled) setStatus(null);
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (status === null || !isActivelyBuilding(status)) return null;

  const firstTitle = status.prs.find((pr) => pr.title)?.title ?? "";

  return (
    <div className="build-banner" role="status">
      <div className="build-banner-inner">
        <span className="build-banner-dot" aria-hidden="true" />
        <p className="build-banner-text">
          {status.prs.length > 0 ? (
            <>
              {status.prs.map((pr, i) => (
                <span key={pr.number}>
                  {i > 0 ? "・" : null}
                  <a href={prUrl(pr.number)} target="_blank" rel="noreferrer">
                    PR #{pr.number}
                  </a>
                </span>
              ))}
              {" をビルド中…"}
            </>
          ) : (
            "新しいバージョンをビルド中…"
          )}
          {firstTitle ? <span className="build-banner-title">{firstTitle}</span> : null}
        </p>
      </div>
    </div>
  );
}
