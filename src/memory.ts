// Taste memory: what Claude has learned about the user in chats, kept in their own
// Cloudflare KV (key "memory") instead of Claude's built-in memory.

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
}

export interface Memory {
  notes: Note[];
  /** Claude's written overview of the user's taste, shown on their page. */
  overview: { text: string; updatedAt: string } | null;
  /** Claude's "watch next" recommendations, shown on their page: newest saves first. */
  picks: { items: Pick[]; updatedAt: string } | null;
}

/** Load/save seam: KV in the Worker, a plain variable in tests. */
export interface MemoryStore {
  load(): Promise<Memory>;
  save(memory: Memory): Promise<void>;
}

export const MEMORY_KEY = "memory";

export const emptyMemory = (): Memory => ({ notes: [], overview: null, picks: null });

/** Tolerates a missing or partly-shaped stored value. */
export function normalizeMemory(raw: unknown): Memory {
  if (!raw || typeof raw !== "object") return emptyMemory();
  const m = raw as Partial<Memory>;
  return {
    notes: Array.isArray(m.notes) ? m.notes : [],
    overview: m.overview ?? null,
    picks: m.picks ?? null,
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
