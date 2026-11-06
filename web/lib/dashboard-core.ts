// ダッシュボードの純粋ロジック（環境変数・fetch に触れない。tests/dashboard.test.mjs で検証する）
//
// Discord の ID（snowflake）は 64bit 整数で、JavaScript の Number では正確に表せない。
// そのため API との受け渡しでは、大きな整数を "#int:<digits>" という番兵文字列で運び、
// 送受信の境界（parseJsonPreservingInts / stringifyWithInts）でだけ生の JSON 数値に変換する。

export const INT_TOKEN_PREFIX = "#int:";

export function intToken(digits: string): string {
  return `${INT_TOKEN_PREFIX}${digits}`;
}

export function isIntToken(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(INT_TOKEN_PREFIX) && /^\d+$/.test(value.slice(INT_TOKEN_PREFIX.length));
}

/** 表示用に、番兵文字列・数値・文字列を ID の数字文字列へ寄せる。 */
export function unwrapId(value: unknown): string {
  if (isIntToken(value)) return value.slice(INT_TOKEN_PREFIX.length);
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string") return value;
  return "";
}

// ---------------------------------------------------------------- JSON 境界

/** JSON テキストを読み、安全範囲を超える整数リテラルを番兵文字列にして返す。 */
export function parseJsonPreservingInts(text: string): unknown {
  let pos = 0;
  const len = text.length;

  function fail(message: string): never {
    throw new Error(`invalid JSON at ${pos}: ${message}`);
  }
  function skipWs() {
    while (pos < len && (text[pos] === " " || text[pos] === "\n" || text[pos] === "\r" || text[pos] === "\t")) pos++;
  }
  function parseValue(): unknown {
    skipWs();
    if (pos >= len) fail("unexpected end");
    const ch = text[pos];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t") { expect("true"); return true; }
    if (ch === "f") { expect("false"); return false; }
    if (ch === "n") { expect("null"); return null; }
    return parseNumber();
  }
  function expect(word: string) {
    if (text.slice(pos, pos + word.length) !== word) fail(`expected ${word}`);
    pos += word.length;
  }
  function parseObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    pos++;
    skipWs();
    if (text[pos] === "}") { pos++; return obj; }
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[pos] !== ":") fail("expected :");
      pos++;
      obj[key] = parseValue();
      skipWs();
      if (text[pos] === ",") { pos++; continue; }
      if (text[pos] === "}") { pos++; return obj; }
      fail("expected , or }");
    }
  }
  function parseArray(): unknown[] {
    const arr: unknown[] = [];
    pos++;
    skipWs();
    if (text[pos] === "]") { pos++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[pos] === ",") { pos++; continue; }
      if (text[pos] === "]") { pos++; return arr; }
      fail("expected , or ]");
    }
  }
  function parseString(): string {
    if (text[pos] !== '"') fail("expected string");
    let end = pos + 1;
    while (end < len) {
      if (text[end] === "\\") { end += 2; continue; }
      if (text[end] === '"') break;
      end++;
    }
    if (end >= len) fail("unterminated string");
    const raw = text.slice(pos, end + 1);
    pos = end + 1;
    return JSON.parse(raw) as string;
  }
  function parseNumber(): unknown {
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!match) fail("expected number");
    const literal = match[0];
    pos += literal.length;
    if (/^\d+$/.test(literal)) {
      const asNumber = Number(literal);
      if (!Number.isSafeInteger(asNumber)) return intToken(literal);
      return asNumber;
    }
    return Number(literal);
  }

  const value = parseValue();
  skipWs();
  if (pos !== len) fail("trailing characters");
  return value;
}

/** 番兵文字列を生の JSON 数値として書き出す JSON 化。 */
export function stringifyWithInts(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot serialize non-finite number");
    return String(value);
  }
  if (typeof value === "string") {
    if (isIntToken(value)) return value.slice(INT_TOKEN_PREFIX.length);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stringifyWithInts(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifyWithInts(v)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`cannot serialize ${typeof value}`);
}

// ---------------------------------------------------------------- Discord 権限

export type OAuthGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
};

const ADMINISTRATOR = 1n << 3n; // 0x8
const MANAGE_GUILD = 1n << 5n; // 0x20

