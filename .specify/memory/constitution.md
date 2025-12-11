# AI OCR IDP Platform Constitution
<!--
Sync Impact Report:
- Version change: 1.5.0 → 1.6.0
- Modified principles: Delivery Workflow & Quality Gates (automated agent test execution required after any test edits/additions)
- Added sections: None
- Removed sections: None
- Templates requiring updates: ✅ .specify/templates/plan-template.md, ✅ .specify/templates/tasks-template.md
- Follow-up TODOs: None
-->

## Core Principles

### Strict Type-Safe Modular Stack
Enforce Nx monorepo boundaries with NestJS modular DDD packages and React app
composition. TypeScript strict mode stays on. All DTOs live in a shared library
(`@my-org/shared-types`) imported by backend and frontend, code-first with
`class-validator` decorators. PostgreSQL access uses Prisma as the sole ORM with
migrations managed and reviewed. TanStack Query is the only frontend data
fetching/caching layer—no manual `fetch()` or alternate state for server data.
Styling uses Mantine native props, not ad-hoc styles. External systems
(Keycloak, Redis/BullMQ, MinIO, PostgreSQL, Label Studio) integrate via DI and
explicit contracts; no ad-hoc SDK sprawl.

### AI/ML Tiering with Active Learning
Use dual OCR engines (PaddleOCR primary, Azure Document Intelligence secondary)
with runtime switchability. Apply tiered classification: traditional OCR for
simple forms, LayoutLM for structured high-volume, LLMs (Llama 3 / GPT-4o mini)
for unstructured. Every validated data point must enter an active learning loop
that retrains and redeploys models; disablement requires documented approval.
MLflow is the system of record for experiments: capture parameters, metrics, and
artifacts for reproducibility. Temporal orchestrates the retraining workflow
(data collection → training → evaluation → deployment) with idempotent steps and
explicit failure handling. Model registry follows staged/live slots (v1, v2,
v3...) with mandatory rollback/fallback paths and promotion gates tied to
evaluation metrics.

### Quality Gates: Tests and Validation
Maintain 80% minimum coverage; builds fail below threshold. Backend mandates
integration tests (supertest + testcontainers) for all endpoints and unit tests
for business logic. Frontend covers critical paths with React Testing Library
and Playwright. External services are mocked via dependency injection; DTO
validation is non-negotiable.

### Evented Observability & Auditability
Emit webhooks on all state changes for event-driven integrations. OpenTelemetry
tracing is required across the full pipeline (ingest → OCR/ML → validation →
export). All extraction templates are schema-versioned with rollback paths.
Every data integrity change writes an audit trail with actor, timestamp, and
diff.

### UX and Scope Discipline
Validation interfaces are keyboard-first using `react-hotkeys-hook`; mouse-only
flows are rejected. v1 explicitly excludes document redaction, full BPM engine,
end-user schema design, and mobile apps—do not accept scope creep without
formal amendment.

## Additional Constraints & Architecture

- Stack: Nx monorepo; NestJS backend; React + Mantine UI frontend with embedded
  Label Studio; PostgreSQL primary DB via Prisma ORM; Redis + BullMQ for queues;
  MinIO S3-compatible storage; Keycloak for auth; Docker + Kubernetes with Helm
  for deploys.
- PDF handling: Use `pdfjs-dist` for text extraction; reserve `pdf-lib` for page
  assembly/splitting and metadata manipulation only.
- Contracts: All APIs are code-first; DTOs validated on input/output. Schema
  changes require version bumps and backward-compatible migrations when
  possible. Error handling uses standard NestJS HTTP exceptions; custom codes
  require OTel trace linkage and contract documentation.
- Frontend data: TanStack Query exclusively for server data fetching/caching.
- Preprocessing: Document deskewing/noise reduction/binarization must use
  OpenCV or compatible OSS libraries; proprietary SDKs are prohibited.
- Integrations: Webhooks are first-class; failures must be observable and
  retriable. External calls must be typed, time-bounded, and logged.
- Performance/reliability: Maintain rollout safety via feature flags and
  canaries when altering OCR/ML models or templates.
- Active learning pipeline: MLflow manages experiment tracking and model
  registry; metadata logging is required for reproducibility. Temporal
  orchestrates retraining from data collection through deployment with auditable
  tasks. Model slots must allow staged/live promotion, rollback, and fallback
  when regressions are detected.
- Enrichment lifecycle: Supplemental enrichment may occur before and after
  validation. Initial enrichment must run even on partial documents to capture
  available signals; the lifecycle and state machine must permit enrichment
  before validation without contradiction.
- TLS Policy: TLS 1.2+ is mandatory for all deployed environments (staging,
  production, shared test). Local developer setups may run without TLS only on
  loopback or behind a trusted local reverse proxy/terminator; production and
  shared environments must reject plain HTTP.
- Queue monitoring: Bull Board must be integrated via `@bull-board/nestjs` into
  the main API behind RBAC/basic auth middleware (no public exposure), mounted
  under `/admin/queues` (configurable), and reuse existing BullMQ connection
  settings; ensure TLS when exposed beyond loopback.

## Delivery Workflow & Quality Gates

- Plan and spec phases must prove constitution alignment before implementation.
- Tests: Integration + unit tests on backend; RTL + Playwright on frontend; mock
  all third-party services via DI. Coverage gate 80% enforced in CI.
- Post-implementation: every feature/change must execute the relevant test
  suites locally after code and test updates, not just author tests. When the
  agent edits or adds tests, it must run all impacted suites (unit, integration,
  E2E/Playwright) and surface the results; task sign-off requires a green run.
- Observability: OTel traces, structured logs, and metrics are mandatory per
  feature. Webhook contracts require contract tests.
- Data: Schema versioning for templates and DB migrations with rollback steps.
- UX: Keyboard-first shortcuts defined per validation screen and tested; Mantine
  props drive styling.

## Governance

- This constitution supersedes other practices for platform and feature work.
- Amendments require documented proposal, rationale, migration/rollback plan,
  and maintainer approval. MAJOR for principle changes/removals, MINOR for new
  principles or material expansions, PATCH for clarifications.
- Compliance review is required in every PR and in release checklists; blockers
  may not be waived without recorded approval.
- Ratification and amendment dates are recorded; version increments follow
  semantic versioning aligned to impact above.

### Amendment 2025-12-07: Active Learning Deferral (Scope-Limited)
- Context: Active learning (MLflow + Temporal retraining workflow with staged/live model promotion) is deferred for the current delivery cycle.
- Permission: Deferred delivery is allowed for this cycle only, provided correction logging remains in place and no automated promotion/retraining is attempted.
- Conditions: (a) No model promotion via MLflow/Temporal in this cycle; (b) data/corrections must still be logged for future training; (c) revisit and schedule MLflow + Temporal implementation in the next planning cycle; (d) re-run constitution check when reintroducing active learning.
- Impact: This is a temporary scope deferral; failure to schedule in the next cycle requires a new amendment.

**Version**: 1.6.0 | **Ratified**: 2025-12-06 | **Last Amended**: 2025-12-10
