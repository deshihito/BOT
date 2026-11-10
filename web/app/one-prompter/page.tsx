import type { Metadata } from "next";
import OnePrompterClient from "./OnePrompterClient";

export const metadata: Metadata = {
  title: "One Prompter",
  description:
    "雑な一文を投げて、二択の質問に答えるだけ。空欄を埋めて細かく詰め切り、AIあるあるを消す条件まで入れた完成プロンプトを返します。",
  alternates: { canonical: "/one-prompter" },
};

export default function OnePrompterPage() {
  return (
    <div className="op-page">
      <div className="page-heading">
        <p className="eyebrow">ONE PROMPTER</p>
        <h1>One Prompter</h1>
        <p className="muted">
          雑なプロンプトは、足りない部分をAIが無難な平均で埋めるため、無難な結果になります。
          ここでは先に二択で空欄を埋めて条件を細かく詰め切り、定型表現や誇張などの「AIあるある」を消す指定まで入れた完成プロンプトに仕上げます。
        </p>
      </div>
      <OnePrompterClient />
    </div>
  );
}
