# AI OCR IDP Platform Constitution
<!--
Sync Impact Report:
- Version change: 1.1.0 → 1.2.0
- Modified principles: Strict Type-Safe Modular Stack (adds shared DTO lib, TanStack Query, Mantine props, NestJS exceptions); Additional Constraints & Architecture (adds Prisma mention retained, OpenCV preprocessing, TanStack Query)
- Added sections: None
- Removed sections: None
- Templates requiring updates: ✅ .specify/templates/plan-template.md, ✅ .specify/templates/spec-template.md, ✅ .specify/templates/tasks-template.md
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

## Delivery Workflow & Quality Gates

- Plan and spec phases must prove constitution alignment before implementation.
- Tests: Integration + unit tests on backend; RTL + Playwright on frontend; mock
  all third-party services via DI. Coverage gate 80% enforced in CI.
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

**Version**: 1.2.0 | **Ratified**: 2025-12-06 | **Last Amended**: 2025-12-06
