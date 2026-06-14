/**
 * scripts/upload-corpus.ts
 *
 * Uploads the committed CA `.gov` source texts in `corpus/` into the Cloudflare
 * AI Search index used for grounded answers.
 *
 * Usage:
 *   npx tsx scripts/upload-corpus.ts
 *
 * Required env vars:
 *   CF_ACCOUNT_ID        — Cloudflare account ID
 *   CF_API_TOKEN         — API token with AI Search:Edit + AI Search:Run
 *   AI_SEARCH_NAMESPACE  — (optional) defaults to "dueprocess-ca"
 *   AI_SEARCH_INSTANCE   — (optional) defaults to "dueprocess-prod"
 *
 * The script:
 * 1. Creates the AI Search instance (if missing) in the given namespace.
 * 2. Updates the instance custom_metadata schema for title/url/source_type.
 * 3. Uploads every .md in corpus/ (except MISSING.md) as an item with metadata.
 * 4. Polls until all items are indexed.
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
// Config

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const NAMESPACE = process.env.AI_SEARCH_NAMESPACE ?? "dueprocess-ca";
const INSTANCE = process.env.AI_SEARCH_INSTANCE ?? "dueprocess-prod";
const CORPUS_DIR = path.resolve(__dirname, "../corpus");

const CUSTOM_METADATA_SCHEMA = [
  { field_name: "title", data_type: "text" },
  { field_name: "url", data_type: "text" },
  { field_name: "source_type", data_type: "text" },
];

/* ------------------------------------------------------------------ */
// Helpers

function apiUrl(route: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${route}`;
}

async function apiFetch(route: string, init?: RequestInit) {
  const res = await fetch(apiUrl(route), {
    ...init,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as any;
  if (!res.ok || !data.success) {
    const msg = data.errors?.[0]?.message ?? JSON.stringify(data);
    throw new Error(`Cloudflare API error (${res.status}): ${msg}`);
  }
  return data;
}

interface FrontMatter {
  title: string;
  url: string;
  retrieved_at: string;
  source_type: string;
}

function parseFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Missing front-matter");
  const raw = match[1];
  const body = match[2].trim();
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return {
    meta: {
      title: meta.title ?? "",
      url: meta.url ?? "",
      retrieved_at: meta.retrieved_at ?? "",
      source_type: meta.source_type ?? "",
    },
    body,
  };
}

/* ------------------------------------------------------------------ */
// Instance lifecycle

async function getOrCreateInstance(): Promise<void> {
  console.log(`Ensuring instance "${INSTANCE}" in namespace "${NAMESPACE}"...`);

  // Try to get existing instance
  try {
    await apiFetch(`/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE}`);
    console.log("  Instance exists.");
  } catch {
    console.log("  Creating instance...");
    await apiFetch(`/ai-search/namespaces/${NAMESPACE}/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: INSTANCE }),
    });
    console.log("  Created.");
  }

  // Update custom metadata schema
  console.log("  Updating custom_metadata schema...");
  await apiFetch(`/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ custom_metadata: CUSTOM_METADATA_SCHEMA }),
  });
  console.log("  Schema updated.");
}

/* ------------------------------------------------------------------ */
// Upload

async function uploadFile(filePath: string, key: string): Promise<void> {
  const text = fs.readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontMatter(text);

  const form = new FormData();
  form.append(
    "file",
    new Blob([text], { type: "text/markdown" }),
    key
  );
  form.append(
    "metadata",
    JSON.stringify({
      title: meta.title,
      url: meta.url,
      source_type: meta.source_type,
    })
  );

  await apiFetch(
    `/ai-search/namespaces/${NAMESPACE}/instances/${INSTANCE}/items`,
    {
      method: "POST",
      body: form,
    }
  );

  console.log(`  Uploaded: ${key} (${meta.title})`);
}

/* ------------------------------------------------------------------ */
// Main

async function main(): Promise<void> {
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error("Missing required env vars: CF_ACCOUNT_ID, CF_API_TOKEN");
    process.exit(1);
  }

  const files = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MISSING.md" && f !== "README.md")
    .sort();

  if (files.length === 0) {
    console.error(`No .md corpus files found in ${CORPUS_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} corpus file(s).`);

  await getOrCreateInstance();

  console.log("Uploading corpus files...");
  for (const f of files) {
    const fp = path.join(CORPUS_DIR, f);
    await uploadFile(fp, f);
  }

  console.log("\nDone. All files queued for indexing.");
  console.log(
    `Check the Cloudflare dashboard (AI > AI Search > ${INSTANCE}) for indexing status.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
