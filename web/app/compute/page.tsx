import type { Metadata } from "next";
import ComputeClient from "./ComputeClient";

export const metadata: Metadata = {
  title: "計算に参加 | AGOBOT",
  description:
    "AGOBOTのボードゲームCPUの検証計算に、ブラウザから参加できます。暗号資産のマイニングではなく、答えの分かっているチェス局面の検証計算です。参加は任意で、ボタン操作があったときだけ実行されます。",
  alternates: { canonical: "/compute" },
};

export default function ComputePage() {
  return (
    <div className="compute-page">
      <div className="page-heading">
        <p className="eyebrow">DISTRIBUTED COMPUTING</p>
        <h1>計算に参加</h1>
        <p className="muted">
          あなたのブラウザの空き時間で、AGOBOT のボードゲームCPUの検証を手伝えます。
          サーバー（小さなコンピューター1台）では時間がかかる計算を、参加者みんなで少しずつ分担する仕組みです。
        </p>
      </div>

      <h2>何を計算するの？</h2>
      <p>
        チェスの「perft（パーフト）」という検証計算です。答えの分かっている局面について、
        決められた深さまでの合法手の組み合わせの数を数え上げます。
        数が公開されている正解と一致すれば、AGOBOT のチェスCPUの着手生成が正しいと確認できます。
        計算は小さなタスクに分割されていて、あなたのブラウザが1件ずつ引き受け、結果だけをサーバーへ返します。
        結果はサーバー側で正解と照合してから集計するので、間違った結果が混ざることはありません。
      </p>

      <h2>安心についての明記</h2>
      <ul>
        <li>
          <strong>暗号資産のマイニングではありません。</strong>
          AGOBOT 自身のゲーム機能のための検証計算で、通貨や報酬は発生しません。
        </li>
        <li>
          <strong>ページを開いただけでは計算は始まりません。</strong>
          下の「計算をはじめる」ボタンを押したときだけ実行されます。
        </li>
        <li>
          <strong>いつでも止められます。</strong>
          「停止する」ボタンで即座に止まり、タブを閉じればその時点で完全に終了します。
          タブが裏に回っている間は自動で一時停止します。
        </li>
        <li>
          <strong>端末への配慮。</strong>
          同時に使う計算スレッドは控えめに抑え、タスクの合間に短い休止を入れています。
        </li>
        <li>
          <strong>匿名で参加できます。</strong>
          ログインは不要です。あなたの貢献件数はこのブラウザの中にだけ保存され、
          サーバーへ個人を特定する情報が送られることはありません。
        </li>
      </ul>

      <ComputeClient />

      <p className="quiet-note">
        進捗が 100% になった時点で、このスイートは完了です。これまでのスイートの実績は
        上のパネルに表示されます。ご協力ありがとうございます。
      </p>
    </div>
  );
}
