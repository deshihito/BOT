// One Prompter の LLM 連携用 純粋ロジック（検証・メッセージ構築）。
// ネットワークや環境変数には触れない。サーバー側（one-prompter-server.ts）と
// テストの両方から使う。ルールベース版（one-prompter.ts）の代替ではなく、
// 実LLMが使えない場面ではそちらへフォールバックする設計。
//
// 生成の本筋は常に LLM。狙いは2つ: (1) 人間が漠然と書いた「やりたいこと」を細かく詰め直して
// 未指定の部分を残さないこと、(2) 完成プロンプトで生成される成果物から
// 「AIあるある」（定型表現・均一な構成・根拠のない誇張など）を極限まで消すこと。
// 合成は下書きをそのまま出さず、自己検証（条件の落とし・曖昧さ・AIあるある・矛盾・
// 形式違いの検査）を挟み、問題があれば1回だけ直してから出す。検証側の失敗では
// 下書きをそのまま返す（サーバー側 synthesizeWithLlm の契約）。

/** 「やりたいこと」入力の上限（コスト・悪用ガード）。クライアント側でも同じ値で制限する。 */
export const MAX_ROUGH_LENGTH = 500;

export const MIN_QUESTIONS = 3;
/** 質問数セレクタの選択肢と既定値（1ラウンド目の質問数）。 */
export const QUESTION_COUNT_OPTIONS = [3, 5, 8];
export const DEFAULT_QUESTION_COUNT = 5;
/** 1ラウンド目の質問数の絶対上限（count の最大値）。 */
export const MAX_LLM_QUESTIONS = 8;
/** 2ラウンド目（深掘り）の質問生成の上限。 */
export const MAX_FOLLOWUP_QUESTIONS = 3;
/** 合成に渡せる回答の総数上限（1ラウンド目＋深掘り）。 */
export const MAX_TOTAL_ANSWERS = MAX_LLM_QUESTIONS + MAX_FOLLOWUP_QUESTIONS;

/**
 * API の count フィールドを検証する。3/5/8 以外（未指定・不正値）は
 * 既定値に丸める（従来呼び出しは 5 として互換を保つ）。
 */
export function resolveQuestionCount(value: unknown): number {
  if (typeof value === "number" && QUESTION_COUNT_OPTIONS.includes(value)) return value;
  return DEFAULT_QUESTION_COUNT;
}

export type LlmQuestion = {
  question: string;
  options: [string, string];
};

export type LlmAnswer = {
  question: string;
  answer: string;
};

export type ChatMessage = { role: "system" | "user"; content: string };

const QUESTION_MAX_CHARS = 120;
const OPTION_MAX_CHARS = 60;
/**
 * 回答1件の上限。「どちらも」回答文（両選択肢を含む）と自由入力（最大200字）を
 * 受けられるよう、選択肢ラベルの上限（60字）より大きく取る。
 */
export const MAX_ANSWER_CHARS = 200;
export const MAX_PROMPT_CHARS = 6000;

export function validateRough(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const rough = value.trim();
  if (!rough || rough.length > MAX_ROUGH_LENGTH) return null;
  return rough;
}

export function validateAnswers(value: unknown): LlmAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOTAL_ANSWERS) return null;
  const answers: LlmAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const q = (item as { question?: unknown }).question;
    const a = (item as { answer?: unknown }).answer;
    if (typeof q !== "string" || typeof a !== "string") return null;
    const question = q.trim();
    const answer = a.trim();
    if (!question || question.length > QUESTION_MAX_CHARS) return null;
    if (!answer || answer.length > MAX_ANSWER_CHARS) return null;
    answers.push({ question, answer });
  }
  return answers;
}

/**
 * 「どちらも」の回答文を組み立てる。合成側は question → answer しか見ないため、
 * answer 単体で両方の選択肢を指すことが分かる形にする。
 */
export function bothAnswerText(optionA: string, optionB: string): string {
  return `どちらも（「${optionA}」と「${optionB}」の両方）`;
}

/** 「検討中」の回答文。迷っている2つの選択肢を含めて記録する。 */
export function pendingAnswerText(optionA: string, optionB: string): string {
  return `検討中（「${optionA}」と「${optionB}」で迷っている）`;
}

