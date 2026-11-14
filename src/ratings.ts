// IMDb / Rotten Tomatoes / Metacritic scores from OMDb, looked up by IMDb id for the picks
// on the page and cached in KV (refreshed monthly, scores move slowly).
//
// Picks carry the IMDb id Claude chose with find_film, so there is no guessing by title
// here: a title search can land on an obscure namesake with no scores.

export const RATINGS_KEY = "ratings";
/** OMDb lookups per page view: one request each. Workers Free allows 50 subrequests per view, shared with up to 30 TMDB poster lookups. */
export const MAX_RATING_LOOKUPS_PER_VIEW = 10;
/** Re-check scores, and ids OMDb didn't know, after this long. */
const REFRESH_MS = 30 * 86_400_000;

export const IMDB_ID = /^tt\d{5,10}$/;

export interface Scores {
  imdbId: string;
  /** "7.8" */
  imdb?: string;
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
  scores: Scores;
}

type CacheEntry = (Scores & { checked: string }) | { miss: string };
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
  Ratings?: { Source?: string; Value?: string }[];
}

/** Keep only values in the exact shapes we expect, so nothing odd reaches the page. */
function toScores(imdbId: string, body: OmdbResponse): Scores {
  const source = (name: string) => body.Ratings?.find((r) => r.Source === name)?.Value ?? "";
  const imdb = /^(10|\d)\.\d$/.exec(body.imdbRating ?? "")?.[0];
  const rt = /^(100|\d{1,2})%$/.exec(source("Rotten Tomatoes"))?.[0];
  const mc = /^(100|\d{1,2})\/100$/.exec(source("Metacritic"))?.[1];
  return { imdbId, ...(imdb && { imdb }), ...(rt && { rt }), ...(mc && { mc }) };
}

/** One OMDb lookup by IMDb id. null = OMDb has nothing under that id. Throws on any other problem (bad key, limit, network). */
export async function fetchOmdb(imdbId: string, key: string, fetcher: typeof fetch = fetch): Promise<OmdbTitle | null> {
  if (!IMDB_ID.test(imdbId)) return null;
  const q = new URLSearchParams({ apikey: key, i: imdbId });
  const res = await fetcher(`https://www.omdbapi.com/?${q}`, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as OmdbResponse;
  if (body.Response === "True") {
    return { title: String(body.Title ?? "").slice(0, 300), year: String(body.Year ?? "").slice(0, 20), scores: toScores(imdbId, body) };
  }
  if (res.ok && /incorrect imdb id|not found/i.test(body.Error ?? "")) return null;
  throw new Error(`OMDb ${res.status}: ${String(body.Error ?? "no error message").slice(0, 100)}`);
}

/**
 * Scores for these IMDb ids: cached ones straight away, missing or month-old ones looked up
 * on OMDb (up to MAX_RATING_LOOKUPS_PER_VIEW). Failures (bad key, daily limit, network)
 * aren't cached, so they're retried on a later view; old cached scores are kept meanwhile.
 */
export async function resolveRatings(
  imdbIds: string[],
  cache: RatingsCache,
  key: string | undefined,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<{ ratings: Ratings; cache: RatingsCache; changed: boolean }> {
  const ids = [...new Set(imdbIds.filter((id) => IMDB_ID.test(id)))];
  // Entries from before picks carried ids were keyed by title; drop them.
  const next: RatingsCache = Object.fromEntries(Object.entries(cache).filter(([k]) => IMDB_ID.test(k)));
  let changed = Object.keys(next).length !== Object.keys(cache).length;

  const todo = ids.filter((id) => {
    const hit = next[id];
    const at = hit && ("miss" in hit ? hit.miss : hit.checked);
    return key && (!at || now.getTime() - Date.parse(at) > REFRESH_MS);
  });
  const lookups = todo.slice(0, MAX_RATING_LOOKUPS_PER_VIEW);
  const results = await Promise.allSettled(lookups.map((id) => fetchOmdb(id, key!, fetcher)));
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(JSON.stringify({ msg: "omdb lookup failed", imdbId: lookups[i], error: String(r.reason) }));
      return;
    }
    const stamp = now.toISOString();
    next[lookups[i]] = r.value ? { ...r.value.scores, checked: stamp } : { miss: stamp };
    changed = true;
  });

  const ratings: Ratings = new Map();
  for (const id of ids) {
    const v = next[id];
    if (v && !("miss" in v)) {
      const { checked: _, ...scores } = v;
      ratings.set(id, scores);
    }
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
  votes: number;
  imdbId: string;
}

/** Candidates returned per title: each costs one extra TMDB request for its IMDb id. */
const MAX_CANDIDATES = 3;

/**
 * Films and series on TMDB with this title, best guess first (matching year, then most voted),
 * each with its IMDb id. Throws on network/HTTP errors.
 */
export async function findFilm(
  wanted: { title: string; year?: number },
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Candidate[]> {
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
    .slice(0, MAX_CANDIDATES);
  const ids = await Promise.all(top.map((r) => get(`${r.media_type}/${r.id}/external_ids`).then((x) => x.imdb_id)));
  return top.flatMap((r, i) => {
    const imdbId = ids[i];
    if (!imdbId || !IMDB_ID.test(imdbId)) return [];
    return [
      {
        title: String(r.title ?? r.name ?? "").slice(0, 300),
        year: yearOf(r),
        type: r.media_type === "tv" ? ("series" as const) : ("film" as const),
        overview: String(r.overview ?? "").slice(0, 160),
        votes: r.vote_count ?? 0,
        imdbId,
      },
    ];
  });
}
