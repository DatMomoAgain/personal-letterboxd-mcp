import { describe, expect, it } from "vitest";
import {
  MAX_LIMIT,
  getDiary,
  getRatings,
  getReviews,
  getTasteSummary,
  getWatchlist,
  hasSeen,
  normalizeTitle,
} from "../src/queries.ts";
import { fixture } from "./fixture.ts";

describe("getRatings", () => {
  it("getRatings filters by min rating and year range", () => {
    const page = getRatings(fixture(), { minRating: 4, yearFrom: 1990 });
    expect(page.items.map((f) => f.name)).toEqual(["Paddington 2", "Amélie", "Se7en"]);
    expect(page.total).toBe(3);
  });

  it("getRatings sorts and paginates", () => {
    const page = getRatings(fixture(), { limit: 2, offset: 2 });
    expect(page.total).toBe(6);
    expect(page.offset).toBe(2);
    expect(page.items.map((f) => `${f.name} ${f.year}`)).toEqual(["Se7en 1995", "Suspiria 1977"]);
    const asc = getRatings(fixture(), { sort: "rating_asc", limit: 1 });
    expect(asc.items[0].name).toBe("Cats");
  });

  it("getRatings clamps limit to 200", () => {
    const d = fixture();
    d.ratings = Array.from({ length: 250 }, (_, i) => ({
      name: `Film ${i}`,
      year: 2000,
      uri: `u${i}`,
      date: "2025-01-01",
      rating: 3,
    }));
    expect(MAX_LIMIT).toBe(200);
    expect(getRatings(d, { limit: 1000 }).items).toHaveLength(200);
    expect(getRatings(d, {}).items).toHaveLength(50);
  });
});

describe("getDiary / getWatchlist / getReviews", () => {
  it("getDiary filters by date range on watchedDate", () => {
    const page = getDiary(fixture(), { from: "2025-09-01", to: "2025-10-31" });
    expect(page.items.map((e) => e.name)).toEqual(["Paddington 2", "Se7en"]);
    // Cats has no watchedDate, so its log date 2025-11-01 is used.
    expect(getDiary(fixture(), { from: "2025-11-01" }).items.map((e) => e.name)).toEqual(["Cats"]);
  });

  it("getWatchlist returns watchlist films", () => {
    expect(getWatchlist(fixture(), {}).items.map((f) => f.name)).toEqual(["The Wailing"]);
  });

  it("getReviews filters by title", () => {
    expect(getReviews(fixture(), { title: "paddington 2" }).items).toHaveLength(1);
    expect(getReviews(fixture(), { title: "heat" }).items).toHaveLength(0);
    expect(getReviews(fixture(), {}).total).toBe(1);
  });

  const withReviews = () => {
    const d = fixture();
    const base = { date: "2025-11-14", rewatch: false, tags: [] };
    d.reviews = [
      { ...base, name: "Paddington 2", year: 2017, uri: "https://boxd.it/LOGp", watchedDate: "2025-10-05", rating: 5, review: "Perfect." },
      { ...base, name: "Cats", year: 2019, uri: "https://boxd.it/LOGc", watchedDate: "2025-11-01", rating: 1, review: "Nightmare fuel." },
      { ...base, name: "Se7en", year: 1995, uri: "https://boxd.it/LOGs", watchedDate: "2025-09-10", rating: 4, review: "   " },
    ];
    return d;
  };

  it("getReviews: partial titles, rating filter, newest first, blank reviews skipped", () => {
    const d = withReviews();
    expect(getReviews(d, {}).items.map((r) => r.name)).toEqual(["Cats", "Paddington 2"]);
    expect(getReviews(d, { title: "paddington" }).items.map((r) => r.name)).toEqual(["Paddington 2"]);
    expect(getReviews(d, { maxRating: 2 }).items.map((r) => r.name)).toEqual(["Cats"]);
    expect(getReviews(d, { limit: 1, offset: 1 }).items.map((r) => r.name)).toEqual(["Paddington 2"]);
  });

  it("getDiary attaches the review text to its entry", () => {
    const d = withReviews();
    // Paddington's diary row keeps the film URI, so this falls back to title + year + date.
    const byName = Object.fromEntries(getDiary(d, {}).items.map((e) => [e.name, e.review]));
    expect(byName).toEqual({ "Paddington 2": "Perfect.", Cats: "Nightmare fuel.", Se7en: undefined });
    // Same-URI match (how real exports look).
    d.diary[2].uri = "https://boxd.it/LOGc";
    d.diary[2].watchedDate = "2020-01-01";
    expect(getDiary(d, { to: "2020-12-31" }).items[0].review).toBe("Nightmare fuel.");
  });

  it("hasSeen and the taste summary carry the user's words", () => {
    const d = withReviews();
    expect(hasSeen(d, "Cats").matches[0].reviews).toEqual([
      { watchedDate: "2025-11-01", rating: 1, review: "Nightmare fuel." },
    ]);
    expect(hasSeen(d, "Se7en").matches[0].reviews).toEqual([]);
    const rated = Object.fromEntries(getRatings(d, {}).items.map((f) => [f.name, f.reviews]));
    expect(rated["Cats"]).toEqual([{ watchedDate: "2025-11-01", rating: 1, review: "Nightmare fuel." }]);
    expect(rated["Se7en"]).toBeUndefined();
    expect(getTasteSummary(d).reviews.map((r) => r.review)).toEqual(["Nightmare fuel.", "Perfect."]);
  });

  it("taste summary truncates very long reviews", () => {
    const d = withReviews();
    d.reviews[0].review = "x".repeat(5000);
    const long = getTasteSummary(d).reviews.find((r) => r.name === "Paddington 2")!;
    expect(long.review).toHaveLength(1501);
    expect(long.review.endsWith("…")).toBe(true);
  });
});

