// Taste memory: what Claude has learned about the user in chats, kept in their own
// Cloudflare KV (key "memory") instead of Claude's built-in memory.
import { normalizeTitle } from "./queries.ts";

/** The sections the Taste page groups notes into, in page order. */
export const TOPICS = {
  loves: "What I love",
  dealbreakers: "What puts me off",
  formats: "Genres and formats",
  rating: "How I rate",
  recommending: "How to recommend to me",
} as const;
export type Topic = keyof typeof TOPICS;

/** A film that illustrates a note, and how it landed with the user. */
export interface Example {
  title: string;
  year: number | null;
  /** Which title this is, so its poster is exact (series especially). Optional. */
  imdbId?: string;
  verdict?: "liked" | "disliked" | "mixed";
  /** A few words on why, e.g. "beautiful, weak characters". */
  why?: string;
}

export interface Note {
  /** Short stable id ("n1", "n2", …) so Claude can update or forget a note. */
  id: string;
  /** The detail, in the user's words. */
  text: string;
  /** Short headline, e.g. "The lead has to click". Older notes have none. */
  title?: string;
  topic?: Topic;
  examples?: Example[];
  createdAt: string;
  updatedAt: string;
}

/** The optional structure on a note; `null` on an update clears that field. */
export interface NoteFields {
  title?: string | null;
  topic?: Topic | null;
  examples?: Example[] | null;
}

function withFields<T extends Note>(note: T, f: NoteFields): T {
  const next = { ...note };
  for (const k of ["title", "topic", "examples"] as const) {
    const v = f[k];
    if (v === null) delete next[k];
    else if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

export interface Pick {
  title: string;
  year: number | null;
  /** Which film this is, for scores. Picks saved before ids were required have none (and show no scores). */
  imdbId?: string;
  /** Why this suits the user, in terms of their own taste. */
  why: string;
  /** When it was saved to the list. Picks saved before 2026-11-22 have none. */
  addedAt?: string;
}

/** A pick the user has since watched, kept so its reason can be compared with how it landed. */
export interface PastPick extends Pick {
  /** When it left the watch list (the first time the server noticed it had been watched). */
  movedAt: string;
}

/**
 * What Claude knows about one film or series beyond Letterboxd, keyed by IMDb id in Memory.titles.
 * Any title can have one, logged on Letterboxd or not. Never loaded up front: check_films attaches it.
 */
export interface TitleRecord {
  title: string;
  year: number | null;
  /** The logged Letterboxd film this is (its boxd.it link), once matched; makes the join exact. */
  letterboxdUri?: string;
  /** Don't recommend this title, and why (seen elsewhere, disliked, on hold, …). */
  dontRecommend?: { reason: string; addedAt: string };
  /** One text per title: what the user told Claude about it in chats. */
  note?: { text: string; updatedAt: string };
  /** The note's text before its last change, so an overwrite can be undone. */
  previousNote?: { text: string; updatedAt: string };
}

/** The old shape of the don't-recommend list (an array), converted into titles on load. */
interface LegacyDontRecommend {
  title: string;
  year: number | null;
  imdbId: string;
  reason: string;
  addedAt: string;
}

export interface Memory {
  notes: Note[];
  /** Claude's written overview of the user's taste, shown on their page. */
  overview: { text: string; updatedAt: string } | null;
  /** Claude's "watch next" recommendations, shown on their page: newest saves first. */
  picks: { items: Pick[]; updatedAt: string } | null;
  /** Picks the user has watched, most recently moved first. Missing in memory saved before 2026-11-22. */
  pastPicks?: PastPick[];
  /** Per-title records by IMDb id. Looked up per title (check_films), never loaded up front. */
  titles?: Record<string, TitleRecord>;
}

/** Load/save seam: KV in the Worker, a plain variable in tests. */
export interface MemoryStore {
  load(): Promise<Memory>;
  save(memory: Memory): Promise<void>;
}

export const MEMORY_KEY = "memory";

export const emptyMemory = (): Memory => ({ notes: [], overview: null, picks: null, pastPicks: [], titles: {} });

/** Tolerates a missing or partly-shaped stored value, and converts the old don't-recommend array into titles. */
export function normalizeMemory(raw: unknown): Memory {
  if (!raw || typeof raw !== "object") return emptyMemory();
  const m = raw as Partial<Memory> & { dontRecommend?: LegacyDontRecommend[] };
  const titles: Record<string, TitleRecord> = m.titles && typeof m.titles === "object" ? { ...m.titles } : {};
  for (const e of Array.isArray(m.dontRecommend) ? m.dontRecommend : []) {
    if (!e?.imdbId) continue;
    const r = titles[e.imdbId] ?? { title: e.title, year: e.year ?? null };
    titles[e.imdbId] = { ...r, dontRecommend: r.dontRecommend ?? { reason: e.reason, addedAt: e.addedAt } };
  }
  return {
    notes: Array.isArray(m.notes) ? m.notes : [],
    overview: m.overview ?? null,
    picks: m.picks ?? null,
    pastPicks: Array.isArray(m.pastPicks) ? m.pastPicks : [],
    titles,
  };
}

export function kvMemoryStore(kv: KVNamespace): MemoryStore {
  return {
    load: async () => normalizeMemory(await kv.get(MEMORY_KEY, "json")),
    save: (memory) => kv.put(MEMORY_KEY, JSON.stringify(memory)),
  };
}

export function inMemoryStore(initial: Memory = emptyMemory()): MemoryStore & { current: Memory } {
  const store = {
    current: initial,
    load: async () => structuredClone(store.current),
    save: async (m: Memory) => {
      store.current = structuredClone(m);
    },
  };
  return store;
}

// ---------- pure updates ----------

function nextId(notes: Note[]): string {
  const max = notes.reduce((n, note) => Math.max(n, Number.parseInt(note.id.slice(1), 10) || 0), 0);
  return `n${max + 1}`;
}

export function addNote(m: Memory, text: string, now: string, fields: NoteFields = {}): { memory: Memory; note: Note } {
  const note = withFields<Note>({ id: nextId(m.notes), text: text.trim(), createdAt: now, updatedAt: now }, fields);
  return { memory: { ...m, notes: [...m.notes, note] }, note };
}

/** `text` undefined keeps the current text. Returns null when no note has that id. */
export function updateNote(m: Memory, id: string, text: string | undefined, now: string, fields: NoteFields = {}): Memory | null {
  if (!m.notes.some((n) => n.id === id)) return null;
  return {
    ...m,
    notes: m.notes.map((n) => (n.id === id ? withFields({ ...n, text: text?.trim() || n.text, updatedAt: now }, fields) : n)),
  };
}

/** Returns null when no note has that id. */
export function removeNote(m: Memory, id: string): Memory | null {
  if (!m.notes.some((n) => n.id === id)) return null;
  return { ...m, notes: m.notes.filter((n) => n.id !== id) };
}

const withPicks = (m: Memory, items: Pick[], now: string): Memory => ({ ...m, picks: { items, updatedAt: now } });

/**
 * Puts these picks at the top of the list, in the order given, ahead of the older ones.
 * A film already on the list (same IMDb id) moves up with its new details instead of appearing twice.
 */
export function addPicks(m: Memory, picks: Pick[], now: string): Memory {
  const ids = new Set<string>();
  const items = [...picks, ...(m.picks?.items ?? [])].filter((p) => !p.imdbId || (!ids.has(p.imdbId) && ids.add(p.imdbId)));
  return withPicks(m, items, now);
}

/** Changes the pick with this IMDb id in place; fields left undefined stay as they are. Returns null when no pick has that id. */
export function updatePick(m: Memory, imdbId: string, edit: Partial<Omit<Pick, "imdbId">>, now: string): Memory | null {
  const items = m.picks?.items ?? [];
  if (!items.some((p) => p.imdbId === imdbId)) return null;
  const defined = Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined));
  return withPicks(m, items.map((p) => (p.imdbId === imdbId ? { ...p, ...defined } : p)), now);
}

