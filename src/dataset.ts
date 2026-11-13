import { parseCsv } from "./csv.ts";
import type { Dataset, DatedFilm, DiaryEntry, ExportFiles, Film, RatedFilm, Review } from "./types.ts";

type Row = Record<string, string>;

const rowsOf = (files: ExportFiles, path: string): Row[] =>
  files[path] === undefined ? [] : parseCsv(files[path]);

const toYear = (s: string | undefined): number | null => {
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) ? n : null;
};

const toRating = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

const film = (r: Row): Film => ({
  name: r["Name"] ?? "",
  year: toYear(r["Year"]),
  uri: r["Letterboxd URI"] ?? "",
});

const dated = (r: Row): DatedFilm => ({ ...film(r), date: r["Date"] ?? "" });

const diaryEntry = (r: Row): DiaryEntry => ({
  ...dated(r),
  watchedDate: r["Watched Date"] || null,
  rating: toRating(r["Rating"]),
  rewatch: r["Rewatch"] === "Yes",
  tags: r["Tags"] ? r["Tags"].split(", ").filter(Boolean) : [],
});

/**
 * Turns the export CSVs into one Dataset. From profile.csv only the Username
 * column is read; every other profile field (email, name, bio…) is dropped.
 */
export function buildDataset(files: ExportFiles, uploadedAt: string): Dataset {
  if (files["ratings.csv"] === undefined && files["watched.csv"] === undefined) {
    throw new Error("Not a Letterboxd export: ratings.csv and watched.csv are missing");
  }

  const ratings: RatedFilm[] = [];
  for (const r of rowsOf(files, "ratings.csv")) {
    const rating = toRating(r["Rating"]);
    if (rating !== null) ratings.push({ ...dated(r), rating });
  }

  const reviews: Review[] = rowsOf(files, "reviews.csv").map((r) => ({
    ...diaryEntry(r),
    review: r["Review"] ?? "",
  }));

  return {
    username: rowsOf(files, "profile.csv")[0]?.["Username"] ?? "",
    uploadedAt,
    ratings,
    watched: rowsOf(files, "watched.csv").map(dated),
    watchlist: rowsOf(files, "watchlist.csv").map(dated),
    diary: rowsOf(files, "diary.csv").map(diaryEntry),
    reviews,
    likedFilms: rowsOf(files, "likes/films.csv").map(dated),
  };
}
