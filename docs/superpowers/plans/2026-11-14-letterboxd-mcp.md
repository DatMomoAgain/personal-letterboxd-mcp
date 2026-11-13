# Letterboxd MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only remote MCP server on Cloudflare Workers that serves the user's Letterboxd export to Claude (claude.ai custom connector + Claude Code).

**Architecture:** A local Node script parses the Letterboxd export (folder or ZIP) into one JSON `Dataset` and uploads it to Cloudflare KV. A stateless Worker answers MCP requests only on `/mcp/<MCP_TOKEN>`, loads the dataset from KV, and runs pure query functions over it.

**Tech Stack:** TypeScript, Cloudflare Workers + KV, wrangler 4.x, `@modelcontextprotocol/sdk` 1.32 (`WebStandardStreamableHTTPServerTransport`, stateless, JSON responses), zod 4, vitest, fflate (ZIP reading in the upload script).

**Spec:** `/home/datmomoagain/Code/letterboxd-mcp/DESIGN.md`

## Global Constraints

- Project root: `/home/datmomoagain/Code/letterboxd-mcp`. Package manager: npm (Node 22 is installed; no global installs, no sudo).
- Read-only. No Letterboxd password, no requests to letterboxd.com, no RSS, no HTML scraping.
- Data source = export CSVs only: `ratings.csv`, `watched.csv`, `watchlist.csv`, `diary.csv`, `reviews.csv`, `likes/films.csv`. From `profile.csv` read **only** the `Username` column. Ignore `comments.csv`, `deleted/`, `orphaned/`, `likes/lists.csv`, `likes/reviews.csv`.
- Export headers (verified 2026-11-14):
  - ratings: `Date,Name,Year,Letterboxd URI,Rating`
  - watched / watchlist / likes/films: `Date,Name,Year,Letterboxd URI`
  - diary: `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date`
  - reviews: `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date`
- Access: the MCP endpoint is exactly `/mcp/<MCP_TOKEN>`, where `MCP_TOKEN` is a Worker secret of 64 hex chars. Everything else → `404` with an empty body. If `MCP_TOKEN` is unset or shorter than 32 chars → 404 for everything (fail closed).
- KV binding `LETTERBOXD`, key `dataset`.
- The token and full URL live in `/home/datmomoagain/Code/letterboxd-mcp/.connector-url` (gitignored, mode 600). Never print the token into committed files.
- No git commits unless the user asks. A `.gitignore` is still created (`node_modules`, `.wrangler`, `.connector-url`, `.dev.vars`, `dist`).
- User notes go to `~/Desktop/notes/claude/letterboxd-mcp.md` (plain language: refresh, where the URL lives, how to undo).

## Review Focus

1. Titles containing commas or quotes (e.g. `"Crouching Tiger, Hidden Dragon"`) must parse as one field. → Task 1 test `parses quoted fields with commas and escaped quotes`.
2. `has_seen` with different case, accents or punctuation (`amelie` → `Amélie`, `se7en` → `Se7en`, `wailing` → `The Wailing`) finds the film; titles shared by remakes return every match with its year. → Task 2 tests `has_seen normalizes titles`, `has_seen returns all year variants`.
3. Wrong path, a prefix of the token, a missing secret, or a GET on `/` must return 404 and leak nothing. → Task 4 tests.
4. KV is empty (deployed but not uploaded yet) → every tool returns a clear "no data uploaded yet" message, not a crash. → Task 3 test `tools report missing dataset`.
5. Profile data (email, name, bio) never reaches the dataset, even when `profile.csv` has values. → Task 1 test `dataset never contains profile fields`.

---

