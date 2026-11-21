# Per-title records — design

Supersedes the don't-recommend list in `2026-11-22-dont-recommend-design.md`.

## Why
The user wants one lookup that returns everything known about any title (film or series, logged on
Letterboxd or not), in every chat and model: Letterboxd rating, liked and reviews; why Claude picked
it; whether it's ruled out; and a Claude note holding what they said about it in chats (e.g. why a
rating contradicts a taste note, so Claude never asks twice). Facts about one title stay out of the
taste notes, which keeps those from overcorrecting, and out of get_memory, which keeps context small.

## Goals / non-goals
- Goals: one lookup (`check_films`); any title; visible on the page; ask before every write; fewer tools.
- Non-goals: editing on the page; giving every logged Letterboxd film an IMDb id.

## Approaches
1. **Chosen:** one `titles` map in the `memory` KV document, keyed by IMDb id, each record holding an
   optional `dontRecommend` and one `note`. Joined to Letterboxd films by a stored `letterboxdUri`
   once matched, else title + year (one off).
2. Two separate lists (don't-recommend, notes): every lookup and the page merge two lists, and a
   title's name and year live in two places. No benefit.
3. Map every logged film to an IMDb id: exact joins, but a TMDB lookup per film (Workers' 50-request
   limit spreads it over views) and wrong matches need a way to be fixed. Held back unless title
   matching actually fails.

## Design
- **Record:** `titles[imdbId] = { title, year, letterboxdUri?, dontRecommend?: {reason, addedAt},
  note?: {text, updatedAt}, previousNote? }`. One text per title (the user's choice, matching how
  taste notes work); a replaced note keeps the old one as `previousNote`. A record with nothing left
  is dropped. The old `dontRecommend` array converts on load.
- **Linking to Letterboxd:** writes and `get_memory` (every chat's first call, so after any upload)
  store the logged film's `letterboxdUri`; joins use it, else title + year. Write replies say
  "logged: X" or "not logged", so a title mismatch surfaces at once.
- **Tools:** `check_films` (all four kinds of detail; optional IMDb id per title; works before any
  upload; an unlogged pick carries pickedBecause/onWatchNext on the result). `set_dont_recommend`
  (batch; reason or null). `save_title_note` (whole text or null). Removed: `add_/update_/
  remove_dont_recommend`, `get_diary` (replaced by `watchedFrom`/`watchedTo` on `get_watched`).
  `get_watched` marks `hasClaudeNote` instead of carrying the text. `get_taste_summary` carries 10
  reviews, not 30. 13 tools, down from 18.
- **Instructions:** look a title up before asking about it; one-title facts go to records, reasons
  across films to taste notes; read a note before replacing it and show the full new text.
- **Page (Films):** each title in one place, first rule wins: logged → the wall (its panel shows the
  reason and note); else don't-recommend → dimmed tiles; else on Watch next → its card shows the
  note; else note only → "Not logged" tiles. Unlogged tiles open a panel like the wall's.

## Known limitation
Two chats writing at the same moment can lose one change (read-modify-write on one KV value);
pre-existing and unlikely for a single user.
