/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep `next build` and `next dev` in SEPARATE output dirs. They both
  // write to `.next` by default, so running a build while the dev server
  // is live corrupts its webpack chunks (MODULE_NOT_FOUND './xxx.js').
  // The `build` npm script sets NEXT_DIST_DIR=.next-build; dev uses `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Docker builds (web/Dockerfile) set NEXT_STANDALONE=1 to emit a
  // self-contained server in .next/standalone; Vercel and local builds don't.
  ...(process.env.NEXT_STANDALONE === "1" ? { output: "standalone" } : {}),
};

export default nextConfig;
