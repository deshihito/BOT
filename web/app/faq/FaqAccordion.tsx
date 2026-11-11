"use client";
// /faq のアコーディオン。質問は1件ずつ開閉でき、初期状態はすべて閉じている。
import { useState, type ReactNode } from "react";

export type FaqItem = { question: string; answer: ReactNode };

export default function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="faq-list">
      {items.map((item, index) => {
        const expanded = open === index;
        return (
          <div key={item.question} className="faq-item">
            <button
              type="button"
              className="faq-q"
              aria-expanded={expanded}
              aria-controls={`faq-a-${index}`}
              onClick={() => setOpen(expanded ? null : index)}
            >
              {item.question}
            </button>
            {expanded ? (
              <div className="faq-a" id={`faq-a-${index}`}>
                {item.answer}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
