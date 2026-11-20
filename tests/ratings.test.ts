import { describe, expect, it } from "vitest";
import { emptyMemory, type Memory } from "../src/memory.ts";
import { pickIdsShown, renderPage } from "../src/page.ts";
import { findFilm, MAX_RATING_LOOKUPS_PER_VIEW, type RatingsCache, recordLookup, resolveRatings } from "../src/ratings.ts";
import { fixture } from "./fixture.ts";

const NOW = new Date("2026-11-20T12:00:00Z");

type Reply = Record<string, unknown> | { status: number; body: Record<string, unknown> };

/** Fake OMDb: answers from `db` (IMDb id → response), "Incorrect IMDb ID." otherwise; records every request. */
function fakeOmdb(db: Record<string, Reply>) {
  const calls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const r = db[url.searchParams.get("i")!];
    if (r && "status" in r) return Response.json(r.body, { status: r.status as number });
    return Response.json(r ?? { Response: "False", Error: "Incorrect IMDb ID." });
  }) as typeof fetch;
  return { calls, fetcher };
}

const found = (title: string, imdb: string, rt?: string, mc?: string, released = "28 May 2009") => ({
  Response: "True",
  Title: title,
  Year: released.slice(-4),
  Released: released,
  imdbRating: imdb,
  imdbVotes: "112,345",
  Ratings: [
    { Source: "Internet Movie Database", Value: `${imdb}/10` },
    ...(rt ? [{ Source: "Rotten Tomatoes", Value: rt }] : []),
    ...(mc ? [{ Source: "Metacritic", Value: `${mc}/100` }] : []),
  ],
});

