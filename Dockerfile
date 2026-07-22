FROM node:22-alpine

WORKDIR /app

# pnpm-workspace.yaml must be copied alongside the manifests, before install: its
# `allowBuilds` allowlist for `esbuild` is what lets pnpm run esbuild's native
# postinstall build. Without it here, pnpm silently skips that build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

EXPOSE 3000

# Single-stage on purpose: the deploy migrate step runs `pnpm db:migrate`
# (tsx src/migrate.ts) against this same image, so devDependencies and src/
# must stay in the final image — do not slim this to a prod-deps-only stage.
CMD ["node", "dist/index.js"]
