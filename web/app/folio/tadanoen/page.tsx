import type { Metadata } from "next";

// ============================================================
// ポートフォリオ枠: tadanoen の割り当てファイル（1人1ファイル）
// ------------------------------------------------------------
// このファイルが tadanoen.agobot.app の実体。編集権は本人にあり、
// 中身（文章・実績・リンク等）は本人が書く。管理側が用意するのは
// 装飾と差し替え枠までで、内容は埋めない。
// デザインは 2026-11-14 の指示でフルティガーエアロ風
// （空と水と緑、ガラスのツヤと泡）。アイコン画像は本人が用意したら
// ヒーローのプレースホルダと差し替える。
// 専用ヘッダー/フッターはこのファイルの中で完結させる（サイト共通の
// ヘッダー/フッターは lib/site-chrome.ts の /folio 判定で出ない）。
// ============================================================

// フルティガーエアロ風ファビコン: 水色の水滴にツヤ
const DROP_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3CradialGradient id='g' cx='38%25' cy='30%25' r='80%25'%3E%3Cstop offset='0%25' stop-color='%23bfeaff'/%3E%3Cstop offset='55%25' stop-color='%233fa9e0'/%3E%3Cstop offset='100%25' stop-color='%231a6fb5'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cpath d='M32 4C32 4 12 30 12 42a20 20 0 1 0 40 0C52 30 32 4 32 4z' fill='url(%23g)'/%3E%3Cellipse cx='24' cy='36' rx='6' ry='9' fill='%23ffffff' opacity='.55'/%3E%3C/svg%3E";


export const metadata: Metadata = {
  title: { absolute: "tadanoen" },
  alternates: { canonical: "/folio/tadanoen" },
  openGraph: {
    type: "website",
    url: "/folio/tadanoen",
    siteName: "tadanoen",
    title: "tadanoen",
    images: [],
  },
  twitter: { card: "summary", title: "tadanoen", images: [] },
  icons: { icon: DROP_ICON },
};

// 泡（装飾）。位置は決定的に生成してサーバー/クライアントで一致させる。
const BUBBLES = Array.from({ length: 42 }, (_, i) => {
  const x = ((i * 137.508 + 7) % 100).toFixed(2);
  const y = ((i * 61.37 + 5) % 88).toFixed(2);
  const s = (7 + ((i * 29) % 38)).toFixed(0);
  const d = ((i * 17) % 50) / 10;
  const dur = (6 + ((i * 11) % 50) / 10).toFixed(1);
  return { x, y, s, d, dur };
});