describe("resolveRatings", () => {
  it("looks films up by IMDb id, then caches hits and misses", async () => {
    const omdb = fakeOmdb({ tt1216496: found("Mother", "7.8", "96%", "79") });
    const ids = ["tt1216496", "tt0000001", "tt1216496"];
    const r = await resolveRatings(ids, {}, "k3y", NOW, omdb.fetcher);
    expect(omdb.calls).toHaveLength(2); // the repeated id is only asked once
    expect(omdb.calls[0].searchParams.get("apikey")).toBe("k3y");
    expect(omdb.calls[0].searchParams.get("i")).toBe("tt1216496");
    expect(omdb.calls[0].searchParams.has("t")).toBe(false); // never by title
    expect(r.ratings.get("tt1216496")).toEqual({ imdbId: "tt1216496", imdb: "7.8", votes: 112345, rt: "96%", mc: "79" });
    expect(r.cache.tt1216496).toMatchObject({ released: "2009-05-28", checked: NOW.toISOString() });
    expect(r.ratings.has("tt0000001")).toBe(false);
    expect(r.changed).toBe(true);

    const again = fakeOmdb({});
    const r2 = await resolveRatings(ids, r.cache, "k3y", NOW, again.fetcher);
    expect(again.calls).toHaveLength(0);
    expect(r2.changed).toBe(false);
    expect(r2.ratings.get("tt1216496")).toEqual({ imdbId: "tt1216496", imdb: "7.8", votes: 112345, rt: "96%", mc: "79" });
  });

  it("re-checks after 7 days, and never caches failures like a bad key or the daily limit", async () => {
    const weekOld = "2026-11-12T00:00:00Z";
    const cache: RatingsCache = { tt1216496: { imdbId: "tt1216496", imdb: "7.7", released: "2009-05-28", checked: weekOld } };
    const fresh = fakeOmdb({ tt1216496: found("Mother", "7.8") });
    expect((await resolveRatings(["tt1216496"], cache, "k", NOW, fresh.fetcher)).ratings.get("tt1216496")?.imdb).toBe("7.8");
    // Six days old is still fresh.
    const recent = { tt1216496: { ...cache.tt1216496, checked: "2026-11-14T13:00:00Z" } } as RatingsCache;
    const none = fakeOmdb({});
    await resolveRatings(["tt1216496"], recent, "k", NOW, none.fetcher);
    expect(none.calls).toHaveLength(0);

    const limited = fakeOmdb({ tt1216496: { status: 401, body: { Response: "False", Error: "Request limit reached!" } } });
    const r = await resolveRatings(["tt1216496"], cache, "k", NOW, limited.fetcher);
    expect(r.changed).toBe(false);
    expect(r.ratings.get("tt1216496")?.imdb).toBe("7.7"); // old scores kept meanwhile
  });

  it("caches only films released over a year ago; newer ones are looked up every time", async () => {
    const omdb = fakeOmdb({
      tt0000010: found("Old", "7.0", undefined, undefined, "19 Nov 2025"), // a year and a day before NOW
      tt0000011: found("New", "8.1", undefined, undefined, "21 Nov 2025"), // just under a year
      tt0000012: { Response: "True", Title: "Ongoing", Year: "2026–", imdbRating: "8.4" }, // no exact date: end of 2026
    });
    const ids = ["tt0000010", "tt0000011", "tt0000012"];
    const r = await resolveRatings(ids, {}, "k", NOW, omdb.fetcher);
    expect(Object.keys(r.cache)).toEqual(["tt0000010"]);
    expect([...r.ratings.keys()]).toEqual(ids); // all three still get their scores

    // Next time only the new ones are asked again.
    const again = fakeOmdb({ tt0000011: found("New", "8.0", undefined, undefined, "21 Nov 2025"), tt0000012: found("Ongoing", "8.4") });
    const r2 = await resolveRatings(ids, r.cache, "k", NOW, again.fetcher);
    expect(again.calls.map((u) => u.searchParams.get("i"))).toEqual(["tt0000011", "tt0000012"]);
    expect(r2.ratings.get("tt0000011")?.imdb).toBe("8.0");
  });

  it("re-checks entries saved before the one-year rule, and drops them if the film is new", async () => {
    const cache: RatingsCache = {
      tt0000020: { imdbId: "tt0000020", imdb: "6.0", checked: NOW.toISOString() }, // no release date: old format
    };
    const omdb = fakeOmdb({ tt0000020: found("Recent", "6.5", undefined, undefined, "01 Oct 2026") });
    const r = await resolveRatings(["tt0000020"], cache, "k", NOW, omdb.fetcher);
    expect(omdb.calls).toHaveLength(1);
    expect(r.cache).toEqual({});
    expect(r.changed).toBe(true);
    expect(r.ratings.get("tt0000020")?.imdb).toBe("6.5");
  });

  it("recordLookup stores misses and old films, skips new ones", () => {
    const cache: RatingsCache = {};
    expect(recordLookup(cache, "tt0000030", null, NOW)).toBe(true);
    expect(cache.tt0000030).toEqual({ miss: NOW.toISOString() });
    const title = (released: string | null) => ({ title: "X", year: "2000", released, scores: { imdbId: "tt0000031", imdb: "7.0" } });
    expect(recordLookup(cache, "tt0000031", title("2000-01-01"), NOW)).toBe(true);
    expect(recordLookup(cache, "tt0000032", title("2026-11-01"), NOW)).toBe(false);
    expect(recordLookup(cache, "tt0000033", title(null), NOW)).toBe(false);
    expect(Object.keys(cache).sort()).toEqual(["tt0000030", "tt0000031"]);
  });

  it("can be limited to fewer lookups, taken in the order given", async () => {
    const omdb = fakeOmdb({});
    await resolveRatings(["tt0000041", "tt0000042", "tt0000043"], {}, "k", NOW, omdb.fetcher, 2);
    expect(omdb.calls.map((u) => u.searchParams.get("i"))).toEqual(["tt0000041", "tt0000042"]);
  });

  it("drops cache entries from when scores were keyed by title", async () => {
    const cache = { "the revenant|2015": { imdbId: "tt27793995", rt: "78%", checked: NOW.toISOString() } } as RatingsCache;
    const r = await resolveRatings([], cache, "k", NOW, fakeOmdb({}).fetcher);
    expect(r.cache).toEqual({});
    expect(r.changed).toBe(true);
  });

  it("caps lookups per view, drops oddly shaped values and ids, and does nothing without a key", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `tt${1000000 + i}`);
    const omdb = fakeOmdb({});
    await resolveRatings(many, {}, "k", NOW, omdb.fetcher);
    expect(omdb.calls).toHaveLength(MAX_RATING_LOOKUPS_PER_VIEW);

    const evil = fakeOmdb({
      tt1234567: { Response: "True", imdbID: "javascript:alert(1)", imdbRating: '"><script>', Ratings: [{ Source: "Rotten Tomatoes", Value: "<b>" }] },
    });
    const r = await resolveRatings(["tt1234567", "javascript:alert(1)"], {}, "k", NOW, evil.fetcher);
    expect(evil.calls).toHaveLength(1);
    expect(r.ratings.get("tt1234567")).toEqual({ imdbId: "tt1234567" });

    const none = fakeOmdb({});
    expect((await resolveRatings(many, {}, undefined, NOW, none.fetcher)).ratings.size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });
});

