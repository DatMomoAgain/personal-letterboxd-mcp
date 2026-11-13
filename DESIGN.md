# Letterboxd MCP connector — design

_2026-11-14 · small project_

## Why
Give Claude the user's real film history so movie recommendations are grounded in what
they've watched and rated. It must work everywhere they use Claude (claude.ai web, apps,
Claude Code), so it's a claude.ai custom connector, not a Project or a CLI-only tool.

## Goals
- Read-only access to the user's Letterboxd data (username `DatMomoAgain`) from any Claude surface.
- Full history from the Letterboxd data export, which is the only data source.
- Refreshing the history takes a single command.

## Non-goals / anti-goals
- No Letterboxd password, no login automation, no writing to Letterboxd.
- No scraping of Letterboxd HTML pages and no RSS feed. All data comes from the export.
- No claude.ai Projects.
- A failure even if it "works": anyone who guesses the URL can read the data, or it breaks silently when the feed is empty.

## Approaches considered
1. **Remote MCP on Cloudflare Workers + KV (chosen).** Free, always on, and works as a claude.ai custom connector.
2. Local stdio MCP (the existing community servers): won't work on claude.ai web, and most of them want the user's password.
3. claude.ai Project with the CSVs uploaded: doesn't reach Claude Code. The user rejected it.

## Design
- **Runtime:** Cloudflare Worker (TypeScript) using Cloudflare's `agents`/MCP SDK, Streamable HTTP transport.
- **Access:** secret URL path (`/mcp/<long random token>`); every other path returns 404. _(Claude's call; the user can upgrade to OAuth later.)_
- **Storage:** Cloudflare KV holds the parsed export as JSON (ratings, diary, reviews, watched, watchlist).
- **Tools:**
  - `get_ratings`: filter by min/max stars, year range, sort; paginated
  - `get_diary`: entries in a date range
  - `get_watchlist`
  - `has_seen`: title (+ optional year) → watched / rating / logged dates
  - `get_reviews`: optional title filter
  - `get_taste_summary`: rating distribution, top-rated films, favourite decades, how many films are logged, and when the data was last uploaded
- **Refresh:** a local script parses the export ZIP/CSVs and uploads them to KV with `wrangler`. The user runs one command; it gets a note in `~/Desktop/notes/claude/`.

## Observed constraint
The user's public RSS feed had 0 entries on 2026-11-14 (it only contains diary entries and
reviews), so it was dropped. The data is only as fresh as the last uploaded export, so tools
report the upload date so Claude can mention when the data may be stale.

## Left to the builder
The exact schema of the stored JSON, pagination sizes, the wording of the taste-summary output, and tests.