// globals.css の要素セレクタ（header/footer は白背景、main は中央寄せ
// カラム+余白）がこのページにも効いてしまうため、:has() でこのページ
// 表示時だけ打ち消し、空を画面全体に広げる（Activity 画面と同じ手法）。
const CSS = `
body:has(.folio-fa){background:#6fc3f7}
main:has(.folio-fa){max-width:none;min-height:0;margin:0;padding:0}
.folio-fa{position:relative;min-height:100svh;overflow:hidden;color:#0d3a56;font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;background:radial-gradient(1050px 520px at 86% -8%,rgba(255,246,190,.75),transparent 60%),radial-gradient(760px 460px at -12% 26%,rgba(255,255,255,.55),transparent 62%),radial-gradient(900px 500px at 108% 62%,rgba(190,255,220,.35),transparent 60%),linear-gradient(180deg,#2f97e6 0%,#5fb6f5 24%,#9fd8ff 46%,#d3f1ff 66%,#e9fcff 82%,#d9f6ff 100%)}
.folio-fa *{box-sizing:border-box}
.folio-fa-bubbles{position:absolute;inset:0;pointer-events:none}
.folio-fa-bubble{position:absolute;border-radius:50%;background:radial-gradient(circle at 32% 28%,rgba(255,255,255,.95),rgba(255,255,255,.28) 42%,rgba(255,255,255,.06) 62%,rgba(170,225,255,.22));border:1px solid rgba(255,255,255,.55);box-shadow:inset -3px -4px 8px rgba(120,190,240,.25),0 2px 8px rgba(30,110,180,.10);animation:folio-fa-float 7s ease-in-out infinite alternate}
@keyframes folio-fa-float{from{transform:translateY(8px)}to{transform:translateY(-14px)}}
.folio-fa-hills{position:absolute;left:0;right:0;bottom:0;width:100%;height:190px;pointer-events:none}
.folio-fa-sun{position:absolute;top:4.6rem;right:4vw;width:230px;height:230px;border-radius:50%;background:radial-gradient(circle,rgba(255,252,210,.85) 0%,rgba(255,244,170,.38) 42%,transparent 70%);pointer-events:none}
.folio-fa-icon{position:absolute;top:6.5rem;right:6vw;width:172px;height:172px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 6px rgba(255,255,255,.9),0 0 0 9px rgba(130,205,255,.55),0 20px 44px rgba(0,80,140,.38)}
.folio-fa-icon-ph{display:grid;place-items:center;background:radial-gradient(circle at 34% 28%,#d8f3ff,#4db2ec 58%,#1a6fb5)}
.folio-fa-fish{position:absolute;pointer-events:none;opacity:.85;animation:folio-fa-swim 9s ease-in-out infinite alternate}
@keyframes folio-fa-swim{from{transform:translateX(-16px)}to{transform:translateX(22px)}}
.folio-fa-inner{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:0 20px 120px}
.folio-fa-header{display:flex;align-items:center;gap:10px;padding:20px 0 14px;position:relative;border-bottom:1px solid transparent;border-image:linear-gradient(90deg,transparent,rgba(255,255,255,.85) 30%,rgba(255,255,255,.85) 70%,transparent) 1}
.folio-fa-header .name{font-size:17px;letter-spacing:.16em;font-weight:600;color:#07507e;text-shadow:0 1px 0 rgba(255,255,255,.7)}
.folio-fa-hero{padding:88px 0 30px;max-width:560px;position:relative}
.folio-fa-hero h1{font-size:52px;margin:0 0 10px;letter-spacing:.05em;font-weight:700;color:#073e63;text-shadow:0 2px 0 rgba(255,255,255,.65),0 12px 28px rgba(0,90,160,.28)}
.folio-fa-alias{color:#1a6ea8;letter-spacing:.12em;margin:0 0 18px;font-size:15px;font-weight:600;text-shadow:0 1px 0 rgba(255,255,255,.6)}
.folio-fa-glass{position:relative;border:1px solid rgba(255,255,255,.95);border-radius:20px;background:linear-gradient(165deg,rgba(255,255,255,.80),rgba(255,255,255,.40) 55%,rgba(205,238,255,.45));box-shadow:inset 0 1px 0 rgba(255,255,255,1),inset 0 -20px 32px rgba(120,200,255,.14),0 14px 30px rgba(15,90,150,.20);backdrop-filter:blur(6px) saturate(1.35);-webkit-backdrop-filter:blur(6px) saturate(1.35);overflow:hidden}
.folio-fa-glass::before{content:"";position:absolute;top:0;left:0;right:0;height:46%;background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0));pointer-events:none}
.folio-fa-slot{padding:14px 16px;color:#33586e}
.folio-fa-badge{display:inline-block;position:relative;z-index:1;font-size:10.5px;letter-spacing:.08em;color:#5b3a00;background:linear-gradient(180deg,#ffe1a0,#ffab2e);border:1px solid rgba(255,255,255,.9);border-radius:999px;padding:2px 9px;margin-bottom:8px;font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 3px 8px rgba(200,120,0,.30)}
.folio-fa-slotbody{position:relative;z-index:1}
.folio-fa-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:26px;max-width:560px}
.folio-fa-stats .folio-fa-glass{min-height:74px}
.folio-fa-divider{display:flex;gap:12px;align-items:center;justify-content:center;margin:46px 0 8px}
.folio-fa section{margin-top:44px}
.folio-fa h2{font-size:21px;letter-spacing:.12em;margin:0 0 16px;display:flex;align-items:center;gap:11px;font-weight:700;color:#07507e;text-shadow:0 1px 0 rgba(255,255,255,.65)}
.folio-fa-h2icon{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:radial-gradient(circle at 32% 28%,#aee6ff,#2f9be8 62%,#1573bd);border:1px solid rgba(255,255,255,.95);box-shadow:inset 0 2px 3px rgba(255,255,255,.8),0 4px 10px rgba(10,90,160,.35)}
.folio-fa-works{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-fa-works .folio-fa-glass{min-height:132px}
.folio-fa-career{list-style:none;margin:0;padding:0 0 0 14px;border-left:3px solid transparent;border-image:linear-gradient(180deg,#39b6f0,#58c256) 1}
.folio-fa-career li{position:relative;margin:0 0 12px 10px}
.folio-fa-career li::before{content:"";position:absolute;left:-23.5px;top:18px;width:13px;height:13px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#ffffff,#8fd8ff 55%,#2f9be8);border:1px solid rgba(255,255,255,.95);box-shadow:0 2px 8px rgba(10,90,160,.35)}
.folio-fa-entry{padding:13px 16px;color:#123f5c;font-size:15.5px}
.folio-fa-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.folio-fa-card{padding:16px 18px}
.folio-fa-card h3{position:relative;z-index:1;margin:0 0 10px;font-size:15.5px;letter-spacing:.07em;color:#0a6ebd;font-weight:700}
.folio-fa-card p{position:relative;z-index:1;margin:4px 0;color:#123f5c;font-size:15px}
.folio-fa-card p.sub{color:#5b84a0;font-size:13.5px}
.folio-fa-tags{display:flex;flex-wrap:wrap;gap:8px}
.folio-fa-tag{border:1px solid rgba(255,255,255,.95);border-radius:999px;padding:7px 16px;color:#33586e;font-size:13.5px;background:linear-gradient(180deg,rgba(255,255,255,.85),rgba(215,242,255,.5));box-shadow:inset 0 1px 0 rgba(255,255,255,1),0 4px 10px rgba(15,90,150,.16)}
.folio-fa-links{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-fa-footer{margin-top:72px;padding:18px 0 0;position:relative;border-top:1px solid transparent;border-image:linear-gradient(90deg,transparent,rgba(255,255,255,.9) 30%,rgba(255,255,255,.9) 70%,transparent) 1;display:flex;align-items:center;gap:8px;justify-content:center;color:#0d5a8a;font-size:12.5px;letter-spacing:.12em;font-weight:600;text-shadow:0 1px 0 rgba(255,255,255,.6)}
@media (max-width:640px){.folio-fa-hero{padding-top:56px}.folio-fa-hero h1{font-size:32px}.folio-fa-sun{width:140px;height:140px;top:3.8rem}.folio-fa-icon{width:104px;height:104px;top:5.2rem;right:5vw}.folio-fa-stats{grid-template-columns:repeat(2,1fr)}.folio-fa-works,.folio-fa-links,.folio-fa-cards{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.folio-fa-bubble,.folio-fa-fish{animation:none}}
`;

