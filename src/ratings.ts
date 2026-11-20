// IMDb / Rotten Tomatoes / Metacritic scores from OMDb, looked up by IMDb id (for the picks
// on the page, find_film and save_picks) and cached in KV.
//
// Only films released more than a year ago are cached, and re-checked weekly. A newer film's
// scores still move a lot, so it is looked up fresh every time.
//
// Lookups are always by IMDb id, never by title: a title search can land on an obscure
// namesake with no scores.

export const RATINGS_KEY = "ratings";
/** OMDb lookups per page view: one request each. Workers Free allows 50 subrequests per view, shared with up to 30 TMDB poster lookups. */
export const MAX_RATING_LOOKUPS_PER_VIEW = 10;
/** Re-check cached scores, and ids OMDb didn't know, after this long. */
const REFRESH_MS = 7 * 86_400_000;
/** Films released longer ago than this get cached. */
const CACHE_AFTER_MS = 365 * 86_400_000;

export const IMDB_ID = /^tt\d{5,10}$/;

export interface Scores {
  imdbId: string;
  /** "7.8" */
  imdb?: string;
  /** How many IMDb users rated it. */
  votes?: number;
  /** "94%" */
  rt?: string;
  /** "80" (out of 100) */
  mc?: string;
}

/** What OMDb has under an IMDb id: enough to check it's the film that was meant. */
export interface OmdbTitle {
  title: string;
  /** "2015", or "2024–" for a series. */
  year: string;
  /** Release date YYYY-MM-DD (Dec 31 of the year when OMDb has no exact date), or null if unknown. */
  released: string | null;
  scores: Scores;
}

/** Only films released over a year ago are stored, with their release date. Entries without one predate this rule and get re-checked. */
type CacheEntry = (Scores & { checked: string; released?: string }) | { miss: string };
/** IMDb id → scores. */
export type RatingsCache = Record<string, CacheEntry>;
/** IMDb id → scores, for the ids OMDb knows. */
export type Ratings = Map<string, Scores>;

interface OmdbResponse {
  Response?: string;
  Error?: string;
  Title?: string;
  Year?: string;
  imdbID?: string;
  imdbRating?: string;
  imdbVotes?: string;
  Released?: string;
  Ratings?: { Source?: string; Value?: string }[];
}

/** Keep only values in the exact shapes we expect, so nothing odd reaches the page. */
function toScores(imdbId: string, body: OmdbResponse): Scores {
  const source = (name: string) => body.Ratings?.find((r) => r.Source === name)?.Value ?? "";
  const imdb = /^(10|\d)\.\d$/.exec(body.imdbRating ?? "")?.[0];
  const votesText = /^\d{1,3}(,\d{3})*$/.exec(body.imdbVotes ?? "")?.[0];
  const votes = votesText ? Number(votesText.replaceAll(",", "")) : undefined;
  const rt = /^(100|\d{1,2})%$/.exec(source("Rotten Tomatoes"))?.[0];
  const mc = /^(100|\d{1,2})\/100$/.exec(source("Metacritic"))?.[1];
  return { imdbId, ...(imdb && { imdb }), ...(votes !== undefined && { votes }), ...(rt && { rt }), ...(mc && { mc }) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** OMDb's "25 Dec 2015" as "2015-12-25"; falls back to the end of the year in "Year" ("2015", "2024–"). */
function releasedOf(body: OmdbResponse): string | null {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(body.Released ?? "");
  const month = m ? MONTHS.indexOf(m[2]) + 1 : 0;
  if (m && month) return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const year = /^\d{4}/.exec(body.Year ?? "")?.[0];
  return year ? `${year}-12-31` : null;
}

/** One OMDb lookup by IMDb id. null = OMDb has nothing under that id. Throws on any other problem (bad key, limit, network). */
export async function fetchOmdb(imdbId: string, key: string, fetcher: typeof fetch = fetch): Promise<OmdbTitle | null> {
  if (!IMDB_ID.test(imdbId)) return null;
  const q = new URLSearchParams({ apikey: key, i: imdbId });
  const res = await fetcher(`https://www.omdbapi.com/?${q}`, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as OmdbResponse;
  if (body.Response === "True") {
    return {
      title: String(body.Title ?? "").slice(0, 300),
      year: String(body.Year ?? "").slice(0, 20),
      released: releasedOf(body),
      scores: toScores(imdbId, body),
    };
  }
  if (res.ok && /incorrect imdb id|not found/i.test(body.Error ?? "")) return null;
  throw new Error(`OMDb ${res.status}: ${String(body.Error ?? "no error message").slice(0, 100)}`);
}

/** A cached entry that needs no new lookup: checked this week, and (for scores) stored under the current rule. */
function isFresh(entry: CacheEntry | undefined, now: Date): boolean {
  if (!entry) return false;
  const at = "miss" in entry ? entry.miss : entry.checked;
  return ("miss" in entry || entry.released !== undefined) && now.getTime() - Date.parse(at) <= REFRESH_MS;
}

/**
 * Puts one OMDb answer into `cache`: an unknown id as a miss, a film released over a year ago
 * with its scores, and a newer film not at all (any older entry for it is dropped).
 * Returns whether the cache changed.
 */
export function recordLookup(cache: RatingsCache, imdbId: string, found: OmdbTitle | null, now: Date): boolean {
  const stamp = now.toISOString();
  if (!found) {
    cache[imdbId] = { miss: stamp };
    return true;
  }
  const released = found.released;
  if (released && now.getTime() - Date.parse(released) > CACHE_AFTER_MS) {
    cache[imdbId] = { ...found.scores, released, checked: stamp };
    return true;
  }
  if (!(imdbId in cache)) return false;
  delete cache[imdbId];
  return true;
}

/**
 * Scores for these IMDb ids: fresh cached ones straight away, the rest looked up on OMDb
 * (at most `maxLookups`, in the order given). Failures (bad key, daily limit, network)
 * aren't cached, so they're retried later; old cached scores are used meanwhile.
 */
export async function resolveRatings(
  imdbIds: string[],
  cache: RatingsCache,
  key: string | undefined,
  now: Date,
  fetcher: typeof fetch = fetch,
  maxLookups = MAX_RATING_LOOKUPS_PER_VIEW,
): Promise<{ ratings: Ratings; cache: RatingsCache; changed: boolean }> {
  const ids = [...new Set(imdbIds.filter((id) => IMDB_ID.test(id)))];
  // Entries from before picks carried ids were keyed by title; drop them.
  const next: RatingsCache = Object.fromEntries(Object.entries(cache).filter(([k]) => IMDB_ID.test(k)));
  let changed = Object.keys(next).length !== Object.keys(cache).length;

  const lookups = key ? ids.filter((id) => !isFresh(next[id], now)).slice(0, maxLookups) : [];
  const results = await Promise.allSettled(lookups.map((id) => fetchOmdb(id, key!, fetcher)));
  /** Scores just fetched, including newer films that aren't cached. */
  const fetched = new Map<string, Scores>();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(JSON.stringify({ msg: "omdb lookup failed", imdbId: lookups[i], error: String(r.reason) }));
      return;
    }
    if (r.value) fetched.set(lookups[i], r.value.scores);
    if (recordLookup(next, lookups[i], r.value, now)) changed = true;
  });

  const ratings: Ratings = new Map();
  for (const id of ids) {
    const v = next[id];
    const cached = v && !("miss" in v) ? (({ checked: _c, released: _r, ...scores }) => scores)(v) : undefined;
    const scores = fetched.get(id) ?? cached;
    if (scores) ratings.set(id, scores);
  }
  return { ratings, cache: next, changed };
}