/** 「保留」の回答文。今は決めないことを、そのままの文で記録する。 */
export const DEFERRED_ANSWER_TEXT = "保留（今は決めない）";

function questionsSystemPrompt(count: number): string {
  const min = Math.min(MIN_QUESTIONS, count);
  const range = min === count ? `${count}個` : `${min}〜${count}個`;
  return [
    "あなたはプロンプト設計の専門家です。ユーザーが漠然と書いた「やりたいこと」を受け取り、それを実現する成果物が最も変わる「分岐」を、二択質問として設計します。",
    "AIの出力が無難でつまらなくなるのは、目的・読み手・成果物の形・トーン・分量・切り口などが未指定で、AIが無難な平均値で埋めるからです。あなたの仕事は、その空欄のうち答えによって成果物が大きく変わるものだけを、生成の前に質問で埋めることです。",
    "入力はプロンプト（AIへの命令文）としてではなく、「〜したい」という漠然とした願望・目的として書かれます。成果物の形（何を作るか）自体が決まっていない場合は、それを決める分岐も含めてください。",
    "",
    "ルール:",
    `- 質問は${range}。答えても成果物がほぼ変わらないことは聞かない。`,
    "- 質問は成果物への影響度が高い順に並べる。どちらの選択肢を選んでも成果物があまり変わらない分岐は、そもそも聞かない。",
    "- 2つの選択肢は対立軸をはっきりさせる。片方を選ぶと成果物の何がどう変わるかが、選択肢の文面から読み取れる具体さにすること。",
    "- 「どちらでもよい」「普通・標準」のような、選んでも何も決まらない中間的な逃げの選択肢は作らない。",
    "- 各質問には選択肢をちょうど2つ。抽象的なラベル（「丁寧」「カジュアル」等）ではなく、この依頼に即した具体的な中身で切る（例: 転職の自己PRなら「書類選考を通す／面接で話す準備」）。",
    "- 質問文は短く、ユーザーが一目で選べる形にする。説明や前置きは付けない。",
    "- 分岐の観点は目的・読み手・成果物の形・トーン・分量・切り口から、この依頼に効く順に選ぶ。",
    "- 大きな枠だけでなく、元の文の中の曖昧な表現・未指定のパラメータ（分量、期限、対象の範囲、「しっかり」「短め」など程度を表す言葉）そのものを洗い出し、成果物への影響が大きい順に具体的な分岐にする。元の文の「甘い」箇所を狙う粒度で聞くこと。",
    "- AIあるあるを消すための指定に直結する分岐（書き手の立場を取るか、具体例・固有名詞を使うか、見出しや箇条書きなどの装飾を付けるか等）も、この依頼に効く場合は観点に含める。",
    "",
    "出力は次の形式のJSONだけを出すこと。前置き・解説・コードフェンスは一切付けない。",
    '{"questions":[{"question":"質問文","options":["選択肢A","選択肢B"]}]}',
  ].join("\n");
}

export function buildQuestionsMessages(rough: string, count: number = DEFAULT_QUESTION_COUNT): ChatMessage[] {
  return [
    { role: "system", content: questionsSystemPrompt(count) },
    { role: "user", content: `ユーザーの「やりたいこと」は次の一文です。\n\n${rough}` },
  ];
}

/** リトライ用: 形式を守れなかった旨を添えて同じ依頼を組み直す。 */
export function buildQuestionsRetryMessages(rough: string, count: number = DEFAULT_QUESTION_COUNT): ChatMessage[] {
  const messages = buildQuestionsMessages(rough, count);
  messages.push({
    role: "user",
    content:
      "直前の出力は指定のJSON形式として読み取れませんでした。説明文やコードフェンスを一切付けず、指定形式のJSONだけを再出力してください。",
  });
  return messages;
}

