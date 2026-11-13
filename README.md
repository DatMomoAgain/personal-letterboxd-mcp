# personal-letterboxd-mcp

A personal, single-user [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that gives Claude
(claude.ai, the apps, and Claude Code) access to your Letterboxd history, so film recommendations
are based on what you've actually watched and what you wrote about it.

It works from Letterboxd's official data export, not scraping and not your password.

## What it does

**For Claude (MCP tools)**
- Read: taste summary, ratings, diary, reviews, watchlist, and "have I seen this?", with your review
  text attached wherever a film appears.
- Taste memory: Claude saves what it learns about your taste (`remember`, `update_note`, `forget`)
  in your own Cloudflare KV, not in Claude's memory, and reads it first in every chat.
- Saves its recommendations and a written overview of your taste for the personal page.

**For you (a private web page)**
- Claude's "watch next" picks (they disappear once you've watched them), its taste overview and
  notes, your paginated diary with reviews and TMDB posters, and stats.
- An upload form for a new Letterboxd export ZIP, so it works from any device.
- Server-rendered HTML, no JavaScript, strict CSP, no-referrer, noindex.

## How access works

There's no login. The MCP endpoint and the page live at `/mcp/<token>` and `/home/<token>`, where
`<token>` is a long random secret (`MCP_TOKEN`). Everything else returns 404. Treat both URLs like
passwords.

## Setup

Requires Node 22+ and a Cloudflare account (the free plan is plenty).
For posters, also a free [TMDB](https://www.themoviedb.org/settings/api) account: use its
**API Read Access Token** (not the shorter API Key). Without it everything works, just without posters.

```sh
npm install
npx wrangler login
npx wrangler kv namespace create LETTERBOXD   # put the id in wrangler.jsonc
openssl rand -hex 32 | npx wrangler secret put MCP_TOKEN
npx wrangler secret put TMDB_TOKEN            # optional: TMDB "API Read Access Token", for posters
npm run deploy
```

Then add `https://<your-worker>.workers.dev/mcp/<token>` as a custom connector in claude.ai
(Settings → Connectors), and open `/home/<token>` to upload your export
(letterboxd.com → Settings → Data → Export your data). You can also upload from the command line:
`npm run upload -- path/to/export.zip`.

## Development

```sh
npm test           # vitest
npx tsc --noEmit   # type check
```

Code lives in `src/`: `index.ts` (routing and auth), `server.ts` (MCP tools and instructions),
`queries.ts` (reading the export), `memory.ts` (taste memory), `page.ts` (the personal page),
`posters.ts` (TMDB lookups, cached in KV), `exportZip.ts` / `dataset.ts` (parsing the export).

Poster images are provided by [TMDB](https://www.themoviedb.org). This product uses the TMDB API
but is not endorsed or certified by TMDB.
