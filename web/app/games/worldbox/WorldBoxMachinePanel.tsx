"use client";

// AGO WORLD BOX の装置パネル（自動収穫機）。
// バッファの回収、プログラム（有効/間隔/プリセット）の変更、共有コードの
// 書き出し・取り込みを行う。状態の正はサーバー（/api/worldbox/machines）。
import { useCallback, useEffect, useState } from "react";
import type { PlayerProfile } from "@/lib/worldbox/profile";
import { ItemAnnotation, ItemSlot, ItemSlotGrid } from "./ItemSlotGrid";
import {
  DEVICE_INTERVAL_CHOICES, DEVICE_PRESETS, type DeviceProgram,
} from "@/lib/worldbox/machines";

const panelStyle: React.CSSProperties = {
  position: "absolute", left: "50%", bottom: 12, transform: "translateX(-50%)",
  width: "min(340px, calc(100% - 20px))", zIndex: 30,
  // 低丈の横持ちでもステージからはみ出さない（従来は高さ制限が無く溢れた）
  maxHeight: "calc(100% - 24px)", overflowY: "auto", overscrollBehavior: "contain",
  background: "rgba(16,20,18,0.94)", border: "1px solid rgba(255,255,255,0.22)",
  borderRadius: 12, padding: "10px 12px", color: "#fff",
  boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
};
const btn: React.CSSProperties = {
  minHeight: 32, padding: "4px 10px", borderRadius: 8, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.12)", color: "#fff",
  fontSize: 13,
};
const input: React.CSSProperties = {
  minHeight: 32, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 13,
};

type MachineView = {
  program: DeviceProgram;
  code: string;
  buffer: Record<string, number>;
  buffered: number;
};

export default function WorldBoxMachinePanel({
  x,
  y,
  onProfileChange,
  onClose,
}: {
  x: number;
  y: number;
  onProfileChange: (profile: PlayerProfile) => void;
  onClose: () => void;
}) {
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [codeIn, setCodeIn] = useState("");
  const [msg, setMsg] = useState("");
  const [bufferSel, setBufferSel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/worldbox/machines?x=${x}&y=${y}`, { headers: { Accept: "application/json" } });
      const data = (await res.json().catch(() => ({}))) as { machine?: MachineView };
      if (res.ok && data.machine) setMachine(data.machine);
      else onClose();
    } catch {
      onClose();
    }
  }, [x, y, onClose]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = async (payload: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/worldbox/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y, ...payload }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        machine?: MachineView; profile?: PlayerProfile; error?: string;
      };
      if (!res.ok) {
        setMsg(data.error === "empty" ? "まだ何もない" : data.error === "bad_code" ? "コードが違う" : "できない");
        return;
      }
      if (data.machine) setMachine(data.machine);
      if (data.profile) onProfileChange(data.profile);
      setMsg("");
    } catch {
      setMsg("できない");
    }
  };

  const setProgram = (program: DeviceProgram) => {
    void post({ action: "set_program", program });
  };

  return (
    <div style={panelStyle} role="dialog" aria-label="自動収穫機" className="wb-panel">
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          position: "sticky", top: -10, zIndex: 3,
          margin: "-10px -12px 0", padding: "10px 12px 6px",
          background: "rgba(16,20,18,0.98)",
        }}
      >
        <strong style={{ fontSize: 14 }}>自動収穫機</strong>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>閉じる</button>
      </div>
      {!machine ? (
        <p style={{ fontSize: 13, opacity: 0.75, margin: "8px 0 2px" }}>…</p>
      ) : (
        <>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {machine.buffered <= 0 ? (
              <span style={{ opacity: 0.75 }}>バッファは空</span>
            ) : (
              <div>
                <ItemSlotGrid>
                  {Object.entries(machine.buffer).map(([itemId, count]) => (
                    <ItemSlot
                      key={itemId}
                      itemId={itemId}
                      count={count}
                      selected={bufferSel === itemId}
                      onClick={() => setBufferSel(itemId)}
                    />
                  ))}
                </ItemSlotGrid>
                {bufferSel && machine.buffer[bufferSel] && (
                  <ItemAnnotation itemId={bufferSel} />
                )}
                <div style={{ marginTop: 8 }}>
                  <button type="button" style={btn} onClick={() => { void post({ action: "collect" }); }}>
                    回収
                  </button>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              style={{ ...btn, ...(machine.program.enabled ? {} : { opacity: 0.55 }) }}
              aria-pressed={machine.program.enabled}
              onClick={() => setProgram({ ...machine.program, enabled: !machine.program.enabled })}
            >
              {machine.program.enabled ? "稼働中" : "停止中"}
            </button>
            <select
              value={machine.program.intervalSec}
              onChange={(e) => setProgram({ ...machine.program, intervalSec: Number(e.target.value) })}
              style={{ ...input, minHeight: 32 }}
              aria-label="間隔"
            >
              {DEVICE_INTERVAL_CHOICES.map((sec) => (
                <option key={sec} value={sec}>{sec}秒ごと</option>
              ))}
            </select>
            <select
              value=""
              onChange={(e) => {
                const preset = DEVICE_PRESETS.find((p) => p.id === e.target.value);
                if (preset) setProgram({ ...preset.program });
              }}
              style={{ ...input, minHeight: 32 }}
              aria-label="プリセット"
            >
              <option value="">プリセット…</option>
              {DEVICE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85, wordBreak: "break-all" }}>
            共有コード: {machine.code}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input
              value={codeIn}
              onChange={(e) => setCodeIn(e.target.value)}
              placeholder="WB1.…"
              style={{ ...input, flex: 1 }}
              aria-label="共有コード入力"
            />
            <button
              type="button"
              style={btn}
              disabled={!codeIn}
              onClick={() => { void post({ action: "apply_code", code: codeIn }); setCodeIn(""); }}
            >
              取り込む
            </button>
          </div>
          {msg && <p role="status" style={{ margin: "8px 0 0", fontSize: 13 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