const FOLLOWUP_QUESTIONS_SYSTEM_PROMPT = [
  "あなたはプロンプト設計の専門家です。ユーザーが書いた「やりたいこと」と、1ラウンド目の二択質問への回答を受け取り、「まだ決まっていない・曖昧なまま残っている箇所」だけを狙う追加の二択質問を設計します。",
  "目的は、漠然とした「やりたいこと」をさらに細かく詰め直すことです。1ラウンド目で決まったことと同趣旨の質問は出さないでください。「やりたいこと」に残る曖昧な表現・未指定のパラメータ（分量、期限、対象の範囲、程度を表す言葉など）を具体的に狙ってください。AIあるあるを消すための指定に直結する分岐（書き手の立場、具体例・固有名詞の使用、装飾の有無など）が未決定なら、それも対象です。",
  "",
  "ルール:",
  "- 質問は最大3個。追加で聞く価値のある曖昧な箇所が残っていなければ、空の配列を返すこと（それが正常な結果です）。",
  "- 1ラウンド目で「検討中」「保留」と答えた項目は、ユーザーが意図的に先送りしたものとして蒸し返さない（同趣旨の質問は出さない）。",
  "- 追加質問も成果物への影響度が高い順に並べる。どちらの選択肢を選んでも成果物があまり変わらない分岐は聞かない。",
  "- 2つの選択肢は対立軸をはっきりさせる。片方を選ぶと成果物の何がどう変わるかが、選択肢の文面から読み取れる具体さにすること。「どちらでもよい」のような中間的な逃げの選択肢は作らない。",
  "- 各質問には選択肢をちょうど2つ。抽象的なラベルではなく、この依頼に即した具体的な中身で切る。",
  "- 質問文は短く、ユーザーが一目で選べる形にする。説明や前置きは付けない。",
  "",
  "出力は次の形式のJSONだけを出すこと。前置き・解説・コードフェンスは一切付けない。",
  '{"questions":[{"question":"質問文","options":["選択肢A","選択肢B"]}]}',
].join("\n");

export function buildFollowupMessages(rough: string, answers: LlmAnswer[]): ChatMessage[] {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n");
  return [
    { role: "system", content: FOLLOWUP_QUESTIONS_SYSTEM_PROMPT },
    {
      role: "user",
      content: `やりたいこと:\n${rough}\n\n1ラウンド目の二択質問への回答:\n${lines}\n\nまだ決まっていない・曖昧なまま残っている箇所だけを狙って、追加の二択質問を作ってください。`,
    },
  ];
}

/** リトライ用: 形式を守れなかった旨を添えて深掘り質問を組み直す。 */
export function buildFollowupRetryMessages(rough: string, answers: LlmAnswer[]): ChatMessage[] {
  const messages = buildFollowupMessages(rough, answers);
  messages.push({
    role: "user",
    content:
      "直前の出力は指定のJSON形式として読み取れませんでした。説明文やコードフェンスを一切付けず、指定形式のJSONだけを再出力してください。追加質問が不要なら空の配列を返してください。",
  });
  return messages;
}

