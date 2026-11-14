import type { Metadata } from "next";

// ============================================================
// ポートフォリオ枠: deshihito の割り当てファイル（1人1ファイル）
// ------------------------------------------------------------
// このファイルが deshihito.agobot.app の実体。編集権は本人にあり、
// 中身（文章・実績・リンク等）は本人が書く。管理側が用意するのは
// 装飾（月モチーフのデザイン）と差し替え枠までで、内容は埋めない。
// （経歴・マリンバの記載は 2026-11-14 に本人が書いた文の転記。）
// 専用ヘッダー/フッターはこのファイルの中で完結させる（サイト共通の
// ヘッダー/フッターは lib/site-chrome.ts の /folio 判定で出ない）。
// ============================================================

const MOON_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='30' fill='%230b1026'/%3E%3Cpath d='M42 10a24 24 0 1 0 12 32A26 26 0 0 1 42 10z' fill='%23e8c97a'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: { absolute: "deshihito / lunamOOn" },
  alternates: { canonical: "/folio/deshihito" },
  openGraph: {
    type: "website",
    url: "/folio/deshihito",
    siteName: "deshihito",
    title: "deshihito / lunamOOn",
    images: [],
  },
  twitter: { card: "summary", title: "deshihito / lunamOOn", images: [] },
  icons: { icon: MOON_ICON },
};

// 星空（装飾）。位置は決定的に生成してサーバー/クライアントで一致させる。
const STARS = Array.from({ length: 72 }, (_, i) => {
  const x = ((i * 137.508) % 100).toFixed(2);
  const y = ((i * 89.31 + 13) % 62).toFixed(2);
  const s = (0.8 + ((i * 7) % 10) / 6).toFixed(1);
  const d = ((i * 13) % 40) / 10;
  return { x, y, s, d };
});

const CSS = `
.folio-dh{position:relative;min-height:100svh;overflow:hidden;background:linear-gradient(180deg,#070b1d 0%,#0b1026 42%,#131a3a 78%,#1a2148 100%);color:#eef0ff;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
.folio-dh *{box-sizing:border-box}
.folio-dh-stars{position:absolute;inset:0;pointer-events:none}
.folio-dh-star{position:absolute;border-radius:50%;background:#dfe6ff;animation:folio-dh-tw 3.6s ease-in-out infinite}
@keyframes folio-dh-tw{0%,100%{opacity:.25}50%{opacity:.95}}
.folio-dh-moon{position:absolute;top:6.5rem;right:6vw;width:172px;height:172px;border-radius:50%;background:radial-gradient(circle at 38% 34%,#fdf6dd 0%,#f3e3ac 42%,#e8c97a 78%,#d9b45f 100%);box-shadow:0 0 60px 18px rgba(232,201,122,.28),0 0 140px 60px rgba(232,201,122,.12)}
.folio-dh-moon::after{content:"";position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 68% 62%,rgba(160,128,58,.20) 0 9%,transparent 10%),radial-gradient(circle at 30% 66%,rgba(160,128,58,.16) 0 6%,transparent 7%),radial-gradient(circle at 55% 22%,rgba(160,128,58,.14) 0 5%,transparent 6%)}
.folio-dh-inner{position:relative;max-width:880px;margin:0 auto;padding:0 20px 64px}
.folio-dh-header{display:flex;align-items:center;gap:10px;padding:20px 0 14px;border-bottom:1px solid transparent;border-image:linear-gradient(90deg,transparent,#e8c97a 30%,#e8c97a 70%,transparent) 1}
.folio-dh-header .name{font-size:17px;letter-spacing:.14em}
.folio-dh-hero{padding:88px 0 30px;max-width:560px}
.folio-dh-hero h1{font-size:52px;margin:0 0 10px;letter-spacing:.08em;font-weight:600}
.folio-dh-slot{border:1.5px dashed rgba(232,201,122,.55);border-radius:12px;padding:14px 16px;color:#b9c0e8;background:rgba(11,16,38,.45)}
.folio-dh-badge{display:inline-block;font-size:10.5px;letter-spacing:.08em;color:#0b1026;background:#e8c97a;border-radius:999px;padding:2px 9px;margin-bottom:8px;font-weight:700}
.folio-dh-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:26px;max-width:560px}
.folio-dh-stats .folio-dh-slot{min-height:74px}
.folio-dh-phases{display:flex;gap:14px;align-items:center;justify-content:center;margin:46px 0 8px;opacity:.9}
.folio-dh section{margin-top:44px}
.folio-dh h2{font-size:21px;letter-spacing:.1em;margin:0 0 16px;display:flex;align-items:center;gap:10px;font-weight:600}
.folio-dh h2::before{content:"";width:15px;height:15px;border-radius:50%;background:#e8c97a;box-shadow:-5px 2px 0 0 #131a3a;transform:rotate(24deg);flex:none}
.folio-dh-works{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-dh-works .folio-dh-slot{min-height:132px}
.folio-dh-career{list-style:none;margin:0;padding:0 0 0 14px;border-left:1px solid rgba(232,201,122,.4)}
.folio-dh-career li{position:relative;margin:0 0 12px 10px}
.folio-dh-career li::before{content:"";position:absolute;left:-21px;top:20px;width:9px;height:9px;border-radius:50%;background:#e8c97a;box-shadow:0 0 10px rgba(232,201,122,.8)}
.folio-dh-entry{border:1px solid rgba(232,201,122,.28);border-radius:12px;padding:13px 16px;color:#eef0ff;background:rgba(19,26,58,.5);font-size:15.5px}
.folio-dh-alias{color:#b9c0e8;letter-spacing:.1em;margin:0 0 18px;font-size:15px}
.folio-dh-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.folio-dh-card{border:1px solid rgba(232,201,122,.28);border-radius:12px;padding:16px 18px;background:rgba(19,26,58,.5)}
.folio-dh-card h3{margin:0 0 10px;font-size:15.5px;letter-spacing:.06em;color:#e8c97a;font-weight:600}
.folio-dh-card p{margin:4px 0;color:#eef0ff;font-size:15px}
.folio-dh-card p.sub{color:#b9c0e8;font-size:13.5px}
.folio-dh-tags{display:flex;flex-wrap:wrap;gap:8px}
.folio-dh-tag{border:1.5px dashed rgba(232,201,122,.55);border-radius:999px;padding:7px 16px;color:#b9c0e8;font-size:13.5px}
.folio-dh-links{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-dh-footer{margin-top:72px;padding-top:18px;border-top:1px solid transparent;border-image:linear-gradient(90deg,transparent,#e8c97a 30%,#e8c97a 70%,transparent) 1;display:flex;align-items:center;gap:8px;justify-content:center;color:#9aa3d4;font-size:12.5px;letter-spacing:.1em}
@media (max-width:640px){.folio-dh-hero{padding-top:56px}.folio-dh-hero h1{font-size:32px}.folio-dh-moon{width:104px;height:104px;top:5.2rem;right:5vw}.folio-dh-stats{grid-template-columns:repeat(2,1fr)}.folio-dh-works,.folio-dh-links,.folio-dh-cards{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.folio-dh-star{animation:none}}
`;

