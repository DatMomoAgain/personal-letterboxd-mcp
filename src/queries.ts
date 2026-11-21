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

// ---------- watched / diary / watchlist / reviews ----------

const highestFirst = (a: RatedFilm, b: RatedFilm) => b.rating - a.rating || byName(a, b);
const lowestFirst = (a: RatedFilm, b: RatedFilm) => a.rating - b.rating || byName(a, b);

/** Cuts long text to `max` characters, marking the cut with "…". */
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "…" : s);

export type WatchedSort = "date_desc" | "date_asc" | "rating_desc" | "rating_asc" | "year_desc" | "year_asc" | "title";

export interface WatchedOptions extends PageOptions {
  /** true: only rated films; false: only unrated ones. */
  rated?: boolean;
  minRating?: number;
  maxRating?: number;
  yearFrom?: number;
  yearTo?: number;
  /** YYYY-MM-DD: only films watched (any diary date, else the day marked watched) on or after this day. */
  watchedFrom?: string;
  /** YYYY-MM-DD: only films watched on or before this day. */
  watchedTo?: string;
  sort?: WatchedSort;
}

/** Reviews in get_watched are cut to this; get_reviews has the full text. */
export const WATCHED_REVIEW_CHARS = 300;

/** Ascending order with unknown values (null) last, in either direction. */
const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : (a - b) * dir;

const watchedSorters: Record<WatchedSort, (a: WatchedFilm, b: WatchedFilm) => number> = {
  date_desc: (a, b) => b.lastDate.localeCompare(a.lastDate) || byName(a, b),
  date_asc: (a, b) => a.lastDate.localeCompare(b.lastDate) || byName(a, b),
  rating_desc: (a, b) => nullsLast(a.rating, b.rating, -1) || byName(a, b),
  rating_asc: (a, b) => nullsLast(a.rating, b.rating, 1) || byName(a, b),
  year_desc: (a, b) => nullsLast(a.year, b.year, -1) || byName(a, b),
  year_asc: (a, b) => nullsLast(a.year, b.year, 1) || byName(a, b),
  title: byName,
};

/** A get_watched row: `watched` is dropped (always true), reviews are clipped. */
export type WatchedItem = Omit<WatchedFilm, "watched">;

/** Every watched film, rated or not: filterable, sortable (newest watch first by default), paginated. */
export function getWatched(d: Dataset, o: WatchedOptions): Page<WatchedItem> {
  const inRange = (day: string) => !!day && (o.watchedFrom === undefined || day >= o.watchedFrom) && (o.watchedTo === undefined || day <= o.watchedTo);
  const dated = o.watchedFrom !== undefined || o.watchedTo !== undefined;
  const filtered = getFilms(d).filter(
    (f) =>
      (o.rated === undefined || (f.rating !== null) === o.rated) &&
      (o.minRating === undefined || (f.rating !== null && f.rating >= o.minRating)) &&
      (o.maxRating === undefined || (f.rating !== null && f.rating <= o.maxRating)) &&
      (o.yearFrom === undefined || (f.year !== null && f.year >= o.yearFrom)) &&
      (o.yearTo === undefined || (f.year !== null && f.year <= o.yearTo)) &&
      (!dated || (f.diaryDates.length ? f.diaryDates : [f.lastDate]).some(inRange)),
  );
  const result = page(filtered.sort(watchedSorters[o.sort ?? "date_desc"]), o);
  return {
    ...result,
    items: result.items.map(({ watched: _, ...f }) => ({
      ...f,
      reviews: f.reviews.map((r) => ({ ...r, review: clip(r.review, WATCHED_REVIEW_CHARS) })),
    })),
  };
}

const diaryDay = (e: DiaryEntry) => e.watchedDate ?? e.date;

const newestFirst = (a: DiaryEntry, b: DiaryEntry) => diaryDay(b).localeCompare(diaryDay(a)) || byName(a, b);

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

export interface WatchedFilm extends SeenMatch {
  /** Latest diary date, else the day it was marked watched or rated. "" if unknown. */
  lastDate: string;
}

/** Every watched film (logged in the diary or not), most recently watched first. */
export function getFilms(d: Dataset): WatchedFilm[] {
  const marked = new Map<string, string>();
  for (const f of [...d.ratings, ...d.watched]) marked.set(f.uri, f.date);
  return [...allFilms(d).values()]
    .filter((f) => f.watched)
    .map((f) => ({ ...f, lastDate: f.diaryDates.at(-1) ?? marked.get(f.uri) ?? "" }))
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || byName(a, b));
}

/**
 * The watched film a stored title (a pick, a title record) is about: by its Letterboxd link when known,
 * else by title and a release year one off either way, closest year first.
 */
export function loggedFilmFinder(d: Dataset | null): (t: { title: string; year: number | null; letterboxdUri?: string }) => WatchedFilm | undefined {
  const films = d ? getFilms(d) : [];
  const byUri = new Map(films.map((f) => [f.uri, f]));
  const byTitle = new Map<string, WatchedFilm[]>();
  for (const f of films) {
    const k = normalizeTitle(f.name);
    byTitle.set(k, [...(byTitle.get(k) ?? []), f]);
  }
  return (t) => {
    if (t.letterboxdUri && byUri.has(t.letterboxdUri)) return byUri.get(t.letterboxdUri);
    const off = (f: WatchedFilm) => (t.year === null || f.year === null ? 0 : Math.abs(f.year - t.year));
    return byTitle
      .get(normalizeTitle(t.title))
      ?.filter((f) => off(f) <= 1)
      .sort((a, b) => off(a) - off(b))[0];
  };
}

export interface SeenResult {
  query: string;
  /** false when matches are partial title matches (or empty) — not proof the user saw this film. */
  exactMatch: boolean;
  matches: SeenMatch[];
}

export function hasSeen(d: Dataset, title: string, year?: number): SeenResult {
  return seenIn([...allFilms(d).values()], title, year);
}

/** has_seen for a list of films, merging the user's lists only once. */
export function hasSeenAll(d: Dataset, wanted: { title: string; year?: number }[]): (SeenResult & { year?: number })[] {
  const films = [...allFilms(d).values()];
  return wanted.map((w) => ({ ...seenIn(films, w.title, w.year), ...(w.year !== undefined && { year: w.year }) }));
}

function seenIn(films: SeenMatch[], title: string, year?: number): SeenResult {
  const q = normalizeTitle(title);
  if (!q) return { query: title, exactMatch: false, matches: [] };
  const exact = films.filter((f) => normalizeTitle(f.name) === q);
  let candidates = matchTitle(films, title);
  // Release years differ by one between sources (festival vs. wide release, TMDB vs. Letterboxd),
  // so a year within one either way counts; the closest year sorts first.
  const off = (f: SeenMatch) => (year === undefined || f.year === null ? 0 : Math.abs(f.year - year));
  if (year !== undefined) candidates = candidates.filter((f) => f.year !== null && off(f) <= 1);
  return {
    query: title,
    exactMatch: exact.length > 0 && candidates.length > 0,
    matches: candidates.sort((a, b) => off(a) - off(b) || byName(a, b)),
  };
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
export const SUMMARY_REVIEWS = 10;
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
    topRated: [...d.ratings].sort(highestFirst).slice(0, 20),
    lowestRated: [...d.ratings].sort(lowestFirst).slice(0, 10),
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
      review: clip(r.review, SUMMARY_REVIEW_CHARS),
    })),
  };
}
