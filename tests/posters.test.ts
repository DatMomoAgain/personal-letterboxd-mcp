import { describe, expect, it } from "vitest";
import { emptyMemory } from "../src/memory.ts";
import { renderPage } from "../src/page.ts";
import { filmKey, MAX_LOOKUPS_PER_VIEW, type PosterCache, resolvePosters } from "../src/posters.ts";
import { fixture } from "./fixture.ts";

const NOW = new Date("2026-11-20T12:00:00Z");

/** Fake TMDB: answers from `db` (title → poster_path|null), records every request. */
function fakeTmdb(db: Record<string, string | null>, fail: string[] = []) {
  const calls: { url: URL; auth: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const title = url.searchParams.get("query")!;
    if (fail.includes(title)) return new Response("nope", { status: 500 });
    const path = db[title];
    return Response.json({ results: path === undefined ? [] : [{ poster_path: path }] });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("resolvePosters", () => {
  it("looks up missing films with the bearer token and year, then caches hits and misses", async () => {
    const tmdb = fakeTmdb({ Heat: "/heat.jpg", Obscure: null });
    const films = [{ title: "Heat", year: 1995 }, { title: "Obscure", year: 2001 }];
    const r = await resolvePosters(films, {}, "tok", NOW, tmdb.fetcher);
    expect(tmdb.calls).toHaveLength(2);
    expect(tmdb.calls[0].auth).toBe("Bearer tok");
    expect(tmdb.calls[0].url.searchParams.get("year")).toBe("1995");
    expect(r.posters.get(filmKey(films[0]))).toBe("/heat.jpg");
    expect(r.posters.has(filmKey(films[1]))).toBe(false);
    expect(r.changed).toBe(true);

    // Second view: everything comes from the cache, no TMDB calls.
    const again = fakeTmdb({});
    const r2 = await resolvePosters(films, r.cache, "tok", NOW, again.fetcher);
    expect(again.calls).toHaveLength(0);
    expect(r2.changed).toBe(false);
    expect(r2.posters.get(filmKey(films[0]))).toBe("/heat.jpg");
  });

  it("prefers the exact title from that year over a more popular near-match, and looks picks up by IMDb id", async () => {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/3/find/tt1663202") {
        expect(url.searchParams.get("external_source")).toBe("imdb_id");
        return Response.json({ movie_results: [{ title: "The Revenant", poster_path: "/revenant.jpg" }], tv_results: [] });
      }
      return Response.json({
        results: [
          { title: "The Lion King", release_date: "2019-07-12", poster_path: "/lion.jpg" },
          { title: "The King", release_date: "2017-01-18", poster_path: "/korean.jpg" },
          { title: "The King", release_date: "2019-10-11", poster_path: "/king.jpg" },
        ],
      });
    }) as typeof fetch;
    const king = { title: "the king!", year: 2019 };
    const unknown = { title: "Kingly", year: 2019 };
    const pick = { title: "The Revenant", year: 2015, imdbId: "tt1663202" };
    const r = await resolvePosters([king, unknown, pick], {}, "tok", NOW, fetcher);
    expect(r.posters.get(filmKey(king))).toBe("/king.jpg");
    expect(r.posters.get(filmKey(unknown))).toBe("/lion.jpg"); // no exact title: the top result, as before
    expect(r.posters.get(filmKey(pick))).toBe("/revenant.jpg");
    expect(paths.filter((p) => p.startsWith("/3/find/"))).toHaveLength(1);
  });

  it("retries misses after 30 days, and never caches failures", async () => {
    const film = { title: "Obscure", year: 2001 };
    const cache: PosterCache = { [filmKey(film)]: { miss: "2026-10-01T00:00:00Z" } };
    const tmdb = fakeTmdb({ Obscure: "/found.jpg" });
    expect((await resolvePosters([film], cache, "tok", NOW, tmdb.fetcher)).posters.get(filmKey(film))).toBe("/found.jpg");

    const down = fakeTmdb({}, ["Heat"]);
    const r = await resolvePosters([{ title: "Heat", year: 1995 }], {}, "tok", NOW, down.fetcher);
    expect(r.changed).toBe(false);
    expect(r.cache).toEqual({});
  });

  it("caps lookups per view, ignores odd poster paths, and does nothing without a token", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `F${i}`, year: 2000 }));
    const tmdb = fakeTmdb({});
    await resolvePosters(many, {}, "tok", NOW, tmdb.fetcher);
    expect(tmdb.calls).toHaveLength(MAX_LOOKUPS_PER_VIEW);

    const evil = fakeTmdb({ X: '"><script>' });
    const r = await resolvePosters([{ title: "X", year: null }], {}, "tok", NOW, evil.fetcher);
    expect(r.posters.size).toBe(0);

    const none = fakeTmdb({});
    expect((await resolvePosters(many, {}, undefined, NOW, none.fetcher)).posters.size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });
});

describe("posters on the page", () => {
  const opts = { uploadAction: "/u", status: null, now: NOW };

  it("shows TMDB images, placeholders for films without one, nothing without posters", () => {
    const d = fixture();
    const first = d.diary.find((e) => e.name === "Paddington 2")!;
    const posters = new Map([[filmKey({ title: first.name, year: first.year }), "/p2.jpg"]]);
    const html = renderPage(d, emptyMemory(), { ...opts, posters });
    expect(html).toContain('src="https://image.tmdb.org/t/p/w185/p2.jpg"');
    expect(html).toContain('srcset="https://image.tmdb.org/t/p/w342/p2.jpg 2x"');
    expect(html).toContain('<span class="poster none">Se7en</span>');
    expect(html).toContain("Posters from TMDB");
    // Without posters at all, every film is a title tile and TMDB isn't mentioned.
    const plain = renderPage(d, emptyMemory(), opts);
    expect(plain).not.toContain("<img");
    expect(plain).toContain('<span class="poster none">Paddington 2</span>');
    expect(plain).not.toContain("TMDB");
  });
});
