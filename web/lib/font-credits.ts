// 画像生成などで使用している同梱フォントのクレジット表記用データ。
//
// フォントファイルはリポジトリの assets/fonts/ に同梱されており、各フォントの
// 著作権表示とライセンス全文は assets/fonts/licenses/ に収録されている。
// 18フォントは SIL Open Font License 1.1、JiyunoTsubasa（自由の翼）のみ
// 旧 M+ FONT LICENSE 準拠（配布元: たぬきフォント）。
export type FontCredit = {
  /** フォントの表示名 */
  name: string;
  /** ライセンス表記 */
  license: string;
  /** ライセンス・配布元の URL（任意） */
  url?: string;
};

const OFL = "SIL Open Font License 1.1";
const OFL_URL = "https://openfontlicense.org";

export const FONT_CREDITS: FontCredit[] = [
  { name: "Bruno Ace SC", license: OFL, url: OFL_URL },
  { name: "Castoro Titling", license: OFL, url: OFL_URL },
  { name: "Dancing Script", license: OFL, url: OFL_URL },
  { name: "Dela Gothic One", license: OFL, url: OFL_URL },
  { name: "Dot Gothic 16", license: OFL, url: OFL_URL },
  { name: "Exo 2", license: OFL, url: OFL_URL },
  { name: "Hachi Maru Pop", license: OFL, url: OFL_URL },
  { name: "Inconsolata", license: OFL, url: OFL_URL },
  { name: "M PLUS Rounded 1c", license: OFL, url: OFL_URL },
  { name: "Noto Color Emoji", license: OFL, url: OFL_URL },
  { name: "Poltawski Nowy", license: OFL, url: OFL_URL },
  { name: "Rampart One", license: OFL, url: OFL_URL },
  { name: "Reggae One", license: OFL, url: OFL_URL },
  { name: "RocknRoll One", license: OFL, url: OFL_URL },
  { name: "Vina Sans", license: OFL, url: OFL_URL },
  { name: "Yuji Syuku", license: OFL, url: OFL_URL },
  { name: "Yusei Magic", license: OFL, url: OFL_URL },
  { name: "Zen Old Mincho", license: OFL, url: OFL_URL },
  {
    name: "JiyunoTsubasa（自由の翼フォント）",
    license: "旧 M+ FONT LICENSE 準拠（© たぬき侍／たぬきフォント）",
    url: "https://tanukifont.com/jiyu-no-tsubasa/",
  },
];

/** 同梱フォントのライセンスファイル置き場（リポジトリ） */
export const FONT_LICENSES_URL = "https://github.com/deshihito/BOT/tree/main/assets/fonts/licenses";
