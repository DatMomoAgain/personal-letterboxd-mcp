// Usage: npm run setup [-- --new-token]
//
// Deploys the Worker to your Cloudflare account, gives it a secret token, and saves the two
// secret links to .connector-url and .page-url (git-ignored, readable only by you). Safe to
// re-run: it keeps the existing token unless you pass --new-token.
//
// It never prints the token, so its output is safe to share or paste into a chat.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTOR_FILE = join(root, ".connector-url");
const PAGE_FILE = join(root, ".page-url");
const WORKERS_DEV = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** Runs wrangler with captured output (nothing echoed). */
function wrangler(args: string[], input?: string) {
  const res = spawnSync("npx", ["wrangler", ...args], { cwd: root, input, encoding: "utf8" });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Reads the token and Worker address back from an existing .connector-url. */
function savedConnector(): { base: string; token: string } | null {
  if (!existsSync(CONNECTOR_FILE)) return null;
  const m = readFileSync(CONNECTOR_FILE, "utf8").trim().match(/^(https:\/\/[^/]+)\/mcp\/([0-9a-f]{32,})$/i);
  return m ? { base: m[1], token: m[2] } : null;
}

async function check(label: string, request: () => Promise<Response>): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await request();
      if (res.ok) {
        console.log(`  ✓ ${label}`);
        return true;
      }
    } catch {
      // Not reachable yet; a fresh deploy or secret can take a few seconds to arrive.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  ✗ ${label} isn't answering yet`);
  return false;
}

async function main() {
  const newToken = process.argv.includes("--new-token");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) fail(`Node 22 or newer is needed (this is ${process.versions.node}).`);

  console.log("Checking your Cloudflare login…");
  const who = wrangler(["whoami"]);
  if (!who.ok || /not authenticated/i.test(who.out)) {
    fail("You're not logged in to Cloudflare. Run `npx wrangler login`, then run this again.");
  }

  const saved = savedConnector();
  let token = saved && !newToken ? saved.token : null;
  if (!token && !newToken) {
    // A token on the Worker with no local file means an existing setup; a new token would
    // silently break its connector and page links.
    const secrets = wrangler(["secret", "list", "--format", "json"]);
    if (secrets.ok && /"MCP_TOKEN"/.test(secrets.out)) {
      fail(
        "This Worker already has a token, but .connector-url is missing here.\n" +
          "  Copy .connector-url and .page-url from where you set it up, or run\n" +
          "  `npm run setup -- --new-token` to make a new one (the old links stop working).",
      );
    }
  }

  console.log("Deploying the Worker…");
  const deploy = wrangler(["deploy"]);
  if (!deploy.ok) {
    if (/workers\.dev subdomain/i.test(deploy.out)) {
      fail(
        "Your Cloudflare account has no workers.dev address yet. Open https://dash.cloudflare.com →\n" +
          "  Workers & Pages once (it asks you to pick one), then run this again.",
      );
    }
    console.error(deploy.out);
    fail("The deploy failed (Wrangler's output is above).");
  }
  const base = deploy.out.match(WORKERS_DEV)?.[0] ?? saved?.base;
  if (!base) fail("Deployed, but couldn't find the Worker's workers.dev address in Wrangler's output.");
  console.log(`  ✓ Deployed to ${base}`);

  if (!token) {
    console.log(newToken ? "Making a new secret token…" : "Making the secret token…");
    token = randomBytes(32).toString("hex");
    const put = wrangler(["secret", "put", "MCP_TOKEN"], token);
    if (!put.ok) fail("Couldn't save the token on Cloudflare (`wrangler secret put MCP_TOKEN` failed).");
    console.log("  ✓ Token saved on Cloudflare");
  }

  writeFileSync(CONNECTOR_FILE, `${base}/mcp/${token}\n`, { mode: 0o600 });
  writeFileSync(PAGE_FILE, `${base}/home/${token}\n`, { mode: 0o600 });
  console.log("  ✓ Secret links saved to .connector-url and .page-url");

  console.log("Checking it works…");
  const pageOk = await check("Personal page", () => fetch(`${base}/home/${token}`));
  const mcpOk = await check("MCP endpoint", () =>
    fetch(`${base}/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setup-check", version: "1" } },
      }),
    }),
  );

  console.log(`
Next steps (the links are secrets, like passwords):
  1. Open the link in .page-url in your browser and upload your Letterboxd export ZIP
     (letterboxd.com → Settings → Data → Export your data).
  2. Add the link in .connector-url as a custom connector in claude.ai (Settings → Connectors),
     or in Claude Code: claude mcp add --transport http letterboxd "$(cat .connector-url)"
  Optional, in your own terminal (each asks for the key):
     npx wrangler secret put TMDB_TOKEN   # posters: TMDB "API Read Access Token"
     npx wrangler secret put OMDB_KEY     # IMDb, Rotten Tomatoes and Metacritic scores`);

  if (!pageOk || !mcpOk) {
    fail("Setup finished, but the checks above failed. Wait a minute and run `npm run setup` again.");
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
