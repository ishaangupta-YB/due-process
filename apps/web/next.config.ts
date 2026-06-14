import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node.js runtime (not Edge) — OpenNext Cloudflare uses Node compat.
  // See SETUP_AND_OPS.md §4.
};

export default nextConfig;

// Expose Cloudflare bindings (DB, DOCS_BUCKET, AI, AI Search, CASE_DO) to
// `getCloudflareContext()` during local `next dev`.
// Verify import path against https://opennext.js.org/cloudflare before changing.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
// Dev-only: opens a remote-binding proxy that needs Cloudflare auth. Guarding it to
// development lets `next build` run without `wrangler login` / CLOUDFLARE_API_TOKEN,
// with zero change to `next dev` behaviour (standard OpenNext pattern).
if (process.env.NODE_ENV === "development") {
  initOpenNextCloudflareForDev();
}
