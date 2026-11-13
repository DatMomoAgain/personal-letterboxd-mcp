// Secrets not listed in .dev.vars, so `wrangler types` doesn't generate them.
// Optional: without it the page simply shows no posters.
interface Env {
  /** TMDB "API Read Access Token" (v4 bearer). `wrangler secret put TMDB_TOKEN` */
  TMDB_TOKEN?: string;
}
