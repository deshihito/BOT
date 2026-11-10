// One Prompter の中核ロジック（クライアント専用の純粋関数）。
// 雑な一文をカテゴリ判定し、出力が一番変わる分岐だけを二択質問として組み立て、
// 回答から構造化されたプロンプトを合成する。外部APIは使わない。
// AIスロップは「未指定の部分をAIが無難な平均値で埋める」ことで起きるため、
// 質問は目的・読み手・形式・トーン・分量の空欄を生成前に埋めるためにある。

export type PrompterCategory =
| "sns"
| "blog"
| "job"
| "business"
| "code"
| "image"
| "study"
| "generic";

export type QuestionSlot = "purpose" | "audience" | "format" | "tone" | "length" | "angle";

export type BinaryOption = {
label: string;
/** 完成プロンプトに差し込まれる具体的な指示文 */
instruction: string;
};

export type BinaryQuestion = {
slot: QuestionSlot;
question: string;
options: [BinaryOption, BinaryOption];
};

export type PrompterAnswer = {
slot: QuestionSlot;
question: string;
label: string;
instruction: string;
};

const CATEGORY_KEYWORDS: { category: PrompterCategory; keywords: string[]}[] = [
{ category: "sns", keywords: ["インスタ", "instagram", "sns", "ツイート", "ポスト", "投稿", "tiktok", "youtube", "動画の台本", "ショート動画"]},
{ category: "job", keywords: ["転職", "就活", "自己pr", "志望動機", "面接", "履歴書", "職務経歴", "エントリーシート"]},
{ category: "code", keywords: ["コード", "プログラム", "アプリ", "サイトを作", "webサイト", "エラー", "バグ", "関数", "python", "javascript", "typescript", "sql", "実装"]},
{ category: "image", keywords: ["画像", "イラスト", "写真", "アイコン", "ロゴ", "バナー", "壁紙", "絵を描", "サムネイル"]},
{ category: "business", keywords: ["メール", "ビジネス", "提案", "報告書", "企画書", "謝罪", "お詫び", "依頼文", "議事録", "プレゼン"]},
{ category: "study", keywords: ["説明", "教えて", "とは", "仕組み", "勉強", "学習", "要約", "まとめ", "解説"]},
{ category: "blog", keywords: ["ブログ", "記事", "文章", "コラム", "note", "執筆", "原稿", "文章を書"]},
];

export function categorizeInput(input: string): PrompterCategory {
const text = input.toLowerCase();
let best: PrompterCategory = "generic";
let bestScore = 0;
for (const { category, keywords} of CATEGORY_KEYWORDS) {
const score = keywords.reduce((acc, kw) => acc + (text.includes(kw)? 1: 0), 0);
if (score > bestScore) {
best = category;
bestScore = score;
}
}
return best;
}

const UNIVERSAL_QUESTIONS: BinaryQuestion[] = [
{
slot: "purpose",
question: "欲しいのはどっち？",
options: [
{ label: "完成形そのもの", instruction: "成果物としてそのまま使える完成形を出力すること。中間の説明や過程は不要。"},
{ label: "アイデア・選択肢", instruction: "完成形ではなく、方向性の違う案を複数出し、それぞれの違いが分かるようにすること。"},
],
},
{
slot: "audience",
question: "誰が読む・見る？",
options: [
{ label: "自分用メモ", instruction: "読み手は依頼者本人。前提知識の説明は省き、実用性だけを優先すること。"},
{ label: "他人に見せる", instruction: "読み手は第三者。初めて読む人にも伝わるよう、前提を補って書くこと。"},
],
},
{
slot: "format",
question: "出力の形は？",
options: [
{ label: "文章で流れる形", instruction: "出力は自然な文章で。見出しや箇条書きは最小限にすること。"},
{ label: "箇条書きで整理", instruction: "出力は項目ごとの箇条書きで整理し、一目で比較・選択できる形にすること。"},
],
},
{
slot: "tone",
question: "トーンは？",
options: [
{ label: "丁寧・きちんと", instruction: "丁寧で落ち着いた文体にすること。砕けた表現や絵文字は使わない。"},
{ label: "フランク・親しみやすく", instruction: "親しみやすい口調にすること。堅い言い回しは避け、話し言葉に寄せる。"},
],
},
{
slot: "length",
question: "分量は？",
options: [
{ label: "短く締める", instruction: "分量は短く。要点だけに絞り、冗長な前置きや繰り返しを入れないこと。"},
{ label: "しっかり詳しく", instruction: "分量は十分に取り、具体例や理由まで含めて詳しく書くこと。ただし水増しの一般論は入れない。"},
],
},
];

