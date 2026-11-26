/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    // ビルドワーカーの並列数を Pi の 4 コア中 2 本までに制限する。
    // 無制限だと静的生成ワーカーだけで CPU 150% 超・メモリ約 1GB を使い、
    // 同居する Bot 本体（約 950MB）と合わせてスワップスラッシングを起こし
    // Bot の応答が止まる（2026-11-26 に実測）。deploy/deploy-web.sh 側の
    // CPU 親和性・優先度制限と対で効かせる。
    cpus: 2,
  },
  // Bot のリポジトリと同居するので、web/ の外のファイルは追跡しない
  outputFileTracingRoot: import.meta.dirname,
  // 旧パス・通称パスからの流入を現行ページへ寄せる（Search Console の
  // 404 検出対策。2026-11-19 に /worldbox 等が 404 で検出された）。
  // 恒久移転は permanent、新規の正は sitemap 側にある。
  async redirects() {
    return [
      { source: "/worldbox", destination: "/games/worldbox", permanent: true },
      { source: "/games/world-box", destination: "/games/worldbox", permanent: true },
      { source: "/home", destination: "/", permanent: true },
      { source: "/support", destination: "/faq", permanent: true },
      // サポートサーバーへの外部リンクは一時リダイレクト（招待先が変わりうる）
      { source: "/discord", destination: "https://discord.gg/dCAQzJUaa9", permanent: false },
    ];
  },
  // /games 配下だけは Discord アクティビティ（iframe 埋め込み）から開けるよう、
  // frame-ancestors で Discord ドメインを許可する。サイト全体のヘッダーは変えない。
  async headers() {
    const frameAncestors = {
      key: "Content-Security-Policy",
      value:
        "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com",
    };
    return [
      { source: "/games", headers: [frameAncestors] },
      { source: "/games/:path*", headers: [frameAncestors] },
    ];
  },
};
export default nextConfig;
