// The user's personal page: three views (Watch next, Films, Taste) rendered on the server.
// A small inline script (pageScript.ts) switches views and filters; without it the page
// is one long document with everything visible.
import { type Example, type Memory, type Note, TOPICS } from "./memory.ts";
import { PAGE_SCRIPT } from "./pageScript.ts";
import { type FilmRef, filmKey, type Posters, posterUrl } from "./posters.ts";
import type { Ratings } from "./ratings.ts";
import { getFilms, getTasteSummary, hasSeen, type WatchedFilm } from "./queries.ts";
import type { Dataset } from "./types.ts";

export type UploadStatus = "ok" | "no-file" | "too-big" | "bad-zip" | "not-export";

const STATUS_MESSAGES: Record<UploadStatus, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Export uploaded. Claude sees the new data in your next message." },
  "no-file": { ok: false, text: "Choose your Letterboxd export ZIP first." },
  "too-big": { ok: false, text: "That file is too big to be a Letterboxd export." },
  "bad-zip": { ok: false, text: "That isn't a readable ZIP file." },
  "not-export": { ok: false, text: "That ZIP doesn't look like a Letterboxd export (no ratings.csv or watched.csv)." },
};

export const isUploadStatus = (s: string | null): s is UploadStatus => s !== null && s in STATUS_MESSAGES;

/** Data older than this gets a nudge to upload a fresh export. */
const STALE_DAYS = 30;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const stars = (r: number | null) => (r === null ? "" : "★".repeat(Math.floor(r)) + (r % 1 ? "½" : ""));

/** Lowercase letters and digits only, accents removed. The script folds search text the same way. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-05" → "Nov 5, 2026" (or "Nov 5" in the current year). */
function day(iso: string, now: Date): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return esc(iso);
  return `${MONTHS[m - 1]} ${d}${y === now.getUTCFullYear() ? "" : `, ${y}`}`;
}

/** A timestamp (uploadedAt, updatedAt) as a calendar date in the viewer's timezone. */
function stamp(iso: string, now: Date, timeZone: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return day(iso, now);
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-CA", { timeZone }).format(t); // YYYY-MM-DD
  } catch {
    local = iso.slice(0, 10);
  }
  return day(local, now);
}

/** Plain text → paragraphs, keeping single line breaks. */
const paragraphs = (text: string) =>
  text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\r?\n/g, "<br>")}</p>`)
    .join("");

const EXT = 'rel="noreferrer noopener" target="_blank"';
const letterboxdSearch = (title: string) => `https://letterboxd.com/search/films/${encodeURIComponent(title)}/`;
/** Letterboxd redirects this to the film's own page. */
const letterboxdByImdb = (imdbId: string) => `https://letterboxd.com/imdb/${encodeURIComponent(imdbId)}/`;

type Stamp = (iso: string) => string;
type PosterSize = 92 | 185 | 342;
const NEXT_SIZE = { 92: 185, 185: 342, 342: 500 } as const;

/** Poster image, or (no poster known) a tile with the title written on it. */
function tile(posters: Posters | undefined, film: FilmRef, size: PosterSize, lazy = true): string {
  const path = posters?.get(filmKey(film));
  return path
    ? `<img class="poster" src="${esc(posterUrl(path, size))}" srcset="${esc(posterUrl(path, NEXT_SIZE[size]))} 2x" alt="" width="2" height="3"${lazy ? ' loading="lazy"' : ""}>`
    : `<span class="poster none">${esc(film.title)}</span>`;
}

/** IMDb / Rotten Tomatoes / Metacritic, each linking to that site. Empty without scores. */
function scores(ratings: Ratings | undefined, film: { title: string; imdbId?: string }): string {
  const s = film.imdbId ? ratings?.get(film.imdbId) : undefined;
  if (!s) return "";
  const q = encodeURIComponent(film.title);
  const link = (href: string, site: string, value?: string) =>
    `<a href="${esc(href)}" ${EXT}>${value ? `<strong>${esc(value)}</strong> ` : ""}${site}</a>`;
  const parts = [
    link(`https://www.imdb.com/title/${s.imdbId}/`, "IMDb", s.imdb),
    s.rt && link(`https://www.rottentomatoes.com/search?search=${q}`, "Rotten Tomatoes", s.rt),
    s.mc && link(`https://www.metacritic.com/search/${q}/?category=2`, "Metacritic", s.mc),
  ].filter(Boolean);
  return `<div class="scores">${parts.join("")}</div>`;
}

/** Picks not yet watched, flagged if they're on the watchlist. */
function pendingPicks(data: Dataset | null, memory: Memory) {
  return (memory.picks?.items ?? []).flatMap((p) => {
    const seen = data ? hasSeen(data, p.title, p.year ?? undefined) : null;
    const match = seen?.exactMatch ? seen.matches : [];
    if (match.some((m) => m.watched)) return []; // watched since: drop it
    return [{ ...p, onWatchlist: match.some((m) => m.onWatchlist) }];
  });
}

