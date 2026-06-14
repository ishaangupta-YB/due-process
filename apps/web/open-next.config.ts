import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// OpenNext Cloudflare adapter config.
// The app is currently static (SSG). Per https://opennext.js.org/cloudflare/caching,
// SSG sites use the read-only Workers Static Assets incremental cache for prerendered
// routes (no Queue / Tag Cache needed). Revisit if/when we add ISR/revalidation.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
