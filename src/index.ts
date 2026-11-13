import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildDataset } from "./dataset.ts";
import { filesFromZip } from "./exportZip.ts";
import { kvMemoryStore } from "./memory.ts";
import { filmsShown, isUploadStatus, renderPage, type UploadStatus } from "./page.ts";
import { type PosterCache, type Posters, POSTERS_KEY, resolvePosters } from "./posters.ts";
import { buildServer } from "./server.ts";
import type { Dataset } from "./types.ts";

// `Env` comes from worker-configuration.d.ts — regenerate with `npx wrangler types`.
// MCP_TOKEN (64 hex chars) is a secret: `wrangler secret put MCP_TOKEN`.
//
// Routes (everything else is 404):
//   POST /mcp/<token>           MCP endpoint (the claude.ai connector)
//   GET  /home/<token>          personal page
//   POST /home/<token>/upload   upload a Letterboxd export ZIP

const MIN_TOKEN_LENGTH = 32;
/** Letterboxd exports are tens of KB; anything this big isn't one. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DATASET_KEY = "dataset";
/** The dataset before the most recent page upload, in case an upload goes wrong. */
const PREVIOUS_DATASET_KEY = "dataset:previous";

const notFound = () => new Response(null, { status: 404 });
const notAllowed = (allow: string) => new Response(null, { status: 405, headers: { allow } });

/**
 * Constant-time compare, per Cloudflare's guidance: hash both values to a fixed
 * size first so neither content nor length leaks through timing.
 */
async function secretEquals(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  // Workers runtime has crypto.subtle.timingSafeEqual; Node (unit tests) does not.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The page URL carries the secret, so it must never leak via Referer, caches or search engines. */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src https://image.tmdb.org; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless server: no server-initiated SSE stream (a GET would otherwise hang open forever)
  // and no sessions to DELETE. Clients treat 405 on GET as "no stream".
  if (request.method !== "POST") return notAllowed("POST");
  const data = await env.LETTERBOXD.get<Dataset>(DATASET_KEY, "json");
  const server = buildServer(data, kvMemoryStore(env.LETTERBOXD));
  // Stateless: a fresh server + transport per request, plain JSON responses.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function handlePage(request: Request, env: Env, ctx: ExecutionContext | undefined, base: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notAllowed("GET, HEAD");
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const diaryPage = Number(params.get("page")) || 1;
  const [data, memory, posterCache] = await Promise.all([
    env.LETTERBOXD.get<Dataset>(DATASET_KEY, "json"),
    kvMemoryStore(env.LETTERBOXD).load(),
    env.TMDB_TOKEN ? env.LETTERBOXD.get<PosterCache>(POSTERS_KEY, "json") : null,
  ]);

  // Posters only when a TMDB token is set; lookups are cached in KV after the response.
  let posters: Posters | undefined;
  if (env.TMDB_TOKEN && request.method === "GET") {
    const r = await resolvePosters(filmsShown(data, memory, diaryPage), posterCache ?? {}, env.TMDB_TOKEN, new Date());
    posters = r.posters;
    if (r.changed) {
      const save = env.LETTERBOXD.put(POSTERS_KEY, JSON.stringify(r.cache));
      if (ctx) ctx.waitUntil(save);
      else await save;
    }
  }

  const html = renderPage(data, memory, {
    uploadAction: `${base}/upload`,
    status: isUploadStatus(status) ? status : null,
    timeZone: typeof request.cf?.timezone === "string" ? request.cf.timezone : undefined,
    diaryPage,
    posters,
  });
  return new Response(request.method === "HEAD" ? null : html, { headers: PAGE_HEADERS });
}

async function handleUpload(request: Request, env: Env, base: string): Promise<Response> {
  if (request.method !== "POST") return notAllowed("POST");
  const back = (status: UploadStatus) =>
    new Response(null, { status: 303, headers: { location: `${base}?status=${status}`, "referrer-policy": "no-referrer" } });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return back("too-big");

  let file: File | null = null;
  try {
    const form = await request.formData();
    const entry = form.get("export");
    file = entry instanceof File && entry.size > 0 ? entry : null;
  } catch {
    return back("no-file");
  }
  if (!file) return back("no-file");
  if (file.size > MAX_UPLOAD_BYTES) return back("too-big");

  let dataset: Dataset;
  try {
    const files = filesFromZip(new Uint8Array(await file.arrayBuffer()));
    try {
      dataset = buildDataset(files, new Date().toISOString());
    } catch {
      return back("not-export");
    }
  } catch {
    return back("bad-zip");
  }

  const previous = await env.LETTERBOXD.get(DATASET_KEY);
  if (previous !== null) await env.LETTERBOXD.put(PREVIOUS_DATASET_KEY, previous);
  await env.LETTERBOXD.put(DATASET_KEY, JSON.stringify(dataset));
  return back("ok");
}

const ROUTE = /^\/(mcp|home)\/([^/]+)(\/upload)?$/;

export default {
  // ctx is optional only so unit tests can call fetch(request, env).
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const token = env.MCP_TOKEN;
    // Fail closed: no (or a weak) secret means nothing is served at all.
    if (!token || token.length < MIN_TOKEN_LENGTH) return notFound();

    const match = ROUTE.exec(new URL(request.url).pathname);
    if (!match) return notFound();
    const [, area, provided, upload] = match;
    if (!(await secretEquals(provided, token))) return notFound();

    if (area === "mcp") return upload ? notFound() : handleMcp(request, env);
    const base = `/home/${token}`;
    return upload ? handleUpload(request, env, base) : handlePage(request, env, ctx, base);
  },
} satisfies ExportedHandler<Env>;