/** Drops the picks with these IMDb ids. */
export function removePicks(m: Memory, imdbIds: string[], now: string): Memory {
  const drop = new Set(imdbIds);
  return withPicks(m, (m.picks?.items ?? []).filter((p) => !(p.imdbId && drop.has(p.imdbId))), now);
}

const sameFilm = (a: Pick, b: Pick) =>
  a.imdbId && b.imdbId ? a.imdbId === b.imdbId : normalizeTitle(a.title) === normalizeTitle(b.title) && a.year === b.year;

/**
 * Moves the picks `isWatched` says the user has watched off the list and into pastPicks (newest first),
 * keeping their reasons. A film already in pastPicks is replaced by the newer entry.
 * `moved` holds the original pick objects. The list's updatedAt is left alone: the user didn't change it.
 */
export function archiveWatched(m: Memory, isWatched: (p: Pick) => boolean, now: string): { memory: Memory; moved: Pick[] } {
  const items = m.picks?.items ?? [];
  const moved = items.filter(isWatched);
  if (!moved.length || !m.picks) return { memory: m, moved: [] };
  const past = (m.pastPicks ?? []).filter((old) => !moved.some((p) => sameFilm(p, old)));
  return {
    memory: {
      ...m,
      picks: { ...m.picks, items: items.filter((p) => !moved.includes(p)) },
      pastPicks: [...moved.map((p) => ({ ...p, movedAt: now })), ...past],
    },
    moved,
  };
}

