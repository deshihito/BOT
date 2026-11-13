"use client";
// BALKU オンライン対戦クライアント。ルーム作成・参加は REST、同期は
// SSE（GET /api/balku/rooms/[code]/events）が主経路で、接続できない
// 環境では1秒間隔ポーリングに自動フォールバックする。手番タイマーと
// オークション期限はローカルで再計算して表示する。
// セッション（ルームコードとプレイヤートークン）は sessionStorage の
// "balku-room-session" に保存し、再訪時に復帰を試みる。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MARKET_MATERIALS,
  TARGETED_EFFECTS,
  getMarketPrice,
  getTotalPoints,
  isLegalSubmission,
  scoreBreakdown,
  selectLegalMaterials,
  type BalkuSnapshot,
  type GameAction,
  type MaterialCard,
  type MaterialKind,
  type ProjectCard,
  type SnapshotPlayer,
  type SnapshotSubmission,
} from "@/lib/balku-game";
import {
  loadSoundSettings,
  playSe,
  saveSoundSettings,
  unlockAudio,
  type BalkuSoundSettings,
} from "@/lib/balku-sound";
import { useGamesNav } from "../GamesShell";

const SESSION_KEY = "balku-room-session";
const NAME_KEY = "balku-display-name";

type Session = { code: string; playerToken: string };
type ChatMessage = { id: string; playerId: number; name: string; text: string; at: number };
type RoomView = {
  code: string;
  status: BalkuSnapshot["phase"];
  revision: number;
  maxPlayers: number;
  player: { seat: number; displayName: string; isHost: boolean };
  state: BalkuSnapshot;
  chat: ChatMessage[];
  cpuSeats: number[];
};
type PublicRoom = { code: string; maxPlayers: number; playerCount: number; createdAt: number };

type EventBanner = { logId: string; title: string; tone: "good" | "warning" | "danger" };

/* --- ジェスチャ操作（Pointer Events、マウス/タッチ共通） ---
   対戦中のゲームアクションはボタンではなくオブジェクトを直接触る
   （ドラッグ／フリック／タップ）ことに一本化する。ドロップ先は
   位置だけでなく「ゾーン方向への速いフリック」でも解決する。 */
type DragPayload =
  | { source: "hand-project"; card: ProjectCard }
  | { source: "hand-material"; kind: MaterialKind }
  | { source: "attached-material"; kind: MaterialKind }
  | { source: "bundle" }
  | { source: "opponent-bundle"; ownerSeat: number; submissionId: string }
  | { source: "force-charge"; chargeId: string }
  | { source: "bid-coin"; plus: number }
  | { source: "market-material"; kind: MaterialKind }
  | { source: "turn-token" };
type DragState = { payload: DragPayload; x: number; y: number; label: string };
type DropZoneId = "build" | "sell" | "hand" | "submit-open" | "submit-down" | "auction" | "pass";
type FlyState = { name: string; x: number; y: number; w: number; h: number; dx: number; dy: number; go: boolean };

/* --- カード表現（ゲームの「物」は全部カードの見た目に統一する） --- */
const KIND_FACE: Record<string, string> = {
  木材: "wood",
  鉄骨: "steel",
  コンクリート: "concrete",
  ガラス: "glass",
  銅線: "copper",
  合金: "alloy",
  超伝導体: "super",
  ゴミ: "trash",
};

/** 素材の描き分けアイコン（絵文字ではなく SVG の線画で8種を描き分ける）。 */
function MatIcon({ kind }: { kind: MaterialKind }) {
  const common = {
    viewBox: "0 0 24 24",
    className: "balku-mat-icon",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "木材":
      return (
        <svg {...common}>
          <rect x="2.5" y="6.5" width="19" height="6" rx="3" />
          <circle cx="17.8" cy="9.5" r="1.5" />
          <path d="M5 16.5h13M8.5 19.5h10" strokeDasharray="0" />
          <rect x="4" y="14.5" width="16" height="5" rx="2.5" />
        </svg>
      );
    case "鉄骨":
      return (
        <svg {...common}>
          <path d="M5 4.5h14M5 19.5h14M12 4.5v15" />
          <path d="M8.5 4.5v15M15.5 4.5v15" strokeWidth="0.9" opacity="0.55" />
        </svg>
      );
    case "コンクリート":
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
          <circle cx="8" cy="10" r="0.4" fill="currentColor" />
          <circle cx="15.5" cy="9" r="0.4" fill="currentColor" />
          <circle cx="11" cy="14.5" r="0.4" fill="currentColor" />
          <circle cx="17.5" cy="14" r="0.4" fill="currentColor" />
        </svg>
      );
    case "ガラス":
      return (
        <svg {...common}>
          <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
          <path d="M8 17.5 16.5 6.5M11 19l6.5-8.5" strokeWidth="1.1" opacity="0.7" />
        </svg>
      );
    case "銅線":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4.8" />
          <circle cx="12" cy="12" r="1.6" />
        </svg>
      );
    case "合金":
      return (
        <svg {...common}>
          <path d="M6 15.5 8.8 8h6.4L18 15.5z" />
          <path d="M4.5 19h15M9.8 11.5h4.4" />
        </svg>
      );
    case "超伝導体":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.2" strokeDasharray="3.5 2.6" />
          <path d="M12.8 6.5 9 13h2.6l-1.2 4.8L14.5 11h-2.7z" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M8 5.5 12 3.8l3.4 1.4 4 2.2.6 4.2-1.8 4-3.8 3-4.6-.4-3.6-2.8L4.6 11 5.8 7.2z" />
          <path d="M8.5 6.5 11 11l4.5-3M11 11l1 6M11 11l5.5 2.5" strokeWidth="1.1" opacity="0.7" />
        </svg>
      );
  }
}

/** 素材カードの面。種類ごとの色面＋描き分けアイコンで、名前をそのまま読ませる。 */
function MatFace({ kind, premium = false, mini = false }: { kind: MaterialKind; premium?: boolean; mini?: boolean }) {
  return (
    <span className={`balku-matface balku-matface-${KIND_FACE[kind] ?? "trash"}${mini ? " balku-matface-mini" : ""}`}>
      <MatIcon kind={kind} />
      <span>{kind}</span>
      {premium ? <span className="balku-mat-rare">レア</span> : null}
    </span>
  );
}

/**
 * 企画ごとの個別イラスト。外部アセットではなく、フラットなベタ塗り SVG を
 * コードで組み立てる（企画名→モチーフ対応表＋効果タイプのフォールバック）。
 * 画風は素材アイコン（MatIcon）と同系統：太めの輪郭なし・ベタ塗り2色。
 */
type ArtMotif =
  | "house" | "houses" | "tower" | "office" | "bridge" | "dome" | "greenhouse"
  | "museum" | "hall" | "farm" | "wind" | "nuclear" | "power" | "antenna"
  | "rocket" | "port" | "aqua" | "wheel" | "lab" | "shelter" | "mystery"
  | "trash" | "crane" | "wrench" | "scroll" | "speech" | "eye" | "gear"
  | "leaf" | "logs" | "beam" | "blocks" | "pane" | "coil" | "crate"
  | "ground" | "chart" | "badge" | "sign" | "network" | "float" | "generic";

const PROJECT_ART: Record<string, ArtMotif> = {
  "ミステリーハウス": "mystery", "小屋": "house", "光ファイバー": "network",
  "ミュージアム": "museum", "ゴミ山": "trash", "解体工事": "wrench",
  "環境アセス": "leaf", "地下シェルター": "shelter", "スマート農場": "farm",
  "風力発電所": "wind", "水族館": "aqua", "宇宙港": "rocket",
  "緊急補修": "wrench", "独占契約": "scroll", "高層ビル": "tower",
  "原子力施設": "nuclear", "遊園地": "wheel", "整地": "ground",
  "資材調達": "crate", "コストカット": "chart", "文句": "speech",
  "産業スパイ": "eye", "内部工作": "gear", "木材調達": "logs",
  "鉄骨調達": "beam", "コンクリ調達": "blocks", "ガラス調達": "pane",
  "銅線調達": "coil", "ホール": "hall", "住宅街": "houses",
  "再開発": "crane", "巨大温室": "greenhouse", "つり橋": "bridge",
  "オフィス": "office", "ガラスドーム": "dome", "言いがかり": "speech",
  "品質保証": "badge", "文句を言うもんく": "speech", "施工停止命令": "sign",
  "通信制御棟": "antenna", "高耐久ドーム": "dome", "都市物流港": "port",
  "深層研究区": "lab", "量子通信塔": "antenna", "浮体都市中枢": "float",
  "電力供給網": "power",
};

const EFFECT_ART: Partial<Record<string, ArtMotif>> = {
  coins: "crate", draw: "scroll", pointBoost: "tower", stealCoins: "speech",
  stealCard: "eye", discard: "wrench", gainMaterial: "crate",
  randomMaterial: "crate", randomProject: "scroll", income: "power",
  forceBulk: "sign", mysteryHouse: "mystery",
};

const ART_COLORS: Record<ArtMotif, [string, string]> = {
  house: ["#c96f4a", "#7a3b2e"], houses: ["#b85c48", "#5d7a4e"], tower: ["#4a6b8a", "#2c4356"],
  office: ["#5d7d99", "#33566b"], bridge: ["#8a4f3d", "#d9a05a"], dome: ["#7fb3c8", "#3e7ca6"],
  greenhouse: ["#8fd0a8", "#3f8f5f"], museum: ["#d9c9a3", "#8a6d3b"], hall: ["#a3703f", "#5f3d22"],
  farm: ["#7ba05b", "#c94f43"], wind: ["#9db8c4", "#39bfe8"], nuclear: ["#b9c0c7", "#e0a100"],
  power: ["#f5c518", "#33566b"], antenna: ["#6d7f8c", "#39bfe8"], rocket: ["#e8e4da", "#c94f43"],
  port: ["#4a7d99", "#d9a05a"], aqua: ["#3e7ca6", "#7fd4e8"], wheel: ["#c95d7a", "#f5c518"],
  lab: ["#7a6fb0", "#57c785"], shelter: ["#6b6f66", "#3d4038"], mystery: ["#3a3f5c", "#8a7fd4"],
  trash: ["#8a7a5c", "#5d5240"], crane: ["#d9a05a", "#33566b"], wrench: ["#8c99a3", "#4a5a66"],
  scroll: ["#e8dcc0", "#a3854f"], speech: ["#e8e4da", "#c94f43"], eye: ["#e8e4da", "#33566b"],
  gear: ["#8c99a3", "#33566b"], leaf: ["#57c785", "#2c7a4b"], logs: ["#a3703f", "#6e4a26"],
  beam: ["#7d99ae", "#42657c"], blocks: ["#b9bcbe", "#7d8287"], pane: ["#a8d4e6", "#5b93ad"],
  coil: ["#c97b4a", "#8a4f26"], crate: ["#b3854f", "#7a5a30"], ground: ["#a38f6e", "#57c785"],
  chart: ["#5d7d99", "#c94f43"], badge: ["#f5c518", "#2c7a4b"], sign: ["#e36a61", "#e8e4da"],
  network: ["#33566b", "#39bfe8"], float: ["#4a7d99", "#f5c518"], generic: ["#5d7d99", "#33566b"],
};

