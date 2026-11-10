"use client";

// One Prompter の操作UI（クライアント）。
// 雑な一文 → 二択質問（1問ずつ） →（LLM 経路のみ）深掘り質問 → 完成プロンプト表示。
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
import {
  bothAnswerText,
  DEFERRED_ANSWER_TEXT,
  DEFAULT_QUESTION_COUNT,
  MAX_ANSWER_CHARS,
  MAX_REVISE_INSTRUCTION_CHARS,
  MAX_ROUGH_LENGTH,
  pendingAnswerText,
  type LlmQuestion,
} from "../../lib/one-prompter-llm";

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
  | {
      name: "questions";
      source: Source;
      category: PrompterCategory;
      /** 1 = 通常の質問、2 = 深掘り（LLM 経路のみ・最大3問） */
      round: 1 | 2;
      questions: UiQuestion[];
      index: number;
      answers: UiAnswer[];
    }
  | { name: "loading-followups"; answers: UiAnswer[] }
  | { name: "loading-result"; answers: UiAnswer[] }
  | { name: "result"; answers: UiAnswer[]; prompt: string; originalPrompt: string };

function isLlmQuestionItem(q: unknown): q is LlmQuestion {
  return Boolean(
    q &&
      typeof q === "object" &&
      typeof (q as LlmQuestion).question === "string" &&
      Array.isArray((q as LlmQuestion).options) &&
      (q as LlmQuestion).options.length === 2 &&
      (q as LlmQuestion).options.every((o) => typeof o === "string" && o.length > 0),
  );
}

/** 1ラウンド目の応答検証。件数の範囲は選択した質問数 count に追随する。 */
function isLlmQuestions(value: unknown, count: number): value is LlmQuestion[] {
  if (!Array.isArray(value) || value.length < Math.min(3, count) || value.length > count) return false;
  return value.every(isLlmQuestionItem);
}

