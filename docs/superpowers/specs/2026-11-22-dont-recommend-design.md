# "Don't recommend" list — design (short)

## Why
The user wants a per-title list of films and series Claude must not recommend, with a reason for each,
kept outside the taste notes. Reasons vary: already seen elsewhere (mostly series, which aren't on
Letterboxd), watched and disliked, on hold for now, or anything else. It replaces the "Don't recommend"
taste note (n22). Two wins: context stays in one place for every chat and model, and turning down one
title no longer tempts Claude into writing a general taste note (overcorrecting).

## Goals
- Claude sees an entry whenever it checks a candidate, never the whole list up front (get_memory stays small).
- Added through chat only, with the user's yes, like picks.
- Visible on the personal page.

## Non-goals
- Editing on the page (chat only, for now).
- Explanations of contradicting ratings (e.g. why Rush got 2★): a separate design, later.
- Ratings or a log for series.

## Approaches
1. **Chosen:** a new `dontRecommend` array in the existing `memory` KV document, matched by title and
   release year (±1), like picks. `check_films` already loads `memory`, so no extra read.
2. Its own KV key: tidier on paper, but a second read per check and a second load/save path for no gain.
3. Match by IMDb id only: precise, but every candidate would need a find_film lookup before checking.

## Design
- **Storage:** `memory.dontRecommend: { title, year, imdbId?, reason, addedAt }[]`, newest first.
  `normalizeMemory` defaults it to `[]`. No kind field: "already seen" is just one possible reason.
  Same title+year (or same imdbId) replaces the old entry instead of duplicating it.
- **`has_seen` → `check_films`:** same input and Letterboxd matching. Each result also gets
  `dontRecommend: { reason, addedAt }` when the title (±1 year) is on the list. The description says
  any entry means don't recommend it. All tool descriptions and INSTRUCTIONS that mention has_seen are updated.
- **Write tools** (ask before writing, like picks): `add_dont_recommend` (1–20 entries, imdbId from
  find_film, required for every entry, since edits and removals go by it), `update_dont_recommend` (change reason), `remove_dont_recommend`.
- **get_memory:** leaves the list out (it's for lookups, not loaded up front).
- **Instructions:** when the user turns down a single title, offer to add it to this list rather than
  proposing a taste note; taste notes are for reasons that repeat across films.
- **Page:** a "Don't recommend" section at the bottom of the Films view, separate from the poster wall:
  one row per entry with title, year and reason. Hidden when the list is empty.
- **Migration (after deploy, with the user's yes, via the new tools):** move Barry, Prisoners, RRR and
  Top Gun: Maverick from note n22 into the list, then forget n22. Top Gun stays as an example in the
  spectacle note (n10).

## Left to the builder
Exact field/tool wording, row styling on the page, tests (memory functions, server tools, page), README
and version bump.