// ---------- per-title records ----------

/** Which title a change is about: its IMDb id, plus the name and year to store (latest wins). */
export interface TitleRef {
  imdbId: string;
  title: string;
  year: number | null;
}

/** Applies `change` to the record for `t` (creating it), then drops the record if nothing is left in it. */
function withTitle(m: Memory, t: TitleRef, change: (r: TitleRecord) => TitleRecord): Memory {
  const titles = { ...(m.titles ?? {}) };
  const current = titles[t.imdbId];
  const next = change({ ...current, title: t.title, year: t.year });
  if (!next.note && !next.dontRecommend && !next.previousNote) delete titles[t.imdbId];
  else titles[t.imdbId] = next;
  return { ...m, titles };
}

/** Sets (or, with null, clears) a title's don't-recommend reason. A changed reason keeps its original addedAt. */
export function setDontRecommend(m: Memory, t: TitleRef, reason: string | null, now: string): Memory {
  return withTitle(m, t, (r) => {
    const { dontRecommend, ...rest } = r;
    return reason === null ? rest : { ...rest, dontRecommend: { reason, addedAt: dontRecommend?.addedAt ?? now } };
  });
}

/**
 * Sets (or, with null, clears) a title's Claude note, the whole text at once.
 * The text it replaces is kept as previousNote, so an overwrite can be undone; clearing drops both.
 */
export function setTitleNote(m: Memory, t: TitleRef, text: string | null, now: string): Memory {
  return withTitle(m, t, (r) => {
    const { note, previousNote: _, ...rest } = r;
    if (text === null) return rest;
    if (note?.text === text) return r;
    return { ...rest, note: { text, updatedAt: now }, ...(note && { previousNote: note }) };
  });
}

/** Stores the Letterboxd link of each record's logged film (from `uriFor`). Unchanged memory when nothing new matched. */
export function linkTitles(m: Memory, uriFor: (r: TitleRecord) => string | undefined): { memory: Memory; changed: boolean } {
  let changed = false;
  const titles = Object.fromEntries(
    Object.entries(m.titles ?? {}).map(([id, r]) => {
      const uri = uriFor(r);
      if (!uri || uri === r.letterboxdUri) return [id, r];
      changed = true;
      return [id, { ...r, letterboxdUri: uri }];
    }),
  );
  return { memory: changed ? { ...m, titles } : m, changed };
}

/**
 * Finds a title's record: by IMDb id when known, else by the logged film's Letterboxd link,
 * else by title and release year (one off either way, as elsewhere).
 */
export function titleFinder(m: Memory): (film: { name: string; year: number | null; uri?: string; imdbId?: string }) =>
  | (TitleRecord & { imdbId: string })
  | undefined {
  const entries = Object.entries(m.titles ?? {}).map(([imdbId, r]) => ({ ...r, imdbId }));
  const byUri = new Map(entries.flatMap((r) => (r.letterboxdUri ? [[r.letterboxdUri, r] as const] : [])));
  const byTitle = new Map<string, (TitleRecord & { imdbId: string })[]>();
  for (const r of entries) {
    const k = normalizeTitle(r.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), r]);
  }
  return (film) => {
    if (film.imdbId) {
      const r = m.titles?.[film.imdbId];
      if (r) return { ...r, imdbId: film.imdbId };
    }
    if (film.uri && byUri.has(film.uri)) return byUri.get(film.uri);
    return byTitle
      .get(normalizeTitle(film.name))
      ?.find((r) => (!film.uri || !r.letterboxdUri) && (r.year === null || film.year === null || Math.abs(r.year - film.year) <= 1));
  };
}

export interface PickReason {
  why: string;
  addedAt?: string;
  /** true while it's still on the watch list (not yet moved to pastPicks). */
  onList?: true;
}

/**
 * Finds why Claude picked a film, by title and release year (one off either way, as has_seen allows),
 * from the watch list and past picks. Films that were never picked get undefined.
 */
export function pickReasonFinder(m: Memory): (film: { name: string; year: number | null }) => PickReason | undefined {
  const byTitle = new Map<string, (Pick & { onList?: true })[]>();
  const add = (p: Pick & { onList?: true }) => {
    const k = normalizeTitle(p.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), p]);
  };
  for (const p of m.picks?.items ?? []) add({ ...p, onList: true });
  for (const p of m.pastPicks ?? []) add(p);
  return (film) => {
    const hit = byTitle
      .get(normalizeTitle(film.name))
      ?.find((p) => p.year === null || film.year === null || Math.abs(p.year - film.year) <= 1);
    if (!hit) return undefined;
    return { why: hit.why, ...(hit.addedAt && { addedAt: hit.addedAt }), ...(hit.onList && { onList: true as const }) };
  };
}
