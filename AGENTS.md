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

## Secrets

The token lives only in `.connector-url`, `.page-url` and `.dev.vars`, all git-ignored. Committed
files write it as `<token>`.

## History

`docs/superpowers/` holds dated plans and specs: a record of what was decided at the time. Leave
them as written; they aren't part of the docs above.