const SYNTHESIZE_SYSTEM_PROMPT = [
  "あなたはプロンプト設計の専門家です。ユーザーが書いた「やりたいこと」と、二択質問への回答をもとに、そのまま ChatGPT や Claude 等のAIに貼れば質の高い成果物が得られる「完成プロンプト」を1つ作成します。",
  "完成プロンプトの狙いは2つです。(1) 「やりたいこと」の曖昧な部分を残さず、成果物の条件を細かく詰め切ること。(2) そのプロンプトで生成される成果物から、「AIあるある」（AIっぽい定型表現・均一な構成・根拠のない誇張・どっちつかずの逃げ）を極限まで排除すること。",
  "用途に合わない定型そのものが新たなAIあるあるになるため、文言と構成の固定はしないこと。中身の要件はすべて満たした上で、形は依頼ごとに組み立てる。",
  "",
  "形は用途に合わせて毎回組み立てる（固定文・定型構成は使わない）:",
  "- 決まった見出しや書き出し、締めの形はない。依頼の種類と用途に合った形式で書くこと。文章作成なら文章向けの指示文として、コードなら仕様として読める形に、画像生成なら画像プロンプトとしてそのまま使える形に、企画・分析・相談ならその成果物に合った形にする。毎回同じ見出し・同じ書き出し・同じ締めにしない",
  "- 役割設定が必要な依頼では、その依頼専用の具体的な役割を書く。定型の役割文（「実務に精通した専門家です」等）は使わない。役割が成果物を左右しない依頼では、役割を無理に付けない",
  "- 「やりたいこと」は、完成プロンプトの依頼内容として正確に伝える（言い換えで意味を変えない）。独立したセクションとして置くか、指示文に組み込むかは、選んだ形式に合わせて決める",
  "- 次の「中身の要件」はすべて満たす。ただし、それらをどう並べ、どういう言葉で書くかは固定しない。要件を定型のブロックとして並べただけの文章にしない",
  "",
  "中身の要件:",
  "- 二択への回答はすべて、AIへの具体的な指示として反映する。回答の抽象的な言い換えで終わらせず、可能な限り具体的な数値・構成要素・手順の粒度まで落とす（例: 回答が「短めに」なら「本文は◯◯字程度、段落は◯つまで」のように、依頼内容に応じて数値や構成に変換する）",
  "- 成果物の形式・分量・構成要素・完成条件（何が揃えば完成か）を具体的に指定する。「適宜」「いい感じに」「〜など」のような曖昧な表現を完成プロンプト内に残さない",
  "- 完成プロンプト自体を冗長にしない。同じことを2回言わない。条件は短い文で言い切り、説明の繰り返しや前置きで膨らませない",
  "- 「やりたいこと」に残っている曖昧な表現は、そのまま転記しない。回答や文脈から決め切るか、前提として明示するか、差し替え項目（プレースホルダ）にするかのいずれかで必ず処理する",
  "- 未指定事項の扱いを線引きする: AIが裁量で決めてよい範囲と、勝手に決めず前提を明示しなければならない範囲を分けて書く",
  "- 回答が「どちらも（「A」と「B」の両方）」の形の項目は、両方の選択肢の条件を矛盾なく両立させる指示として反映する",
  "- 回答が「検討中（…）」の項目は、未決定であることを完成プロンプトの中で明示し、下流のAIに最も妥当な既定を1つ置かせ、その前提を成果物に明示させる指示にする（黙って無難な平均値で埋めさせない）",
  "- 回答が「保留（今は決めない）」の項目は、決め打ちせずプレースホルダ／差し替え可能な形で残し、下流のAIに勝手に決めさせない。差し替え項目の一覧にも載せる",
  "- 選択肢の文言そのままではない回答は、ユーザーが自由入力した明示指定として扱い、他の条件と矛盾する場合はそちらを優先して反映する",
  "- 「やりたいこと」にも回答にも無い事実（名前・日時・数字・固有名詞など）が必要な箇所は、本文中に【会社名】のようなプレースホルダで示し、実在の情報を勝手に作らない。使ったプレースホルダはすべて、ユーザーが差し替えるべき項目として完成プロンプトの末尾に一覧で示す（並べ方や見出しは全体の形に合わせる）。プレースホルダが1つも無い場合は、そのための一覧は作らない",
  "",
  "AIあるある対策は、固定文のブロックとしてではなく、用途に合わせて選んで書く:",
  "- 次の対策リストは素材である。すべてを固定文のブロックとして丸ごと写さない。成果物の種類に関係するものだけを選び、この依頼に合った具体的な言い方に置き換えて使う",
  "- 文体に関する対策（定型文・接続詞・文のリズム・要約の焼き直し等）は文章生成の依頼にだけ適用し、コード・画像・データなど文章以外の成果物には持ち込まない",
  "対策リスト（文章向け）:",
  "- 定型の前置き・締め文句（「いかがでしたか」「まとめると」「結論として」「〜と言えるでしょう」「お役に立てれば幸いです」「ぜひ〜してみてください」等）を使わない",
  "- 「まず〜、次に〜、最後に〜」式の機械的な列挙をしない。段落構成や文の長さ・リズムが均一になる書き方をしない",
  "- 「しかしながら」「さらに」「また」「そのため」などの接続詞を連発しない",
  "- 依頼に不要な見出し・箇条書き・絵文字などの装飾をしない",
  "- 「革新的」「画期的」「寄り添う」「伴走」「深掘り」「解像度を上げる」「刺さる」など具体に落とせないバズワードや、根拠のない誇張表現を使わない。具体的な事実で示す",
  "- 「魅力」「価値」「可能性」「重要性」などの抽象語を、具体的な事実・数字・固有名詞なしに使わない",
  "- 両論併記で結論を逃げない。過剰なへりくだり・謝罪・言い訳の前置きをしない",
  "- 同じ内容の言い換え反復で分量を稼がない。締めで内容を焼き直した要約をしない",
  "どの用途にも効く対策（書き方の指定として含める。言い方は用途に合わせる）:",
  "- 書き手の立場・判断を1つに決めて書き切る",
  "- 具体名詞と検証可能な事実で書き、出来上がりの形には自然なばらつきを持たせる",
  "- 全部を均等に扱わず、重要なものに分量と順序で優先順位を付ける（人間が実際に作るときの非対称さを許す）",
  "- 情報が足りない部分を無難な一般論で埋めない。前提が必要なら、最も妥当な前提を1つ置いて明示する",
  "- 情報不足を理由に確認や質問で止めず、成果物を出力する",
  "用途別の翻訳の指針（この精神を、その用途の言葉で書く。関係しない用途の文言をそのまま入れない）:",
  "- コード生成: 未実装のまま TODO や省略記法で済ませず、指定された範囲を完成させる。ありがちな汎用サンプルに逃げず、この依頼の入力・出力・制約に沿った実装にする",
  "- 画像生成: 「高品質」「美しい」等の雰囲気語の羅列で済ませず、被写体・構図・光・質感・色を具体的に指定する。ありがちな量産構図に寄せない",
  "- 企画・分析・相談: どこにでも当てはまる一般論の列挙で済ませず、この依頼の前提に即した判断と具体策まで踏み込む",
  "",
  "出力は完成プロンプトの本文だけ。前置き・解説・コードフェンスは付けない。",
].join("\n");

