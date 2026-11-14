import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDiary,
  getRatings,
  getReviews,
  getTasteSummary,
  getWatchlist,
  hasSeen,
  MAX_LIMIT,
} from "./queries.ts";
import { addNote, type MemoryStore, type NoteFields, removeNote, TOPICS, type Topic, updateNote } from "./memory.ts";
import { fetchOmdb, findFilm, IMDB_ID } from "./ratings.ts";
import type { Dataset } from "./types.ts";

export const NO_DATA_MESSAGE =
  "No Letterboxd data has been uploaded yet. The user can upload their export ZIP on their personal page " +
  '(or run "npm run upload -- <export zip>" in the project folder).';

export const INSTRUCTIONS = [
  "The user's Letterboxd history (read-only, from their data export; data is as of uploadedAt) " +
    "plus a taste memory that you maintain.",
  "",
  "TASTE MEMORY: call get_memory FIRST in any conversation about films, before any other tool. " +
    "It holds what the user told you about their taste in earlier chats. It is the user's chosen place " +
    "for this: store film-taste facts here with remember, NOT in your own built-in memory. " +
    "Whenever the user explains a preference, answers a question about their taste, or corrects you, " +
    "save it with remember. Each note is one theme of their taste: a short title, a topic, the detail " +
    "close to their words, and the films that show it (with whether they liked each). If a new fact belongs " +
    "to an existing theme, extend that note with update_note instead of adding a near-duplicate. Fix stale " +
    "notes with update_note or forget. When you recommend films, save the list with save_picks (it appears on " +
    "the user's personal page). save_picks needs each film's IMDb id: get them with find_film (one call for the " +
    "whole list), never from memory, and read save_picks's reply to check each id matched the film you meant. " +
    "Note examples take an optional imdbId too (also from find_film); always give one for a series, or the " +
    "page may show a same-named film's poster. " +
    "When your understanding of their taste meaningfully changes, rewrite " +
    "the overview with save_overview (written to them, in second person).",
  "",
  "Then use get_taste_summary for recommendations, and has_seen before recommending a film.",
  "",
  "How this user rates: 2.5 stars means average. 3 stars and above means decent, and they liked " +
    "almost every film rated 3 or higher. Do not read a 3 as lukewarm or negative.",
  "",
  "The user's written reviews are the best evidence of WHY they liked or disliked something: " +
    "read them and reason from their own words rather than guessing from star ratings or genre.",
  "The user only started writing reviews on 2026-11-14. A film with no review is not less important " +
    "or less memorable; it was simply rated before they began reviewing.",
  "",
  "When their taste is unclear (e.g. why one film rated higher than a similar one, or what put them " +
    "off something), do not guess or invent a reason. Ask the user directly; they want to be asked, " +
    "and a review alone often does not explain it.",
].join("\n");

const rating = z.number().min(0.5).max(5);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const year = z.number().int().min(1870).max(2100);
const paging = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max items (default 50, max ${MAX_LIMIT})`),
  offset: z.number().int().min(0).optional().describe("Items to skip, for paging"),
};

const noteText = z.string().trim().min(1).max(2000).describe("The detail, close to the user's own words");
const noteFields = {
  title: z.string().trim().min(1).max(80).optional().describe('Short headline for the theme, e.g. "The lead has to click"'),
  topic: z
    .enum(Object.keys(TOPICS) as [Topic, ...Topic[]])
    .optional()
    .describe(`Section on the user's page: ${Object.entries(TOPICS).map(([k, v]) => `${k} (${v})`).join(", ")}`),
  examples: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        year: year.optional().describe("Release year"),
        imdbId: z
          .string()
          .regex(IMDB_ID, 'An IMDb id like "tt1663202"')
          .optional()
          .describe("IMDb id from find_film, so the page shows the right poster. Always include it for series."),
        verdict: z.enum(["liked", "disliked", "mixed"]).optional().describe("How it landed with the user"),
        why: z.string().trim().min(1).max(120).optional().describe('A few words, e.g. "beautiful, weak characters"'),
      }),
    )
    .max(8)
    .optional()
    .describe("Films that show this theme, from the user's own history or what they told you"),
};
/** Tool input → NoteFields (years default to null; undefined stays "unchanged"). */
const fields = (f: {
  title?: string | null;
  topic?: Topic | null;
  examples?: { title: string; year?: number; imdbId?: string; verdict?: "liked" | "disliked" | "mixed"; why?: string }[] | null;
}): NoteFields => ({
  title: f.title,
  topic: f.topic,
  examples: f.examples && f.examples.map((e) => ({ ...e, year: e.year ?? null })),
});

