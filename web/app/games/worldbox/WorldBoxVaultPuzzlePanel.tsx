"use client";
import { useState } from "react";
import { playWbSe } from "@/lib/worldbox/sound";

type Mode = "cipher" | "circuit" | "runes";

const RUNES = ["◈", "◇", "△", "☆"];

function generateSecretCode(): string {
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const picked: string[] = [];
  while (picked.length < 4) {
    const idx = Math.floor(Math.random() * digits.length);
    picked.push(digits.splice(idx, 1)[0]);
  }
  return picked.join("");
}

function evalGuess(secret: string, guess: string): { hit: number; blow: number } {
  let hit = 0;
  let blow = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) hit++;
    else if (secret.includes(guess[i])) blow++;
  }
  return { hit, blow };
}

type ConduitCell = {
  type: "I" | "L";
  rot: number; // 0..3 * 90deg
};

// Directions: 0=N, 1=E, 2=S, 3=W
const INITIAL_CIRCUIT: ConduitCell[] = [
  { type: "L", rot: 0 }, // (0,0) target S/E => rot 1
  { type: "I", rot: 1 }, // (1,0) target E/W => rot 1
  { type: "L", rot: 1 }, // (2,0) target W/S => rot 2
  { type: "I", rot: 0 }, // (0,1)
  { type: "L", rot: 0 }, // (1,1)
  { type: "I", rot: 1 }, // (2,1) target N/S => rot 0
  { type: "L", rot: 2 }, // (0,2)
  { type: "I", rot: 0 }, // (1,2)
  { type: "L", rot: 2 }, // (2,2) target N/E => rot 0
];

function openPorts(cell: ConduitCell): number[] {
  const base = cell.type === "I" ? [0, 2] : [0, 1];
  return base.map((d) => (d + cell.rot) % 4);
}

function isCircuitSolved(cells: ConduitCell[]): boolean {
  // Check path from (0,0) West-entry -> ... -> (2,2) East-exit
  const dirs = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  const opp = [2, 3, 0, 1];
  if (!openPorts(cells[0]).includes(3)) return false;
  const visited = new Set<number>([0]);
  const q = [0];
  while (q.length > 0) {
    const idx = q.pop()!;
    const cx = idx % 3;
    const cy = Math.floor(idx / 3);
    for (const d of openPorts(cells[idx])) {
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (nx < 0 || nx >= 3 || ny < 0 || ny >= 3) continue;
      const nidx = ny * 3 + nx;
      if (openPorts(cells[nidx]).includes(opp[d]) && !visited.has(nidx)) {
        visited.add(nidx);
        q.push(nidx);
      }
    }
  }
  return visited.has(8) && openPorts(cells[8]).includes(1);
}

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(500px, calc(100% - 20px))",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12,14,22,0.95)",
  border: "1px solid rgba(185,150,255,0.35)",
  color: "#f2f1f8",
  zIndex: 6,
  boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
  boxSizing: "border-box",
};

const btn: React.CSSProperties = {
  minHeight: 34,
  padding: "4px 12px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
};

