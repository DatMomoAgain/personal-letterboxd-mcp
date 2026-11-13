// Node-only: used by scripts/upload.ts, never bundled into the Worker.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_FILES, filesFromZip } from "./exportZip.ts";
import type { ExportFiles } from "./types.ts";

export { EXPORT_FILES };

/** Reads the whitelisted CSVs from an export folder or .zip. */
export async function readExport(path: string): Promise<ExportFiles> {
  if (!existsSync(path)) throw new Error(`Export not found: ${path}`);
  return statSync(path).isDirectory() ? readFolder(path) : filesFromZip(readFileSync(path));
}

function readFolder(dir: string): ExportFiles {
  const files: ExportFiles = {};
  for (const p of EXPORT_FILES) {
    const full = join(dir, p);
    if (existsSync(full)) files[p] = readFileSync(full, "utf8");
  }
  return files;
}
