# AGENTS.md

## Keep the docs in step with the code

Every change updates, in the same change, whichever of these it makes untrue:

- `README.md`: "What it does" (Claude's abilities and page features) and "Run your own copy"
  (setup, connecting, updating, removing). Keep it lean: it describes features, not every tool.
- `.claude/skills/setup/SKILL.md`: anything about setup, deploying, secrets, uploading the export,
  connecting Claude, or `scripts/setup.ts`. The skill quotes that script's messages to tell
  failures apart, so changing a message means changing the skill.

Done when both files read true for the code as it now stands. Say in your summary which of the two
you updated, or that neither needed it.

## Keep the Dockerfile working

The Dockerfile runs the repo as it stands (`npm ci`, then `wrangler dev`), and the Worker reads
secrets from the container's environment, so most changes need nothing there. Update it in the same
change when you:

- change the Node version, or add a build step that `wrangler dev` doesn't run itself;
- make the Worker read files from a folder `.dockerignore` leaves out (`docs`, `tests`);
- add a binding that works only on Cloudflare (e.g. Workers AI). The container can't run it, so
  the README's "Without Cloudflare" must say what's missing.

Done when the image builds and, started with a test token, answers the MCP handshake and serves
the page.

## Secrets

The token lives only in `.connector-url`, `.page-url` and `.dev.vars`, all git-ignored. Committed
files write it as `<token>`. Any file holding a secret goes in both `.gitignore` and `.dockerignore`.

## History

`docs/superpowers/` holds dated plans and specs: a record of what was decided at the time. Leave
them as written; they aren't part of the docs above.
