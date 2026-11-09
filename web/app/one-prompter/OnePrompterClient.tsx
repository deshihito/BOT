"use client";

// One Prompter の操作UI（クライアント）。
// 雑な一文 → 二択質問（1問ずつ） → 完成プロンプト表示。
// 質問生成とプロンプト合成は自サイトの API（/api/one-prompter、サーバー側で LLM を呼ぶ）に任せ、
// API が使えない環境・失敗時はルールベース版（lib/one-prompter.ts）にその場で切り替える。
import { useMemo, useState } from "react";
import {
  buildPrompt,
  generateQuestions,
  type PrompterAnswer,
  type PrompterCategory,
  type QuestionSlot,
} from "../../lib/one-prompter";
import { MAX_ROUGH_LENGTH, type LlmQuestion } from "../../lib/one-prompter-llm";

type UiOption = {
  label: string;
  /** ルールベース版の選択肢だけが持つ、完成プロンプト用の指示文 */
  instruction?: string;
};

type UiQuestion = {
  slot?: QuestionSlot;
  question: string;
  options: [UiOption, UiOption];
};

type UiAnswer = {
  slot?: QuestionSlot;
  question: string;
  label: string;
  instruction: string;
};

type Source = "llm" | "rule";

type Phase =
  | { name: "input" }
  | { name: "loading-questions" }
  | { name: "questions"; source: Source; category: PrompterCategory; questions: UiQuestion[]; index: number; answers: UiAnswer[] }
  | { name: "loading-result"; answers: UiAnswer[] }
  | { name: "result"; answers: UiAnswer[]; prompt: string };

function isLlmQuestions(value: unknown): value is LlmQuestion[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 5) return false;
  return value.every(
    (q) =>
      q &&
      typeof q === "object" &&
      typeof (q as LlmQuestion).question === "string" &&
      Array.isArray((q as LlmQuestion).options) &&
      (q as LlmQuestion).options.length === 2 &&
      (q as LlmQuestion).options.every((o) => typeof o === "string" && o.length > 0),
  );
}

async function postOnePrompter(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch("/api/one-prompter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default function OnePrompterClient() {
  const [rough, setRough] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "input" });
  const [copied, setCopied] = useState(false);

  const canStart = rough.trim().length > 0;

  const startWithRuleBased = () => {
    const { category, questions } = generateQuestions(rough);
    setPhase({
      name: "questions",
      source: "rule",
      category,
      questions: questions.map((q) => ({
        slot: q.slot,
        question: q.question,
        options: [
          { label: q.options[0].label, instruction: q.options[0].instruction },
          { label: q.options[1].label, instruction: q.options[1].instruction },
        ] as [UiOption, UiOption],
      })),
      index: 0,
      answers: [],
    });
  };

  const start = async () => {
    setCopied(false);
    setPhase({ name: "loading-questions" });
    const data = await postOnePrompter({ action: "questions", rough: rough.trim() });
    if (data && isLlmQuestions(data.questions)) {
      setPhase({
        name: "questions",
        source: "llm",
        category: "generic",
        questions: data.questions.map((q) => ({
          question: q.question,
          options: [{ label: q.options[0] }, { label: q.options[1] }] as [UiOption, UiOption],
        })),
        index: 0,
        answers: [],
      });
      return;
    }
    startWithRuleBased();
  };

  const finishWithRuleBased = (category: PrompterCategory, answers: UiAnswer[]) => {
    const promptAnswers: PrompterAnswer[] = answers.map((a) => ({
      slot: a.slot ?? "purpose",
      question: a.question,
      label: a.label,
      instruction: a.instruction,
    }));
    setPhase({ name: "result", answers, prompt: buildPrompt(rough, category, promptAnswers) });
  };

  const finish = async (source: Source, category: PrompterCategory, answers: UiAnswer[]) => {
    if (source === "rule") {
      finishWithRuleBased(category, answers);
      return;
    }
    setPhase({ name: "loading-result", answers });
    const data = await postOnePrompter({
      action: "synthesize",
      rough: rough.trim(),
      answers: answers.map((a) => ({ question: a.question, answer: a.label })),
    });
    if (data && typeof data.prompt === "string" && data.prompt.trim()) {
      setPhase({ name: "result", answers, prompt: data.prompt });
      return;
    }
    finishWithRuleBased(category, answers);
  };

  const answer = (optionIndex: 0 | 1) => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    const opt = q.options[optionIndex];
    const answers: UiAnswer[] = [
      ...phase.answers,
      {
        slot: q.slot,
        question: q.question,
        label: opt.label,
        instruction: opt.instruction ?? opt.label,
      },
    ];
    if (phase.index + 1 >= phase.questions.length) {
      void finish(phase.source, phase.category, answers);
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
          <span key={`${q.question}-${i}`} className={i < phase.index ? "op-dot done" : i === phase.index ? "op-dot current" : "op-dot"} />
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
          maxLength={MAX_ROUGH_LENGTH}
          autoFocus
        />
        <div className="op-actions">
          <button type="button" className="op-primary" onClick={() => void start()} disabled={!canStart}>
            質問に答える
          </button>
        </div>
      </div>
    );
  }

  if (phase.name === "loading-questions" || phase.name === "loading-result") {
    return (
      <div className="op-panel" aria-live="polite">
        <div className="op-dots op-loading" aria-hidden="true">
          <span className="op-dot current" />
          <span className="op-dot current" />
          <span className="op-dot current" />
        </div>
        <p className="op-count">{phase.name === "loading-questions" ? "質問を考えています…" : "プロンプトを仕上げています…"}</p>
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
          {phase.answers.map((a, i) => (
            <li key={`${a.question}-${i}`}><span>{a.question}</span>{a.label}</li>
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
