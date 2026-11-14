// The user's personal page: server-rendered HTML, no JavaScript.
import type { Memory } from "./memory.ts";
import { type FilmRef, filmKey, type Posters, posterUrl } from "./posters.ts";
import type { Ratings } from "./ratings.ts";
import { getDiary, getTasteSummary, hasSeen } from "./queries.ts";
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
const DIARY_PAGE_SIZE = 15;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const stars = (r: number | null) =>
  r === null ? "" : "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "");

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

const filmLink = (name: string, year: number | null, uri?: string) => {
  const href = uri || `https://letterboxd.com/search/films/${encodeURIComponent(name)}/`;
  return `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(name)}</a>${
    year ? ` <span class="muted">${year}</span>` : ""
  }`;
};

type Stamp = (iso: string) => string;

/** Poster thumbnail. No `posters` at all (no TMDB token) → no poster column. */
function poster(posters: Posters | undefined, film: FilmRef): string {
  if (!posters) return "";
  const path = posters.get(filmKey(film));
  return path
    ? `<img class="poster" src="${esc(posterUrl(path, 92))}" srcset="${esc(posterUrl(path, 185))} 2x" alt="" width="46" height="69" loading="lazy">`
    : `<span class="poster none" aria-hidden="true"></span>`;
}

/** "IMDb 7.8 · Rotten Tomatoes 94% · Metacritic 80", each linking to that site. Empty without scores. */
function scoresLine(ratings: Ratings | undefined, film: FilmRef): string {
  const s = ratings?.get(filmKey(film));
  if (!s) return "";
  const q = encodeURIComponent(film.title);
  const link = (href: string, text: string) => `<a href="${esc(href)}" rel="noreferrer noopener" target="_blank">${esc(text)}</a>`;
  const parts = [
    link(`https://www.imdb.com/title/${s.imdbId}/`, s.imdb ? `IMDb ${s.imdb}` : "IMDb"),
    s.rt && link(`https://www.rottentomatoes.com/search?search=${q}`, `Rotten Tomatoes ${s.rt}`),
    s.mc && link(`https://www.metacritic.com/search/${q}/?category=2`, `Metacritic ${s.mc}`),
  ].filter(Boolean);
  return `<div class="scores">${parts.join(" · ")}</div>`;
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

/** One page of the diary, newest first; out-of-range page numbers are clamped. */
function diaryPage(data: Dataset, requested: number | undefined) {
  const total = getDiary(data, { limit: 1 }).total;
  const pages = Math.max(1, Math.ceil(total / DIARY_PAGE_SIZE));
  const page = clampPage(requested, pages);
  const entries = getDiary(data, { limit: DIARY_PAGE_SIZE, offset: (page - 1) * DIARY_PAGE_SIZE }).items;
  return { total, pages, page, entries };
}

/** The picks the page will show, so scores can be fetched for exactly those. */
export function picksShown(data: Dataset | null, memory: Memory): FilmRef[] {
  return pendingPicks(data, memory).map((p) => ({ title: p.title, year: p.year }));
}

/** Every film the page will show, so posters can be fetched for exactly those. */
export function filmsShown(data: Dataset | null, memory: Memory, requestedPage?: number): FilmRef[] {
  const picks = picksShown(data, memory);
  const diary = data ? diaryPage(data, requestedPage).entries.map((e) => ({ title: e.name, year: e.year })) : [];
  return [...picks, ...diary];
}

function picksSection(data: Dataset | null, memory: Memory, at: Stamp, posters?: Posters, ratings?: Ratings): string {
  const picks = memory.picks;
  const pending = pendingPicks(data, memory);
  const body = pending.length
    ? `<ol class="picks${posters ? " with-posters" : ""}">${pending
        .map(
          (p) => `<li>
            ${poster(posters, p)}
            <div>
              <div class="pick-title">${filmLink(p.title, p.year)}${p.onWatchlist ? ' <span class="badge">on your watchlist</span>' : ""}</div>
              ${scoresLine(ratings, p)}
              <p class="why">${esc(p.why)}</p>
            </div>
          </li>`,
        )
        .join("")}</ol>`
    : `<p class="empty">${
        picks ? "You've watched everything Claude picked. Ask for more in a chat." : "Ask Claude for recommendations in a chat and they'll show up here."
      }</p>`;
  return `<section>
    <h2>Watch next${picks ? ` <span class="sub">picked by Claude · ${at(picks.updatedAt)}</span>` : ""}</h2>
    ${body}
  </section>`;
}

/** Clamps a requested page number (from the URL) to 1…pages. */
const clampPage = (requested: number | undefined, pages: number) =>
  Math.min(Math.max(1, Math.floor(Number(requested) || 1)), Math.max(1, pages));

/** Prev / "page x of y" / next. Query-only hrefs, so the secret path stays as is. */
function pager(page: number, pages: number): string {
  if (pages <= 1) return "";
  const link = (n: number, label: string, rel: string) =>
    `<a class="pg" href="?page=${n}#diary" rel="${rel}">${label}</a>`;
  return `<nav class="pager" aria-label="Diary pages">
    ${page > 1 ? link(page - 1, "← Newer", "prev") : '<span class="pg off">← Newer</span>'}
    <span class="muted">Page ${page} of ${pages}</span>
    ${page < pages ? link(page + 1, "Older →", "next") : '<span class="pg off">Older →</span>'}
  </nav>`;
}

function recentSection(data: Dataset, now: Date, requestedPage?: number, posters?: Posters): string {
  const { total, pages, page, entries } = diaryPage(data, requestedPage);
  if (!total) return "";
  return `<section id="diary">
    <h2>Recently watched <span class="sub">${total} ${total === 1 ? "entry" : "entries"}</span></h2>
    <ul class="diary${posters ? " with-posters" : ""}">${entries
      .map(
        (e) => `<li>
          <span class="date">${day(e.watchedDate ?? e.date, now)}</span>
          ${poster(posters, { title: e.name, year: e.year })}
          <div class="entry">
            <div class="entry-head">${filmLink(e.name, e.year, e.uri)}
              <span class="stars" aria-label="${e.rating ?? "no"} stars">${stars(e.rating)}</span>
              ${e.rewatch ? '<span class="badge">rewatch</span>' : ""}</div>
            ${e.review ? `<p class="review">${esc(e.review).replace(/\r?\n/g, " ")}</p>` : ""}
          </div>
        </li>`,
      )
      .join("")}</ul>
    ${pager(page, pages)}
  </section>`;
}

function tasteSection(memory: Memory, at: Stamp): string {
  const overview = memory.overview
    ? `<div class="overview">${paragraphs(memory.overview.text)}<p class="sub">Written by Claude · ${at(memory.overview.updatedAt)}</p></div>`
    : `<p class="empty">Claude hasn't written an overview yet. Ask it to in a chat.</p>`;
  const notes = memory.notes.length
    ? `<h3>What Claude remembers</h3><ul class="notes">${memory.notes.map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>
       <p class="sub">To change or remove one, tell Claude in a chat.</p>`
    : `<p class="empty">No notes yet. They get added as you tell Claude about your taste.</p>`;
  return `<section><h2>Your taste</h2>${overview}${notes}</section>`;
}

function statsSection(data: Dataset): string {
  const s = getTasteSummary(data);
  // Object.entries lists integer-like keys ("1", "2"…) before "0.5", so sort numerically.
  const dist = Object.entries(s.ratingDistribution).sort(([a], [b]) => Number(a) - Number(b));
  const maxCount = Math.max(1, ...dist.map(([, n]) => n));
  const counts: [string, number][] = [
    ["watched", s.counts.watched],
    ["rated", s.counts.rated],
    ["reviews", s.counts.reviews],
    ["liked", s.counts.liked],
    ["watchlist", s.counts.watchlist],
  ];
  return `<section>
    <h2>Stats</h2>
    <div class="counts">${counts.map(([k, n]) => `<div><strong>${n}</strong><span>${k}</span></div>`).join("")}
      <div><strong>${s.averageRating ?? "–"}</strong><span>avg rating</span></div></div>
    <div class="grid">
      <div>
        <h3>Ratings</h3>
        <div class="bars">${dist
          .map(
            ([step, n]) => `<div class="bar" title="${n} × ${step}★">
              <div class="col"><span class="n">${n || ""}</span>
              <div class="fill" style="height:${Math.round((n / maxCount) * 100)}%"></div></div>
              <span class="lbl">${step}</span></div>`,
          )
          .join("")}</div>
      </div>
      <div>
        <h3>Decades</h3>
        <table class="decades">${s.decades
          .map((d) => `<tr><td>${d.decade}</td><td>${d.watched} ${d.watched === 1 ? "film" : "films"}</td><td class="muted">${d.averageRating ?? "–"} avg</td></tr>`)
          .join("")}</table>
      </div>
    </div>
  </section>`;
}

export interface PageOptions {
  uploadAction: string;
  status: UploadStatus | null;
  now?: Date;
  /** Viewer's IANA timezone (Cloudflare's request.cf.timezone); defaults to UTC. */
  timeZone?: string;
  /** Diary page from ?page=, 1-based; out-of-range values are clamped. */
  diaryPage?: number;
  /** Posters for the films shown (from resolvePosters). Omit to show no poster column. */
  posters?: Posters;
  /** IMDb / RT / Metacritic scores for the picks (from resolveRatings). Omit to show none. */
  ratings?: Ratings;
}

export function renderPage(data: Dataset | null, memory: Memory, o: PageOptions): string {
  const now = o.now ?? new Date();
  const at: Stamp = (iso) => stamp(iso, now, o.timeZone ?? "UTC");
  const ageDays = data ? (now.getTime() - Date.parse(data.uploadedAt)) / 86_400_000 : Infinity;
  const status = o.status ? STATUS_MESSAGES[o.status] : null;
  const name = data?.username || "My films";

  const upload = `<form class="upload" method="post" action="${esc(o.uploadAction)}" enctype="multipart/form-data">
    <label class="file"><input type="file" name="export" accept=".zip,application/zip" required><span>Choose export ZIP</span></label>
    <button type="submit">Upload</button>
  </form>`;

  const banner = !data
    ? `<p class="notice">No data yet. On letterboxd.com go to Settings → Data → Export your data, then upload the ZIP here.</p>`
    : ageDays > STALE_DAYS
      ? `<p class="notice">Your data is ${Math.floor(ageDays)} days old. Export a fresh copy from Letterboxd (Settings → Data) and upload it.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(name)} · Films</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${esc(name)}</h1>
      <p class="sub">${data ? `Letterboxd data as of ${at(data.uploadedAt)}` : "No Letterboxd data uploaded"}${
        data?.username
          ? ` · <a class="profile" href="https://letterboxd.com/${esc(encodeURIComponent(data.username))}/" rel="noreferrer noopener" target="_blank">My Letterboxd ↗</a>`
          : ""
      }</p>
    </div>
    ${upload}
  </header>
  ${status ? `<p class="flash ${status.ok ? "ok" : "err"}" role="status">${esc(status.text)}</p>` : ""}
  ${banner}
  ${picksSection(data, memory, at, o.posters, o.ratings)}
  ${tasteSection(memory, at)}
  ${data ? recentSection(data, now, o.diaryPage, o.posters) : ""}
  ${data ? statsSection(data) : ""}
</main>
</body>
</html>`;
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1b1d1f;--muted:#6b7075;--line:#e6e6e2;--accent:#1f9d55;--accent-soft:#e3f4ea;--star:#d08a00;--err:#b42318;--err-soft:#fde8e6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1113;--card:#171a1d;--text:#e8eaec;--muted:#9097a0;--line:#262a2f;--accent:#3ccf7c;--accent-soft:#16301f;--star:#f2b33d;--err:#ff8a7a;--err-soft:#3a1714}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:24px}
h1{font-size:28px;letter-spacing:-.02em;margin:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 14px;font-weight:600}
h3{font-size:14px;margin:18px 0 8px}
.sub{color:var(--muted);font-size:13px;margin:2px 0 0;text-transform:none;letter-spacing:0;font-weight:400}
h2 .sub{margin-left:6px}
.muted{color:var(--muted)}
a{color:inherit;text-decoration:none;font-weight:600}
a:hover{color:var(--accent)}
a.profile{color:var(--accent)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:16px}
.upload{display:flex;gap:8px;align-items:center}
.file{position:relative;overflow:hidden;border:1px dashed var(--line);border-radius:10px;padding:8px 12px;color:var(--muted);font-size:13px;cursor:pointer;background:var(--card);max-width:220px}
.file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.file span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file:has(input:valid){border-style:solid;border-color:var(--accent);color:var(--accent)}
.file:has(input:valid) span{font-size:0}
.file:has(input:valid) span::after{content:"ZIP selected ✓";font-size:13px}
button{border:0;border-radius:10px;padding:9px 16px;background:var(--accent);color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer}
@media (prefers-color-scheme:dark){button{color:#0b1a11}}
.flash,.notice{border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:14px}
.flash.ok{background:var(--accent-soft)}
.flash.err{background:var(--err-soft);color:var(--err)}
.notice{background:var(--card);border:1px solid var(--line)}
.picks{margin:0;padding:0;list-style:none;counter-reset:p}
.picks li{counter-increment:p;position:relative;padding:12px 0 12px 34px;border-top:1px solid var(--line)}
.picks li:first-child{border-top:0;padding-top:0}
.picks li::before{content:counter(p);position:absolute;left:0;top:12px;width:22px;height:22px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700;display:grid;place-items:center}
.picks li:first-child::before{top:0}
.pick-title{font-size:16px}
.why{margin:4px 0 0;color:var(--muted)}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent);margin-left:6px;vertical-align:2px}
.diary{list-style:none;margin:0;padding:0}
.diary li{display:grid;grid-template-columns:64px 1fr;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.diary li:first-child{border-top:0;padding-top:0}
.date{color:var(--muted);font-size:13px;padding-top:1px;font-variant-numeric:tabular-nums}
.stars{color:var(--star);margin-left:6px;letter-spacing:1px}
.review{margin:4px 0 0;color:var(--muted);font-size:14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.scores{margin-top:3px;font-size:13px;color:var(--muted)}
.scores a{color:var(--muted)}
.scores a:hover{color:var(--accent)}
.poster{display:block;width:46px;height:69px;border-radius:4px;object-fit:cover;background:var(--line);box-shadow:0 0 0 1px var(--line)}
.picks.with-posters li{display:grid;grid-template-columns:46px 1fr;gap:14px;align-items:start}
.diary.with-posters li{grid-template-columns:64px 46px 1fr}
.pager{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line);font-size:13px}
.pg{padding:6px 12px;border-radius:8px;background:var(--bg)}
.pg.off{opacity:.4}
.overview p{margin:0 0 10px}
.notes{margin:0;padding-left:18px}
.notes li{margin:4px 0}
.empty{color:var(--muted);margin:0}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px;margin-bottom:8px}
.counts div{background:var(--bg);border-radius:10px;padding:10px 12px}
.counts strong{display:block;font-size:20px;letter-spacing:-.01em}
.counts span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media (max-width:600px){.grid{grid-template-columns:1fr}.diary li{grid-template-columns:52px 1fr}.diary.with-posters li{grid-template-columns:48px 40px 1fr}.diary .poster{width:40px;height:60px}}
.bars{display:flex;gap:4px;height:140px}
.bar{flex:1;display:flex;flex-direction:column;align-items:center}
.col{flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding-top:16px}
.fill{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px;opacity:.85;max-height:calc(100% - 16px)}
.bar .n{font-size:11px;color:var(--muted);line-height:16px}
.bar .lbl{font-size:10px;color:var(--muted);margin-top:4px}
.decades{width:100%;border-collapse:collapse;font-size:14px}
.decades td{padding:5px 0;border-top:1px solid var(--line)}
.decades tr:first-child td{border-top:0}
.decades td:nth-child(2),.decades td:nth-child(3){text-align:right}
`;
