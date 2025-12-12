# Tasks: Intelligent Document Processing Platform

**Feature**: Document Processing Automation  
**Status**: Pending  
**Spec**: `specs/001-doc-processing-automation/spec.md`  
**Plan**: `specs/001-doc-processing-automation/plan.md`

## Phase 1: Foundation & Shared Contracts
**Goal**: Scaffolding the Nx workspace and strictly typed contracts.

- [X] T001 Initialize Nx workspace with NestJS and React presets
  - **Files**: `nx.json`, `package.json`
  - **Done**: `nx graph` shows empty workspace with correct presets.

- [X] T002 Create `@my-org/shared-types` library
  - **Files**: `packages/shared-types/src/index.ts`, `packages/shared-types/project.json`
  - **Done**: `nx build shared-types` passes.

- [X] T003 Implement Document Ingest DTOs with `class-validator`
  - **Files**: `packages/shared-types/src/lib/dtos/ingest.dto.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Unit tests verify `class-validator` rejects invalid payloads.

- [X] T004 Implement Document Status & Lifecycle DTOs
  - **Files**: `packages/shared-types/src/lib/dtos/lifecycle.dto.ts`, `packages/shared-types/src/lib/enums/status.enum.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Enum matches `spec.md` lifecycle states exactly.

- [X] T005 [P] Create `packages/database` library with Prisma ORM
  - **Files**: `packages/database/prisma/schema.prisma`, `packages/database/src/lib/database.module.ts`
  - **Dependencies**: `@prisma/client`, `prisma`
  - **Done**: `npx prisma db push` creates `Document` table in local Postgres and tests can query it.

- [X] T006 [P] Create `packages/queue` library with BullMQ configuration
  - **Files**: `packages/queue/src/lib/queue.module.ts`, `packages/queue/src/lib/queue.service.ts`
  - **Dependencies**: `@my-org/queue`
  - **Done**: Test connects to Redis and creates a queue.

- [X] T007 [P] Create `packages/storage` library with MinIO integration
  - **Files**: `packages/storage/src/lib/storage.module.ts`, `packages/storage/src/lib/storage.service.ts`
  - **Dependencies**: `@my-org/storage`
  - **Done**: Test uploads and retrieves a file from MinIO.

- [X] T008 [P] Create `packages/observability` library with OpenTelemetry
  - **Files**: `packages/observability/src/lib/tracing.module.ts`, `packages/observability/src/lib/logger.service.ts`
  - **Dependencies**: `@my-org/observability`
  - **Done**: Logs appear in stdout in JSON format with trace IDs.

- [X] T032 [P] Implement Auth DTOs & Guards (Shared)
  - **Files**: `packages/shared-types/src/lib/auth/*`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Auth interfaces and mock guards are defined.

- [X] T044 Implement Security Baseline (TLS, At-Rest Encryption, Session Timeout)
  - **Files**: `apps/api/src/config/security.config.ts`, `apps/api/src/app/security/security.module.ts`, `helm/values.yaml` (or equivalent runtime config)
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: TLS 1.2+ enforced, AES-256 at-rest config documented, 30m idle session timeout applied and tested.

- [X] T045 Implement Auth/Audit Logging for Authentication & Authorization Events
  - **Files**: `packages/observability/src/lib/audit-logger.ts`, `apps/api/src/app/auth/*`
  - **Dependencies**: `@my-org/observability`, `@my-org/shared-types`
  - **Done**: AuthN/AuthZ events emit audit logs with user, roles, outcome, trace id.

- [X] T098 [OBS] Add Bull Board dashboard for BullMQ
  - **Files**: `apps/api/src/app/queues/bull-board.module.ts`, `apps/api/src/app/app.module.ts`, `apps/api/src/app/auth/*`
  - **Dependencies**: `@bull-board/nestjs`, `@bull-board/api`, `@bull-board/express` (or `@bull-board/fastify` if adapter changes)
  - **Instructions**: Mount dashboard at `/admin/queues` in the main API using BullBoardModule with the correct adapter, reuse existing BullMQ/Redis config, and secure with RBAC/basic auth middleware per constitution (no public exposure; TLS for non-loopback access).
  - **Done**: Authenticated admins can view queues; unauthenticated/unauthorized access is blocked; smoke test hits `/admin/queues` and asserts guard enforcement.

## Phase 2: Ingestion & Storage Pipeline (Revised for TDD)
**Goal**: Reliable document upload and normalization defined by tests.

- [X] T009 [US1] Create `apps/api` NestJS application
  - **Files**: `apps/api/src/main.ts`, `apps/api/project.json`
  - **Done**: `nx serve api` starts on port 3000.

