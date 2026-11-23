# Runs this server without a Cloudflare account, on workerd (Cloudflare's open-source Workers
# runtime) through `wrangler dev`. Data is kept in /data; mount a volume there.
# How to build and run it: README, "Without Cloudflare".
FROM node:22-slim

# workerd checks TLS against the system certificate store (for the TMDB and OMDb calls).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir /app /data && chown node:node /app /data
USER node
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .

# Pass MCP_TOKEN, TMDB_TOKEN and OMDB_KEY to the Worker from the container's environment.
ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true WRANGLER_SEND_METRICS=false
VOLUME /data
EXPOSE 8787
CMD ["node_modules/.bin/wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--persist-to", "/data", "--show-interactive-dev-session=false"]