describe("hasSeen", () => {
  it("normalizeTitle strips accents, case, articles and punctuation", () => {
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(normalizeTitle("The Wailing")).toBe("wailing");
    expect(normalizeTitle("Paddington 2!")).toBe("paddington2");
  });

  it("has_seen normalizes titles", () => {
    expect(hasSeen(fixture(), "amelie").matches).toHaveLength(1);
    expect(hasSeen(fixture(), "SE7EN").matches[0]).toMatchObject({
      watched: true,
      rating: 4,
      diaryDates: ["2025-09-10"],
    });
    const wailing = hasSeen(fixture(), "wailing");
    expect(wailing.matches).toHaveLength(1);
    expect(wailing.matches[0]).toMatchObject({ watched: false, onWatchlist: true, rating: null });
  });

  it("has_seen returns all year variants", () => {
    expect(hasSeen(fixture(), "suspiria").matches).toHaveLength(2);
    const only2018 = hasSeen(fixture(), "Suspiria", 2018);
    expect(only2018.matches).toHaveLength(1);
    expect(only2018.matches[0]).toMatchObject({ year: 2018, rating: 3 });
  });

  it("has_seen accepts a year one off either way, closest year first", () => {
    expect(hasSeen(fixture(), "Se7en", 1996)).toMatchObject({ exactMatch: true, matches: [{ year: 1995 }] });
    expect(hasSeen(fixture(), "Se7en", 1994).exactMatch).toBe(true);
    expect(hasSeen(fixture(), "Se7en", 1997)).toMatchObject({ exactMatch: false, matches: [] });
    // Both Suspirias are far apart, so a year still picks one.
    expect(hasSeen(fixture(), "Suspiria", 2019).matches.map((m) => m.year)).toEqual([2018]);
  });

  it("has_seen watched but unrated", () => {
    expect(hasSeen(fixture(), "Heat").matches[0]).toMatchObject({
      watched: true,
      rating: null,
      liked: true,
    });
  });

  it("has_seen falls back to partial match", () => {
    const res = hasSeen(fixture(), "paddington");
    expect(res.matches.map((m) => m.name)).toEqual(["Paddington 2"]);
    expect(res.exactMatch).toBe(false);
    expect(hasSeen(fixture(), "amelie").exactMatch).toBe(true);
  });

  it("has_seen does not treat 'Her' as Hereditary", () => {
    const d = fixture();
    d.watched.push({ name: "Hereditary", year: 2018, uri: "https://boxd.it/hd", date: "2025-08-17" });
    const res = hasSeen(d, "Her");
    expect(res.exactMatch).toBe(false);
    // Short queries (< 5 normalized chars) never fall back to partial matching.
    expect(res.matches).toEqual([]);
  });

  it("non-Latin and punctuation-only titles do not match each other", () => {
    const d = fixture();
    d.watched.push(
      { name: "千と千尋の神隠し", year: 2001, uri: "https://boxd.it/jp", date: "2025-08-17" },
      { name: "Ёлки", year: 2010, uri: "https://boxd.it/ru", date: "2025-08-17" },
      { name: "Søndag", year: 2020, uri: "https://boxd.it/dk", date: "2025-08-17" },
      { name: "Æon Flux", year: 2005, uri: "https://boxd.it/ae", date: "2025-08-17" },
    );
    expect(hasSeen(d, "Солярис").matches).toEqual([]);
    expect(hasSeen(d, "?").matches).toEqual([]);
    expect(hasSeen(d, "千と千尋の神隠し").matches.map((m) => m.uri)).toEqual(["https://boxd.it/jp"]);
    expect(hasSeen(d, "sondag").matches.map((m) => m.uri)).toEqual(["https://boxd.it/dk"]);
    expect(hasSeen(d, "aeon flux").matches.map((m) => m.uri)).toEqual(["https://boxd.it/ae"]);
  });

  it("diary entries with their own URI merge into the film by title + year", () => {
    const d = fixture();
    // Letterboxd diary/review rows can carry the log entry's URI, not the film's.
    d.diary = [
      { name: "Se7en", year: 1995, uri: "https://boxd.it/LOG1", date: "2025-09-11", watchedDate: "2025-09-10", rating: 4, rewatch: false, tags: [] },
    ];
    d.reviews = [
      { name: "Paddington 2", year: 2017, uri: "https://boxd.it/REV1", date: "2025-10-06", watchedDate: "2025-10-05", rating: 5, rewatch: true, tags: [], review: "Perfect." },
    ];
    const se7en = hasSeen(d, "Se7en").matches;
    expect(se7en).toHaveLength(1);
    expect(se7en[0]).toMatchObject({ uri: "https://boxd.it/s7", rating: 4, diaryDates: ["2025-09-10"] });
    expect(hasSeen(d, "Paddington 2").matches).toHaveLength(1);
    expect(getTasteSummary(d).counts.watched).toBe(7);
  });

  it("has_seen unknown title returns empty matches", () => {
    expect(hasSeen(fixture(), "Mulholland Drive")).toEqual({
      query: "Mulholland Drive",
      exactMatch: false,
      matches: [],
    });
  });
});

