# Build context = repo root (see docker-compose.yml) — the npm workspace
# lockfile lives there, not in server/.
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --ignore-scripts

COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src

RUN npm run build --workspace=@impri/server

# ---- runtime ----
FROM node:22-alpine

WORKDIR /app

# argon2 + better-sqlite3 are native; build tools cover cases where no
# musl prebuilt binary exists for the current arch
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev

COPY --from=builder /app/server/dist ./server/dist

EXPOSE 8484

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8484

CMD ["node", "server/dist/index.js"]