/** The picks the page will show. */
export function picksShown(data: Dataset | null, memory: Memory): FilmRef[] {
  return pendingPicks(data, memory).map((p) => ({ title: p.title, year: p.year, ...(p.imdbId && { imdbId: p.imdbId }) }));
}

/** IMDb ids of the picks the page will show, so scores can be fetched for exactly those. */
export function pickIdsShown(data: Dataset | null, memory: Memory): string[] {
  return pendingPicks(data, memory).flatMap((p) => (p.imdbId ? [p.imdbId] : []));
}

/** Every film the page will show (picks, then films newest first, then taste examples), so posters can be fetched for those. */
export function filmsShown(data: Dataset | null, memory: Memory): FilmRef[] {
  const films = data ? getFilms(data).map((f) => ({ title: f.name, year: f.year })) : [];
  const all = [...picksShown(data, memory), ...films, ...exampleFilms(memory)];
  const seen = new Set<string>();
  return all.filter((f) => !seen.has(filmKey(f)) && seen.add(filmKey(f)));
}

// ---------- Watch next ----------

function watchView(data: Dataset | null, memory: Memory, at: Stamp, posters?: Posters, ratings?: Ratings): string {
  const picks = memory.picks;
  const pending = pendingPicks(data, memory);
  if (!pending.length) {
    return `<section class="view" id="watch"><div class="blank">
      <h2>${picks ? "You've watched everything Claude picked" : "No picks yet"}</h2>
      <p>${picks ? "Ask for more in a chat." : "Ask Claude for recommendations in a chat and they'll show up here."}</p>
    </div></section>`;
  }
  const path = (p: FilmRef) => posters?.get(filmKey(p));
  const first = path(pending[0]);
  const panels = pending
    .map((p, i) => {
      const bg = path(p);
      return `<article class="pick${bg ? "" : " no-poster"}"${bg ? ` data-bg="${esc(posterUrl(bg, 92))}"` : ""}>
        ${bg ? `<div class="pick-poster">${tile(posters, p, 342, i > 0)}</div>` : ""}
        <div class="pick-body">
          <h2>${esc(p.title)}</h2>
          <p class="pick-meta">${p.year ?? ""}${p.onWatchlist ? ' <span class="badge">on your watchlist</span>' : ""}</p>
          ${scores(ratings, p)}
          <p class="why">${esc(p.why)}</p>
          <a class="btn" href="${esc(p.imdbId ? letterboxdByImdb(p.imdbId) : letterboxdSearch(p.title))}" ${EXT}>Open on Letterboxd</a>
        </div>
      </article>`;
    })
    .join("");
  const strip = pending
    .map(
      (p) =>
        `<button type="button" class="thumb" aria-pressed="false" aria-label="${esc(p.title)}${p.year ? ` (${p.year})` : ""}">${tile(posters, p, 92, false)}<span class="thumb-t" aria-hidden="true">${esc(p.title)}</span></button>`,
    )
    .join("");
  // "See all" opens the strip into rows; the script shows it only when the picks overflow the strip.
  const more = `<button type="button" class="see-all" aria-expanded="false" data-n="${pending.length}" hidden><span>See all</span><b>${pending.length}</b></button>`;
  return `<section class="view" id="watch">
    <div class="stage">
      <img class="glow" alt="" aria-hidden="true"${first ? ` src="${esc(posterUrl(first, 92))}"` : " hidden"}>
      ${panels}
    </div>
    <div class="picks-nav"><div class="strip" role="group" aria-label="Claude's picks">${strip}</div>${more}</div>
    <p class="fine">${pending.length} ${pending.length === 1 ? "pick" : "picks"} from Claude, ${at(picks!.updatedAt)}. A pick leaves this list once you've watched it.</p>
  </section>`;
}

// ---------- Films ----------

function filmDetail(f: WatchedFilm, now: Date, posters?: Posters): string {
  const ref = { title: f.name, year: f.year };
  const has = posters?.has(filmKey(ref));
  const dates = f.diaryDates.map((d) => day(d, now));
  return `<div class="fd${has ? "" : " no-poster"}">
    ${has ? tile(posters, ref, 185, false) : ""}
    <div>
      <h3>${esc(f.name)}</h3>
      <p class="muted">${f.year ?? ""}</p>
      <p class="fd-rating">${f.rating === null ? '<span class="muted">Not rated</span>' : `<span class="stars" aria-label="${f.rating} stars">${stars(f.rating)}</span>`}${f.liked ? ' <span class="badge">liked</span>' : ""}</p>
      ${dates.length ? `<p class="muted">Watched ${dates.join(", ")}</p>` : ""}
      ${f.reviews.map((r) => `<blockquote>${paragraphs(r.review)}</blockquote>`).join("")}
      <a class="btn" href="${esc(f.uri || letterboxdSearch(f.name))}" ${EXT}>Open on Letterboxd</a>
    </div>
  </div>`;
}

