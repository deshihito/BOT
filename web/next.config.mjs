/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Bot のリポジトリと同居するので、web/ の外のファイルは追跡しない
  outputFileTracingRoot: import.meta.dirname,
};
export default nextConfig;
