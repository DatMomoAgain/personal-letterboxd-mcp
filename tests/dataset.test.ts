import { describe, expect, it } from "vitest";
import { buildDataset } from "../src/dataset.ts";
import type { ExportFiles } from "../src/types.ts";

const UPLOADED = "2026-11-14T00:00:00.000Z";

const base = (): ExportFiles => ({
  "ratings.csv":
    "Date,Name,Year,Letterboxd URI,Rating\n" +
    "2025-12-25,Little Miss Sunshine,2006,https://boxd.it/29EW,3.5\n" +
    "2025-08-17,Mystery Film,,https://boxd.it/zzzz,2\n",
  "watched.csv":
    "Date,Name,Year,Letterboxd URI\n" +
    "2025-08-17,Little Miss Sunshine,2006,https://boxd.it/29EW\n",
});

describe("buildDataset", () => {
  it("maps ratings with numeric rating and year", () => {
    const d = buildDataset(base(), UPLOADED);
    expect(d.ratings[0]).toEqual({
      name: "Little Miss Sunshine",
      year: 2006,
      rating: 3.5,
      date: "2025-12-25",
      uri: "https://boxd.it/29EW",
    });
    expect(d.watched).toHaveLength(1);
  });

  it("empty year becomes null", () => {
    const d = buildDataset(base(), UPLOADED);
    expect(d.ratings[1].year).toBeNull();
  });

  it("diary rewatch and tags parsed", () => {
    const files = base();
    files["diary.csv"] =
      "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n" +
      '2025-10-01,The Witch,2015,https://boxd.it/9X0m,4,Yes,"horror, a24",2025-09-30\n' +
      "2025-10-02,Heat,1995,https://boxd.it/heat,,,,\n";
    const d = buildDataset(files, UPLOADED);
    expect(d.diary[0]).toMatchObject({
      rewatch: true,
      tags: ["horror", "a24"],
      rating: 4,
      watchedDate: "2025-09-30",
    });
    expect(d.diary[1]).toMatchObject({ rewatch: false, tags: [], rating: null, watchedDate: null });
  });

  it("missing optional files give empty arrays", () => {
    const d = buildDataset(base(), UPLOADED);
    expect(d.watchlist).toEqual([]);
    expect(d.diary).toEqual([]);
    expect(d.reviews).toEqual([]);
    expect(d.likedFilms).toEqual([]);
  });

  it("throws on non-export input", () => {
    expect(() => buildDataset({}, UPLOADED)).toThrow(
      "Not a Letterboxd export: ratings.csv and watched.csv are missing",
    );
  });

  it("username comes from profile.csv", () => {
    const files = base();
    files["profile.csv"] =
      "Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n" +
      "2025-08-17,DatMomoAgain,,,,,,,He / his,\n";
    expect(buildDataset(files, UPLOADED).username).toBe("DatMomoAgain");
  });

  it("dataset never contains profile fields", () => {
    const files = base();
    files["profile.csv"] =
      "Date Joined,Username,Given Name,Family Name,Email Address,Location,Website,Bio,Pronoun,Favorite Films\n" +
      "2025-08-17,DatMomoAgain,Momo,,x@example.com,,,secret bio,,\n";
    const json = JSON.stringify(buildDataset(files, UPLOADED));
    expect(json).not.toContain("x@example.com");
    expect(json).not.toContain("Momo\"");
    expect(json).not.toContain("secret bio");
  });

  it("uploadedAt is passed through", () => {
    expect(buildDataset(base(), UPLOADED).uploadedAt).toBe(UPLOADED);
  });
});
