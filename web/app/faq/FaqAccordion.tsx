// /faq のアコーディオン。ネイティブの details/summary で開閉し、
// 回答テキストは初期HTMLに常時含まれる（クローラが回答まで読めるようにするため、
// JSで開いたときだけ描画する形にはしない）。初期状態はすべて閉じている。
import type { ReactNode } from "react";

export type FaqItem = { question: string; answer: ReactNode };

export default function FaqAccordion({ items }: { items: FaqItem[] }) {
  return (
    <div className="faq-list">
      {items.map((item) => (
        <details key={item.question} className="faq-item">
          <summary className="faq-q">{item.question}</summary>
          <div className="faq-a">{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
