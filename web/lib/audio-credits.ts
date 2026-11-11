/**
 * 立体音響で使用している実測データ（HRTF・部屋の残響・スピーカー特性）のクレジット。
 * 各データの利用条件は出典元の表記に従う（確認日: 2026-11-11）。
 */
export type AudioDataCredit = {
  /** 用途の見出し */
  usage: string;
  /** データ名 */
  name: string;
  /** 権利者・出典 */
  credit: string;
  /** 利用条件の要約 */
  terms: string;
  /** 出典 URL */
  url: string;
};

export const AUDIO_DATA_CREDITS: AudioDataCredit[] = [
  {
    usage: "HRTF（頭部伝達関数）",
    name: "KEMAR HRTF Measurements",
    credit: "Bill Gardner and Keith Martin, MIT Media Lab (Copyright 1994 by the MIT Media Laboratory)",
    terms: "著者の引用を条件に、無制限に利用できます。",
    url: "https://sound.media.mit.edu/resources/KEMAR.html",
  },
  {
    usage: "リバーブ（コンサートホール）",
    name: "Pori Concert Hall Impulse Responses",
    credit: "Copyright © 2005 Helsinki University of Technology (TKK), Akukon Oy, and the authors",
    terms: "非商用目的に限り、著者の引用を条件に利用できます（商用利用は権利者の書面許可が必要）。",
    url: "http://legacy.spa.aalto.fi/projects/poririrs/",
  },
  {
    usage: "リバーブ（録音スタジオ）",
    name: "EchoThief Impulse Response Library",
    credit: "Chris Warren (San Diego State University)",
    terms: "Steinman Foundation Recording Suite のインパルス応答を使用。残響づけなどの派生的な音響作品への利用が許可されています。",
    url: "https://www.echothief.com/",
  },
  {
    usage: "スピーカー特性・指向性",
    name: "DirPat — Database and Viewer of 2D/3D Directivity Patterns of Sound Sources and Receivers",
    credit: "M. Brandner, M. Frank, and D. Rudrich, IEM, University of Music and Performing Arts Graz (AES Convention 144, 2018)",
    terms: "CC0（パブリックドメイン）。Neumann KH120A / Tannoy System 1200 / Yamaha DXR8 / Genelec 8020 の実測データを使用。",
    url: "https://phaidra.kug.ac.at/detail/o:68229",
  },
];
