import { VOICEVOX_CHARACTERS, VOICEVOX_CREDITS_AS_OF } from "@/lib/voicevox-credits";

export const metadata = {
  title: "クレジット | AGOBOT",
  description: "AGOBOTの読み上げ機能で使用しているVOICEVOXのキャラクタークレジット一覧です。",
  alternates: { canonical: "/credits" },
};

export default function CreditsPage() {
  const styleCount = VOICEVOX_CHARACTERS.reduce((sum, c) => sum + c.styles.length, 0);
  return (
    <article className="legal-page">
      <h1>クレジット</h1>
      <p>
        AGOBOTの読み上げ機能は、音声合成ソフトウェア<strong>VOICEVOX</strong>のキャラクターボイスを使用しています。
        使用している全キャラクターのクレジットを以下に表記します。
      </p>

      <h2>音声合成</h2>
      <ul>
        <li>
          ソフトウェア：<a href="https://voicevox.hiroshiba.jp/" target="_blank" rel="noreferrer">VOICEVOX</a>
        </li>
        <li>
          音声合成API：<a href="https://tts.quest/" target="_blank" rel="noreferrer">VOICEVOX Web API（api.tts.quest）</a>を利用しています。
        </li>
      </ul>

      <h2>キャラクタークレジット</h2>
      <p>
        読み上げで利用できる全{VOICEVOX_CHARACTERS.length}キャラクター（全{styleCount}スタイル）のクレジットです。
        一覧は{VOICEVOX_CREDITS_AS_OF}時点のものです。各キャラクターの利用条件は、それぞれの利用規約に従います。
      </p>
      <ul>
        {VOICEVOX_CHARACTERS.map((character) => (
          <li key={character.name}>
            <strong>VOICEVOX:{character.name}</strong>
            <br />
            <span className="muted">スタイル：{character.styles.join("、")}</span>
          </li>
        ))}
      </ul>
      <p className="muted">VOICEVOX はヒホ（Hiroshiba）氏による音声合成ソフトウェアです。キャラクターごとに権利者と利用規約が異なります。</p>
    </article>
  );
}
