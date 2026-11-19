"use client";
// LLL 共通ベクターアイコン集（絵文字を使わず均質なストローク線画で統一する）。
import type { SVGProps } from "react";
import type { LllElement } from "./LllCard";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size: number, rest: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...rest,
  };
}

export function IconHub({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconSwords({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M14.5 17.5L3 6V3h3l11.5 11.5" />
      <path d="M13 19l6-6" />
      <path d="M16 16l4 4" />
      <path d="M19 21l2-2" />
      <path d="M14.5 6.5L18 3h3v3l-3.5 3.5" />
      <path d="M5 14l4 4" />
      <path d="M7 17l-3 3" />
      <path d="M3 19l2 2" />
    </svg>
  );
}

export function IconDeck({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="6" y="3" width="12" height="16" rx="2" />
      <path d="M3 7v11a2 2 0 0 0 2 2h10" />
      <path d="M10 8h4" />
      <path d="M10 12h4" />
    </svg>
  );
}

export function IconScout({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="12" cy="12" r="3" />
      <path d="M7 5l1.5-2h7L17 5" />
    </svg>
  );
}

export function IconCodex({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M9 7h6" />
      <path d="M9 11h5" />
    </svg>
  );
}

export function IconBack({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function IconRelic({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <polygon points="12 2 19 8 16 21 8 21 5 8 12 2" />
      <path d="M12 2v19" />
      <path d="M5 8h14" />
    </svg>
  );
}

export function IconTune({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M2 14h4" />
      <path d="M10 8h4" />
      <path d="M18 16h4" />
    </svg>
  );
}

export function IconShield({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
    </svg>
  );
}

export function IconLock({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function IconStar({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <polygon points="12 2.5 14.9 8.6 21.5 9.4 16.6 14 17.9 20.6 12 17.3 6.1 20.6 7.4 14 2.5 9.4 9.1 8.6 12 2.5" />
    </svg>
  );
}

export function IconBolt({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" />
    </svg>
  );
}

export function IconCube({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z" />
      <path d="M12 22V11" />
      <path d="M20 6.5L12 11 4 6.5" />
    </svg>
  );
}

export function IconMusic({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export function IconVolume({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
    </svg>
  );
}

export function IconTicket({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z" />
      <path d="M10 6v12" strokeDasharray="2 2" />
    </svg>
  );
}

export function IconShard({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <polygon points="12 2 19 12 12 22 5 12 12 2" />
    </svg>
  );
}

export function IconLumen({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
    </svg>
  );
}

export function IconArrowRight({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconField({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size, rest)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
    </svg>
  );
}

export function ElementIcon({ element, size = 14, ...rest }: IconProps & { element: LllElement }) {
  switch (element) {
    case "fire":
      return (
        <svg {...baseProps(size, rest)}>
          <path d="M12 2c2.5 3 5 5.5 5 9a5 5 0 0 1-10 0c0-2 1-3.8 2-5 .5 1.5 1.5 2 2 2 0-2.5 0-4.5 1-6z" />
        </svg>
      );
    case "water":
      return (
        <svg {...baseProps(size, rest)}>
          <path d="M12 3c-3.5 4.8-6 8-6 11a6 6 0 0 0 12 0c0-3-2.5-6.2-6-11z" />
        </svg>
      );
    case "wind":
      return (
        <svg {...baseProps(size, rest)}>
          <path d="M3 9h12a3 3 0 1 0-3-3" />
          <path d="M3 14h15a3 3 0 1 1-3 3" />
          <path d="M3 19h8" />
        </svg>
      );
    case "earth":
      return (
        <svg {...baseProps(size, rest)}>
          <polygon points="12 3 21 19 3 19 12 3" />
          <path d="M8 14h8" />
        </svg>
      );
    case "light":
      return (
        <svg {...baseProps(size, rest)}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
        </svg>
      );
    case "dark":
      return (
        <svg {...baseProps(size, rest)}>
          <path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
        </svg>
      );
  }
}
