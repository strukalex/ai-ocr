## At-Rest Encryption Checklist

- Storage: MinIO uploads must use SSE (AES-256) by default. Verify `x-amz-server-side-encryption=AES256` on objects (see `packages/storage/src/lib/storage.service.ts`).
- Database: Use Postgres encryption at rest (e.g., volume encryption or TDE where supported). Document the enabled mechanism per environment and ensure credentials/secrets are managed via KMS/secret store.
- Verification: CI/ops smoke test should upload an object and assert SSE headers; environment readiness checklist must capture DB encryption evidence before promotion.