/** 深掘り（2ラウンド目）の応答検証。1〜3問のときだけ true（0問は呼び出し側で分岐する）。 */
function isFollowupQuestions(value: unknown): value is LlmQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
  return value.every(isLlmQuestionItem);
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
  /** 1ラウンド目の質問数（3/5/8）。深掘りは別枠で最大3問。 */
  const [questionCount, setQuestionCount] = useState(DEFAULT_QUESTION_COUNT);
  /** 自由入力の展開状態と下書き（質問が切り替わるたびにリセットする）。 */
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeDraft, setFreeDraft] = useState("");
  /** 結果画面の「AIで直す」用。 */
  const [reviseDraft, setReviseDraft] = useState("");
  const [revising, setRevising] = useState(false);
  const [reviseNote, setReviseNote] = useState("");

  const canStart = rough.trim().length > 0;

  const resetFree = () => {
    setFreeOpen(false);
    setFreeDraft("");
  };

  const startWithRuleBased = () => {
    const { category, questions } = generateQuestions(rough, questionCount);
    setPhase({
      name: "questions",
      source: "rule",
      category,
      round: 1,
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
    resetFree();
    setReviseNote("");
    setPhase({ name: "loading-questions" });
    const data = await postOnePrompter({ action: "questions", rough: rough.trim(), count: questionCount });
    if (data && isLlmQuestions(data.questions, questionCount)) {
      setPhase({
        name: "questions",
        source: "llm",
        category: "generic",
        round: 1,
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
    const prompt = buildPrompt(rough, category, promptAnswers);
    setPhase({ name: "result", answers, prompt, originalPrompt: prompt });
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
      setPhase({ name: "result", answers, prompt: data.prompt, originalPrompt: data.prompt });
      return;
    }
    finishWithRuleBased(category, answers);
  };

  /**
   * 1ラウンド目が終わったら、合成の前に深掘り（2ラウンド目）を取りに行く。
   * 深掘りが0問・fallback・応答不正のときは、そのまま合成へ進む。
   */
  const proceedAfterRound1 = async (answers: UiAnswer[]) => {
    setPhase({ name: "loading-followups", answers });
    const data = await postOnePrompter({
      action: "questions",
      rough: rough.trim(),
      answers: answers.map((a) => ({ question: a.question, answer: a.label })),
    });
    if (data && Array.isArray(data.questions) && data.questions.length > 0 && isFollowupQuestions(data.questions)) {
      setPhase({
        name: "questions",
        source: "llm",
        category: "generic",
        round: 2,
        questions: data.questions.map((q) => ({
          question: q.question,
          options: [{ label: q.options[0] }, { label: q.options[1] }] as [UiOption, UiOption],
        })),
        index: 0,
        answers,
      });
      return;
    }
    void finish("llm", "generic", answers);
  };

  /** 回答を1件記録して次へ進む（2択・補助選択肢の共通処理）。 */
  const submitAnswer = (uiAnswer: UiAnswer) => {
    if (phase.name !== "questions") return;
    const answers: UiAnswer[] = [...phase.answers, uiAnswer];
    resetFree();
    if (phase.index + 1 >= phase.questions.length) {
      if (phase.source === "llm" && phase.round === 1) {
        void proceedAfterRound1(answers);
      } else {
        void finish(phase.source, phase.category, answers);
      }
    } else {
      setPhase({ ...phase, index: phase.index + 1, answers });
    }
  };

  const answer = (optionIndex: 0 | 1) => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    const opt = q.options[optionIndex];
    submitAnswer({
      slot: q.slot,
      question: q.question,
      label: opt.label,
      instruction: opt.instruction ?? opt.label,
    });
  };

  /** 「どちらも」: LLM 経路では両選択肢を含む回答文、ルール経路では両 instruction を含める。 */
  const answerBoth = () => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    const [a, b] = q.options;
    if (phase.source === "llm") {
      const text = bothAnswerText(a.label, b.label);
      submitAnswer({ slot: q.slot, question: q.question, label: text, instruction: text });
    } else {
      submitAnswer({
        slot: q.slot,
        question: q.question,
        label: "どちらも",
        instruction: `${a.instruction ?? a.label}\n- ${b.instruction ?? b.label}`,
      });
    }
  };

  /** 「検討中」: 迷っている2択を含めて記録する。合成側では既定＋前提明示に倒す。 */
  const answerPending = () => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    const [a, b] = q.options;
    if (phase.source === "llm") {
      const text = pendingAnswerText(a.label, b.label);
      submitAnswer({ slot: q.slot, question: q.question, label: text, instruction: text });
    } else {
      submitAnswer({
        slot: q.slot,
        question: q.question,
        label: "検討中",
        instruction: `（${q.question}）は検討中。最も妥当な既定を1つ置き、その前提を明示すること`,
      });
    }
  };

  /** 「保留」: 決めないまま進める。合成側ではプレースホルダとして残す。 */
  const answerDeferred = () => {
    if (phase.name !== "questions") return;
    const q = phase.questions[phase.index];
    if (phase.source === "llm") {
      submitAnswer({ slot: q.slot, question: q.question, label: DEFERRED_ANSWER_TEXT, instruction: DEFERRED_ANSWER_TEXT });
    } else {
      submitAnswer({
        slot: q.slot,
        question: q.question,
        label: "保留",
        instruction: `（${q.question}）は保留。決め打ちせず、差し替え可能な形で残すこと`,
      });
    }
  };

  /** 自由入力: 入力文そのものを回答にする（上限はサーバー検証と同じ200字）。 */
  const submitFree = () => {
    if (phase.name !== "questions") return;
    const text = freeDraft.trim();
    if (!text) return;
    const q = phase.questions[phase.index];
    submitAnswer({
      slot: q.slot,
      question: q.question,
      label: text,
      instruction: `ユーザーの指定: ${text}`,
    });
  };

  /** 深掘りを打ち切って、ここまでの回答で合成する。 */
  const skipFollowups = () => {
    if (phase.name !== "questions" || phase.round !== 2) return;
    resetFree();
    void finish(phase.source, phase.category, phase.answers);
  };

  const back = () => {
    if (phase.name !== "questions" || phase.index === 0) return;
    resetFree();
    setPhase({ ...phase, index: phase.index - 1, answers: phase.answers.slice(0, -1) });
  };

  const restart = () => {
    setPhase({ name: "input" });
    setCopied(false);
    resetFree();
    setReviseDraft("");
    setReviseNote("");
  };

  /** 結果の直接編集。コピーはこの編集後の内容を使う。 */
  const editPrompt = (value: string) => {
    if (phase.name !== "result") return;
    setPhase({ ...phase, prompt: value });
    setCopied(false);
  };

  /** 生成直後の内容に戻す。 */
  const resetPrompt = () => {
    if (phase.name !== "result") return;
    setPhase({ ...phase, prompt: phase.originalPrompt });
    setCopied(false);
    setReviseNote("");
  };

  /** 「AIで直す」: 現在のテキストエリア内容を prompt として送る。使えない環境では手編集に委ねる。 */
  const revise = async () => {
    if (phase.name !== "result" || revising) return;
    const instruction = reviseDraft.trim();
    if (!instruction || !phase.prompt.trim()) return;
    setRevising(true);
    setReviseNote("");
    const data = await postOnePrompter({ action: "revise", prompt: phase.prompt, instruction });
    setRevising(false);
    if (data && typeof data.prompt === "string" && data.prompt.trim()) {
      setPhase({ ...phase, prompt: data.prompt });
      setReviseDraft("");
      setCopied(false);
      return;
    }
    setReviseNote("AIでの修正は今使えません。そのまま手で編集できます。");
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
        <div className="op-countrow">
          <span className="op-countlabel">質問の数</span>
          {[3, 5, 8].map((n) => (
            <button
              key={n}
              type="button"
              className={n === questionCount ? "op-suboption selected" : "op-suboption"}
              onClick={() => setQuestionCount(n)}
            >
              {n}問
            </button>
          ))}
        </div>
        <div className="op-actions">
          <button type="button" className="op-primary" onClick={() => void start()} disabled={!canStart}>
            質問に答える
          </button>
        </div>
      </div>
    );
  }

  if (phase.name === "loading-questions" || phase.name === "loading-followups" || phase.name === "loading-result") {
    return (
      <div className="op-panel" aria-live="polite">
        <div className="op-dots op-loading" aria-hidden="true">
          <span className="op-dot current" />
          <span className="op-dot current" />
          <span className="op-dot current" />
        </div>
        <p className="op-count">{phase.name === "loading-result" ? "プロンプトを仕上げています…" : "質問を考えています…"}</p>
      </div>
    );
  }

  if (phase.name === "questions") {
    const q = phase.questions[phase.index];
    return (
      <div className="op-panel">
        {dots}
        <p className="op-count">
          {phase.round === 2 ? "深掘り " : ""}{phase.index + 1} / {phase.questions.length}
        </p>
        <h2 className="op-question">{q.question}</h2>
        <div className="op-options">
          {q.options.map((opt, i) => (
            <button key={opt.label} type="button" className="op-option" onClick={() => answer(i as 0 | 1)}>
              {opt.label}
            </button>
          ))}
        </div>
        <div className="op-suboptions">
          <button type="button" className="op-suboption" onClick={answerBoth}>どちらも</button>
          <button type="button" className="op-suboption" onClick={() => setFreeOpen((v) => !v)}>自分で入力する</button>
          <button type="button" className="op-suboption" onClick={answerPending}>検討中</button>
          <button type="button" className="op-suboption" onClick={answerDeferred}>保留</button>
        </div>
        {freeOpen && (
          <div className="op-freeform">
            <textarea
              value={freeDraft}
              onChange={(e) => setFreeDraft(e.target.value)}
              placeholder="自分の指定を入力（200字まで）"
              rows={2}
              maxLength={MAX_ANSWER_CHARS}
              autoFocus
            />
            <button type="button" className="op-primary op-small" onClick={submitFree} disabled={!freeDraft.trim()}>
              この内容で決定
            </button>
          </div>
        )}
        {phase.index > 0 && (
          <button type="button" className="op-back" onClick={back}>← もどる</button>
        )}
        {phase.round === 2 && (
          <button type="button" className="op-back" onClick={skipFollowups}>このまま合成する</button>
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
      <textarea
        className="op-edit"
        value={phase.prompt}
        onChange={(e) => editPrompt(e.target.value)}
        rows={14}
        aria-label="完成プロンプト（編集できます）"
      />
      <p className="op-count">
        {phase.prompt.length} 字
        {phase.prompt !== phase.originalPrompt && (
          <button type="button" className="op-back" onClick={resetPrompt}>生成直後の内容に戻す</button>
        )}
      </p>
      <div className="op-freeform">
        <label className="op-label" htmlFor="op-revise-input">AIで直す</label>
        <textarea
          id="op-revise-input"
          value={reviseDraft}
          onChange={(e) => setReviseDraft(e.target.value)}
          placeholder="直したいところ（例：もっと短く、敬語を強めに）"
          rows={2}
          maxLength={MAX_REVISE_INSTRUCTION_CHARS}
        />
        <button
          type="button"
          className="op-primary op-small"
          onClick={() => void revise()}
          disabled={revising || !reviseDraft.trim() || !phase.prompt.trim()}
        >
          {revising ? "直しています…" : "AIで直す"}
        </button>
        {reviseNote && <p className="quiet-note">{reviseNote}</p>}
      </div>
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
