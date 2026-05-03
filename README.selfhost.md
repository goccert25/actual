# Self-Hosting This Fork

This file documents the simplest way to run this fork of Actual from local
source while keeping the data portable between machines.

## Files

- Compose file: [docker-compose.selfhost.yml](./docker-compose.selfhost.yml)
- Env template: [\.env.selfhost.example](./.env.selfhost.example)
- Actual AI env template: [\.env.actual-ai.example](./.env.actual-ai.example)
- Image build: [sync-server.Dockerfile](./sync-server.Dockerfile)

## One-Time Setup

1. Copy the env template:

```bash
cp .env.selfhost.example .env.selfhost
```

2. Edit `.env.selfhost` and set:

```env
ACTUAL_HOST_DATA_DIR=./actual-data
ACTUAL_BIND_PORT=5006
ACTUAL_IMAGE_NAME=actual-local:dev
ACTUAL_LOGIN_METHOD=password
```

`./actual-data` is intentionally outside git tracking and is where all server
state and budget data will live.

## Start The Server

Build and start the container:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up --build -d
```

Open Actual at:

```text
http://localhost:5006
```

## Enable Actual AI

`actual-ai` is wired in as an optional sidecar service behind the `ai` compose
profile. It is not started unless you explicitly enable that profile.

In this fork, `actual-ai` is built from the vendored source in
[`actual-ai/`](./actual-ai) instead of pulling the published Docker Hub image.
That keeps it pinned to this repo's local `@actual-app/api` and avoids budget
schema drift when this fork adds newer migrations.

1. Copy the AI env template:

```bash
cp .env.actual-ai.example .env.actual-ai
```

2. Edit `.env.actual-ai` and set at least:

```env
ACTUAL_PASSWORD=your_actual_password
ACTUAL_BUDGET_ID=your_budget_sync_id
OPENAI_API_KEY=your_openai_api_key
```

Notes:

- `ACTUAL_BUDGET_ID` is the Sync ID from Actual: `Settings -> Show advanced settings -> Sync ID`
- `FEATURES` defaults to safe `dryRun` mode. Nothing will be modified until you
  remove `"dryRun"` from the list.
- If your budget uses end-to-end encryption, also set `ACTUAL_E2E_PASSWORD`.

3. Start Actual with Actual AI enabled:

```bash
docker compose --env-file .env.selfhost --profile ai -f docker-compose.selfhost.yml up --build -d
```

This starts:

- `actual`
- `actual-ai` built from local source in this repo

If you want to keep running Actual without AI, omit `--profile ai`.

## Stop The Server

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml down
```

## Rebuild After Code Changes

Whenever this fork changes and you want the running server to pick up the new
code:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up --build -d
```

If you are running with Actual AI enabled:

```bash
docker compose --env-file .env.selfhost --profile ai -f docker-compose.selfhost.yml up --build -d
```

That rebuilds both the Actual server and the vendored `actual-ai` sidecar
against the current source tree, so the API schema and migration list stay in
lockstep.

## Where The Data Lives

All persistent data is stored in the host directory configured by
`ACTUAL_HOST_DATA_DIR`, which for this setup is:

```text
./actual-data
```

That directory contains the server metadata and budget files. Rebuilding the
container does not remove it.

## Moving To Another Machine

1. Stop the container on the current machine.
2. Copy the repo to the new machine.
3. Copy the entire `actual-data/` directory to the new machine.
4. Use the same `.env.selfhost` values on the new machine.
5. Run:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up --build -d
```

Notes:

- Do not copy the built Docker image from Mac to Raspberry Pi.
- Rebuild from source on the new machine instead.
- Copy the data directory, not just individual sqlite files.

## Useful Commands

Show logs:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml logs -f
```

Show logs with Actual AI enabled:

```bash
docker compose --env-file .env.selfhost --profile ai -f docker-compose.selfhost.yml logs -f
```

Show only Actual AI logs:

```bash
docker compose --env-file .env.selfhost --profile ai -f docker-compose.selfhost.yml logs -f actual-ai
```

Force a clean rebuild:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml build --no-cache
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d
```

## Backup Recommendation

Back up the entire `actual-data/` directory regularly. The simplest safe
workflow is:

1. Stop the container.
2. Copy or archive `actual-data/`.
3. Start the container again.

Hot-copying sqlite-backed app data can work, but a stopped backup is the least
risky option.
