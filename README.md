# personal-letterboxd-mcp

[![DatMomoAgain/personal-letterboxd-mcp MCP server](https://glama.ai/mcp/servers/DatMomoAgain/personal-letterboxd-mcp/badges/score.svg)](https://glama.ai/mcp/servers/DatMomoAgain/personal-letterboxd-mcp)

A personal [MCP](https://modelcontextprotocol.io) server that gives Claude (claude.ai, the apps and
Claude Code) your Letterboxd history and a taste memory it keeps for you, so recommendations are based
on what you've watched and what you wrote about it. It reads Letterboxd's official data export: no
scraping, no password.

![Watch next: your watch list on a poster stage with IMDb, Rotten Tomatoes and Metacritic scores](docs/screenshots/watch-next.png)

![Taste: Claude's overview, then its notes grouped by topic with example films](docs/screenshots/taste.png)

## What it does

**For Claude**
- Reads your watched films, ratings, reviews and watchlist. `check_films` gives everything known about
  a list of titles in one call; `find_film` gets IMDb ids and real ratings.
- Keeps a **taste memory** in your own storage, not Claude's memory, and reads it first in every chat.
  It asks before every write and is told not to overcorrect from one review.
- Keeps your **watch next** list of films you've decided to watch, each with Claude's reason. Once
  you've watched one, the reason stays so Claude can learn what landed.
- Per title, for any film or series: a **don't-recommend** reason and one **note** about what you said
  in chats.

**For you**, a private page:
- **Watch next:** one pick at a time, with Claude's reason and IMDb, Rotten Tomatoes and Metacritic scores.
- **Films:** a poster wall of everything you've watched, with search and filters.
- **Taste:** Claude's overview and notes about your taste, with example films.
- An upload box for a new Letterboxd export, from any device.

## Talking to it

Say which of three things you want:

> Just watched The Revenant, gave it 3.5. Let's talk about it.

> Recommend 5 films for tonight. Something tense, under 2 hours.

> Review my taste notes against my whole history. Flag anything contradicted or out of date.

If Claude reads too much into something, "that was just about that film" corrects it.

## Run your own copy

Each person runs their own copy on their own free Cloudflare account, or in a container (see
"Without Cloudflare" below). In Claude Code, open this folder
and ask it to set this up: the [setup skill](.claude/skills/setup/SKILL.md) walks you through it.

You need Node 22+, a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and your Letterboxd
export (letterboxd.com → Settings → Data → Export your data). Optional: a
[TMDB](https://www.themoviedb.org/settings/api) **API Read Access Token** for posters, and an
[OMDb](https://www.omdbapi.com/apikey.aspx) key for scores.

```sh
npm install
npx wrangler login
npm run setup
```

`npm run setup` deploys the Worker, makes a secret token, checks it works and saves two secret links:
`.connector-url` (for Claude) and `.page-url` (your page). There's no login: the token in these links
is the only lock, so treat them like passwords. If setup says your account has no workers.dev address,
open Workers & Pages in the Cloudflare dashboard once, then run it again.

Then:

1. Open the link in `.page-url` and upload your export ZIP. Re-upload a new export whenever you like.
2. Add the link in `.connector-url` as a custom connector in claude.ai (Settings → Connectors), or in
   Claude Code: `claude mcp add --transport http letterboxd "$(cat .connector-url)"`
3. Optional, in your own terminal (each asks for the key):
   `npx wrangler secret put TMDB_TOKEN` and `npx wrangler secret put OMDB_KEY`

**Later:**
- Update: `git pull && npm run deploy`. Then refresh the connector in claude.ai and start a new chat.
- Leaked link: `npm run setup -- --new-token`. The old links stop working.
- Remove: delete the connector, then `npx wrangler delete`. Your data stays in a KV namespace until you
  delete that too (`npx wrangler kv namespace list`, then `npx wrangler kv namespace delete --namespace-id <id>`).

**Without Cloudflare:** the [Dockerfile](Dockerfile) runs the same server in Docker or Podman, on
Cloudflare's open-source runtime, with your data in a volume. Put `MCP_TOKEN=` and the output of
`openssl rand -hex 32` in `.dev.vars` (optionally `TMDB_TOKEN=` and `OMDB_KEY=` lines too), then:

```sh
docker build -t letterboxd-mcp .
docker run -d -p 8787:8787 -v letterboxd-data:/data --env-file .dev.vars letterboxd-mcp
```

Your links are `<address>/mcp/<token>` and `<address>/home/<token>`. Claude Code can use
`http://127.0.0.1:8787` directly; claude.ai needs a public HTTPS address, such as a tunnel or a
reverse proxy in front of the container.

## Development

```sh
npm test           # vitest
npx tsc --noEmit   # type check
npm run dev        # local server; put MCP_TOKEN=<64 hex chars> in .dev.vars
```

## License and credits

[MIT](LICENSE). Posters come from [TMDB](https://www.themoviedb.org); this product uses the TMDB API
but is not endorsed or certified by TMDB. The display font is
[Big Shoulders](https://github.com/xotypeco/big_shoulders) (SIL Open Font License, `src/fonts/LICENSE`).
