// 専用サブドメインの振り分け（middleware から使う純粋ロジック）。
//
// 専用サブドメインのルートは、本体サイト上の公開パスへリダイレクトする。
// 現在の割り当て:
// - oneprompter.agobot.app → /one-prompter（One Prompter）
// - viewslopper.agobot.app → /viewslopper（viewslopper）
// - deshihito.agobot.app  → /folio/deshihito（ポートフォリオ枠・1人1ファイル）
// - tadanoen.agobot.app   → /folio/tadanoen（ポートフォリオ枠・1人1ファイル）
//
// rewrite ではなく redirect にしている理由（2026-11-10 の 500 障害）:
// Cloudflare Tunnel 配下では Next の nextUrl は X-Forwarded-Proto を拾って
// https://localhost:3000 の形になる。その URL への rewrite は、実サーバー
// （http://localhost:3000）とは別オリジン扱いになり、Next が外部プロキシと
// して https で自サーバーを取りに行って TLS エラー（EPROTO）で 500 になる。
// 公開 URL への redirect ならプロキシ判定を経由しないため壊れない。

/** One Prompter 専用サブドメインのホスト名。 */
export const ONE_PROMPTER_HOST = "oneprompter.agobot.app";

/** サブドメインのルートの飛ばし先パス（本体サイトでの公開パス）。 */
export const ONE_PROMPTER_PATH = "/one-prompter";

/**
 * 専用サブドメインの割り当て表（ホスト名 → 本体サイトでの公開パス）。
 * 新しい割り当てはここに1行足すだけ（ポートフォリオ枠の基底）。
 */
export const SUBDOMAIN_ROUTES: Readonly<Record<string, string>> = {
  [ONE_PROMPTER_HOST]: ONE_PROMPTER_PATH,
  "viewslopper.agobot.app": "/viewslopper",
  "deshihito.agobot.app": "/folio/deshihito",
  "tadanoen.agobot.app": "/folio/tadanoen",
};

/**
 * 実効ホストを決める。Cloudflare Tunnel 経由では元のホストが
 * X-Forwarded-Host（カンマ区切りの先頭）に入るので、そちらを優先する。
 */
export function effectiveHost(
  forwardedHost: string | null | undefined,
  hostname: string,
): string {
  return forwardedHost?.split(",")[0]?.trim() || hostname;
}

/**
 * 専用サブドメインのルートへのアクセスなら、飛ばし先の絶対 URL を返す。
 * それ以外は null（通常どおり表示する）。クエリ文字列はそのまま引き継ぐ。
 */
export function subdomainRedirectUrl(args: {
  pathname: string;
  forwardedHost: string | null | undefined;
  hostname: string;
  search: string;
}): string | null {
  if (args.pathname !== "/") return null;
  const host = effectiveHost(args.forwardedHost, args.hostname);
  const path = SUBDOMAIN_ROUTES[host];
  if (!path) return null;
  return `https://${host}${path}${args.search}`;
}

/** One Prompter 専用の後方互換ラッパー（subdomainRedirectUrl に委譲）。 */
export function onePrompterRedirectUrl(args: {
  pathname: string;
  forwardedHost: string | null | undefined;
  hostname: string;
  search: string;
}): string | null {
  const url = subdomainRedirectUrl(args);
  if (!url) return null;
  // 汎用版は全ホストを見るため、One Prompter のホスト以外は対象外に戻す。
  return effectiveHost(args.forwardedHost, args.hostname) === ONE_PROMPTER_HOST
    ? url
    : null;
}
