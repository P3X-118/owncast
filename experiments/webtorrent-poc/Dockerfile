# Chunk-seeder companion image (Node). Watches okast's HLS output (shared
# volume) and seeds each segment as a WebTorrent with the origin as WebSeed.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY seeder.js ./
COPY public ./public
EXPOSE 8088
USER node
CMD ["node", "seeder.js"]
