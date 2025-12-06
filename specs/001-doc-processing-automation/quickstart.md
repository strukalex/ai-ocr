# Quickstart (Planning)

## Prereqs

- Docker/Docker Compose available; kubectl/helm for deployment targets.
- Node 18+, pnpm; ensure `nx` CLI available (`pnpm dlx nx --version`).
- Local services: PostgreSQL, Redis, MinIO; Keycloak for SSO (or dev fallback).

## Setup

1. Install deps:
   - `cd /home/lex/GitHub/ai-ocr && pnpm install`
2. Start infra locally (example compose):
   - `docker compose -f ops/compose.dev.yml up -d postgres redis minio keycloak`
3. Generate Prisma client and shared types:
   - `pnpm nx run shared-types:build`
   - `pnpm nx run api:prisma-generate`
4. Seed base data (profiles, roles, sample template):
   - `pnpm nx run api:seed`

## Run services

- API + queues producer: `pnpm nx serve api`
- Workers (BullMQ consumers): `pnpm nx run-many --target=serve --projects=workers-intake,workers-classify,workers-ocr,workers-extract,workers-enrich-pre,workers-validate-review,workers-enrich-post,workers-export`
- Web validation UI: `pnpm nx serve web`
- Admin console: `pnpm nx serve admin`

## Dev notes

- Use TanStack Query hooks for all server data; avoid manual `fetch`.
- Mantine native props only; embed Label Studio for validation surface.
- Locks stored in Redis with TTL + heartbeat; server enforces single active lock.
- Webhooks: configure subscription endpoints under `/contracts/pipeline.yaml` and test via `/webhooks/test`.

## Tests

- Backend unit/integration: `pnpm nx run api:test` (uses testcontainers for Postgres/Redis/MinIO).
- Frontend: `pnpm nx run web:test` (RTL) and `pnpm nx run web:e2e` (Playwright).
- Coverage gate 80% enforced in CI.