function filmsView(data: Dataset, now: Date, posters?: Posters): string {
  const films = getFilms(data);
  if (!films.length) return "";
  const ratingSteps = [...new Set(films.flatMap((f) => (f.rating === null ? [] : [f.rating])))].sort((a, b) => b - a);
  const decades = [...new Set(films.flatMap((f) => (f.year ? [Math.floor(f.year / 10) * 10] : [])))].sort((a, b) => b - a);
  const wall = films
    .map((f) => {
      const label = `${f.name}${f.year ? ` (${f.year})` : ""}`;
      return `<li><a class="film" href="${esc(f.uri || letterboxdSearch(f.name))}" ${EXT} title="${esc(label)}" aria-label="${esc(label)}"
        data-t="${esc(fold(f.name))}" data-r="${f.rating ?? ""}" data-y="${f.year ?? ""}" data-l="${f.liked ? 1 : 0}" data-v="${f.reviews.length ? 1 : 0}">
        ${tile(posters, { title: f.name, year: f.year }, 185)}
        <span class="film-stars">${stars(f.rating)}${f.reviews.length ? '<span class="dot" title="Reviewed"></span>' : ""}</span>
      </a><template>${filmDetail(f, now, posters)}</template></li>`;
    })
    .join("");
  return `<section class="view" id="films">
    <div class="tools">
      <input type="search" id="q" placeholder="Search your films" aria-label="Search your films" autocomplete="off">
      <div class="seg" role="group" aria-label="Show">
        <button type="button" data-flag="" aria-pressed="true">All</button>
        <button type="button" data-flag="liked" aria-pressed="false">Liked</button>
        <button type="button" data-flag="reviewed" aria-pressed="false">Reviewed</button>
      </div>
      <select id="rating" aria-label="Rating"><option value="">Any rating</option>${ratingSteps
        .map((r) => `<option value="${r}">${stars(r)}</option>`)
        .join("")}</select>
      <select id="decade" aria-label="Decade"><option value="">Any decade</option>${decades
        .map((d) => `<option value="${d}">${d}s</option>`)
        .join("")}</select>
      <select id="sort" aria-label="Sort">
        <option value="recent">Recently watched</option>
        <option value="high">Highest rated</option>
        <option value="low">Lowest rated</option>
        <option value="new">Newest release</option>
        <option value="old">Oldest release</option>
      </select>
    </div>
    <p class="fine"><span class="count" aria-live="polite">${films.length} ${films.length === 1 ? "film" : "films"}</span>
      <button type="button" class="clear link" hidden>Clear filters</button></p>
    <ul class="wall">${wall}</ul>
    <p class="nomatch" hidden>No films match.</p>
    <button type="button" class="more btn quiet" hidden>Show more</button>
  </section>`;
}

// ---------- Taste ----------

/** Splits a note into its opening sentence and the rest, so the list reads as headlines. */
function splitNote(text: string): [string, string | null] {
  const m = /^(.{20,160}?[.!?])\s+(\S[\s\S]*)$/.exec(text.trim());
  return m ? [m[1], m[2]] : [text.trim(), null];
}

function statsBlock(data: Dataset): string {
  const s = getTasteSummary(data);
  // Object.entries lists integer-like keys ("1", "2"…) before "0.5", so sort numerically.
  const dist = Object.entries(s.ratingDistribution).sort(([a], [b]) => Number(a) - Number(b));
  const maxCount = Math.max(1, ...dist.map(([, n]) => n));
  const maxDecade = Math.max(1, ...s.decades.map((d) => d.watched));
  const counts: [string, number | string][] = [
    ["watched", s.counts.watched],
    ["rated", s.counts.rated],
    ["average rating", s.averageRating ?? "–"],
    ["liked", s.counts.liked],
    ["reviews", s.counts.reviews],
    ["on your watchlist", s.counts.watchlist],
  ];
  return `<dl class="counts">${counts.map(([k, n]) => `<div><dd>${n}</dd><dt>${k}</dt></div>`).join("")}</dl>
    <div class="charts">
      <div>
        <h3>Ratings</h3>
        <div class="bars">${dist
          .map(
            ([step, n]) => `<button type="button" class="bar" data-jump-rating="${n ? step : ""}"${n ? "" : " disabled"} title="${n} rated ${step}★">
              <span class="col"><span class="n">${n || ""}</span><span class="fill" style="height:${Math.round((n / maxCount) * 100)}%"></span></span>
              <span class="lbl">${step}</span></button>`,
          )
          .join("")}</div>
      </div>
      <div>
        <h3>Decades</h3>
        <div class="decades">${s.decades
          .map(
            (d) => `<button type="button" class="dec" data-jump-decade="${Number.parseInt(d.decade, 10)}">
              <span>${d.decade}</span>
              <span class="track"><span class="fill" style="width:${Math.max(2, Math.round((d.watched / maxDecade) * 100))}%"></span></span>
              <span class="num">${d.watched}</span><span class="muted num">${d.averageRating ?? "–"}★</span></button>`,
          )
          .join("")}</div>
      </div>
    </div>`;
}