### Task 1: Project scaffold, CSV parser, export → Dataset

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/types.ts`, `src/csv.ts`, `src/dataset.ts`
- Test: `tests/csv.test.ts`, `tests/dataset.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  interface Film { name: string; year: number | null; uri: string }
  interface DatedFilm extends Film { date: string }              // YYYY-MM-DD
  interface RatedFilm extends DatedFilm { rating: number }       // 0.5–5
  interface DiaryEntry extends DatedFilm { watchedDate: string | null; rating: number | null; rewatch: boolean; tags: string[] }
  interface Review extends DiaryEntry { review: string }
  interface Dataset { username: string; uploadedAt: string; ratings: RatedFilm[]; watched: DatedFilm[];
    watchlist: DatedFilm[]; diary: DiaryEntry[]; reviews: Review[]; likedFilms: DatedFilm[] }
  type ExportFiles = Record<string, string>   // relative path ("likes/films.csv") → file text
  ```
- Produces: `parseCsv(text: string): Record<string, string>[]` (`src/csv.ts`; header row → keys; RFC 4180 quotes, `""` escapes, CRLF/LF, embedded newlines in quoted fields, trailing newline ignored, BOM stripped).
- Produces: `buildDataset(files: ExportFiles, uploadedAt: string): Dataset` (`src/dataset.ts`). Missing optional files → empty arrays. Missing `ratings.csv` **and** `watched.csv` → throws `Error("Not a Letterboxd export: ratings.csv and watched.csv are missing")`. Empty `Year` → `null`; empty `Rating` → `null` (diary/reviews) or row skipped (ratings); `Rewatch` `"Yes"` → true; `Tags` split on `", "`.

- [ ] **Step 1: Scaffold.** `npm init -y`, set `"type": "module"`, scripts `test: vitest run`, `typecheck: tsc --noEmit`, `dev: wrangler dev`, `deploy: wrangler deploy`, `upload: node --experimental-strip-types scripts/upload.ts`. Dev deps: `wrangler@^4.162.0 typescript vitest @cloudflare/workers-types fflate`; deps: `@modelcontextprotocol/sdk@^1.32.2 zod@^4`. tsconfig: `target ES2022`, `module ESNext`, `moduleResolution bundler`, `strict`, `types: ["@cloudflare/workers-types"]`, `allowImportingTsExtensions`, `noEmit`.
- [ ] **Step 2: Write failing tests** in `tests/csv.test.ts`:
  - `parses header and rows`: `"Date,Name\n2025-01-01,Heat\n"` → `[{Date:"2025-01-01",Name:"Heat"}]`
  - `parses quoted fields with commas and escaped quotes`: `'Name,Year\n"Crouching Tiger, Hidden Dragon",2000\n"The ""Best"" Film",1999'` → names `Crouching Tiger, Hidden Dragon` and `The "Best" Film`
  - `handles CRLF, BOM, and newline inside quotes`
  - `header-only file returns []`

  And in `tests/dataset.test.ts` (fixture built inline as an `ExportFiles` object from the real headers above):
  - `maps ratings with numeric rating and year`: `2025-12-25,Little Miss Sunshine,2006,https://boxd.it/29EW,3.5` → `{name:"Little Miss Sunshine", year:2006, rating:3.5, date:"2025-12-25", uri:"https://boxd.it/29EW"}`
  - `empty year becomes null`
  - `diary rewatch and tags parsed`: `Rewatch "Yes"`, `Tags "horror, a24"` → `rewatch:true, tags:["horror","a24"]`
  - `missing optional files give empty arrays` (only ratings + watched provided)
  - `throws on non-export input` (`{}`) with the message above
  - `username comes from profile.csv`; `dataset never contains profile fields`: profile row with `Email Address` `x@example.com`, `Given Name` `Momo`, `Bio` `secret bio` → `JSON.stringify(dataset)` contains none of those three strings
  - `uploadedAt is passed through`
