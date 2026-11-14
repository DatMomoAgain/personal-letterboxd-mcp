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
    expect(html).not.toMatch(/<script|<img src=x|<b>bold|<i>why/);
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
    expect(html).toMatch(/<h2>The Wailing<\/h2>\s*<p class="pick-meta">2016 <span class="badge">on your watchlist/);
    expect(html).toContain("epic battles");
    expect(html).toContain("2 picks from Claude, Nov 14");
    // One strip button per pick shown.
    expect(html.match(/class="thumb"/g)).toHaveLength(2);
  });

  it("all picks watched → friendly empty state", () => {
    const memory: Memory = { ...emptyMemory(), picks: { updatedAt: "2026-11-14", items: [{ title: "Heat", year: 1995, why: "x" }] } };
    expect(render(fixture(), memory)).toContain("You've watched everything Claude picked");
  });

  it("films wall: every watched film, newest first, with rating, watch dates and review", () => {
    const html = render(fixture());
    expect(html.match(/<a class="film"/g)).toHaveLength(7);
    const order = [...html.matchAll(/data-t="([^"]*)"/g)].map((m) => m[1]);
    // Diary dates beat the day a film was marked watched; Heat is watched but unrated.
    expect(order.slice(0, 3)).toEqual(["cats", "paddington2", "se7en"]);
    expect(order).toContain("amelie"); // accents folded for search
    expect(html).toMatch(/data-t="heat" data-r="" data-y="1995" data-l="1" data-v="0"/);
    expect(html).toMatch(/<h3>Paddington 2<\/h3>.*★★★★★.*Watched Oct 5, 2025.*Perfect\./s);
    expect(html).toContain("Not rated");
  });

  it("nudges when data is stale, and explains how to start when there is none", () => {
    const d = fixture();
    d.uploadedAt = "2026-09-01T00:00:00Z";
    expect(render(d)).toContain("Your data is 80 days old");
    expect(render(fixture())).not.toContain("days old");
    const empty = render(null);
    expect(empty).toContain("No data yet");
    expect(empty).not.toContain('id="films"');
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

  it("has three views in order, each reachable from the nav", () => {
    const html = render(fixture());
    const at = (id: string) => html.indexOf(`<section class="view" id="${id}"`);
    expect(at("watch")).toBeGreaterThan(-1);
    expect(at("watch")).toBeLessThan(at("films"));
    expect(at("films")).toBeLessThan(at("taste"));
    for (const id of ["watch", "films", "taste"]) expect(html).toContain(`<a href="#${id}">`);
  });

  it("groups notes by topic, with title, detail and example films", () => {
    const note = (id: string, text: string, extra = {}) => ({ id, text, createdAt: "", updatedAt: "", ...extra });
    const memory: Memory = {
      ...emptyMemory(),
      notes: [
        note("n1", "2.5 stars means average for me. Three and up means I liked it."),
        note("n2", "Needs a person at the centre.", {
          title: "Documentaries",
          topic: "formats",
          examples: [
            { title: "Se7en", year: 1995, why: "<tense>" },
            { title: "Cats", year: 2019 },
            { title: "Unknown Doc", year: null, verdict: "mixed" },
          ],
        }),
        note("n3", "Characters first.", { title: "Craft", topic: "loves" }),
      ],
    };
    const html = render(fixture(), memory);
    // Topic order follows TOPICS; untitled, topicless notes go last and are split at the first sentence.
    const order = ["t-loves", "t-formats", "t-other"].map((id) => html.indexOf(`id="${id}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
    expect(html).toContain('<a href="#t-formats">Genres and formats <span class="num">1</span></a>');
    expect(html).toContain("<h4>2.5 stars means average for me.</h4>\n    <p>Three and up means I liked it.</p>");
    expect(html).toContain("<h4>Documentaries</h4>\n    <p>Needs a person at the centre.</p>");
    // The user's own rating decides the verdict when Claude didn't give one; links go to their Letterboxd entry.
    expect(html).toMatch(/<li class="ex liked">\s*<a href="https:\/\/boxd.it\/s7"[^]*?★★★★<\/span> · &lt;tense&gt;/);
    expect(html).toMatch(/<li class="ex disliked">[^]*?Cats/);
    expect(html).toMatch(/<li class="ex mixed">[^]*?Unknown Doc<\/span><span class="ex-note">Mixed</);
  });

  it("rating and decade charts link to the matching films", () => {
    const html = render(fixture());
    expect(html).toContain('data-jump-rating="4"');
    expect(html).toContain('data-jump-rating="" disabled'); // nothing rated 0.5
    expect(html).toContain('data-jump-decade="1990"');
    expect(html).toContain('<option value="1990">1990s</option>');
  });

  it("includes the script only with a nonce, and the font only with a font address", () => {
    const opts = { uploadAction: "/u", status: null, now: NOW };
    expect(render(fixture())).not.toMatch(/<script|@font-face/);
    const html = renderPage(fixture(), emptyMemory(), { ...opts, nonce: "abc", fontBase: "/home/t" });
    expect(html).toContain('<script nonce="abc">');
    expect(html).toContain('url("/home/t/font-latin.woff2")');
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
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("DatMomoAgain");
    expect(html).toContain(`action="/home/${TOKEN}/upload"`);
    // Only the page's own script may run: its nonce matches the header and changes per request.
    const nonce = /<script nonce="([^"]+)">/.exec(html)![1];
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).not.toMatch(/connect-src|unsafe-eval|script-src[^;]*(https:|\*|'self')/);
    const again = await (await worker.fetch(new Request(HOME), env(fakeKv(fixture())))).text();
    expect(again).not.toContain(nonce);
  });

  it("serves the font only under the secret path", async () => {
    const res = await worker.fetch(new Request(`${HOME}/font-latin.woff2`), env(fakeKv(null)));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    const wrong = `${ORIGIN}/home/${"b".repeat(64)}/font-latin.woff2`;
    expect((await worker.fetch(new Request(wrong), env(fakeKv(null)))).status).toBe(404);
    expect((await worker.fetch(new Request(`${HOME}/other.woff2`), env(fakeKv(null)))).status).toBe(404);
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
