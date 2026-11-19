// サイト共通クローム（ヘッダー/フッター）の出し分けに使う純粋ロジック。
// app/SiteChrome.tsx（クライアント）から使う。
//
// One Prompter は AGO BOT の一機能ではなく、独立サービス化を前提にした
// 別サービスのデモ（ユーザー決定 2026-11-10）。そのため /one-prompter では
// サイト共通のヘッダー/フッター/ナビを出さず、画面は One Prompter 単独名義で
// 完結させる（外枠は app/one-prompter/layout.tsx が持つ）。

/** 共通クロームを出さないパス（このパス自体と、その配下すべて）。 */
export const CHROMELESS_PATHS: readonly string[] = [
  "/one-prompter",
  // viewslopper も独立サービス（Slop Score の産出と診断）のため、画面は単独名義で完結させる。
  "/viewslopper",
  // ポートフォリオ枠（1人1ファイル割り当て）。各ページは専用ヘッダー/
  // フッターを含めてページ内で完結させるため、共通クロームは出さない。
  "/folio",
  // AGO WORLD BOX は独立シェル（.wb-shell、100svh 全画面）で完結させる
  // ゲーム画面のため、共通ヘッダー/フッターは出さない。戻り導線は
  // 画面内の ≡ メニューに一本化する（docs/world-box-shared.md）。
  "/games/worldbox",
  // LLL（写真AIカードバトル）も独立シェル（.lll-shell）で画面幅を広く使い切るため、
  // サイト共通ヘッダー/フッターは出さず、アプリバーと独立フッターに一本化する。
  "/games/lll",
  // dreaming は終わりなき夢空間に没入する独立シェル（.dreaming-shell、100svh 全画面）
  // のため、サイト共通ヘッダー/フッターを出さず専用バーから /games へ戻す。
  "/games/dreaming",
];

/** 指定パスでサイト共通クロームを省くかどうか。 */
export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PATHS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}

// 最終CTA帯（フッター直前）とスマホ下部固定CTAバーの出し分け。
// 公開ページにだけ出し、アプリ画面・特殊ツール画面・ポリシー系・審査用
// ページには出さない。「公開ページの入口は共通レイアウト内1か所だけ」の
// 規則（lib/site.ts）と衝突しないよう、帯の行き先は招待（外部）と
// サポートサーバー（同名重複が認められている唯一の外部導線）に限る。

/** CTA帯・下部バーを出さないパス（このパス自体と、その配下すべて）。 */
export const CTA_BAND_EXCLUDED_PATHS: readonly string[] = [
  // アプリ画面（ログイン必須・運用系）
  "/dashboard",
  "/admin",
  "/login",
  // アクティビティ画面と独立ツール/ゲーム画面
  "/activity",
  "/coder",
  // ポリシー・サイト情報（読み物として単独で完結させる）
  "/terms",
  "/privacy",
  "/credits",
  "/about",
  // Discord 審査用の証跡ページ（販促導線を置かない）
  "/intents",
];

/** アクティビティのプロキシ配下（/.proxy/…）を通常パスへ寄せてから判定する。 */
function normalizeChromePath(pathname: string): string {
  if (pathname === "/.proxy") return "/";
  if (pathname.startsWith("/.proxy/")) return pathname.slice("/.proxy".length);
  return pathname;
}

/** 指定パスで最終CTA帯とスマホ下部固定CTAバーを出すかどうか。 */
export function showsCtaBand(pathname: string): boolean {
  const path = normalizeChromePath(pathname);
  if (isChromelessPath(path)) return false;
  return !CTA_BAND_EXCLUDED_PATHS.some(
    (base) => path === base || path.startsWith(`${base}/`),
  );
}