- [ ] **Step 3: Run** `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** `src/types.ts`, `parseCsv`, `buildDataset`.
- [ ] **Step 5: Run** `npm test && npm run typecheck`. Expected: all pass, no type errors.

### Task 2: Query functions

**Files:**
- Create: `src/queries.ts`
- Test: `tests/queries.test.ts`

**Interfaces:**
- Consumes: `Dataset` and the other types from Task 1.
- Produces (all pure, `src/queries.ts`; `Page<T> = { total: number; offset: number; items: T[] }`, default `limit` 50, max 200):
  - `getRatings(d, o: { minRating?: number; maxRating?: number; yearFrom?: number; yearTo?: number; sort?: "rating_desc" | "rating_asc" | "date_desc" | "year_desc"; limit?: number; offset?: number }): Page<RatedFilm>`. Default sort `rating_desc`, ties broken by name.
  - `getDiary(d, o: { from?: string; to?: string; limit?; offset? }): Page<DiaryEntry>`. Filters on `watchedDate ?? date`, newest first.
  - `getWatchlist(d, o: { limit?; offset? }): Page<DatedFilm>`. Newest first.
  - `getReviews(d, o: { title?: string }): Review[]`. Title uses the same matching as `hasSeen`.
  - `hasSeen(d, title: string, year?: number): { query: string; matches: SeenMatch[] }`, where `SeenMatch = { name; year; uri; watched: boolean; rating: number | null; diaryDates: string[]; onWatchlist: boolean; liked: boolean }`. Films are merged across lists by `uri`.
  - `normalizeTitle(s: string): string`: NFD + strip diacritics, lowercase, drop a leading `the `/`a `/`an `, remove everything except `[a-z0-9]`.
  - `getTasteSummary(d): TasteSummary` = `{ username; uploadedAt; counts: { watched; rated; watchlist; diary; reviews; liked }; averageRating: number | null (1 decimal); ratingDistribution: Record<"0.5"|"1"|…|"5", number>; topRated: RatedFilm[] (rating desc, max 20); lowestRated: RatedFilm[] (rating asc, max 10); decades: { decade: string /* "1990s" */; watched: number; averageRating: number | null }[] (sorted by decade) }`.

Matching algorithm for `hasSeen` (the tests don't pin this down):
```
q = normalizeTitle(title)
exact = films where normalizeTitle(name) === q
candidates = exact.length ? exact : films where normalizeTitle(name).includes(q)   // only if q.length >= 3
if year given: candidates = candidates.filter(f => f.year === year)
```

- [ ] **Step 1: Write failing tests** with a small inline `Dataset` fixture (≈8 films, including `Amélie` 2001, `Se7en` 1995, `The Wailing` 2016 on the watchlist only, `Suspiria` 1977 rated 4 and `Suspiria` 2018 rated 3, and one watched-but-unrated film):
  - `getRatings filters by min rating and year range`; `getRatings sorts and paginates` (`limit:2, offset:2` → `total` is the full count, 2 items)
  - `getRatings clamps limit to 200`
  - `getDiary filters by date range on watchedDate`
  - `has_seen normalizes titles`: `"amelie"`, `"SE7EN"`, `"wailing"` each give one match; `wailing` → `watched:false, onWatchlist:true`
  - `has_seen returns all year variants`: `"suspiria"` → 2 matches; with `year:2018` → 1 match, rating 3
  - `has_seen watched but unrated` → `watched:true, rating:null`
  - `has_seen unknown title returns empty matches`
  - `taste summary counts, distribution, decades and average`: assert exact numbers for the fixture
- [ ] **Step 2: Run** `npm test -- queries`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/queries.ts`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

### Task 3: MCP server (tool registration)

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: the Task 2 query functions, `Dataset`.
- Produces: `buildServer(data: Dataset | null): McpServer`. Server name `letterboxd`, version `1.0.0`. Instructions string: "Read-only access to the user's Letterboxd history (from their data export). Use has_seen before recommending a film; use get_taste_summary first for recommendations. Data is as of uploadedAt."
- Tools (zod input schemas mirror the Task 2 options; all annotated `readOnlyHint: true`; output = one `text` content item holding `JSON.stringify(result, null, 2)`):
  `get_ratings`, `get_diary`, `get_watchlist`, `has_seen` (`title` required, `year` optional), `get_reviews`, `get_taste_summary`.
- When `data` is null, every tool returns `isError: true` with the text `No Letterboxd data has been uploaded yet. Run "npm run upload -- <export folder or zip>" in ~/Code/letterboxd-mcp.`

- [ ] **Step 1: Write failing tests** using the SDK's `Client` + `InMemoryTransport.createLinkedPair()`:
  - `lists exactly the six tools` (sorted names match)
  - `has_seen returns JSON matches` (fixture from Task 2 test helpers; move the fixture into `tests/fixture.ts`)
  - `tools report missing dataset`: `buildServer(null)` → `get_ratings` result has `isError: true` and the exact text above
  - `rejects invalid input`: `get_ratings` with `minRating: 9` → error
