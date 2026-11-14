import type { Metadata } from "next";

// ============================================================
// ポートフォリオ枠: tadanoen の割り当てファイル（1人1ファイル）
// ------------------------------------------------------------
// このファイルが tadanoen.agobot.app の実体。編集権は本人にあり、
// 中身（文章・実績・リンク等）は本人が書く。管理側が用意するのは
// 装飾と差し替え枠までで、内容は埋めない。
// デザインは 2026-11-14 の指示でフルティガーエアロ風
// （空と水と緑、ガラスのツヤと泡）。同日の追加指示で全体の緑要素を
// 強め、定番の低解像度イルカ画像を入れた。さらに同日の追加指示で
// 参考コラージュに寄せ、地球のガラス球・雲・スカイライン・蝶・
// 草花の要素を足した。さらに同日の追加指示で、光沢の境界を
// ハッキリさせ（上部で濃く下端で薄く、境界はシャープ）、
// グラデーションは下に行くほど明るくなるガラス光沢に統一した。さらに同日の追加指示で、その光沢を全UI要素（ヘッダー/ヒーロー/フッター/経歴ドット等）へ展開し、イルカ画像を About 欄の右上へ移し、配色全体をかなり鮮やかにした。さらに泡は「ぼかした白い丸」ではなく縁とハイライトの境目がハッキリしたガラス球の質感に作り替え、パネルのスペキュラは上端から少し下げた位置から薄く効かせるようにした。地球儀は大陸を消して青一色（#0080ff）にした（光沢は維持）。さらに Frutiger Aero のスペキュラ仕様（50%付近のハードストップ段差、内側リムライト＋外側の暗い輪郭線、下端のバウンスライト、ドーム型ハイライト、斜めのガラス反射）に沿ってガラス表現を全面改修し、オーロラの帯とボケ味も加えた。その後、魚・蝶・雲・キラキラ・地球儀と背景（流線型の白＋ガラス建築・屋上の緑・滝・丘陵・草花）をすべて低解像度のピクセル画像（data URI）に置き換え、水玉も同仕様（ドームの段差＋リムライト）に作り直し、泡は左下から右上へ流れる配置＋透明度のバラつきにした。アイコン画像は本人が
// 用意したらヒーローのプレースホルダと差し替える。
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

// イルカ画像: フルティガーエアロ定番の低解像度ストック写真風に、
// あえて 144px まで落として data URI で埋め込み、表示側で拡大する
// （image-rendering: pixelated で粗さをそのまま見せる）。
const DOLPHIN_SRC =
  "data:image/png;base64,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";

