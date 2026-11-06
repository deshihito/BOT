"use client";

import { useState } from "react";
import { unwrapId, type SectionSpec } from "@/lib/dashboard-core";

type Props = {
  guildId: string;
  spec: SectionSpec;
  initial: Record<string, unknown>;
};

function initialText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return unwrapId(value) || (typeof value === "string" ? value : "");
}

function initialList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => unwrapId(item)).filter(Boolean).join("\n");
}

export default function SettingsForm({ guildId, spec, initial }: Props) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const state: Record<string, string | boolean> = {};
    for (const field of spec.fields) {
      const raw = initial[field.name];
      switch (field.type) {
        case "bool":
          state[field.name] = typeof raw === "boolean" ? raw : field.default === true;
          break;
        case "role_list":
          state[field.name] = initialList(raw);
          break;
        case "text_list":
          state[field.name] = Array.isArray(raw) ? raw.filter((item) => typeof item === "string").join("\n") : "";
          break;
        case "number":
        case "enum_number":
          state[field.name] = typeof raw === "number" ? String(raw) : typeof field.default === "number" ? String(field.default) : "";
          break;
        case "enum":
          state[field.name] = typeof raw === "string" ? raw : typeof field.default === "string" ? field.default : String(field.options?.[0]?.value ?? "");
          break;
        case "preset": {
          const presets = field.presetValues ?? {};
          const matched = Object.entries(presets).find(([, preset]) =>
            Object.entries(preset).every(([key, value]) => initial[key] === value),
          );
          state[field.name] = matched?.[0] ?? String(field.options?.[0]?.value ?? "");
          break;
        }
        case "text":
          state[field.name] = typeof raw === "string" ? raw : typeof field.default === "string" ? field.default : "";
          break;
        default:
          state[field.name] = initialText(raw);
      }
    }
    return state;
  });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  function set(name: string, value: string | boolean) {
    setValues((prev) => ({ ...prev, [name]: value }));
    setStatus("idle");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setErrors([]);
    const payload: Record<string, unknown> = {};
    for (const field of spec.fields) {
      const value = values[field.name];
      switch (field.type) {
        case "bool":
          payload[field.name] = value === true;
          break;
        case "role_list":
          payload[field.name] = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
          break;
        case "text_list":
          payload[field.name] = typeof value === "string" ? value.split(/[\n,、]+/).map((item) => item.trim()).filter(Boolean) : [];
          break;
        case "number":
        case "enum_number":
          if (typeof value === "string" && value.trim() !== "") payload[field.name] = Number(value);
          break;
        default:
          payload[field.name] = typeof value === "string" ? value : "";
      }
    }
    try {
      const res = await fetch(`/api/dashboard/guilds/${guildId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: spec.section, values: payload }),
      });
      const data = (await res.json()) as { ok?: boolean; errors?: string[]; error?: string };
      if (res.ok && data.ok) {
        setStatus("saved");
      } else {
        setStatus("error");
        setErrors(data.errors ?? [data.error ?? "保存できませんでした"]);
      }
    } catch {
      setStatus("error");
      setErrors(["通信に失敗しました。時間をおいて再度お試しください。"]);
    }
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="page-heading compact-heading">
        <h2>{spec.label}</h2>
        <p className="muted">{spec.description}</p>
      </div>
      {spec.fields.map((field) => {
        const value = values[field.name];
        return (
          <div className="settings-field" key={field.name}>
            {field.type === "bool" ? (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => set(field.name, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
            ) : (
              <>
                <label htmlFor={`${spec.section}-${field.name}`}>{field.label}</label>
                {field.type === "enum" || field.type === "enum_number" || field.type === "preset" ? (
                  <select
                    id={`${spec.section}-${field.name}`}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(field.name, event.target.value)}
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                    ))}
                  </select>
                ) : field.type === "role_list" || field.type === "text_list" || field.multiline ? (
                  <textarea
                    id={`${spec.section}-${field.name}`}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(field.name, event.target.value)}
                    rows={field.type === "role_list" ? 4 : 3}
                    placeholder={field.type === "role_list" ? "ロールIDを1行に1つずつ" : undefined}
                  />
                ) : (
                  <input
                    id={`${spec.section}-${field.name}`}
                    type={field.type === "number" ? "number" : "text"}
                    inputMode={field.type === "channel" || field.type === "role" ? "numeric" : undefined}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(field.name, event.target.value)}
                    placeholder={field.type === "channel" ? "チャンネルID（空欄で未設定）" : field.type === "role" ? "ロールID（空欄で未設定）" : undefined}
                  />
                )}
              </>
            )}
            {field.description ? <p className="settings-note">{field.description}</p> : null}
          </div>
        );
      })}
      <div className="settings-actions">
        <button type="submit" disabled={status === "saving"}>{status === "saving" ? "保存中…" : "保存する"}</button>
        {status === "saved" ? <span className="settings-saved" role="status">保存しました。Botへの反映には1分ほどかかります。</span> : null}
      </div>
      {status === "error" ? (
        <ul className="login-error" role="alert">
          {errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      ) : null}
    </form>
  );
}