- [ ] **Step 2: Run** `npm test -- server`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/server.ts` (zod: `rating` fields are `z.number().min(0.5).max(5)`; dates are `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`).
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.

### Task 4: Worker entry (secret path, KV, HTTP transport)

**Files:**
- Create: `src/index.ts`, `wrangler.jsonc`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: `buildServer`.
- Produces: `export default { fetch(req: Request, env: Env): Promise<Response> }`, where `interface Env { LETTERBOXD: KVNamespace; MCP_TOKEN?: string }`.
- Per request: check the path (constant-time compare of the full path against `/mcp/${env.MCP_TOKEN}`), then `env.LETTERBOXD.get("dataset", "json")`, then `buildServer(data)`, then a new `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`, then `server.connect(transport)`, then `transport.handleRequest(req)`.
- `wrangler.jsonc`: `name: "letterboxd-mcp"`, `main: "src/index.ts"`, `compatibility_date: "2026-11-01"`, `compatibility_flags: ["nodejs_compat"]`, `kv_namespaces: [{ binding: "LETTERBOXD", id: "<filled in Task 6>" }]`, `workers_dev: true`.

- [ ] **Step 1: Write failing tests** calling `worker.fetch` directly with a fake KV (`{ get: async () => fixture }`) and `MCP_TOKEN = "a".repeat(64)`:
  - `404 on root`, `404 on /mcp`, `404 on /mcp/<token minus last char>`, `404 on /mcp/<token>/extra`
  - `404 for everything when MCP_TOKEN is unset or short`
  - `initialize succeeds on the secret path`: POST a JSON-RPC `initialize` (headers `content-type: application/json`, `accept: application/json, text/event-stream`) → 200, result includes `serverInfo.name === "letterboxd"`
  - `tools/call works on the secret path` (initialize is not required for a stateless server; if the SDK insists, send it first in the same test)
  - `empty KV gives the no-data message`
- [ ] **Step 2: Run** `npm test -- worker`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/index.ts` and `wrangler.jsonc`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Local smoke test.** Create a `.dev.vars` file with `MCP_TOKEN=<64 a's>`, run `npx wrangler dev`, then curl the initialize request from Step 1 → 200. Stop the dev server.

### Task 5: Upload script

**Files:**
- Create: `scripts/upload.ts`, `src/readExport.ts`
- Test: `tests/readExport.test.ts`

**Interfaces:**
- Consumes: `buildDataset`.
- Produces: `readExport(path: string): Promise<ExportFiles>` (`src/readExport.ts`, Node-only). It accepts a folder or a `.zip`. Only the whitelisted paths from Global Constraints are read (profile.csv is included only so `buildDataset` can read the username column).
- `scripts/upload.ts <path>`: `readExport`, then `buildDataset(files, new Date().toISOString())`, then write the JSON to `os.tmpdir()/letterboxd-dataset-<pid>.json`, then run `npx wrangler kv key put dataset --path <tmp> --binding LETTERBOXD --remote`, then delete the temp file and print `Uploaded: N rated, N watched, N on watchlist (as of <date>)`. It exits non-zero with a readable message if the path is missing or isn't an export.

- [ ] **Step 1: Write failing tests**: `reads a folder` and `reads a zip` (build a tiny zip in the test with `fflate.zipSync`), and `ignores non-whitelisted files` (e.g. `comments.csv` and `deleted/diary.csv` are absent from the result).
- [ ] **Step 2: Run** `npm test -- readExport`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Dry check against the real export.** Run `node --experimental-strip-types -e` (or a `--dry-run` flag on the script that prints the counts and skips the upload) on `~/Downloads/letterboxd-datmomoagain-2026-11-13-20-55-utc`. Expected: `94 rated, 94 watched, 14 on watchlist`.

### Task 6: Deploy, upload, connect (needs the user)

- [ ] **Step 1: The user runs** `! npx wrangler login` (browser approval). Verify with `npx wrangler whoami`.
- [ ] **Step 2:** `npx wrangler kv namespace create LETTERBOXD`, then put the returned id into `wrangler.jsonc`.
- [ ] **Step 3:** Generate a token with `openssl rand -hex 32`, then pipe it into `npx wrangler secret put MCP_TOKEN` (never echo it to the terminal).
- [ ] **Step 4:** `npm run deploy`, then write `https://letterboxd-mcp.<subdomain>.workers.dev/mcp/<token>` to `.connector-url` (chmod 600).
- [ ] **Step 5:** `npm run upload -- ~/Downloads/letterboxd-datmomoagain-2026-11-13-20-55-utc`. Expected: `Uploaded: 94 rated, 94 watched, 14 on watchlist`.
- [ ] **Step 6: Remote smoke test.** Curl `initialize` and then `tools/call get_taste_summary` against the URL → counts are 94/94/14. Also check that `/` and `/mcp/wrong` return 404.
- [ ] **Step 7: The user adds the connector** in claude.ai (Settings → Connectors → Add custom connector, name "Letterboxd", paste the URL, no OAuth). After restarting Claude Code, verify `has_seen` works from here.
- [ ] **Step 8: Write** `~/Desktop/notes/claude/letterboxd-mcp.md`: what it is, where the code and URL live, how to refresh (export → `npm run upload -- <zip>`), how to rotate the secret (new `secret put`, then update the connector URL), and how to remove everything (`npx wrangler delete`, `npx wrangler kv namespace delete`, remove the connector in claude.ai).