const VERDICTS = { liked: "Liked", disliked: "Didn't work", mixed: "Mixed" } as const;

/** One example film: poster, title, the user's own rating if they've logged it, and how it landed. */
function exampleChip(data: Dataset | null, e: Example, posters?: Posters): string {
  const seen = data ? hasSeen(data, e.title, e.year ?? undefined) : null;
  const film = seen?.exactMatch ? seen.matches[0] : undefined;
  const ref = exampleRef(e, film?.year);
  const verdict = e.verdict ?? (film?.rating != null ? (film.rating >= 3 ? "liked" : film.rating <= 2 ? "disliked" : "mixed") : undefined);
  const rating = film?.rating != null ? `<span class="stars">${stars(film.rating)}</span>` : "";
  const label = [rating, verdict && !rating ? VERDICTS[verdict] : "", e.why ? esc(e.why) : ""].filter(Boolean).join(" · ");
  return `<li class="ex${verdict ? ` ${verdict}` : ""}">
    <a href="${esc(film?.uri || letterboxdSearch(e.title))}" ${EXT}>
      ${tile(posters, ref, 92)}
      <span class="ex-text"><span class="ex-title">${esc(e.title)}</span>${label ? `<span class="ex-note">${label}</span>` : ""}</span>
    </a></li>`;
}

function themeCard(data: Dataset | null, n: Note, posters?: Posters): string {
  const [lead, rest] = n.title ? [n.title, n.text] : splitNote(n.text);
  const examples = n.examples?.length
    ? `<ul class="examples">${n.examples.map((e) => exampleChip(data, e, posters)).join("")}</ul>`
    : "";
  return `<article class="theme">
    <h4>${esc(lead)}</h4>
    ${rest ? `<p>${esc(rest)}</p>` : ""}
    ${examples}
  </article>`;
}

/** Notes grouped by topic, in TOPICS order; notes without a topic go last. */
function groupNotes(notes: Note[]): { id: string; label: string; notes: Note[] }[] {
  const groups = Object.entries(TOPICS).map(([id, label]) => ({ id, label: label as string, notes: notes.filter((n) => n.topic === id) }));
  groups.push({ id: "other", label: "Other notes", notes: notes.filter((n) => !n.topic || !(n.topic in TOPICS)) });
  return groups.filter((g) => g.notes.length);
}

/** Example films on the Taste view, so their posters get looked up too. */
export function exampleFilms(memory: Memory): FilmRef[] {
  return memory.notes.flatMap((n) => (n.examples ?? []).map((e) => exampleRef(e)));
}

/** The poster lookup for an example: by IMDb id when Claude gave one, else by title and year. */
function exampleRef(e: Example, watchedYear?: number | null): FilmRef {
  return { title: e.title, year: e.year ?? watchedYear ?? null, ...(e.imdbId && { imdbId: e.imdbId }) };
}

function tasteView(data: Dataset | null, memory: Memory, at: Stamp, posters?: Posters): string {
  const overview = memory.overview
    ? `<div class="overview">${paragraphs(memory.overview.text)}<p class="fine">Written by Claude, ${at(memory.overview.updatedAt)}</p></div>`
    : "";
  const groups = groupNotes(memory.notes);
  const themes = groups.length
    ? `<div class="themes">
        <nav class="topics" aria-label="Topics">${groups
          .map((g) => `<a href="#t-${g.id}">${esc(g.label)} <span class="num">${g.notes.length}</span></a>`)
          .join("")}</nav>
        <div class="topic-list">${groups
          .map(
            (g) => `<details class="topic" id="t-${g.id}" open>
              <summary><h3>${esc(g.label)}</h3><span class="num">${g.notes.length}</span></summary>
              <div class="theme-grid">${g.notes.map((n) => themeCard(data, n, posters)).join("")}</div>
            </details>`,
          )
          .join("")}</div>
      </div>`
    : `<p class="muted">No notes yet. They get added as you tell Claude about your taste.</p>`;
  return `<section class="view" id="taste">
    ${overview}
    <div class="head">
      <h2>What Claude remembers</h2>
      <p class="fine">${memory.notes.length ? "To change or remove something, tell Claude in a chat." : ""}${
        memory.overview ? "" : " Ask Claude to write your taste overview and it appears here."
      }</p>
    </div>
    ${themes}
    ${data ? `<div class="head numbers"><h2>In numbers</h2><p class="fine">Select a bar to see those films.</p></div>${statsBlock(data)}` : ""}
  </section>`;
}

