import { describe, expect, it } from "vitest";
import { emptyMemory, type Memory } from "../src/memory.ts";
import { pickIdsShown, renderPage } from "../src/page.ts";
import { findFilm, MAX_RATING_LOOKUPS_PER_VIEW, type RatingsCache, resolveRatings } from "../src/ratings.ts";
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

const found = (title: string, imdb: string, rt?: string, mc?: string) => ({
  Response: "True",
  Title: title,
  Year: "2009",
  imdbRating: imdb,
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
    expect(r.ratings.get("tt1216496")).toEqual({ imdbId: "tt1216496", imdb: "7.8", rt: "96%", mc: "79" });
    expect(r.ratings.has("tt0000001")).toBe(false);
    expect(r.changed).toBe(true);

    const again = fakeOmdb({});
    const r2 = await resolveRatings(ids, r.cache, "k3y", NOW, again.fetcher);
    expect(again.calls).toHaveLength(0);
    expect(r2.changed).toBe(false);
    expect(r2.ratings.get("tt1216496")?.imdb).toBe("7.8");
  });

  it("refreshes after 30 days, and never caches failures like a bad key or the daily limit", async () => {
    const cache: RatingsCache = { tt1216496: { imdbId: "tt1216496", imdb: "7.7", checked: "2026-10-01T00:00:00Z" } };
    const fresh = fakeOmdb({ tt1216496: found("Mother", "7.8") });
    expect((await resolveRatings(["tt1216496"], cache, "k", NOW, fresh.fetcher)).ratings.get("tt1216496")?.imdb).toBe("7.8");

    const limited = fakeOmdb({ tt1216496: { status: 401, body: { Response: "False", Error: "Request limit reached!" } } });
    const r = await resolveRatings(["tt1216496"], cache, "k", NOW, limited.fetcher);
    expect(r.changed).toBe(false);
    expect(r.ratings.get("tt1216496")?.imdb).toBe("7.7"); // old scores kept meanwhile
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
  it("returns films and series with IMDb ids, matching year first, then most voted", async () => {
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
    // The 2024 film has no IMDb id on TMDB, so it's left out; the person is never a candidate.
    expect(got.map((c) => [c.imdbId, c.type, c.year, c.votes])).toEqual([
      ["tt2788316", "series", 2024, 1500],
      ["tt0080274", "series", 1980, 900],
    ]);
    expect(got[0].overview).toHaveLength(160);
    expect(paths).toHaveLength(4);
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
