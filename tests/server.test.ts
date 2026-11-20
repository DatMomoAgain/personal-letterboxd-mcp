import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inMemoryStore } from "../src/memory.ts";
import type { RatingsCache } from "../src/ratings.ts";
import { NO_DATA_MESSAGE, type Services, buildServer } from "../src/server.ts";
import type { Dataset } from "../src/types.ts";
import { fixture } from "./fixture.ts";

async function connect(data: Dataset | null, memory = inMemoryStore()) {
  const server = buildServer(data, memory);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (res: unknown) => (res as { content: { type: string; text: string }[] }).content[0].text;

describe("buildServer", () => {
  it("lists the data tools (read-only) and the memory tools", async () => {
    const client = await connect(fixture());
    const { tools } = await client.listTools();
    const readOnly = ["find_film", "get_diary", "get_memory", "get_reviews", "get_taste_summary", "get_watched", "get_watchlist", "has_seen"];
    const writing = ["forget", "remember", "save_overview", "save_picks", "update_note"];
    expect(tools.map((t) => t.name).sort()).toEqual([...readOnly, ...writing].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(readOnly.includes(t.name));
    expect(tools.find((t) => t.name === "forget")?.annotations?.destructiveHint).toBe(true);
  });

  it("memory: remember, update, forget, overview and picks round-trip", async () => {
    const memory = inMemoryStore();
    const client = await connect(fixture(), memory);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { res, body: res.isError ? text(res) : JSON.parse(text(res)) };
    };

    expect((await call("remember", { note: "  2.5 means average  " })).body).toMatchObject({ id: "n1", text: "2.5 means average" });
    expect((await call("remember", { note: "Pacing matters" })).body.id).toBe("n2");
    await call("update_note", { id: "n2", note: "Pacing matters a lot" });
    await call("forget", { id: "n1" });
    expect((await call("forget", { id: "n9" })).res.isError).toBe(true);
    await call("save_overview", { text: "You love spectacle." });
    await call("save_picks", {
      picks: [{ title: "Heat", year: 1995, imdbId: "tt0113277", why: "Pacing" }, { title: "Ran", imdbId: "tt0089881", why: "Epic" }],
    });

    const got = (await call("get_memory")).body;
    expect(got.notes.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([["n2", "Pacing matters a lot"]]);
    expect(got.overview.text).toBe("You love spectacle.");
    expect(got.picks.items).toEqual([
      { title: "Heat", year: 1995, imdbId: "tt0113277", why: "Pacing" },
      { title: "Ran", year: null, imdbId: "tt0089881", why: "Epic" },
    ]);
    // A new note never reuses a forgotten id.
    expect((await call("remember", { note: "x" })).body.id).toBe("n3");
  });

  it("notes carry a title, topic and example films; updates change only what's passed", async () => {
    const memory = inMemoryStore();
    const client = await connect(fixture(), memory);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    await call("remember", {
      note: "Needs a person at the centre.",
      title: "Documentaries",
      topic: "formats",
      examples: [{ title: "Senna", year: 2010, verdict: "liked" }, { title: "Fyre", why: "end dragged" }],
    });
    expect(memory.current.notes[0]).toMatchObject({
      title: "Documentaries",
      topic: "formats",
      examples: [{ title: "Senna", year: 2010, verdict: "liked" }, { title: "Fyre", year: null, why: "end dragged" }],
    });

    await call("update_note", { id: "n1", examples: [{ title: "Dear Zachary", verdict: "liked" }] });
    expect(memory.current.notes[0]).toMatchObject({ text: "Needs a person at the centre.", title: "Documentaries", topic: "formats" });
    expect(memory.current.notes[0].examples).toEqual([{ title: "Dear Zachary", year: null, verdict: "liked" }]);

    await call("update_note", { id: "n1", topic: null });
    expect(memory.current.notes[0].topic).toBeUndefined();
    expect((await call("remember", { note: "x", topic: "not-a-topic" })).isError).toBe(true);
  });

  /** Fake TMDB + OMDb: The Revenant (2015, tt1663202) and Anora (released 2024-10-18, tt28607951); every request recorded. */
  function fakeServices() {
    const urls: URL[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.host === "api.themoviedb.org") {
        if (url.pathname === "/3/search/multi") {
          return url.searchParams.get("query") === "Nope"
            ? Response.json({ results: [] })
            : Response.json({
                results: [
                  { id: 281957, media_type: "movie", title: "The Revenant", release_date: "2015-12-25", vote_count: 18000, overview: "A frontiersman." },
                  { id: 9, media_type: "movie", title: "The Revenant", release_date: "2009-10-01", vote_count: 40 },
                ],
              });
        }
        return Response.json({ imdb_id: "tt1663202" });
      }
      return url.searchParams.get("i") === "tt1663202"
        ? Response.json({ Response: "True", Title: "The Revenant", Year: "2015", Released: "08 Jan 2016", imdbRating: "8.0", imdbVotes: "923,415" })
        : Response.json({ Response: "False", Error: "Incorrect IMDb ID." });
    }) as typeof fetch;
    let cache: RatingsCache = {};
    const ratingsStore = { load: async () => structuredClone(cache), save: async (c: RatingsCache) => void (cache = c) };
    return { urls, fetcher, ratingsStore, cache: () => cache };
  }

  async function connectWith(services: Services, memory = inMemoryStore()) {
    const server = buildServer(fixture(), memory, services);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  }

  it("find_film gives the best guess its IMDb id, rating and vote count, and namesakes without ids", async () => {
    const fake = fakeServices();
    const call = await connectWith({ tmdbToken: "tok", omdbKey: "k", fetcher: fake.fetcher, ratingsStore: fake.ratingsStore });

    const got = JSON.parse(text(await call("find_film", { films: [{ title: "The Revenant", year: 2015 }, { title: "Nope" }] })));
    expect(got[0]).toMatchObject({
      title: "The Revenant",
      year: 2015,
      match: { title: "The Revenant", year: 2015, type: "film", imdbId: "tt1663202", imdbRating: 8, imdbVotes: 923415, tmdbVotes: 18000 },
      otherMatches: [{ title: "The Revenant", year: 2009, tmdbVotes: 40 }],
    });
    expect(got[1]).toEqual({ title: "Nope", match: null, otherMatches: [] });
    // 2 TMDB requests for the found title, 1 for the other, 1 OMDb for the best guess.
    expect(fake.urls.map((u) => u.host)).toEqual(["api.themoviedb.org", "api.themoviedb.org", "api.themoviedb.org", "www.omdbapi.com"]);
    // Released over a year ago, so it's cached and the next lookup skips OMDb.
    expect(fake.cache().tt1663202).toMatchObject({ imdb: "8.0", votes: 923415 });
    fake.urls.length = 0;
    const again = JSON.parse(text(await call("find_film", { films: [{ title: "The Revenant", year: 2015 }] })));
    expect(again[0].match.imdbRating).toBe(8);
    expect(fake.urls.map((u) => u.host)).not.toContain("www.omdbapi.com");
  });

  it("find_film still finds ids without an OMDb key, with null ratings", async () => {
    const fake = fakeServices();
    const call = await connectWith({ tmdbToken: "tok", fetcher: fake.fetcher });
    const got = JSON.parse(text(await call("find_film", { films: [{ title: "The Revenant" }] })));
    expect(got[0].match).toMatchObject({ imdbId: "tt1663202", imdbRating: null, imdbVotes: null });
    expect((await call("find_film", { films: Array.from({ length: 11 }, () => ({ title: "x" })) })).isError).toBe(true);
  });

  it("save_picks requires an IMDb id, checks it, reports what it matched, and caches the scores", async () => {
    const memory = inMemoryStore();
    const fake = fakeServices();
    const call = await connectWith({ tmdbToken: "tok", omdbKey: "k", fetcher: fake.fetcher, ratingsStore: fake.ratingsStore }, memory);

    expect((await call("save_picks", { picks: [{ title: "The Revenant", why: "x" }] })).isError).toBe(true); // no id
    const wrong = await call("save_picks", { picks: [{ title: "The Revenant", imdbId: "tt9999999", why: "x" }] });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("tt9999999 (The Revenant)");
    expect(memory.current.picks).toBeNull(); // nothing saved

    const ok = JSON.parse(text(await call("save_picks", { picks: [{ title: "The Revenant", year: 2015, imdbId: "tt1663202", why: "x" }] })));
    expect(ok.picks).toEqual([{ imdbId: "tt1663202", youSaid: "The Revenant (2015)", onImdb: "The Revenant (2015)" }]);
    expect(memory.current.picks?.items[0].imdbId).toBe("tt1663202");
    // The scores it fetched to check the id are kept for the page.
    expect(fake.cache()).toEqual({
      tt1663202: { imdbId: "tt1663202", imdb: "8.0", votes: 923415, released: "2016-01-08", checked: expect.any(String) },
    });
  });

  it("find_film says so when there's no TMDB token", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "find_film", arguments: { films: [{ title: "Heat" }] } });
    expect(res.isError).toBe(true);
  });

  it("memory tools work before any Letterboxd data is uploaded", async () => {
    const client = await connect(null);
    const res = await client.callTool({ name: "remember", arguments: { note: "Loves Godzilla" } });
    expect(res.isError).toBeFalsy();
  });

  it("has_seen takes a list and answers each film in order", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({
      name: "has_seen",
      arguments: { films: [{ title: "suspiria", year: 1977 }, { title: "Mulholland Drive" }] },
    });
    const body = JSON.parse(text(res));
    expect(body).toHaveLength(2);
    expect(body[0].matches).toHaveLength(1);
    expect(body[0].matches[0]).toMatchObject({ name: "Suspiria", year: 1977, rating: 4, watched: true });
    expect(body[1]).toMatchObject({ query: "Mulholland Drive", exactMatch: false, matches: [] });
    // List only: the old single-title form is rejected.
    expect((await client.callTool({ name: "has_seen", arguments: { title: "Heat" } })).isError).toBe(true);
    const tooMany = Array.from({ length: 26 }, () => ({ title: "Heat" }));
    expect((await client.callTool({ name: "has_seen", arguments: { films: tooMany } })).isError).toBe(true);
  });

  it("get_watched passes filters and sorting through", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "get_watched", arguments: { minRating: 4.5, sort: "rating_desc" } });
    expect(JSON.parse(text(res)).items.map((f: { name: string }) => f.name)).toEqual(["Paddington 2", "Amélie"]);
    const unrated = await client.callTool({ name: "get_watched", arguments: { rated: false } });
    expect(JSON.parse(text(unrated)).items.map((f: { name: string }) => f.name)).toEqual(["Heat"]);
  });

  it("tools report missing dataset", async () => {
    const client = await connect(null);
    const res = await client.callTool({ name: "get_watched", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(NO_DATA_MESSAGE);
    expect(NO_DATA_MESSAGE).toMatch(/personal page/);
  });

  it("rejects invalid input", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "get_watched", arguments: { minRating: 9 } });
    expect(res.isError).toBe(true);
    const bad = await client.callTool({ name: "get_diary", arguments: { from: "last week" } });
    expect(bad.isError).toBe(true);
  });
});