/** Bot 内 has_manage_permission と同じ基準（管理者 または サーバーの管理）。 */
export function hasManageGuild(permissions: string): boolean {
  try {
    const bits = BigInt(permissions);
    return (bits & ADMINISTRATOR) !== 0n || (bits & MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

export function manageableGuilds(guilds: OAuthGuild[]): OAuthGuild[] {
  return guilds.filter((guild) => guild.owner || hasManageGuild(guild.permissions));
}

// ---------------------------------------------------------------- 検証

const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

export type FieldType =
  | "bool" | "channel" | "role" | "role_list" | "text" | "number" | "enum"
  | "enum_number" | "text_list" | "preset";

export type FieldSpec = {
  name: string;
  label: string;
  type: FieldType;
  description?: string;
  /** Bot側のデフォルト値（未設定のときにフォームが初期表示する値） */
  default?: boolean | number | string;
  multiline?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
  options?: { value: string | number; label: string }[];
  /** type="preset" のとき: プリセット名 → 実際に保存する複数フィールドの値 */
  presetValues?: Record<string, Record<string, unknown>>;
};

export type SectionGuard = {
  /** このフィールドが true のときだけ効くガード */
  flag: string;
  /** すべて非空でなければならないフィールド */
  needs?: string[];
  /** いずれか1つが非空でなければならないフィールド */
  needsAny?: string[];
  message: string;
};

export type SectionSpec = {
  section: string;
  label: string;
  description: string;
  fields: FieldSpec[];
  guards?: SectionGuard[];
};

/** v1 で編集できるセクション（Bot 側の検証規則に合わせる）。 */
export const SETTING_SECTIONS: SectionSpec[] = [
  {
    section: "assist_welcome",
    label: "参加・退出メッセージ",
    description: "メンバーの参加・退出を、選んだチャンネルへお知らせします。文面では {user} {name} {server} {count} {id} が使えます。",
    fields: [
      { name: "welcome_enabled", label: "参加メッセージ", type: "bool" },
      { name: "welcome_channel_id", label: "参加メッセージの送信先", type: "channel" },
      { name: "welcome_message", label: "参加メッセージの文面", type: "text", maxLength: 1500, multiline: true, description: "空欄にすると既定の文面になります" },
      { name: "goodbye_enabled", label: "退出メッセージ", type: "bool" },
      { name: "goodbye_channel_id", label: "退出メッセージの送信先", type: "channel", description: "未設定なら参加メッセージの送信先と同じ" },
      { name: "goodbye_message", label: "退出メッセージの文面", type: "text", maxLength: 1500, multiline: true, description: "空欄にすると既定の文面になります" },
      { name: "welcome_image_enabled", label: "画像カード（参加時）", type: "bool" },
      {
        name: "welcome_image_theme", label: "画像テーマ", type: "enum", default: "white",
        options: [
          { value: "white", label: "ホワイト" }, { value: "blue", label: "ブルー" },
          { value: "pink", label: "ピンク" }, { value: "green", label: "グリーン" },
          { value: "dark", label: "ダーク" },
        ],
      },
    ],
    guards: [
      { flag: "welcome_enabled", needs: ["welcome_channel_id"], message: "参加メッセージを有効にするには、参加メッセージの送信先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_autorole",
    label: "自動ロール",
    description: "メンバーが参加したときに、指定したロールを自動で付与します。Botが管理できる範囲のロールだけが実際に付与されます。",
    fields: [
      { name: "enabled", label: "自動ロール", type: "bool" },
      { name: "role_ids", label: "自動付与するロール（最大10個）", type: "role_list", maxItems: 10 },
      { name: "include_bots", label: "BOTにも付与", type: "bool" },
    ],
  },
  {
    section: "assist_starboard",
    label: "Starboard",
    description: "リアクションが集まったメッセージを、Starboardチャンネルへ転載します。",
    fields: [
      { name: "enabled", label: "Starboard", type: "bool" },
      { name: "channel_id", label: "送信先", type: "channel" },
      { name: "emoji", label: "反応に使う絵文字", type: "text", maxLength: 64, default: "⭐" },
      {
        name: "threshold", label: "しきい値", type: "enum_number", default: 3,
        options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: `${n} 個` })),
      },
      { name: "allow_self", label: "自分のメッセージへのリアクションも対象にする", type: "bool" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "Starboardを有効にするには、送信先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_leveling",
    label: "レベル報酬",
    description: "既存EXPのレベルに応じて、ロールを自動付与します。レベルとロールの対応表の編集は、Discordの /support パネルで行ってください。",
    fields: [
      { name: "enabled", label: "レベル報酬", type: "bool" },
    ],
  },
  {
    section: "assist_tempvoice",
    label: "一時VC",
    description: "参加すると専用のボイスチャンネルを自動作成し、名前変更やロックができます。",
    fields: [
      { name: "enabled", label: "一時VC", type: "bool" },
      { name: "join_channel_id", label: "作成用VC（ボイスチャンネルのID）", type: "channel" },
      { name: "name_template", label: "名前テンプレート", type: "text", maxLength: 100, description: "{user} {name} {id} が使えます。空欄にすると既定の「{user}のVC」になります" },
      { name: "user_limit", label: "既定の人数上限（0で無制限）", type: "number", min: 0, max: 99, default: 0 },
    ],
    guards: [
      { flag: "enabled", needs: ["join_channel_id"], message: "一時VCを有効にするには、作成用VCが必要です" },
    ],
  },
  {
    section: "assist_suggestions",
    label: "提案箱",
    description: "サーバーへの提案を募集し、賛成・反対の票を集めます。",
    fields: [
      { name: "enabled", label: "提案箱", type: "bool" },
      { name: "channel_id", label: "提案先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "提案箱を有効にするには、提案先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_automod",
    label: "AutoMod",
    description: "招待リンク・外部リンク・メンションスパム・大文字スパム・連投を自動削除します。管理者と「メッセージの管理」権限者は対象外です。",
    fields: [
      { name: "enabled", label: "AutoMod", type: "bool" },
      { name: "log_channel_id", label: "ログ送信先", type: "channel" },
      { name: "block_invites", label: "招待リンクを削除", type: "bool" },
      { name: "block_links", label: "外部リンクを削除", type: "bool" },
      {
        name: "max_mentions", label: "メンションスパムのしきい値", type: "enum_number", default: 5,
        options: [
          { value: 0, label: "制限なし" }, { value: 3, label: "3 件以上" },
          { value: 5, label: "5 件以上" }, { value: 10, label: "10 件以上" },
        ],
      },
      {
        name: "caps_percent", label: "大文字スパムのしきい値", type: "enum_number", default: 70,
        options: [
          { value: 0, label: "チェックなし" }, { value: 50, label: "50% 以上" },
          { value: 70, label: "70% 以上" }, { value: 90, label: "90% 以上" },
        ],
      },
      {
        name: "timeout_minutes", label: "検知時のタイムアウト", type: "enum_number", default: 0,
        options: [
          { value: 0, label: "タイムアウトなし" }, { value: 1, label: "1 分" },
          { value: 5, label: "5 分" }, { value: 10, label: "10 分" }, { value: 60, label: "60 分" },
        ],
      },
      {
        name: "spam_count", label: "連投検知（10秒間）", type: "enum_number", default: 0,
        options: [
          { value: 0, label: "オフ" }, { value: 3, label: "3 件以上" },
          { value: 5, label: "5 件以上" }, { value: 8, label: "8 件以上" },
        ],
      },
    ],
  },
  {
    section: "assist_polls",
    label: "投票",
    description: "質問と選択肢から投票を作り、結果をその場で集計します。",
    fields: [
      { name: "enabled", label: "投票", type: "bool" },
      { name: "channel_id", label: "投稿先", type: "channel" },
      { name: "multiple", label: "複数選択を許可", type: "bool" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "投票を有効にするには、投稿先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_autothread",
    label: "自動スレッド",
    description: "指定したチャンネルの各メッセージにスレッドを作ります。",
    fields: [
      { name: "enabled", label: "自動スレッド", type: "bool" },
      { name: "channel_id", label: "対象チャンネル", type: "channel" },
      {
        name: "archive_minutes", label: "スレッドの自動アーカイブ", type: "enum_number", default: 1440,
        options: [
          { value: 60, label: "1時間" }, { value: 1440, label: "1日" },
          { value: 4320, label: "3日" }, { value: 10080, label: "1週間" },
        ],
      },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "自動スレッドを有効にするには、対象チャンネルが必要です" },
    ],
  },
  {
    section: "assist_serverlog",
    label: "サーバーログ",
    description: "参加・退出、メッセージ削除、ロール/チャンネルの作成削除を記録します。",
    fields: [
      { name: "enabled", label: "サーバーログ", type: "bool" },
      { name: "channel_id", label: "送信先", type: "channel" },
      { name: "log_joins", label: "参加", type: "bool", default: true },
      { name: "log_leaves", label: "退出", type: "bool", default: true },
      { name: "log_message_delete", label: "メッセージ削除", type: "bool", default: true },
      { name: "log_roles", label: "ロール", type: "bool", default: true },
      { name: "log_channels", label: "チャンネル", type: "bool", default: true },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "サーバーログを有効にするには、送信先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_embed",
    label: "埋め込みビルダー",
    description: "タイトル・本文・色などを指定してEmbedを投稿します。テンプレートの作成・編集は、Discordの /support パネルで行ってください。",
    fields: [
      { name: "enabled", label: "埋め込みビルダー", type: "bool" },
      { name: "channel_id", label: "投稿先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "埋め込みビルダーを有効にするには、投稿先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_stats",
    label: "サーバースタッツ",
    description: "メンバー数・オンライン数・ブースト数をVC名に反映します。表示先はボイスチャンネルのIDを指定してください。",
    fields: [
      { name: "enabled", label: "サーバースタッツ", type: "bool" },
      { name: "member_channel_id", label: "メンバー数を表示するVC", type: "channel" },
      { name: "online_channel_id", label: "オンライン数を表示するVC", type: "channel" },
      { name: "boost_channel_id", label: "ブースト数を表示するVC", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needsAny: ["member_channel_id", "online_channel_id", "boost_channel_id"], message: "サーバースタッツを有効にするには、表示先のVCが最低1つ必要です" },
    ],
  },
  {
    section: "assist_webhook",
    label: "Webhookビルダー",
    description: "Webhookを使って、名前とアイコンを変えたメッセージを投稿します。",
    fields: [
      { name: "enabled", label: "Webhookビルダー", type: "bool" },
      { name: "channel_id", label: "投稿先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "Webhookビルダーを有効にするには、投稿先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_timed",
    label: "タイマー告知",
    description: "毎日決まった時刻の告知と、一回限りのリマインダーを投稿します。告知スケジュールの追加・編集は、Discordの /support パネルで行ってください。",
    fields: [
      { name: "enabled", label: "タイマー告知", type: "bool" },
      { name: "channel_id", label: "送信先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "タイマー告知を有効にするには、送信先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_warnings",
    label: "警告",
    description: "メンバーへの警告を記録し、ログとDMで通知します。",
    fields: [
      { name: "enabled", label: "警告", type: "bool" },
      { name: "panel_channel_id", label: "警告パネルを置くチャンネル", type: "channel" },
      { name: "log_channel_id", label: "警告ログを送るチャンネル", type: "channel" },
      { name: "mod_role_id", label: "警告できるモデレーターロール（任意）", type: "role" },
      { name: "escalation_enabled", label: "エスカレーション（警告の蓄積で自動処罰）", type: "bool" },
      {
        name: "escalation_threshold", label: "エスカレーションの間隔（警告N件ごと）", type: "enum_number", default: 3,
        options: [2, 3, 4, 5, 10].map((n) => ({ value: n, label: `${n} 件ごと` })),
      },
      {
        name: "escalation_preset", label: "処罰プリセット", type: "preset",
        options: [
          { value: "timeout10", label: "タイムアウト 10分" },
          { value: "timeout60", label: "タイムアウト 60分" },
          { value: "timeout1440", label: "タイムアウト 1440分" },
          { value: "kick", label: "キック" },
        ],
        presetValues: {
          timeout10: { escalation_action: "timeout", escalation_timeout_minutes: 10 },
          timeout60: { escalation_action: "timeout", escalation_timeout_minutes: 60 },
          timeout1440: { escalation_action: "timeout", escalation_timeout_minutes: 1440 },
          kick: { escalation_action: "kick" },
        },
      },
    ],
    guards: [
      { flag: "enabled", needs: ["panel_channel_id"], message: "警告を有効にするには、警告パネルを置くチャンネルが必要です" },
    ],
  },
  {
    section: "assist_autoreact",
    label: "自動リアクション",
    description: "指定チャンネルのメッセージに自動でリアクションを付けます。",
    fields: [
      { name: "enabled", label: "自動リアクション", type: "bool" },
      { name: "channel_id", label: "対象チャンネル", type: "channel" },
      { name: "emojis", label: "リアクション（1行に1つ、最大10件）", type: "text_list", maxItems: 10, multiline: true },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id", "emojis"], message: "自動リアクションを有効にするには、対象チャンネルとリアクションが必要です" },
    ],
  },
  {
    section: "assist_invites",
    label: "招待トラッカー",
    description: "新しいメンバーがどの招待リンクから参加したかを記録します。",
    fields: [
      { name: "enabled", label: "招待トラッカー", type: "bool" },
      { name: "channel_id", label: "送信先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "招待トラッカーを有効にするには、送信先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_events",
    label: "イベント",
    description: "日時と場所を添えて、参加・不参加・未定を受け付けます。",
    fields: [
      { name: "enabled", label: "イベント", type: "bool" },
      { name: "channel_id", label: "投稿先", type: "channel" },
      { name: "sync_scheduled", label: "公式イベント連携（Discordの予定イベントも作る）", type: "bool" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id"], message: "イベントを有効にするには、投稿先チャンネルが必要です" },
    ],
  },
  {
    section: "assist_stickyroles",
    label: "ロール復元",
    description: "退出したメンバーのロールを保存し、再参加時に戻します。",
    fields: [
      { name: "enabled", label: "ロール復元", type: "bool" },
      { name: "ignore_bots", label: "BOTを除外", type: "bool", default: true },
    ],
  },
  {
    section: "assist_customreplies",
    label: "カスタム返信",
    description: "決まった言葉に、Botが決まった返信をします。返信リストの追加・編集は、Discordの /support パネルで行ってください。",
    fields: [
      { name: "enabled", label: "カスタム返信", type: "bool" },
      { name: "min_role_id", label: "返信を使えるロール（任意・未設定は全員）", type: "role" },
    ],
  },
  {
    section: "assist_applications",
    label: "応募フォーム",
    description: "スタッフ応募を受け付け、レビュー担当が承認・不承認を選べます。",
    fields: [
      { name: "enabled", label: "応募フォーム", type: "bool" },
      { name: "panel_channel_id", label: "応募パネルを置くチャンネル", type: "channel" },
      { name: "review_channel_id", label: "応募をレビューするチャンネル", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["review_channel_id"], message: "応募フォームを有効にするには、レビュー先チャンネルが必要です" },
    ],
  },
];

export function sectionSpec(section: string): SectionSpec | undefined {
  return SETTING_SECTIONS.find((spec) => spec.section === section);
}

export type SanitizeResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * クライアントから来た1セクション分の入力を、Bot の保存形式へ検証・変換する。
 * 値が null のキーは「その項目を消す」（Bot の GuildSettings.update と同じ意味）。
 */
export function sanitizeSectionInput(spec: SectionSpec, input: unknown): SanitizeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["入力の形式が正しくありません"] };
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set(spec.fields.map((field) => field.name));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, errors: [`扱えない項目です: ${key}`] };
  }

  const errors: string[] = [];
  const values: Record<string, unknown> = {};

  for (const field of spec.fields) {
    if (!(field.name in record)) continue;
    const raw = record[field.name];
    switch (field.type) {
      case "bool": {
        if (typeof raw !== "boolean") { errors.push(`${field.label}: オン/オフの値が必要です`); break; }
        values[field.name] = raw;
        break;
      }
      case "channel":
      case "role": {
        if (typeof raw !== "string") { errors.push(`${field.label}: IDは文字列で入力してください`); break; }
        const trimmed = raw.trim();
        if (trimmed === "") { values[field.name] = null; break; }
        if (!isSnowflake(trimmed)) { errors.push(`${field.label}: DiscordのID（17〜20桁の数字）で入力してください`); break; }
        values[field.name] = intToken(trimmed);
        break;
      }
      case "role_list": {
        const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
        if (!items) { errors.push(`${field.label}: ロールIDの一覧が必要です`); break; }
        const ids: string[] = [];
        for (const item of items) {
          if (typeof item !== "string") { errors.push(`${field.label}: ロールIDは文字列で入力してください`); break; }
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (!isSnowflake(trimmed)) { errors.push(`${field.label}: DiscordのID（17〜20桁の数字）で入力してください: ${trimmed}`); break; }
          if (!ids.includes(trimmed)) ids.push(trimmed);
        }
        if (errors.length) break;
        const maxItems = field.maxItems ?? 25;
        if (ids.length > maxItems) { errors.push(`${field.label}: 最大 ${maxItems} 件までです`); break; }
        values[field.name] = ids.length > 0 ? ids.map(intToken) : null;
        break;
      }
      case "text": {
        if (typeof raw !== "string") { errors.push(`${field.label}: 文字列で入力してください`); break; }
        if (raw.includes(INT_TOKEN_PREFIX)) { errors.push(`${field.label}: 使えない文字列が含まれています`); break; }
        const maxLength = field.maxLength ?? 2000;
        if (raw.length > maxLength) { errors.push(`${field.label}: ${maxLength}文字までです`); break; }
        values[field.name] = raw === "" ? null : raw;
        break;
      }
      case "number": {
        const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(num) || !Number.isInteger(num)) { errors.push(`${field.label}: 整数で入力してください`); break; }
        if (field.min !== undefined && num < field.min) { errors.push(`${field.label}: ${field.min} 以上で入力してください`); break; }
        if (field.max !== undefined && num > field.max) { errors.push(`${field.label}: ${field.max} 以下で入力してください`); break; }
        values[field.name] = num;
        break;
      }
      case "enum": {
        const options = field.options ?? [];
        if (typeof raw !== "string" || !options.some((option) => option.value === raw)) {
          errors.push(`${field.label}: 選択肢から選んでください`);
          break;
        }
        values[field.name] = raw;
        break;
      }
      case "enum_number": {
        const options = field.options ?? [];
        const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(num) || !options.some((option) => option.value === num)) {
          errors.push(`${field.label}: 選択肢から選んでください`);
          break;
        }
        values[field.name] = num;
        break;
      }
      case "text_list": {
        const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,、]+/) : null;
        if (!items) { errors.push(`${field.label}: 一覧が必要です`); break; }
        const cleaned: string[] = [];
        for (const item of items) {
          if (typeof item !== "string") { errors.push(`${field.label}: 文字列で入力してください`); break; }
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (trimmed.length > 100) { errors.push(`${field.label}: 1件は100文字までです`); break; }
          if (trimmed.includes(INT_TOKEN_PREFIX)) { errors.push(`${field.label}: 使えない文字列が含まれています`); break; }
          if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
        }
        if (errors.length) break;
        const maxItems = field.maxItems ?? 10;
        if (cleaned.length > maxItems) { errors.push(`${field.label}: 最大 ${maxItems} 件までです`); break; }
        values[field.name] = cleaned.length > 0 ? cleaned : null;
        break;
      }
      case "preset": {
        const presets = field.presetValues ?? {};
        if (typeof raw !== "string" || !(raw in presets)) {
          errors.push(`${field.label}: 選択肢から選んでください`);
          break;
        }
        Object.assign(values, presets[raw]);
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values };
}

function isEmptySettingValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** マージ後のセクションに対して、有効化の前提条件（Discordパネルと同じガード）を確かめる。 */
export function validateSectionGuards(spec: SectionSpec, mergedSection: unknown): string[] {
  const section =
    typeof mergedSection === "object" && mergedSection !== null && !Array.isArray(mergedSection)
      ? (mergedSection as Record<string, unknown>)
      : {};
  const errors: string[] = [];
  for (const guard of spec.guards ?? []) {
    if (section[guard.flag] !== true) continue;
    const missingNeeds = (guard.needs ?? []).some((name) => isEmptySettingValue(section[name]));
    const missingAny = guard.needsAny ? guard.needsAny.every((name) => isEmptySettingValue(section[name])) : false;
    if (missingNeeds || missingAny) errors.push(guard.message);
  }
  return errors;
}

/**
 * Bot の GuildSettings.update と同じ意味でセクションをマージする。
 * 戻り値が null のときはギルド行そのものを削除する。
 */
export function mergeGuildSettings(
  current: unknown,
  section: string,
  values: Record<string, unknown>,
): Record<string, unknown> | null {
  const guild: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const existing = guild[section];
  const merged: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [name, value] of Object.entries(values)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  if (Object.keys(merged).length > 0) guild[section] = merged;
  else delete guild[section];
  return Object.keys(guild).length > 0 ? guild : null;
}
