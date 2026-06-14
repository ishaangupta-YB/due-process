/**
 * scripts/upload-corpus.ts
 *
 * Uploads the committed CA `.gov` source texts in `corpus/` into the Cloudflare
 * AI Search index used for grounded answers.
 *
 * STUB (P0): not implemented. Implemented in Wave 1 (P1-A) once the AI Search
 * binding / API is confirmed against https://developers.cloudflare.com/ai-search/.
 */

async function main(): Promise<void> {
  throw new Error("upload-corpus: not implemented (P0 stub)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
