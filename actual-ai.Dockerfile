FROM node:22-bookworm AS deps

RUN apt-get update \
    && apt-get install -y git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY .yarn ./.yarn
COPY yarn.lock package.json .yarnrc.yml tsconfig.json lage.config.js ./
COPY actual-ai/package.json actual-ai/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/component-library/package.json packages/component-library/package.json
COPY packages/crdt/package.json packages/crdt/package.json
COPY packages/desktop-client/package.json packages/desktop-client/package.json
COPY packages/desktop-electron/package.json packages/desktop-electron/package.json
COPY packages/eslint-plugin-actual/package.json packages/eslint-plugin-actual/package.json
COPY packages/loot-core/package.json packages/loot-core/package.json
COPY packages/plugins-service/package.json packages/plugins-service/package.json
COPY packages/sync-server/package.json packages/sync-server/package.json

RUN yarn install

FROM deps AS builder

WORKDIR /app

COPY packages/ ./packages/
COPY actual-ai/ ./actual-ai/

ENV NODE_OPTIONS=--max_old_space_size=8192

RUN yarn workspace @actual-app/crdt build
RUN yarn workspace @actual-app/core build
RUN yarn workspace @actual-app/api build
RUN yarn workspace @sakowicz/actual-ai build

RUN yarn workspaces focus @sakowicz/actual-ai --production

RUN cp -RL node_modules node_modules.real \
    && rm -rf node_modules \
    && mv node_modules.real node_modules

RUN find node_modules/@actual-app -maxdepth 2 -type d \
    \( -name src -o -name e2e -o -name __tests__ -o -name __mocks__ -o -name tests -o -name test -o -name build-stats \) \
    -exec rm -rf {} +

FROM node:22-bookworm-slim AS prod

RUN apt-get update \
    && apt-get install -y tini \
    && rm -rf /var/lib/apt/lists/*

ARG USERNAME=actual
ARG USER_UID=1001
ARG USER_GID=$USER_UID
RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME

ENV NODE_ENV=production

WORKDIR /app/actual-ai

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/actual-ai/dist ./dist
COPY --from=builder /app/actual-ai/src/templates ./src/templates

USER ${USERNAME}

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/app.js"]
