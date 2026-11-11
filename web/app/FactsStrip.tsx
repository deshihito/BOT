export type Fact = { label: string; value: string };

/**
 * 判断材料ストリップ。利用判断に必要な情報（総数・対象・料金・対応環境・
 * 更新間隔など）を、長い説明文より前に短く並べるための共通部品。
 */
export default function FactsStrip({ facts, label = "判断材料" }: { facts: Fact[]; label?: string }) {
  return (
    <dl className="facts-strip" aria-label={label}>
      {facts.map((fact) => (
        <div key={fact.label} className="fact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
