import type { Metadata } from "next";

import Breadcrumbs from "../../Breadcrumbs";
import { getBgcutSession } from "@/lib/bgcut";
import BgCutClient from "./BgCutClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "背景透過・絵文字/スタンプ化",
  description:
    "画像やGIFの背景透過と、Discordの絵文字／スタンプ用への圧縮を、あなたのブラウザの中で行います。",
  robots: { index: false, follow: false },
};

function GonePage({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <Breadcrumbs items={[{ label: "背景透過" }]} />
      <div className="page-heading">
        <h1>{title}</h1>
        <p className="muted">{body}</p>
      </div>
      <p>
        背景透過は Discord の /general パネル「背景透過・絵文字/スタンプ化」から
        リンクを発行して使います。リンクの有効期限は60分です。
      </p>
    </div>
  );
}

export default async function BgCutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = getBgcutSession(token);
  if (session.status === "unconfigured") {
    return (
      <GonePage
        title="この環境では利用できません"
        body="リンク検証の基盤が未設定のため、背景透過ページを開けません。"
      />
    );
  }
  if (session.status === "invalid") {
    return (
      <GonePage
        title="リンクが正しくありません"
        body="背景透過のリンクが正しくないか、既に使われています。"
      />
    );
  }
  if (session.status === "expired") {
    return (
      <GonePage
        title="このリンクは期限切れです"
        body="背景透過リンクの有効期限（60分）が切れました。Discord で新しいリンクを発行してください。"
      />
    );
  }
  return (
    <div>
      <Breadcrumbs items={[{ label: "背景透過" }]} />
      <div className="page-heading">
        <p className="eyebrow">BACKGROUND CUTOUT</p>
        <h1>背景透過・絵文字/スタンプ化</h1>
      </div>
      <BgCutClient
        token={token}
        purpose={session.payload.purpose}
        expiresAt={session.payload.expiresAt}
      />
    </div>
  );
}
