import { describe, expect, it } from "vitest";
import { emptyMemory, type Memory } from "../src/memory.ts";
import { renderPage } from "../src/page.ts";
import { filmKey } from "../src/posters.ts";
import { MAX_RATING_LOOKUPS_PER_VIEW, type RatingsCache, resolveRatings } from "../src/ratings.ts";
import { fixture } from "./fixture.ts";

const NOW = new Date("2026-11-20T12:00:00Z");

type Reply = Record<string, unknown> | { status: number; body: Record<string, unknown> };

/** Fake OMDb: answers from `db` (title → response), "Movie not found!" otherwise; records every request. */
function fakeOmdb(db: Record<string, Reply>) {
  const calls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const r = db[url.searchParams.get("t")!];
    if (r && "status" in r) return Response.json(r.body, { status: r.status as number });
    return Response.json(r ?? { Response: "False", Error: "Movie not found!" });
  }) as typeof fetch;
  return { calls, fetcher };
}

const found = (id: string, imdb: string, rt?: string, mc?: string) => ({
  Response: "True",
  imdbID: id,
  imdbRating: imdb,
  Ratings: [
    { Source: "Internet Movie Database", Value: `${imdb}/10` },
    ...(rt ? [{ Source: "Rotten Tomatoes", Value: rt }] : []),
    ...(mc ? [{ Source: "Metacritic", Value: `${mc}/100` }] : []),
  ],
});

describe("resolveRatings", () => {
  it("looks films up by title, year and key, then caches hits and misses", async () => {
    const omdb = fakeOmdb({ Mother: found("tt1216496", "7.8", "96%", "79") });
    const films = [{ title: "Mother", year: 2009 }, { title: "Obscure", year: 2001 }];
    const r = await resolveRatings(films, {}, "k3y", NOW, omdb.fetcher);
    expect(omdb.calls[0].searchParams.get("apikey")).toBe("k3y");
    expect(omdb.calls[0].searchParams.get("y")).toBe("2009");
    expect(r.ratings.get(filmKey(films[0]))).toEqual({ imdbId: "tt1216496", imdb: "7.8", rt: "96%", mc: "79" });
    expect(r.ratings.has(filmKey(films[1]))).toBe(false);
    expect(r.changed).toBe(true);

    const again = fakeOmdb({});
    const r2 = await resolveRatings(films, r.cache, "k3y", NOW, again.fetcher);
    expect(again.calls).toHaveLength(0);
    expect(r2.changed).toBe(false);
    expect(r2.ratings.get(filmKey(films[0]))?.imdb).toBe("7.8");
  });

  it("retries without accents when the title isn't found", async () => {
    const omdb = fakeOmdb({ Shogun: found("tt2788316", "8.6", "99%") });
    const film = { title: "Shōgun", year: 2024 };
    const r = await resolveRatings([film], {}, "k", NOW, omdb.fetcher);
    expect(omdb.calls.map((u) => u.searchParams.get("t"))).toEqual(["Shōgun", "Shogun"]);
    expect(r.ratings.get(filmKey(film))?.rt).toBe("99%");
  });

  it("tries a year either side when the exact year isn't found", async () => {
    const omdb = fakeOmdb({});
    const byYear = (async (input: RequestInfo | URL) => {
      omdb.calls.push(new URL(String(input)));
      const y = new URL(String(input)).searchParams.get("y");
      return Response.json(y === "2012" ? found("tt1772925", "7.8", "99%", "77") : { Response: "False", Error: "Movie not found!" });
    }) as typeof fetch;
    const film = { title: "Jiro Dreams of Sushi", year: 2011 };
    const r = await resolveRatings([film], {}, "k", NOW, byYear);
    expect(omdb.calls.map((u) => u.searchParams.get("y"))).toEqual(["2011", "2012"]);
    expect(r.ratings.get(filmKey(film))?.imdb).toBe("7.8");
  });

  it("refreshes after 30 days, and never caches failures like a bad key or the daily limit", async () => {
    const film = { title: "Mother", year: 2009 };
    const cache: RatingsCache = { [filmKey(film)]: { imdbId: "tt1216496", imdb: "7.7", checked: "2026-10-01T00:00:00Z" } };
    const fresh = fakeOmdb({ Mother: found("tt1216496", "7.8") });
    expect((await resolveRatings([film], cache, "k", NOW, fresh.fetcher)).ratings.get(filmKey(film))?.imdb).toBe("7.8");

    const limited = fakeOmdb({ Mother: { status: 401, body: { Response: "False", Error: "Request limit reached!" } } });
    const r = await resolveRatings([film], cache, "k", NOW, limited.fetcher);
    expect(r.changed).toBe(false);
    expect(r.ratings.get(filmKey(film))?.imdb).toBe("7.7"); // old scores kept meanwhile
  });

  it("caps lookups per view, drops oddly shaped values, and does nothing without a key", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `F${i}`, year: 2000 }));
    const omdb = fakeOmdb({});
    await resolveRatings(many, {}, "k", NOW, omdb.fetcher);
    // Each unknown film tries its year, then a year either side.
    expect(omdb.calls).toHaveLength(MAX_RATING_LOOKUPS_PER_VIEW * 3);

    const evil = fakeOmdb({
      X: { Response: "True", imdbID: "tt1234567", imdbRating: '"><script>', Ratings: [{ Source: "Rotten Tomatoes", Value: "<b>" }] },
      Y: { Response: "True", imdbID: "javascript:alert(1)", imdbRating: "9.0" },
    });
    const r = await resolveRatings([{ title: "X", year: null }, { title: "Y", year: null }], {}, "k", NOW, evil.fetcher);
    expect(r.ratings.get(filmKey({ title: "X", year: null }))).toEqual({ imdbId: "tt1234567" });
    expect(r.ratings.has(filmKey({ title: "Y", year: null }))).toBe(false);

    const none = fakeOmdb({});
    expect((await resolveRatings(many, {}, undefined, NOW, none.fetcher)).ratings.size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });
});

describe("scores on the page", () => {
  const opts = { uploadAction: "/u", status: null, now: NOW };
  const memory: Memory = {
    ...emptyMemory(),
    picks: { updatedAt: NOW.toISOString(), items: [{ title: "Mother & Son", year: 2009, why: "Because." }] },
  };

  it("links each score to its site, and shows nothing without scores", () => {
    const ratings = new Map([[filmKey({ title: "Mother & Son", year: 2009 }), { imdbId: "tt1216496", imdb: "7.8", rt: "96%", mc: "79" }]]);
    const html = renderPage(fixture(), memory, { ...opts, ratings });
    expect(html).toContain('href="https://www.imdb.com/title/tt1216496/" rel="noreferrer noopener" target="_blank">IMDb 7.8</a>');
    expect(html).toContain('href="https://www.rottentomatoes.com/search?search=Mother%20%26%20Son"');
    expect(html).toContain(">Rotten Tomatoes 96%</a>");
    expect(html).toContain('href="https://www.metacritic.com/search/Mother%20%26%20Son/?category=2"');
    expect(html).toContain(">Metacritic 79</a>");

    const partial = new Map([[filmKey({ title: "Mother & Son", year: 2009 }), { imdbId: "tt1216496" }]]);
    const p = renderPage(fixture(), memory, { ...opts, ratings: partial });
    expect(p).toContain(">IMDb</a></div>");
    expect(p).not.toContain("Rotten Tomatoes");

    expect(renderPage(fixture(), memory, opts)).not.toContain('class="scores"');
  });
});
