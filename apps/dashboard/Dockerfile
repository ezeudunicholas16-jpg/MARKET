FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@10.12.1

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/analysis-engine/package.json packages/analysis-engine/package.json
COPY packages/compliance/package.json packages/compliance/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/data-providers/package.json packages/data-providers/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/telegram/package.json packages/telegram/package.json
COPY prisma/schema.prisma prisma/schema.prisma
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @market-desk/dashboard build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@market-desk/dashboard", "start"]