export function buildSynthesizeMessages(rough: string, answers: LlmAnswer[]): ChatMessage[] {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n");
  return [
    { role: "system", content: SYNTHESIZE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `やりたいこと:\n${rough}\n\n二択質問への回答:\n${lines}`,
    },
  ];
}

const VERIFY_SYSTEM_PROMPT = [
  "あなたはプロンプトの検査担当です。「やりたいこと」と二択質問への回答から作られた完成プロンプトの下書きを読み、出す前に直すべき問題だけを指摘します。",
  "",
  "検査の観点:",
  "(a) 回答で決まった条件が、下書きに落ちていないか、別の内容に改変されていないか",
  "(b) 「適宜」「いい感じに」「〜など」等の曖昧な表現や、未処理のまま残った曖昧な箇所がないか",
  "(c) プロンプト自体にAIあるある（定型の前置き・締め、根拠のない誇張、具体に落ちない抽象語・バズワード、均一な構成）が混ざっていないか",
  "(d) 条件同士が矛盾していないか",
  "(e) 依頼の用途に合わない形式（文章向けの文体指定がコード向けに混ざる等）になっていないか",
  "",
  "ルール:",
  "- 問題は、どこをどう直すべきかが分かる具体さで、1件ごとに短く書く。問題が無ければ空の配列を返す。",
  "- 好みの範囲の言い換えや、要件を満たしている部分への感想は問題に含めない。実害のある問題だけを挙げる。",
  "- 回答にも要件にも無い新しい条件を要求しない。検査は「決まったことと要件が守られているか」の確認に限る。",
  "",
  "出力は次の形式のJSONだけを出すこと。前置き・解説・コードフェンスは一切付けない。",
  '{"issues":["問題1","問題2"]}',
].join("\n");

/** 合成後の自己検証用メッセージ。下書きを観点 (a)〜(e) で検査させる。 */
export function buildVerifyMessages(rough: string, answers: LlmAnswer[], draft: string): ChatMessage[] {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n");
  return [
    { role: "system", content: VERIFY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `やりたいこと:\n${rough}\n\n二択質問への回答:\n${lines}\n\n完成プロンプトの下書き:\n${draft}`,
    },
  ];
}

