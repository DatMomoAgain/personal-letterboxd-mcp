// IMDb / Rotten Tomatoes / Metacritic scores from OMDb, looked up lazily for the
// picks on the page and cached in KV (refreshed monthly, scores move slowly).

import { type FilmRef, filmKey } from "./posters.ts";

export const RATINGS_KEY = "ratings";
/** OMDb films looked up per page view (each may take 2 requests; Workers Free allows 50 subrequests). */
export const MAX_RATING_LOOKUPS_PER_VIEW = 8;
/** Re-check scores, and films OMDb didn't know, after this long. */
const REFRESH_MS = 30 * 86_400_000;

export interface Scores {
  imdbId: string;
  /** "7.8" */
  imdb?: string;
  /** "94%" */
  rt?: string;
  /** "80" (out of 100) */
  mc?: string;
}

type CacheEntry = (Scores & { checked: string }) | { miss: string };
export type RatingsCache = Record<string, CacheEntry>;
/** Film key → scores, for the films OMDb knows. */
export type Ratings = Map<string, Scores>;

interface OmdbResponse {
  Response?: string;
  Error?: string;
  imdbID?: string;
  imdbRating?: string;
  Ratings?: { Source?: string; Value?: string }[];
}

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Keep only values in the exact shapes we expect, so nothing odd reaches the page. */
function toScores(body: OmdbResponse): Scores | null {
  if (!body.imdbID || !/^tt\d{5,10}$/.test(body.imdbID)) return null;
  const source = (name: string) => body.Ratings?.find((r) => r.Source === name)?.Value ?? "";
  const imdb = /^(10|\d)\.\d$/.exec(body.imdbRating ?? "")?.[0];
  const rt = /^(100|\d{1,2})%$/.exec(source("Rotten Tomatoes"))?.[0];
  const mc = /^(100|\d{1,2})\/100$/.exec(source("Metacritic"))?.[1];
  return { imdbId: body.imdbID, ...(imdb && { imdb }), ...(rt && { rt }), ...(mc && { mc }) };
}

/** One OMDb title lookup. null = OMDb doesn't know the film. Throws on any other problem (bad key, limit, network). */
async function fetchOmdb(title: string, year: number | null, key: string, fetcher: typeof fetch): Promise<Scores | null> {
  const q = new URLSearchParams({ apikey: key, t: title });
  if (year) q.set("y", String(year));
  const res = await fetcher(`https://www.omdbapi.com/?${q}`, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => ({}))) as OmdbResponse;
  if (body.Response === "True") return toScores(body);
  if (res.ok && /not found/i.test(body.Error ?? "")) return null;
  throw new Error(`OMDb ${res.status}: ${String(body.Error ?? "no error message").slice(0, 100)}`);
}

/** Tries the title as given, then without accents (OMDb has "Shogun", not "Shōgun"). */
async function lookup(f: FilmRef, key: string, fetcher: typeof fetch): Promise<Scores | null> {
  const found = await fetchOmdb(f.title, f.year, key, fetcher);
  const plain = stripAccents(f.title);
  return found ?? (plain !== f.title ? fetchOmdb(plain, f.year, key, fetcher) : null);
}

/**
 * Scores for `films`: cached ones straight away, missing or month-old ones looked up
 * on OMDb (up to MAX_RATING_LOOKUPS_PER_VIEW). Failures (bad key, daily limit, network)
 * aren't cached, so they're retried on a later view; old cached scores are kept meanwhile.
 */
export async function resolveRatings(
  films: FilmRef[],
  cache: RatingsCache,
  key: string | undefined,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<{ ratings: Ratings; cache: RatingsCache; changed: boolean }> {
  const next: RatingsCache = { ...cache };
  const todo = new Map<string, FilmRef>();
  for (const f of films) {
    const k = filmKey(f);
    const hit = next[k];
    const at = hit && ("miss" in hit ? hit.miss : hit.checked);
    if ((!at || now.getTime() - Date.parse(at) > REFRESH_MS) && key) todo.set(k, f);
  }

  const lookups = [...todo].slice(0, MAX_RATING_LOOKUPS_PER_VIEW);
  const results = await Promise.allSettled(lookups.map(([, f]) => lookup(f, key!, fetcher)));
  let changed = false;
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(JSON.stringify({ msg: "omdb lookup failed", title: lookups[i][1].title, error: String(r.reason) }));
      return;
    }
    const stamp = now.toISOString();
    next[lookups[i][0]] = r.value ? { ...r.value, checked: stamp } : { miss: stamp };
    changed = true;
  });

  const ratings: Ratings = new Map();
  for (const f of films) {
    const v = next[filmKey(f)];
    if (v && !("miss" in v)) {
      const { checked: _, ...scores } = v;
      ratings.set(filmKey(f), scores);
    }
  }
  return { ratings, cache: next, changed };
}