function Slot({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="folio-dh-slot">
      <span className="folio-dh-badge">差し替え項目</span>
      <div>{children ?? `（${label}：本人が記入）`}</div>
    </div>
  );
}

function MoonMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M42 6a26 26 0 1 0 16 36A28 28 0 0 1 42 6z" fill="#e8c97a" />
    </svg>
  );
}

function Phases() {
  // 月の満ち欠け（装飾の区切り）
  const fills = [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0];
  return (
    <div className="folio-dh-phases" aria-hidden="true">
      {fills.map((f, i) => (
        <svg key={i} width="18" height="18" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="rgba(232,201,122,.5)" strokeWidth="1" />
          {f > 0 && (
            <path
              d={`M10 2a8 8 0 0 1 0 16a${8 * Math.abs(1 - 2 * f)} 8 0 0 ${f > 0.5 ? 1 : 0} 0-16z`}
              fill="#e8c97a"
              opacity="0.9"
            />
          )}
        </svg>
      ))}
    </div>
  );
}

export default function DeshihitoFolioPage() {
  return (
    <div className="folio-dh">
      <style>{CSS}</style>
      <div className="folio-dh-stars" aria-hidden="true">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="folio-dh-star"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: `${s.s}px`,
              height: `${s.s}px`,
              animationDelay: `${s.d}s`,
            }}
          />
        ))}
      </div>
      <div className="folio-dh-moon" aria-hidden="true" />
      <div className="folio-dh-inner">
        <header className="folio-dh-header">
          <MoonMark />
          <span className="name">deshihito</span>
        </header>

        <div className="folio-dh-hero">
          <h1>deshihito / lunamOOn</h1>
          <p className="folio-dh-alias">通称：でし</p>
          <Slot label="キャッチコピー" />
          <div className="folio-dh-stats">
            <Slot label="数字" />
            <Slot label="数字" />
            <Slot label="数字" />
            <Slot label="数字" />
          </div>
        </div>

        <Phases />

        <section>
          <h2>About</h2>
          <Slot label="自己紹介" />
        </section>

        <section>
          <h2>Works</h2>
          <div className="folio-dh-works">
            <Slot label="作品・実績" />
            <Slot label="作品・実績" />
            <Slot label="作品・実績" />
          </div>
        </section>

        <section>
          <h2>経歴</h2>
          <ul className="folio-dh-career">
            {[
              "10代",
              "ハードウェア歴 6年",
              "投資歴 3年",
              "マーケティングの研究を行う",
              "数千人規模のDiscordサーバーの鯖主経験 4回",
              "30000人のユーザーカウントを誇るAGOBOTを運営。",
              "TakasumiBOT サポーター/デベロッパー",
            ].map((text, i) => (
              <li key={i}>
                <div className="folio-dh-entry">{text}</div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>マリンバ</h2>
          <div className="folio-dh-cards">
            <div className="folio-dh-card">
              <h3>国際音楽コンクール受賞歴</h3>
              <p>1位：1回</p>
              <p>2位：2回</p>
              <p className="sub">以下入賞省略</p>
            </div>
            <div className="folio-dh-card">
              <h3>全国</h3>
              <p>2位：2回</p>
              <p className="sub">以下入賞省略</p>
            </div>
          </div>
        </section>

        <section>
          <h2>Skills</h2>
          <div className="folio-dh-tags">
            <span className="folio-dh-tag">（スキル：本人が記入）</span>
            <span className="folio-dh-tag">（スキル：本人が記入）</span>
            <span className="folio-dh-tag">（スキル：本人が記入）</span>
          </div>
        </section>

        <section>
          <h2>Links</h2>
          <div className="folio-dh-links">
            <Slot label="リンク" />
            <Slot label="リンク" />
            <Slot label="リンク" />
          </div>
        </section>

        <footer className="folio-dh-footer">
          <MoonMark size={15} />
          <span>© deshihito</span>
        </footer>
      </div>
    </div>
  );
}