function Slot({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="folio-fa-glass folio-fa-slot">
      <span className="folio-fa-badge">差し替え項目</span>
      <div className="folio-fa-slotbody">{children ?? `（${label}：本人が記入）`}</div>
    </div>
  );
}

function DropMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id="folio-fa-drop" cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#bfeaff" />
          <stop offset="55%" stopColor="#3fa9e0" />
          <stop offset="100%" stopColor="#1a6fb5" />
        </radialGradient>
      </defs>
      <path d="M32 4C32 4 12 30 12 42a20 20 0 1 0 40 0C52 30 32 4 32 4z" fill="url(#folio-fa-drop)" />
      <ellipse cx="24" cy="36" rx="6" ry="9" fill="#ffffff" opacity=".55" />
    </svg>
  );
}

function H2Icon({ d }: { d: string }) {
  return (
    <span className="folio-fa-h2icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
      </svg>
    </span>
  );
}

function BubbleDivider() {
  // 泡の大きさが山なりになる区切り（装飾）
  const sizes = [8, 12, 16, 20, 24, 20, 16, 12, 8];
  return (
    <div className="folio-fa-divider" aria-hidden="true">
      {sizes.map((s, i) => (
        <span
          key={i}
          style={{
            width: s,
            height: s,
            borderRadius: "50%",
            background:
              "radial-gradient(circle at 32% 28%,rgba(255,255,255,.95),rgba(255,255,255,.28) 42%,rgba(255,255,255,.06) 62%,rgba(170,225,255,.22))",
            border: "1px solid rgba(255,255,255,.55)",
            boxShadow: "inset -3px -4px 8px rgba(120,190,240,.25)",
          }}
        />
      ))}
    </div>
  );
}

