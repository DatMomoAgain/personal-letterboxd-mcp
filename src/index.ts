import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildDataset } from "./dataset.ts";
import { filesFromZip } from "./exportZip.ts";
import fontLatinExt from "./fonts/font-latin-ext.woff2";
import fontLatin from "./fonts/font-latin.woff2";
import { kvMemoryStore } from "./memory.ts";
import { filmsShown, isUploadStatus, pickIdsShown, renderPage, type UploadStatus } from "./page.ts";
import { type PosterCache, type Posters, POSTERS_KEY, resolvePosters } from "./posters.ts";
import { type Ratings, type RatingsCache, RATINGS_KEY, resolveRatings } from "./ratings.ts";
import { buildServer } from "./server.ts";
import type { Dataset } from "./types.ts";

// `Env` comes from worker-configuration.d.ts — regenerate with `npx wrangler types`.
// MCP_TOKEN (64 hex chars) is a secret: `wrangler secret put MCP_TOKEN`.
//
// Routes (everything else is 404):
//   POST /mcp/<token>           MCP endpoint (the claude.ai connector)
//   GET  /home/<token>          personal page
//   POST /home/<token>/upload   upload a Letterboxd export ZIP
//   GET  /home/<token>/font-*.woff2   the page's display font

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

/**
 * The page URL carries the secret, so it must never leak via Referer, caches or search engines.
 * The only script allowed to run is the page's own inline one (it carries this request's nonce),
 * and nothing on the page may connect anywhere, so the URL can't be sent off by a script either.
 */
const pageHeaders = (nonce: string) => ({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src 'self'; img-src https://image.tmdb.org; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
});

/** The page's display font (Big Shoulders, SIL Open Font License), served under the secret path. */
const FONTS: Record<string, ArrayBuffer> = { "/font-latin.woff2": fontLatin, "/font-latin-ext.woff2": fontLatinExt };

function handleFont(request: Request, file: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return notAllowed("GET, HEAD");
  return new Response(request.method === "HEAD" ? null : FONTS[file], {
    headers: {
      "content-type": "font/woff2",
      "cache-control": "private, max-age=31536000, immutable",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Stateless server: no server-initiated SSE stream (a GET would otherwise hang open forever)
  // and no sessions to DELETE. Clients treat 405 on GET as "no stream".
  if (request.method !== "POST") return notAllowed("POST");
  const data = await env.LETTERBOXD.get<Dataset>(DATASET_KEY, "json");
  const server = buildServer(data, kvMemoryStore(env.LETTERBOXD), { tmdbToken: env.TMDB_TOKEN, omdbKey: env.OMDB_KEY });
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
  const isGet = request.method === "GET";
  const [data, memory, posterCache, ratingsCache] = await Promise.all([
    env.LETTERBOXD.get<Dataset>(DATASET_KEY, "json"),
    kvMemoryStore(env.LETTERBOXD).load(),
    env.TMDB_TOKEN && isGet ? env.LETTERBOXD.get<PosterCache>(POSTERS_KEY, "json") : null,
    env.OMDB_KEY && isGet ? env.LETTERBOXD.get<RatingsCache>(RATINGS_KEY, "json") : null,
  ]);

  // New lookups are saved to KV after the response is sent.
  const save = async (key: string, value: unknown) => {
    const put = env.LETTERBOXD.put(key, JSON.stringify(value));
    if (ctx) ctx.waitUntil(put);
    else await put;
  };
  const now = new Date();

  // Posters only when a TMDB token is set, scores only when an OMDb key is set.
  const [p, r] = await Promise.all([
    env.TMDB_TOKEN && isGet ? resolvePosters(filmsShown(data, memory), posterCache ?? {}, env.TMDB_TOKEN, now) : null,
    env.OMDB_KEY && isGet ? resolveRatings(pickIdsShown(data, memory), ratingsCache ?? {}, env.OMDB_KEY, now) : null,
  ]);
  if (p?.changed) await save(POSTERS_KEY, p.cache);
  if (r?.changed) await save(RATINGS_KEY, r.cache);
  const posters: Posters | undefined = p?.posters;
  const ratings: Ratings | undefined = r?.ratings;

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = renderPage(data, memory, {
    uploadAction: `${base}/upload`,
    status: isUploadStatus(status) ? status : null,
    timeZone: typeof request.cf?.timezone === "string" ? request.cf.timezone : undefined,
    posters,
    ratings,
    nonce,
    fontBase: base,
  });
  return new Response(request.method === "HEAD" ? null : html, { headers: pageHeaders(nonce) });
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

const ROUTE = /^\/(mcp|home)\/([^/]+)(\/upload|\/font-latin\.woff2|\/font-latin-ext\.woff2)?$/;

export default {
  // ctx is optional only so unit tests can call fetch(request, env).
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const token = env.MCP_TOKEN;
    // Fail closed: no (or a weak) secret means nothing is served at all.
    if (!token || token.length < MIN_TOKEN_LENGTH) return notFound();

    const match = ROUTE.exec(new URL(request.url).pathname);
    if (!match) return notFound();
    const [, area, provided, sub] = match;
    if (!(await secretEquals(provided, token))) return notFound();

    if (area === "mcp") return sub ? notFound() : handleMcp(request, env);
    const base = `/home/${token}`;
    if (sub === "/upload") return handleUpload(request, env, base);
    return sub ? handleFont(request, sub) : handlePage(request, env, ctx, base);
  },
} satisfies ExportedHandler<Env>;
