// ハンバーガーメニュー・サービス名の表示回数・「より考える」トグルの配線・
// モデル選択の廃止（ds1017 固定）・選択中ボタンのスタイルを、
// ソースコードの静的チェックで確かめる（画面描画はしない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(import.meta.dirname, "..", rel));

const layoutSrc = read("app/one-prompter/layout.tsx");
const headerSrc = read("app/one-prompter/OpHeader.tsx");
const pageSrc = read("app/one-prompter/page.tsx");
const menuSrc = read("app/one-prompter/OpMenu.tsx");
const clientSrc = read("app/one-prompter/OnePrompterClient.tsx");
const routeSrc = read("app/api/one-prompter/route.ts");
const llmSrc = read("lib/one-prompter-llm.ts");
const serverSrc = read("lib/one-prompter-server.ts");
const cssSrc = read("app/globals.css");

/** 行コメント（// で始まる行）を除いた本文。コメント中の言及を表示と数えないため。 */
function withoutLineComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

test("サービス名の常時表示はヘッダーの1箇所だけ（フッター・見出しに出さない）", () => {
  // ブランド表示は OpHeader にあり、出現はそこの1回だけ
  assert.equal(withoutLineComments(headerSrc).split("One Prompter").length - 1, 1);
  assert.ok(!withoutLineComments(layoutSrc).includes("One Prompter"));
  // ページの描画部分（コンポーネント本体）にサービス名は出ない（メタ情報は対象外）
  const pageJsx = pageSrc.slice(pageSrc.indexOf("export default function"));
  assert.ok(!pageJsx.includes("One Prompter"));
  // 見出しはキャッチフレーズ
  assert.match(pageJsx, /<h1 className="op-lead">雑な意見を、神プロンプトに。<\/h1>/);
  // クライアントの描画文にもサービス名は出ない
  assert.ok(!withoutLineComments(clientSrc).includes("One Prompter"));
  assert.ok(!withoutLineComments(menuSrc).includes("One Prompter"));
});

test("レイアウトはヘッダーを置き、モデル状態の Provider は持たず、セッションを渡す", () => {
  assert.match(layoutSrc, /import OpHeader[^\n]*from "\.\/OpHeader"/);
  assert.match(layoutSrc, /<OpHeader user={user} googleEnabled={isGoogleConfigured\(\)} userKeyEnabled={isUserKeyEnabled\(\)} \/>/);
  assert.ok(!layoutSrc.includes("OpModelProvider"));
  assert.ok(!layoutSrc.includes("OpModelContext"));
  // モデル状態の共有コンテキスト自体を廃止した
  assert.ok(!exists("app/one-prompter/OpModelContext.tsx"));
  // ログイン状態は共通セッションから読み、プロバイダでアバターの形を出し分ける
  assert.match(layoutSrc, /getCurrentSession\(\)/);
  assert.match(layoutSrc, /session\.provider === "google"/);
  assert.match(layoutSrc, /userAvatarUrl\(session\.id, session\.avatar\)/);
});

test("ヘッダーはハンバーガーメニューを出し、ユーザー情報をそのまま渡す", () => {
  assert.match(headerSrc, /import OpMenu from "\.\/OpMenu"/);
  assert.match(headerSrc, /<OpMenu user={user} googleEnabled={googleEnabled} userKeyEnabled={userKeyEnabled} \/>/);
  assert.ok(!headerSrc.includes("op-header-model"));
  assert.ok(!headerSrc.includes("useOpModel"));
});

