import type { Metadata } from "next";
import OnePrompterClient from "./OnePrompterClient";

export const metadata: Metadata = {
  title: "One Prompter",
  description:
    "雑な一文を投げて、二択の質問に答えるだけ。AIが空欄を埋めた、構造化された完成プロンプトを返します。",
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
          ここでは先に二択で空欄を埋めてから、完成プロンプトに仕上げます。
        </p>
      </div>
      <OnePrompterClient />
    </div>
  );
}
