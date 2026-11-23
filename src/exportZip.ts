// Reads the export ZIP uploaded on the personal page.
import { strFromU8, unzipSync } from "fflate";
import type { ExportFiles } from "./types.ts";

/**
 * The only export files we ever read. profile.csv is included solely so
 * buildDataset can take the Username column; everything else in it is dropped.
 */
export const EXPORT_FILES = [
  "ratings.csv",
  "watched.csv",
  "watchlist.csv",
  "diary.csv",
  "reviews.csv",
  "likes/films.csv",
  "profile.csv",
] as const;

/** Largest single CSV we'll decompress; guards against zip bombs. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** True for a whitelisted file at the zip root or inside one wrapping folder. */
const wanted = (name: string) =>
  EXPORT_FILES.some((p) => name === p || (name.endsWith(`/${p}`) && name.split("/").length === p.split("/").length + 1));

/** Extracts the whitelisted CSVs from a Letterboxd export ZIP. Only those files are ever decompressed. */
export function filesFromZip(bytes: Uint8Array): ExportFiles {
  const entries = unzipSync(bytes, { filter: (f) => wanted(f.name) && f.originalSize <= MAX_FILE_BYTES });
  const names = Object.keys(entries);
  // Files are normally at the zip root; tolerate one wrapping folder.
  const anchor = names.find((n) => /^([^/]+\/)?(ratings|watched)\.csv$/.test(n));
  const prefix = anchor ? anchor.slice(0, anchor.lastIndexOf("/") + 1) : "";
  const files: ExportFiles = {};
  for (const p of EXPORT_FILES) {
    const entry = entries[prefix + p];
    if (entry) files[p] = strFromU8(entry);
  }
  return files;
}