// 装飾イラストはすべて低解像度のピクセル画像（data URI）に統一。
const FISH_ORANGE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABsAAAASCAYAAACq26WdAAAAuUlEQVR42mNgGK6AkViF/7sYruM0pIxBk2LL8FlAjsWMJFlU+v8cCr+b0YgUC1kIWoTLAnRxLPrRLWXEaRGyYTh8gA1wbEnW+OEz9wY2XzLitYgES2AWwdgwC7FahmIRiZbg8xmyhUzUzkvoFqHEIaVJnZSswERO5iQXYATjw6cMzQ+fMjRTYihMP8GkDwMP8hmiGBgYGOSlGWqJNRwGFCYyLCOruCLFl/LSDLVkFVe4fIoL4PLNyAAAwXtT6/666KkAAAAASUVORK5CYII=";
const FISH_GREEN_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABsAAAASCAYAAACq26WdAAAAtklEQVR42mNgGK6AkWiVJ4Kv45SzWKtJuWX4LCDDYkZSLPpvvuYciuaTIUakWMhCyCJcFqCLY9WPZikjLoXIhuH0ARbAXiag8bPrww1svmTEZxEplsAsgrHhFmK1DMkiUi3B6zMkC5monZcwLELyCCPFSZ2ErMBETuYkF2AG44OXzQwPXjZTZCpMP8GkDwMrbKIYGBgYGBTEa4k2HAYijiwjr7gixZcK4rXkFVe4fIoL4PDNyAAAJXxZ9P6cL0MAAAAASUVORK5CYII=";
const BUTTERFLY_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABoAAAAWCAYAAADeiIy1AAABFElEQVR42t2VMQ6CMBSG/9e4cgC9hJskJCZeAEe4gTuLmxdwYfcGMOoFSExI6uYl9ADEuU4YfLxWIMEY/6n90/5fX3mkwJdE3Ai1MdwrkhhVmZMtxAsis0qzln/yiVogCdAFZoNwoOKQ4wL6uICWNvDD2A7HM0JtjOIQaQwAqzRDkcSv8FAbUyQxeDW2DNXng9YwL4hEiEtvoPUFvjTuI1vGxLVwqKQM1WzBTyqS2Dn/eHV9YEN08onEH3a5wZ372yvNvCBqtXNV5rSfmxv3zwdMmwW0uk6CAIAU5vJ5juqyaaiaeWosCM9V+JJ+E7R7ZHfXvBNoe6XZGJXUuUoyXZvqN6kqc+qy3vrC2jrQFdp3/X/oCUfmkWNK+b1MAAAAAElFTkSuQmCC";
const CLOUD_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEYAAAAeCAYAAACR82geAAAAjklEQVR42u3XgQ2AIAxEUe7i/rO5h0PUCSwkgCnt/QVqXzBKa0optS9EfCgzs+6DA0gPMwLxNxROB9kFhCwgq4GYEWXFHGZEWTGPWVFm5zIzysz86/Slw/zHnA4x+rVC1ZPRA0Ll18UDYmUUbz9WRvH2ZHWUr33ZVIy7kmAEIxjBKOcSeT86MUowglG7egG4rVmvVR9UbAAAAABJRU5ErkJggg==";
const SPARKLE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAAWElEQVR42mNgwAH+f9v/H5s4EwOJgIkU0wnagE0jEymmMzAwMDBiVcjpgFDx/QBEIZcjIwMDAwMLIRMJ2vz/2/7/yABdngWrLqgziAolmFvJClZCmonyJADxSTHzXA5pSgAAAABJRU5ErkJggg==";
const GLOBE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEoAAABKCAYAAAAc0MJxAAACcklEQVR42u3cPVbDMAwAYMsvEwNLm40rMDDDKbgEMwNzH3NPwCU4BcwMHAG2tksH1jD0+eGGxLZsOU4saezjmeSrLNn5qVISQQGlD6Drul3wwQK0LKAwKHPDg9I4+x+1Dh1rfaH2pdBgSiAMSgpeDjBYKtDUYJALaAqcUDQKMKBGKgnkAkvF0rUi9Y8nteNCjUA5sktzQKLILs0BiQJLc0FKxdKckFKwNDekWCwdO3htWMlQRrs2pD6WL6s0ZyQMlo69PFJrjJ23ppzHNdcrzXnKYaagVhJxXY9rNvmySjIqJqO4drqQDqg5dzpMB5Sph5163Iu4r6hLRlFtiiVO0fQ/aLdK7Z5oBr95mf6EPh5oxmm3SnUbB1QIVgkA6i/HBdpu/38GdsGC579CfnXJd5p9H6211OZ0m+ssozjj+BykmEvXEyiBEiiBEigJgRKo/FDmCbSvR/dz3NzCeABA24ztc2Svdx4N5o9r2hO6zm8ompz/pAQoFiArVOmDLtr1TEE311+4h3EwLrI8SFlHcc+qofM/gyr5huUcw/aQqRc79bgX9X4Rl4yiKOZcs2osm5RyvIZmPxtk3++jiNvrQ/IY75+rbJ1uCKpxVfzUB8soQLBjpwKOdX7vi41Dd5FLwOTMPNeUC4byYc0RB4MWgoSGMlhLwnGh+eoSenlgD1JLJ8QgodZR9mBv96tFY9nHH7ptQy04a8CKQYpamS8ZKxYpeguzRKwUpOCuF9oR714P69qAyDbFc84uKiSSjBrKrNLZ1f/CZvNrPy6wqdCGsnmWvx9VCiw3UHYoF1gsnq8GLvI37mLQKC+LLBoqFa/kXaJfe36FJaanIB8AAAAASUVORK5CYII=";
const BACKDROP_SRC =
  "data:image/png;base64,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";