const CATEGORY_QUESTIONS: Record<Exclude<PrompterCategory, "generic">, BinaryQuestion[]> = {
sns: [
{
slot: "purpose",
question: "投稿の狙いは？",
options: [
{ label: "来店・購入につなげる", instruction: "目的は読み手の来店・購入などの行動につなげること。具体的な行動（予約、購入、来店）を最後に明示すること。"},
{ label: "共感・ファンを増やす", instruction: "目的は共感とファン化。売り込みはせず、読み手が『自分のことだ』と感じる具体的な場面から入ること。"},
],
},
{
slot: "format",
question: "ハッシュタグは？",
options: [
{ label: "付ける（5個まで）", instruction: "本文の後にハッシュタグを最大5個付けること。一般的すぎるタグではなく内容に固有のタグを選ぶ。"},
{ label: "付けない", instruction: "ハッシュタグは付けず、投稿文だけで完結させること。"},
],
},
{
slot: "tone",
question: "口調は？",
options: [
{ label: "タメ口寄りで近い距離", instruction: "友人に話すような近い口調にすること。宣伝文句らしい言い回しは使わない。"},
{ label: "丁寧で上品", instruction: "丁寧で上品な口調にすること。感嘆符の多用や過剰な絵文字は避ける。"},
],
},
{
slot: "length",
question: "長さは？",
options: [
{ label: "100字以内で一撃", instruction: "本文は100字以内。最初の1文で読み手をつかむこと。"},
{ label: "200字前後で伝える", instruction: "本文は200字前後。具体的な情報（日時、価格、場所など分かっている範囲）を盛り込むこと。"},
],
},
],
blog: [
{
slot: "format",
question: "欲しいのは？",
options: [
{ label: "記事本文そのもの", instruction: "記事本文を完成形で出力すること。構成案やメタな説明は不要。"},
{ label: "構成案＋見出し", instruction: "本文ではなく、見出し構成と各見出しで書く内容の要点を出力すること。"},
],
},
{
slot: "audience",
question: "読み手は？",
options: [
{ label: "その分野の初心者", instruction: "読み手は初心者。専門用語は使うたびに短く言い換え、具体例を先に置くこと。"},
{ label: "経験者・同業者", instruction: "読み手は経験者。入門的な説明は省き、実務で差がつく具体論に踏み込むこと。"},
],
},
{
slot: "angle",
question: "切り口は？",
options: [
{ label: "体験・実例ベース", instruction: "一般論ではなく、具体的な体験・事例・数字を軸に書くこと。体験談として書けない部分は『一般的には』とごまかさず、事実ベースで書く。"},
{ label: "ノウハウ・手順ベース", instruction: "読み手がそのまま再現できる手順・ノウハウとして書くこと。手順は順番通りに、飛ばさず書く。"},
],
},
{
slot: "tone",
question: "文体は？",
options: [
{ label: "です・ますで整える", instruction: "文体は『です・ます』調で統一すること。"},
{ label: "だ・であるで言い切る", instruction: "文体は『だ・である』調で統一し、短い文で言い切ること。"},
],
},
],
job: [
{
slot: "purpose",
question: "使い道は？",
options: [
{ label: "書類選考を通す", instruction: "目的は書類選考の通過。採用担当が数十秒で読む前提で、強みと実績を最初に置くこと。"},
{ label: "面接で話す準備", instruction: "目的は面接対策。想定質問と、それへの回答の骨子をセットで出すこと。"},
],
},
{
slot: "angle",
question: "押すのはどっち？",
options: [
{ label: "実績・数字", instruction: "強みは実績と数字で示すこと。『頑張りました』『成長しました』等の定型表現でごまかさない。数字が無い部分は規模や頻度など測れる形で書く。"},
{ label: "人柄・姿勢", instruction: "強みは人柄と仕事への姿勢で示すこと。抽象的な美点の列挙ではなく、それが伝わる具体的な行動エピソードで書く。"},
],
},
{
slot: "tone",
question: "トーンは？",
options: [
{ label: "自信強め", instruction: "自信のある言い切りで書くこと。『と思います』『させていただきます』の多用で弱めない。"},
{ label: "誠実・控えめ", instruction: "誠実で控えめなトーンにすること。誇張や盛った表現は使わない。"},
],
},
{
slot: "length",
question: "分量は？",
options: [
{ label: "200字で締める", instruction: "全体で200字以内に収めること。"},
{ label: "400字でしっかり", instruction: "全体で400字程度。エピソードを1つ具体的に含めること。"},
],
},
],
business: [
{
slot: "audience",
question: "相手は？",
options: [
{ label: "社外・取引先", instruction: "宛先は社外。ビジネス敬語を正確に使い、失礼のない定型を押さえた上で要件を明確にすること。"},
{ label: "社内", instruction: "宛先は社内。過度な敬語は省き、要件と期限を明確に、簡潔に書くこと。"},
],
},
{
slot: "format",
question: "形は？",
options: [
{ label: "そのまま送れる文面", instruction: "件名・宛名・署名の位置まで含め、そのまま送れる完成文面で出力すること。"},
{ label: "要点の箇条書き", instruction: "文面ではなく、伝えるべき要点を箇条書きで整理して出力すること。"},
],
},
{
slot: "tone",
question: "トーンは？",
options: [
{ label: "しっかり丁寧", instruction: "クッション言葉を使い、丁寧に書くこと。ただし前置きが長くなりすぎず、要件は早めに示す。"},
{ label: "簡潔に要件のみ", instruction: "挨拶や前置きは最小限にし、要件・期限・依頼事項を端的に書くこと。"},
],
},
{
slot: "length",
question: "分量は？",
options: [
{ label: "短く（スクロール不要）", instruction: "スマホでスクロールせず読める分量に収めること。"},
{ label: "必要なだけ詳しく", instruction: "分量制限は設けない。背景や経緯も含め、読み手が追加で質問しなくて済むように書くこと。"},
],
},
],
code: [
{
slot: "format",
question: "出力は？",
options: [
{ label: "コードのみ", instruction: "出力は動作するコードのみ。解説は付けない。コードは省略せず全体を出すこと。"},
{ label: "コード＋短い解説", instruction: "コード全体に加えて、設計の要点だけを短く解説すること。行ごとの逐次解説は不要。"},
],
},
{
slot: "angle",
question: "方針は？",
options: [
{ label: "最小実装で確実に動く", instruction: "方針は最小実装。余分な抽象化や将来への備えは入れず、要求された動作を確実に満たすこと。外部ライブラリは標準で使えるもの優先。"},
{ label: "拡張しやすく作る", instruction: "方針は拡張性重視。役割ごとに分割し、後から機能を足しやすい構造にすること。ただし過剰な設計パターンは持ち込まない。"},
],
},
{
slot: "audience",
question: "書く相手（環境）は？",
options: [
{ label: "既存コードに合わせる", instruction: "既存コードベースの流儀（命名、構成、使用ライブラリ）に合わせること。不明な点は勝手に決めず、コード内のコメントではなく前提として最初に明示する。"},
{ label: "新規プロジェクト", instruction: "新規プロジェクトとして、一般的なベストプラクティスに沿って自由に構成してよい。"},
],
},
{
slot: "length",
question: "完成度は？",
options: [
{ label: "動く試作（プロトタイプ）", instruction: "目的は動く試作。エラー処理やエッジケースは最小限でよく、まず動作確認できる形を優先すること。"},
{ label: "そのまま使える本番品質", instruction: "目的は本番利用。エラー処理、入力検証、エッジケースまで含めること。"},
],
},
],
image: [
{
slot: "format",
question: "スタイルは？",
options: [
{ label: "写真風・リアル", instruction: "スタイルは写真風のリアルな質感。レンズや照明など撮影条件まで具体的に指定すること。"},
{ label: "イラスト風", instruction: "スタイルはイラスト。画風（線の太さ、色数、質感）を具体的に指定すること。"},
],
},
{
slot: "angle",
question: "雰囲気は？",
options: [
{ label: "明るく爽やか", instruction: "全体の雰囲気は明るく爽やかに。彩度と明度を高めに指定すること。"},
{ label: "落ち着いて高級感", instruction: "全体の雰囲気は落ち着いて高級感のある方向に。色数を絞り、余白を活かす指定にすること。"},
],
},
{
slot: "purpose",
question: "使い道は？",
options: [
{ label: "SNS・スマホ表示", instruction: "用途はSNS・スマホ表示。縦長構図で、縮小表示でも主題がはっきり分かるようにすること。"},
{ label: "バナー・ヘッダー", instruction: "用途はバナーやヘッダー。横長構図で、文字を載せる余白を確保すること。"},
],
},
{
slot: "length",
question: "要素の量は？",
options: [
{ label: "主題ひとつでシンプル", instruction: "被写体・要素は主題ひとつに絞り、背景はシンプルにすること。"},
{ label: "情報量多めでにぎやか", instruction: "要素を多めに入れて情報量のある画にすること。ただし主題が埋もれないよう主従を指定する。"},
],
},
],
study: [
{
slot: "audience",
question: "レベルは？",
options: [
{ label: "中学生でも分かる", instruction: "中学生でも分かる言葉で説明すること。専門用語を使う場合はその場で言い換える。"},
{ label: "専門用語OK", instruction: "専門用語はそのまま使ってよい。正確さと密度を優先すること。"},
],
},
{
slot: "format",
question: "形は？",
options: [
{ label: "要点まとめ", instruction: "要点を箇条書きで先に示し、各要点を短く補足する形にすること。"},
{ label: "例え話つき解説", instruction: "日常の具体例や例え話を使って流れで解説すること。例えは正確さを損なわない範囲で使う。"},
],
},
{
slot: "length",
question: "分量は？",
options: [
{ label: "3行で核心だけ", instruction: "核心だけを3行程度で。周辺知識は入れないこと。"},
{ label: "しっかり理解まで", instruction: "背景・理由・注意点まで含めて、読み終われば人に説明できるレベルまで書くこと。"},
],
},
{
slot: "tone",
question: "口調は？",
options: [
{ label: "先生のように丁寧に", instruction: "丁寧に教える口調で書くこと。"},
{ label: "友達に教える感じで", instruction: "友達に教えるような砕けた口調で書くこと。ただし正確さは落とさない。"},
],
},
],
};