- [X] T010 [US1] **Create Integration Test for Ingestion Pipeline**
  - **Files**: `tests/integration/ingestion.spec.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Integration test now covers upload happy path, checksum dedupe, and failure handling (missing originals, checksum mismatch) with audit/log assertions; endpoint passes.

- [X] T063 [US1] Implement monitored storage watcher intake service
  - **Files**: `apps/ingest-watcher/src/main.ts`, `apps/ingest-watcher/src/app/watcher.service.ts`, `apps/ingest-watcher/project.json`
  - **Dependencies**: `@my-org/storage`, `@my-org/queue`, `chokidar` (or equivalent FS watcher/poller)
  - **Done**: Dropping a file into a configured local/S3/SMB path enqueues the same job as `POST /documents`, updates status to "Uploaded", and deduplicates by checksum to satisfy FR-001.

- [X] T077 [US1] Implement IntakeSource CRUD API & Service
  - **Files**: `apps/api/src/app/intake-sources/intake-sources.controller.ts`, `apps/api/src/app/intake-sources/intake-sources.service.ts`, `packages/database/prisma/schema.prisma` (IntakeSource entity)
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `@my-org/storage`
  - **Done**: REST endpoints for managing watched storage locations (local/S3/SMB paths) with validation and persistence; enables multi-channel intake configuration per FR-001.

- [X] T011 [US1] Implement `POST /documents` Endpoint
  - **Files**: `apps/api/src/app/documents/documents.controller.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/queue`, `@my-org/storage`, `@my-org/database`
  - **Done**: Integration test from T010 passes the "Upload" step (returns 201).

- [X] T012 [US1] Implement `intake` processor & Worker
  - **Files**: `apps/workers/ingestion-worker/src/main.ts`, `apps/workers/ingestion-worker/src/app/processors/intake.processor.ts`
  - **Dependencies**: `@my-org/queue`, `@my-org/storage`, `@my-org/database`
  - **Done**: Integration test from T010 passes the "DB Status Update" assertion.

- [X] T097 [US1][OBS] Preserve Originals & Canonical Artifacts with Checksums
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/intake.processor.ts`, `apps/workers/ingestion-worker/src/app/services/normalization.service.ts`, `packages/storage/src/lib/storage.service.ts`, `packages/observability/src/lib/audit-logger.ts`, `tests/integration/ingestion.spec.ts`
  - **Dependencies**: `@my-org/storage`, `@my-org/observability`, `@my-org/shared-types`
  - **Instructions**: Persist the uploaded source file immutably with checksum (e.g., SHA-256) and object-lock/write-once semantics where supported; generate canonical PDF/A-2b separately without overwriting the original; emit audit linking original + canonical artifact ids, checksums, and locations; enforce checksum dedupe before enqueue; validate both artifacts are accessible for downstream steps.
  - **Done**: Integration test uploads a JPG → original stored with checksum, canonical PDF/A created under a different key, audit log records both ids/checksums, and duplicate upload is deduped by checksum.

- [X] T089 [ARCH] Idempotency Keys & Backoff Profiles
  - **Files**: `packages/queue/src/lib/queue.service.ts`, `packages/queue/src/lib/retry.config.ts`, `apps/workers/*/src/app/processors/*.ts`
  - **Dependencies**: `@my-org/queue`
  - **Done**: All processors accept idempotency keys and use standardized exponential backoff/retry profiles; integration tests cover retry and idempotent behavior.

- [X] T069 [US1] Implement heuristic document splitter
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/split.processor.ts`
  - **Dependencies**: `pdf-lib` (or ghostscript), `@my-org/shared-types`
  - **Instructions**: Detect split points (e.g., separator sheet/barcode/new header), split PDFs into child artifacts, mark parent as "Split", and enqueue intake jobs for each child; ensure child documents inherit linkage to parent/root ids per data model.

- [X] T013 [US1] Implement PDF/A-2b normalization using Ghostscript
  - **Files**: `apps/workers/ingestion-worker/src/app/services/normalization.service.ts`
  - **Dependencies**: `ghostscript` CLI, `@my-org/storage`
  - **Done**: Uploaded JPG is converted to PDF/A-2b. **Check**: Verify Ghostscript is used; reject if any other PDF SDK is imported. NormalizationService invokes Ghostscript CLI for PDF/A-2b output and is wired into intake canonical artifact creation with unit tests.

- [X] T058 [US1] Implement OpenCV Preprocessing via Python Microservice (Deskew, Denoise, Binarization) — reworked to remove Node OpenCV bindings
  - **Files**: Python preprocessing microservice (FastAPI/Flask) using native OpenCV; `apps/workers/ingestion-worker/src/app/services/preprocessing.service.ts` (HTTP client/integration)
  - **Dependencies**: Python OpenCV system packages, Redis (pub/sub callback), MinIO SDK, `@my-org/storage` (no `opencv4nodejs`/`opencv-wasm` in NestJS workers)
  - **Instructions**: Deskew (Hough transform), noise reduction (Gaussian/bilateral filter), and adaptive binarization run inside the dedicated Python service. NestJS workers call it via HTTP/REST, receive async responses over Redis pub/sub, and exchange image artifacts through MinIO. Service scales independently from Node workers; do not vendor OpenCV bindings in Node.
  - **Done**: Integration test uploads a sample, ensures ingestion worker stores artifacts in MinIO, posts preprocessing request to the Python service, receives async response with correction angle + processed image within SLA, and asserts Node packages contain no OpenCV bindings. **Check**: Verify OpenCV runs in Python microservice per constitution; reject proprietary SDKs and Node OpenCV bindings.

- [X] T019 [US1] Implement `classify` processor with Tiered Strategy
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`
  - **Done**: Classifier supports LayoutLM/LLM calls based on config, falling back to simple keyword matching if configured.

