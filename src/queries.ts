import type { Dataset, DatedFilm, DiaryEntry, Film, RatedFilm, Review } from "./types.ts";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page<T> {
  total: number;
  offset: number;
  items: T[];
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

function page<T>(all: T[], o: PageOptions): Page<T> {
  const limit = Math.min(Math.max(o.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(o.offset ?? 0, 0);
  return { total: all.length, offset, items: all.slice(offset, offset + limit) };
}

const byName = (a: Film, b: Film) => a.name.localeCompare(b.name) || (a.year ?? 0) - (b.year ?? 0);

// ---------- ratings / diary / watchlist / reviews ----------

export type RatingSort = "rating_desc" | "rating_asc" | "date_desc" | "year_desc";

export interface RatingsOptions extends PageOptions {
  minRating?: number;
  maxRating?: number;
  yearFrom?: number;
  yearTo?: number;
  sort?: RatingSort;
}

const ratingSorters: Record<RatingSort, (a: RatedFilm, b: RatedFilm) => number> = {
  rating_desc: (a, b) => b.rating - a.rating || byName(a, b),
  rating_asc: (a, b) => a.rating - b.rating || byName(a, b),
  date_desc: (a, b) => b.date.localeCompare(a.date) || byName(a, b),
  year_desc: (a, b) => (b.year ?? 0) - (a.year ?? 0) || byName(a, b),
};

export type RatedFilmWithReviews = RatedFilm & { reviews?: SeenMatch["reviews"] };

export function getRatings(d: Dataset, o: RatingsOptions): Page<RatedFilmWithReviews> {
  const filtered = d.ratings.filter(
    (f) =>
      (o.minRating === undefined || f.rating >= o.minRating) &&
      (o.maxRating === undefined || f.rating <= o.maxRating) &&
      (o.yearFrom === undefined || (f.year !== null && f.year >= o.yearFrom)) &&
      (o.yearTo === undefined || (f.year !== null && f.year <= o.yearTo)),
  );
  const result = page([...filtered].sort(ratingSorters[o.sort ?? "rating_desc"]), o);
  // Ratings use the film's URI, which is how allFilms keys films (reviews already merged in).
  const films = allFilms(d);
  return {
    ...result,
    items: result.items.map((f) => {
      const reviews = films.get(f.uri)?.reviews;
      return reviews?.length ? { ...f, reviews } : f;
    }),
  };
}

export interface DiaryOptions extends PageOptions {
  from?: string;
  to?: string;
}

const diaryDay = (e: DiaryEntry) => e.watchedDate ?? e.date;

const newestFirst = (a: DiaryEntry, b: DiaryEntry) => diaryDay(b).localeCompare(diaryDay(a)) || byName(a, b);

/**
 * Finds the review written for a diary entry. Letterboxd gives a review the same
 * log-entry URI as its diary row; fall back to title + year + watch date.
 */
function reviewLookup(d: Dataset): (e: DiaryEntry) => string | undefined {
  const byUri = new Map<string, string>();
  const byEntry = new Map<string, string>();
  const key = (e: DiaryEntry) => `${normalizeTitle(e.name)}|${e.year}|${diaryDay(e)}`;
  for (const r of d.reviews) {
    if (!r.review.trim()) continue;
    byUri.set(r.uri, r.review);
    byEntry.set(key(r), r.review);
  }
  return (e) => byUri.get(e.uri) ?? byEntry.get(key(e));
}

export type DiaryEntryWithReview = DiaryEntry & { review?: string };

export function getDiary(d: Dataset, o: DiaryOptions): Page<DiaryEntryWithReview> {
  const reviewFor = reviewLookup(d);
  const filtered = d.diary.filter((e) => {
    const day = diaryDay(e);
    return (o.from === undefined || day >= o.from) && (o.to === undefined || day <= o.to);
  });
  const result = page([...filtered].sort(newestFirst), o);
  return {
    ...result,
    items: result.items.map((e) => {
      const review = reviewFor(e);
      return review === undefined ? e : { ...e, review };
    }),
  };
}

export function getWatchlist(d: Dataset, o: PageOptions): Page<DatedFilm> {
  return page([...d.watchlist].sort((a, b) => b.date.localeCompare(a.date) || byName(a, b)), o);
}

export interface ReviewsOptions extends PageOptions {
  title?: string;
  minRating?: number;
  maxRating?: number;
}

/** Same forgiving title rules as has_seen: exact first, partial only for longer queries. */
function matchTitle<T extends Film>(items: T[], title: string): T[] {
  const q = normalizeTitle(title);
  if (!q) return [];
  const exact = items.filter((f) => normalizeTitle(f.name) === q);
  if (exact.length || [...q].length < MIN_PARTIAL_QUERY) return exact;
  return items.filter((f) => normalizeTitle(f.name).includes(q));
}

export function getReviews(d: Dataset, o: ReviewsOptions): Page<Review> {
  let reviews = d.reviews.filter((r) => r.review.trim());
  if (o.title) reviews = matchTitle(reviews, o.title);
  reviews = reviews.filter(
    (r) =>
      (o.minRating === undefined || (r.rating !== null && r.rating >= o.minRating)) &&
      (o.maxRating === undefined || (r.rating !== null && r.rating <= o.maxRating)),
  );
  return page([...reviews].sort(newestFirst), o);
}

// ---------- has_seen ----------

/** Letters that NFD does not decompose into a base letter + accent. */
const FOLDS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ł: "l", þ: "th", ð: "d" };

/**
 * Lowercase, fold accents (é→e, ø→o, æ→ae…), drop a leading English article,
 * keep only letters and digits of any script. "千と千尋の神隠し" stays matchable.
 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[øæœßđłþð]/g, (c) => FOLDS[c])
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Partial (substring) matching only kicks in for queries at least this long. */
const MIN_PARTIAL_QUERY = 5;

export interface SeenMatch extends Film {
  watched: boolean;
  rating: number | null;
  diaryDates: string[];
  onWatchlist: boolean;
  liked: boolean;
  /** The user's own words about this film, oldest viewing first. */
  reviews: { watchedDate: string; rating: number | null; review: string }[];
}

/** Every film the user has any record of, merged across lists by URI. */
function allFilms(d: Dataset): Map<string, SeenMatch> {
  const films = new Map<string, SeenMatch>();
  const get = (f: Film): SeenMatch => {
    let m = films.get(f.uri);
    if (!m) {
      m = { name: f.name, year: f.year, uri: f.uri, watched: false, rating: null, diaryDates: [], onWatchlist: false, liked: false, reviews: [] };
      films.set(f.uri, m);
    }
    return m;
  };
  // Film-URI lists first: watched, ratings, watchlist and likes all use the film's URI.
  for (const f of d.watched) get(f).watched = true;
  for (const f of d.ratings) Object.assign(get(f), { watched: true, rating: f.rating });
  for (const f of d.watchlist) get(f).onWatchlist = true;
  for (const f of d.likedFilms) get(f).liked = true;

  // Diary and review rows may carry the log entry's URI instead of the film's,
  // so fall back to matching the film by normalized title + year.
  const byTitleYear = new Map<string, SeenMatch>();
  for (const m of films.values()) byTitleYear.set(`${normalizeTitle(m.name)}|${m.year}`, m);
  const forEntry = (e: Film): SeenMatch =>
    films.get(e.uri) ?? byTitleYear.get(`${normalizeTitle(e.name)}|${e.year}`) ?? get(e);

  for (const e of d.diary) {
    const m = forEntry(e);
    m.watched = true;
    m.diaryDates.push(diaryDay(e));
  }
  for (const r of d.reviews) {
    const m = forEntry(r);
    m.watched = true;
    if (r.review.trim()) m.reviews.push({ watchedDate: diaryDay(r), rating: r.rating, review: r.review });
  }
  for (const m of films.values()) {
    m.diaryDates.sort();
    m.reviews.sort((a, b) => a.watchedDate.localeCompare(b.watchedDate));
  }
  return films;
}

export interface SeenResult {
  query: string;
  /** false when matches are partial title matches (or empty) — not proof the user saw this film. */
  exactMatch: boolean;
  matches: SeenMatch[];
}

export function hasSeen(d: Dataset, title: string, year?: number): SeenResult {
  const q = normalizeTitle(title);
  if (!q) return { query: title, exactMatch: false, matches: [] };
  const films = [...allFilms(d).values()];
  const exact = films.filter((f) => normalizeTitle(f.name) === q);
  let candidates = matchTitle(films, title);
  if (year !== undefined) candidates = candidates.filter((f) => f.year === year);
  return { query: title, exactMatch: exact.length > 0 && candidates.length > 0, matches: candidates.sort(byName) };
}

// ---------- taste summary ----------

const RATING_STEPS = ["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"] as const;
type RatingStep = (typeof RATING_STEPS)[number];

export interface TasteSummary {
  username: string;
  uploadedAt: string;
  counts: { watched: number; rated: number; watchlist: number; diary: number; reviews: number; liked: number };
  averageRating: number | null;
  ratingDistribution: Record<RatingStep, number>;
  topRated: RatedFilm[];
  lowestRated: RatedFilm[];
  decades: { decade: string; watched: number; averageRating: number | null }[];
  /** The user's own words, newest first, explaining why they liked or disliked things. */
  reviews: { name: string; year: number | null; watchedDate: string; rating: number | null; rewatch: boolean; review: string }[];
}

/** Keeps the summary bounded once the user has written a lot; get_reviews pages through the rest. */
export const SUMMARY_REVIEWS = 30;
export const SUMMARY_REVIEW_CHARS = 1500;

const avg1 = (xs: number[]): number | null =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

export function getTasteSummary(d: Dataset): TasteSummary {
  const watched = [...allFilms(d).values()].filter((f) => f.watched);

  const ratingDistribution = Object.fromEntries(RATING_STEPS.map((s) => [s, 0])) as Record<RatingStep, number>;
  for (const f of d.ratings) {
    const key = String(f.rating) as RatingStep;
    if (key in ratingDistribution) ratingDistribution[key]++;
  }

  const byDecade = new Map<number, SeenMatch[]>();
  for (const f of watched) {
    if (f.year === null) continue;
    const dec = Math.floor(f.year / 10) * 10;
    byDecade.set(dec, [...(byDecade.get(dec) ?? []), f]);
  }

  return {
    username: d.username,
    uploadedAt: d.uploadedAt,
    counts: {
      watched: watched.length,
      rated: d.ratings.length,
      watchlist: d.watchlist.length,
      diary: d.diary.length,
      reviews: d.reviews.length,
      liked: d.likedFilms.length,
    },
    averageRating: avg1(d.ratings.map((f) => f.rating)),
    ratingDistribution,
    topRated: [...d.ratings].sort(ratingSorters.rating_desc).slice(0, 20),
    lowestRated: [...d.ratings].sort(ratingSorters.rating_asc).slice(0, 10),
    decades: [...byDecade.entries()]
      .sort(([a], [b]) => a - b)
      .map(([dec, films]) => ({
        decade: `${dec}s`,
        watched: films.length,
        averageRating: avg1(films.flatMap((f) => (f.rating === null ? [] : [f.rating]))),
      })),
    reviews: getReviews(d, { limit: SUMMARY_REVIEWS }).items.map((r) => ({
      name: r.name,
      year: r.year,
      watchedDate: diaryDay(r),
      rating: r.rating,
      rewatch: r.rewatch,
      review: r.review.length > SUMMARY_REVIEW_CHARS ? r.review.slice(0, SUMMARY_REVIEW_CHARS) + "…" : r.review,
    })),
  };
}