// ---------- page ----------

export interface PageOptions {
  uploadAction: string;
  status: UploadStatus | null;
  now?: Date;
  /** Viewer's IANA timezone (Cloudflare's request.cf.timezone); defaults to UTC. */
  timeZone?: string;
  /** Posters for the films shown (from resolvePosters). Omit to show title tiles instead. */
  posters?: Posters;
  /** IMDb / RT / Metacritic scores for the picks (from resolveRatings). Omit to show none. */
  ratings?: Ratings;
  /** CSP nonce for the inline script. Omit to render without the script. */
  nonce?: string;
  /** Where font-latin.woff2 and font-latin-ext.woff2 are served. Omit to use system fonts. */
  fontBase?: string;
}

export function renderPage(data: Dataset | null, memory: Memory, o: PageOptions): string {
  const now = o.now ?? new Date();
  const at: Stamp = (iso) => stamp(iso, now, o.timeZone ?? "UTC");
  const ageDays = data ? (now.getTime() - Date.parse(data.uploadedAt)) / 86_400_000 : Infinity;
  const status = o.status ? STATUS_MESSAGES[o.status] : null;
  const name = data?.username || "My films";
  const filmCount = data ? getFilms(data).length : 0;

  const banner = !data
    ? `<p class="notice">No data yet. On letterboxd.com go to Settings → Data → Export your data, then upload the ZIP with “Update data”.</p>`
    : ageDays > STALE_DAYS
      ? `<p class="notice">Your data is ${Math.floor(ageDays)} days old. Export a fresh copy from Letterboxd (Settings → Data) and upload it with “Update data”.</p>`
      : "";

  const fonts = o.fontBase
    ? `@font-face{font-family:"Big Shoulders";font-weight:100 900;font-display:swap;src:url("${esc(o.fontBase)}/font-latin.woff2") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:"Big Shoulders";font-weight:100 900;font-display:swap;src:url("${esc(o.fontBase)}/font-latin-ext.woff2") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+20A0-20C0,U+2C60-2C7F}`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(name)} · Films</title>
<style>${fonts}${CSS}</style>
</head>
<body>
<header class="top"><div class="bar-in">
  <a class="brand" href="#watch">${esc(name)}</a>
  <nav class="tabs" aria-label="Sections">
    <a href="#watch">Watch next</a>
    <a href="#films">Films${filmCount ? ` <span class="num">${filmCount}</span>` : ""}</a>
    <a href="#taste">Taste</a>
  </nav>
  <button type="button" class="btn quiet" data-open="update">Update data</button>
</div></header>
<main>
  ${status ? `<p class="flash ${status.ok ? "ok" : "err"}" role="status">${esc(status.text)}</p>` : ""}
  ${banner}
  ${watchView(data, memory, at, o.posters, o.ratings)}
  ${data ? filmsView(data, now, o.posters) : ""}
  ${tasteView(data, memory, at, o.posters)}
</main>
<footer>
  <span>${data ? `Letterboxd data as of ${at(data.uploadedAt)}` : "No Letterboxd data uploaded"}</span>
  ${data?.username ? `<a href="https://letterboxd.com/${esc(encodeURIComponent(data.username))}/" ${EXT}>My Letterboxd</a>` : ""}
  ${o.posters ? "<span>Posters from TMDB</span>" : ""}
</footer>
<dialog id="update" aria-labelledby="update-h">
  <h2 id="update-h">Update your data</h2>
  <p>On letterboxd.com, go to Settings → Data → Export your data. Then upload the ZIP it downloads.</p>
  <form class="upload" method="post" action="${esc(o.uploadAction)}" enctype="multipart/form-data">
    <label class="file"><input type="file" name="export" accept=".zip,application/zip" required><span>Choose export ZIP</span></label>
    <button type="submit" class="btn">Upload export</button>
  </form>
  <button type="button" class="link close" data-close>Close</button>