export default function WorldBoxVaultPuzzlePanel({
  clears,
  onClear,
  onClose,
}: {
  clears: number;
  onClear: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("cipher");

  // Mode 1: Cipher 4-digit Bulls & Cows
  const [secret, setSecret] = useState<string>(() => generateSecretCode());
  const [guess, setGuess] = useState("");
  const [logs, setLogs] = useState<{ guess: string; hit: number; blow: number }[]>([]);
  const [cipherSolved, setCipherSolved] = useState(false);

  // Mode 2: Rotating Conduit Circuit
  const [circuit, setCircuit] = useState<ConduitCell[]>(() =>
    INITIAL_CIRCUIT.map((c) => ({ ...c })),
  );
  const [circuitSolved, setCircuitSolved] = useState(false);

  // Mode 3: Linked Rune Gear Lock (goal: all 0 => ◈)
  const [runes, setRunes] = useState<number[]>([2, 1, 3, 2]);
  const [runesSolved, setRunesSolved] = useState(false);

  const [msg, setMsg] = useState("金庫の暗号装置を起動しました");

  const submitCipher = () => {
    if (cipherSolved) return;
    const clean = guess.trim();
    if (!/^\d{4}$/.test(clean) || new Set(clean).size !== 4) {
      playWbSe("error");
      setMsg("重複しない4桁の数字を入力してください（例: 4927）");
      return;
    }
    const res = evalGuess(secret, clean);
    const nextLogs = [{ guess: clean, ...res }, ...logs];
    setLogs(nextLogs);
    setGuess("");
    if (res.hit === 4) {
      setCipherSolved(true);
      playWbSe("success");
      setMsg(`解錠成功！ 暗号コードは ${secret} でした！`);
      onClear();
    } else {
      playWbSe("click");
      setMsg(`${res.hit} HIT（位置と数字一致） / ${res.blow} BLOW（数字のみ一致）`);
    }
  };

  const resetCipher = () => {
    setSecret(generateSecretCode());
    setGuess("");
    setLogs([]);
    setCipherSolved(false);
    setMsg("新しい4桁暗号を生成しました");
  };

  const rotateCell = (idx: number) => {
    if (circuitSolved) return;
    playWbSe("click");
    setCircuit((prev) => {
      const next = prev.map((c, i) => (i === idx ? { ...c, rot: (c.rot + 1) % 4 } : c));
      if (isCircuitSolved(next)) {
        setCircuitSolved(true);
        playWbSe("success");
        setMsg("導線サーキット通電完了！ 金庫のボルトが外れた！");
        onClear();
      }
      return next;
    });
  };

  const resetCircuit = () => {
    setCircuit(INITIAL_CIRCUIT.map((c) => ({ ...c })));
    setCircuitSolved(false);
    setMsg("導線を初期位置へ戻しました");
  };

  const spinRune = (idx: number) => {
    if (runesSolved) return;
    playWbSe("click");
    setRunes((prev) => {
      const next = [...prev];
      const partner = (idx + 1) % 4;
      next[idx] = (next[idx] + 1) % 4;
      next[partner] = (next[partner] + 1) % 4;
      if (next.every((v) => v === 0)) {
        setRunesSolved(true);
        playWbSe("success");
        setMsg("全ての紋章が ◈ に揃い、秘密金庫が開いた！");
        onClear();
      }
      return next;
    });
  };

  const resetRunes = () => {
    setRunes([2, 1, 3, 2]);
    setRunesSolved(false);
    setMsg("ルーンリングをリセットしました");
  };

  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>🔐 古代秘宝・暗号金庫</strong>
        <span style={{ fontSize: 12, color: "#cfaeff" }}>解錠実績 {clears} 回</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { id: "cipher" as Mode, label: "4桁暗号デコード" },
          { id: "circuit" as Mode, label: "導線サーキット" },
          { id: "runes" as Mode, label: "連動ルーン錠" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setMode(tab.id);
              playWbSe("click");
            }}
            style={{
              ...btn,
              background: mode === tab.id ? "rgba(170,120,255,0.32)" : "rgba(255,255,255,0.08)",
              borderColor: mode === tab.id ? "#c59bff" : "rgba(255,255,255,0.2)",
              fontWeight: mode === tab.id ? 700 : 400,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "cipher" && (
        <div>
          <div style={{ fontSize: 12, color: "#d5d3ea", marginBottom: 8 }}>
            重複しない4桁の暗号を推理しよう（例: 1234）
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={guess}
              onChange={(e) => setGuess(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCipher();
              }}
              placeholder="0123"
              aria-label="4桁コード"
              style={{
                flex: 1,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.28)",
                background: "rgba(255,255,255,0.08)",
                color: "#fff",
                fontSize: 16,
                letterSpacing: "0.25em",
              }}
            />
            <button
              type="button"
              onClick={submitCipher}
              disabled={cipherSolved}
              style={{ ...btn, background: "rgba(110,195,145,0.35)", fontWeight: 700 }}
            >
              照合
            </button>
            <button type="button" onClick={resetCipher} style={btn}>
              新規問題
            </button>
          </div>
          <div style={{ maxHeight: 130, overflowY: "auto", display: "grid", gap: 4 }}>
            {logs.map((entry, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 10px",
                  borderRadius: 7,
                  background: "rgba(255,255,255,0.06)",
                  fontSize: 12,
                }}
              >
                <span style={{ letterSpacing: "0.2em", fontWeight: 700 }}>{entry.guess}</span>
                <span>
                  <strong style={{ color: "#ffd84d" }}>{entry.hit} HIT</strong> /{" "}
                  <strong style={{ color: "#79c8ff" }}>{entry.blow} BLOW</strong>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "circuit" && (
        <div>
          <div style={{ fontSize: 12, color: "#d5d3ea", marginBottom: 8 }}>
            左上 IN（←）から右下 OUT（→）まで導線を回転させて接続しよう！
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              justifyContent: "center",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 12, color: "#80e8ff", fontWeight: 700 }}>IN →</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 62px)", gap: 6 }}>
              {circuit.map((cell, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => rotateCell(idx)}
                  aria-label={`サーキットマス ${idx + 1}`}
                  style={{
                    width: 62,
                    height: 62,
                    borderRadius: 10,
                    border: circuitSolved
                      ? "2px solid #7be495"
                      : "1px solid rgba(255,255,255,0.28)",
                    background: circuitSolved ? "rgba(123,228,149,0.16)" : "rgba(255,255,255,0.07)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                  }}
                >
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 40 40"
                    style={{
                      transform: `rotate(${cell.rot * 90}deg)`,
                      transition: "transform 120ms",
                    }}
                  >
                    {cell.type === "I" ? (
                      <line
                        x1="20"
                        y1="0"
                        x2="20"
                        y2="40"
                        stroke={circuitSolved ? "#7be495" : "#80d4ff"}
                        strokeWidth="6"
                        strokeLinecap="round"
                      />
                    ) : (
                      <path
                        d="M 20 0 L 20 20 L 40 20"
                        fill="none"
                        stroke={circuitSolved ? "#7be495" : "#ffd86b"}
                        strokeWidth="6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: "#ffd84d", fontWeight: 700 }}>→ OUT</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <button type="button" onClick={resetCircuit} style={btn}>
              リセット
            </button>
          </div>
        </div>
      )}

      {mode === "runes" && (
        <div>
          <div style={{ fontSize: 12, color: "#d5d3ea", marginBottom: 8 }}>
            ボタンを押すと<strong>そのリングと右隣（循環）</strong>が同時に1段階回転！
            全て「◈」に揃えよう。
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 10 }}>
            {runes.map((val, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => spinRune(idx)}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  border: val === 0 ? "2px solid #ffd84d" : "1px solid rgba(255,255,255,0.28)",
                  background: val === 0 ? "rgba(255,216,77,0.18)" : "rgba(255,255,255,0.08)",
                  color: val === 0 ? "#ffd84d" : "#eef",
                  fontSize: 26,
                  cursor: "pointer",
                }}
              >
                {RUNES[val]}
              </button>
            ))}
          </div>
          <div style={{ textAlign: "right" }}>
            <button type="button" onClick={resetRunes} style={btn}>
              リセット
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 12, color: "#b9e8ff" }} role="status">
        {msg}
      </div>
    </div>
  );
}
