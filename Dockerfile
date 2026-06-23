FROM node:20-bookworm-slim

# The sqlite3 package may need to build its native addon, so include build tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached unless package files change.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# App code.
COPY server.js ./
COPY public ./public

# The database lives under /data so it can be a mounted volume that survives restarts.
ENV PORT=3000
ENV DB_PATH=/data/squares.db
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
