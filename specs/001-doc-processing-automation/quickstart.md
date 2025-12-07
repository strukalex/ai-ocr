# Quickstart (Planning)

## Prereqs

- Docker/Docker Compose available; kubectl/helm for deployment targets.
- Node 24+, pnpm; ensure `nx` CLI available (`pnpm dlx nx --version`).
- Local services: PostgreSQL, Redis, MinIO; Keycloak for SSO; Ghostscript (v9.50+) installed on host.

## Setup

1. Configure environment:
   - `cp .env.example .env`
2. Install deps:
   - `cd <project-root> && pnpm install`
3. Start infra locally (example compose):
   - `docker compose -f ops/compose.dev.yml up -d postgres redis minio keycloak`
4. Generate Prisma client and shared types:
   - `pnpm nx run shared-types:build`
   - `pnpm nx run api:prisma-generate`
5. Seed base data (profiles, roles, sample template):
   - `pnpm nx run api:seed`
   - *Note: If using local Keycloak, ensure `realm-export.json` is imported or configured.*

## Run services

- API + queues producer: `pnpm nx serve api`
- Workers (BullMQ consumers): `pnpm nx run-many --target=serve --projects=ingestion-worker,processing-worker,enrichment-worker,export-worker`
- Web validation UI: `pnpm nx serve web` (http://localhost:4200)
- Admin console: `pnpm nx serve admin`

## Dev notes

- Use TanStack Query hooks for all server data; avoid manual `fetch`.
- Mantine native props only; embed Label Studio with custom plugin integration for validation.
- Locks stored in Redis with TTL + heartbeat; server enforces single active lock.
- Webhooks: configure subscription endpoints under `/contracts/pipeline.yaml` and test via `/webhooks/test`.

## Tests

- Backend unit/integration: `pnpm nx run api:test` (uses testcontainers for Postgres/Redis/MinIO).
- Frontend: `pnpm nx run web:test` (RTL) and `pnpm nx run web:e2e` (Playwright).
- Coverage gate 80% enforced in CI.