describe("findFilm", () => {
  it("gives the best guess (matching year first, then most voted) an IMDb id, and lists namesakes for free", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      if (url.pathname === "/3/search/multi") {
        expect(url.searchParams.get("query")).toBe("Shōgun");
        return Response.json({
          results: [
            { id: 1, media_type: "tv", name: "Shōgun", vote_count: 900, first_air_date: "1980-09-15", overview: "Old one." },
            { id: 2, media_type: "movie", title: "Shōgun", vote_count: 3, release_date: "2024-05-01" },
            { id: 3, media_type: "person", name: "Shōgun" },
            { id: 126308, media_type: "tv", name: "Shōgun", vote_count: 1500, first_air_date: "2024-02-27", overview: "x".repeat(500) },
          ],
        });
      }
      const ids: Record<string, string | null> = { "/3/tv/126308/external_ids": "tt2788316", "/3/movie/2/external_ids": null, "/3/tv/1/external_ids": "tt0080274" };
      return Response.json({ imdb_id: ids[url.pathname] });
    }) as typeof fetch;

    const got = await findFilm({ title: "Shōgun", year: 2024 }, "tok", fetcher);
    expect(got.best).toMatchObject({ imdbId: "tt2788316", type: "series", year: 2024, tmdbVotes: 1500 });
    expect(got.best!.overview).toHaveLength(160);
    // The person is never a candidate; namesakes come without ids.
    expect(got.others.map((c) => [c.title, c.type, c.year, c.tmdbVotes])).toEqual([
      ["Shōgun", "film", 2024, 3],
      ["Shōgun", "series", 1980, 900],
    ]);
    expect(got.others[0]).not.toHaveProperty("imdbId");
    // Two requests per title: the search and the best guess's id.
    expect(paths).toEqual(["/3/search/multi", "/3/tv/126308/external_ids"]);
  });

  it("returns no match when TMDB finds nothing, and a null id when TMDB has none", async () => {
    const empty = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    expect(await findFilm({ title: "Nothing" }, "tok", empty)).toEqual({ best: null, others: [] });
    const noId = (async (input: RequestInfo | URL) =>
      new URL(String(input)).pathname === "/3/search/multi"
        ? Response.json({ results: [{ id: 2, media_type: "movie", title: "Obscure", vote_count: 1 }] })
        : Response.json({ imdb_id: null })) as typeof fetch;
    expect((await findFilm({ title: "Obscure" }, "tok", noId)).best).toMatchObject({ title: "Obscure", imdbId: null });
  });

  it("throws when TMDB fails", async () => {
    const down = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(findFilm({ title: "Heat" }, "tok", down)).rejects.toThrow("TMDB 500");
  });
});

describe("scores on the page", () => {
  const opts = { uploadAction: "/u", status: null, now: NOW };
  const memory: Memory = {
    ...emptyMemory(),
    picks: {
      updatedAt: NOW.toISOString(),
      items: [
        { title: "Mother & Son", year: 2009, imdbId: "tt1216496", why: "Because." },
        { title: "No Id", year: 2001, why: "Saved before ids were required." },
      ],
    },
  };

  it("asks for scores only for picks that carry an id", () => {
    expect(pickIdsShown(fixture(), memory)).toEqual(["tt1216496"]);
  });

  it("links each score to its site, and shows nothing without scores", () => {
    const ratings = new Map([["tt1216496", { imdbId: "tt1216496", imdb: "7.8", rt: "96%", mc: "79" }]]);
    const html = renderPage(fixture(), memory, { ...opts, ratings });
    expect(html).toContain('href="https://www.imdb.com/title/tt1216496/" rel="noreferrer noopener" target="_blank"><strong>7.8</strong> IMDb</a>');
    expect(html).toContain('href="https://www.rottentomatoes.com/search?search=Mother%20%26%20Son"');
    expect(html).toContain("<strong>96%</strong> Rotten Tomatoes</a>");
    expect(html).toContain('href="https://www.metacritic.com/search/Mother%20%26%20Son/?category=2"');
    expect(html).toContain("<strong>79</strong> Metacritic</a>");
    expect(html.match(/class="scores"/g)).toHaveLength(1); // the pick without an id shows none

    const partial = new Map([["tt1216496", { imdbId: "tt1216496" }]]);
    const p = renderPage(fixture(), memory, { ...opts, ratings: partial });
    expect(p).toContain(">IMDb</a></div>");
    expect(p).not.toContain("Rotten Tomatoes");

    expect(renderPage(fixture(), memory, opts)).not.toContain('class="scores"');
  });
});
