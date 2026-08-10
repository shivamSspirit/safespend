import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Vercel supplies its own Next.js deployment adapter. Its build expects the
  // normal trace output, while the Render Docker image needs standalone output.
  ...(process.env.SAFESPEND_DEPLOY_TARGET === "render" ? { output: "standalone" } : {}),
};

export default nextConfig;
