"use client";

import { useState, type MouseEvent } from "react";

type Point = { label: string; value: number };

function clampPct(pct: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, pct));
}

/** 折れ線グラフ。クリックした位置に一番近い点の日時と数値をポップアップで出す。 */
export function InteractiveSeriesChart({ points, color, label }: {
  points: Point[];
  color: string;
  label: string;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const width = 560;
  const height = 140;
  const pad = 8;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => [
    pad + index * stepX,
    height - pad - ((point.value - min) / range) * (height - pad * 2),
  ] as const);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(pad + (points.length - 1) * stepX).toFixed(1)},${height - pad}`;
  const [lastX, lastY] = coords[coords.length - 1];

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round((viewX - pad) / (stepX || 1));
    const clamped = Math.min(points.length - 1, Math.max(0, index));
    setSelected((prev) => (prev === clamped ? null : clamped));
  };

  const sel = selected !== null ? points[selected] : null;
  const selCoord = selected !== null ? coords[selected] : null;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="status-chart clickable"
        role="img"
        aria-label={label}
        onClick={onClick}
      >
        <polygon points={area} fill={color} opacity={0.14} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} />
        <circle cx={lastX} cy={lastY} r={3.5} fill={color} />
        {selCoord ? (
          <>
            <line
              x1={selCoord[0]}
              y1={pad}
              x2={selCoord[0]}
              y2={height - pad}
              stroke={color}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            <circle cx={selCoord[0]} cy={selCoord[1]} r={5} fill="#ffffff" stroke={color} strokeWidth={2.5} />
          </>
        ) : null}
      </svg>
      {sel && selCoord ? (
        <div
          className="chart-pop"
          style={{
            left: `${clampPct((selCoord[0] / width) * 100, 13, 87)}%`,
            top: `${(selCoord[1] / height) * 100}%`,
          }}
        >
          <span className="chart-pop-label">{sel.label.replace(/-/g, "/")}</span>
          <strong>{sel.value.toLocaleString("ja-JP")}</strong>
        </div>
      ) : null}
    </div>
  );
}

/** 1時間ごとの実行数の棒グラフ。バーをクリックすると、その時間帯の回数をポップアップで出す。 */
export function InteractiveHoursChart({ points }: { points: Point[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const width = 560;
  const height = 140;
  const gap = 2;
  const max = Math.max(1, ...points.map((point) => point.value));
  const barWidth = (width - gap * (points.length - 1)) / points.length;

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.min(points.length - 1, Math.max(0, Math.floor(ratio * points.length)));
    setSelected((prev) => (prev === index ? null : index));
  };

  const sel = selected !== null ? points[selected] : null;
  const selBarHeight = sel ? Math.max(1, (sel.value / max) * (height - 16)) : 0;

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="status-chart clickable"
        role="img"
        aria-label="直近24時間の1時間ごとの実行数"
        onClick={onClick}
      >
        {points.map((point, index) => {
          const barHeight = Math.max(1, (point.value / max) * (height - 16));
          const isSel = index === selected;
          return (
            <rect
              key={point.label}
              x={index * (barWidth + gap)}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={2}
              fill={isSel ? "#1f7a33" : "#2f9e44"}
              stroke={isSel ? "#0d3a56" : "none"}
              strokeWidth={isSel ? 1.2 : 0}
            >
              <title>{`${point.label}: ${point.value}回`}</title>
            </rect>
          );
        })}
      </svg>
      {sel && selected !== null ? (
        <div
          className="chart-pop"
          style={{
            left: `${clampPct(((selected + 0.5) / points.length) * 100, 13, 87)}%`,
            top: `${((height - selBarHeight) / height) * 100}%`,
          }}
        >
          <span className="chart-pop-label">{sel.label.replace("-", "/")}</span>
          <strong>{sel.value.toLocaleString("ja-JP")} 回</strong>
        </div>
      ) : null}
    </div>
  );
}

/** 稼働率バー。日ごとのバーや合計表示をクリックすると、その数値をポップアップで出す。 */
export function InteractiveUptime({ items, pct, recordedDays, samplesPerDay }: {
  items: { date: string; ratio: number | null; samples: number | null }[];
  pct: number | null;
  recordedDays: number;
  samplesPerDay: number;
}) {
  const [selected, setSelected] = useState<number | "summary" | null>(null);
  const selItem = typeof selected === "number" ? items[selected] : null;

  return (
    <div className="chart-wrap">
      <div className="uptime-bars">
        {items.map((item, index) => {
          const ratio = item.ratio;
          const cls = ratio === null ? "uptime-bar none"
            : ratio >= 0.99 ? "uptime-bar ok"
            : ratio >= 0.5 ? "uptime-bar warn" : "uptime-bar low";
          const title = ratio === null
            ? `${item.date}: 記録なし`
            : `${item.date}: 稼働率 ${(ratio * 100).toFixed(1)}%`;
          return (
            <div
              key={item.date}
              className={selected === index ? `${cls} sel` : cls}
              title={title}
              onClick={() => setSelected((prev) => (prev === index ? null : index))}
            />
          );
        })}
      </div>
      <div className="uptime-caption">
        <span>30日前</span>
        <button
          type="button"
          className="uptime-pct"
          onClick={() => setSelected((prev) => (prev === "summary" ? null : "summary"))}
        >
          {pct === null ? "—" : `${pct.toFixed(1)} % uptime`}
        </button>
        <span>今日</span>
      </div>
      {selItem && typeof selected === "number" ? (
        <div
          className="chart-pop"
          style={{
            left: `${clampPct(((selected + 0.5) / items.length) * 100, 16, 84)}%`,
            top: 0,
          }}
        >
          <span className="chart-pop-label">{selItem.date.replace(/-/g, "/")}</span>
          {selItem.ratio === null ? (
            <strong>記録なし</strong>
          ) : (
            <strong>
              稼働率 {(selItem.ratio * 100).toFixed(1)}%
              {selItem.samples !== null ? (
                <span className="chart-pop-sub">記録 {selItem.samples}/{samplesPerDay}</span>
              ) : null}
            </strong>
          )}
        </div>
      ) : null}
      {selected === "summary" ? (
        <div className="chart-pop" style={{ left: "50%", top: 0 }}>
          <span className="chart-pop-label">過去30日の平均</span>
          <strong>
            {pct === null ? "—" : `稼働率 ${pct.toFixed(1)}%`}
            <span className="chart-pop-sub">記録のある日 {recordedDays}/{items.length}日</span>
          </strong>
        </div>
      ) : null}
    </div>
  );
}
