# Phase 0 Research

## Findings

### Decision: BullMQ queues per pipeline stage with idempotent workers and DLQs
- Rationale: Aligns with event-driven async requirement, supports backoff/retries, integrates with Redis for locks/metrics, keeps stages independently scalable.
- Alternatives considered: Kafka Streams (heavier infra, less direct job semantics), direct NestJS cron/inline processing (violates async/decoupled requirement and retry/DLQ expectations).

### Decision: Template extraction with schema-versioned templates, partial-match fallback
- Rationale: Meets FR-025/026/031 by using versioned templates (coordinates, tables, signatures) with confidence scoring; partial matches trigger flexible extraction + exception routing to avoid mis-mapping.
- Alternatives considered: Rigid template-only extraction (fails on drift); pure ML layout inference (slower to iterate, weaker for standardized forms without guarantees).

### Decision: Dual OCR + tiered classification switchable at runtime
- Rationale: Constitution mandates PaddleOCR primary, Azure DI secondary; tiered path (traditional OCR → LayoutLM → LLM) balances latency vs accuracy and supports profile-based routing.
- Alternatives considered: Single-engine OCR (no redundancy, poorer resilience); LLM-first (cost/latency, not suited for structured, lowers throughput goals).

### Decision: Active learning loop via MLflow + Temporal retraining
- Rationale: Validated corrections feed labeled datasets, logged to MLflow with metrics/artifacts; Temporal orchestrates retraining/eval/promotion with staged/live slots, rollback/fallback for regressions.
- Alternatives considered: Ad-hoc retraining scripts (no auditability/rollback), manual promotions (slow, error-prone, violates constitution active-learning mandate).

### Decision: Keyboard-first validation UI with Redis-backed document locks
- Rationale: react-hotkeys-hook + Mantine + Label Studio embedding ensures keyboard-first; Redis locks (TTL + heartbeat) prevent collisions and surface holder identity; aligns with FR-012/013/014 and SC-002/003.
- Alternatives considered: Optimistic concurrency only (risk of overwrite), client-only locks (unreliable), mouse-centric Label Studio defaults (fails keyboard-first constraint).

### Decision: Enrichment ordering and resiliency
- Rationale: Pre-validation enrichment is mandatory to satisfy FR-030; post-validation enrichment optional for export assembly. Both modeled as separate queues with retries/backoff and DLQ; partial documents allowed but state machine forbids skipping pre-validation enrichment before validation.
- Alternatives considered: Single enrichment stage (cannot guarantee pre-validation completion), synchronous enrichment in API (breaks async pipeline and throughput goals).