/** 質問数の既定値。generateQuestions の count はこれを既定として追随する。 */
export const MAX_QUESTIONS = 5;

export function generateQuestions(input: string, count: number = MAX_QUESTIONS): { category: PrompterCategory; questions: BinaryQuestion[]} {
const cap = Math.max(1, Math.floor(count) || MAX_QUESTIONS);
const category = categorizeInput(input);
const picked: BinaryQuestion[] = [];
const usedSlots = new Set<QuestionSlot>();
const push = (q: BinaryQuestion) => {
if (picked.length >= cap || usedSlots.has(q.slot)) return;
usedSlots.add(q.slot);
picked.push(q);
};
if (category!== "generic") {
for (const q of CATEGORY_QUESTIONS[category]) push(q);
}
for (const q of UNIVERSAL_QUESTIONS) push(q);
return { category, questions: picked.slice(0, cap)};
}

const ANTI_SLOP_RULES = [
"「いかがでしたか」「まとめると」「結論として」「〜と言えるでしょう」などの定型の締め文句や、「お役に立てれば幸いです」「ぜひ〜してみてください」などの定型の前置きを使わない",
"「まず〜、次に〜、最後に〜」式の機械的な列挙をしない。文の長さとリズムに自然なばらつきを持たせる",
"「しかしながら」「さらに」「また」「そのため」などの接続詞を連発しない",
"依頼に不要な見出し・箇条書き・絵文字で装飾しない",
"「革新的」「画期的」「寄り添う」「伴走」「深掘り」「解像度を上げる」「刺さる」など具体に落とせないバズワードや、根拠のない誇張表現を使わない。具体的な事実で示す",
"「魅力」「価値」「可能性」「重要性」などの抽象語を、具体的な事実・数字・固有名詞なしに使わない",
"両論併記で結論を逃げない。書き手の立場を1つに決めて書き切り、過剰なへりくだり・謝罪をしない",
"全部を均等に扱わず、重要なものに分量と順序で優先順位を付ける",
"前置き・言い訳・自己言及（「以下に示します」等）を入れず、成果物から始める",
"情報が足りない部分は無難な一般論で埋めず、その旨を明示するか、最も妥当な前提を1つ置いて明示する",
"同じ内容の言い換え繰り返しで分量を稼がず、締めで内容を焼き直した要約をしない",
];

export function buildPrompt(input: string, category: PrompterCategory, answers: PrompterAnswer[]): string {
const rough = input.trim();
const lines: string[] = [];
// 定型の役割文・締め文は置かない。依頼文と、決まった条件・対策・差し替え指示だけの最小構成にする。
lines.push(rough);
if (answers.length > 0) {
lines.push("");
for (const a of answers) {
lines.push(`- ${a.instruction}`);
}
}
lines.push("");
for (const rule of ANTI_SLOP_RULES) {
lines.push(`- ${rule}`);
}
lines.push("");
lines.push("元の依頼に無い事実（名前・日時・数字・固有名詞など）が必要な場合は勝手に作らず、【会社名】のようなプレースホルダで示し、末尾に「差し替え項目」として一覧を付けること。");
lines.push("条件同士が矛盾する場合は、より具体的な条件を優先してください。");
return lines.join("\n");
}