// ---------- finding the IMDb id (for Claude's find_film tool) ----------

export interface Candidate {
  title: string;
  year: number | null;
  type: "film" | "series";
  /** Start of the plot summary, to tell namesakes apart. */
  overview: string;
  /** How many TMDB users rated it: the well-known title has far more. */
  tmdbVotes: number;
}

export interface FilmSearch {
  /** The best guess, with its IMDb id (null when TMDB has none). Null when nothing matched. */
  best: (Candidate & { imdbId: string | null }) | null;
  /** Namesakes, so a wrong best guess can be spotted. No IMDb id: that would cost a request each. */
  others: Candidate[];
}

/** Namesakes listed after the best guess. They come free with the search. */
const MAX_OTHERS = 3;

/**
 * Films and series on TMDB with this title, best guess first (matching year, then most voted).
 * Two TMDB requests: the search, and the best guess's IMDb id. Throws on network/HTTP errors.
 */
export async function findFilm(
  wanted: { title: string; year?: number },
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<FilmSearch> {
  const get = async (path: string) => {
    const res = await fetcher(`https://api.themoviedb.org/3/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return (await res.json()) as {
      results?: {
        id?: number;
        media_type?: string;
        title?: string;
        name?: string;
        overview?: string;
        vote_count?: number;
        release_date?: string;
        first_air_date?: string;
      }[];
      imdb_id?: string | null;
    };
  };
  const q = new URLSearchParams({ query: wanted.title, include_adult: "false" });
  const yearOf = (r: { release_date?: string; first_air_date?: string }) =>
    Number.parseInt(r.release_date ?? r.first_air_date ?? "", 10) || null;
  const fits = (y: number | null) => (wanted.year && y && Math.abs(y - wanted.year) <= 1 ? 1 : 0);
  const top = ((await get(`search/multi?${q}`)).results ?? [])
    .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && Number.isInteger(r.id))
    .sort((a, b) => fits(yearOf(b)) - fits(yearOf(a)) || (b.vote_count ?? 0) - (a.vote_count ?? 0))
    .slice(0, 1 + MAX_OTHERS);
  const candidate = (r: (typeof top)[number]): Candidate => ({
    title: String(r.title ?? r.name ?? "").slice(0, 300),
    year: yearOf(r),
    type: r.media_type === "tv" ? "series" : "film",
    overview: String(r.overview ?? "").slice(0, 160),
    tmdbVotes: r.vote_count ?? 0,
  });
  if (!top.length) return { best: null, others: [] };
  const id = (await get(`${top[0].media_type}/${top[0].id}/external_ids`)).imdb_id;
  return {
    best: { ...candidate(top[0]), imdbId: id && IMDB_ID.test(id) ? id : null },
    others: top.slice(1).map(candidate),
  };
}
