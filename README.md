pnpm nx serve api
pnpm nx serve ingestion-worker
docker compose -f ops/compose.dev.yml up -d postgres redis minio keycloak minio-init

Generate Prisma client
pnpm nx run shared-types:build
pnpm nx run api:prisma-generate

npx prisma migrate reset
pnpm prisma db push

npx prisma studio


==

API=https://localhost:3000/api
REQUIRE_TLS=false

TOKEN=...

FILE=sampleDocs/sample1.pdf
CHECKSUM=$(sha256sum "$FILE" | cut -d' ' -f1)
BASE64=$(base64 -w0 "$FILE")


cat <<EOF | curl -k -X POST "$API/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @-
{
  "sourceChannel": "upload",
  "originalUri": "file://$FILE",
  "filename": "$(basename "$FILE")",
  "checksum": "$CHECKSUM",
  "idempotencyKey": "idem-$CHECKSUM",
  "metadata": {
    "rawContentBase64": "$BASE64"
  }
}
EOF