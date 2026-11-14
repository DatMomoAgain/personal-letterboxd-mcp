import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inMemoryStore } from "../src/memory.ts";
import { NO_DATA_MESSAGE, buildServer } from "../src/server.ts";
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
    const readOnly = ["find_film", "get_diary", "get_memory", "get_ratings", "get_reviews", "get_taste_summary", "get_watchlist", "has_seen"];
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

  it("save_picks requires an IMDb id, checks it, and reports what it matched", async () => {
    const memory = inMemoryStore();
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.host === "api.themoviedb.org") {
        if (url.pathname === "/3/search/multi") return Response.json({ results: [{ id: 281957, media_type: "movie", title: "The Revenant", release_date: "2015-12-25", vote_count: 18000 }] });
        return Response.json({ imdb_id: "tt1663202" });
      }
      return url.searchParams.get("i") === "tt1663202"
        ? Response.json({ Response: "True", Title: "The Revenant", Year: "2015", imdbRating: "8.0" })
        : Response.json({ Response: "False", Error: "Incorrect IMDb ID." });
    }) as typeof fetch;
    const server = buildServer(fixture(), memory, { tmdbToken: "tok", omdbKey: "k", fetcher });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    const lookedUp = JSON.parse(text(await call("find_film", { films: [{ title: "The Revenant", year: 2015 }] })));
    expect(lookedUp[0].candidates[0]).toMatchObject({ imdbId: "tt1663202", type: "film", year: 2015 });

    expect((await call("save_picks", { picks: [{ title: "The Revenant", why: "x" }] })).isError).toBe(true); // no id
    const wrong = await call("save_picks", { picks: [{ title: "The Revenant", imdbId: "tt9999999", why: "x" }] });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain("tt9999999 (The Revenant)");
    expect(memory.current.picks).toBeNull(); // nothing saved

    const ok = JSON.parse(text(await call("save_picks", { picks: [{ title: "The Revenant", year: 2015, imdbId: "tt1663202", why: "x" }] })));
    expect(ok.picks).toEqual([{ imdbId: "tt1663202", youSaid: "The Revenant (2015)", onImdb: "The Revenant (2015)" }]);
    expect(memory.current.picks?.items[0].imdbId).toBe("tt1663202");
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

  it("has_seen returns JSON matches", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "has_seen", arguments: { title: "suspiria", year: 1977 } });
    const body = JSON.parse(text(res));
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ name: "Suspiria", year: 1977, rating: 4, watched: true });
  });

  it("get_ratings passes filters through", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "get_ratings", arguments: { minRating: 4.5 } });
    expect(JSON.parse(text(res)).items.map((f: { name: string }) => f.name)).toEqual(["Paddington 2", "Amélie"]);
  });

  it("tools report missing dataset", async () => {
    const client = await connect(null);
    const res = await client.callTool({ name: "get_ratings", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe(NO_DATA_MESSAGE);
    expect(NO_DATA_MESSAGE).toMatch(/personal page/);
  });

  it("rejects invalid input", async () => {
    const client = await connect(fixture());
    const res = await client.callTool({ name: "get_ratings", arguments: { minRating: 9 } });
    expect(res.isError).toBe(true);
    const bad = await client.callTool({ name: "get_diary", arguments: { from: "last week" } });
    expect(bad.isError).toBe(true);
  });
});
