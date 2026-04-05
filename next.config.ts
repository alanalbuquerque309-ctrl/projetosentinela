import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Evita aviso de lockfile na pasta mãe (ISA AI) quando corres `npm run build` daqui.
  turbopack: {
    root: path.resolve(process.cwd()),
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev-local",
  },
};

export default nextConfig;
