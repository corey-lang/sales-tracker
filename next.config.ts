import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf bundles a serverless pdf.js build used only by the server-side
  // Coverage Intelligence extraction route. Keep it external so Next requires
  // it from node_modules at runtime instead of bundling pdf.js internals.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
