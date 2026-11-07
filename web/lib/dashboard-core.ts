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

// ---------------------------------------------------------------- Discord CDN

/** ユーザーアバターのURL。ハッシュが無ければ ID から決まるデフォルトアバター。 */
export function userAvatarUrl(userId: string, avatarHash: string | null | undefined): string {
  if (avatarHash) {
    const ext = avatarHash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=64`;
  }
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** ギルドアイコンのURL。ハッシュが無ければ null（呼び出し側で頭文字表示にする）。 */
export function guildIconUrl(guildId: string, iconHash: string | null | undefined): string | null {
  if (!iconHash) return null;
  const ext = iconHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=64`;
}

// ---------------------------------------------------------------- 検証

const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

export type FieldType =
  | "bool" | "channel" | "role" | "role_list" | "text" | "number" | "enum"
  | "enum_number" | "text_list" | "preset" | "id_list" | "rate_map" | "bot_rule_map"
  | "message" | "emoji_role_map" | "level_role_map" | "schedule_list";

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
  /** type="text_list" のとき: 1件あたりの最大文字数（既定100） */
  itemMaxLength?: number;
  /** type="text_list" のとき: 各要素が満たすべき正規表現（文字列） */
  itemPattern?: string;
  /** type="text_list" のとき: 保存時に黙って除く値（Bot側 normalize と同じ扱いのもの） */
  excludeValues?: string[];
  /** type="channel" のとき: セレクタ表示で候補にするチャンネル種別（既定はテキスト系） */
  channelKind?: "text" | "voice" | "category";
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
  /** true のとき: セクション全体が1つの対応表（bot_control 等）。単一フィールドの解析結果でセクションを置き換える */
  mapSection?: boolean;
  /** guild_settings 以外の保存先（Bot 本体と同じテーブルを Bot API 経由で読み書きする） */
  external?: "bump_rta";
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
    description: "既存EXPのレベルに応じて、ロールを自動付与します。到達レベル以下で最も高い報酬が1つ付与されます。",
    fields: [
      { name: "enabled", label: "レベル報酬", type: "bool" },
      { name: "role_rewards", label: "レベルとロールの対応表（1行に1件、最大10件）", type: "level_role_map", multiline: true, description: "書式: レベル=ロールID（レベルは2〜1000）。空欄にすると対応表を消します" },
    ],
  },
  {
    section: "assist_tempvoice",
    label: "一時VC",
    description: "参加すると専用のボイスチャンネルを自動作成し、名前変更やロックができます。",
    fields: [
      { name: "enabled", label: "一時VC", type: "bool" },
      { name: "join_channel_id", label: "作成用VC（ボイスチャンネル）", type: "channel", channelKind: "voice" },
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
    description: "招待リンク・外部リンク・メンションスパム・大文字スパム・連投・横断連投・コピペ荒らしを自動削除します。管理者と「メッセージの管理」権限者は対象外です。",
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
      {
        name: "cross_count", label: "横断連投検知（60秒間・複数チャンネル）", type: "enum_number", default: 0,
        options: [
          { value: 0, label: "オフ" }, { value: 3, label: "同一内容 3 件以上" },
          { value: 5, label: "同一内容 5 件以上" },
        ],
      },
      {
        name: "raid_users", label: "コピペ荒らし検知（60秒間）", type: "enum_number", default: 0,
        options: [
          { value: 0, label: "オフ" }, { value: 3, label: "同一内容を 3 人以上" },
          { value: 5, label: "同一内容を 5 人以上" }, { value: 10, label: "同一内容を 10 人以上" },
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
    description: "メンバー数・オンライン数・ブースト数をVC名に反映します。",
    fields: [
      { name: "enabled", label: "サーバースタッツ", type: "bool" },
      { name: "member_channel_id", label: "メンバー数を表示するVC", type: "channel", channelKind: "voice" },
      { name: "online_channel_id", label: "オンライン数を表示するVC", type: "channel", channelKind: "voice" },
      { name: "boost_channel_id", label: "ブースト数を表示するVC", type: "channel", channelKind: "voice" },
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
    description: "毎日決まった時刻の告知と、一回限りのリマインダーを投稿します。スケジュールを編集しても、その日の送信済み記録は引き継がれます（時刻と本文を変えると新しい告知として扱われます）。一回限りのリマインダーは利用者自身の登録のため、ここでは扱いません。",
    fields: [
      { name: "enabled", label: "タイマー告知", type: "bool" },
      { name: "channel_id", label: "送信先", type: "channel" },
      { name: "schedules", label: "告知スケジュール（1行に1件、最大10件）", type: "schedule_list", multiline: true, description: "書式: HH:MM メッセージ（例: 21:00 定例会のお知らせ）。空欄にすると全て消します" },
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
    section: "assist_reactionroles",
    label: "リアクションロール",
    description: "対象メッセージの絵文字リアクションでロールを付与・解除します。チャンネルを変えると対象メッセージと対応表はリセットされ、メッセージを変えると対応表がリセットされます（Discordのパネルと同じ動作）。保存後にDiscordで対象メッセージへ「リアクションを反映」すると、Botが絵文字を付けます。",
    fields: [
      { name: "enabled", label: "リアクションロール", type: "bool" },
      { name: "channel_id", label: "対象メッセージのチャンネル", type: "channel" },
      { name: "message_id", label: "対象メッセージのID", type: "message" },
      { name: "mappings", label: "絵文字とロールの対応表（1行に1件、最大25件）", type: "emoji_role_map", multiline: true, description: "書式: 絵文字=ロールID（例: ⭐=123456789012345678）。空欄にすると対応表を消します" },
    ],
    guards: [
      { flag: "enabled", needs: ["channel_id", "message_id", "mappings"], message: "リアクションロールを有効にするには、対象チャンネル・対象メッセージ・対応表が必要です" },
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
  {
    section: "ticket",
    label: "チケットツール",
    description: "問い合わせチケットの受付パネルと作成ルームの設定です。チケットの種別と担当者の割り当ては、Discordの /support パネルで行ってください。",
    fields: [
      { name: "enabled", label: "チケットツール", type: "bool" },
      { name: "panel_channel_id", label: "パネル設置先", type: "channel" },
      {
        name: "mode", label: "作成タイプ", type: "enum", default: "thread",
        options: [
          { value: "thread", label: "プライベートスレッド" },
          { value: "channel", label: "専用チャンネル" },
        ],
      },
      { name: "category_id", label: "専用チャンネルのカテゴリ（作成タイプが専用チャンネルのとき）", type: "channel", channelKind: "category" },
      { name: "viewer_role_ids", label: "閲覧ロール（最大25個）", type: "role_list", maxItems: 25 },
      { name: "operator_role_ids", label: "操作ロール（最大25個）", type: "role_list", maxItems: 25 },
      {
        name: "delete_after", label: "クローズ後の自動削除", type: "enum_number", default: 0,
        options: [
          { value: 0, label: "無効" }, { value: 3600, label: "1時間" },
          { value: 86400, label: "1日" }, { value: 259200, label: "3日" },
          { value: 604800, label: "7日" },
        ],
      },
      { name: "user_manage", label: "作成者にルーム操作（名前変更など）を許可", type: "bool" },
      { name: "transcript_channel_id", label: "記録（トランスクリプト）の保存先", type: "channel" },
    ],
    guards: [
      { flag: "enabled", needs: ["panel_channel_id"], message: "チケットツールを有効にするには、パネル設置先チャンネルが必要です" },
    ],
  },
  {
    section: "vc_auto_start",
    label: "VC参加時の自動開始",
    description: "誰かがボイスチャンネルに参加したとき、選んだ機能を自動で始めます。グローバルVCはルーム名が未設定だと開始されません。",
    fields: [
      { name: "tts", label: "読み上げ", type: "bool" },
      { name: "transcribe", label: "文字起こし", type: "bool" },
      { name: "music_panel", label: "ミュージックパネル", type: "bool" },
      { name: "global", label: "グローバルVC", type: "bool" },
      { name: "global_room", label: "グローバルVCのルーム名", type: "text", maxLength: 100, description: "グローバルVCを自動開始するにはルーム名が必要です" },
      { name: "global_password", label: "グローバルVCのパスワード（任意）", type: "text", maxLength: 100 },
    ],
  },
  {
    section: "globalchat",
    label: "グローバルチャット（荒らし対策）",
    description: "NGワードとブロックの指定だけを編集します。参加チャンネルの登録・解除はDiscordの /support パネルで行ってください（チャンネル登録はWebでは扱いません）。",
    fields: [
      { name: "ng_words", label: "NGワード（1行に1つ、最大100件）", type: "text_list", maxItems: 100, itemMaxLength: 50, multiline: true },
      { name: "blocked_users", label: "ブロックするユーザーID（1行に1つ、最大100件）", type: "id_list", maxItems: 100 },
      { name: "blocked_guilds", label: "ブロックするサーバーID（1行に1つ、最大100件）", type: "id_list", maxItems: 100 },
    ],
  },
  {
    section: "command_control",
    label: "BOT fixer（コマンド制限）",
    description: "AGO BOTの機能をサーバー単位で制限します。設定用の機能（BOT fixer）自体は常に対象外で、サーバー管理者は制限の対象になりません。レート制限は1行に「アクションID 回数 期間（秒）」の形で書きます（例: general:money_panel 10 3600）。期間は60〜604800秒、回数は1〜1000です。",
    fields: [
      {
        name: "mode", label: "制限モード", type: "enum", default: "off",
        options: [
          { value: "off", label: "制限なし" },
          { value: "deny", label: "禁止リスト（下のアクションを使えない）" },
          { value: "allow", label: "許可リストのみ（下のアクションだけ使える）" },
        ],
      },
      { name: "actions", label: "対象アクションID（1行に1つ）", type: "text_list", maxItems: 300, itemPattern: "^[a-z0-9_]+:[a-z0-9_]+(:[a-z0-9_]+)?$", excludeValues: ["support:bot_fixer"], multiline: true, description: "アクションIDは general:money_panel のような形です。BOT fixer 自体は自動で除かれます" },
      { name: "rates", label: "レート制限（1行に1件）", type: "rate_map", multiline: true, description: "空欄にするとレート制限なし。書式: アクションID 回数 期間（秒）" },
    ],
  },
  {
    section: "bot_control",
    label: "BOT fixer（他ボット制限）",
    description: "他のボットの発言を、許可したチャンネルだけに制限します。1行に「ボットID 許可チャンネルID（カンマ区切り） [回数 期間（秒）]」の形で書きます（例: 123456789012345678 234567890123456789,345678901234567890 20 3600）。許可チャンネルが1つも無い行は保存できません。AGO BOT 自身は対象にできません。",
    fields: [
      { name: "rules", label: "制限するボット（1行に1件、最大50件）", type: "bot_rule_map", multiline: true },
    ],
    mapSection: true,
  },
  {
    section: "bump_rta",
    label: "bump/up RTA通知",
    description: "DISBOARDのbumpや各種upの通知と、次に可能になる時刻のリマインダー・RTA計測の設定です。保存はBotに1分ほどで反映されます。",
    fields: [
      { name: "notifications_enabled", label: "bump/up通知とRTA計測", type: "bool", default: true },
      { name: "role_id", label: "通知時にメンションするロール（任意）", type: "role" },
    ],
    external: "bump_rta",
  },
];

export function sectionSpec(section: string): SectionSpec | undefined {
  return SETTING_SECTIONS.find((spec) => spec.section === section);
}

export type SanitizeResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; errors: string[] };

// BOT fixer のレート検証範囲（Bot側 core/support/command_control.py と
// パネルのモーダル検証に一致させる: 回数 1〜1000、期間 60〜604800 秒）
const RATE_MAX_COUNT = 1000;
const RATE_MIN_WINDOW_SECONDS = 60;
const RATE_MAX_WINDOW_SECONDS = 604800;
const ACTION_ID_PATTERN = /^[a-z0-9_]+:[a-z0-9_]+(:[a-z0-9_]+)?$/;
const COMMAND_CONTROL_SELF_ACTION = "support:bot_fixer";
/** AGO BOT 自身のアプリケーションID（他ボット制限の対象にできない） */
const OWN_BOT_ID = "1476636487784337428";
const BOT_RULE_MAX_ENTRIES = 50;

type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function parseRateParts(countRaw: string, windowRaw: string): { count: number; window_seconds: number } | null {
  const count = Number(countRaw);
  const window = Number(windowRaw);
  if (!Number.isInteger(count) || !Number.isInteger(window)) return null;
  if (count < 1 || count > RATE_MAX_COUNT) return null;
  if (window < RATE_MIN_WINDOW_SECONDS || window > RATE_MAX_WINDOW_SECONDS) return null;
  return { count, window_seconds: window };
}

/**
 * レート制限の対応表を検証・変換する。
 * 入力は「アクションID 回数 期間（秒）」を1行に1件書いた文字列、
 * または既に {action: {count, window_seconds}} の形のオブジェクト。
 * 空なら null（= レート制限なし）。BOT fixer 自体は Bot 側 normalize と同じく黙って除く。
 */
export function parseRateMap(raw: unknown): ParseResult<Record<string, { count: number; window_seconds: number }> | null> {
  const result: Record<string, { count: number; window_seconds: number }> = {};
  const errors: string[] = [];
  if (typeof raw === "string") {
    for (const line of raw.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/[\s,]+/).filter(Boolean);
      if (parts.length !== 3) { errors.push(`書式が正しくありません（アクションID 回数 期間（秒））: ${trimmed}`); continue; }
      const [actionId, countRaw, windowRaw] = parts;
      if (!ACTION_ID_PATTERN.test(actionId)) { errors.push(`アクションIDの形式が正しくありません: ${actionId}`); continue; }
      if (actionId === COMMAND_CONTROL_SELF_ACTION) continue;
      const rate = parseRateParts(countRaw, windowRaw);
      if (!rate) { errors.push(`回数は1〜${RATE_MAX_COUNT}、期間は${RATE_MIN_WINDOW_SECONDS}〜${RATE_MAX_WINDOW_SECONDS}秒で入力してください: ${actionId}`); continue; }
      result[actionId] = rate;
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [actionId, rule] of Object.entries(raw as Record<string, unknown>)) {
      if (!ACTION_ID_PATTERN.test(actionId)) { errors.push(`アクションIDの形式が正しくありません: ${actionId}`); continue; }
      if (actionId === COMMAND_CONTROL_SELF_ACTION) continue;
      if (typeof rule !== "object" || rule === null) { errors.push(`レートの形式が正しくありません: ${actionId}`); continue; }
      const r = rule as Record<string, unknown>;
      const rate = parseRateParts(String(r.count), String(r.window_seconds));
      if (!rate) { errors.push(`回数・期間の範囲が正しくありません: ${actionId}`); continue; }
      result[actionId] = rate;
    }
  } else if (raw !== null && raw !== undefined) {
    return { ok: false, errors: ["形式が正しくありません"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: Object.keys(result).length > 0 ? result : null };
}

/**
 * 他ボット制限（bot_control セクション全体）の対応表を検証・変換する。
 * 入力は1行に「ボットID 許可チャンネルID（カンマ区切り） [回数 期間（秒）]」と書いた文字列、
 * または既に {bot_id: {allowed_channel_ids, rate}} の形のオブジェクト。
 * 許可チャンネルが無いエントリは Bot 側 normalize と同じく成立しないためエラーにする
 * （Web では黙って落とすと事故に気付けないため）。空なら null（= セクション削除）。
 */
export function parseBotRuleMap(raw: unknown): ParseResult<Record<string, { allowed_channel_ids: string[]; rate: { count: number; window_seconds: number } | null }> | null> {
  type Entry = { allowed_channel_ids: string[]; rate: { count: number; window_seconds: number } | null };
  const result: Record<string, Entry> = {};
  const errors: string[] = [];

  function addEntry(botId: string, channelIds: string[], rate: { count: number; window_seconds: number } | null) {
    if (!isSnowflake(botId)) { errors.push(`ボットIDの形式が正しくありません: ${botId}`); return; }
    if (botId === OWN_BOT_ID) { errors.push("AGO BOT 自身は対象にできません"); return; }
    if (botId in result) { errors.push(`ボットIDが重複しています: ${botId}`); return; }
    const channels: string[] = [];
    for (const channelId of channelIds) {
      if (!isSnowflake(channelId)) { errors.push(`チャンネルIDの形式が正しくありません: ${channelId}`); return; }
      if (!channels.includes(channelId)) channels.push(channelId);
    }
    if (channels.length === 0) { errors.push(`許可チャンネルが1つ以上必要です: ${botId}`); return; }
    result[botId] = { allowed_channel_ids: channels.map(intToken), rate };
  }

  if (typeof raw === "string") {
    for (const line of raw.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length !== 2 && parts.length !== 4) {
        errors.push(`書式が正しくありません（ボットID 許可チャンネルID [回数 期間（秒）]）: ${trimmed}`);
        continue;
      }
      let rate: { count: number; window_seconds: number } | null = null;
      if (parts.length === 4) {
        rate = parseRateParts(parts[2], parts[3]);
        if (!rate) { errors.push(`回数は1〜${RATE_MAX_COUNT}、期間は${RATE_MIN_WINDOW_SECONDS}〜${RATE_MAX_WINDOW_SECONDS}秒で入力してください: ${parts[0]}`); continue; }
      }
      addEntry(parts[0], parts[1].split(","), rate);
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [botId, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) { errors.push(`形式が正しくありません: ${botId}`); continue; }
      const e = entry as Record<string, unknown>;
      const rawChannels = Array.isArray(e.allowed_channel_ids) ? e.allowed_channel_ids : [];
      const channelIds = rawChannels.map((c) => unwrapId(c)).filter(Boolean);
      let rate: { count: number; window_seconds: number } | null = null;
      if (e.rate !== null && e.rate !== undefined) {
        if (typeof e.rate !== "object") { errors.push(`レートの形式が正しくありません: ${botId}`); continue; }
        const r = e.rate as Record<string, unknown>;
        rate = parseRateParts(String(r.count), String(r.window_seconds));
        if (!rate) { errors.push(`回数・期間の範囲が正しくありません: ${botId}`); continue; }
      }
      addEntry(botId, channelIds, rate);
    }
  } else if (raw !== null && raw !== undefined) {
    return { ok: false, errors: ["形式が正しくありません"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(result).length > BOT_RULE_MAX_ENTRIES) {
    return { ok: false, errors: [`最大 ${BOT_RULE_MAX_ENTRIES} 件までです`] };
  }
  return { ok: true, value: Object.keys(result).length > 0 ? result : null };
}


const EMOJI_ROLE_MAX = 25;
const LEVEL_ROLE_MAX = 10;
const SCHEDULE_MAX = 10;
const SCHEDULE_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * リアクションロールの対応表（絵文字→ロールID）を検証・変換する。
 * 入力は「絵文字=ロールID」を1行に1件書いた文字列（Bot のモーダルと同じく
 * 区切りは改行/カンマ、= が無ければ : でもよい）、または保存済みオブジェクト。
 */
export function parseEmojiRoleMap(raw: unknown): ParseResult<Record<string, string> | null> {
  const result: Record<string, string> = {};
  const errors: string[] = [];
  function add(emojiRaw: string, roleRaw: string) {
    const emoji = emojiRaw.trim();
    const roleId = roleRaw.trim();
    if (!emoji) { errors.push("絵文字が空です"); return; }
    if (emoji.length > 100 || emoji.includes(INT_TOKEN_PREFIX)) { errors.push(`絵文字が不正です: ${emoji}`); return; }
    if (!isSnowflake(roleId)) { errors.push(`ロールIDの形式が正しくありません: ${roleId}`); return; }
    result[emoji] = intToken(roleId);
  }
  if (typeof raw === "string") {
    for (const token of raw.split(/[\n,]+/)) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const sep = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
      if (!sep) { errors.push(`「絵文字=ロールID」の形式で入力してください: ${trimmed}`); continue; }
      const at = trimmed.indexOf(sep);
      add(trimmed.slice(0, at), trimmed.slice(at + 1));
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [emoji, roleId] of Object.entries(raw as Record<string, unknown>)) {
      add(emoji, unwrapId(roleId));
    }
  } else if (raw !== null && raw !== undefined) {
    return { ok: false, errors: ["形式が正しくありません"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(result).length > EMOJI_ROLE_MAX) {
    return { ok: false, errors: [`最大 ${EMOJI_ROLE_MAX} 件までです`] };
  }
  return { ok: true, value: Object.keys(result).length > 0 ? result : null };
}

/**
 * レベル報酬の対応表（レベル→ロールID）を検証・変換する。
 * 入力は「レベル=ロールID」を1行に1件書いた文字列（Bot のモーダルと同じ形式）。
 * レベルは 2〜1000、最大10件。キーはレベル文字列（Bot の保存形式と同じ）。
 */
export function parseLevelRoleMap(raw: unknown): ParseResult<Record<string, string> | null> {
  const result: Record<string, string> = {};
  const errors: string[] = [];
  function add(levelRaw: string, roleRaw: string) {
    const level = Number(levelRaw.trim());
    const roleId = roleRaw.trim();
    if (!Number.isInteger(level) || level < 2 || level > 1000) {
      errors.push(`レベルは2〜1000の整数で入力してください: ${levelRaw}`);
      return;
    }
    if (!isSnowflake(roleId)) { errors.push(`ロールIDの形式が正しくありません: ${roleId}`); return; }
    result[String(level)] = intToken(roleId);
  }
  if (typeof raw === "string") {
    for (const token of raw.split(/[\n,]+/)) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const sep = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
      if (!sep) { errors.push(`「レベル=ロールID」の形式で入力してください: ${trimmed}`); continue; }
      const at = trimmed.indexOf(sep);
      add(trimmed.slice(0, at), trimmed.slice(at + 1));
    }
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [level, roleId] of Object.entries(raw as Record<string, unknown>)) {
      add(level, unwrapId(roleId));
    }
  } else if (raw !== null && raw !== undefined) {
    return { ok: false, errors: ["形式が正しくありません"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  const keys = Object.keys(result).sort((a, b) => Number(a) - Number(b));
  if (keys.length > LEVEL_ROLE_MAX) {
    return { ok: false, errors: [`最大 ${LEVEL_ROLE_MAX} 件までです`] };
  }
  const sorted: Record<string, string> = {};
  for (const key of keys) sorted[key] = result[key];
  return { ok: true, value: keys.length > 0 ? sorted : null };
}

export type ScheduleEntry = { time: string; message: string };

/**
 * タイマー告知スケジュール（時刻＋本文）を検証・変換する。
 * 入力は「HH:MM メッセージ」を1行に1件書いた文字列、または保存済み相当の配列。
 * id / last_sent はここでは付けない（reconcileSchedules で既存分を引き継ぐ）。
 */
export function parseScheduleList(raw: unknown): ParseResult<ScheduleEntry[] | null> {
  const result: ScheduleEntry[] = [];
  const errors: string[] = [];
  function add(timeRaw: string, messageRaw: string) {
    const match = SCHEDULE_TIME.exec(timeRaw.trim());
    if (!match) { errors.push(`時刻は HH:MM で入力してください: ${timeRaw}`); return; }
    const time = `${match[1].padStart(2, "0")}:${match[2]}`;
    const message = messageRaw.trim();
    if (!message) { errors.push(`メッセージが空です: ${timeRaw}`); return; }
    if (message.length > 1500) { errors.push(`メッセージは1500文字までです: ${timeRaw}`); return; }
    if (message.includes(INT_TOKEN_PREFIX)) { errors.push(`使えない文字列が含まれています: ${timeRaw}`); return; }
    result.push({ time, message });
  }
  if (typeof raw === "string") {
    for (const line of raw.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const at = trimmed.search(/\s/);
      if (at < 0) { errors.push(`「HH:MM メッセージ」の形式で入力してください: ${trimmed}`); continue; }
      add(trimmed.slice(0, at), trimmed.slice(at + 1));
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) { errors.push("形式が正しくありません"); continue; }
      const entry = item as Record<string, unknown>;
      add(typeof entry.time === "string" ? entry.time : "", typeof entry.message === "string" ? entry.message : "");
    }
  } else if (raw !== null && raw !== undefined) {
    return { ok: false, errors: ["形式が正しくありません"] };
  }
  if (errors.length > 0) return { ok: false, errors };
  if (result.length > SCHEDULE_MAX) {
    return { ok: false, errors: [`最大 ${SCHEDULE_MAX} 件までです`] };
  }
  return { ok: true, value: result.length > 0 ? result : null };
}

/**
 * 新しいスケジュール一覧に、既存エントリの id / last_sent を引き継ぐ。
 * (time, message) が一致する既存エントリがあればその id を再利用し、
 * 二重送信防止（last_sent）を壊さない。一致しないものは新規 id を採番する。
 */
export function reconcileSchedules(
  entries: ScheduleEntry[],
  existingRaw: unknown,
  genId: () => string,
): Record<string, unknown>[] {
  const existing = Array.isArray(existingRaw) ? existingRaw : [];
  const pool: Record<string, unknown>[] = [];
  for (const item of existing) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.time === "string" && typeof entry.message === "string" && typeof entry.id === "string") {
      pool.push(entry);
    }
  }
  const used = new Set<number>();
  return entries.map((entry) => {
    const at = pool.findIndex(
      (old, index) => !used.has(index) && old.time === entry.time && old.message === entry.message,
    );
    if (at >= 0) {
      used.add(at);
      const old = pool[at];
      return {
        id: old.id as string,
        time: entry.time,
        message: entry.message,
        ...(typeof old.last_sent === "string" && old.last_sent ? { last_sent: old.last_sent } : {}),
      };
    }
    return { id: genId(), time: entry.time, message: entry.message };
  });
}

function normalizedMappings(value: unknown): [string, string][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([emoji, roleId]) => [emoji, unwrapId(roleId)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * リアクションロールの連動リセットを Discord パネルと同じ意味で適用する。
 * チャンネル変更時は対象メッセージと対応表をリセットし、メッセージ変更時は
 * 対応表をリセットする。ただし今回の送信で新しい値が明示されている項目は
 * そのまま使う（Web はセクション全体を一括送信するため、保存値との比較で
 * 「変更されたかどうか」を判定する）。
 */
export function applyReactionRolesCoupling(
  values: Record<string, unknown>,
  existingSection: unknown,
): Record<string, unknown> {
  const stored =
    typeof existingSection === "object" && existingSection !== null && !Array.isArray(existingSection)
      ? (existingSection as Record<string, unknown>)
      : {};
  const result = { ...values };
  const channelChanged =
    "channel_id" in result && unwrapId(result.channel_id) !== unwrapId(stored.channel_id);
  if (channelChanged) {
    if (unwrapId(result.message_id) === unwrapId(stored.message_id)) {
      result.message_id = null;
      result.mappings = null;
    }
    return result;
  }
  const messageChanged =
    "message_id" in result && unwrapId(result.message_id) !== unwrapId(stored.message_id);
  if (messageChanged) {
    const sameMappings =
      JSON.stringify(normalizedMappings(result.mappings)) === JSON.stringify(normalizedMappings(stored.mappings));
    if (sameMappings) result.mappings = null;
  }
  return result;
}

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
      case "role":
      case "message": {
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
        const itemMax = field.itemMaxLength ?? 100;
        const pattern = field.itemPattern ? new RegExp(field.itemPattern) : null;
        const excluded = new Set(field.excludeValues ?? []);
        const cleaned: string[] = [];
        for (const item of items) {
          if (typeof item !== "string") { errors.push(`${field.label}: 文字列で入力してください`); break; }
          const trimmed = item.trim();
          if (!trimmed) continue;
          if (excluded.has(trimmed)) continue;
          if (trimmed.length > itemMax) { errors.push(`${field.label}: 1件は${itemMax}文字までです`); break; }
          if (trimmed.includes(INT_TOKEN_PREFIX)) { errors.push(`${field.label}: 使えない文字列が含まれています`); break; }
          if (pattern && !pattern.test(trimmed)) { errors.push(`${field.label}: 形式が正しくありません: ${trimmed}`); break; }
          if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
        }
        if (errors.length) break;
        const maxItems = field.maxItems ?? 10;
        if (cleaned.length > maxItems) { errors.push(`${field.label}: 最大 ${maxItems} 件までです`); break; }
        values[field.name] = cleaned.length > 0 ? cleaned : null;
        break;
      }
      case "id_list": {
        const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
        if (!items) { errors.push(`${field.label}: IDの一覧が必要です`); break; }
        const ids: string[] = [];
        for (const item of items) {
          if (typeof item !== "string") { errors.push(`${field.label}: IDは文字列で入力してください`); break; }
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
      case "rate_map": {
        const parsed = parseRateMap(raw);
        if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${field.label}: ${e}`)); break; }
        values[field.name] = parsed.value;
        break;
      }
      case "bot_rule_map": {
        const parsed = parseBotRuleMap(raw);
        if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${field.label}: ${e}`)); break; }
        values[field.name] = parsed.value;
        break;
      }
      case "emoji_role_map": {
        const parsed = parseEmojiRoleMap(raw);
        if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${field.label}: ${e}`)); break; }
        values[field.name] = parsed.value;
        break;
      }
      case "level_role_map": {
        const parsed = parseLevelRoleMap(raw);
        if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${field.label}: ${e}`)); break; }
        values[field.name] = parsed.value;
        break;
      }
      case "schedule_list": {
        const parsed = parseScheduleList(raw);
        if (!parsed.ok) { errors.push(...parsed.errors.map((e) => `${field.label}: ${e}`)); break; }
        values[field.name] = parsed.value;
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

/**
 * 検証済みの入力をギルド設定全体へ反映する。
 * 通常セクションは mergeGuildSettings と同じキー単位マージ、
 * mapSection（bot_control のような対応表セクション）は解析結果で置き換える。
 */
export function applySectionValues(
  current: unknown,
  spec: SectionSpec,
  values: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!spec.mapSection) return mergeGuildSettings(current, spec.section, values);
  const guild: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const fieldName = spec.fields[0]?.name;
  const parsed = fieldName ? values[fieldName] : null;
  if (parsed === null || parsed === undefined ||
      (typeof parsed === "object" && Object.keys(parsed as Record<string, unknown>).length === 0)) {
    delete guild[spec.section];
  } else {
    guild[spec.section] = parsed;
  }
  return Object.keys(guild).length > 0 ? guild : null;
}
