// ハンバーガーメニュー（モデル選択専用）・サービス名の表示回数・
// モデル状態の共有・「より考える」トグルの配線・選択中ボタンの
// スタイルを、ソースコードの静的チェックで確かめる（画面描画はしない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

const layoutSrc = read("app/one-prompter/layout.tsx");
const headerSrc = read("app/one-prompter/OpHeader.tsx");
const contextSrc = read("app/one-prompter/OpModelContext.tsx");
const pageSrc = read("app/one-prompter/page.tsx");
const menuSrc = read("app/one-prompter/OpMenu.tsx");
const clientSrc = read("app/one-prompter/OnePrompterClient.tsx");
const routeSrc = read("app/api/one-prompter/route.ts");
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

test("レイアウトはモデル状態の Provider で包み、ヘッダーを置く", () => {
  assert.match(layoutSrc, /import OpHeader from "\.\/OpHeader"/);
  assert.match(layoutSrc, /import \{ OpModelProvider \} from "\.\/OpModelContext"/);
  assert.match(layoutSrc, /<OpModelProvider>/);
  assert.match(layoutSrc, /<OpHeader \/>/);
  // コンテキストは既定モデルで初期化される
  assert.match(contextSrc, /useState<PrompterModelKey>\(DEFAULT_MODEL_KEY\)/);
});

test("ヘッダーはハンバーガーメニューと現在のモデル名（控えめ表示）を出す", () => {
  assert.match(headerSrc, /import OpMenu from "\.\/OpMenu"/);
  assert.match(headerSrc, /<OpMenu \/>/);
  assert.match(headerSrc, /className="op-header-model"/);
  assert.match(headerSrc, /PROMPTER_MODEL_OPTIONS\.find/);
  assert.match(headerSrc, /useOpModel\(\)/);
});

test("メニューはモデル選択専用: 一覧とチェックと閉じる操作を持ち、規約リンクも使い方も持たない", () => {
  assert.match(menuSrc, />モデル</);
  assert.match(menuSrc, /PROMPTER_MODEL_OPTIONS\.map/);
  assert.match(menuSrc, /✓/);
  assert.match(menuSrc, /aria-pressed=\{selected\}/);
  // 選んだら切り替えて閉じる
  assert.match(menuSrc, /setModelKey\(opt\.key\)/);
  assert.match(menuSrc, /setOpen\(false\)/);
  // 件1: 利用規約・プライバシーポリシーは画面のどこにも置かない
  assert.ok(!menuSrc.includes("agobot.app/terms"));
  assert.ok(!menuSrc.includes("agobot.app/privacy"));
  assert.ok(!menuSrc.includes("利用規約"));
  assert.ok(!menuSrc.includes("プライバシーポリシー"));
  // 使い方の項目もメニューから外した
  assert.ok(!menuSrc.includes("使い方"));
  assert.ok(!menuSrc.includes("やりたいことを書く"));
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
    ["OpModelContext.tsx", contextSrc],
    ["layout.tsx", layoutSrc],
    ["page.tsx", pageSrc],
  ]) {
    assert.ok(!/logfare/i.test(src), `${name} にプロバイダ名が含まれている`);
  }
});

test("モデル状態はコンテキスト経由でクライアントと共有される", () => {
  assert.match(clientSrc, /const \{ modelKey \} = useOpModel\(\);/);
  assert.match(menuSrc, /const \{ modelKey, setModelKey \} = useOpModel\(\);/);
});

test("入力画面の設定グループは質問の数・言語・思考トグルだけで、モデル選択を含まない", () => {
  const groupStart = clientSrc.indexOf('className="op-settings"');
  assert.ok(groupStart >= 0, "設定グループがない");
  const group = clientSrc.slice(groupStart, clientSrc.indexOf('className="op-actions"', groupStart));
  assert.match(group, />設定</);
  assert.ok(group.indexOf("質問の数") < group.indexOf("プロンプトの言語"), "質問の数→言語の順で並ぶ");
  assert.ok(group.indexOf("プロンプトの言語") < group.indexOf("より考える"), "言語→思考トグルの順で並ぶ");
  // モデル選択はメニューへ移したので、設定グループには行ごと無い
  assert.ok(!group.includes('op-countlabel">モデル'), "設定グループにモデル行が残っている");
  assert.ok(!group.includes("PROMPTER_MODEL_OPTIONS"), "設定グループでモデル選択肢を描いている");
  // メニュー側がモデル一覧を描く
  assert.match(menuSrc, /PROMPTER_MODEL_OPTIONS\.map/);
});

test("「より考える」トグルは既定オフで、非対応モデルでは無効化される", () => {
  assert.match(clientSrc, /const \[think, setThink\] = useState\(false\);/);
  assert.match(clientSrc, /className=\{think \? "op-suboption selected" : "op-suboption"\}/);
  assert.match(clientSrc, /aria-pressed=\{think\}/);
  assert.match(clientSrc, /disabled=\{!thinkSupported\}/);
  assert.match(clientSrc, /const thinkSupported = modelSupportsThink\(modelKey\);/);
  assert.ok(clientSrc.includes("より考える"));
});

test("クライアントは全リクエスト（質問・深掘り・合成・revise）に model と think を送る", () => {
  assert.equal((clientSrc.match(/model: modelKey/g) || []).length, 4);
  // think の送り方は2形: 末尾に並べる形（質問開始・revise）と単独行（深掘り・合成）
  assert.equal((clientSrc.match(/model: modelKey, think \}/g) || []).length, 2);
  assert.equal((clientSrc.match(/^\s+think,$/gm) || []).length, 2);
});

test("API ルートは model と think を全アクションの LLM 呼び出しへ伝播する", () => {
  assert.equal((routeSrc.match(/model: body\.model/g) || []).length, 4);
  assert.equal((routeSrc.match(/think: body\.think/g) || []).length, 4);
  // ログにはモデルキーだけを出す（ID 解決はサーバー側の対応表）
  assert.match(routeSrc, /resolveModelKey\(body\.model\)/);
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
  // メニューのモデル一覧の選択中も同じ統一
  assert.match(cssSrc, /\.op-shell \.op-menu-model\.selected \{ background:#17191c; border-color:#17191c; color:#fff; \}/);
});
