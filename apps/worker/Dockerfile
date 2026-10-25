# Built from apps/worker/dist (see build.mjs).
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "server.js"]
