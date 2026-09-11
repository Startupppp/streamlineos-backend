FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim AS run
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# The schema stores 1388 timestamps without a time zone. The driver reads them back
# with a bare `new Date(text)`, so the process must agree with the database session,
# which src/db/pool.config.ts pins to UTC. Do not remove one without the other.
ENV TZ=UTC
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
EXPOSE 1500
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 1500}/health/ready`).then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
USER node
CMD ["node", "dist/main.js"]