function artShapes(motif: ArtMotif, m: string, a: string) {
  const ground = <rect x="0" y="30" width="48" height="6" fill="#00000022" />;
  const win = (x: number, y: number) => <rect key={`${x}-${y}`} x={x} y={y} width="3" height="4" fill="#ffe9a8" />;
  switch (motif) {
    case "house": return <>{ground}<polygon points="10,15 24,5 38,15" fill={a} /><rect x="14" y="15" width="20" height="15" fill={m} /><rect x="21" y="21" width="6" height="9" fill={a} />{win(16, 18)}{win(29, 18)}</>;
    case "houses": return <>{ground}<polygon points="2,18 12,10 22,18" fill={a} /><rect x="5" y="18" width="14" height="12" fill={m} /><polygon points="24,16 36,7 48,16" fill={a} /><rect x="27" y="16" width="17" height="14" fill={m} /><rect x="33" y="22" width="5" height="8" fill={a} /></>;
    case "tower": return <>{ground}<rect x="18" y="3" width="12" height="27" fill={m} /><rect x="16" y="1" width="16" height="3" fill={a} />{[7, 13, 19].map((y) => win(21, y))}{[7, 13, 19].map((y) => win(26, y))}</>;
    case "office": return <>{ground}<rect x="9" y="7" width="30" height="23" fill={m} />{[11, 17, 23].map((y) => [13, 20, 27, 34].map((x) => win(x, y)))}</>;
    case "bridge": return <>{ground}<rect x="2" y="24" width="44" height="3" fill={m} /><rect x="10" y="10" width="4" height="14" fill={a} /><rect x="34" y="10" width="4" height="14" fill={a} /><path d="M2 24 Q 24 8 46 24" stroke={a} strokeWidth="2" fill="none" /><path d="M12 17 L12 24 M24 13 L24 24 M36 17 L36 24" stroke={a} strokeWidth="1.5" /></>;
    case "dome": return <>{ground}<path d="M8 30 A 16 16 0 0 1 40 30 Z" fill={m} /><path d="M16 30 A 8 12 0 0 1 32 30" stroke={a} strokeWidth="2" fill="none" /><rect x="22" y="10" width="4" height="5" fill={a} /></>;
    case "greenhouse": return <>{ground}<path d="M6 30 A 18 18 0 0 1 42 30 Z" fill={m} opacity="0.75" /><path d="M15 30 A 9 14 0 0 1 33 30 M24 12 L24 30" stroke={a} strokeWidth="1.6" fill="none" /><polygon points="20,30 24,22 28,30" fill={a} /></>;
    case "museum": return <>{ground}<polygon points="24,4 44,13 4,13" fill={a} /><rect x="8" y="16" width="4" height="12" fill={m} /><rect x="17" y="16" width="4" height="12" fill={m} /><rect x="27" y="16" width="4" height="12" fill={m} /><rect x="36" y="16" width="4" height="12" fill={m} /><rect x="4" y="28" width="40" height="2" fill={a} /></>;
    case "hall": return <>{ground}<path d="M10 30 L10 16 A 14 12 0 0 1 38 16 L38 30 Z" fill={m} /><path d="M20 30 L20 22 A 4 5 0 0 1 28 22 L28 30 Z" fill={a} /></>;
    case "farm": return <>{ground}<circle cx="40" cy="7" r="4" fill={a} /><polygon points="8,16 20,8 32,16" fill={a} /><rect x="11" y="16" width="18" height="12" fill={m} /><path d="M2 30 L46 30 M4 33 L44 33" stroke={a} strokeWidth="1.6" /><polygon points="34,28 37,20 40,28" fill={a} /></>;
    case "wind": return <>{ground}<rect x="14" y="14" width="3" height="16" fill={m} /><polygon points="15.5,14 18,3 13.5,3" fill={a} /><polygon points="15.5,14 25,17 24,12" fill={a} /><polygon points="15.5,14 7,19 10,22" fill={a} /><rect x="30" y="20" width="12" height="10" fill={m} /><polygon points="28,20 36,14 44,20" fill={a} /></>;
    case "nuclear": return <>{ground}<polygon points="16,30 19,10 29,10 32,30" fill={m} /><ellipse cx="24" cy="7" rx="7" ry="3" fill={a} opacity="0.8" /><ellipse cx="31" cy="4" rx="5" ry="2.4" fill={a} opacity="0.55" /></>;
    case "power": return <>{ground}<polygon points="25,3 13,19 22,19 19,31 35,14 26,14" fill={m} stroke={a} strokeWidth="1.4" /></>;
    case "antenna": return <>{ground}<polygon points="24,8 16,30 32,30" fill="none" stroke={m} strokeWidth="2.4" /><path d="M14 12 A 13 13 0 0 1 34 12 M17 15 A 8 8 0 0 1 31 15" stroke={a} strokeWidth="2" fill="none" /><circle cx="24" cy="9" r="2.4" fill={a} /></>;
    case "rocket": return <>{ground}<polygon points="24,2 30,12 30,24 18,24 18,12" fill={m} /><polygon points="18,20 12,28 18,27 30,27 36,28 30,20" fill={a} /><circle cx="24" cy="14" r="3.4" fill={a} /><polygon points="21,28 24,35 27,28" fill="#f5c518" /></>;
    case "port": return <>{ground}<rect x="6" y="6" width="3" height="20" fill={m} /><rect x="6" y="6" width="30" height="3" fill={m} /><line x1="30" y1="9" x2="30" y2="16" stroke={a} strokeWidth="1.6" /><rect x="26" y="16" width="9" height="6" fill={a} /><rect x="8" y="22" width="11" height="6" fill={a} /><path d="M0 32 Q 6 29 12 32 T 24 32 T 36 32 T 48 32" stroke={m} strokeWidth="2" fill="none" /></>;
    case "aqua": return <>{ground}<path d="M0 10 Q 6 6 12 10 T 24 10 T 36 10 T 48 10" stroke={m} strokeWidth="2.4" fill="none" /><ellipse cx="22" cy="22" rx="9" ry="5" fill={a} /><polygon points="30,22 37,17 37,27" fill={a} /><circle cx="18" cy="21" r="1.4" fill="#fff" /><circle cx="38" cy="14" r="1.8" fill={m} /><circle cx="42" cy="19" r="1.2" fill={m} /></>;
    case "wheel": return <>{ground}<circle cx="24" cy="15" r="11" fill="none" stroke={m} strokeWidth="2.4" /><path d="M24 4 L24 26 M13 15 L35 15 M16 7 L32 23 M32 7 L16 23" stroke={a} strokeWidth="1.4" /><polygon points="24,26 17,32 31,32" fill={a} /></>;
    case "lab": return <>{ground}<polygon points="20,6 28,6 28,14 36,27 36,30 12,30 12,27 20,14" fill={m} opacity="0.85" /><rect x="18" y="3" width="12" height="3" fill={a} /><circle cx="21" cy="24" r="2" fill={a} /><circle cx="27" cy="26" r="1.5" fill={a} /><rect x="14" y="27" width="20" height="3" fill={a} opacity="0.7" /></>;
    case "shelter": return <><rect x="0" y="24" width="48" height="12" fill={a} opacity="0.5" /><path d="M8 24 A 16 12 0 0 1 40 24 Z" fill={m} /><rect x="20" y="17" width="8" height="7" fill={a} /></>;
    case "mystery": return <>{ground}<circle cx="39" cy="7" r="4.4" fill={a} /><polygon points="8,16 22,7 36,16" fill={a} /><rect x="11" y="16" width="22" height="14" fill={m} /><rect x="19" y="21" width="6" height="9" fill="#171a2e" /><circle cx="15" cy="12" r="1.3" fill="#ffe9a8" /><circle cx="30" cy="10" r="1" fill="#ffe9a8" /></>;
    case "trash": return <>{ground}<polygon points="6,30 16,16 26,24 33,14 44,30" fill={m} /><rect x="18" y="10" width="6" height="5" fill={a} transform="rotate(18 21 12)" /><circle cx="33" cy="12" r="2.6" fill={a} /></>;
    case "crane": return <>{ground}<rect x="10" y="4" width="3.4" height="26" fill={m} /><rect x="10" y="4" width="34" height="3.4" fill={m} /><line x1="38" y1="7" x2="38" y2="15" stroke={a} strokeWidth="1.6" /><rect x="33" y="15" width="10" height="7" fill={a} /><rect x="20" y="22" width="12" height="8" fill={a} opacity="0.65" /></>;
    case "wrench": return <>{ground}<circle cx="17" cy="12" r="6" fill="none" stroke={m} strokeWidth="4" /><rect x="21" y="15" width="5" height="16" fill={m} transform="rotate(-38 23 23)" /><circle cx="38" cy="10" r="2" fill={a} /></>;
    case "scroll": return <>{ground}<rect x="10" y="10" width="28" height="16" fill={m} /><circle cx="10" cy="18" r="5" fill={a} /><circle cx="38" cy="18" r="5" fill={a} /><path d="M16 16 L32 16 M16 21 L29 21" stroke={a} strokeWidth="1.8" /></>;
    case "speech": return <>{ground}<rect x="7" y="7" width="34" height="17" rx="5" fill={m} /><polygon points="16,24 14,31 24,24" fill={m} /><circle cx="17" cy="15" r="2" fill={a} /><circle cx="24" cy="15" r="2" fill={a} /><circle cx="31" cy="15" r="2" fill={a} /></>;
    case "eye": return <>{ground}<ellipse cx="24" cy="17" rx="17" ry="9" fill={m} /><circle cx="24" cy="17" r="5.4" fill={a} /><circle cx="24" cy="17" r="2.2" fill="#171a2e" /></>;
    case "gear": return <>{ground}<circle cx="24" cy="17" r="9" fill={m} /><circle cx="24" cy="17" r="3.6" fill="#dceef5" />{[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => <rect key={deg} x="22.4" y="4" width="3.2" height="6" fill={a} transform={`rotate(${deg} 24 17)`} />)}</>;
    case "leaf": return <>{ground}<path d="M10 28 C 8 12 20 5 38 6 C 37 24 26 31 10 28 Z" fill={m} /><path d="M12 27 C 20 19 28 12 36 8" stroke={a} strokeWidth="1.8" fill="none" /></>;
    case "logs": return <>{ground}<rect x="6" y="10" width="30" height="7" rx="3.5" fill={m} /><rect x="10" y="19" width="30" height="7" rx="3.5" fill={m} /><circle cx="36" cy="13.5" r="3.4" fill={a} /><circle cx="40" cy="22.5" r="3.4" fill={a} /></>;
    case "beam": return <>{ground}<rect x="8" y="9" width="32" height="4.6" fill={m} /><rect x="8" y="23" width="32" height="4.6" fill={m} /><rect x="21" y="13" width="6" height="10" fill={a} /></>;
    case "blocks": return <>{ground}<rect x="8" y="21" width="15" height="8" fill={m} /><rect x="25" y="21" width="15" height="8" fill={a} opacity="0.75" /><rect x="16" y="12" width="15" height="8" fill={m} opacity="0.85" /></>;
    case "pane": return <>{ground}<rect x="12" y="6" width="24" height="24" fill={m} opacity="0.8" /><path d="M17 26 L29 10 M23 28 L33 14" stroke={a} strokeWidth="2.4" /></>;
    case "coil": return <>{ground}<ellipse cx="24" cy="11" rx="12" ry="4.6" fill="none" stroke={m} strokeWidth="3" /><ellipse cx="24" cy="18" rx="12" ry="4.6" fill="none" stroke={a} strokeWidth="3" /><ellipse cx="24" cy="25" rx="12" ry="4.6" fill="none" stroke={m} strokeWidth="3" /></>;
    case "crate": return <>{ground}<rect x="11" y="9" width="26" height="21" fill={m} /><path d="M11 9 L37 30 M37 9 L11 30" stroke={a} strokeWidth="2.2" /></>;
    case "ground": return <>{ground}<rect x="4" y="27" width="40" height="3.4" fill={m} /><path d="M6 23 L42 23" stroke={a} strokeWidth="1.6" strokeDasharray="4 3" /><rect x="35" y="10" width="2" height="13" fill={a} /><polygon points="37,10 44,12.4 37,15" fill="#c94f43" /></>;
    case "chart": return <>{ground}<rect x="9" y="10" width="6" height="17" fill={m} /><rect x="19" y="15" width="6" height="12" fill={m} opacity="0.8" /><rect x="29" y="20" width="6" height="7" fill={m} opacity="0.6" /><path d="M8 8 L40 22" stroke={a} strokeWidth="2.2" /><polygon points="40,22 34,21 37,16" fill={a} /></>;
    case "badge": return <>{ground}<circle cx="24" cy="15" r="9" fill={m} /><path d="M19 15 L22.6 18.6 L29 11.6" stroke={a} strokeWidth="2.4" fill="none" /><polygon points="19,22 16,31 22,27 24,31 27,26" fill={a} /></>;
    case "sign": return <>{ground}<polygon points="17,5 31,5 38,12 38,22 31,29 17,29 10,22 10,12" fill={m} /><rect x="16" y="14.6" width="16" height="4.4" fill={a} /></>;
    case "network": return <>{ground}<path d="M10 24 L24 10 L38 24 M24 10 L24 27" stroke={a} strokeWidth="1.8" /><circle cx="10" cy="24" r="3.6" fill={m} /><circle cx="38" cy="24" r="3.6" fill={m} /><circle cx="24" cy="10" r="3.6" fill={m} /><circle cx="24" cy="28" r="3" fill={a} /></>;
    case "float": return <>{ground}<rect x="19" y="8" width="10" height="12" fill={m} />{win(22, 12)}<polygon points="10,20 38,20 33,27 15,27" fill={a} /><path d="M2 31 Q 8 28 14 31 T 26 31 T 38 31 T 48 31" stroke={m} strokeWidth="2" fill="none" /></>;
    default: return <>{ground}<rect x="13" y="12" width="22" height="18" fill={m} /><polygon points="10,12 24,4 38,12" fill={a} />{win(18, 18)}{win(27, 18)}<rect x="21" y="23" width="6" height="7" fill={a} /></>;
  }
}

function ProjectArt({ name, effectType, mini = false }: { name: string; effectType?: string; mini?: boolean }) {
  const motif = PROJECT_ART[name] ?? EFFECT_ART[effectType ?? ""] ?? "generic";
  const [main, accent] = ART_COLORS[motif];
  return (
    <svg className={`balku-art${mini ? " balku-art-mini" : ""}`} viewBox="0 0 48 36" aria-hidden="true" focusable="false">
      {artShapes(motif, main, accent)}
    </svg>
  );
}

