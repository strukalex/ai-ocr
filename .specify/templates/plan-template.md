# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript (strict) — NestJS backend, React 18 frontend  
**Primary Dependencies**: Nx, NestJS (DDD modules, class-validator), Prisma, Mantine UI, @heartexlabs/label-studio, TanStack Query, BullMQ, OpenTelemetry, OpenCV, pdfjs-dist (text extraction), pdf-lib (assembly/splitting), MLflow, Temporal  
**Storage**: PostgreSQL (Prisma ORM), MinIO (S3-compatible), Redis for queues/cache  
**Testing**: Jest + supertest + testcontainers (backend); React Testing Library + Playwright (frontend)  
**Target Platform**: Docker + Kubernetes (Helm); Linux server runtime
**Project Type**: Nx monorepo with backend and frontend workspaces  
**Performance Goals**: Define per feature; preserve webhook and OCR throughput baselines  
**Constraints**: 80% coverage gate (fail build below); DTO validation required; OTel tracing on new codepaths; MLflow experiment tracking + model registry; Temporal-orchestrated retraining; enrichment allowed pre/post validation with lifecycle consistency; PDF text extraction uses pdfjs-dist, pdf-lib limited to structural operations  
**Scale/Scope**: Enterprise IDP/OCR with event-driven integrations; v1 excludes redaction, BPM engine, end-user schema designer, mobile apps

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Stack fit: Nx monorepo boundaries respected; NestJS modules + React/Mantine + Label Studio only. External systems (Keycloak, Redis/BullMQ, MinIO, PostgreSQL) wired via DI with typed contracts.
- Type safety: TypeScript strict on; DTOs code-first with `class-validator`. No untyped SDK shortcuts.
- Shared DTOs: DTOs reside in `@my-org/shared-types`, consumed by backend and frontend.
- Frontend data: TanStack Query is the exclusive server data fetch/cache layer; no manual `fetch()`/alt state for server data.
- Styling: Mantine native props drive styling; avoid ad-hoc CSS-in-JS outside Mantine conventions.
- AI/ML: Plan must state OCR engine selection (PaddleOCR primary, Azure DI secondary) and runtime switch; tiering (OCR → LayoutLM → LLM) per document class; active learning loop for validated data.
- Active learning pipeline: MLflow logs params/metrics/artifacts; Temporal orchestrates retraining (data collection → training → evaluation → deployment) with idempotent steps; model registry uses staged/live slots with rollback/fallback gates.
- Enrichment lifecycle: Supplemental enrichment may run before and after validation; initial enrichment must execute even on partial documents, and lifecycle/state diagrams must not contradict this ordering.
- Quality gates: Coverage ≥80% enforced; backend integration tests (supertest + testcontainers) and unit tests; frontend RTL + Playwright for critical paths; third-party services mocked via DI.
- Test execution discipline: When the agent modifies or adds tests, it must run
  all impacted suites (unit, integration, E2E/Playwright) and report the
  results; task sign-off requires a green run.
- Observability & events: OTel tracing across pipeline; structured logs and metrics; webhooks for all state changes with retry/alerts; contract tests for webhook schemas.
- Data & schema: Extraction templates schema-versioned with rollback plan; DB migrations via Prisma with downgrade path.
- Error handling: Backend uses NestJS HTTP exceptions; custom codes require OTel trace linkage and contract documentation.
- Preprocessing: Document deskew/noise reduction/binarization uses OpenCV or compatible OSS, no proprietary SDKs.
- PDF handling: Text extraction must use `pdfjs-dist`; `pdf-lib` is restricted to page assembly/splitting and metadata writes.
- UX: Keyboard-first flows using `react-hotkeys-hook`; outline shortcuts for validation UI changes.
- Scope discipline: v1 exclusions honored (no redaction, BPM engine, end-user schema designer, mobile apps) unless an amendment is approved.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
