# Implementation Plan: Document Processing Automation

**Branch**: `001-doc-processing-automation` | **Date**: 2025-12-06 | **Spec**: `/home/lex/GitHub/ai-ocr/specs/001-doc-processing-automation/spec.md`
**Input**: Feature specification from `/specs/001-doc-processing-automation/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Implement a four-group async pipeline (ingestion-worker: intake→**lightweight OCR preview→classify with OCR text**→OCR; processing-worker: extract→enrich-pre→validate-review; enrichment-worker: enrich-post; export-worker: export) with BullMQ-managed queues, idempotent workers, and DLQs. Normalization via Ghostscript; image preprocessing (deskew, denoise, binarize) delegated to a dedicated Python microservice using native OpenCV, invoked over HTTP/REST with async responses via Redis pub/sub and MinIO artifact exchange so it can scale independently of NestJS workers that carry no OpenCV bindings. Template-based extraction with partial-match fallback; tiered classification (LayoutLM + LLM fallback) and field categorization via GPT-4o Mini; validation via json-rules-engine; versioned templates/rules with rollback; webhook + notification contracts with retries; observability via OTel tracing/metrics/log schema; security baseline (TLS, AES at rest, session timeout); success-metrics harness; and a keyboard-first validation UI (Mantine + Label Studio Plugin + react-hotkeys-hook) with Redis-backed document locking and webhook-driven status updates. Active learning (MLflow + Temporal) is deferred out of this cycle per Constitution Amendment 2025-12-07; current milestone only logs corrections, exposes manual retrain trigger, and treats learning success criteria as observational (tracked, not enforced) until reintroduction next cycle.

## Technical Context

**Language/Version**: TypeScript (strict) — Nx monorepo with NestJS backend, React 18 frontend  
**Primary Dependencies**: Nx, NestJS (DDD modules, class-validator), Prisma, Mantine UI, @heartexlabs/label-studio, TanStack Query, BullMQ, Redis, OpenTelemetry, ghostscript4js (PDF processing), json-rules-engine, openai, Python OpenCV microservice (native OpenCV packages), MinIO SDK, Keycloak adapters  
**Storage**: PostgreSQL (Prisma ORM as sole DAL), MinIO (S3-compatible originals + normalized artifacts), Redis for queues/cache/locks  
**Testing**: Jest + supertest + testcontainers (backend); React Testing Library + Playwright (frontend); contract tests for webhooks; coverage gate ≥80%  
**Target Platform**: Dockerized services deployed via Helm to Kubernetes; Linux runtime; OTel collectors configured cluster-wide  
**Project Type**: Nx monorepo with shared types (`@my-org/shared-types`) consumed by backend, frontend, and workers  
**Performance Goals**: 500 docs/day baseline (p95 end-to-end under 1 workday), queue processing p95 < 10s per stage for healthy items, webhook emission < 5s from state change, lock acquisition under 200ms  
**Constraints**: DTO validation mandatory; enrichment allowed pre/post validation with lifecycle consistency; dual OCR (PaddleOCR primary, Azure DI secondary) with runtime switch; tiered classification (traditional OCR → LayoutLM → LLM for unstructured); active learning (MLflow + Temporal) deferred out of this cycle per Constitution Amendment 2025-12-07; current milestone limited to correction logging; preprocessing must run in a dedicated Python microservice using native OpenCV with HTTP/REST invocation and async Redis pub/sub callbacks, exchanging artifacts via MinIO, scaling independently from Node.js workers which MUST NOT ship OpenCV Node bindings; no proprietary preprocessing SDKs (OpenCV only); Bull Board dashboard mounted in the main API under `/admin/queues` via `@bull-board/nestjs`, protected by RBAC/basic auth, reusing BullMQ config  
**Scale/Scope**: Enterprise IDP pipeline with evented integrations, schema-versioned templates/rules with rollback; v1 excludes redaction/BPM/mobile/end-user schema design

### Template Lifecycle Design (Authoring → Live → Execution)
- Authoring (Admin UI, T041): Operator uploads a clean **Reference PDF** for a document type (e.g., Staples invoice), draws bounding boxes for fields (Invoice Number, Total, tables), and the UI normalizes them to percentage-based coordinates to survive DPI/page-size differences.
- Draft storage (DB, TemplateVersion): Saving creates a **draft** `TemplateVersion` (status=draft) with coordinates, tolerances, and `match_policy` (min_confidence, max_shift_px/max_rotation_deg, partial_match_action, fallback_extraction_enabled).
- Publish/promote (Registry, T052): Clicking Publish promotes the draft to **live** (e.g., version 1.2.0) and preserves rollback pointer to the prior live version; only one live version per Template at a time.
- Execution (Workers T018/T062): When a document is classified (e.g., "Staples Invoice"), the extraction worker loads the **live TemplateVersion**, overlays the stored bounding boxes onto OCR text/artifacts, and runs the Template Matching Engine (T062) to align with drift/rotation. If `match_policy` detects excessive shift (e.g., >max_shift_px or <confidence threshold), the worker falls back to flexible extraction and flags **Human Review**.
- Outcomes & audit: Extraction captures mapped fields with confidence, notes any fallback path, and emits audit events tying the document to the specific `TemplateVersion` used.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Stack fit: Nx + NestJS backend, React/Mantine + Label Studio frontend, Redis/BullMQ, MinIO, PostgreSQL, Keycloak — all via DI with typed contracts. **Status: PASS**
- Type safety & DTOs: TypeScript strict, shared DTOs in `@my-org/shared-types` with `class-validator`; no untyped SDK shortcuts. **Status: PASS**
- Frontend data & styling: TanStack Query only for server data; Mantine native props; react-hotkeys-hook for shortcuts. **Status: PASS**
- AI/ML tiering: PaddleOCR primary, Azure DI secondary with runtime switch; LayoutLM for structured high-volume; LLM fallback for unstructured; active learning mandated. **Status: PASS**
- Active learning pipeline: PostgreSQL-based correction logging with manual retraining trigger (>1000 corrections); Phase 2 adds MLflow for experiment tracking and Temporal for automated retraining workflows. **Status: PASS**
- Enrichment lifecycle: Pre-validation enrichment mandatory; post-validation optional; lifecycle supports partial documents without contradiction. **Status: PASS**
- Quality gates: Coverage ≥80%, backend integration + unit tests, frontend RTL + Playwright, DI mocks for third parties. **Status: PASS**
- Observability/events: OTel tracing across pipeline, structured JSON logs, metrics, webhooks on all state changes with retry/alerts, contract tests. **Status: PASS**
- Data/schema: Templates and rule sets schema-versioned with rollback; Prisma migrations with downgrade path. **Status: PASS**
- Error handling: Standard NestJS HTTP exceptions; custom codes documented and trace-linked. **Status: PASS**
- Preprocessing: Ghostscript for PDF/A-2b + dedicated Python microservice running native OpenCV for deskew/noise/binarization, invoked via HTTP/REST with async Redis pub/sub responses; NestJS workers exclude OpenCV Node bindings; MinIO used for artifact exchange; no proprietary SDKs. **Status: PASS**
- UX & scope: Keyboard-first validation; scope exclusions (redaction, BPM, mobile, end-user schema design) honored. **Status: PASS**

## Project Structure

### Documentation (this feature)

```text
specs/001-doc-processing-automation/
├── plan.md          # This file (/speckit.plan output)
├── research.md      # Phase 0 output
├── data-model.md    # Phase 1 output
├── quickstart.md    # Phase 1 output
└── contracts/       # Phase 1 output (OpenAPI/GraphQL)
```

### Source Code (repository root)

```text
apps/
├── api/                 # NestJS HTTP + queue producers
├── web/                 # React + Mantine + Label Studio validation UI
├── admin/               # Ops console (profiles, templates, rules, webhooks)
└── workers/             # Nx targets bundling BullMQ consumers per group
    ├── ingestion-worker/     # intake → classify → ocr
    ├── processing-worker/    # extract → enrich-pre → validate-review
    ├── enrichment-worker/    # enrich-post
    └── export-worker/        # export

packages/
├── shared-types/        # DTOs/schemas with class-validator
├── queue/               # BullMQ setup, retry/backoff/DLQ helpers
├── storage/             # MinIO + canonical artifact helpers
├── observability/       # OTel, structured logging, metrics
├── templates/           # Template schema, versioning, matcher utilities
├── ml/                  # OCR model orchestration, correction logging (Phase 2: MLflow + Temporal hooks)
└── validation-rules/    # Business rules, rule engine wiring (schema-versioned)

tests/
├── contract/            # Webhook/HTTP contract tests
├── integration/         # Pipeline + DB/queue integration (testcontainers)
└── e2e/                 # Playwright for validation UI flows
```

**Structure Decision**: Nx workspace with `apps` for API/UI/workers and `packages` for shared libs (types, queue, storage, templates, observability, ML, validation rules). Tests split by contract/integration/e2e to align with coverage gate and pipeline stages. Workers consolidated from 8 separate services to 4 groups for operational efficiency at current scale (500 docs/day).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| None | N/A | N/A |
