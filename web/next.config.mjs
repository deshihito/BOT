/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Bot のリポジトリと同居するので、web/ の外のファイルは追跡しない
  outputFileTracingRoot: import.meta.dirname,
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
