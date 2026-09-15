# ---- build stage ----
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public

# Optional Sentry error reporting — baked in at build time (Vite env vars),
# no-op when unset. See docker-compose.yml (build.args) / deploy/.env.example.
ARG VITE_SENTRY_DSN=
ARG VITE_SENTRY_ENVIRONMENT=self-hosted
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT

RUN npm run build

# ---- runtime: nginx ----
FROM nginx:1.27-alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx config: SPA fallback + /v1 reverse proxy to server service
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
