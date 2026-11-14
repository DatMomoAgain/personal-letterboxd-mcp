// Secrets not listed in .dev.vars, so `wrangler types` doesn't generate them.
// Both optional: without them the page simply shows no posters / no scores.
interface Env {
  /** TMDB "API Read Access Token" (v4 bearer). `wrangler secret put TMDB_TOKEN` */
  TMDB_TOKEN?: string;
  /** OMDb API key, for IMDb / Rotten Tomatoes / Metacritic scores on picks. `wrangler secret put OMDB_KEY` */
  OMDB_KEY?: string;
}