</dialog>
<dialog id="film" aria-label="Film"><div class="film-body"></div><button type="button" class="link close" data-close>Close</button></dialog>
${o.nonce ? `<script nonce="${esc(o.nonce)}">${PAGE_SCRIPT}</script>` : ""}
</body>
</html>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f2f3f5;--surface:#fff;--raise:#e8eaee;--line:#d9dce3;--text:#15171c;--muted:#5d6471;--accent:#ffcf33;--on-accent:#1b1600;--ink:#7d5c00;--err:#b42318;--err-soft:#fde8e6;--glow:.5;
--display:"Big Shoulders","Avenir Next Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;--body:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#181b21;--raise:#22262e;--line:#2c313b;--text:#f1f2f4;--muted:#99a0ad;--ink:#ffcf33;--err:#ff8a7a;--err-soft:#3a1714;--glow:.42}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-padding-top:90px}
@media (max-width:760px){html{scroll-padding-top:124px}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 var(--body);-webkit-font-smoothing:antialiased}
a{color:inherit}
h2,h3,p{margin:0}
.muted{color:var(--muted)}
.num{font-variant-numeric:tabular-nums}
.fine{color:var(--muted);font-size:14px}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:4px}
button,input,select{font:inherit;color:inherit}

.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.bar-in{max-width:1120px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:28px;min-height:60px}
.brand{font:800 26px/1 var(--display);letter-spacing:.01em;text-decoration:none}
.tabs{display:flex;gap:4px;align-self:stretch;margin-right:auto}
.tabs a{display:flex;align-items:center;gap:6px;padding:0 12px;text-decoration:none;color:var(--muted);font-weight:500;font-size:15px;border-bottom:3px solid transparent;margin-bottom:-1px}
.tabs a:hover{color:var(--text)}
.tabs a[aria-current]{color:var(--text);border-bottom-color:var(--accent)}
.tabs .num{font-size:12px;background:var(--raise);border-radius:99px;padding:1px 7px}
main{max-width:1120px;margin:0 auto;padding:28px 20px 40px}
.js .view:not(.on){display:none}
.view+.view{margin-top:56px}
.js .view+.view{margin-top:0}
footer{max-width:1120px;margin:0 auto;padding:0 20px 40px;display:flex;flex-wrap:wrap;gap:6px 24px;color:var(--muted);font-size:13px}

.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;padding:10px 18px;background:var(--accent);color:var(--on-accent);font-weight:600;font-size:15px;text-decoration:none;cursor:pointer}
.btn:hover{filter:brightness(1.07)}
.btn.quiet{background:var(--raise);color:var(--text);padding:8px 14px;font-size:14px}
.link{border:0;background:none;padding:0;color:var(--ink);font-weight:600;font-size:14px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:99px;background:var(--raise);color:var(--text)}
.flash,.notice{border-radius:12px;padding:12px 16px;margin:0 0 20px;font-size:15px;background:var(--surface);border:1px solid var(--line)}
.flash.err{background:var(--err-soft);color:var(--err);border-color:transparent}
.blank{padding:72px 0;max-width:46ch}
.blank h2{font:800 44px/1 var(--display);margin-bottom:12px}

.poster{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:8px;background:var(--raise)}
.poster.none{display:flex;align-items:flex-end;padding:10px;font:700 17px/1.05 var(--display);color:var(--muted);overflow:hidden;overflow-wrap:anywhere;text-align:left}

.stage{position:relative;overflow:hidden;border-radius:22px;background:var(--surface);isolation:isolate}
.glow{position:absolute;z-index:-1;inset:-25%;width:150%;height:150%;object-fit:cover;filter:blur(64px) saturate(1.5);opacity:var(--glow)}
.pick{display:grid;grid-template-columns:minmax(0,272px) minmax(0,1fr);gap:48px;align-items:center;padding:44px;min-height:500px}
.pick.no-poster{grid-template-columns:1fr}
.js .pick:not(.on){display:none}
.pick+.pick{border-top:1px solid var(--line)}
.stage.live .pick.on{animation:arrive .3s ease-out}
@keyframes arrive{from{opacity:0;transform:translateY(10px)}}
.pick-poster .poster{border-radius:12px;box-shadow:0 24px 48px -20px rgba(0,0,0,.55)}
.pick h2{font:800 clamp(44px,7vw,84px)/.92 var(--display);letter-spacing:-.005em;text-wrap:balance}
.pick-meta{margin-top:10px;color:var(--muted);font-size:17px;display:flex;align-items:center;gap:10px}
.scores{display:flex;flex-wrap:wrap;gap:8px 26px;margin-top:22px}
.scores a{text-decoration:none;color:var(--muted);font-size:14px;display:flex;align-items:baseline;gap:7px}
.scores strong{font:700 30px/1 var(--display);color:var(--text)}
.scores a:hover{color:var(--text);text-decoration:underline;text-underline-offset:4px}
.why{margin:22px 0 26px;font-size:18px;line-height:1.55;max-width:54ch}
.strip{display:flex;gap:12px;overflow-x:auto;padding:18px 4px 10px;scrollbar-width:thin}
html:not(.js) .strip{display:none}
.thumb{flex:0 0 84px;padding:0;border:0;background:none;border-radius:8px;cursor:pointer;opacity:.55;transition:opacity .15s,transform .15s}
.thumb:hover{opacity:.9}
.thumb[aria-pressed=true]{opacity:1;outline:3px solid var(--accent);outline-offset:3px;transform:translateY(-4px)}
.thumb .poster.none{font-size:13px;padding:6px}
.picks-nav{display:flex;gap:12px;align-items:flex-start}
.picks-nav .strip{flex:1;min-width:0}
.thumb-t{display:none}
.see-all{flex:none;width:84px;aspect-ratio:2/3;margin-top:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed var(--line);border-radius:8px;background:var(--surface);color:var(--text);font:600 13px/1.2 inherit;cursor:pointer}
.see-all[hidden]{display:none}
.see-all:hover{border-color:var(--muted)}
.see-all b{font:800 24px/1 var(--display)}
.picks-nav.open{flex-wrap:wrap;gap:18px 12px;padding:18px 4px 10px}
.picks-nav.open .strip{display:contents}
.picks-nav.open .see-all{margin-top:0}
.picks-nav.open .thumb{opacity:.8}
.picks-nav.open .thumb:hover,.picks-nav.open .thumb[aria-pressed=true]{opacity:1}
.picks-nav.open .thumb[aria-pressed=true]{outline:0}
.picks-nav.open .thumb[aria-pressed=true] .poster{outline:3px solid var(--accent);outline-offset:3px}
.picks-nav.open .thumb-t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:6px;font-size:11.5px;font-weight:600;line-height:1.25;color:var(--text);text-align:left}

