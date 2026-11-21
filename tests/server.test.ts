import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inMemoryStore, normalizeMemory } from "../src/memory.ts";
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
    const readOnly = ["check_films", "find_film", "get_memory", "get_reviews", "get_taste_summary", "get_watched", "get_watchlist"];
    const writing = [
      "forget",
      "remember",
      "remove_picks",
      "save_overview",
      "save_picks",
      "save_title_note",
      "set_dont_recommend",
      "update_note",
      "update_pick",
    ];
    expect(tools.map((t) => t.name).sort()).toEqual([...readOnly, ...writing].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(readOnly.includes(t.name));
    for (const name of ["forget", "remove_picks"]) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint).toBe(true);
    }
    // The user approves every write: each writing tool says so, and so do the instructions.
    for (const t of tools.filter((t) => writing.includes(t.name))) expect(t.description).toMatch(/user (confirms|agrees)|they (confirm|agree)/);
    const instructions = client.getInstructions() ?? "";
    for (const name of writing) expect(instructions).toContain(name);
    expect(instructions.replace(/\s+/g, " ")).toContain(
      "never call remember, update_note, forget, save_overview, save_picks, update_pick, remove_picks, set_dont_recommend " +
        "or save_title_note without the user's yes",
    );
    // Removed or renamed tools: nothing should still point Claude at them.
    const everything = [instructions, ...tools.map((t) => t.description ?? "")].join("\n");
    for (const old of ["has_seen", "get_diary", "add_dont_recommend", "update_dont_recommend", "remove_dont_recommend"]) {
      expect(everything).not.toContain(old);
    }
    expect(everything).not.toMatch(/\):\S/); // no missing space after a closing bracket and colon
  });

  it("title records: don't-recommend and Claude notes for any title, all in check_films, none in get_memory", async () => {
    const memory = inMemoryStore();
    const client = await connect(fixture(), memory);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return { res, body: res.isError ? text(res) : JSON.parse(text(res)) };
    };

    expect((await call("set_dont_recommend", { entries: [{ title: "Barry", reason: "x" }] })).res.isError).toBe(true); // no id
    const set = await call("set_dont_recommend", {
      entries: [
        { title: "Barry", year: 2018, imdbId: "tt5348176", reason: "dropped in season 1" },
        { title: "Se7en", year: 1996, imdbId: "tt0114369", reason: "seen it, not again" },
      ],
    });
    // The reply says which titles are logged on Letterboxd (Se7en is, a year off), and links them for exact joins.
    expect(set.body).toEqual([
      { imdbId: "tt5348176", title: "Barry (2018)", dontRecommend: "added", letterboxd: "not logged on Letterboxd" },
      { imdbId: "tt0114369", title: "Se7en (1996)", dontRecommend: "added", letterboxd: "logged: Se7en (1995)" },
    ]);
    expect(memory.current.titles?.tt0114369.letterboxdUri).toMatch(/^https:\/\/boxd\.it\//);
    expect(memory.current.titles?.tt5348176.letterboxdUri).toBeUndefined();

    // A changed reason keeps when it was added.
    const addedAt = memory.current.titles?.tt5348176.dontRecommend?.addedAt;
    expect((await call("set_dont_recommend", { entries: [{ title: "Barry", year: 2018, imdbId: "tt5348176", reason: "female lead" }] })).body[0].dontRecommend).toBe("reason changed");
    expect(memory.current.titles?.tt5348176.dontRecommend).toEqual({ reason: "female lead", addedAt });

    // One Claude note per title: saving again replaces it and keeps the old text as the previous version.
    expect((await call("save_title_note", { title: "Heat", year: 1995, imdbId: "tt0113277", note: "Loved the bank heist." })).body).toMatchObject({
      note: "saved",
      letterboxd: "logged: Heat (1995)",
    });
    expect((await call("save_title_note", { title: "Heat", year: 1995, imdbId: "tt0113277", note: "Loved the heist; the rest dragged." })).body.note).toMatch(/^replaced/);
    expect(memory.current.titles?.tt0113277).toMatchObject({
      note: { text: "Loved the heist; the rest dragged." },
      previousNote: { text: "Loved the bank heist." },
    });
    await call("save_title_note", { title: "Hannibal", year: 2013, imdbId: "tt2243973", note: "Series, loved it." });

    // check_films: everything about each title in one place, by title (a year off) or by IMDb id.
    const checked = (
      await call("check_films", {
        films: [{ title: "barry", year: 2019 }, { title: "Se7en" }, { title: "Heat" }, { title: "Hannibal TV", imdbId: "tt2243973" }, { title: "Ran" }],
      })
    ).body;
    expect(checked[0]).toMatchObject({ query: "barry", matches: [], dontRecommend: { reason: "female lead" }, recordImdbId: "tt5348176" });
    expect(checked[1]).toMatchObject({ exactMatch: true, dontRecommend: { reason: "seen it, not again" } });
    expect(checked[1].matches[0]).toMatchObject({ name: "Se7en", watched: true });
    expect(checked[2]).toMatchObject({ claudeNote: { text: "Loved the heist; the rest dragged.", updatedOn: expect.any(String) } });
    expect(checked[2].dontRecommend).toBeUndefined();
    expect(checked[3]).toMatchObject({ imdbId: "tt2243973", matches: [], claudeNote: { text: "Series, loved it." } });
    expect(checked[4]).toEqual({ query: "Ran", exactMatch: false, matches: [] });
    expect((await call("check_films", { films: [{ title: "Barry", year: 2010 }] })).body[0].dontRecommend).toBeUndefined();

    // get_watched marks films with a note; get_memory carries none of it.
    const watchedFilms = (await call("get_watched", {})).body.items;
    expect(watchedFilms.filter((f: { hasClaudeNote?: boolean }) => f.hasClaudeNote).map((f: { name: string }) => f.name)).toEqual(["Heat"]);
    const got = (await call("get_memory", {})).body;
    expect(got.titles).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain("Loved the heist");

    // Clearing: null takes a title off don't-recommend, or deletes its note; an empty record disappears.
    expect((await call("set_dont_recommend", { entries: [{ title: "Barry", imdbId: "tt5348176", reason: null }] })).body[0].dontRecommend).toBe("taken off");
    expect(memory.current.titles?.tt5348176).toBeUndefined();
    await call("save_title_note", { title: "Heat", imdbId: "tt0113277", note: null });
    expect(memory.current.titles?.tt0113277).toBeUndefined();
    expect((await call("save_title_note", { title: "Heat", imdbId: "tt0113277", note: null })).res.isError).toBe(true);
  });

  it("check_films: an unlogged pick carries its reason on the result; works before any upload", async () => {
    const memory = inMemoryStore({
      notes: [],
      overview: null,
      picks: { items: [{ title: "Thief", year: 1981, imdbId: "tt0083190", why: "Mann's first" }], updatedAt: "2026-11-01T00:00:00.000Z" },
      titles: { tt2243973: { title: "Hannibal", year: 2013, note: { text: "Series, loved it.", updatedAt: "2026-11-20T00:00:00.000Z" } } },
    });
    const withData = await connect(fixture(), memory);
    const body = JSON.parse(text(await withData.callTool({ name: "check_films", arguments: { films: [{ title: "Thief", year: 1981 }] } })));
    expect(body[0]).toMatchObject({ matches: [], pickedBecause: "Mann's first", onWatchNext: true });

    const noData = await connect(null, memory);
    const early = JSON.parse(text(await noData.callTool({ name: "check_films", arguments: { films: [{ title: "Hannibal" }] } })));
    expect(early[0]).toMatchObject({ matches: [], claudeNote: { text: "Series, loved it." } });
  });

  it("converts the old don't-recommend list into title records, and links titles logged since", async () => {
    const memory = inMemoryStore(
      normalizeMemory({
        notes: [],
        overview: null,
        picks: null,
        dontRecommend: [
          { title: "RRR", year: 2022, imdbId: "tt8178634", reason: "didn't like it", addedAt: "2026-11-21T00:00:00.000Z" },
          { title: "Heat", year: 1995, imdbId: "tt0113277", reason: "seen it", addedAt: "2026-11-21T00:00:00.000Z" },
        ],
      }),
    );
    expect(memory.current.titles?.tt8178634).toEqual({
      title: "RRR",
      year: 2022,
      dontRecommend: { reason: "didn't like it", addedAt: "2026-11-21T00:00:00.000Z" },
    });
    expect(memory.current).not.toHaveProperty("dontRecommend");
    // get_memory (every chat's first call) links Heat to the logged film, and saves that.
    const client = await connect(fixture(), memory);
    await client.callTool({ name: "get_memory", arguments: {} });
    expect(memory.current.titles?.tt0113277.letterboxdUri).toMatch(/^https:\/\/boxd\.it\//);
    expect(memory.current.titles?.tt8178634.letterboxdUri).toBeUndefined();
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
      picks: [{ title: "Thief", year: 1981, imdbId: "tt0083190", why: "Pacing" }, { title: "Ran", imdbId: "tt0089881", why: "Epic" }],
    });

    const got = (await call("get_memory")).body;
    expect(got.notes.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([["n2", "Pacing matters a lot"]]);
    expect(got.overview.text).toBe("You love spectacle.");
    expect(got.picks.items).toEqual([
      { title: "Thief", year: 1981, imdbId: "tt0083190", why: "Pacing", addedAt: expect.any(String) },
      { title: "Ran", year: null, imdbId: "tt0089881", why: "Epic", addedAt: expect.any(String) },
    ]);
    // A new note never reuses a forgotten id.
    expect((await call("remember", { note: "x" })).body.id).toBe("n3");
  });

  it("picks: saves add newest first, a re-saved film moves up, watched films are left out; edit and remove by id", async () => {
    const memory = inMemoryStore();
    const client = await connect(fixture(), memory);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const list = () => memory.current.picks?.items.map((p) => [p.title, p.why]);

    await call("save_picks", {
      picks: [{ title: "Thief", year: 1981, imdbId: "tt0083190", why: "a" }, { title: "Ran", year: 1985, imdbId: "tt0089881", why: "b" }],
    });
    // Heat (1995) is watched in the fixture, so it's left out; Ran was already on the list and moves up.
    const second = JSON.parse(
      text(
        await call("save_picks", {
          picks: [
            { title: "Heat", year: 1995, imdbId: "tt0113277", why: "c" },
            { title: "Sorcerer", year: 1977, imdbId: "tt0076740", why: "d" },
            { title: "Ran", year: 1985, imdbId: "tt0089881", why: "b2" },
          ],
        }),
      ),
    );
    expect(second).toMatchObject({ saved: 2, onList: 3, leftOutAlreadyWatched: ["Heat (1995)"] });
    expect(list()).toEqual([["Sorcerer", "d"], ["Ran", "b2"], ["Thief", "a"]]);

    // Editing keeps the pick's place and changes only what's passed.
    await call("update_pick", { imdbId: "tt0083190", why: "a2" });
    expect(memory.current.picks?.items[2]).toEqual({ title: "Thief", year: 1981, imdbId: "tt0083190", why: "a2", addedAt: expect.any(String) });
    // A film they'd already watched was never on the list, so it isn't a past pick either.
    expect(memory.current.pastPicks ?? []).toEqual([]);
    expect((await call("update_pick", { imdbId: "tt0083190" })).isError).toBe(true); // nothing to change
    expect((await call("update_pick", { imdbId: "tt0000001", why: "x" })).isError).toBe(true); // not on the list

    const removed = JSON.parse(text(await call("remove_picks", { imdbIds: ["tt0089881", "tt0000001"] })));
    expect(removed).toEqual({ removed: ["tt0089881"], notOnList: ["tt0000001"], onList: 2 });
    expect(list()).toEqual([["Sorcerer", "d"], ["Thief", "a2"]]);
    expect((await call("remove_picks", { imdbIds: ["tt0000001"] })).isError).toBe(true);
  });

  it("get_memory moves picks the user has since watched to pastPicks, keeping their reasons", async () => {
    const heat = { title: "Heat", year: 1995, imdbId: "tt0113277", why: "watched since it was picked", addedAt: "2026-11-02T10:00:00.000Z" };
    const thief = { title: "Thief", year: 1981, imdbId: "tt0083190", why: "still to watch" };
    const memory = inMemoryStore({ notes: [], overview: null, picks: { items: [heat, thief], updatedAt: "2026-11-01T00:00:00.000Z" } });
    const client = await connect(fixture(), memory);
    const got = JSON.parse(text(await client.callTool({ name: "get_memory", arguments: {} })));
    expect(got.picks.items).toEqual([thief]);
    expect(got.pastPicks).toBeUndefined(); // kept out of get_memory; they show up as pickedBecause instead
    expect(memory.current.picks).toEqual({ items: [thief], updatedAt: "2026-11-01T00:00:00.000Z" });
    expect(memory.current.pastPicks).toEqual([{ ...heat, movedAt: expect.any(String) }]);

    // Its reason now comes with the film wherever Claude looks it up.
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(text(await client.callTool({ name, arguments: args })));
    const seen = await call("check_films", { films: [{ title: "Heat", year: 1995 }, { title: "Se7en" }] });
    expect(seen[0].matches[0]).toMatchObject({ name: "Heat", pickedBecause: "watched since it was picked", pickedOn: "2026-11-02" });
    expect(seen[1].matches[0].pickedBecause).toBeUndefined();
    const watchedFilms = (await call("get_watched", {})).items;
    expect(watchedFilms.filter((f: { pickedBecause?: string }) => f.pickedBecause).map((f: { name: string }) => f.name)).toEqual(["Heat"]);

    // Watching it again later, or a second get_memory, doesn't duplicate it.
    await call("get_memory", {});
    expect(memory.current.pastPicks).toHaveLength(1);
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

  it("check_films takes a list and answers each film in order", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({
      name: "check_films",
      arguments: { films: [{ title: "suspiria", year: 1977 }, { title: "Mulholland Drive" }] },
    });
    const body = JSON.parse(text(res));
    expect(body).toHaveLength(2);
    expect(body[0].matches).toHaveLength(1);
    expect(body[0].matches[0]).toMatchObject({ name: "Suspiria", year: 1977, rating: 4, watched: true });
    expect(body[1]).toMatchObject({ query: "Mulholland Drive", exactMatch: false, matches: [] });
    // List only: the old single-title form is rejected.
    expect((await client.callTool({ name: "check_films", arguments: { title: "Heat" } })).isError).toBe(true);
    const tooMany = Array.from({ length: 26 }, () => ({ title: "Heat" }));
    expect((await client.callTool({ name: "check_films", arguments: { films: tooMany } })).isError).toBe(true);
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
    const bad = await client.callTool({ name: "get_watched", arguments: { watchedFrom: "last week" } });
    expect(bad.isError).toBe(true);
  });
});