// 泡（装飾）。位置は決定的に生成してサーバー/クライアントで一致させる。
const BUBBLES = Array.from({ length: 42 }, (_, i) => {
  const t = i / 41;
  const x = (2 + t * 88 + ((i * 37) % 13) - 6).toFixed(2);
  const y = (84 - t * 72 + ((i * 53) % 15) - 7).toFixed(2);
  const s = (7 + ((i * 29) % 38)).toFixed(0);
  const o = (0.4 + ((i * 23) % 55) / 100).toFixed(2);
  const d = ((i * 17) % 50) / 10;
  const dur = (6 + ((i * 11) % 50) / 10).toFixed(1);
  return { x, y, s, o, d, dur };
});

// globals.css の要素セレクタ（header/footer は白背景、main は中央寄せ
// カラム+余白）がこのページにも効いてしまうため、:has() でこのページ
// 表示時だけ打ち消し、空を画面全体に広げる（Activity 画面と同じ手法）。
const CSS = `
body:has(.folio-fa){background:#3ec6ff}
main:has(.folio-fa){max-width:none;min-height:0;margin:0;padding:0}
.folio-fa{position:relative;min-height:100svh;overflow:hidden;color:#0d3a56;font-family:"Segoe UI","Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",system-ui,sans-serif;background:radial-gradient(1050px 520px at 86% -8%,rgba(255,246,190,.6),transparent 60%),linear-gradient(180deg,#007cf0 0%,#00a2ff 22%,#3ec6ff 42%,#8df5c0 60%,#54e86a 78%,#c6ff9a 100%)}
.folio-fa *{box-sizing:border-box}
.folio-fa-bubbles{position:absolute;inset:0;pointer-events:none}
.folio-fa-aurora{position:absolute;top:-46px;left:0;width:100%;height:330px;pointer-events:none;animation:folio-fa-drift 18s ease-in-out infinite alternate}
@keyframes folio-fa-drift{from{transform:translateX(-24px)}to{transform:translateX(24px)}}
.folio-fa-bokeh{position:absolute;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.22),rgba(255,255,255,0) 62%);filter:blur(5px);pointer-events:none}
.folio-fa-bubble{position:absolute;border-radius:50%;background:radial-gradient(circle at 34% 23%,rgba(255,255,255,1) 0 6%,rgba(255,255,255,0) 8.5%),radial-gradient(ellipse 60% 34% at 50% 13%,rgba(255,255,255,.95) 0 54%,rgba(255,255,255,.32) 64%,rgba(255,255,255,0) 68%),radial-gradient(ellipse 66% 30% at 50% 112%,rgba(170,255,205,.55) 0 56%,rgba(170,255,205,0) 64%),linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.02) 48%,rgba(190,255,215,.30));border:1.5px solid rgba(255,255,255,.95);box-shadow:inset 0 1px 0 rgba(255,255,255,.9),inset 0 0 0 1px rgba(255,255,255,.35),0 2px 5px rgba(0,90,160,.20);animation:folio-fa-float 7s ease-in-out infinite alternate}
@keyframes folio-fa-float{from{transform:translateY(8px)}to{transform:translateY(-14px)}}
.folio-fa-backdrop{position:absolute;left:0;right:0;bottom:0;width:100%;height:250px;pointer-events:none}
.folio-fa-sun{position:absolute;top:4.6rem;right:4vw;width:230px;height:230px;border-radius:50%;background:radial-gradient(circle,rgba(255,252,210,.55) 0%,rgba(255,244,170,.22) 42%,transparent 70%);pointer-events:none}
.folio-fa-icon{position:absolute;top:6.5rem;right:6vw;width:172px;height:172px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 6px rgba(255,255,255,.9),0 0 0 9px rgba(130,205,255,.55),0 20px 44px rgba(0,80,140,.38)}
.folio-fa-icon-ph{display:grid;place-items:center;background:radial-gradient(ellipse 135% 100% at 50% -30%,rgba(255,255,255,.95) 0 46%,rgba(255,255,255,.30) 58%,rgba(255,255,255,0) 63%),linear-gradient(180deg,#00a2ff,#0072e0 58%,#4dc9ff)}
.folio-fa-fish{position:absolute;pointer-events:none;opacity:.85;animation:folio-fa-swim 9s ease-in-out infinite alternate}
.folio-fa-fish,.folio-fa-butterfly,.folio-fa-sparkle,.folio-fa-globe,.folio-fa-cloud,.folio-fa-backdrop{image-rendering:pixelated}
@keyframes folio-fa-swim{from{transform:translateX(-16px)}to{transform:translateX(22px)}}
.folio-fa-inner{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:0 20px 120px}
.folio-fa-header{display:flex;align-items:center;gap:10px;padding:12px 18px;margin-top:16px;border-radius:16px}
.folio-fa-header::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(105deg,rgba(255,255,255,0) 22%,rgba(255,255,255,.38) 40%,rgba(255,255,255,.10) 52%,rgba(255,255,255,0) 68%);pointer-events:none}
.folio-fa-header .name{font-size:17px;letter-spacing:.16em;font-weight:600;color:#0063b3;text-shadow:0 1px 0 rgba(255,255,255,.7)}
.folio-fa-hero{margin-top:64px;padding:30px 30px 34px;max-width:600px}
.folio-fa-hero::after{content:"";position:absolute;left:-10%;right:-10%;top:-46%;height:84%;border-radius:50%;background:linear-gradient(180deg,rgba(255,255,255,.34),rgba(255,255,255,.04) 80%);pointer-events:none}
.folio-fa-hero h1{font-size:52px;margin:0 0 10px;letter-spacing:.05em;font-weight:700;color:#0057a8;text-shadow:0 2px 0 rgba(255,255,255,.65),0 12px 28px rgba(0,90,160,.28)}
.folio-fa-alias{color:#1a6ea8;letter-spacing:.12em;margin:0 0 18px;font-size:15px;font-weight:600;text-shadow:0 1px 0 rgba(255,255,255,.6)}
.folio-fa-glass{position:relative;border:1px solid rgba(7,64,110,.42);border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.48),rgba(255,255,255,.20) 52%,rgba(198,255,214,.46));box-shadow:inset 0 1px 0 rgba(255,255,255,.92),inset 1px 0 0 rgba(255,255,255,.38),inset -1px 0 0 rgba(255,255,255,.38),inset 0 -1px 0 rgba(255,255,255,.30),0 14px 30px rgba(15,90,150,.18);overflow:hidden}
.folio-fa-glass::before{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.80) 0%,rgba(255,255,255,.26) 48%,rgba(255,255,255,.03) 50.5%,rgba(255,255,255,.08) 78%,rgba(150,255,185,.30) 100%);pointer-events:none}
.folio-fa-slot{padding:14px 16px;color:#33586e}
.folio-fa-badge{display:inline-block;position:relative;z-index:1;font-size:10.5px;letter-spacing:.08em;color:#5b3a00;background:linear-gradient(180deg,#fff3cf 0%,#ffd873 47%,#ff8a00 52%,#ffb84d 100%);border:1px solid rgba(255,255,255,.95);border-radius:999px;padding:2px 9px;margin-bottom:8px;font-weight:700;box-shadow:inset 0 1px 0 #ffffff,0 3px 8px rgba(200,120,0,.30)}
.folio-fa-slotbody{position:relative;z-index:1}
.folio-fa-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:26px;max-width:560px}
.folio-fa-stats .folio-fa-glass{min-height:74px}
.folio-fa-divider{display:flex;gap:12px;align-items:center;justify-content:center;margin:46px 0 8px}
.folio-fa section{margin-top:44px}
.folio-fa h2{font-size:21px;letter-spacing:.12em;margin:0 0 16px;display:flex;align-items:center;gap:11px;font-weight:700;color:#0063b3;text-shadow:0 1px 0 rgba(255,255,255,.65)}
.folio-fa-h2icon{flex:none;width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:radial-gradient(ellipse 135% 100% at 50% -30%,rgba(255,255,255,.95) 0 46%,rgba(255,255,255,.30) 58%,rgba(255,255,255,0) 63%),linear-gradient(180deg,#2fb9ff,#0072e0 55%,#4dc9ff);border:1px solid rgba(255,255,255,.98);box-shadow:inset 0 -3px 5px rgba(255,255,255,.45),0 4px 10px rgba(10,90,160,.35)}
.folio-fa-works{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-fa-works .folio-fa-glass{min-height:132px}
.folio-fa-career{list-style:none;margin:0;padding:0 0 0 14px;border-left:3px solid transparent;border-image:linear-gradient(180deg,#00a2ff,#00c853) 1}
.folio-fa-career li{position:relative;margin:0 0 12px 10px}
.folio-fa-career li::before{content:"";position:absolute;left:-23.5px;top:18px;width:13px;height:13px;border-radius:50%;background:radial-gradient(circle at 35% 22%,rgba(255,255,255,.98) 0 30%,rgba(255,255,255,0) 34%),linear-gradient(180deg,#38b6ff,#0072e0 60%,#4dc9ff);border:1px solid rgba(255,255,255,.98);box-shadow:inset 0 -2px 3px rgba(255,255,255,.45),0 2px 8px rgba(10,90,160,.35)}
.folio-fa-entry{padding:13px 16px;color:#123f5c;font-size:15.5px}
.folio-fa-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.folio-fa-card{padding:16px 18px}
.folio-fa-card h3{position:relative;z-index:1;margin:0 0 10px;font-size:15.5px;letter-spacing:.07em;color:#0072e0;font-weight:700}
.folio-fa-card p{position:relative;z-index:1;margin:4px 0;color:#123f5c;font-size:15px}
.folio-fa-card p.sub{color:#5b84a0;font-size:13.5px}
.folio-fa-tags{display:flex;flex-wrap:wrap;gap:8px}
.folio-fa-tag{border:1px solid rgba(255,255,255,.98);border-radius:999px;padding:7px 16px;color:#1d4a33;font-size:13.5px;background:linear-gradient(180deg,#ffffff 0%,#f4fff2 47%,#4be04b 52%,#b6ff9e 100%);box-shadow:inset 0 1px 0 #ffffff,0 4px 10px rgba(15,90,60,.18)}
.folio-fa-links{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.folio-fa-footer{margin:72px auto 0;padding:10px 22px;width:fit-content;border-radius:999px;display:flex;align-items:center;gap:8px;justify-content:center;color:#0d5a8a;font-size:12.5px;letter-spacing:.12em;font-weight:600;text-shadow:0 1px 0 rgba(255,255,255,.6)}
.folio-fa-h2icon.g{background:radial-gradient(circle at 35% 20%,rgba(255,255,255,.98) 0 26%,rgba(255,255,255,0) 30%),linear-gradient(180deg,#4be04b,#00a83c 55%,#7bf06a)}
.folio-fa-stats .folio-fa-glass{background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(240,255,235,.24) 52%,rgba(140,255,150,.55))}
.folio-fa-aboutwrap{position:relative}
.folio-fa-aboutwrap .folio-fa-slot{padding-right:196px;min-height:122px}
.folio-fa-dolphin{position:absolute;top:-16px;right:12px;width:172px;margin:0;padding:6px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,.35) 55%,rgba(240,255,246,.6));border:1px solid rgba(7,64,110,.35);box-shadow:inset 0 1px 0 #fff,0 18px 36px rgba(10,90,60,.28);transform:rotate(2.5deg);z-index:3}
.folio-fa-dolphin::after{content:"";position:absolute;left:6px;right:6px;top:6px;height:36%;border-radius:11px;background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.14) 84%,rgba(255,255,255,0) 88%);pointer-events:none}
.folio-fa-dolphin img{display:block;width:100%;height:auto;border-radius:11px;image-rendering:pixelated}
.folio-fa-cloud{position:absolute;width:280px;height:120px;pointer-events:none;opacity:.98;animation:folio-fa-drift 26s ease-in-out infinite alternate}
@keyframes folio-fa-drift{from{transform:translateX(-24px)}to{transform:translateX(34px)}}
.folio-fa-globe{position:absolute;border-radius:50%;pointer-events:none;filter:drop-shadow(0 22px 26px rgba(0,80,140,.35));animation:folio-fa-bob 8s ease-in-out infinite alternate}
@keyframes folio-fa-bob{from{transform:translateY(6px)}to{transform:translateY(-10px)}}


.folio-fa-butterfly{position:absolute;pointer-events:none;animation:folio-fa-flutter 11s ease-in-out infinite alternate;z-index:1}
@keyframes folio-fa-flutter{0%{transform:translate(0,0) rotate(-6deg)}50%{transform:translate(26px,-30px) rotate(7deg)}100%{transform:translate(52px,-6px) rotate(-4deg)}}
.folio-fa-sparkle{position:absolute;pointer-events:none;animation:folio-fa-twinkle 3.4s ease-in-out infinite alternate}
@keyframes folio-fa-twinkle{from{opacity:.25;transform:scale(.7) rotate(0deg)}to{opacity:.95;transform:scale(1.15) rotate(20deg)}}
@media (max-width:640px){.folio-fa-hero{margin-top:40px;padding:22px}.folio-fa-hero h1{font-size:32px}.folio-fa-sun{width:140px;height:140px;top:3.8rem}.folio-fa-icon{width:104px;height:104px;top:5.2rem;right:5vw}.folio-fa-stats{grid-template-columns:repeat(2,1fr)}.folio-fa-works,.folio-fa-links,.folio-fa-cards{grid-template-columns:1fr}.folio-fa-aboutwrap{display:flex;flex-direction:column}.folio-fa-aboutwrap .folio-fa-slot{padding-right:16px;min-height:0}.folio-fa-dolphin{position:relative;order:-1;top:0;right:0;margin:0 0 10px auto;width:150px}}
@media (prefers-reduced-motion:reduce){.folio-fa-aurora,.folio-fa-bubble,.folio-fa-fish,.folio-fa-cloud,.folio-fa-globe,.folio-fa-butterfly,.folio-fa-sparkle{animation:none}}
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
          <stop offset="0%" stopColor="#a8e6ff" />
          <stop offset="55%" stopColor="#00a2ff" />
          <stop offset="100%" stopColor="#0072e0" />
        </radialGradient>
      </defs>
      <path d="M32 4C32 4 12 30 12 42a20 20 0 1 0 40 0C52 30 32 4 32 4z" fill="url(#folio-fa-drop)" />
      <ellipse cx="24" cy="36" rx="6" ry="9" fill="#ffffff" opacity=".55" />
    </svg>
  );
}

function H2Icon({ d, g }: { d: string; g?: boolean }) {
  return (
    <span className={g ? "folio-fa-h2icon g" : "folio-fa-h2icon"} aria-hidden="true">
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
              "radial-gradient(circle at 34% 23%,rgba(255,255,255,1) 0 6%,rgba(255,255,255,0) 8.5%),radial-gradient(ellipse 60% 34% at 50% 13%,rgba(255,255,255,.95) 0 54%,rgba(255,255,255,.32) 64%,rgba(255,255,255,0) 68%),radial-gradient(ellipse 66% 30% at 50% 112%,rgba(170,255,205,.55) 0 56%,rgba(170,255,205,0) 64%),linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.02) 48%,rgba(190,255,215,.30))",
            border: "1.5px solid rgba(255,255,255,.95)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.9),inset 0 0 0 1px rgba(255,255,255,.35),0 1px 2px rgba(0,90,160,.18)",
          }}
        />
      ))}
    </div>
  );
}

function Fish({ top, left, scale, flip, color, delay }: { top: string; left: string; scale: number; flip?: boolean; color: string; delay: string }) {
  return (
    <img
      className="folio-fa-fish"
      src={color === "#00c853" ? FISH_GREEN_SRC : FISH_ORANGE_SRC}
      width={54}
      height={36}
      style={{ top, left, transform: `scale(${flip ? -scale : scale}, ${scale})`, animationDelay: delay }}
      alt=""
      aria-hidden="true"
    />
  );
}


function Cloud({ top, left, scale, delay }: { top: string; left: string; scale: number; delay: string }) {
  return <img className="folio-fa-cloud" src={CLOUD_SRC} width={280} height={120} style={{ top, left, transform: `scale(${scale})`, animationDelay: delay }} alt="" aria-hidden="true" />;
}

function Globe({ top, right, size, delay }: { top: string; right: string; size: number; delay: string }) {
  return <img className="folio-fa-globe" src={GLOBE_SRC} width={size} height={size} style={{ top, right, animationDelay: delay }} alt="" aria-hidden="true" />;
}

function Aurora() {
  return (
    <svg className="folio-fa-aurora" viewBox="0 0 1440 320" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="folio-fa-aurora-a" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#37f2c8" />
          <stop offset="52%" stopColor="#7dff8a" />
          <stop offset="100%" stopColor="#8a7dff" />
        </linearGradient>
        <linearGradient id="folio-fa-aurora-b" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4dc9ff" />
          <stop offset="55%" stopColor="#37f2c8" />
          <stop offset="100%" stopColor="#c07dff" />
        </linearGradient>
      </defs>
      <path d="M-40 218 C220 96 460 262 740 158 C1020 54 1260 96 1500 176 L1500 66 C1240 150 980 44 700 128 C430 209 210 118 -40 96 Z" fill="url(#folio-fa-aurora-a)" opacity=".34" />
      <path d="M-40 268 C260 170 520 300 820 208 C1090 126 1300 168 1500 226 L1500 148 C1270 208 1040 118 780 190 C520 262 260 190 -40 168 Z" fill="url(#folio-fa-aurora-b)" opacity=".22" />
    </svg>
  );
}

function Butterfly({ top, left, delay }: { top: string; left: string; delay: string }) {
  return <img className="folio-fa-butterfly" src={BUTTERFLY_SRC} width={52} height={44} style={{ top, left, animationDelay: delay }} alt="" aria-hidden="true" />;
}

function Sparkle({ top, left, size, delay }: { top: string; left: string; size: number; delay: string }) {
  return <img className="folio-fa-sparkle" src={SPARKLE_SRC} width={size} height={size} style={{ top, left, animationDelay: delay }} alt="" aria-hidden="true" />;
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
              opacity: b.o,
              animationDelay: `${b.d}s`,
              animationDuration: `${b.dur}s`,
            }}
          />
        ))}
      </div>
      <img className="folio-fa-backdrop" src={BACKDROP_SRC} alt="" aria-hidden="true" />
      <div className="folio-fa-sun" aria-hidden="true" />
      <Aurora />
      <span className="folio-fa-bokeh" style={{ width: 170, height: 170, top: "9%", right: "14%" }} aria-hidden="true" />
      <span className="folio-fa-bokeh" style={{ width: 210, height: 210, top: "34%", left: -60 }} aria-hidden="true" />
      <span className="folio-fa-bokeh" style={{ width: 130, height: 130, bottom: "16%", right: "5%", background: "radial-gradient(circle,rgba(190,255,200,.28),rgba(190,255,200,0) 62%)" }} aria-hidden="true" />
      <Cloud top="4rem" left="4%" scale={1} delay="0s" />
      <Cloud top="9.5rem" left="52%" scale={0.7} delay="2.2s" />
      <Cloud top="2.2rem" left="68%" scale={0.55} delay="4s" />
      <Globe top="21rem" right="5vw" size={148} delay="0.6s" />
      <Sparkle top="12rem" left="16%" size={22} delay="0s" />
      <Sparkle top="19rem" left="7%" size={14} delay="1.1s" />
      <Sparkle top="26rem" left="86%" size={16} delay="0.5s" />
      <Butterfly top="13.5rem" left="9%" delay="0s" />
      <div className="folio-fa-icon folio-fa-icon-ph" aria-hidden="true"><DropMark size={64} /></div>
      <Fish top="11.5rem" left="6%" scale={1} color="#ff8a00" delay="0s" />
      <Fish top="15.5rem" left="13%" scale={0.7} flip color="#00c853" delay="1.4s" />
      <div className="folio-fa-inner">
        <header className="folio-fa-header folio-fa-glass">
          <DropMark />
          <span className="name">tadanoen</span>
        </header>

        <div className="folio-fa-hero folio-fa-glass">
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
            <H2Icon g d="M12 21s-7.5-4.6-9.7-9A5.4 5.4 0 0 1 12 6.4 5.4 5.4 0 0 1 21.7 12C19.5 16.4 12 21 12 21z" />
            About
          </h2>
          <div className="folio-fa-aboutwrap">
            <Slot label="自己紹介" />
            <figure className="folio-fa-dolphin">
              <img src={DOLPHIN_SRC} alt="イルカ" />
            </figure>
          </div>
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
            <H2Icon g d="M3 12c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2M3 18c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2 2.5-2 3-2" />
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
            <H2Icon g d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />
            Links
          </h2>
          <div className="folio-fa-links">
            <Slot label="リンク" />
            <Slot label="リンク" />
            <Slot label="リンク" />
          </div>
        </section>

        <footer className="folio-fa-footer folio-fa-glass">
          <DropMark size={15} />
          <span>© tadanoen</span>
        </footer>
      </div>
    </div>
  );
}
