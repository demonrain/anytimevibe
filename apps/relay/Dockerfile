FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/relay/package.json apps/relay/package.json
RUN pnpm install --frozen-lockfile --filter @anytimevibe/relay... --prod=false
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN pnpm --filter @anytimevibe/protocol build && pnpm --filter @anytimevibe/relay build
ENV NODE_ENV=production
CMD ["node", "apps/relay/dist/index.js"]
