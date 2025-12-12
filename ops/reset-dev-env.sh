#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/compose.dev.yml"
PRISMA_SCHEMA="$REPO_ROOT/packages/database/prisma/schema.prisma"

echo "Bringing down dev services and removing data volumes..."
docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans

echo "Starting fresh containers..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis minio minio-init keycloak

echo "Waiting for Postgres to become ready..."
for _ in {1..30}; do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U postgres -d ai_ocr >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Applying Prisma schema to reset database..."
if command -v pnpm >/dev/null 2>&1; then
  pnpm exec prisma db push --skip-generate --schema "$PRISMA_SCHEMA"
else
  npx prisma db push --skip-generate --schema "$PRISMA_SCHEMA"
fi

echo "Flushing Redis..."
docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli FLUSHALL

echo "Reset complete."