test("メニューはログイン導線だけを持ち、モデル選択も規約リンクも使い方も持たない", () => {
  assert.ok(!menuSrc.includes("PROMPTER_MODEL_OPTIONS"));
  assert.ok(!menuSrc.includes("✓"));
  // 利用規約・プライバシーポリシーは画面のどこにも置かない
  assert.ok(!menuSrc.includes("agobot.app/terms"));
  assert.ok(!menuSrc.includes("agobot.app/privacy"));
  assert.ok(!menuSrc.includes("利用規約"));
  assert.ok(!menuSrc.includes("プライバシーポリシー"));
  // 使い方の項目もメニューから外した
  assert.ok(!menuSrc.includes("使い方"));
  assert.ok(!menuSrc.includes("やりたいことを書く"));
  // 未ログイン: 共通 OAuth ルートへの導線（完了後はこの画面へ戻る）。Google は有効時のみ
  assert.match(menuSrc, /href={\`\/api\/auth\/discord\/authorize\?next=\$\{NEXT\}\`}/);
  assert.match(menuSrc, /Discord でログイン/);
  assert.match(menuSrc, /googleEnabled && \(/);
  assert.match(menuSrc, /href={\`\/api\/auth\/google\/authorize\?next=\$\{NEXT\}\`}/);
  assert.match(menuSrc, /Google でログイン/);
  assert.match(menuSrc, /NEXT = "\/one-prompter"/);
  // ログイン中: ユーザー表示とログアウト（戻り先つき）
  assert.match(menuSrc, /op-menu-username/);
  assert.match(menuSrc, /action={\`\/api\/auth\/logout\?next=\$\{NEXT\}\`}/);
  assert.match(menuSrc, /ログアウト/);
  // 閉じるボタン・Esc・外側クリック
  assert.match(menuSrc, /aria-label="メニューを閉じる"/);
  assert.match(menuSrc, /"Escape"/);
  assert.match(menuSrc, /contains\(e\.target as Node\)/);
  assert.match(menuSrc, /☰/);
});

test("規約・ポリシーへのリンクは One Prompter の画面側コードのどこにもない", () => {
  for (const [name, src] of [
    ["layout.tsx", layoutSrc],
    ["OpHeader.tsx", headerSrc],
    ["OpMenu.tsx", menuSrc],
    ["OnePrompterClient.tsx", clientSrc],
    ["page.tsx", pageSrc],
  ]) {
    assert.ok(!src.includes("agobot.app/terms"), `${name} に利用規約リンクがある`);
    assert.ok(!src.includes("agobot.app/privacy"), `${name} にプライバシーポリシーへのリンクがある`);
  }
});

test("クライアント側コードと表示文言にプロバイダ名（Logfare）が出ない", () => {
  for (const [name, src] of [
    ["OnePrompterClient.tsx", clientSrc],
    ["OpMenu.tsx", menuSrc],
    ["OpHeader.tsx", headerSrc],
    ["layout.tsx", layoutSrc],
    ["page.tsx", pageSrc],
  ]) {
    assert.ok(!/logfare/i.test(src), `${name} にプロバイダ名が含まれている`);
  }
});

test("モデル選択は廃止され、生成は ds1017 固定（env 差し替えのみ）", () => {
  // 選択肢・キー解決・対応表の痕跡がどこにもない
  for (const [name, src] of [
    ["one-prompter-llm.ts", llmSrc],
    ["one-prompter-server.ts", serverSrc],
    ["OnePrompterClient.tsx", clientSrc],
    ["OpMenu.tsx", menuSrc],
    ["OpHeader.tsx", headerSrc],
    ["route.ts", routeSrc],
  ]) {
    assert.ok(!src.includes("PROMPTER_MODEL_OPTIONS"), `${name} にモデル選択肢が残っている`);
    assert.ok(!src.includes("resolveModelKey"), `${name} にモデルキー解決が残っている`);
    assert.ok(!src.includes("resolveModelSpec"), `${name} にモデル対応表が残っている`);
    assert.ok(!src.includes("modelSupportsThink"), `${name} にモデル別 think 判定が残っている`);
  }
  // サーバー側は固定モデルを env でだけ差し替える
  assert.match(serverSrc, /model: onePrompterModel\(env\)/);
  assert.match(serverSrc, /env\.ONE_PROMPTER_MODEL/);
  assert.match(serverSrc, /"deepseek-v4\.1-flash-1017"/);
});

test("入力画面の設定グループは質問の数・言語・思考トグルだけ", () => {
  const groupStart = clientSrc.indexOf('className="op-settings"');
  assert.ok(groupStart >= 0, "設定グループがない");
  const group = clientSrc.slice(groupStart, clientSrc.indexOf('className="op-actions"', groupStart));
  assert.match(group, />設定</);
  assert.ok(group.indexOf("質問の数") < group.indexOf("プロンプトの言語"), "質問の数→言語の順で並ぶ");
  assert.ok(group.indexOf("プロンプトの言語") < group.indexOf("より考える"), "言語→思考トグルの順で並ぶ");
  assert.ok(!group.includes("モデル"), "設定グループにモデルが残っている");
});

test("「より考える」トグルは既定オフで、無効化されない（ds1017 専用の挙動）", () => {
  assert.match(clientSrc, /const \[think, setThink\] = useState\(false\);/);
  assert.match(clientSrc, /className=\{think \? "op-suboption selected" : "op-suboption"\}/);
  assert.match(clientSrc, /aria-pressed=\{think\}/);
  assert.ok(!clientSrc.includes("thinkSupported"));
  assert.ok(clientSrc.includes("より考える"));
});

test("クライアントは全リクエスト（質問・深掘り・合成・revise）に think を送り、model は送らない", () => {
  assert.ok(!clientSrc.includes("model:"));
  assert.equal((clientSrc.match(/count: questionCount, think \}/g) || []).length, 1);
  assert.equal((clientSrc.match(/^\s+think,$/gm) || []).length, 2);
  assert.equal((clientSrc.match(/lang: promptLang, think \}/g) || []).length, 1);
});

test("API ルートは think を全アクションの LLM 呼び出しへ伝播し、model は受け取らない", () => {
  assert.equal((routeSrc.match(/think: body\.think/g) || []).length, 4);
  assert.ok(!routeSrc.includes("body.model"));
});

test("選択中ボタンが真っ白にならない（黒背景＋白文字が白背景の一律上書きに負けない）", () => {
  // バグの原因だった一律ルール: .op-shell 内の .op-suboption を無条件で白背景にしていた
  assert.ok(
    !/\.op-shell \.op-suboption \{ background:#ffffff/.test(cssSrc),
    "選択中を含む一律の白背景ルールが残っている",
  );
  // 白背景の一律ルールは未選択だけに効く
  assert.match(cssSrc, /\.op-suboption:not\(\.selected\) \{ background:#ffffff; \}/);
  // 選択中はプライマリと同じ黒背景（#17191c）＋白文字を明示する
  assert.match(cssSrc, /\.op-shell \.op-suboption\.selected \{ background:#17191c; border-color:#17191c; color:#fff; \}/);
});
