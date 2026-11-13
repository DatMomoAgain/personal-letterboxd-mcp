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
    const readOnly = ["get_diary", "get_memory", "get_ratings", "get_reviews", "get_taste_summary", "get_watchlist", "has_seen"];
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
    await call("save_picks", { picks: [{ title: "Heat", year: 1995, why: "Pacing" }, { title: "Ran", why: "Epic" }] });

    const got = (await call("get_memory")).body;
    expect(got.notes.map((n: { id: string; text: string }) => [n.id, n.text])).toEqual([["n2", "Pacing matters a lot"]]);
    expect(got.overview.text).toBe("You love spectacle.");
    expect(got.picks.items).toEqual([
      { title: "Heat", year: 1995, why: "Pacing" },
      { title: "Ran", year: null, why: "Epic" },
    ]);
    // A new note never reuses a forgotten id.
    expect((await call("remember", { note: "x" })).body.id).toBe("n3");
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
