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
initOpenNextCloudflareForDev();