- [X] T033 [US1] Implement Auth Module in API
  - **Files**: `apps/api/src/app/auth/*`
  - **Dependencies**: `@my-org/shared-types`, `keycloak-connect` (or similar)
  - **Done**: Endpoints are protected by Bearer token; 401 returned if missing.

- [X] T078 [US1] Implement /auth/login Endpoint & Worker Auth Consistency
  - **Files**: `apps/api/src/app/auth/auth.controller.ts`, `packages/shared-types/src/lib/auth/worker-auth.interface.ts`, `apps/workers/*/src/app/auth/*`
  - **Dependencies**: `@my-org/shared-types`, `keycloak-connect`, `@my-org/database`
  - **Done**: Login endpoint supports OIDC/bearer/password auth per OpenAPI; workers and webhooks use consistent service-to-service auth patterns matching FR-018 and constitution RBAC requirements.

- [X] T090 [SEC] Enforce At-Rest Encryption for Storage/DB
  - **Files**: `packages/storage/src/lib/storage.service.ts`, `apps/api/src/config/security.config.ts`, `docs/ops/security.md`
  - **Dependencies**: `@my-org/storage`
  - **Done**: MinIO uploads use SSE (AES-256) by default; DB encryption/TDE requirements documented and enabled per environment; tests/ops checklist verify encryption flags.

- [X] T091 [OBS][US1] Add trace_id JSON logging for ingestion
  - **Files**: `apps/api/src/main.ts`, `apps/api/src/app/telemetry/request-telemetry.interceptor.ts`, `apps/api/src/app/documents/*`, `packages/queue/src/lib/queue.service.ts`
  - **Dependencies**: `@my-org/observability`, `@my-org/queue`
  - **Done**: Ingestion endpoints and queue producers emit JSON logs with `trace_id`/`document_id` and structured fields per OBS-001; trace_id propagates to produced jobs.

- [X] T092 [OBS][US1] Contract test for ingestion log/trace shape
  - **Files**: `tests/contract/ingestion-telemetry.spec.ts`
  - **Dependencies**: `@my-org/observability`
  - **Done**: Test asserts response includes trace header and log sink receives JSON entry with required fields (timestamp, severity, service, trace_id, document_id, message).

- [X] T093 [US1] Corrections summary/report API (tracked, not enforced)
  - **Files**: `apps/api/src/app/learning/learning.controller.ts`, `apps/api/src/app/documents/corrections.controller.ts`, `apps/web/src/app/features/reports/corrections-report.tsx`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `packages/ml`
  - **Done**: Read-only backend endpoints surface correction counts and recurrence window with a “not enforced this cycle” flag; UI/reporting is deferred to the frontend phase.

## Phase 3: Intelligent Processing Core
**Goal**: Extraction, classification, and validation logic.

- [ ] T014 [US1] Create `apps/workers/processing-worker` application
  - **Files**: `apps/workers/processing-worker/src/main.ts`, `apps/workers/processing-worker/project.json`
  - **Dependencies**: `@my-org/queue`
  - **Done**: Worker starts and listens to `processing` queue.

- [ ] T015 [US1] Implement `OcrProvider` Strategy Interface
  - **Files**: `apps/workers/processing-worker/src/app/ocr/ocr-provider.interface.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Interface defines `process(file: Buffer): Promise<ExtractedData>`.

- [ ] T016 [P] [US1] Implement PaddleOCR Provider (Default)
  - **Files**: `apps/workers/processing-worker/src/app/ocr/paddle-ocr.provider.ts`
  - **Dependencies**: `axios` (call to sidecar) or direct integration
  - **Done**: Unit test mocks Docker response and returns typed text.

- [ ] T017 [P] [US1] Implement Azure DI Provider
  - **Files**: `apps/workers/processing-worker/src/app/ocr/azure-di.provider.ts`
  - **Dependencies**: `@azure/ai-form-recognizer`
  - **Done**: Integration test (skipped in CI) validates connection to Azure resource.

- [ ] T018 [US1] Implement `extract` processor with Strategy selection
  - **Files**: `apps/workers/processing-worker/src/app/processors/extract.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `apps/workers/processing-worker/src/app/ocr/*`, `@my-org/database`
  - **Done**: Processor calls correct provider based on config/flag and saves raw text to DB.

- [ ] T018a [US1] Add lightweight OCR preview for classification
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/intake.processor.ts`, `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, OCR preview helper (reuse PaddleOCR sidecar minimal page-1 call)
  - **Done**: Intake runs fast OCR on first page/canonical artifact, attaches text to classify job payload; classification prefers OCR text over filename/metadata, logs OCR snippet in audit metadata.

