import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { NO_DATA_MESSAGE } from "../src/server.ts";
import type { Dataset } from "../src/types.ts";
import { fixture } from "./fixture.ts";

const TOKEN = "a".repeat(64);
const ORIGIN = "https://letterboxd-mcp.example.workers.dev";

/** A Map-backed stand-in for the KV namespace. */
function fakeKv(data: Dataset | null) {
  const store = new Map<string, string>();
  if (data) store.set("dataset", JSON.stringify(data));
  const ns = {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
  return { store, ns };
}

const env = (data: Dataset | null = fixture(), token: string | undefined = TOKEN, kv = fakeKv(data)): Env =>
  ({ MCP_TOKEN: token, LETTERBOXD: kv.ns }) as Env;

const rpc = (path: string, body: unknown) =>
  new Request(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("worker routing", () => {
  const paths = [
    "/",
    "/mcp",
    `/mcp/${TOKEN.slice(0, -1)}`,
    `/mcp/${TOKEN}/extra`,
    `/mcp/${TOKEN}/upload`,
    `/mcp/${"b".repeat(64)}`,
    `/home/${"b".repeat(64)}`,
    `/home/${"b".repeat(64)}/upload`,
    `/home/${TOKEN}/other`,
    `/${TOKEN}`,
  ];
  for (const path of paths) {
    it(`404 on ${path.length > 20 ? path.slice(0, 20) + "…" : path}`, async () => {
      const res = await worker.fetch(rpc(path, initialize), env());
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    });
  }

  it("404 for everything when MCP_TOKEN is unset or short", async () => {
    expect((await worker.fetch(rpc("/mcp/", initialize), env(fixture(), undefined))).status).toBe(404);
    expect((await worker.fetch(rpc("/mcp/undefined", initialize), env(fixture(), undefined))).status).toBe(404);
    expect((await worker.fetch(rpc("/mcp/short", initialize), env(fixture(), "short"))).status).toBe(404);
  });

  it("404 on GET to the root", async () => {
    expect((await worker.fetch(new Request(ORIGIN + "/"), env())).status).toBe(404);
  });
});

describe("worker MCP", () => {
  it("initialize succeeds on the secret path", async () => {
    const res = await worker.fetch(rpc(`/mcp/${TOKEN}`, initialize), env());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.serverInfo.name).toBe("letterboxd");
  });

  it("tools/call works on the secret path", async () => {
    const res = await worker.fetch(rpc(`/mcp/${TOKEN}`, call("get_taste_summary")), env());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const summary = JSON.parse(body.result.content[0].text);
    expect(summary.counts.rated).toBe(6);
  });

  it("GET on the secret path is 405, not a never-ending stream", async () => {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/mcp/${TOKEN}`, { headers: { accept: "text/event-stream" } }),
      env(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("memory tools persist to KV under 'memory'", async () => {
    const kv = fakeKv(fixture());
    await worker.fetch(rpc(`/mcp/${TOKEN}`, call("remember", { note: "Loves set pieces" })), env(fixture(), TOKEN, kv));
    expect(JSON.parse(kv.store.get("memory")!).notes[0].text).toBe("Loves set pieces");
  });

  it("empty KV gives the no-data message", async () => {
    const res = await worker.fetch(rpc(`/mcp/${TOKEN}`, call("get_watched")), env(null));
    const body: any = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(NO_DATA_MESSAGE);
  });
});