.tools{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}
html:not(.js) .tools{display:none}
.tools input,.tools select{height:40px;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:0 12px;font-size:15px}
.tools input{flex:1 1 220px;min-width:0}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:3px}
.seg button{border:0;background:none;border-radius:7px;padding:0 13px;font-size:14px;font-weight:500;color:var(--muted);cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent);color:var(--on-accent)}
#films .fine{display:flex;gap:14px;align-items:center;margin-bottom:16px;min-height:22px}
.wall{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:20px 14px}
.film{display:block;text-decoration:none}
.film .poster{transition:transform .15s}
.film:hover .poster{transform:translateY(-4px);outline:2px solid var(--accent);outline-offset:2px}
.film-stars{display:flex;align-items:center;gap:6px;min-height:20px;margin-top:6px;font-size:12px;letter-spacing:1px;color:var(--ink)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--muted)}
.nomatch{padding:48px 0;color:var(--muted)}
.more{display:flex;margin:28px auto 0}

dialog{border:0;border-radius:20px;padding:28px;background:var(--surface);color:var(--text);width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 48px);box-shadow:0 40px 80px -20px rgba(0,0,0,.6)}
dialog::backdrop{background:rgba(8,9,12,.62);backdrop-filter:blur(3px)}
html:not(.js) dialog#update{display:block;position:static;margin:0 auto 40px;box-shadow:none;border:1px solid var(--line)}
html:not(.js) [data-open],html:not(.js) .close{display:none}
dialog h2{font:800 32px/1 var(--display);margin-bottom:10px}
dialog .close{display:block;margin:22px 0 0 auto}
.upload{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.file{position:relative;flex:1 1 220px;border:1px dashed var(--muted);border-radius:10px;padding:10px 14px;color:var(--muted);font-size:15px;cursor:pointer;overflow:hidden}
.file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.file span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file:has(input:valid){border-style:solid;border-color:var(--ink);color:var(--text)}
.file:has(input:focus-visible){outline:2px solid var(--ink);outline-offset:3px}
.fd{display:grid;grid-template-columns:170px minmax(0,1fr);gap:26px;align-items:start}
.fd.no-poster{grid-template-columns:1fr}
.fd h3{font:800 40px/.95 var(--display);text-wrap:balance}
.fd p{margin-top:6px}
.fd-rating{display:flex;align-items:center;gap:10px}
.stars{color:var(--ink);letter-spacing:2px;font-size:18px}
.fd blockquote{margin:16px 0 0;padding-left:14px;border-left:3px solid var(--accent)}
.fd blockquote p{margin:0 0 8px}
.fd .btn{margin-top:20px}

.overview{max-width:68ch;font-size:18px;margin-bottom:40px}
.overview p{margin-bottom:12px}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 18px;margin-bottom:16px}
.head h2{font:800 32px/1 var(--display)}
.themes{margin-bottom:56px}
.topics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:28px}
.topics a{display:flex;gap:10px;padding:8px 12px;border-radius:9px;background:var(--surface);white-space:nowrap;text-decoration:none;color:var(--muted);font-weight:500;font-size:15px}
.topics a:hover{color:var(--text)}
.topics .num{font-size:13px}
.topic{border-top:1px solid var(--line)}
.topic[open]{padding-bottom:28px}
.topic summary{display:flex;align-items:center;gap:12px;padding:16px 0;cursor:pointer;list-style:none;border-radius:6px}
.topic summary::-webkit-details-marker{display:none}
.topic summary .num{color:var(--muted);font-size:14px}
.topic summary::after{content:"";margin-left:auto;margin-right:6px;width:9px;height:9px;border:solid var(--muted);border-width:0 2px 2px 0;transform:rotate(-45deg);transition:transform .15s}
.topic[open] summary::after{transform:rotate(45deg)}
.topic summary:hover::after{border-color:var(--text)}
.topic h3{font:800 26px/1 var(--display)}
.theme-grid{display:grid;gap:12px}
.theme{background:var(--surface);border-radius:16px;padding:22px 24px;display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);grid-template-rows:auto auto 1fr;column-gap:36px}
.theme h4{grid-column:1;margin:0 0 6px;font-size:18px;font-weight:650;line-height:1.3;text-wrap:balance}
.theme p{grid-column:1;color:var(--muted);font-size:15px;line-height:1.55}
.examples{grid-column:2;grid-row:1/span 3;align-self:start;list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.ex a{display:flex;align-items:center;gap:10px;height:100%;text-decoration:none;padding:5px 12px 5px 5px;border-radius:10px;background:var(--raise);border-left:3px solid transparent}
.ex.liked a{border-left-color:var(--accent)}
.ex.disliked a{border-left-color:var(--err)}
.ex.mixed a{border-left-color:var(--muted)}
.ex a:hover{filter:brightness(1.08)}
.ex .poster{width:30px;flex:none;border-radius:4px}
.ex .poster.none{font-size:0;padding:0}
.ex-text{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.ex-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ex-note{font-size:12px;color:var(--muted)}
.ex-note .stars{font-size:12px;letter-spacing:1px}
.counts{display:flex;flex-wrap:wrap;gap:14px 40px;margin:0 0 28px}
.counts dd{margin:0;font:800 40px/1 var(--display)}
.counts dt{color:var(--muted);font-size:13px;margin-top:4px}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.charts>div{background:var(--surface);border-radius:16px;padding:20px 22px}
.charts h3{font-size:14px;font-weight:600;color:var(--muted);margin-bottom:14px}
.bars{display:flex;gap:5px;height:170px}
.bar{flex:1;display:flex;flex-direction:column;align-items:center;border:0;background:none;padding:0;cursor:pointer;min-width:0}
.bar:disabled{cursor:default}
.col{flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.bar .fill{display:block;width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px;max-height:calc(100% - 18px)}
.bar:disabled .fill{background:var(--line)}
.bar:not(:disabled):hover .fill,.dec:hover .fill{filter:brightness(.86)}
.bar .n{font-size:12px;color:var(--muted);line-height:18px}
.bar .lbl{font-size:11px;color:var(--muted);margin-top:5px}
.decades{display:grid;gap:4px}
.dec{display:grid;grid-template-columns:52px 1fr 28px 44px;gap:12px;align-items:center;border:0;background:none;padding:5px 0;font-size:14px;text-align:left;cursor:pointer}
.dec .num{text-align:right}
.track{display:block;height:10px;border-radius:99px;background:var(--raise);overflow:hidden}
.track .fill{display:block;height:100%;background:var(--accent);border-radius:99px}

@media (max-width:760px){
  .bar-in{flex-wrap:wrap;gap:0 12px;padding:0 16px}
  .brand{padding:12px 0 6px;margin-right:auto}
  .tabs{order:3;flex:1 0 100%;margin:0 -12px}
  .tabs a{padding:10px 12px}
  main{padding:18px 16px 32px}
  footer{padding:0 16px 32px}
  .stage{border-radius:18px}
  .pick{grid-template-columns:1fr;gap:22px;padding:24px 22px 28px;min-height:0}
  .pick-poster{width:132px}
  .why{font-size:17px;margin:18px 0 22px}
  .scores{margin-top:16px;gap:8px 20px}
  .thumb{flex-basis:64px}
  .see-all{width:64px}
  .picks-nav.open{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px 10px}
  .picks-nav.open .see-all{width:auto}
  .wall{grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:16px 10px}
  .tools select{flex:1 1 30%;min-width:0}
  .seg{flex:1 1 100%}
  .seg button{flex:1;height:32px}
  .charts{grid-template-columns:1fr}
  .themes{margin-bottom:40px}
  .topics{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 -16px 20px;padding:0 16px}
  .topics a{flex:none}
  .theme{display:block;padding:18px 20px 20px}
  .examples{display:flex;flex-wrap:wrap;margin-top:16px}
  .ex a{max-width:260px}
  .topic[open]{padding-bottom:20px}
  .fd{grid-template-columns:96px minmax(0,1fr);gap:16px}
  .fd h3{font-size:30px}
  dialog{padding:22px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
