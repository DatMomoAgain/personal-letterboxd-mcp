import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { EXPORT_FILES, readExport } from "../src/readExport.ts";

const RATINGS = "Date,Name,Year,Letterboxd URI,Rating\n2025-12-25,Heat,1995,https://boxd.it/h,4\n";
const WATCHED = "Date,Name,Year,Letterboxd URI\n2025-12-25,Heat,1995,https://boxd.it/h\n";
const DIARY = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n";
const DELETED = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2020-01-01,Gone,2000,x,1,,,\n";

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "lbx-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const sample: Record<string, string> = {
  "ratings.csv": RATINGS,
  "watched.csv": WATCHED,
  "diary.csv": DIARY,
  "comments.csv": "Date,Content,Comment\n",
  "deleted/diary.csv": DELETED,
  "likes/films.csv": WATCHED,
};

describe("readExport", () => {
  it("whitelist is exactly the export files we use", () => {
    expect([...EXPORT_FILES].sort()).toEqual(
      ["diary.csv", "likes/films.csv", "profile.csv", "ratings.csv", "reviews.csv", "watched.csv", "watchlist.csv"],
    );
  });

  it("reads a folder", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "deleted"));
    mkdirSync(join(dir, "likes"));
    for (const [p, text] of Object.entries(sample)) writeFileSync(join(dir, p), text);
    const files = await readExport(dir);
    expect(Object.keys(files).sort()).toEqual(["diary.csv", "likes/films.csv", "ratings.csv", "watched.csv"]);
    expect(files["ratings.csv"]).toBe(RATINGS);
  });

  it("reads a zip", async () => {
    const zipPath = join(tmp(), "export.zip");
    writeFileSync(zipPath, zipSync(Object.fromEntries(Object.entries(sample).map(([p, t]) => [p, strToU8(t)]))));
    const files = await readExport(zipPath);
    expect(Object.keys(files).sort()).toEqual(["diary.csv", "likes/films.csv", "ratings.csv", "watched.csv"]);
    expect(files["watched.csv"]).toBe(WATCHED);
  });

  it("reads a zip whose files sit in one top-level folder", async () => {
    const zipPath = join(tmp(), "export.zip");
    writeFileSync(
      zipPath,
      zipSync({ "letterboxd-x/ratings.csv": strToU8(RATINGS), "letterboxd-x/deleted/diary.csv": strToU8(DELETED) }),
    );
    const files = await readExport(zipPath);
    expect(Object.keys(files)).toEqual(["ratings.csv"]);
  });

  it("ignores non-whitelisted files", async () => {
    const zipPath = join(tmp(), "export.zip");
    writeFileSync(zipPath, zipSync(Object.fromEntries(Object.entries(sample).map(([p, t]) => [p, strToU8(t)]))));
    const files = await readExport(zipPath);
    expect(files["comments.csv"]).toBeUndefined();
    expect(files["deleted/diary.csv"]).toBeUndefined();
    expect(files["diary.csv"]).toBe(DIARY);
  });

  it("missing path gives a readable error", async () => {
    await expect(readExport("/nope/not-here")).rejects.toThrow("Export not found: /nope/not-here");
  });
});
