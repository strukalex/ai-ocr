# SETUP

pnpm nx serve api
pnpm nx serve ingestion-worker
docker compose -f ops/compose.dev.yml up -d postgres redis minio keycloak minio-init

Generate Prisma client
pnpm nx run shared-types:build
pnpm nx run api:prisma-generate
npx prisma migrate reset
pnpm prisma db push

npx prisma studio

# RESET
reset:env


# Phase 2 tryouts

API=http://localhost:3000/api
REQUIRE_TLS=false

curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInByZWZlcnJlZF91c2VybmFtZSI6ImFkbWluIiwicm9sZXMiOlsib3BlcmF0b3IiLCJhZG1pbiJdLCJpYXQiOjE3NjU0OTU5ODgsImV4cCI6MTc2NTQ5OTU4OH0.EJGsNS1zyQ0Ycc1Ttrwd_TEmEg81JNM9_J21n8l-EX0

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

## Invoice test (classifies by file name)

cat <<EOF | curl -k -X POST "$API/documents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @-
{
  "sourceChannel": "upload",
  "originalUri": "file://sampleDocs/invoice.png",
  "filename": "$(basename "sampleDocs/invoice.png")",
  "checksum": "$(sha256sum "sampleDocs/invoice.png" | cut -d' ' -f1)",
  "idempotencyKey": "idem-$(sha256sum "sampleDocs/invoice.png" | cut -d' ' -f1)",
  "metadata": {
    "rawContentBase64": "$(base64 -w0 "sampleDocs/invoice.png")"
  }
}
EOF