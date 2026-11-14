// Film posters from TMDB, looked up lazily for whatever the page is about to show
// and cached in KV, so each film is only ever looked up once.

export const POSTERS_KEY = "posters";
/** Never make more TMDB calls than this in one page view (Workers Free allows 50 subrequests). */
export const MAX_LOOKUPS_PER_VIEW = 30;
/** Retry films TMDB had no poster for after this long (posters do get added later). */
const MISS_RETRY_MS = 30 * 86_400_000;

/** poster_path like "/abc.jpg", or a miss with when it was checked. */
type CacheEntry = string | { miss: string };
export type PosterCache = Record<string, CacheEntry>;
/** Film key → poster_path, for the films that have one. */
export type Posters = Map<string, string>;

export interface FilmRef {
  title: string;
  year: number | null;
}

export const filmKey = (f: FilmRef) => `${f.title.trim().toLowerCase()}|${f.year ?? ""}`;

export function posterUrl(path: string, width: 92 | 185 | 342 | 500): string {
  return `https://image.tmdb.org/t/p/w${width}${path}`;
}

/** One TMDB search; returns the top result's poster_path or null. Throws on network/HTTP errors. */
async function searchPoster(f: FilmRef, token: string, fetcher: typeof fetch): Promise<string | null> {
  const q = new URLSearchParams({ query: f.title, include_adult: "false" });
  if (f.year) q.set("year", String(f.year));
  const res = await fetcher(`https://api.themoviedb.org/3/search/movie?${q}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const body = (await res.json()) as { results?: { poster_path?: string | null }[] };
  const path = body.results?.find((r) => r.poster_path)?.poster_path;
  return typeof path === "string" && /^\/[\w.-]+$/.test(path) ? path : null;
}

/**
 * Posters for `films`: cached ones straight away, missing ones looked up on TMDB
 * (up to MAX_LOOKUPS_PER_VIEW). Returns the posters plus the updated cache, or
 * `changed: false` when nothing new was learned. Lookup failures are skipped
 * (not cached) so they get retried on a later view.
 */
export async function resolvePosters(
  films: FilmRef[],
  cache: PosterCache,
  token: string | undefined,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<{ posters: Posters; cache: PosterCache; changed: boolean }> {
  const next: PosterCache = { ...cache };
  const todo = new Map<string, FilmRef>();
  for (const f of films) {
    const k = filmKey(f);
    const hit = next[k];
    const stale = hit !== undefined && typeof hit !== "string" && now.getTime() - Date.parse(hit.miss) > MISS_RETRY_MS;
    if ((hit === undefined || stale) && token) todo.set(k, f);
  }

  const lookups = [...todo].slice(0, MAX_LOOKUPS_PER_VIEW);
  const results = await Promise.allSettled(lookups.map(([, f]) => searchPoster(f, token!, fetcher)));
  let changed = false;
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    next[lookups[i][0]] = r.value ?? { miss: now.toISOString() };
    changed = true;
  });

  const posters: Posters = new Map();
  for (const f of films) {
    const v = next[filmKey(f)];
    if (typeof v === "string") posters.set(filmKey(f), v);
  }
  return { posters, cache: next, changed };
}
