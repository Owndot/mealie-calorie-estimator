FROM scratch AS license
COPY LICENSE /LICENSE
COPY NOTICE /NOTICE

FROM cgr.dev/chainguard/wolfi-base AS builder
USER root
RUN apk add --no-cache nodejs-22 npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM builder AS test
COPY vitest.config.ts ./
COPY tests ./tests
RUN npm run typecheck && npm test

FROM cgr.dev/chainguard/wolfi-base AS runner
USER root
RUN apk add --no-cache nodejs-22 npm
WORKDIR /app
COPY --from=license / /
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data && \
    adduser -D -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["node", "dist/index.js"]
