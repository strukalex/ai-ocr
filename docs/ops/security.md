## At-Rest Encryption Checklist

- Storage: MinIO uploads must use SSE (AES-256) by default. Verify `x-amz-server-side-encryption=AES256` on objects (see `packages/storage/src/lib/storage.service.ts`).
- Configuration: Set `MINIO_ENFORCE_SSE=true` (default) and optionally `MINIO_SSE_ALGORITHM=AES256|aws:kms` to align with environment controls; keep `REQUIRE_AT_REST_ENCRYPTION=true` in API config to prevent accidental disablement.
- Database: Use Postgres encryption at rest (e.g., volume encryption or TDE where supported). Document the enabled mechanism per environment and ensure credentials/secrets are managed via KMS/secret store. Set `DB_AT_REST_ENCRYPTED=true` (or `DATABASE_ENCRYPTION_ENABLED=true`) in encrypted environments; API startup will block if `REQUIRE_AT_REST_ENCRYPTION` is true and this flag is missing (except in `NODE_ENV=test`).
- Verification: CI/ops smoke test should upload an object and assert SSE headers; environment readiness checklist must capture DB encryption evidence before promotion (e.g., cloud disk encryption flag, KMS key id, TDE status). Add a migration/ops checklist item to confirm `DB_AT_REST_ENCRYPTED` is set in production/staging.
