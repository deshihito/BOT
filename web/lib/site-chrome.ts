// サイト共通クローム（ヘッダー/フッター）の出し分けに使う純粋ロジック。
// app/SiteChrome.tsx（クライアント）から使う。
//
// One Prompter は AGO BOT の一機能ではなく、独立サービス化を前提にした
// 別サービスのデモ（ユーザー決定 2026-11-10）。そのため /one-prompter では
// サイト共通のヘッダー/フッター/ナビを出さず、画面は One Prompter 単独名義で
// 完結させる（外枠は app/one-prompter/layout.tsx が持つ）。

/** 共通クロームを出さないパス（このパス自体と、その配下すべて）。 */
export const CHROMELESS_PATHS: readonly string[] = ["/one-prompter"];

/** 指定パスでサイト共通クロームを省くかどうか。 */
export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PATHS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}
