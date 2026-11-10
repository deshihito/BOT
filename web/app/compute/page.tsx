import type { Metadata } from "next";
import Link from "next/link";
import ComputeClient from "./ComputeClient";

export const metadata: Metadata = {
  title: "計算に参加",
  description:
    "AGOBOTのボードゲームCPUの着手生成が正しいことを確かめた検証計算（perft）の結果ページです。検証スイートは完了済みで、同じ計算基盤が /games のチェスなど、あなたの端末で動くゲームに使われています。",
  alternates: { canonical: "/compute" },
};

export default function ComputePage() {
  return (
    <div className="compute-page">
      <div className="page-heading">
        <p className="eyebrow">DISTRIBUTED COMPUTING</p>
        <h1>計算に参加</h1>
        <p className="muted">
          AGOBOT のボードゲームCPUは、サーバーではなく、あなたの端末（ブラウザ）の中で計算する仕組みで動いています。
          このページでは、その計算エンジンが正しいことを確かめた検証の結果を表示します。
          検証スイートはすべて完了済みのため、現在このページから新しい計算を受け付けることはありません。
        </p>
      </div>

      <h2>何を検証したの？</h2>
      <p>
        チェスの「perft（パーフト）」という検証計算です。答えの分かっている局面について、
        決められた深さまでの合法手の組み合わせの数を数え上げ、公開されている正解と一致すれば、
        AGOBOT のチェスCPUの着手生成が正しいと確認できます。
        計算は小さなタスクに分割され、参加者のブラウザが1件ずつ引き受けて結果だけをサーバーへ返し、
        サーバー側で正解と照合してから集計しました。間違った結果が混ざることはありません。
        検証が済んだエンジンは、いま <Link href="/games/chess">/games のチェス</Link> で、
        あなたの端末の中でCPUとして動いています。
      </p>

      <h2>安心についての明記</h2>
      <ul>
        <li>
          <strong>暗号資産のマイニングではありません。</strong>
          AGOBOT 自身のゲーム機能のための検証計算で、通貨や報酬は発生しません。
        </li>
        <li>
          <strong>このページを開いても、計算は始まりません。</strong>
          検証スイートが完了したため、このページは結果の表示専用です。
          実行方式や端末への配慮の設定は、計算基盤の名残として残してあります。
        </li>
        <li>
          <strong>匿名で参加できる仕組みでした。</strong>
          ログインは不要で、個人を特定する情報がサーバーへ送られることはありません。
          あなたの貢献件数は、このブラウザの中にだけ保存されています。
        </li>
      </ul>

      <ComputeClient />

      <p className="quiet-note">
        進捗が 100% になった時点で、このスイートは完了です。これまでのスイートの実績は
        上のパネルに表示されます。ご協力ありがとうございました。
      </p>
    </div>
  );
}
