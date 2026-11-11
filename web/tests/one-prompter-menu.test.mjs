// ハンバーガーメニュー・サービス名の表示回数・モデル選択の配線を、
// ソースコードの静的チェックで確かめる（画面描画はしない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

const layoutSrc = read("app/one-prompter/layout.tsx");
const pageSrc = read("app/one-prompter/page.tsx");
const menuSrc = read("app/one-prompter/OpMenu.tsx");
const clientSrc = read("app/one-prompter/OnePrompterClient.tsx");
const routeSrc = read("app/api/one-prompter/route.ts");

/** 行コメント（// で始まる行）を除いた本文。コメント中の言及を表示と数えないため。 */
function withoutLineComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

test("サービス名の常時表示はヘッダーの1箇所だけ（フッター・見出しに出さない）", () => {
  const layoutBody = withoutLineComments(layoutSrc);
  assert.equal(layoutBody.split("One Prompter").length - 1, 1);
  // ページの描画部分（コンポーネント本体）にサービス名は出ない（メタ情報は対象外）
  const pageJsx = pageSrc.slice(pageSrc.indexOf("export default function"));
  assert.ok(!pageJsx.includes("One Prompter"));
  // 見出しはキャッチフレーズ
  assert.match(pageJsx, /<h1 className="op-lead">雑な意見を、神プロンプトに。<\/h1>/);
  // クライアントの描画文にもサービス名は出ない
  assert.ok(!withoutLineComments(clientSrc).includes("One Prompter"));
  assert.ok(!withoutLineComments(menuSrc).includes("One Prompter"));
});

test("レイアウトはハンバーガーメニューをヘッダーに置く", () => {
  assert.match(layoutSrc, /import OpMenu from "\.\/OpMenu"/);
  assert.match(layoutSrc, /<OpMenu \/>/);
});

test("メニューは使い方3ステップと規約リンク（新規タブ）を持ち、閉じる操作がある", () => {
  assert.match(menuSrc, /使い方/);
  assert.match(menuSrc, /やりたいことを書く/);
  assert.match(menuSrc, /二択の質問に答える/);
  assert.match(menuSrc, /完成プロンプトをコピー／保存して、好きなAIに貼る/);
  assert.match(menuSrc, /href="https:\/\/agobot\.app\/terms"/);
  assert.match(menuSrc, /href="https:\/\/agobot\.app\/privacy"/);
  assert.equal((menuSrc.match(/target="_blank"/g) || []).length, 2);
  // 閉じるボタン・Esc・外側クリック
  assert.match(menuSrc, /aria-label="メニューを閉じる"/);
  assert.match(menuSrc, /"Escape"/);
  assert.match(menuSrc, /contains\(e\.target as Node\)/);
  assert.match(menuSrc, /☰/);
});

test("クライアント側コードと表示文言にプロバイダ名（Logfare）が出ない", () => {
  for (const [name, src] of [
    ["OnePrompterClient.tsx", clientSrc],
    ["OpMenu.tsx", menuSrc],
    ["layout.tsx", layoutSrc],
    ["page.tsx", pageSrc],
  ]) {
    assert.ok(!/logfare/i.test(src), `${name} にプロバイダ名が含まれている`);
  }
});

test("入力画面の設定は1つの設定グループにまとまり、モデル選択を含む", () => {
  const groupStart = clientSrc.indexOf('className="op-settings"');
  assert.ok(groupStart >= 0, "設定グループがない");
  const group = clientSrc.slice(groupStart, clientSrc.indexOf('className="op-actions"', groupStart));
  assert.match(group, />設定</);
  assert.ok(group.indexOf("質問の数") < group.indexOf("プロンプトの言語"), "質問の数→言語の順で並ぶ");
  assert.ok(group.indexOf("プロンプトの言語") < group.indexOf("モデル"), "言語→モデルの順で並ぶ");
  assert.match(clientSrc, /PROMPTER_MODEL_OPTIONS\.map/);
});

test("クライアントは全リクエスト（質問・深掘り・合成・revise）に model を送る", () => {
  assert.equal((clientSrc.match(/model: modelKey/g) || []).length, 4);
});

test("API ルートは model を全アクションの LLM 呼び出しへ伝播する", () => {
  assert.equal((routeSrc.match(/model: body\.model/g) || []).length, 4);
  // ログにはモデルキーだけを出す（ID 解決はサーバー側の対応表）
  assert.match(routeSrc, /resolveModelKey\(body\.model\)/);
});
