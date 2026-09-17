FROM scratch AS license
COPY LICENSE /LICENSE
COPY NOTICE /NOTICE

FROM cgr.dev/chainguard/wolfi-base AS builder
USER root
RUN apk add --no-cache nodejs-22 npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm install @rolldown/binding-linux-x64-gnu --no-save
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM cgr.dev/chainguard/wolfi-base AS runner
USER root
RUN apk add --no-cache nodejs-22 npm
WORKDIR /app
COPY --from=license / /
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install @rolldown/binding-linux-x64-gnu --no-save
COPY --from=builder /app/dist ./dist
COPY resources ./resources
RUN mkdir -p /app/data && \
    adduser -D -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
# TEMPORARY — benchmark revision only, never merged to main. Starts the normal server so the
# deployment health check behaves as usual, then runs the READ-ONLY PR D benchmark against a
# THROWAWAY cache file so the production cache is untouched.
CMD ["sh", "-c", "node dist/index.js & SERVER=$!; sleep 8; CACHE_DB_PATH=/tmp/bench-prd-cache.db node dist/bench/prd-run.js 2>&1 || echo BENCH-FAILED; wait $SERVER"]
