// Custom Worker entry (per https://opennext.js.org/cloudflare/howtos/custom-worker).
// Re-uses the OpenNext-generated fetch handler and re-exports the per-case Durable
// Object so the CASE_DO binding resolves at runtime.

// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

export default handler;

export { CaseDO } from "./durable-objects/case-do";
