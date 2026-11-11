"use client";

// 生成モデルの選択状態を、ヘッダー（OpHeader / OpMenu）と操作UI
// （OnePrompterClient）で共有するためのコンテキスト。
// 以前はモデル選択が入力画面の設定グループ内にあり、状態は
// OnePrompterClient が単独で持っていた。選択UIがヘッダーの
// ハンバーガーメニューへ移ったため、状態の置き場をここへ寄せ、
// レイアウト側から Provider で全体を包む。
import { createContext, useContext, useState, type ReactNode } from "react";
import { DEFAULT_MODEL_KEY, type PrompterModelKey } from "../../lib/one-prompter-llm";

type OpModelState = {
  modelKey: PrompterModelKey;
  setModelKey: (key: PrompterModelKey) => void;
};

const OpModelContext = createContext<OpModelState | null>(null);

export function OpModelProvider({ children }: { children: ReactNode }) {
  const [modelKey, setModelKey] = useState<PrompterModelKey>(DEFAULT_MODEL_KEY);
  return <OpModelContext.Provider value={{ modelKey, setModelKey }}>{children}</OpModelContext.Provider>;
}

export function useOpModel(): OpModelState {
  const ctx = useContext(OpModelContext);
  if (!ctx) throw new Error("useOpModel は OpModelProvider の内側で使ってください。");
  return ctx;
}