describe("getTasteSummary", () => {
  it("taste summary counts, distribution, decades and average", () => {
    const s = getTasteSummary(fixture());
    expect(s.username).toBe("DatMomoAgain");
    expect(s.uploadedAt).toBe("2026-11-14T00:00:00.000Z");
    expect(s.counts).toEqual({ watched: 7, rated: 6, watchlist: 1, diary: 3, reviews: 1, liked: 1 });
    expect(s.averageRating).toBe(3.6);
    expect(s.ratingDistribution).toEqual({
      "0.5": 0, "1": 1, "1.5": 0, "2": 0, "2.5": 0, "3": 1, "3.5": 0, "4": 2, "4.5": 1, "5": 1,
    });
    expect(s.topRated[0].name).toBe("Paddington 2");
    expect(s.lowestRated[0].name).toBe("Cats");
    expect(s.decades).toEqual([
      { decade: "1970s", watched: 1, averageRating: 4 },
      { decade: "1990s", watched: 2, averageRating: 4 },
      { decade: "2000s", watched: 1, averageRating: 4.5 },
      { decade: "2010s", watched: 3, averageRating: 3 },
    ]);
  });

  it("taste summary of an empty dataset", () => {
    const d = fixture();
    d.ratings = [];
    d.watched = [];
    d.diary = [];
    d.reviews = [];
    const s = getTasteSummary(d);
    expect(s.averageRating).toBeNull();
    expect(s.decades).toEqual([]);
  });
});