function Fish({ top, left, scale, flip, color, delay }: { top: string; left: string; scale: number; flip?: boolean; color: string; delay: string }) {
  return (
    <svg
      className="folio-fa-fish"
      style={{ top, left, transform: `scale(${flip ? -scale : scale}, ${scale})`, animationDelay: delay }}
      width="54"
      height="36"
      viewBox="0 0 54 36"
      aria-hidden="true"
    >
      <path d="M4 18C12 7 24 3 34 6c7 2 12 7 16 12-4 5-9 10-16 12C24 33 12 29 4 18z" fill={color} opacity=".8" />
      <path d="M8 18c6-6 14-9 21-8" stroke="#ffffff" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity=".65" />
      <circle cx="40" cy="15" r="2.4" fill="#073e63" />
    </svg>
  );
}

export default function TadanoenFolioPage() {
  return (
    <div className="folio-fa">
      <style>{CSS}</style>
      <div className="folio-fa-bubbles" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="folio-fa-bubble"
            style={{
              left: `${b.x}%`,
              top: `${b.y}%`,
              width: `${b.s}px`,
              height: `${b.s}px`,
              animationDelay: `${b.d}s`,
              animationDuration: `${b.dur}s`,
            }}
          />
        ))}
      </div>
      <svg className="folio-fa-hills" viewBox="0 0 1280 190" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 96 C160 40 300 128 470 96 C640 64 760 130 930 100 C1080 74 1180 110 1280 84 L1280 190 L0 190 Z" fill="#79c95e" opacity=".75" />
        <path d="M0 138 C180 92 340 162 540 132 C740 104 880 164 1060 138 C1160 124 1220 142 1280 130 L1280 190 L0 190 Z" fill="#57b53e" opacity=".9" />
        <path d="M0 168 C240 138 460 182 700 160 C920 142 1100 176 1280 158 L1280 190 L0 190 Z" fill="#3f9e2c" />
      </svg>
      <div className="folio-fa-sun" aria-hidden="true" />
      <div className="folio-fa-icon folio-fa-icon-ph" aria-hidden="true"><DropMark size={64} /></div>
      <Fish top="11.5rem" left="6%" scale={1} color="#ff9f2e" delay="0s" />
      <Fish top="15.5rem" left="13%" scale={0.7} flip color="#37b6ff" delay="1.4s" />
      <div className="folio-fa-inner">
        <header className="folio-fa-header">
          <DropMark />
          <span className="name">tadanoen</span>
        </header>

        <div className="folio-fa-hero">
          <h1>tadanoen</h1>
          <Slot label="キャッチコピー" />
          <div className="folio-fa-stats">
            <Slot label="数字" />
            <Slot label="数字" />
            <Slot label="数字" />
            <Slot label="数字" />
          </div>
        </div>

        <BubbleDivider />

        <section>
          <h2>
            <H2Icon d="M12 21s-7.5-4.6-9.7-9A5.4 5.4 0 0 1 12 6.4 5.4 5.4 0 0 1 21.7 12C19.5 16.4 12 21 12 21z" />
            About
          </h2>
          <Slot label="自己紹介" />
        </section>

        <section>
          <h2>
            <H2Icon d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
            Works
          </h2>
          <div className="folio-fa-works">
            <Slot label="作品・実績" />
            <Slot label="作品・実績" />
            <Slot label="作品・実績" />
          </div>
        </section>

        <section>
          <h2>
            <H2Icon d="M3 12c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2M3 18c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2" />
            経歴
          </h2>
          <ul className="folio-fa-career">
            {[
              "（経歴：本人が記入）",
              "（経歴：本人が記入）",
              "（経歴：本人が記入）",
            ].map((text, i) => (
              <li key={i}>
                <div className="folio-fa-glass folio-fa-entry">{text}</div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>
            <H2Icon d="M12 3c2 4.5 6 7.6 6 11a6 6 0 1 1-12 0c0-3.4 4-6.5 6-11z" />
            Skills
          </h2>
          <div className="folio-fa-tags">
            <span className="folio-fa-tag">（スキル：本人が記入）</span>
            <span className="folio-fa-tag">（スキル：本人が記入）</span>
            <span className="folio-fa-tag">（スキル：本人が記入）</span>
          </div>
        </section>

        <section>
          <h2>
            <H2Icon d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />
            Links
          </h2>
          <div className="folio-fa-links">
            <Slot label="リンク" />
            <Slot label="リンク" />
            <Slot label="リンク" />
          </div>
        </section>

        <footer className="folio-fa-footer">
          <DropMark size={15} />
          <span>© tadanoen</span>
        </footer>
      </div>
    </div>
  );
}
