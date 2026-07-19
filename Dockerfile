FROM node:22-alpine

# @tsteil/push-service is installed as a git dependency; pnpm clones it and runs
# its `prepare` build during `pnpm install`. Alpine ships no git by default, and
# this step needs network egress to github.com at build time.
RUN apk add --no-cache git

WORKDIR /app

# pnpm-workspace.yaml must be copied alongside the manifests, before install:
# its `allowBuilds` allowlist for `@tsteil/push-service` + `esbuild` is what lets
# pnpm run the git-dep's `prepare` build and native postinstalls. Without it here,
# pnpm silently skips both and the engine's dist/ never gets built.
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