/** 検証で受け付ける問題の件数上限（これを超える分は切り捨てる）。 */
export const MAX_VERIFY_ISSUES = 10;
/** 問題1件の文字数上限（これを超える項目は読み飛ばす）。 */
const MAX_VERIFY_ISSUE_CHARS = 200;

/**
 * 検証応答（問題リストのJSON）を取り出して検証する。
 * JSON自体が読めない・issues が配列でない場合は null（検証の失敗として扱う）。
 * 項目単位の崩れ（空・長すぎ）は読み飛ばし、件数は上限で切り詰める。
 * 問題なし（空配列）は正常系としてそのまま返す。
 */
export function parseVerificationJson(text: string): string[] | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  // コードフェンスで包まれていたら剥がす
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  // 前後に文が混ざっていたら最初の { から最後の } までを取る
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rawIssues = (data as { issues?: unknown }).issues;
  if (!Array.isArray(rawIssues)) return null;
  const issues: string[] = [];
  for (const raw of rawIssues) {
    if (typeof raw !== "string") continue;
    const issue = raw.trim();
    if (!issue || issue.length > MAX_VERIFY_ISSUE_CHARS) continue;
    issues.push(issue);
    if (issues.length >= MAX_VERIFY_ISSUES) break;
  }
  return issues;
}

const REFINE_SYSTEM_PROMPT = [
  "あなたはプロンプト設計の専門家です。完成プロンプトの下書きと、その検査で見つかった問題リストを受け取り、問題だけを直した完成プロンプトの全文を作成します。",
  "",
  "ルール:",
  "- 指摘された問題はすべて直す。それ以外の部分は、意味・条件・強さを変えずにそのまま活かす。",
  "- 回答で決まった条件を落としたり、別の内容に改変したりしない。検査で指摘されていない新しい条件を足さない。",
  "- AIあるある対策の中身（定型表現・誇張・抽象語の排除など）は弱めない・落とさない。下書きの形式と、依頼の用途に合った形を保ち、定型の見出し構成や定型の冒頭文に戻さない。",
  "- プレースホルダと差し替え項目の形は保つ。新しい事実（実績、数字、固有名詞など）を勝手に作らない。",
  "- 完成プロンプト自体を冗長にしない。同じことを2回言わない。",
  "",
  "出力は直した完成プロンプトの本文だけ。前置き・解説・コードフェンスは付けない。",
].join("\n");

/** 自己検証で見つかった問題を直すためのメッセージ。下書きの全文を書き直させる。 */
export function buildRefineMessages(rough: string, answers: LlmAnswer[], draft: string, issues: string[]): ChatMessage[] {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n");
  const issueLines = issues.map((issue) => `- ${issue}`).join("\n");
  return [
    { role: "system", content: REFINE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `やりたいこと:\n${rough}\n\n二択質問への回答:\n${lines}\n\n完成プロンプトの下書き:\n${draft}\n\n検査で見つかった問題:\n${issueLines}`,
    },
  ];
}

/** AIで直す（revise）の修正指示の上限。クライアント側でも同じ値で制限する。 */
export const MAX_REVISE_INSTRUCTION_CHARS = 200;

/** revise に渡す現在のプロンプト本文を検証する（合成結果と同じ上限）。 */
export function validatePromptInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return null;
  return prompt;
}

/** revise の修正指示を検証する。 */
export function validateReviseInstruction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const instruction = value.trim();
  if (!instruction || instruction.length > MAX_REVISE_INSTRUCTION_CHARS) return null;
  return instruction;
}

