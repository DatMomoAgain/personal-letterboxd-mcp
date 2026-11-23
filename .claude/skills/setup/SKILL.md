---
name: setup
description: Walk the user through running their own copy of this Letterboxd MCP server on Cloudflare (login, `npm run setup`, uploading their export, connecting Claude, optional poster and score keys). Use when someone wants to set up or deploy this project, or when `npm run setup` fails.
---

# Set up your own copy

The person ends with their own Worker on their own Cloudflare account, their Letterboxd data uploaded, and Claude connected. The README's "Run your own copy" section is the human version of these steps; send them there for detail.

## Secrets stay out of the conversation

The token (inside `.connector-url` and `.page-url`) and the TMDB / OMDb keys are **secrets**: anyone holding them can read the person's film data and taste notes. Everything in this conversation is a transcript, so:

- Refer to `.connector-url` and `.page-url` by name and use them inside commands (`"$(cat .connector-url)"`) so only the command shows. Leave their contents unread.
- Hand any step that displays or types a secret to the person, to run in **their own terminal window** (not with `!`, which puts the output in this chat). Each such step below says so.
- `npm run setup` never prints the token, so you can run it yourself and read its output.

## Steps

1. **Prerequisites.** Check `node --version` (22 or newer) and run `npm install`. If they have no Cloudflare account, send them to https://dash.cloudflare.com/sign-up (free plan). Done when Node is 22+, `npm install` succeeded, and they have an account.

2. **Run `npm run setup`** yourself and read its output.
   - "not logged in": ask them to run `! npx wrangler login` (it opens their browser; the output holds no secret), then run setup again.
   - "no workers.dev address yet": they open the Cloudflare dashboard → Workers & Pages once and pick a subdomain; run setup again.
   - "already has a token, but .connector-url is missing": an earlier setup exists. Ask whether they can copy `.connector-url` and `.page-url` from that machine, or want `npm run setup -- --new-token` (their old connector and page links stop working). The choice is theirs.
   - Any other failure: read Wrangler's output it printed and fix the cause before rerunning.

   Done when the output ends with ✓ for both "Personal page" and "MCP endpoint".

3. **Upload their Letterboxd data.** They export from letterboxd.com → Settings → Data → Export your data. Open the page for them with `xdg-open "$(cat .page-url)"` (`open` on macOS), or ask them to open the link in `.page-url`. They pick the ZIP and press Upload. Done when they confirm the page shows their films.

4. **Connect Claude.** Ask where they use Claude:
   - claude.ai or the apps: Settings → Connectors → add custom connector, pasting the link from `.connector-url`. To copy it without showing it: `wl-copy < .connector-url` (Wayland), `xclip -sel clip < .connector-url` (X11) or `pbcopy < .connector-url` (macOS), run by you or by them.
   - Claude Code: in their own terminal, `claude mcp add --transport http letterboxd "$(cat .connector-url)"` (its output can show the link).

   Done when, in a new chat, Claude can call the Letterboxd tools (e.g. `get_taste_summary`).

5. **Optional: posters and scores.** Ask whether they want posters (TMDB) and IMDb / Rotten Tomatoes / Metacritic scores (OMDb); the README's "Run your own copy" links where to get each key (for TMDB, the **API Read Access Token**, not the shorter API Key). In their own terminal they run `npx wrangler secret put TMDB_TOKEN` and/or `npx wrangler secret put OMDB_KEY`; each asks for the key. Done when the page shows posters (scores show on picks once they have some) after a reload, or they decline.

6. **Wrap up.** Tell them: the links live in `.connector-url` and `.page-url` and work like passwords; to refresh their data they export again and upload on the page; to update the code, `git pull && npm run deploy`; if a link leaks, `npm run setup -- --new-token`.
