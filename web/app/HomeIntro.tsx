"use client";

// ホームページを開いた直後の導入演出（クライアント専用）。
// 白い画面いっぱいにアイコンと名前 → フェードしてキャッチコピー →
// フェードして通常のホームページ、の順で表示する。
// クリックまたはキー入力で即座にスキップできる。同じブラウザの
// セッションでは1回だけ表示し、モーション軽減の設定では表示しない。
import { useEffect, useState } from "react";

type Stage = "brand" | "tagline" | "leaving" | "done";

const SEEN_KEY = "agobot-home-intro-seen-v1";

export default function HomeIntro() {
  const [stage, setStage] = useState<Stage>("brand");

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
    if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage("done");
      return;
    }
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // 保存できなくても演出は続行する
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setStage("tagline"), 1500));
    timers.push(setTimeout(() => setStage("leaving"), 3200));
    timers.push(setTimeout(() => setStage("done"), 3900));
    const skip = () => {
      timers.forEach(clearTimeout);
      setStage((current) => (current === "done" ? current : "leaving"));
      timers.push(setTimeout(() => setStage("done"), 380));
    };
    window.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
    };
  }, []);

  // 演出の間は背景のスクロールを止める
  useEffect(() => {
    if (stage === "done") return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [stage]);

  if (stage === "done") return null;
  return (
    <div className={stage === "leaving" ? "home-intro home-intro-leaving" : "home-intro"} aria-hidden="true">
      <noscript>
        <style>{`.home-intro{display:none}`}</style>
      </noscript>
      <div className={stage === "brand" ? "home-intro-brand home-intro-show" : "home-intro-brand"}>
        <img src="/img/nomal.png" alt="" />
        <span>AGOBOT</span>
      </div>
      <p className={stage === "tagline" ? "home-intro-tagline home-intro-show" : "home-intro-tagline"}>
        使いたいこと、全部このボットでいい。
      </p>
    </div>
  );
}