const REVISE_SYSTEM_PROMPT = [
  "あなたはプロンプト編集の専門家です。ユーザーが使う「完成プロンプト」を、修正指示どおりに書き直します。",
  "",
  "ルール:",
  "- 既存の条件・対策（AIあるあるの排除と、詰めの指定）は、その中身（意図）を弱めない・落とさない。文言や並びを整えるのはよいが、対策そのものを削除・無効化しない。修正指示と既存の対策が矛盾する場合は、対策側を優先する。",
  "- 書き直しの結果を、定型の見出し構成や定型の冒頭文に寄せない。現在のプロンプトの形式と、依頼の用途に合った形を保つ（修正指示で形式の変更を求められた場合を除く）。",
  "- 修正指示に無い部分は、意味を変えずにそのまま残す。元の「やりたいこと」の趣旨は変えない。",
  "- 新しい事実（実績、数字、固有名詞など）を勝手に作らない。必要な場合はプレースホルダと差し替え項目の形を保つ。",
  "",
  "出力は書き直した完成プロンプトの本文だけ。前置き・解説・コードフェンスは付けない。",
].join("\n");

export function buildReviseMessages(prompt: string, instruction: string): ChatMessage[] {
  return [
    { role: "system", content: REVISE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `現在のプロンプト:\n${prompt}\n\n修正指示:\n${instruction}`,
    },
  ];
}

/** LLM応答から質問JSONの配列部分を取り出す。JSONとして読めなければ null。 */
function extractQuestionsArray(text: string): unknown[] | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  // コードフェンスで包まれていたら剥がす
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  // 前後に文が混ざっていたら最初の { から最後の } までを取る
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rawQuestions = (data as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return null;
  return rawQuestions;
}

/** 質問1件分の形を検証する。崩れていたら null。 */
function toLlmQuestion(raw: unknown): LlmQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = (raw as { question?: unknown }).question;
  const opts = (raw as { options?: unknown }).options;
  if (typeof q !== "string") return null;
  const question = q.trim();
  if (!question || question.length > QUESTION_MAX_CHARS) return null;
  if (!Array.isArray(opts) || opts.length !== 2) return null;
  const options = opts.map((o) => (typeof o === "string" ? o.trim() : ""));
  if (options.some((o) => !o || o.length > OPTION_MAX_CHARS)) return null;
  if (options[0] === options[1]) return null;
  return { question, options: [options[0], options[1]] };
}

/**
 * LLM応答から質問JSONを取り出して検証する。形式が崩れていたら null。
 * 件数の範囲は count に追随する（上限 = count、下限 = min(3, count)）。
 * count 未指定は既定値として従来どおり 3〜5問。
 */
export function parseQuestionsJson(text: string, count: number = DEFAULT_QUESTION_COUNT): LlmQuestion[] | null {
  const rawQuestions = extractQuestionsArray(text);
  if (!rawQuestions) return null;
  if (rawQuestions.length < Math.min(MIN_QUESTIONS, count) || rawQuestions.length > count) return null;
  const questions: LlmQuestion[] = [];
  for (const raw of rawQuestions) {
    const question = toLlmQuestion(raw);
    if (!question) return null;
    questions.push(question);
  }
  return questions;
}

/** 質問文の重複判定用に、末尾の句読点・疑問符を取り除いて正規化する。 */
function normalizeQuestionText(text: string): string {
  return text.trim().replace(/[？?。]+$/, "");
}

/**
 * 深掘り（2ラウンド目）応答の検証。1ラウンド目より緩い:
 * 0件（深掘りなし）も正常系で、形の崩れた項目と既出質問の重複は除外し、
 * 残りを最大 MAX_FOLLOWUP_QUESTIONS 件まで採用する。
 * JSON自体が読めない場合だけ null（呼び出し側のリトライ判定用）。
 */
export function parseFollowupQuestionsJson(text: string, askedQuestions: string[]): LlmQuestion[] | null {
  const rawQuestions = extractQuestionsArray(text);
  if (!rawQuestions) return null;
  const seen = new Set(askedQuestions.map(normalizeQuestionText));
  const questions: LlmQuestion[] = [];
  for (const raw of rawQuestions) {
    const question = toLlmQuestion(raw);
    if (!question) continue;
    const key = normalizeQuestionText(question.question);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length >= MAX_FOLLOWUP_QUESTIONS) break;
  }
  return questions;
}

/** 合成結果を整える。フェンスや前後の空白を取り除き、長さの範囲外なら null。 */
export function cleanSynthesizedPrompt(text: string): string | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  const fence = body.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  if (!body || body.length > MAX_PROMPT_CHARS) return null;
  return body;
}
