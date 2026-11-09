"use client";

// One Prompter の操作UI（クライアント専用）。
// 雑な一文 → 二択質問（1問ずつ） → 完成プロンプト表示、の3状態だけを持つ。
// 入力はこのブラウザの中だけで処理し、サーバーへは送らない。
import { useMemo, useState } from "react";
import {
  buildPrompt,
  generateQuestions,
  type BinaryQuestion,
  type PrompterAnswer,
  type PrompterCategory,
} from "../../lib/one-prompter";

type Phase =
  | { name: "input" }
  | { name: "questions"; category: PrompterCategory; questions: BinaryQuestion[]; index: number; answers: PrompterAnswer[] }
  | { name: "result"; category: PrompterCategory; answers: PrompterAnswer[]; prompt: string };

export default function OnePrompterClient() {
  const [rough, setRough] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "input" });
  const [copied, setCopied] = useState(false);

  const canStart = rough.trim().length > 0;

  const start = () => {
    const { category, questions } = generateQuestions(rough);
    setCopied(false);
    setPhase({ name: "questions", category, questions, index: 0, answers: [] });
  };

  const answer = (optionIndex: 0 | 1) => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    const opt = q.options[optionIndex];
    const answers: PrompterAnswer[] = [
      ...phase.answers,
      { slot: q.slot, question: q.question, label: opt.label, instruction: opt.instruction },
    ];
    if (phase.index + 1 >= phase.questions.length) {
      setPhase({ name: "result", category: phase.category, answers, prompt: buildPrompt(rough, phase.category, answers) });
    } else {
      setPhase({ ...phase, index: phase.index + 1, answers });
    }
  };

  const back = () => {
    if (phase.name !== "questions" || phase.index === 0) return;
    setPhase({ ...phase, index: phase.index - 1, answers: phase.answers.slice(0, -1) });
  };

  const restart = () => {
    setPhase({ name: "input" });
    setCopied(false);
  };

  const copy = async () => {
    if (phase.name !== "result") return;
    try {
      await navigator.clipboard.writeText(phase.prompt);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const dots = useMemo(() => {
    if (phase.name !== "questions") return null;
    return (
      <div className="op-dots" aria-hidden="true">
        {phase.questions.map((q, i) => (
          <span key={q.slot} className={i < phase.index ? "op-dot done" : i === phase.index ? "op-dot current" : "op-dot"} />
        ))}
      </div>
    );
  }, [phase]);

  if (phase.name === "input") {
    return (
      <div className="op-panel">
        <label className="op-label" htmlFor="op-input">雑な一文でいいので、やりたいことを書いてください</label>
        <textarea
          id="op-input"
          value={rough}
          onChange={(e) => setRough(e.target.value)}
          placeholder="例：転職したい、自己PR書いて"
          rows={3}
          autoFocus
        />
        <div className="op-actions">
          <button type="button" className="op-primary" onClick={start} disabled={!canStart}>
            質問に答える
          </button>
        </div>
      </div>
    );
  }

  if (phase.name === "questions") {
    const q = phase.questions[phase.index];
    return (
      <div className="op-panel">
        {dots}
        <p className="op-count">{phase.index + 1} / {phase.questions.length}</p>
        <h2 className="op-question">{q.question}</h2>
        <div className="op-options">
          {q.options.map((opt, i) => (
            <button key={opt.label} type="button" className="op-option" onClick={() => answer(i as 0 | 1)}>
              {opt.label}
            </button>
          ))}
        </div>
        {phase.index > 0 && (
          <button type="button" className="op-back" onClick={back}>← もどる</button>
        )}
      </div>
    );
  }

  return (
    <div className="op-panel">
      <h2 className="op-question">完成プロンプト</h2>
      {phase.answers.length > 0 && (
        <ul className="op-summary">
          {phase.answers.map((a) => (
            <li key={a.slot}><span>{a.question}</span>{a.label}</li>
          ))}
        </ul>
      )}
      <pre className="op-result">{phase.prompt}</pre>
      <div className="op-actions">
        <button type="button" className="op-primary" onClick={copy}>
          {copied ? "コピーしました" : "プロンプトをコピー"}
        </button>
        <button type="button" className="op-secondary" onClick={restart}>
          最初からやり直す
        </button>
      </div>
      <p className="quiet-note">コピーして、ChatGPT・Claude など好きなAIに貼って使ってください。</p>
    </div>
  );
}