const readOnly ={ readOnlyHint: true, openWorldHint: false } as const;
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** Outside services the tools may call. Both are optional: without them find_film fails and ids go unchecked. */
export interface Services {
  /** TMDB "API Read Access Token", for find_film. */
  tmdbToken?: string;
  /** OMDb API key, to check the IMDb ids passed to save_picks. */
  omdbKey?: string;
  fetcher?: typeof fetch;
}

export function buildServer(data: Dataset | null, memory: MemoryStore, services: Services = {}): McpServer {
  const server = new McpServer({ name: "letterboxd", version: "1.3.0" }, { instructions: INSTRUCTIONS });
  const now = () => new Date().toISOString();
  const { tmdbToken, omdbKey, fetcher = fetch } = services;

  // ---------- taste memory ----------

  server.registerTool(
    "get_memory",
    {
      title: "Taste memory",
      description:
        "Call this FIRST. Everything the user has told you about their film taste in earlier chats (notes with ids), " +
        "your last written overview of their taste, and your last saved recommendations.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => json(await memory.load()),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a taste fact",
      description:
        "Save one theme of the user's film taste, e.g. why they rated one film above another. Use whenever they " +
        "explain a preference or answer a question about their taste. Returns the note with its id.",
      inputSchema: { note: noteText, ...noteFields },
      annotations: writes,
    },
    async ({ note, title, topic, examples }) => {
      const result = addNote(await memory.load(), note, now(), fields({ title, topic, examples }));
      await memory.save(result.memory);
      return json(result.note);
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Update a taste note",
      description:
        "Change a saved note (by id from get_memory), e.g. when the user corrects or refines it, or to add an example. " +
        "Only the fields you pass change; examples replaces the whole list; pass null to clear title, topic or examples.",
      inputSchema: {
        id: z.string().min(1),
        note: noteText.optional(),
        title: noteFields.title.nullable(),
        topic: noteFields.topic.nullable(),
        examples: noteFields.examples.nullable(),
      },
      annotations: { ...writes, idempotentHint: true },
    },
    async ({ id, note, title, topic, examples }) => {
      const next = updateNote(await memory.load(), id, note, now(), fields({ title, topic, examples }));
      if (!next) return fail(`No note with id ${id}. Call get_memory to see the ids.`);
      await memory.save(next);
      return json({ updated: id });
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget a taste note",
      description: "Delete a saved note (by id from get_memory) that is wrong or no longer true.",
      inputSchema: { id: z.string().min(1) },
      annotations: { ...writes, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const next = removeNote(await memory.load(), id);
      if (!next) return fail(`No note with id ${id}. Call get_memory to see the ids.`);
      await memory.save(next);
      return json({ forgotten: id });
    },
  );

  server.registerTool(
    "save_overview",
    {
      title: "Save taste overview",
      description:
        "Replace the written overview of the user's film taste shown on their personal page. " +
        "Write it to them in second person, a few short paragraphs, grounded in their ratings, reviews and notes.",
      inputSchema: { text: z.string().trim().min(1).max(6000) },
      annotations: { ...writes, idempotentHint: true },
    },
    async ({ text }) => {
      await memory.save({ ...(await memory.load()), overview: { text, updatedAt: now() } });
      return json({ saved: true });
    },
  );

  server.registerTool(
    "find_film",
    {
      title: "Find a film's IMDb id",
      description:
        "Look up films or series by title to get their IMDb ids, which save_picks requires. Pass every film you are about " +
        "to save in one call. Each title returns up to 3 candidates, best guess first, with year, type, the start of " +
        "the plot and a vote count: namesakes are common, so pick the one that is really the film you mean.",
      inputSchema: {
        films: z
          .array(z.object({ title: z.string().trim().min(1).max(300), year: year.optional().describe("Release year") }))
          .min(1)
          .max(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ films }) => {
      if (!tmdbToken) return fail("Film lookup isn't set up on this server (no TMDB token), so IMDb ids can't be looked up here.");
      const found = await Promise.allSettled(films.map((f) => findFilm(f, tmdbToken, fetcher)));
      return json(
        films.map((f, i) => {
          const r = found[i];
          return r.status === "fulfilled"
            ? { ...f, candidates: r.value }
            : { ...f, candidates: [], error: "Lookup failed; try again." };
        }),
      );
    },
  );

  server.registerTool(
    "save_picks",
    {
      title: "Save recommendations",
      description:
        "Replace the 'watch next' list on the user's personal page with the films you just recommended. " +
        "Only include films they have not seen (check has_seen). Each pick needs its IMDb id from find_film. " +
        "The reply lists what each id is on IMDb: if one is not the film you meant, find the right id and save again. " +
        "Picks they later watch drop off the page automatically.",
      inputSchema: {
        picks: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(300).describe("Title as on Letterboxd"),
              year: year.optional().describe("Release year"),
              imdbId: z.string().regex(IMDB_ID, 'An IMDb id like "tt1663202", from find_film'),
              why: z.string().trim().min(1).max(1000).describe("Why it suits them, in terms of their own taste"),
            }),
          )
          .min(1)
          .max(20),
      },
      annotations: { ...writes, idempotentHint: true },
    },
    async ({ picks }) => {
      // Check every id against IMDb (via OMDb) before saving, so a wrong id never reaches the page.
      const checked = omdbKey ? await Promise.allSettled(picks.map((p) => fetchOmdb(p.imdbId, omdbKey, fetcher))) : null;
      const unknown = picks.filter((_, i) => checked?.[i].status === "fulfilled" && checked[i].value === null);
      if (unknown.length) {
        return fail(
          `Nothing was saved. IMDb has no title with these ids: ${unknown.map((p) => `${p.imdbId} (${p.title})`).join(", ")}. ` +
            "Look them up with find_film and save again.",
        );
      }
      const items = picks.map((p) => ({ title: p.title, year: p.year ?? null, imdbId: p.imdbId, why: p.why }));
      await memory.save({ ...(await memory.load()), picks: { items, updatedAt: now() } });
      return json({
        saved: items.length,
        check: "Make sure each id is the film you meant; if not, find the right id and save again.",
        picks: picks.map((p, i) => {
          const r = checked?.[i];
          const onImdb = r?.status === "fulfilled" && r.value ? `${r.value.title} (${r.value.year})` : "could not be checked";
          return { imdbId: p.imdbId, youSaid: `${p.title}${p.year ? ` (${p.year})` : ""}`, onImdb };
        }),
      });
    },
  );

  // ---------- Letterboxd data (read-only) ----------

  /** Wraps a query: JSON text result, or the no-data error when nothing is uploaded. */
  const answer =
    <A>(fn: (d: Dataset, args: A) => unknown) =>
    async (args: A) => {
      if (!data) return { isError: true, content: [{ type: "text" as const, text: NO_DATA_MESSAGE }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(fn(data, args), null, 2) }] };
    };

  server.registerTool(
    "get_taste_summary",
    {
      title: "Taste summary",
      description:
        "Overview of the user's film taste: counts, average rating, rating distribution, top and lowest rated films, decades watched, and their most recent written reviews (up to 30). Start here for recommendations; the reviews explain the ratings.",
      inputSchema: {},
      annotations: readOnly,
    },
    answer((d) => getTasteSummary(d)),
  );

  server.registerTool(
    "has_seen",
    {
      title: "Has the user seen a film?",
      description:
        "Look up a film by title (forgiving of case, accents, punctuation and a leading 'The'). Returns every matching film with watched status, star rating, diary dates, watchlist and liked flags, and the user's written reviews of it. Empty matches means the user has no record of it. If exactMatch is false, the matches are only partial title matches (other films), so do not assume the user has seen the film you asked about.",
      inputSchema: {
        title: z.string().min(1).describe("Film title"),
        year: year.optional().describe("Release year, to pick between remakes"),
      },
      annotations: readOnly,
    },
    answer((d, a: { title: string; year?: number }) => hasSeen(d, a.title, a.year)),
  );

  server.registerTool(
    "get_ratings",
    {
      title: "Rated films",
      description:
        "The user's star ratings (0.5–5), filterable by rating and release year, sortable, paginated. Films the user wrote about include their reviews, which explain the rating.",
      inputSchema: {
        minRating: rating.optional(),
        maxRating: rating.optional(),
        yearFrom: year.optional().describe("Earliest release year"),
        yearTo: year.optional().describe("Latest release year"),
        sort: z.enum(["rating_desc", "rating_asc", "date_desc", "year_desc"]).optional(),
        ...paging,
      },
      annotations: readOnly,
    },
    answer(getRatings),
  );

  server.registerTool(
    "get_diary",
    {
      title: "Diary entries",
      description:
        "Films the user logged with a watch date, newest first, optionally within a date range. Entries the user wrote about include their review text.",
      inputSchema: { from: day.optional(), to: day.optional(), ...paging },
      annotations: readOnly,
    },
    answer(getDiary),
  );

  server.registerTool(
    "get_watchlist",
    {
      title: "Watchlist",
      description: "Films the user wants to watch, most recently added first.",
      inputSchema: { ...paging },
      annotations: readOnly,
    },
    answer(getWatchlist),
  );

  server.registerTool(
    "get_reviews",
    {
      title: "Reviews",
      description:
        "The user's written reviews, newest first: their own words on what worked and what didn't. Filter by title (forgiving, like has_seen) or star rating, e.g. maxRating 2.5 to see what they dislike and why.",
      inputSchema: {
        title: z.string().min(1).optional().describe("Film title"),
        minRating: rating.optional(),
        maxRating: rating.optional(),
        ...paging,
      },
      annotations: readOnly,
    },
    answer(getReviews),
  );

  return server;
}
