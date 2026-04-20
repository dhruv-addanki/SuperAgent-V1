FROM node:22-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY tsconfig.json eslint.config.js .prettierrc ./
COPY src ./src
RUN pnpm prisma:generate
RUN pnpm build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/app/server.js"]