- [ ] T046a [US1] Pass OCR text into classifier providers
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`, `apps/workers/ingestion-worker/src/app/processors/classify/*.provider.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: LayoutLM/LLM/heuristic all consume OCR text when available; audit event includes provider tier and whether OCR text was used.

- [ ] T046b [US1] Update heuristic to prioritize OCR keywords
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Heuristic keyword detection runs on OCR text (not just filename/metadata) with OCR hits weighted higher; unknown/ambiguous thresholds unchanged.
- [ ] T094 [US1] Implement canonical normalization service for extracted values
  - **Files**: `apps/workers/processing-worker/src/app/services/normalization.service.ts`, `apps/workers/processing-worker/src/app/processors/extract.processor.ts`, `apps/workers/processing-worker/src/app/processors/enrich-pre.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`
  - **Done**: Dates normalized to ISO, currencies to USD equivalents, addresses standardized, and totals/taxes reconciled before validation/export; unit tests cover transformations and processors persist normalized values.

- [ ] T062 [P] [US6] Implement Template Matching Engine
  - **Files**: `packages/templates/src/lib/matcher.service.ts`
  - **Dependencies**: `@my-org/templates`, `@my-org/shared-types`
  - **Instructions**: Implement coordinate-to-text mapping, handle multi-page offsets, and partial-match scoring with fallback per FR-025/FR-031. Unit tests cover cross-page mapping and low-confidence fallback to flexible extraction.
  - **Done**: Given OCR text + template coordinates, service returns mapped fields with confidence and triggers fallback when match < threshold.

- [ ] T038 [US1] Update `processing-worker` for `enrich-pre`
  - **Files**: `apps/workers/processing-worker/src/app/processors/enrich-pre.processor.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Pre-validation lookups occur before validation step.

- [ ] T020 [US1] Create `packages/validation-rules` library
  - **Files**: `packages/validation-rules/src/lib/engine.service.ts`
  - **Dependencies**: `json-rules-engine`, `@my-org/shared-types`
  - **Done**: Unit test passes a sample fact object against a rule and returns success/failure.

- [ ] T021 [US1] Integrate validation engine into processing worker
  - **Files**: `apps/workers/processing-worker/src/app/processors/validate.processor.ts`
  - **Dependencies**: `@my-org/validation-rules`, `@my-org/database`
  - **Done**: Documents failing rules are updated in DB with "review" status.

- [ ] T073 [US3] Implement Correction Logging Service (No Auto-Retraining)
  - **Files**: `packages/ml/src/lib/correction-log.service.ts`, `apps/workers/processing-worker/src/app/processors/review.processor.ts`, `packages/database/prisma/schema.prisma`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`
  - **Instructions**: Persist corrections (document id, field id, before/after, rule/template versions, user, timestamp, confidence, reason) for future training; expose a typed service API; do not trigger MLflow/Temporal or model promotion in this cycle; emit audit events.
  - **Done**: Unit test covers persistence and retrieval; integration test confirms review flow writes correction records without invoking retraining.

- [ ] T080 [US1] Implement Learning APIs (Correction Summary & Retrain)
  - **Files**: `apps/api/src/app/learning/learning.controller.ts`, `apps/api/src/app/documents/corrections.controller.ts`, `packages/ml/src/lib/correction-summary.service.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `packages/ml`
  - **Done**: /documents/{id}/corrections, /learning/corrections-summary, and /learning/retrain endpoints provide read-only correction inspection and manual retrain triggering per FR-020; retrain endpoint is stubbed for this cycle per active learning deferral.

- [ ] T060 [US4] Implement Content-Based Routing Rules Engine
  - **Files**: `packages/validation-rules/src/lib/routing-engine.service.ts`, `apps/workers/processing-worker/src/app/processors/route.processor.ts`
  - **Dependencies**: `json-rules-engine`, `@my-org/shared-types`, `@my-org/database`
  - **Instructions**: Extend rules engine to support routing decisions based on extracted content values (e.g., invoice amount > $10k → senior-review queue). Rules are configurable via admin UI. Emit routing events for webhook consumers.
  - **Done**: Integration test verifies high-value document routes to configured queue; unit test covers rule evaluation with sample facts.

- [ ] T061 [US4] Implement External Verification Timeout Handling
  - **Files**: `apps/workers/processing-worker/src/app/processors/enrich-pre.processor.ts`, `packages/queue/src/lib/timeout.config.ts`
  - **Dependencies**: `@my-org/queue`, `@my-org/shared-types`
  - **Instructions**: External lookups must timeout after 30 seconds (per spec). On timeout, mark document "External System Unavailable", route to exception queue, and allow manual retry. Other documents must continue processing.
  - **Done**: Integration test simulates timeout and verifies exception routing + manual retry option.

- [ ] T046 [US1] Implement LayoutLM Classifier Provider (Structured High-Volume)
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify/layoutlm.provider.ts`
  - **Dependencies**: `@azure/layoutlm` (or chosen lib), `@my-org/shared-types`
  - **Done**: Provider returns typed classification with confidence; unit test covers sample layout.

- [ ] T047 [US1] Implement LLM Classifier Fallback for Unstructured Docs
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify/llm.provider.ts`
  - **Dependencies**: `openai` (or equivalent), `@my-org/shared-types`
  - **Done**: Provider handles freeform docs; test mocks API and returns typed class.

- [ ] T048 [US1] Runtime Classifier Selection & Tests
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`
  - **Dependencies**: `@my-org/database`, `@my-org/shared-types`
  - **Done**: Config flag selects OCR-only, LayoutLM, or LLM path; integration test covers switch.

- [ ] T075 [US1] Handle Unknown/Novel Document Types
  - **Files**: `apps/workers/ingestion-worker/src/app/processors/classify.processor.ts`, `apps/workers/ingestion-worker/src/app/processors/exception.processor.ts`, `packages/database/prisma/schema.prisma`
  - **Dependencies**: `@my-org/database`, `@my-org/shared-types`, `@my-org/queue`
  - **Instructions**: When classification confidence is low or no template match exists, route to an exception queue with reason "Unknown Type"; capture signals (top tokens, layout hints, checksum, reference to sample page) for future configuration; emit audit event and allow manual retry/resume once configured.
  - **Done**: Integration test covers unknown-type path; DB stores captured signals; audit/log entries emitted.

- [ ] T049 [US1] Webhook & Event Contract Tests with Retry/DLQ
  - **Files**: `tests/contract/webhooks.spec.ts`, `packages/queue/src/lib/retry.config.ts`
  - **Dependencies**: `@my-org/queue`, `@my-org/shared-types`
  - **Done**: Contract tests verify payload schema, retries, DLQ on exhaustion.

- [ ] T050 [US1] Submitter Notification Service (Failure/Ambiguity/Missing Pages)
  - **Files**: `apps/api/src/app/notifications/*`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: Templates exist; integration test covers unprocessable + missing pages path.

- [ ] T034 [US1] Create `apps/workers/enrichment-worker`
  - **Files**: `apps/workers/enrichment-worker/src/main.ts`, `apps/workers/enrichment-worker/project.json`
  - **Dependencies**: `@my-org/queue`
  - **Done**: Worker starts and listens to `enrichment` queue.

- [ ] T035 [US1] Implement `enrich-post` processor
  - **Files**: `apps/workers/enrichment-worker/src/app/processors/enrich-post.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`
  - **Done**: Processor updates document status to 'enriched' after validation.

- [ ] T036 [US1] Create `apps/workers/export-worker`
  - **Files**: `apps/workers/export-worker/src/main.ts`, `apps/workers/export-worker/project.json`
  - **Dependencies**: `@my-org/queue`
  - **Done**: Worker starts and listens to `export` queue.

- [ ] T037 [US1] Implement `export` processor
  - **Files**: `apps/workers/export-worker/src/app/processors/export.processor.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `axios`
  - **Done**: JSON payload is sent to a configured webhook URL.

- [ ] T070 [US1] Apply field categorization per FR-027 in extraction/enrichment flow
  - **Files**: `apps/workers/processing-worker/src/app/processors/extract.processor.ts`, `apps/workers/processing-worker/src/app/processors/enrich-pre.processor.ts`, `packages/templates/src/lib/matcher.service.ts` (or dedicated categorization helper)
  - **Dependencies**: `@my-org/shared-types`, `@my-org/templates`, configured model provider (e.g., `openai`) using TemplateField.categorization_config
  - **Instructions**: After mapping fields, apply category labels (e.g., vendor → "Medical Supplier") according to TemplateField config; persist categorized value alongside raw value and include in validation/enrichment facts.

## Phase 4: Human-in-the-Loop UI (Revised for Granularity)
**Goal**: Validation interface for human operators.

- [ ] T022 [US3] Create `apps/web` React application
  - **Files**: `apps/web/src/main.tsx`, `apps/web/project.json`
  - **Dependencies**: `@mantine/core`, `tanstack-query`
  - **Done**: `nx serve web` loads Mantine shell.

- [ ] T023 [US3] Setup `tanstack-query` provider and client
  - **Files**: `apps/web/src/app/providers.tsx`
  - **Done**: QueryClientProvider wraps the app.

- [ ] T024 [US3] Implement Label Studio Wrapper Component
  - **Files**: `apps/web/src/app/components/label-studio-wrapper.tsx`
  - **Dependencies**: `@heartexlabs/label-studio`
  - **Done**: Label Studio renders a mock image without errors.

- [ ] T025 [US3] Implement Split-Pane Validation Layout
  - **Files**: `apps/web/src/app/features/validation/validation-layout.tsx`
  - **Done**: Layout shows Label Studio on left, Sidebar on right.

- [ ] T026 [US3] Implement Keyboard Shortcuts Logic
  - **Files**: `apps/web/src/app/features/validation/hooks/use-shortcuts.ts`
  - **Dependencies**: `react-hotkeys-hook`
  - **Instructions**: Map `Ctrl+Enter` to Approve, `Ctrl+Backspace` to Reject.
  - **Done**: Key presses log distinct actions to console.

- [ ] T043 [US3] Implement Document Locking Service & API
  - **Files**: `apps/api/src/app/locking/locking.service.ts`, `apps/api/src/app/locking/locking.controller.ts`
  - **Dependencies**: `@my-org/shared-types`, `ioredis`
  - **Done**: Unit test verifies lock acquisition, expiration, and release.

- [ ] T027 [US3] Connect Shortcuts to API Mutations
  - **Files**: `apps/web/src/app/features/validation/validation-view.tsx`
  - **Done**: Key presses trigger actual API calls and refresh the document list.

- [ ] T028 [US3] Connect UI to API for document list and status
  - **Files**: `apps/web/src/app/api/documents.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database` (via API)
  - **Done**: List of uploaded documents appears in the grid.

- [ ] T059 [US4] Implement Pre-Export Review View (Combined Extracted + Supplemental Data)
  - **Files**: `apps/web/src/app/features/export-review/export-review-view.tsx`, `apps/web/src/app/features/export-review/components/combined-data-panel.tsx`
  - **Dependencies**: `@my-org/shared-types`, `@mantine/core`, `tanstack-query`
  - **Instructions**: Display side-by-side extracted fields and enrichment data before export approval. Include approve/reject actions with keyboard shortcuts (Ctrl+Shift+Enter to approve export, Ctrl+Shift+Backspace to reject).
  - **Done**: E2E test confirms user can review combined data and approve/reject export via keyboard.

- [ ] T029 [US3] Verify Accessibility & Keyboard Navigation
  - **Files**: `tests/e2e/accessibility.spec.ts`
  - **Done**: Verification ensures no mouse is required for core flows.

- [ ] T079 [US3] Implement Review/Audit/Export Inspection API Endpoints
  - **Files**: `apps/api/src/app/review/review.controller.ts`, `apps/api/src/app/documents/audit.controller.ts`, `apps/api/src/app/exports/exports.controller.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `@my-org/queue`
  - **Done**: /review/queue, /review/{documentId}, /documents/{id}/audit, /documents/{id}/export, and /exports/* endpoints provide queue inspection, audit trail access, and export job status per OpenAPI contracts.

- [ ] T039 [US3] Implement Login & RBAC in Web
  - **Files**: `apps/web/src/app/features/auth/*`
  - **Dependencies**: `react-oidc-context` (or similar)
  - **Done**: Unauthenticated user is redirected to login; Roles restrict view access.

- [ ] T071 [US1] Implement Classification Review UI for ambiguous documents
  - **Files**: `apps/web/src/app/features/classification-review/*`, `apps/api/src/app/documents/documents.controller.ts` (confirm/override endpoint)
  - **Dependencies**: `@my-org/shared-types`, `tanstack-query`, document list/queue endpoints
  - **Instructions**: Surface PendingReview items with ambiguous classifications; show candidate types/confidence; allow confirm/override; on submit, update to Classified and resume pipeline; include keyboard shortcuts and audit entry.

## Phase 5: Operator Control & Admin
**Goal**: Administration console for templates, profiles, and rules.

- [ ] T040 [US2] Create `apps/admin` React application
  - **Files**: `apps/admin/src/main.tsx`, `apps/admin/project.json`
  - **Done**: `nx serve admin` loads admin shell.

- [ ] T041 [US2] Implement Profile & Template Management UI
  - **Files**: `apps/admin/src/app/features/templates/*`, `apps/admin/src/app/features/profiles/*`
  - **Done**: Admin can create a new Template and toggle Processing Profiles.

- [ ] T081 [US2] Implement Processing Profiles & Rule Version API Controllers
  - **Files**: `apps/api/src/app/processing-profiles/processing-profiles.controller.ts`, `apps/api/src/app/rule-versions/rule-versions.controller.ts`, `packages/validation-rules/src/lib/rule-versioning.service.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `@my-org/templates`, `@my-org/validation-rules`
  - **Done**: /processing-profiles and /rule-versions* endpoints enable HTTP management of strategy profiles and versioned rules with promotion/rollback per OpenAPI contracts.

- [ ] T064 [US2] Add Reference PDF upload + bbox editor (normalize to %) in `apps/admin/src/app/features/templates/template-editor.tsx`
  - **Dependencies**: `apps/api/src/app/templates/template.controller.ts`
  - **Done**: Operator can upload a clean sample, draw boxes, and save draft coordinates.
  - **Notes**: Embed Label Studio (reuse `<LabelStudioWrapper />` from T024) in template-creation mode with XML config to allow rectangle labels + per-region key entry + data type choices (string/currency/date). Accept backend-provided reference image from uploaded PDF page; persist percent-based coords.

- [ ] T065 [US2] Persist draft TemplateVersion with match_policy and tolerances in `apps/api/src/app/templates/template.controller.ts`
  - **Dependencies**: `packages/templates/src/lib/versioning.service.ts`, `packages/database/prisma/schema.prisma`
  - **Done**: Draft saved with bbox JSON, match_policy (min_confidence, max_shift_px/max_rotation_deg, partial_match_action, fallback_extraction_enabled).
  - **Notes**: Transform Label Studio result JSON by matching rectangle regions to per-region key/data_type answers; store as TemplateField entries (type kv/table/mark) with normalized bbox percentages and mapping key.

- [ ] T052 [US2] Implement Versioned Template/Rule Registry with Rollback
  - **Files**: `packages/templates/src/lib/versioning.service.ts`, `packages/validation-rules/src/lib/versioning.service.ts`
  - **Dependencies**: `@my-org/templates`, `@my-org/validation-rules`, `@my-org/database`
  - **Done**: Versioned storage with rollback; migration includes downgrade path; tests cover rollback.

- [ ] T053 [US2] Admin UI for Version History & Rollback
  - **Files**: `apps/admin/src/app/features/templates/version-history.tsx`, `apps/admin/src/app/features/rules/version-history.tsx`
  - **Dependencies**: `@my-org/templates`, `@my-org/validation-rules`
  - **Done**: Admin can view versions, diff, and roll back; e2e test covers rollback flow.

- [ ] T086 [US6] Measure & Enforce Template Publish Latency
  - **Files**: `apps/admin/src/app/features/templates/publish-flow.tsx`, `packages/templates/src/lib/versioning.service.ts`, `tests/perf/template-publish.bench.ts`
  - **Dependencies**: `@my-org/templates`
  - **Done**: Publish flow measured end-to-end with p95 < 2 minutes; alerts/logs fire when SLA breached.

- [ ] T082 [US2] Implement Webhook Subscription Management API
  - **Files**: `apps/api/src/app/webhook-subscriptions/webhook-subscriptions.controller.ts`, `apps/api/src/app/webhook-subscriptions/webhook-subscriptions.service.ts`, `apps/api/src/app/webhook-deliveries/webhook-deliveries.controller.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`, `@my-org/queue`
  - **Done**: /webhook-subscriptions CRUD, delivery listing, and test-send endpoints with retry/DLQ handling per constitution webhook requirements and FR-016.

- [ ] T083 [US2] Implement Queue/DLQ Inspection & Remediation API
  - **Files**: `apps/api/src/app/queues/queues.controller.ts`, `apps/api/src/app/queues/queues.service.ts`, `packages/queue/src/lib/queue-inspection.service.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/queue`, `@my-org/observability`
  - **Done**: /queues/status and /queues/{queueName}/dlq endpoints enable queue health inspection, requeue, and purge operations for operator manual intervention per architecture requirements.

- [ ] T066 [US2] Publish TemplateVersion to live (single-live guarantee) in `apps/admin/src/app/features/templates/publish-flow.tsx`
  - **Dependencies**: `packages/templates/src/lib/versioning.service.ts`
  - **Done**: Publish marks version live (e.g., 1.2.0), sets rollback pointer, invalidates caches.

- [ ] T067 [US6] Load live TemplateVersion in extraction worker and overlay bboxes in `apps/workers/processing-worker/src/app/processors/extract.processor.ts`
  - **Dependencies**: `packages/templates/src/lib/matcher.service.ts`, `@my-org/database`
  - **Done**: Worker fetches live template by document type, overlays coords on OCR text, records TemplateVersion id in audit.
  - **Notes**: Use stored percent-based bbox to page-space mapping, align via matcher service, and ensure TemplateVersion association is logged.

- [ ] T068 [US6] Enforce match_policy drift/rotation thresholds and fallback-to-review in `apps/workers/processing-worker/src/app/processors/extract.processor.ts`
  - **Dependencies**: `packages/templates/src/lib/matcher.service.ts`
  - **Done**: If shift > max_shift_px or confidence < min_confidence, fallback to flexible extraction and flag Human Review.
  - **Notes**: Surface matchPolicy breach as reason; include TemplateVersion id and fallback path in audit/log.

- [ ] T084 [US2] Learning Toggle API & Schema
  - **Files**: `packages/database/prisma/schema.prisma`, `apps/api/src/app/learning/learning.controller.ts`
  - **Dependencies**: `@my-org/database`, `@my-org/shared-types`
  - **Done**: Operators can enable/disable learning per doc type/profile with staged rollout flag and rollback pointer; integration test covers toggle/rollback.

- [ ] T085 [US2] Learning Toggle Worker Enforcement
  - **Files**: `apps/workers/processing-worker/src/app/processors/review.processor.ts`, `packages/ml/src/lib/correction-log.service.ts`
  - **Dependencies**: `@my-org/ml`, `@my-org/database`
  - **Done**: Corrections are persisted but only applied when learning is enabled; respects staged rollout flag and emits audit events.

- [ ] T076 [US2] Admin View for Unknown-Type Backlog
  - **Files**: `apps/admin/src/app/features/unknown-types/*`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/database`
  - **Instructions**: Display queue of unknown/novel documents with captured signals (tokens/layout hints/sample thumbnail); allow download and promote into new template creation flow; record audit on disposition.
  - **Done**: Admin can view and export unknown-type items; e2e test covers promote-to-template flow.

## Phase 6: Production Readiness & Polish
**Goal**: Ensure production readiness, search, and auditability.

- [ ] T042 [US5] Implement Search API & UI
  - **Files**: `apps/api/src/app/search/*`, `apps/web/src/app/features/search/*`
  - **Dependencies**: `@my-org/database`
  - **Done**: Users can search documents by metadata and extracted content.

- [ ] T030 [US5] Implement Audit Logging for Status Changes
  - **Files**: `packages/observability/src/lib/audit-logger.ts`
  - **Done**: Every state transition in workers logs an audit event.

- [ ] T031 [US1] Verify End-to-End Flow
  - **Files**: `tests/e2e/full-pipeline.spec.ts`
  - **Done**: Upload -> Process -> Validate (UI) -> Export flow passes.
- [ ] T095 [OBS][AUD] End-to-end audit coverage for data changes
  - **Files**: `packages/observability/src/lib/audit-logger.ts`, `apps/workers/*/src/app/processors/*`, `apps/api/src/app/*`, `tests/contract/audit-events.spec.ts`
  - **Dependencies**: `@my-org/observability`, `@my-org/shared-types`, `@my-org/database`
  - **Done**: Every state change or data mutation (ingest, extract, enrich, validate, review corrections, export, template/rule selection) emits immutable audit entries with actor/timestamp/diff; contract test asserts schema and end-to-end propagation.

- [ ] T054 [OBS] Instrument API & Workers with OTel Traces/Metrics/Logs
  - **Files**: `apps/api/src/app/*`, `apps/workers/*/src/app/*`, `packages/observability/*`
  - **Dependencies**: `@my-org/observability`
  - **Done**: Spans emitted across intake→export; metrics for queue depth/latency; logs use JSON schema.

- [ ] T055 [OBS] Metrics & Alerting for Webhooks/Queues/Latency
  - **Files**: `packages/observability/src/lib/metrics.ts`, `helm/values.yaml` (alerts)
  - **Dependencies**: `@my-org/observability`
  - **Done**: Alerts fire on webhook retries/DLQ growth and stage latency; tests/assertions documented.

- [ ] T056 [SC] Performance & Success-Criteria Benchmarks
  - **Files**: `tests/perf/pipeline.bench.ts`
  - **Dependencies**: `@my-org/shared-types`, `@my-org/queue`
  - **Done**: Benchmarks capture throughput, p95 stage latency, webhook emission <5s, lock acquisition <200ms.

- [ ] T057 [SC] Monitoring Dashboards for Success Criteria
  - **Files**: `docs/ops/dashboards.md`, `helm/values.yaml` (dashboards)
  - **Dependencies**: `@my-org/observability`
  - **Done**: Dashboards show SC-001..SC-008 metrics with thresholds and ownership.
- [ ] T096 [QA] Enforce 80% coverage gate in CI
  - **Files**: `package.json`, `nx.json` (or CI workflow), `tools/scripts/check-coverage.ts`
  - **Dependencies**: Nx/Jest config
  - **Done**: CI fails if global coverage <80% (line/branch); coverage report published as artifact; documented in CONTRIBUTING.

- [ ] T074 [SC] Schedule Active-Learning Reintroduction
  - **Files**: `docs/roadmap/active-learning.md`
  - **Dependencies**: None
  - **Instructions**: Document next-cycle plan to re-enable MLflow/Temporal active learning with staged promotion gates; include prerequisites, rollback plan, and entry criteria; link in release checklist.
  - **Done**: Roadmap doc exists with dated action items; referenced in release checklist; no retraining triggered this cycle.

- [ ] T087 [OBS] Centralized Log Sink & 30d Retention
  - **Files**: `helm/values.yaml`, `docs/ops/logging.md`
  - **Dependencies**: `@my-org/observability`
  - **Done**: Logs ship to centralized sink with ≥30-day retention; smoke test verifies ingestion.

- [ ] T088 [SEC] OWASP Hardening & Tests
  - **Files**: `apps/api/src/main.ts`, `apps/api/src/app/auth/*`, `tests/security/owasp.spec.ts`
  - **Dependencies**: `@my-org/shared-types`
  - **Done**: CSRF/XSS/SQLi protections and security headers enforced; automated tests verify guardrails.

## Deferred (Post-Cycle) - Active Learning
**Note**: Active learning (MLflow + Temporal) is deferred out of this cycle per Constitution Amendment 2025-12-07. Only correction logging is in scope now. Reintroduce in the next planning cycle with fresh tasks.
