# Built from apps/worker/dist (see build.mjs).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin the agent runtime; OPENCODE_API_KEY is supplied by the runtime secret.
RUN npm install -g --no-audit --no-fund opencode-ai@1.19.5

WORKDIR /app
ENV NODE_ENV=production \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    REVIEW_ENGINE=opencode
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "server.js"]
