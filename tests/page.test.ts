import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { emptyMemory, type Memory } from "../src/memory.ts";
import { renderPage } from "../src/page.ts";
import type { Dataset } from "../src/types.ts";
import { fixture } from "./fixture.ts";

const TOKEN = "a".repeat(64);
const ORIGIN = "https://letterboxd-mcp.example.workers.dev";
const HOME = `${ORIGIN}/home/${TOKEN}`;
const NOW = new Date("2026-11-20T12:00:00Z");

function fakeKv(data: Dataset | null, memory?: Memory) {
  const store = new Map<string, string>();
  if (data) store.set("dataset", JSON.stringify(data));
  if (memory) store.set("memory", JSON.stringify(memory));
  const ns = {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
  return { store, ns };
}
const env = (kv: ReturnType<typeof fakeKv>) => ({ MCP_TOKEN: TOKEN, LETTERBOXD: kv.ns }) as Env;

const render = (data: Dataset | null, memory: Memory = emptyMemory(), status: "ok" | null = null) =>
  renderPage(data, memory, { uploadAction: "/home/x/upload", status, now: NOW });

describe("renderPage", () => {
  it("escapes everything user- or Claude-written", () => {
    const d = fixture();
    d.reviews[0].review = '<script>alert(1)</script> & "quotes"';
    const memory: Memory = {
      notes: [{ id: "n1", text: "<img src=x onerror=alert(1)>", createdAt: "", updatedAt: "" }],
      overview: { text: "<b>bold</b>", updatedAt: "2026-11-14T00:00:00Z" },
      picks: { items: [{ title: '"><script>', year: null, why: "<i>why</i>" }], updatedAt: "2026-11-14T00:00:00Z" },
    };
    const html = render(d, memory);
    expect(html).not.toMatch(/<script>|<img|<b>bold|<i>why/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
  });

  it("shows unwatched picks, hides watched ones, flags watchlist picks", () => {
    const memory: Memory = {
      ...emptyMemory(),
      picks: {
        updatedAt: "2026-11-14T00:00:00Z",
        items: [
          { title: "Se7en", year: 1995, why: "already seen" },
          { title: "The Wailing", year: 2016, why: "folk horror" },
          { title: "Ran", year: 1985, why: "epic battles" },
        ],
      },
    };
    const html = render(fixture(), memory);
    expect(html).not.toContain("already seen");
    expect(html).toMatch(/The Wailing<\/a>.*on your watchlist/s);
    expect(html).toContain("epic battles");
    expect(html).toContain("picked by Claude · Nov 14");
  });

  it("all picks watched → friendly empty state", () => {
    const memory: Memory = { ...emptyMemory(), picks: { updatedAt: "2026-11-14", items: [{ title: "Heat", year: 1995, why: "x" }] } };
    expect(render(fixture(), memory)).toContain("You've watched everything Claude picked");
  });

  it("recent diary with stars, rewatch badge and review", () => {
    const html = render(fixture());
    expect(html).toContain("Recently watched");
    expect(html).toMatch(/Paddington 2<\/a>.*★★★★★.*rewatch.*Perfect\./s);
  });

  it("nudges when data is stale, and explains how to start when there is none", () => {
    const d = fixture();
    d.uploadedAt = "2026-09-01T00:00:00Z";
    expect(render(d)).toContain("Your data is 80 days old");
    expect(render(fixture())).not.toContain("days old");
    const empty = render(null);
    expect(empty).toContain("No data yet");
    expect(empty).not.toContain("Recently watched");
  });

  it("rating bars run 0.5 → 5 and timestamps use the viewer's timezone", () => {
    const html = render(fixture());
    const labels = [...html.matchAll(/class="lbl">([\d.]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5"]);
    const d = fixture();
    d.uploadedAt = "2026-11-13T22:32:00Z"; // Nov 14, 04:02 in India
    const opts = { uploadAction: "/u", status: null, now: NOW };
    expect(renderPage(d, emptyMemory(), opts)).toContain("data as of Nov 13");
    expect(renderPage(d, emptyMemory(), { ...opts, timeZone: "Asia/Kolkata" })).toContain("data as of Nov 14");
    expect(renderPage(d, emptyMemory(), { ...opts, timeZone: "Not/AZone" })).toContain("data as of Nov 13");
  });

  it("links to the Letterboxd profile, only when the username is known", () => {
    const d = fixture();
    d.username = "Some User";
    expect(render(d)).toContain('href="https://letterboxd.com/Some%20User/"');
    d.username = "";
    expect(render(d)).not.toContain("My Letterboxd");
    expect(render(null)).not.toContain("My Letterboxd");
  });

  it("puts Your taste above Recently watched", () => {
    const html = render(fixture());
    expect(html.indexOf("Your taste")).toBeLessThan(html.indexOf("Recently watched"));
  });

  it("pages through the whole diary, clamping out-of-range pages", () => {
    const d = fixture();
    const base = d.diary[0];
    // Film 1 is the newest.
    d.diary = Array.from({ length: 40 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 0, 1) + (40 - i) * 86_400_000).toISOString().slice(0, 10);
      return { ...base, name: `Film ${i + 1}`, uri: `https://boxd.it/f${i + 1}`, date, watchedDate: date };
    });
    const at = (diaryPage: number) =>
      renderPage(d, emptyMemory(), { uploadAction: "/u", status: null, now: NOW, diaryPage });
    const p1 = at(1);
    expect(p1).toContain("Page 1 of 3");
    expect(p1).toContain(">Film 1<");
    expect(p1).not.toContain(">Film 16<");
    expect(p1).toContain('href="?page=2#diary"');
    expect(p1).toContain('<span class="pg off">← Newer</span>');
    const p3 = at(3);
    expect(p3).toContain("Page 3 of 3");
    expect(p3).toContain(">Film 40<");
    expect(p3).toContain('<span class="pg off">Older →</span>');
    expect(at(99)).toContain("Page 3 of 3");
    expect(at(-5)).toContain("Page 1 of 3");
    expect(render(fixture())).not.toContain("Page 1 of"); // one page → no pager
  });

  it("shows the upload result", () => {
    expect(render(fixture(), emptyMemory(), "ok")).toContain("Export uploaded");
  });
});

describe("page routes", () => {
  it("GET serves the page with privacy headers", async () => {
    const res = await worker.fetch(new Request(HOME), env(fakeKv(fixture())));
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("DatMomoAgain");
    expect(html).toContain(`action="/home/${TOKEN}/upload"`);
  });

  it("POST to the page itself, or GET to upload, is 405", async () => {
    expect((await worker.fetch(new Request(HOME, { method: "POST" }), env(fakeKv(null)))).status).toBe(405);
    expect((await worker.fetch(new Request(`${HOME}/upload`), env(fakeKv(null)))).status).toBe(405);
  });

  const upload = (body: BodyInit) => new Request(`${HOME}/upload`, { method: "POST", body });
  const form = (file?: Blob, name = "export.zip") => {
    const f = new FormData();
    if (file) f.set("export", file, name);
    return f;
  };
  const zip = (files: Record<string, string>) =>
    new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))]);

  it("uploading a valid export replaces the dataset and keeps the old one", async () => {
    const kv = fakeKv(fixture());
    const before = kv.store.get("dataset");
    const res = await worker.fetch(
      upload(
        form(
          zip({
            "letterboxd-me/ratings.csv": "Date,Name,Year,Letterboxd URI,Rating\n2026-01-01,Ran,1985,https://boxd.it/r,5\n",
            "letterboxd-me/watched.csv": "Date,Name,Year,Letterboxd URI\n2026-01-01,Ran,1985,https://boxd.it/r\n",
            "letterboxd-me/profile.csv": "Username,Email Address\nDatMomoAgain,secret@example.com\n",
          }),
        ),
      ),
      env(kv),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/home/${TOKEN}?status=ok`);
    const saved = JSON.parse(kv.store.get("dataset")!);
    expect(saved.ratings).toHaveLength(1);
    expect(saved.username).toBe("DatMomoAgain");
    expect(kv.store.get("dataset")).not.toContain("secret@example.com");
    expect(kv.store.get("dataset:previous")).toBe(before);
  });

  const rejected: [string, () => BodyInit, string][] = [
    ["no file", () => form(), "no-file"],
    ["not a zip", () => form(new Blob(["hello"]), "x.zip"), "bad-zip"],
    ["a zip without Letterboxd files", () => form(zip({ "notes.txt": "hi" })), "not-export"],
  ];
  for (const [label, body, status] of rejected) {
    it(`rejects ${label} and leaves the data alone`, async () => {
      const kv = fakeKv(fixture());
      const before = kv.store.get("dataset");
      const res = await worker.fetch(upload(body()), env(kv));
      expect(res.headers.get("location")).toBe(`/home/${TOKEN}?status=${status}`);
      expect(kv.store.get("dataset")).toBe(before);
      expect(kv.store.has("dataset:previous")).toBe(false);
    });
  }

  it("ignores unknown status values in the URL", async () => {
    const res = await worker.fetch(new Request(`${HOME}?status=<script>`), env(fakeKv(fixture())));
    expect(await res.text()).not.toContain("<script>");
  });
});