/** 残り時間バー（数字と併せて「減っていく」こと自体を見せる）。 */
function TimerBar({ sec, total }: { sec: number; total: number }) {
  const pct = Math.max(0, Math.min(100, (sec / total) * 100));
  const level = pct <= 25 ? " balku-timerbar-danger" : pct <= 50 ? " balku-timerbar-warn" : "";
  return (
    <span className={`balku-timerbar${level}`} aria-hidden="true">
      <span className="balku-timerbar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** 最終精算の点数カウントアップ（精算行が現れてから短く数える）。 */
function CountUp({ value, delayMs = 0 }: { value: number; delayMs?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    let startAt: number | null = null;
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(value);
      return;
    }
    const tick = (t: number) => {
      if (startAt === null) startAt = t + delayMs;
      const p = Math.min(1, Math.max(0, (t - startAt) / 550));
      setShown(Math.round(value * p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, delayMs]);
  return <>{shown}</>;
}

/** カード裏面（AGOシアン）。 */
function CardBack({ mini = false }: { mini?: boolean }) {
  return (
    <span className={`balku-cardback${mini ? " balku-cardback-mini" : ""}`} aria-hidden="true">
      B
    </span>
  );
}

/** 裏面の束＋枚数（相手の手札や山札の表現）。 */
function BackStack({ count }: { count: number }) {
  return (
    <span className="balku-backstack" aria-label={`カード ${count}枚`}>
      <CardBack mini />
      <span className="balku-backstack-count">×{count}</span>
    </span>
  );
}

/** 大きなイベントのログだけをバナー表示用に拾う（通常の提出・ドローでは出さない）。 */
function toEventBanner(log: { id: string; text: string } | undefined): EventBanner | null {
  if (!log) return null;
  const { id, text } = log;
  if (text.includes("強制BALKU発動")) return { logId: id, title: "確定BALKU", tone: "danger" };
  if (text.includes("BALKU成功")) return { logId: id, title: "違法建築を接収", tone: "good" };
  if (text.includes("BALKU失敗")) return { logId: id, title: "BALKU 失敗", tone: "danger" };
  if (text.includes("自動オークション成立")) return { logId: id, title: "落札成立", tone: "good" };
  if (text.includes("山札消尽")) return { logId: id, title: "最終精算", tone: "warning" };
  if (text.includes("脱落")) return { logId: id, title: "施工者脱落", tone: "danger" };
  return null;
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return typeof parsed.code === "string" && typeof parsed.playerToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export default function BalkuClient() {
  const { prefix } = useGamesNav();
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [syncMode, setSyncMode] = useState<"sse" | "polling">("sse");
  const [name, setName] = useState("");
  const [createMax, setCreateMax] = useState(2);
  const [isPublic, setIsPublic] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // 提出時の添付素材は「種類ごとの枚数」で持つ。実カードIDは送信時に
  // 手札の先頭から割り当てる（エンジンの判定は種類カウントなので等価）。
  const [attachCounts, setAttachCounts] = useState<Record<string, number>>({});
  const [targetSeat, setTargetSeat] = useState<number | undefined>(undefined);
  const [banner, setBanner] = useState<EventBanner | null>(null);
  // BALKU で開示された束の一時フラッシュ（key = "seat:submissionId"）
  const [flashKeys, setFlashKeys] = useState<Record<string, true>>({});
  // 開示フリップ（裏→表にめくれる対象束。key は flashKeys と同じ）
  const [flipKeys, setFlipKeys] = useState<Record<string, true>>({});
  // 接収で消えた束の開示カード（場に短くフリップ表示する）
  const [revealCard, setRevealCard] = useState<{ name: string; legal: boolean; key: string; seized?: boolean } | null>(null);
  const [burstKey, setBurstKey] = useState<string | null>(null);
  const [selfHurtKey, setSelfHurtKey] = useState<string | null>(null);
  // 自分のコイン増減ポップ（前スナップショットとの差分）
  const [coinPop, setCoinPop] = useState<{ delta: number; key: number } | null>(null);
  const prevCoinsRef = useRef<number | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  viewRef.current = view;
  const lastLogIdRef = useRef<string | null>(null);
  const prevSubsRef = useRef<Map<string, boolean>>(new Map());
  // --- サウンド（BGM / SE の個別ミュートは localStorage に保存） ---
  const [soundSettings, setSoundSettings] = useState<BalkuSoundSettings>({ bgm: true, se: true });
  const soundPrimedRef = useRef(false);
  const prevActiveSeatRef = useRef<number | null>(null);
  const finishSoundRef = useRef<string | null>(null);
  // --- ルーム内チャット（右下固定ウィジェット） ---
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const lastSeenChatIdRef = useRef<string | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  // --- ドラッグ＆ドロップ ---
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropHot, setDropHot] = useState<DropZoneId | null>(null);
  const [fly, setFly] = useState<FlyState | null>(null);
  const [hoverCard, setHoverCard] = useState<string | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // --- 拡大表示（同時表示を減らす代わりに、詳細は必ず大サイズで読めるようにする） ---
  // detailSeat: その席の提出束すべてを全サイズで見せる詳細シート。
  // preview: 単体カード（企画/素材）の拡大プレビュー。どちらもステージ上の重なりで、
  // ステージの行レイアウトには一切影響しない。
  const [detailSeat, setDetailSeat] = useState<number | null>(null);
  const [preview, setPreview] = useState<
    | { type: "project"; card: ProjectCard }
    | { type: "material"; kind: MaterialKind; premium: boolean }
    | null
  >(null);
  // シートのハンドルを下方向へ引いて閉じるための開始Y（詳細/プレビュー共通）
  const sheetPullRef = useRef<number | null>(null);
  const dragTrackRef = useRef<{
    payload: DragPayload;
    label: string;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    mode: "undecided" | "drag" | "fan";
    samples: { t: number; x: number; y: number }[];
    fanEl: HTMLElement | null;
    fanStartScroll: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const buildZoneRef = useRef<HTMLElement | null>(null);
  const sellZoneRef = useRef<HTMLDivElement | null>(null);
  const handZoneRef = useRef<HTMLElement | null>(null);
  const seatsRef = useRef<HTMLDivElement | null>(null);
  const auctionRef = useRef<HTMLDivElement | null>(null);
  const openPadRef = useRef<HTMLDivElement | null>(null);
  const downPadRef = useRef<HTMLDivElement | null>(null);

  // --- セッション復元と表示名 ---
  useEffect(() => {
    setSession(loadSession());
    try {
      setName(sessionStorage.getItem(NAME_KEY) ?? "");
    } catch {
      // 保存名が無くてもよい
    }
  }, []);

  const saveSession = useCallback((next: Session | null) => {
    try {
      if (next) sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // 保存できなくても対戦は続けられる
    }
    setSession(next);
    if (!next) setView(null);
  }, []);

  const saveName = useCallback((value: string) => {
    setName(value);
    try {
      sessionStorage.setItem(NAME_KEY, value);
    } catch {
      // 保存できなくてもよい
    }
  }, []);

  // --- サウンド初期化（設定読み込み＋最初の操作で AudioContext を解放） ---
  useEffect(() => {
    setSoundSettings(loadSoundSettings());
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  const toggleSound = (key: keyof BalkuSoundSettings) => {
    unlockAudio();
    const next = { ...soundSettings, [key]: !soundSettings[key] };
    setSoundSettings(next);
    saveSoundSettings(next);
    if (next.se && key === "se") playSe("click");
  };

  // エラーが出たらエラー音
  useEffect(() => {
    if (error) playSe("error");
  }, [error]);

  // --- 同期 ---
  const fetchView = useCallback(
    async (target: Session): Promise<RoomView | null> => {
      try {
        const res = await fetch(`/api/balku/rooms/${target.code}?token=${encodeURIComponent(target.playerToken)}`, { cache: "no-store" });
        if (res.status === 403 || res.status === 404) {
          setError("ルームから切断されました。");
          saveSession(null);
          return null;
        }
        if (!res.ok) return null;
        const data = (await res.json()) as RoomView;
        setView(data);
        return data;
      } catch {
        return null;
      }
    },
    [saveSession],
  );

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    void fetchView(session);
    const startPolling = () => {
      if (pollTimer || cancelled) return;
      setSyncMode("polling");
      pollTimer = setInterval(() => {
        void fetchView(session);
      }, 1000);
    };
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/balku/rooms/${session.code}/events?token=${encodeURIComponent(session.playerToken)}`);
      es.onmessage = (event) => {
        try {
          setView(JSON.parse(event.data as string) as RoomView);
          setSyncMode("sse");
        } catch {
          // 壊れたイベントは無視する
        }
      };
      es.addEventListener("room-error", () => {
        es?.close();
        saveSession(null);
      });
      es.onerror = () => {
        // SSE が使えない環境では1秒ポーリングへ切り替える
        es?.close();
        startPolling();
      };
    } catch {
      startPolling();
    }
    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [session, fetchView, saveSession]);

  // 公開ルーム一覧（ロビー表示中だけ自動更新）
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/balku/rooms/public", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { rooms: PublicRoom[] };
        if (!cancelled) setPublicRooms(data.rooms ?? []);
      } catch {
        // 一覧が取れなくても作成・参加はできる
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);

  // タイマー表示用のローカル刻み
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // --- 操作 ---
  const postJson = async (url: string, body: unknown): Promise<{ res: Response; data: Record<string, unknown> }> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, data };
  };

  const validName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("名前は2〜24文字で入力してください。");
      return null;
    }
    return trimmed;
  };

  const createRoom = async () => {
    const displayName = validName();
    if (!displayName || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/balku/rooms", { displayName, maxPlayers: createMax, isPublic });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "ルームを作成できませんでした。");
        return;
      }
      saveSession({ code: String(data.code), playerToken: String(data.playerToken) });
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const joinRoom = async (code: string) => {
    const displayName = validName();
    if (!displayName || busy) return;
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(normalized)) {
      setError("ルームコードは6文字で入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson("/api/balku/rooms/join", { code: normalized, displayName });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "参加できませんでした。");
        return;
      }
      saveSession({ code: String(data.code), playerToken: String(data.playerToken) });
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const doMove = async (action: GameAction) => {
    const current = viewRef.current;
    if (!session || !current || busy) return;
    setBusy(true);
    setError("");
    // 自分の操作には即座に SE を返す（結果系はログ連動で鳴らす）
    if (action.type === "submit") playSe("submit");
    else if (action.type === "buyMaterial") playSe("shop");
    else if (action.type === "sellCards") playSe("sell");
    else if (action.type === "bid") playSe("bid");
    else if (action.type === "endTurn") playSe("click");
    const postMove = (revision: number) =>
      postJson(`/api/balku/rooms/${session.code}/move`, {
        playerToken: session.playerToken,
        expectedRevision: revision,
        action,
      });
    try {
      let { res, data } = await postMove(current.revision);
      // BALKU系は手番外アクションで、CPU進行やオークションで revision が
      // 頻繁に進む局面とぶつかり 409 になりやすい（「押せない」体感の主因）。
      // bulkCall / forceBulk に限り、最新盤面を取り直して1回だけ再送する。
      // 対象の束が最新盤面で消えている場合はサーバーが 400 を返し、通常の
      // エラー表示に落ちる（無効なコールを蘇らせはしない）。
      if (res.status === 409 && (action.type === "bulkCall" || action.type === "forceBulk")) {
        const fresh = await fetchView(session);
        if (fresh) {
          ({ res, data } = await postMove(fresh.revision));
        }
      }
      if (res.status === 409) {
        setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。");
        await fetchView(session);
      } else if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "操作できませんでした。");
      } else {
        // 操作が成立したら拡大表示は役目を終える（盤面が変わるため閉じる）
        setDetailSeat(null);
        setPreview(null);
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const doHostAction = async (kind: "start" | "restart") => {
    const current = viewRef.current;
    if (!session || !current || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/${kind}`, {
        playerToken: session.playerToken,
        expectedRevision: current.revision,
      });
      if (res.status === 409) {
        setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。");
        await fetchView(session);
      } else if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "操作できませんでした。");
      } else {
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const leaveRoom = async () => {
    if (!session || busy) return;
    const current = viewRef.current;
    setBusy(true);
    try {
      if (current) {
        const { res, data } = await postJson(`/api/balku/rooms/${session.code}/leave`, {
          playerToken: session.playerToken,
          expectedRevision: current.revision,
        });
        if (res.status === 409) {
          setNotice(typeof data.error === "string" ? data.error : "盤面が更新されました。もう一度退出してください。");
          await fetchView(session);
          return;
        }
      }
      saveSession(null);
      setView(null);
      setError("");
      setNotice("");
    } catch {
      // 通信できなくても手元のセッションは破棄する
      saveSession(null);
    } finally {
      setBusy(false);
    }
  };

  const sendChat = async () => {
    const text = chatText.trim();
    if (!session || !text || chatSending) return;
    setChatSending(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/chat`, {
        playerToken: session.playerToken,
        text,
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "メッセージを送信できませんでした。");
        return;
      }
      setChatText("");
      playSe("click");
      await fetchView(session);
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setChatSending(false);
    }
  };

  const doCpu = async (action: "add" | "remove", seat?: number) => {
    if (!session || busy) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await postJson(`/api/balku/rooms/${session.code}/cpu`, {
        playerToken: session.playerToken,
        action,
        ...(seat !== undefined ? { seat } : {}),
      });
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "CPUを操作できませんでした。");
      } else {
        playSe("click");
        await fetchView(session);
      }
    } catch {
      setError("通信に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice(`ルームコード: ${session.code}`);
    }
  };

  // --- 対戦中の選択状態の掃除 ---
  const state = view?.state;
  const mySeat = view?.player.seat ?? -1;
  const me: SnapshotPlayer | undefined = state?.players.find((p) => p.seat === mySeat);
  useEffect(() => {
    if (selectedProjectId && me && !me.hand.some((c) => c.id === selectedProjectId)) {
      setSelectedProjectId(null);
      setAttachCounts({});
      setTargetSeat(undefined);
    }
    // me の同一性はポーリングごとに変わるため、手札の中身で判定する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.turn, state?.activeSeat, me?.hand.length]);

  // --- チャット: 未読管理と自動スクロール ---
  const chatMessages = view?.chat ?? [];
  const lastSeenIdx = chatMessages.findIndex((m) => m.id === lastSeenChatIdRef.current);
  const chatUnread =
    lastSeenChatIdRef.current === null
      ? 0
      : chatMessages.slice(lastSeenIdx + 1).filter((m) => m.playerId !== mySeat).length;
  // 初回表示では既存の履歴を未読にしない
  useEffect(() => {
    if (lastSeenChatIdRef.current === null && chatMessages.length > 0) {
      lastSeenChatIdRef.current = chatMessages[chatMessages.length - 1].id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.revision]);
  // 開いている間は既読にし続け、一番下へスクロールする
  useEffect(() => {
    if (!chatOpen) return;
    if (chatMessages.length > 0) {
      lastSeenChatIdRef.current = chatMessages[chatMessages.length - 1].id;
    }
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen, chatMessages.length, view?.revision]);

  // --- 演出: イベントバナー（同じログでは二度出さない）＋ログ連動 SE ---
  const latestLog = state?.logs[0];
  useEffect(() => {
    if (!latestLog || lastLogIdRef.current === latestLog.id) return;
    lastLogIdRef.current = latestLog.id;
    // 最初のスナップショットでは音を鳴らさない（過去ログの再生防止）
    const primed = soundPrimedRef.current;
    soundPrimedRef.current = true;
    if (primed) {
      const text = latestLog.text;
      if (text.includes("強制BALKU発動")) playSe("forceBulk");
      else if (text.includes("BALKU成功")) playSe("bulkSuccess");
      else if (text.includes("BALKU失敗")) playSe("bulkFail");
      else if (text.includes("自動オークション成立")) {
        playSe("auctionWin");
        playSe("coin");
      } else if (text.includes("落札")) playSe("coin");
      if (text.includes("落札") || text.includes("自動オークション成立")) setBurstKey(latestLog.id);
      if (text.includes("BALKU失敗")) {
        const caller = text.match(/BALKU失敗。(.+?)は/)?.[1];
        const myName = state?.players.find((p) => p.seat === mySeat)?.name;
        if (caller && myName && caller === myName) setSelfHurtKey(latestLog.id);
      }
      else if (text.includes("公開で") || text.includes("伏せ企画を完成") || text.includes("伏せて")) playSe("play");
    }
    const event = toEventBanner(latestLog);
    if (!event) return;
    setBanner(event);
    const timer = setTimeout(() => setBanner((b) => (b?.logId === event.logId ? null : b)), 2200);
    return () => clearTimeout(timer);
  }, [latestLog]);

  // --- SE: 自分の手番が来たら知らせる ---
  useEffect(() => {
    if (!state || state.phase !== "active") return;
    const prev = prevActiveSeatRef.current;
    prevActiveSeatRef.current = state.activeSeat;
    if (prev !== null && prev !== state.activeSeat && state.activeSeat === mySeat) playSe("turn");
    // mySeat は view から決まる値なので state の変化だけで追う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.activeSeat, state?.phase]);

  // --- SE: 終局（勝ち/負けを一度だけ） ---
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    const key = `${state.turn}:${state.finalScores.map((s) => s.seat).join(",")}`;
    if (finishSoundRef.current === key) return;
    finishSoundRef.current = key;
    playSe(state.winnerSeats.includes(mySeat) ? "win" : "lose");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.phase]);

  // --- 演出: 伏せ束が BALKU で開示されたら対象の束を揺らす ---
  useEffect(() => {
    if (!state) return;
    const next = new Map<string, boolean>();
    const flashes: string[] = [];
    for (const p of state.players) {
      for (const sub of p.submitted) {
        const key = `${p.seat}:${sub.id}`;
        next.set(key, sub.faceUp);
        if (prevSubsRef.current.get(key) === false && sub.faceUp) flashes.push(key);
      }
    }
    prevSubsRef.current = next;
    if (flashes.length === 0) return;
    setFlashKeys((prev) => {
      const cp = { ...prev };
      for (const k of flashes) cp[k] = true;
      return cp;
    });
    setFlipKeys((prev) => {
      const cp = { ...prev };
      for (const k of flashes) cp[k] = true;
      return cp;
    });
    // めくれた束は場の開示カードでも見せる（誰の束が何だったか一目で分かる）
    if (state) {
      for (const p of state.players) {
        for (const sub of p.submitted) {
          if (flashes.includes(`${p.seat}:${sub.id}`)) {
            setRevealCard({ name: sub.project.name, legal: sub.legal, key: `${p.seat}:${sub.id}` });
          }
        }
      }
    }
    const timer = setTimeout(() => {
      setFlashKeys((prev) => {
        const cp = { ...prev };
        for (const k of flashes) delete cp[k];
        return cp;
      });
      setFlipKeys((prev) => {
        const cp = { ...prev };
        for (const k of flashes) delete cp[k];
        return cp;
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [state]);

  // --- 演出: 接収で消えた束は、ログの開示名で開示カードをフリップ表示する ---
  useEffect(() => {
    if (!latestLog) return;
    const text = latestLog.text;
    let name: string | null = null;
    if (text.includes("BALKU成功")) {
      name = text.match(/違法建築「([^」]+)」/)?.[1] ?? null;
    } else if (text.includes("強制BALKU発動")) {
      const quoted = [...text.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
      name = quoted.length >= 2 ? quoted[1] : null;
    }
    if (!name) return;
    setRevealCard({ name, legal: false, key: `log:${latestLog.id}`, seized: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestLog?.id]);

  // 開示カードは短く出して消す
  useEffect(() => {
    if (!revealCard) return;
    const timer = setTimeout(() => setRevealCard((r) => (r?.key === revealCard.key ? null : r)), 2100);
    return () => clearTimeout(timer);
  }, [revealCard]);

  // 落札バーストと自領域の崩れは短く出して消す
  useEffect(() => {
    if (!burstKey) return;
    const timer = setTimeout(() => setBurstKey((k) => (k === burstKey ? null : k)), 1300);
    return () => clearTimeout(timer);
  }, [burstKey]);
  useEffect(() => {
    if (!selfHurtKey) return;
    const timer = setTimeout(() => setSelfHurtKey((k) => (k === selfHurtKey ? null : k)), 900);
    return () => clearTimeout(timer);
  }, [selfHurtKey]);

  // --- 演出: ドローで山札から手札へカードが飛ぶ（初回スナップショットは除く） ---
  const seenHandRef = useRef<Set<string>>(new Set());
  const handPrimedRef = useRef(false);
  const myHandCards = state?.players.find((p) => p.seat === mySeat)?.hand ?? [];
  const dealIds = handPrimedRef.current ? new Set(myHandCards.filter((c) => !seenHandRef.current.has(c.id)).map((c) => c.id)) : new Set<string>();
  const myHandIdsKey = myHandCards.map((c) => c.id).join(",");
  useEffect(() => {
    for (const c of myHandCards) seenHandRef.current.add(c.id);
    handPrimedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myHandIdsKey]);

  // --- 演出: 自分のコインが動いたら +N / −N を浮かせる ---
  const myCoinsNow = state?.players.find((p) => p.seat === mySeat)?.coins;
  useEffect(() => {
    if (myCoinsNow === undefined) return;
    const prev = prevCoinsRef.current;
    prevCoinsRef.current = myCoinsNow;
    if (prev === null || prev === myCoinsNow) return;
    setCoinPop({ delta: myCoinsNow - prev, key: Date.now() });
    const timer = setTimeout(() => setCoinPop(null), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myCoinsNow]);

  const header = (
    <>
      {/* 対戦中はページ見出しを畳み、ステージの実寸を稼ぐ（ステージ寸法の
          予約高は、この畳んだ状態＝実測 chrome 前提で決めている）。 */}
      {!(view && view.status === "active") && (
        <>
          <nav className="breadcrumbs" aria-label="パンくず">
            <Link href={`${prefix}/games`}>ゲーム</Link>
            <span> / </span>
            <span>BALKU</span>
          </nav>
          <div className="page-heading compact-heading">
            <h1>BALKU</h1>
            <p className="muted">素材を集めて企画を完成させる、オンライン建築ブラフ。</p>
          </div>
        </>
      )}
      {!(view && view.status === "active") && (
      <div className="balku-soundbar" role="group" aria-label="サウンド設定">
        <button
          type="button"
          className={`balku-snd-btn${soundSettings.bgm ? " balku-snd-on" : ""}`}
          aria-pressed={soundSettings.bgm}
          onClick={() => toggleSound("bgm")}
        >
          ♪ BGM {soundSettings.bgm ? "ON" : "OFF"}
        </button>
        <button
          type="button"
          className={`balku-snd-btn${soundSettings.se ? " balku-snd-on" : ""}`}
          aria-pressed={soundSettings.se}
          onClick={() => toggleSound("se")}
        >
          SE {soundSettings.se ? "ON" : "OFF"}
        </button>
      </div>
      )}
      {error && (
        <p className="balku-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="balku-notice">{notice}</p>}
    </>
  );

  // --- ロビー ---
  if (!session) {
    return (
      <>
        {header}
        <div className="balku-table balku-table-lobby">
        <ol className="balku-steps">
          <li>
            <strong>1.</strong> 素材を集めて企画を完成させる
          </li>
          <li>
            <strong>2.</strong> 伏せ提出でブラフ、怪しければ BALKU で暴く
          </li>
          <li>
            <strong>3.</strong> 山札が尽きたら最終精算。高得点の勝ち
          </li>
        </ol>
        <div className="balku-lobby-grid">
          <section className="balku-panel">
            <h2>ルームを作成 / 参加</h2>
            <label className="balku-field">
              <span>あなたの名前</span>
              <input
                className="balku-input"
                value={name}
                onChange={(e) => saveName(e.target.value)}
                placeholder="2〜24文字"
                maxLength={24}
              />
            </label>
            <div className="balku-field">
              <span>人数（作成時）</span>
              <div className="balku-segmented" role="group" aria-label="人数">
                {[2, 3, 4].map((n) => (
                  <button key={n} type="button" aria-pressed={createMax === n} className={createMax === n ? "balku-segmented-active" : ""} onClick={() => setCreateMax(n)}>
                    {n}人
                  </button>
                ))}
              </div>
            </div>
            <label className="balku-check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
              公開ルームにする（一覧に載せる）
            </label>
            <button type="button" className="balku-btn balku-btn-primary" onClick={createRoom} disabled={busy}>
              ルームを作成
            </button>
            <div className="balku-join-row">
              <input
                className="balku-input balku-code-input"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="コード6文字"
                maxLength={6}
                aria-label="ルームコード"
              />
              <button type="button" className="balku-btn" onClick={() => joinRoom(joinCode)} disabled={busy}>
                参加
              </button>
            </div>
          </section>
          <section className="balku-panel">
            <h2>公開ルーム</h2>
            {publicRooms.length === 0 ? (
              <p className="muted">いま入れる公開ルームはありません。</p>
            ) : (
              <div className="balku-public-list">
                {publicRooms.map((room) => (
                  <div key={room.code} className="balku-public-row">
                    <span className="balku-public-code">{room.code}</span>
                    <span className="muted">
                      {room.playerCount} / {room.maxPlayers} 人
                    </span>
                    <button type="button" className="balku-btn" onClick={() => joinRoom(room.code)} disabled={busy || room.playerCount >= room.maxPlayers}>
                      参加
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        </div>
      </>
    );
  }

  if (!view || !state || !me) {
    return (
      <>
        {header}
        <p className="muted">ルーム {session.code} に接続中…</p>
        <button type="button" className="balku-btn balku-btn-ghost" onClick={() => saveSession(null)}>
          接続をやめる
        </button>
      </>
    );
  }

  const st = state;
  const isHost = view.player.isHost;

  // --- ルーム内チャット（右下固定。ロビー/対戦/終了の全画面で共通） ---
  const renderChat = () => (
    <div className="balku-chat">
      {chatOpen ? (
        <div className="balku-chat-panel" role="dialog" aria-label="ルームチャット">
          <div className="balku-chat-head">
            <span className="balku-plate">ルームチャット</span>
            <button type="button" className="balku-chat-close" onClick={() => setChatOpen(false)} aria-label="チャットを閉じる">
              ×
            </button>
          </div>
          <div className="balku-chat-list" ref={chatListRef}>
            {chatMessages.length === 0 ? (
              <p className="balku-chat-empty">まだメッセージはありません。</p>
            ) : (
              chatMessages.map((m) => (
                <div key={m.id} className={`balku-chat-msg${m.playerId === mySeat ? " balku-chat-mine" : ""}`}>
                  <span className="balku-chat-meta">
                    {m.name}
                    <span className="balku-chat-time">
                      {new Date(m.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </span>
                  <span className="balku-chat-text">{m.text}</span>
                </div>
              ))
            )}
          </div>
          <form
            className="balku-chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
          >
            <input
              className="balku-chat-input"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="メッセージ（200文字まで）"
              aria-label="チャットメッセージ"
            />
            <button type="submit" className="balku-btn balku-btn-primary balku-chat-send" disabled={chatSending || chatText.trim().length === 0}>
              送信
            </button>
          </form>
        </div>
      ) : (
        <button type="button" className="balku-chat-fab" onClick={() => setChatOpen(true)}>
          チャット
          {chatUnread > 0 && <span className="balku-chat-badge">{chatUnread}</span>}
        </button>
      )}
    </div>
  );

  // --- 待機画面 ---
  if (view.status === "lobby") {
    return (
      <>
        {header}
        <div className="balku-table">
        <section className="balku-panel">
          <h2>待機中</h2>
          <div className="balku-room-code-row">
            <span className="balku-room-code">{session.code}</span>
            <button type="button" className="balku-btn" onClick={copyCode}>
              {copied ? "コピーしました" : "コードをコピー"}
            </button>
          </div>
          <p className="muted">このコードを共有すると、他のプレイヤーが参加できます。</p>
          <div className="balku-player-list">
            {st.players.map((p) => {
              const isCpuSeat = view.cpuSeats.includes(p.seat);
              return (
                <div key={p.seat} className="balku-player-row">
                  <span>
                    {p.name}
                    {p.seat === mySeat ? "（あなた）" : ""}
                    {p.seat === 0 ? "（ホスト）" : ""}
                    {isCpuSeat && <span className="balku-badge balku-badge-cpu">CPU</span>}
                  </span>
                  {isHost && isCpuSeat && (
                    <button type="button" className="balku-btn balku-btn-ghost balku-cpu-remove" onClick={() => doCpu("remove", p.seat)} disabled={busy}>
                      外す
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="muted">
            {st.players.length} / {view.maxPlayers} 人
          </p>
          <div className="balku-actions">
            {isHost ? (
              <button type="button" className="balku-btn balku-btn-primary" onClick={() => doHostAction("start")} disabled={busy || st.players.length < 2}>
                対戦を開始
              </button>
            ) : (
              <p className="muted">ホストの開始を待っています…</p>
            )}
            {isHost && st.players.length < view.maxPlayers && (
              <button type="button" className="balku-btn" onClick={() => doCpu("add")} disabled={busy}>
                CPUを追加
              </button>
            )}
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出
            </button>
          </div>
          {isHost && st.players.length < 2 && <p className="muted">あと1席で開始できます。参加者を待つか、CPUを追加してください。</p>}
        </section>
        </div>
        {renderChat()}
      </>
    );
  }

  // --- 終了画面 ---
  if (view.status === "finished") {
    const winnerNames = st.finalScores.filter((s) => st.winnerSeats.includes(s.seat)).map((s) => s.name);
    return (
      <>
        {header}
        {banner && (
          <div className={`balku-banner balku-banner-${banner.tone}`} role="status" aria-live="polite">
            <strong>{banner.title}</strong>
            <span>{st.logs[0]?.id === banner.logId ? st.logs[0].text : ""}</span>
          </div>
        )}
        <div className="balku-table">
        <section className="balku-panel balku-panel-results">
          {st.winnerSeats.includes(mySeat) && (
            <div className="balku-confetti" aria-hidden="true">
              {Array.from({ length: 18 }, (_, i) => (
                <span
                  key={i}
                  style={{
                    left: `${(i * 53) % 96 + 2}%`,
                    animationDelay: `${(i % 6) * 0.14}s`,
                    background: ["#f5c518", "#39bfe8", "#57c785", "#fdf6dd"][i % 4],
                  }}
                />
              ))}
            </div>
          )}
          <h2>最終精算</h2>
          <p className="balku-winner">
            {st.winnerSeats.length > 1 ? `共同勝利: ${winnerNames.join(" / ")}` : `勝者: ${winnerNames[0] ?? "—"}`}
          </p>
          <table className="balku-results">
            <thead>
              <tr>
                <th>順位</th>
                <th>会社</th>
                <th>提出点</th>
                <th>ボーナス</th>
                <th>合計</th>
              </tr>
            </thead>
            <tbody>
              {st.finalScores.map((score, index) => (
                <tr
                  key={score.seat}
                  className={`balku-result-row${st.winnerSeats.includes(score.seat) ? " balku-result-win" : ""}`}
                  style={{ animationDelay: `${index * 0.35}s` }}
                >
                  <td>{index + 1}</td>
                  <td>
                    {score.name}
                    {score.seat === mySeat ? "（あなた）" : ""}
                  </td>
                  <td>
                    <CountUp value={score.submittedPoints} delayMs={index * 350} />
                  </td>
                  <td>
                    <CountUp value={score.bonusPoints} delayMs={index * 350} />
                  </td>
                  <td>
                    <strong>
                      <CountUp value={score.points} delayMs={index * 350} /> PT
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="balku-actions">
            {isHost && (
              <button type="button" className="balku-btn balku-btn-primary" onClick={() => doHostAction("restart")} disabled={busy}>
                再戦を準備
              </button>
            )}
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出
            </button>
          </div>
          {!isHost && <p className="muted">再戦の準備はホストが行います。</p>}
        </section>
        </div>
        {renderChat()}
      </>
    );
  }

  // --- 対戦画面 ---
  const activePlayer = st.players.find((p) => p.seat === st.activeSeat);
  const myTurn = st.activeSeat === mySeat && !me.eliminated;
  const turnSec = st.turnDeadlineAt ? Math.max(0, Math.ceil((st.turnDeadlineAt - now) / 1000)) : null;
  const auctionSec = st.auction ? Math.max(0, Math.ceil((st.auction.deadlineAt - now) / 1000)) : null;
  const deckPct = st.deckInitialCount > 0 ? Math.max(0, Math.min(100, Math.round((st.deckCount / st.deckInitialCount) * 100))) : 0;
  const myBreakdown = scoreBreakdown(me);
  const myCharges = me.forceBulkCharges.filter((c) => !c.used);
  const handProjects = me.hand.filter((c): c is ProjectCard => c.kind === "project");
  const handMaterials = me.hand.filter((c): c is MaterialCard => c.kind === "material");
  const selectedProject = handProjects.find((c) => c.id === selectedProjectId) ?? null;
  const needsTarget = selectedProject ? TARGETED_EFFECTS.includes(selectedProject.effect.type) : false;
  const opponents = st.players.filter((p) => p.seat !== mySeat);

  const ownedCount = (kind: MaterialKind) => handMaterials.filter((c) => c.material === kind).length;
  // 添付数は所持数でクランプして扱う（同期で手札が減っても壊れない）
  const attachOf = (kind: MaterialKind) => Math.min(attachCounts[kind] ?? 0, ownedCount(kind));
  // 種類ごとの添付数 → 実カードID（手札の先頭から割り当て）
  const buildMaterialIds = (counts: Record<string, number>): string[] => {
    const ids: string[] = [];
    for (const kind of MARKET_MATERIALS) {
      const n = Math.min(counts[kind] ?? 0, ownedCount(kind));
      ids.push(...handMaterials.filter((c) => c.material === kind).slice(0, n).map((c) => c.id));
    }
    return ids;
  };
  const selectedMaterialIds = selectedProject ? buildMaterialIds(attachCounts) : [];
  const selectedMaterialCards = handMaterials.filter((c) => selectedMaterialIds.includes(c.id));
  const selectedLegal = selectedProject ? isLegalSubmission(selectedProject, selectedMaterialCards) : false;

  /** 企画を施工ゾーンにセットする（タップとドロップの共通入口）。 */
  const placeProject = (card: ProjectCard) => {
    setSelectedProjectId(card.id);
    // 正規完成に必要な数を初期値にする（足りない種類は所持ぶんまで）。
    // selectLegalMaterials が返す実カード集合と種類カウントで等価になる。
    const counts: Record<string, number> = {};
    for (const [kind, amount] of Object.entries(card.requirements)) {
      counts[kind] = Math.min(ownedCount(kind as MaterialKind), amount ?? 0);
    }
    setAttachCounts(counts);
    setTargetSeat(undefined);
  };

  const selectProject = (card: ProjectCard) => {
    if (suppressClickRef.current) return;
    playSe("select");
    if (selectedProjectId === card.id) {
      setSelectedProjectId(null);
      setAttachCounts({});
      setTargetSeat(undefined);
      return;
    }
    placeProject(card);
  };

  const submitSelected = (faceUp: boolean) => {
    if (!selectedProject) return;
    if (!myTurn || busy) {
      playSe("error");
      return;
    }
    if (needsTarget && targetSeat === undefined) {
      playSe("error");
      return;
    }
    // FLIP: 手札の企画カードの位置から施工ゾーンへカードを飛ばす
    try {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const src = document.querySelector(`[data-hand-project="${selectedProject.id}"]`)?.getBoundingClientRect();
      const dst = buildZoneRef.current?.getBoundingClientRect();
      if (src && dst && !reduced) {
        setFly({
          name: selectedProject.name,
          x: src.left,
          y: src.top,
          w: src.width,
          h: src.height,
          dx: dst.left + dst.width / 2 - (src.left + src.width / 2),
          dy: dst.top + 56 - (src.top + src.height / 2),
          go: false,
        });
        requestAnimationFrame(() => requestAnimationFrame(() => setFly((f) => (f ? { ...f, go: true } : f))));
        setTimeout(() => setFly(null), 300);
      }
    } catch {
      // FLIP は装飾なので失敗しても提出は続ける
    }
    void doMove({
      type: "submit",
      projectId: selectedProject.id,
      materialIds: selectedMaterialIds,
      faceUp,
      ...(needsTarget && targetSeat !== undefined ? { targetSeat } : {}),
    });
    setSelectedProjectId(null);
    setAttachCounts({});
    setTargetSeat(undefined);
  };

  /* --- ジェスチャの解決 ---
     対戦中のアクションは全てここを通る。ドロップ先は
     施工（build）/ 売却（sell）/ 自分の領域（hand）/ 提出パッド
     （submit-open・submit-down）/ オークション（auction）/ 席（pass）。
     強制BALKU の対象束だけは要素そのものを当たり判定にする。 */
  const zoneEls = (): [DropZoneId, HTMLElement | null][] => [
    ["submit-open", openPadRef.current],
    ["submit-down", downPadRef.current],
    ["sell", sellZoneRef.current],
    ["auction", auctionRef.current],
    ["build", buildZoneRef.current],
    ["pass", seatsRef.current],
    ["hand", handZoneRef.current],
  ];

  const zoneAt = (x: number, y: number, payload?: DragPayload): DropZoneId | null => {
    if (payload?.source === "force-charge") {
      const hit = document.elementFromPoint(x, y)?.closest?.("[data-bulk-target]");
      if (hit) return "hand"; // 対象束の特定は endDrag 側の属性で確定させる
    }
    for (const [id, el] of zoneEls()) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  };

  /** フリック解決: ゾーンに届いていなくても、ゾーン方向への速いスワイプは到達と同等にする。 */
  const flickZone = (track: { payload: DragPayload; startX: number; startY: number }, vx: number, vy: number): DropZoneId | null => {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.5) return null;
    const relevant: Partial<Record<DragPayload["source"], DropZoneId[]>> = {
      "hand-project": ["build", "sell"],
      "hand-material": ["build", "sell"],
      "attached-material": ["hand"],
      bundle: ["submit-open", "submit-down"],
      "opponent-bundle": ["hand"],
      "bid-coin": ["auction"],
      "market-material": ["hand"],
      "turn-token": ["pass"],
    };
    const wanted = relevant[track.payload.source] ?? [];
    let best: { zone: DropZoneId; dot: number } | null = null;
    for (const [id, el] of zoneEls()) {
      if (!el || !wanted.includes(id)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 - track.startX;
      const cy = r.top + r.height / 2 - track.startY;
      const dist = Math.hypot(cx, cy);
      if (dist < 24 || dist > 900) continue;
      const dot = (vx * cx + vy * cy) / (speed * dist);
      if (dot > 0.62 && (!best || dot > best.dot)) best = { zone: id, dot };
    }
    return best?.zone ?? null;
  };

  const resolveDrop = (payload: DragPayload, zone: DropZoneId | null, forceTarget?: { seat: number; submissionId: string }) => {
    if (!zone) return;
    if (payload.source === "force-charge") {
      if (forceTarget) {
        void doMove({ type: "forceBulk", chargeId: payload.chargeId, targetSeat: forceTarget.seat, submissionId: forceTarget.submissionId });
      } else {
        playSe("error");
      }
      return;
    }
    if (zone === "build") {
      if (payload.source === "hand-project") {
        playSe("play");
        placeProject(payload.card);
      } else if (payload.source === "hand-material") {
        if (selectedProject && payload.kind in selectedProject.requirements) {
          playSe("play");
          setAttachCounts((prev) => ({ ...prev, [payload.kind]: Math.min(ownedCount(payload.kind), attachOf(payload.kind) + 1) }));
        } else {
          playSe("error");
        }
      } else if (payload.source === "attached-material") {
        playSe("error");
      }
      return;
    }
    if (zone === "sell") {
      if (payload.source === "hand-project") {
        void doMove({ type: "sellCards", cardIds: [payload.card.id] });
      } else if (payload.source === "hand-material") {
        const first = handMaterials.find((c) => c.material === payload.kind);
        if (first) void doMove({ type: "sellCards", cardIds: [first.id] });
      }
      return;
    }
    if (zone === "hand") {
      if (payload.source === "attached-material") {
        playSe("draw");
        setAttachCounts((prev) => ({ ...prev, [payload.kind]: Math.max(0, attachOf(payload.kind) - 1) }));
      } else if (payload.source === "market-material") {
        void doMove({ type: "buyMaterial", material: payload.kind });
      } else if (payload.source === "opponent-bundle") {
        void doMove({ type: "bulkCall", targetSeat: payload.ownerSeat, submissionId: payload.submissionId });
      }
      return;
    }
    if (zone === "submit-open" || zone === "submit-down") {
      if (payload.source === "bundle") submitSelected(zone === "submit-open");
      return;
    }
    if (zone === "auction") {
      if (payload.source === "bid-coin" && st.auction) {
        void doMove({ type: "bid", amount: st.auction.highestBid + payload.plus });
      }
      return;
    }
    if (zone === "pass") {
      if (payload.source === "turn-token") void doMove({ type: "endTurn" });
      return;
    }
  };

  /* ドラッグの可否はオブジェクトごとに決める（手番制約のない入札・BALKU と、
     手番中だけの提出・購入などを分ける）。触れない時は呼び出し側で
     balku-inert を付けて沈ませる。 */
  const beginDrag = (payload: DragPayload, label: string, canDrag: boolean) => (e: React.PointerEvent) => {
    if (!canDrag || busy) return;
    if (e.button !== undefined && e.button > 0) return;
    // 入れ子のドラッグ（束の中の添付素材など）は内側を優先する
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const fan = el.closest?.(".balku-fan") as HTMLElement | null;
    dragTrackRef.current = {
      payload,
      label,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      mode: "undecided",
      samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }],
      fanEl: payload.source === "hand-project" || payload.source === "hand-material" ? fan : null,
      fanStartScroll: fan ? fan.scrollLeft : 0,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // キャプチャできなくても move/up は要素上で追える
    }
  };
  const moveDrag = (e: React.PointerEvent) => {
    const track = dragTrackRef.current;
    if (!track) return;
    track.samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (track.samples.length > 24) track.samples.shift();
    const dx = e.clientX - track.startX;
    const dy = e.clientY - track.startY;
    if (!track.active) {
      if (Math.hypot(dx, dy) < 7) return;
      track.active = true;
      playSe("draw");
      // 手札ファンの上の横スワイプは「ファンを流す」専用に振り分ける
      if (track.fanEl && Math.abs(dx) > Math.abs(dy) * 1.3) track.mode = "fan";
      else track.mode = "drag";
    }
    if (track.mode === "fan" && track.fanEl) {
      track.fanEl.scrollLeft = track.fanStartScroll - dx;
      return;
    }
    track.lastX = e.clientX;
    track.lastY = e.clientY;
    setDrag({ payload: track.payload, x: e.clientX, y: e.clientY, label: track.label });
    setDropHot(zoneAt(e.clientX, e.clientY, track.payload));
  };
  const endDrag = (e: React.PointerEvent) => {
    const track = dragTrackRef.current;
    dragTrackRef.current = null;
    if (!track || !track.active) return;
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 60);
    setDropHot(null);
    if (track.mode === "fan") {
      setDrag(null);
      return;
    }
    // 速度（直近サンプルから px/ms）
    const nowT = performance.now();
    const past = [...track.samples].reverse().find((s) => nowT - s.t >= 70) ?? track.samples[0];
    const dt = Math.max(1, nowT - (past?.t ?? nowT));
    const vx = (e.clientX - (past?.x ?? e.clientX)) / dt;
    const vy = (e.clientY - (past?.y ?? e.clientY)) / dt;
    // 強制BALKU は離した地点の束そのものが対象
    let forceTarget: { seat: number; submissionId: string } | undefined;
    if (track.payload.source === "force-charge") {
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-bulk-target]");
      const raw = hit?.getAttribute("data-bulk-target");
      if (raw) {
        const [seatRaw, submissionId] = raw.split(":");
        forceTarget = { seat: Number(seatRaw), submissionId };
      }
    }
    let zone = zoneAt(e.clientX, e.clientY, track.payload);
    if (track.payload.source === "force-charge") zone = forceTarget ? "hand" : null;
    // 相手の束を自分の側へ「引いて離す」引き寄せ（閾値未満は無効＝確認を兼ねる）
    if (!zone && track.payload.source === "opponent-bundle") {
      const dy = e.clientY - track.startY;
      if (dy > 56 && vy > 0.12) zone = "hand";
    }
    if (!zone) zone = flickZone(track, vx, vy);
    if (zone) {
      setDrag(null);
      resolveDrop(track.payload, zone, forceTarget);
    } else {
      // 対象外で離したら元の位置へ戻る（スナップバック）
      playSe("error");
      setDrag({ payload: track.payload, x: track.startX, y: track.startY, label: track.label });
      setTimeout(() => setDrag(null), 200);
    }
  };
  const cancelDrag = () => {
    dragTrackRef.current = null;
    setDrag(null);
    setDropHot(null);
  };
  const dragHandlers = (payload: DragPayload, label: string, canDrag: boolean) => ({
    onPointerDown: beginDrag(payload, label, canDrag),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: cancelDrag,
  });

  /** 提出束に添付された素材を、小さな素材カード（伏せなら裏面）の重なりで見せる。 */
  const renderBundleMats = (sub: SnapshotSubmission, visible: boolean) => {
    if (sub.materialCount === 0) return null;
    if (!visible) {
      const shown = Math.min(sub.materialCount, 6);
      return (
        <div className="balku-bundle-mats" aria-label={`添付素材 ${sub.materialCount}枚（裏向き）`}>
          {Array.from({ length: shown }, (_, i) => (
            <CardBack key={i} mini />
          ))}
          {sub.materialCount > shown && <span className="muted">+{sub.materialCount - shown}</span>}
        </div>
      );
    }
    const shownMats = sub.materials.slice(0, 8);
    return (
      <div className="balku-bundle-mats" aria-label={`添付素材 ${sub.materialCount}枚`}>
        {shownMats.map((m) => (
          <MatFace key={m.id} kind={m.material} premium={m.rarity === "premium"} mini />
        ))}
        {sub.materialCount > shownMats.length && <span className="muted">+{sub.materialCount - shownMats.length}</span>}
      </div>
    );
  };

  const renderBundle = (owner: SnapshotPlayer, sub: SnapshotSubmission) => {
    const isMine = owner.seat === mySeat;
    const keyBase = `${owner.seat}:${sub.id}`;
    // 相手の束は「自分の側へ引く」ジェスチャそのものが BALKU コール。
    // 強制BALKU の権利オブジェクトのドロップ先にもなる。
    const canBulk = !isMine && !me.eliminated && !owner.eliminated && st.phase === "active";
    const bundleDrag = canBulk
      ? dragHandlers({ source: "opponent-bundle", ownerSeat: owner.seat, submissionId: sub.id }, isMine ? "" : sub.faceUp ? sub.project.name : "伏せ企画", true)
      : undefined;
    const bundleCls = `${flashKeys[keyBase] ? " balku-bundle-flash" : ""}${flipKeys[keyBase] ? " balku-bundle-flip" : ""}${canBulk ? " balku-draggable balku-bundle-pullable" : ""}`;
    // 支援技術向け: 束自体を focusable にし、Enter/Space を引き寄せ（BALKU）と等価にする
    const bundleKeys = canBulk
      ? {
          tabIndex: 0,
          role: "button" as const,
          "aria-label": `${owner.name}の提出をBALKUする`,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void doMove({ type: "bulkCall", targetSeat: owner.seat, submissionId: sub.id });
            }
          },
        }
      : {};
    if (!sub.faceUp) {
      return (
        <div
          key={sub.id}
          data-bulk-target={canBulk ? keyBase : undefined}
          className={`balku-bundle balku-bundle-down${bundleCls}`}
          {...bundleDrag}
          {...bundleKeys}
        >
          <div className="balku-bundle-main">
            <span className="balku-bundle-name">{isMine ? sub.project.name : "伏せ企画"}</span>
            <span className="balku-badge balku-badge-hazard">伏せ</span>
            <span className="muted">素材 {sub.materialCount}枚</span>
            {isMine && <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>}
          </div>
          {isMine && <ProjectArt name={sub.project.name} effectType={sub.project.effect.type} />}
          {renderBundleMats(sub, isMine)}
          {canBulk && <span className="balku-bundle-pullhint" aria-hidden="true">▽ 引くとBALKU</span>}
        </div>
      );
    }
    return (
      <div
        key={sub.id}
        data-bulk-target={canBulk ? keyBase : undefined}
        className={`balku-bundle${bundleCls}`}
        {...bundleDrag}
        {...bundleKeys}
      >
        {sub.legal ? (
          <span className="balku-stamp" aria-hidden="true">承認</span>
        ) : (
          <span className="balku-stamp balku-stamp-bad" aria-hidden="true">違法</span>
        )}
        <div className="balku-bundle-main">
          <span className="balku-bundle-name">{sub.project.name}</span>
          <span>{sub.project.points} PT</span>
          <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>
          <span className="muted">素材 {sub.materialCount}枚</span>
        </div>
        <ProjectArt name={sub.project.name} effectType={sub.project.effect.type} />
        <p className="balku-bundle-effect">{sub.project.effect.label}</p>
        {renderBundleMats(sub, true)}
        {canBulk && <span className="balku-bundle-pullhint" aria-hidden="true">▽ 引くとBALKU</span>}
      </div>
    );
  };

  /* --- 席の要約スタック（同時表示の圧縮） ---
     席ごとに「最新の束の顔」だけをステージ上に置き、残りは件数で示す。
     顔は「絵の帯＋名前＋点数」だけの情報ダイエット済み表示で、効果文や
     必要素材は出さない（詳細シート/施工シート/プレビューでのみ出す）。
     相手の最新束の顔は、従来どおり引きドラッグで BALKU できる。 */
  const renderStackFace = (owner: SnapshotPlayer, sub: SnapshotSubmission) => {
    const isMine = owner.seat === mySeat;
    const keyBase = `${owner.seat}:${sub.id}`;
    const canBulk = !isMine && !me.eliminated && !owner.eliminated && st.phase === "active";
    const faceCls = `${flashKeys[keyBase] ? " balku-bundle-flash" : ""}${flipKeys[keyBase] ? " balku-bundle-flip" : ""}${canBulk ? " balku-draggable balku-bundle-pullable" : ""}`;
    const faceDrag = canBulk
      ? dragHandlers({ source: "opponent-bundle", ownerSeat: owner.seat, submissionId: sub.id }, sub.faceUp ? sub.project.name : "伏せ企画", true)
      : undefined;
    const faceKeys = canBulk
      ? {
          tabIndex: 0,
          role: "button" as const,
          "aria-label": `${owner.name}の提出をBALKUする（タップで詳細）`,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void doMove({ type: "bulkCall", targetSeat: owner.seat, submissionId: sub.id });
            }
          },
        }
      : {};
    if (!sub.faceUp) {
      return (
        <div data-bulk-target={canBulk ? keyBase : undefined} className={`balku-stackface balku-stackface-down${faceCls}`} {...faceDrag} {...faceKeys}>
          {isMine && <ProjectArt name={sub.project.name} effectType={sub.project.effect.type} mini />}
          <div className="balku-stackface-main">
            <span className="balku-stackface-name">{isMine ? sub.project.name : "伏せ企画"}</span>
            {isMine && <span className="balku-stackface-pts">{sub.project.points} PT</span>}
            <span className="balku-badge balku-badge-hazard">伏せ</span>
            {isMine && <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>}
          </div>
        </div>
      );
    }
    return (
      <div data-bulk-target={canBulk ? keyBase : undefined} className={`balku-stackface${faceCls}`} {...faceDrag} {...faceKeys}>
        <ProjectArt name={sub.project.name} effectType={sub.project.effect.type} mini />
        <div className="balku-stackface-main">
          <span className="balku-stackface-name">{sub.project.name}</span>
          <span className="balku-stackface-pts">{sub.project.points} PT</span>
          <span className={sub.legal ? "balku-badge balku-badge-ok" : "balku-badge balku-badge-bad"}>{sub.legal ? "正規" : "違法"}</span>
        </div>
      </div>
    );
  };

  /** シート上端のハンドル：タップ、または閉方向へ引くと閉じる。 */
  const sheetHandle = (close: () => void, dir: 1 | -1, label: string) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onClick: () => {
      if (suppressClickRef.current) return;
      close();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        close();
      }
    },
    onPointerDown: (e: React.PointerEvent) => {
      sheetPullRef.current = e.clientY;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const start = sheetPullRef.current;
      sheetPullRef.current = null;
      if (start !== null && (e.clientY - start) * dir > 40) close();
    },
  });

  /* --- 席の詳細シート（拡大表示） ---
     その席の提出束をすべて全サイズ（renderBundle）で見せる。ステージ上に
     重なるシートなので、ステージの行は一切増えない。相手の束はこの中でも
     引きドラッグで BALKU できる。 */
  const detailPlayer = detailSeat !== null ? st.players.find((p) => p.seat === detailSeat) ?? null : null;
  const renderDetailSheet = () => {
    if (!detailPlayer) return null;
    const p = detailPlayer;
    return (
      <div className="balku-sheet-wrap">
        <div className="balku-sheet-backdrop" onClick={() => setDetailSeat(null)} />
        <section className="balku-sheet" aria-label={`${p.name}の提出詳細`}>
          <div className="balku-sheet-handle" {...sheetHandle(() => setDetailSeat(null), 1, "詳細を閉じる")}>
            <span className="balku-sheet-grip" />
          </div>
          <div className="balku-sheet-head">
            <span className="balku-nameplate">{p.name}</span>
            {view.cpuSeats.includes(p.seat) && <span className="balku-badge balku-badge-cpu">CPU</span>}
            {p.eliminated ? (
              <span className="balku-badge balku-badge-bad">脱落</span>
            ) : (
              <span className="balku-seat-stats">
                <BackStack count={p.handCount} />
                <span>
                  {p.coins}コイン / {getTotalPoints(p)} PT / 提出 {p.submitted.length}件
                </span>
              </span>
            )}
          </div>
          <div className="balku-sheet-bundles">
            {p.submitted.length === 0 ? <p className="balku-table-note">提出なし</p> : p.submitted.map((sub) => renderBundle(p, sub))}
          </div>
          {p.seat !== mySeat && !me.eliminated && <p className="balku-sheet-note">相手の束は、自分の側へ引くと BALKU できます。</p>}
        </section>
      </div>
    );
  };

  /* --- 単体カードの拡大プレビュー ---
     小カードで省略した情報（効果文・必要素材）は、ここで必ず読める。 */
  const renderPreviewOverlay = () => {
    if (!preview) return null;
    return (
      <div className="balku-sheet-wrap">
        <div className="balku-sheet-backdrop" onClick={() => setPreview(null)} />
        <section className="balku-sheet balku-preview-sheet" aria-label="カードの拡大表示">
          <div className="balku-sheet-handle" {...sheetHandle(() => setPreview(null), 1, "拡大表示を閉じる")}>
            <span className="balku-sheet-grip" />
          </div>
          {preview.type === "project" ? (
            <div className="balku-preview-card">
              <ProjectArt name={preview.card.name} effectType={preview.card.effect.type} />
              <div className="balku-preview-main">
                <strong>{preview.card.name}</strong>
                <span>{preview.card.points} PT</span>
              </div>
              <p className="balku-card-effect">
                {preview.card.immediate ? "即時 / " : ""}
                {preview.card.effect.label}
              </p>
              <span className="balku-req-chips">
                {Object.entries(preview.card.requirements).length === 0 ? (
                  <span className="balku-req-chip balku-req-chip-ok">素材不要</span>
                ) : (
                  Object.entries(preview.card.requirements).map(([kind, need]) => {
                    const owned = ownedCount(kind as MaterialKind);
                    const ok = owned >= (need ?? 0);
                    return (
                      <span key={kind} className={`balku-req-chip${ok ? " balku-req-chip-ok" : " balku-req-chip-ng"}`}>
                        {kind} {owned}/{need}
                      </span>
                    );
                  })
                )}
              </span>
            </div>
          ) : (
            <div className="balku-preview-card balku-preview-material">
              <MatFace kind={preview.kind} premium={preview.premium} />
              <div className="balku-preview-main">
                <strong>{preview.kind}</strong>
                <span>所持 {ownedCount(preview.kind)}枚</span>
              </div>
              <p className="balku-card-effect">調達市場では {getMarketPrice(preview.kind)}コイン / 売却は 1コイン</p>
            </div>
          )}
        </section>
      </div>
    );
  };

  /* --- 施工シート ---
     企画を選んだら施工ゾーンはステージ上部に重なるシートとして開く。
     大カード＋必要素材＋提出パッドを全サイズで出し、ステージの行は
     増やさない。閉じるのはハンドル（タップ/上へ引く）か、同じ企画の
     再タップ、または提出の成立。素材の付け外しはシート内と手札の
     ドラッグ/タップ（従来経路）のまま。 */
  const renderBuildSheet = () => {
    if (!selectedProject) return null;
    const closeBuild = () => {
      setSelectedProjectId(null);
      setAttachCounts({});
      setTargetSeat(undefined);
    };
    return (
      <section
        ref={buildZoneRef}
        data-drop="build"
        aria-label="施工ゾーン"
        className={`balku-buildsheet${drag ? " balku-drop-armed" : ""}${dropHot === "build" ? " balku-drop-hot" : ""}`}
      >
        <div className="balku-sheet-handle" {...sheetHandle(closeBuild, -1, "施工ゾーンを閉じる")}>
          <span className="balku-sheet-grip" />
        </div>
        <div className="balku-buildsheet-body">
          <div
            className={`balku-build-card balku-draggable${myTurn ? "" : " balku-inert"}`}
            data-build-bundle={selectedProject.id}
            {...dragHandlers({ source: "bundle" }, selectedProject.name, myTurn)}
            tabIndex={0}
            role="button"
            aria-label={`${selectedProject.name}の束（Enterで公開提出）`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSelected(true);
              }
            }}
          >
            <ProjectArt name={selectedProject.name} effectType={selectedProject.effect.type} />
            <div className="balku-build-card-main">
              <strong>{selectedProject.name}</strong>
              <span>{selectedProject.points} PT</span>
              {myTurn && turnSec !== null && (
                <span className="balku-build-timer">
                  あと{turnSec}秒
                  <TimerBar sec={turnSec} total={60} />
                </span>
              )}
            </div>
            <p className="balku-build-effect">
              {selectedProject.immediate ? "即時 / " : ""}
              {selectedProject.effect.label}
            </p>
          </div>
          <div className="balku-build-info">
            {selectedMaterialCards.length > 0 && (
              <div className="balku-attached" aria-label="添付中の素材">
                {MARKET_MATERIALS.map((kind) => {
                  const n = attachOf(kind);
                  if (n === 0) return null;
                  return (
                    <span
                      key={kind}
                      className="balku-attached-item balku-draggable"
                      title="手札へドラッグで戻す"
                      {...dragHandlers({ source: "attached-material", kind }, kind, myTurn)}
                    >
                      <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                      <span className="balku-attached-count">×{n}</span>
                    </span>
                  );
                })}
              </div>
            )}
            {Object.entries(selectedProject.requirements).length === 0 ? (
              <p className="balku-table-note">素材不要</p>
            ) : (
              <div className="balku-reqrows">
                {Object.entries(selectedProject.requirements).map(([kindRaw, needRaw]) => {
                  const kind = kindRaw as MaterialKind;
                  const need = needRaw ?? 0;
                  const owned = ownedCount(kind);
                  const attached = attachOf(kind);
                  return (
                    <div key={kind} className="balku-reqrow">
                      <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                      <span className="balku-reqrow-kind">{kind}</span>
                      <span className="balku-reqrow-meta">
                        必要 {need} / 所持 {owned} / 添付 {attached}
                      </span>
                      {attached >= need ? <span className="balku-badge balku-badge-ok">充足</span> : <span className="balku-badge balku-badge-bad">あと{need - attached}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            <p className={selectedLegal ? "balku-legal-ok" : "balku-legal-ng"}>
              {selectedLegal
                ? "素材条件を満たしています（正規完成）。"
                : `素材が不足しています（不足: ${Object.entries(selectedProject.requirements)
                    .map(([kind, need]) => {
                      const have = attachOf(kind as MaterialKind);
                      return have < (need ?? 0) ? `${kind} あと${(need ?? 0) - have}枚` : "";
                    })
                    .filter(Boolean)
                    .join(" / ")}）。公開すると違法建築になります。`}
            </p>
            {needsTarget && (
              <div className="balku-targetrow" aria-label="効果の対象">
                <span className="balku-target-hint">効果の対象:</span>
                {opponents
                  .filter((p) => !p.eliminated)
                  .map((p) => (
                    <span
                      key={p.seat}
                      role="button"
                      tabIndex={0}
                      className={`balku-targetchip${targetSeat === p.seat ? " balku-targetchip-on" : ""}`}
                      aria-pressed={targetSeat === p.seat}
                      onClick={() => {
                        if (suppressClickRef.current) return;
                        playSe("select");
                        setTargetSeat(p.seat);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setTargetSeat(p.seat);
                        }
                      }}
                    >
                      {p.name}
                    </span>
                  ))}
                {targetSeat === undefined && <strong className="balku-target-hint">相手を選んでください</strong>}
              </div>
            )}
          </div>
        </div>
        <div className="balku-submitpads" aria-label="提出先">
          <div
            ref={openPadRef}
            data-drop="submit-open"
            className={`balku-submitpad balku-submitpad-open${dropHot === "submit-open" ? " balku-drop-hot" : ""}${needsTarget && targetSeat === undefined ? " balku-submitpad-locked" : ""}`}
            tabIndex={0}
            role="button"
            aria-label="公開で提出"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                submitSelected(true);
              }
            }}
          >
            公開エリア
            <span>束を放つと表向きで提出</span>
          </div>
          <div
            ref={downPadRef}
            data-drop="submit-down"
            className={`balku-submitpad balku-submitpad-down${dropHot === "submit-down" ? " balku-drop-hot" : ""}${needsTarget && targetSeat === undefined ? " balku-submitpad-locked" : ""}`}
            tabIndex={0}
            role="button"
            aria-label="伏せて提出"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                submitSelected(false);
              }
            }}
          >
            伏せエリア
            <span>束を放つと裏向きで提出</span>
          </div>
        </div>
      </section>
    );
  };

  const latestLogEntry = st.logs[0];
  // 手札ファンの重なりは CSS 側（ステージ相対の負マージン）で固定する。
  // カード幅の下限を守ったまま、重なり率だけを深くして横幅に収める。
  const matKindsInHand = MARKET_MATERIALS.filter((kind) => ownedCount(kind) > 0);
  const dragProjectId = drag?.payload.source === "hand-project" ? drag.payload.card.id : null;
  const dragMatKind = drag?.payload.source === "hand-material" || drag?.payload.source === "attached-material" ? drag.payload.kind : null;

  // 対象指定効果の宛先は「相手の席そのもの」をタップして決める
  const targetPicking = Boolean(selectedProject && needsTarget && myTurn);
  const renderSeat = (p: SnapshotPlayer) => (
    <div
      key={p.seat}
      className={`balku-seat${p.eliminated ? " balku-seat-out" : ""}${st.activeSeat === p.seat ? " balku-seat-active" : ""}${targetPicking && !p.eliminated ? " balku-seat-targetable" : ""}${targetPicking && targetSeat === p.seat ? " balku-seat-targeted" : ""}`}
      tabIndex={0}
      aria-label={`${p.name}の席（タップで提出の詳細）`}
      onClick={() => {
        if (suppressClickRef.current) return;
        playSe("select");
        // 対象指定中は席タップ＝対象選択、それ以外は席タップ＝詳細シート
        if (targetPicking && !p.eliminated) {
          setTargetSeat(p.seat);
          return;
        }
        setDetailSeat(p.seat);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // 束の顔にフォーカスがある場合はそちらの BALKU キー操作を優先する
        if ((e.target as HTMLElement).dataset?.bulkTarget) return;
        e.preventDefault();
        if (targetPicking && !p.eliminated) setTargetSeat(p.seat);
        else setDetailSeat(p.seat);
      }}
    >
      <div className="balku-seat-head">
        <span className="balku-nameplate">{p.name}</span>
        {view.cpuSeats.includes(p.seat) && <span className="balku-badge balku-badge-cpu">CPU</span>}
        {p.eliminated ? (
          <span className="balku-badge balku-badge-bad">脱落</span>
        ) : (
          <span className="balku-seat-stats">
            <BackStack count={p.handCount} />
            <span>
              {p.coins}コイン / {getTotalPoints(p)} PT
              {st.activeSeat === p.seat && turnSec !== null ? ` / あと${turnSec}秒` : ""}
            </span>
          </span>
        )}
      </div>
      {st.activeSeat === p.seat && turnSec !== null && <TimerBar sec={turnSec} total={60} />}
      {/* 同時表示は最新の束だけ（要約スタック）。残りは件数で示し、
          全束はタップで開く詳細シートで全サイズ表示する。 */}
      {p.submitted.length === 0 ? (
        <p className="balku-table-note">提出なし</p>
      ) : (
        <div className="balku-seatstack">
          {renderStackFace(p, p.submitted[p.submitted.length - 1])}
          {p.submitted.length > 1 && (
            <span className="balku-stack-count" aria-label={`提出 ${p.submitted.length}件`}>
              ×{p.submitted.length}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {header}
      {banner && (
        <div className={`balku-banner balku-banner-${banner.tone}`} role="status" aria-live="polite">
          <strong>{banner.title}</strong>
          <span>{latestLogEntry?.id === banner.logId ? latestLogEntry.text : ""}</span>
        </div>
      )}
      <div className="balku-table balku-table-game">
        {/* BALKU-MENU-START：対戦外 chrome の退避先（ハンバーガー） */}
        <button
          type="button"
          className="balku-menu-btn"
          aria-expanded={menuOpen}
          aria-label="メニューを開く"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        {menuOpen && (
          <div className="balku-menu-drawer">
            <div className="balku-menu-sec">
              <h3>ルーム</h3>
              <div className="balku-menu-row">
                <code className="balku-code">{session.code}</code>
                <button type="button" className="balku-btn balku-btn-ghost" onClick={copyCode}>
                  {copied ? "コピーしました" : "コードをコピー"}
                </button>
              </div>
            </div>
            <div className="balku-menu-sec">
              <h3>サウンド</h3>
              <div className="balku-menu-row">
                <button
                  type="button"
                  className={`balku-snd-btn${soundSettings.bgm ? " balku-snd-on" : ""}`}
                  aria-pressed={soundSettings.bgm}
                  onClick={() => toggleSound("bgm")}
                >
                  BGM {soundSettings.bgm ? "ON" : "OFF"}
                </button>
                <button
                  type="button"
                  className={`balku-snd-btn${soundSettings.se ? " balku-snd-on" : ""}`}
                  aria-pressed={soundSettings.se}
                  onClick={() => toggleSound("se")}
                >
                  SE {soundSettings.se ? "ON" : "OFF"}
                </button>
              </div>
            </div>
            <div className="balku-menu-sec">
              <h3>スコア</h3>
              <ul className="balku-menu-scores">
                {st.players.map((p) => (
                  <li key={p.seat}>
                    <span>
                      {p.name}
                      {p.seat === me.seat ? "（あなた）" : ""}
                    </span>
                    <span>
                      {p.coins}コイン / 提出 {p.submitted.length}件
                      {p.seat === me.seat && myBreakdown ? ` / 現在 ${myBreakdown.points}点` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="balku-menu-sec">
              <h3>ログ</h3>
              <div className="balku-menu-log">
                {st.logs.map((log) => (
                  <p key={log.id} className={`balku-logline balku-log-${log.tone}`}>
                    {log.text}
                  </p>
                ))}
              </div>
            </div>
            <div className="balku-menu-sec">
              <h3>進め方</h3>
              <ul className="balku-menu-rules">
                <li>企画カードをタップし、素材をドラッグして施工ゾーンで束を作る。</li>
                <li>束を公開／伏せのドロップ先へ放つと提出。</li>
                <li>相手の伏せ束は自分の側へ引くと BALKU。違法を暴けば没収、正規なら奪われる。</li>
                <li>調達市場はテーブル右端のタブから開く。</li>
                <li>手番トークンを次の席へ放つとパス。</li>
              </ul>
            </div>
            <button type="button" className="balku-btn balku-btn-ghost" onClick={leaveRoom} disabled={busy}>
              退出する
            </button>
          </div>
        )}
        {/* BALKU-MENU-END */}
        {/* 上段：他社席（手番トークンの放り先＝パス） */}
        <div className="balku-seats" ref={seatsRef} data-drop="pass">
          {opponents.map((p) => renderSeat(p))}
        </div>

        {/* 中央：場（オークション／自分の提出／施工ゾーン）＋市場の棚 */}
        <div className="balku-fieldrow">
          <div className="balku-field">
            {st.auction && (
              <div key={`${st.auction.roundOpened}:${st.auction.card.id}`} className="balku-auction" role="status" ref={auctionRef} data-drop="auction">
                <span className="balku-plate">オークション</span>
                {st.auction.card.kind === "project" ? (
                  <span
                    className="balku-card balku-card-small balku-card-static balku-auction-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`${st.auction.card.name}を拡大表示`}
                    onClick={() => {
                      if (suppressClickRef.current) return;
                      setPreview({ type: "project", card: st.auction!.card as ProjectCard });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPreview({ type: "project", card: st.auction!.card as ProjectCard });
                      }
                    }}
                  >
                    <span className="balku-card-head">
                      <strong>{st.auction.card.name}</strong>
                      <span>{(st.auction.card as ProjectCard).points} PT</span>
                    </span>
                    <ProjectArt name={st.auction.card.name} effectType={(st.auction.card as ProjectCard).effect.type} mini />
                  </span>
                ) : (
                  <span
                    className="balku-auction-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`${(st.auction.card as MaterialCard).material}を拡大表示`}
                    onClick={() => {
                      if (suppressClickRef.current) return;
                      const c = st.auction!.card as MaterialCard;
                      setPreview({ type: "material", kind: c.material, premium: c.rarity === "premium" });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const c = st.auction!.card as MaterialCard;
                        setPreview({ type: "material", kind: c.material, premium: c.rarity === "premium" });
                      }
                    }}
                  >
                    <MatFace kind={(st.auction.card as MaterialCard).material} premium={(st.auction.card as MaterialCard).rarity === "premium"} />
                  </span>
                )}
                <span className="balku-auction-info">
                  現在 {st.auction.highestBid}コイン
                  {st.auction.highestBidderSeat !== null ? `（${st.players.find((p) => p.seat === st.auction!.highestBidderSeat)?.name ?? ""}）` : "（入札なし）"}
                  <span className={auctionSec !== null && auctionSec <= 5 ? " balku-auction-danger" : ""}> ・ あと{auctionSec ?? 0}秒</span>
                  {auctionSec !== null && <TimerBar sec={auctionSec} total={15} />}
                </span>
                <span className="balku-bidcoins" aria-label="入札コイン（出品物へドラッグ）">
                  {[1, 5, 10].map((plus) => {
                    const amount = st.auction!.highestBid + plus;
                    const canBid = !busy && !me.eliminated && me.coins >= amount && st.auction!.highestBidderSeat !== mySeat;
                    return (
                      <span
                        key={plus}
                        className={`balku-coin balku-draggable${canBid ? "" : " balku-inert"}`}
                        {...dragHandlers({ source: "bid-coin", plus }, `+${plus}コイン`, canBid)}
                        tabIndex={canBid ? 0 : -1}
                        role="button"
                        aria-label={`${amount}コインで入札`}
                        onKeyDown={(e) => {
                          if (canBid && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            void doMove({ type: "bid", amount });
                          }
                        }}
                      >
                        +{plus}
                      </span>
                    );
                  })}
                </span>
              </div>
            )}

            {/* 中央帯は同時に1コンテキストだけ：オークション中は自分の
                提出ストリップを畳み、オークションが中央帯を占有する。 */}
            {!st.auction && (
              <div
                className="balku-myfield"
                role="button"
                tabIndex={0}
                aria-label="あなたの提出の詳細"
                onClick={() => {
                  if (suppressClickRef.current) return;
                  playSe("select");
                  setDetailSeat(mySeat);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailSeat(mySeat);
                  }
                }}
              >
                <span className="balku-plate">あなたの提出</span>
                {me.submitted.length === 0 ? (
                  <p className="balku-table-note">まだ提出していません。</p>
                ) : (
                  <div className="balku-seatstack">
                    {renderStackFace(me, me.submitted[me.submitted.length - 1])}
                    {me.submitted.length > 1 && (
                      <span className="balku-stack-count" aria-label={`提出 ${me.submitted.length}件`}>
                        ×{me.submitted.length}
                      </span>
                    )}
                  </div>
                )}
                <span className="balku-myfield-total">{myBreakdown.points} PT</span>
              </div>
            )}

            {burstKey && (
              <div key={burstKey} className="balku-coinburst" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} style={{ "--i": i } as React.CSSProperties} />
                ))}
              </div>
            )}

          </div>

          <div
            role="button"
            tabIndex={0}
            className="balku-shelf-tab"
            aria-expanded={marketOpen}
            onClick={() => setMarketOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setMarketOpen((v) => !v);
              }
            }}
          >
            調達市場
          </div>
          {marketOpen && (
            <aside className="balku-shelf balku-shelf-drawer">
              <span className="balku-plate">調達市場（手札へドラッグで購入）</span>
            <div className="balku-market">
              {MARKET_MATERIALS.map((kind) => {
                const canBuy = !busy && myTurn && me.coins >= getMarketPrice(kind);
                return (
                  <div
                    key={kind}
                    className={`balku-market-card balku-draggable${canBuy ? "" : " balku-inert"}`}
                    {...dragHandlers({ source: "market-material", kind }, kind, canBuy)}
                    tabIndex={canBuy ? 0 : -1}
                    role="button"
                    aria-label={`${kind}を${getMarketPrice(kind)}コインで購入（自分の領域へドラッグ）`}
                    onKeyDown={(e) => {
                      if (canBuy && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        void doMove({ type: "buyMaterial", material: kind });
                      }
                    }}
                  >
                    <MatFace kind={kind} premium={kind === "超伝導体"} mini />
                    <span className="balku-price-tag">{getMarketPrice(kind)}コイン</span>
                  </div>
                );
              })}
            </div>
            </aside>
          )}
        </div>

        {/* 下段：自分の領域（情報バー＋手札） */}
        <section ref={handZoneRef} className={`balku-self${selfHurtKey ? " balku-self-hurt" : ""}`} aria-label="あなたの領域">
          <div className="balku-infobar">
            <span className="balku-chip balku-chip-deck">
              <CardBack mini />
              <span className="balku-deckbar" aria-hidden="true">
                <span className="balku-deckbar-fill" style={{ width: `${deckPct}%` }} />
              </span>
              山札 {st.deckCount} / {st.deckInitialCount}
            </span>
            <span className="balku-chip">第{st.turn}ターン</span>
            {myTurn && !me.eliminated ? (
              <span
                key={`mine-${st.turn}`}
                className="balku-chip balku-chip-now balku-draggable balku-turntoken"
                {...dragHandlers({ source: "turn-token" }, "手番トークン", true)}
                tabIndex={0}
                role="button"
                aria-label="手番トークン（相手の席へ放つとパス）"
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void doMove({ type: "endTurn" });
                  }
                }}
              >
                あなたの手番{turnSec !== null ? ` ・ あと${turnSec}秒` : ""}
              </span>
            ) : (
              <span key="other" className="balku-chip">
                {me.eliminated ? "脱落（観戦中）" : `${activePlayer?.name ?? ""}の手番${turnSec !== null ? ` ・ あと${turnSec}秒` : ""}`}
              </span>
            )}
            {turnSec !== null && st.phase === "active" && <TimerBar sec={turnSec} total={60} />}
            <span className="balku-chip balku-chip-coins">
              {me.coins}コイン / {myBreakdown.points} PT
              {coinPop && (
                <span key={coinPop.key} className={`balku-coin-pop${coinPop.delta < 0 ? " balku-coin-pop-minus" : ""}`} aria-hidden="true">
                  {coinPop.delta > 0 ? `+${coinPop.delta}` : `${coinPop.delta}`}
                </span>
              )}
            </span>
            {syncMode === "polling" && <span className="balku-chip balku-sync-note">ポーリングで同期中</span>}
            {myCharges.map((charge) => (
              <span
                key={charge.id}
                className="balku-chip balku-chip-charge balku-draggable"
                {...dragHandlers({ source: "force-charge", chargeId: charge.id }, "強制BALKU権", !me.eliminated && st.phase === "active")}
                tabIndex={0}
                role="button"
                aria-label={`強制BALKU権（${charge.sourceProject}）：相手の束へドラッグで発動`}
                title={`強制BALKU権（${charge.sourceProject}）：相手の束へドラッグで発動`}
              >
                強制BALKU権（{charge.sourceProject}）
              </span>
            ))}

          </div>

          {!selectedProject && (
            <section
              ref={buildZoneRef}
              data-drop="build"
              aria-label="施工ゾーン"
              className={`balku-buildbar${drag ? " balku-drop-armed" : ""}${dropHot === "build" ? " balku-drop-hot" : ""}`}
            >
              <span className="balku-buildbar-label">施工ゾーン</span>
              <span className="balku-buildbar-hint">企画カードをここへドラッグ（または手札でタップ）</span>
            </section>
          )}

          <p className="balku-preview" aria-live="polite">
            {hoverCard ?? ""}
          </p>

          <div className="balku-fan balku-fan-projects" aria-label="企画カード">
            {handProjects.map((card) => {
              const ready = selectLegalMaterials(card, me.hand) !== null;
              const selected = selectedProjectId === card.id;
              return (
                <div
                  key={card.id}
                  role="button"
                  tabIndex={myTurn ? 0 : -1}
                  data-hand-project={card.id}
                  className={`balku-card balku-fan-item balku-draggable${dealIds.has(card.id) ? " balku-deal" : ""}${ready ? " balku-card-ready" : ""}${selected ? " balku-card-selected" : ""}${dragProjectId === card.id ? " balku-card-ghost" : ""}${myTurn ? "" : " balku-inert"}`}
                  {...dragHandlers({ source: "hand-project", card }, card.name, myTurn)}
                  onClick={() => {
                    // 自分の手番はタップ＝施工シート（大カード）で開く。
                    // 相手の手番は読み専用の拡大プレビューで開く（どの小カードも
                    // 必ず読める状態に到達できるための安全網）。
                    if (!myTurn) {
                      if (suppressClickRef.current) return;
                      playSe("select");
                      setPreview({ type: "project", card });
                      return;
                    }
                    selectProject(card);
                  }}
                  onMouseEnter={() => setHoverCard(`${card.name}（${card.points} PT）：${card.effect.label}`)}
                  onMouseLeave={() => setHoverCard(null)}
                  onFocus={() => setHoverCard(`${card.name}（${card.points} PT）：${card.effect.label}`)}
                  onBlur={() => setHoverCard(null)}
                  onKeyDown={(e) => {
                    if (myTurn && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      selectProject(card);
                    }
                  }}
                >
                  <span className="balku-card-head">
                    <strong>{card.name}</strong>
                    <span>{card.points} PT</span>
                  </span>
                  <ProjectArt name={card.name} effectType={card.effect.type} />
                </div>
              );
            })}
            {handProjects.length === 0 && <p className="balku-table-note">企画カードはありません。</p>}
          </div>

          <div className="balku-fan balku-fan-mats" aria-label="素材カード">
            {matKindsInHand.map((kind) => {
              const owned = ownedCount(kind);
              const premium = handMaterials.some((c) => c.material === kind && c.rarity === "premium");
              const attached = selectedProject ? attachOf(kind) : 0;
              return (
                <div
                  key={kind}
                  role="button"
                  tabIndex={myTurn ? 0 : -1}
                  className={`balku-matgroup balku-fan-item balku-draggable${handMaterials.some((c) => c.material === kind && dealIds.has(c.id)) ? " balku-deal" : ""}${attached > 0 ? " balku-matgroup-attached" : ""}${dragMatKind === kind && drag?.payload.source === "hand-material" ? " balku-card-ghost" : ""}${myTurn ? "" : " balku-inert"}`}
                  {...dragHandlers({ source: "hand-material", kind }, kind, myTurn)}
                  onClick={() => {
                    if (suppressClickRef.current) return;
                    if (selectedProject && kind in selectedProject.requirements) {
                      playSe("play");
                      setAttachCounts((prev) => ({ ...prev, [kind]: Math.min(owned, attachOf(kind) + 1) }));
                    } else if (!selectedProject) {
                      // 小カードで省略した情報は拡大プレビューで必ず読める
                      playSe("select");
                      setPreview({ type: "material", kind, premium });
                    }
                  }}
                  onMouseEnter={() => setHoverCard(`${kind} ×${owned}${selectedProject ? "（タップ/ドロップで施工ゾーンへ添付）" : ""}`)}
                  onMouseLeave={() => setHoverCard(null)}
                  aria-label={`${kind} ${owned}枚`}
                  onKeyDown={(e) => {
                    if (myTurn && (e.key === "Enter" || e.key === " ") && selectedProject && kind in selectedProject.requirements) {
                      e.preventDefault();
                      playSe("play");
                      setAttachCounts((prev) => ({ ...prev, [kind]: Math.min(owned, attachOf(kind) + 1) }));
                    }
                  }}
                >
                  <MatFace kind={kind} premium={premium} mini />
                  <span className="balku-matgroup-count">×{owned}</span>
                  {attached > 0 && <span className="balku-badge balku-badge-ok">添付 {attached}</span>}
                </div>
              );
            })}
            {handMaterials.length === 0 && <p className="balku-table-note">素材はありません。</p>}
          </div>
          <div
            ref={sellZoneRef}
            data-drop="sell"
            className={`balku-sellpocket${drag ? " balku-drop-armed" : ""}${dropHot === "sell" ? " balku-drop-hot" : ""}`}
          >
            売却ポケット
            <span>カードをここへ放つと +1コイン / 枚</span>
          </div>
        </section>
      {/* 拡大表示はすべてステージ上の重なり（行レイアウトに影響しない） */}
      {renderBuildSheet()}
      {renderDetailSheet()}
      {renderPreviewOverlay()}
      {revealCard && (
        <div key={revealCard.key} className={`balku-reveal balku-reveal-overlay${revealCard.seized ? " balku-reveal-seize" : ""}${revealCard.legal ? " balku-reveal-ok" : ""}`} role="status" aria-live="polite">
          <span className="balku-plate">開示</span>
          <span className="balku-reveal-card">
            <strong>{revealCard.name}</strong>
            {!revealCard.legal && (
              <svg className="balku-cracks" viewBox="0 0 100 60" aria-hidden="true" focusable="false">
                <path d="M8 4 L26 22 L18 34 L34 50 M26 22 L44 18 M62 2 L58 20 L74 30 L68 48 M58 20 L46 34" stroke="#2b2b26" strokeWidth="1.6" fill="none" opacity="0.65" />
              </svg>
            )}
            <span className={`balku-stamp ${revealCard.legal ? "" : "balku-stamp-bad"}`}>{revealCard.legal ? "承認" : "違法"}</span>
          </span>
        </div>
      )}

      </div>

      {drag && (
        <div
          className="balku-drag-clone"
          style={{ transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -72%) rotate(-3deg)` }}
          aria-hidden="true"
        >
          {drag.payload.source === "hand-project" ? (
            <span className="balku-card balku-card-small balku-card-static">
              <span className="balku-card-head">
                <strong>{drag.payload.card.name}</strong>
                <span>{drag.payload.card.points} PT</span>
              </span>
            </span>
          ) : drag.payload.source === "hand-material" || drag.payload.source === "attached-material" || drag.payload.source === "market-material" ? (
            <MatFace kind={drag.payload.kind} premium={drag.payload.kind === "超伝導体"} />
          ) : drag.payload.source === "bid-coin" ? (
            <span className="balku-coin">+{drag.payload.plus}</span>
          ) : drag.payload.source === "opponent-bundle" ? (
            <span className="balku-bundle balku-bundle-down balku-bundle-ghost">
              <span className="balku-bundle-name">{drag.label}</span>
            </span>
          ) : (
            <span className="balku-card balku-card-small balku-card-static">
              <span className="balku-card-head">
                <strong>{drag.label}</strong>
              </span>
            </span>
          )}
        </div>
      )}
      {fly && (
        <div
          className="balku-fly-card"
          style={{
            left: fly.x,
            top: fly.y,
            width: fly.w,
            height: fly.h,
            transform: fly.go ? `translate(${fly.dx}px, ${fly.dy}px) scale(.55)` : "translate(0, 0)",
            opacity: fly.go ? 0.85 : 1,
          }}
          aria-hidden="true"
        >
          <strong>{fly.name}</strong>
        </div>
      )}
      {renderChat()}
    </>
  );
}
