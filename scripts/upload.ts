// Usage: npm run upload -- <export folder or .zip> [--dry-run]
// Parses a Letterboxd export and uploads it to Cloudflare KV (key "dataset").
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "../src/dataset.ts";
import { readExport } from "../src/readExport.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: npm run upload -- <export folder or .zip> [--dry-run]");
    process.exit(2);
  }

  const dataset = buildDataset(await readExport(resolve(path)), new Date().toISOString());
  const summary =
    `${dataset.ratings.length} rated, ${dataset.watched.length} watched, ` +
    `${dataset.watchlist.length} on watchlist, ${dataset.diary.length} diary, ${dataset.reviews.length} reviews`;

  if (dryRun) {
    console.log(`Dry run (nothing uploaded): ${summary}`);
    return;
  }

  const tmp = join(tmpdir(), `letterboxd-dataset-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(dataset), { mode: 0o600 });
  try {
    const res = spawnSync(
      "npx",
      ["wrangler", "kv", "key", "put", "dataset", "--path", tmp, "--binding", "LETTERBOXD", "--remote"],
      { cwd: projectRoot, stdio: "inherit" },
    );
    if (res.status !== 0) {
      console.error("Upload failed (see wrangler output above). Are you logged in? Try: npx wrangler login");
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`Uploaded: ${summary} (as of ${dataset.uploadedAt})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
