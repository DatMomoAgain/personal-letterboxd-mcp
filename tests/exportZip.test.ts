import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EXPORT_FILES, filesFromZip } from "../src/exportZip.ts";

const RATINGS = "Date,Name,Year,Letterboxd URI,Rating\n2025-12-25,Heat,1995,https://boxd.it/h,4\n";
const WATCHED = "Date,Name,Year,Letterboxd URI\n2025-12-25,Heat,1995,https://boxd.it/h\n";
const DIARY = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n";
const DELETED = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2020-01-01,Gone,2000,x,1,,,\n";

const sample: Record<string, string> = {
  "ratings.csv": RATINGS,
  "watched.csv": WATCHED,
  "diary.csv": DIARY,
  "comments.csv": "Date,Content,Comment\n",
  "deleted/diary.csv": DELETED,
  "likes/films.csv": WATCHED,
};
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, strToU8(t)])));

describe("filesFromZip", () => {
  it("whitelist is exactly the export files we use", () => {
    expect([...EXPORT_FILES].sort()).toEqual(
      ["diary.csv", "likes/films.csv", "profile.csv", "ratings.csv", "reviews.csv", "watched.csv", "watchlist.csv"],
    );
  });

  it("reads a zip", () => {
    const files = filesFromZip(zip(sample));
    expect(Object.keys(files).sort()).toEqual(["diary.csv", "likes/films.csv", "ratings.csv", "watched.csv"]);
    expect(files["watched.csv"]).toBe(WATCHED);
  });

  it("reads a zip whose files sit in one top-level folder", () => {
    const files = filesFromZip(zip({ "letterboxd-x/ratings.csv": RATINGS, "letterboxd-x/deleted/diary.csv": DELETED }));
    expect(Object.keys(files)).toEqual(["ratings.csv"]);
  });

  it("ignores non-whitelisted files", () => {
    const files = filesFromZip(zip(sample));
    expect(files["comments.csv"]).toBeUndefined();
    expect(files["deleted/diary.csv"]).toBeUndefined();
    expect(files["diary.csv"]).toBe(DIARY);
  });
});
