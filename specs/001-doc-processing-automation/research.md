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

### Decision: Label Studio with Custom Plugin + Hybrid Keyboard Control
- Rationale: Meets FR-012/013/014 by using Label Studio Plugins (JavaScript extensions) to bridge external react-hotkeys-hook events to Label Studio's internal annotation lifecycle. Plugins can listen to custom events from the parent React app and programmatically call Label Studio's submitAnnotation() or skipTask() methods. Pure react-hotkeys-hook conflicts with Label Studio's internal keymap, and embedded mode doesn't expose programmatic control. Redis-backed document locks (TTL + heartbeat) remain valid.
- Alternatives considered: Pure react-hotkeys-hook without Label Studio integration (fails FR-013 requirement for side-by-side extracted/supplemental data and region zoom), Building a custom annotation UI from scratch (violates timeline and increases maintenance burden).

### Decision: json-rules-engine for Serializable Business Rules with Versioned Storage
- Rationale: Meets FR-007 (versioning + rollback) and FR-010 (configurable rules) by storing rules as JSON in PostgreSQL with rule_version_id, effective_from, and deprecated_at columns. Rules are fetched at runtime and executed via json-rules-engine. Supports custom operators for domain-specific validations (e.g., tax rate calculations) and event-driven architecture.
- Alternatives considered: Hardcoded TypeScript validation classes (violates FR-007 requirement for dynamic rollback without code deploys), JSON Logic (simpler but lacks event system and custom operator extensibility), Commercial BRMS (overkill, violates OSS preference).

### Decision: Ghostscript (ghostscript4js) + Python OpenCV Microservice for Normalization/Preprocessing
- Rationale: Meets FR-032 (PDF/A-2b normalization) and FR-002 (deskew/noise reduction). Ghostscript converts all PDFs to PDF/A-2b standard; a dedicated Python microservice with native OpenCV handles deskew/denoise/binarize, invoked via HTTP/REST with async responses delivered via Redis pub/sub, exchanging image artifacts through MinIO so it can scale independently of NestJS workers (which remain free of OpenCV Node bindings).
- Alternatives considered: Commercial PDF SDKs (Apryse, Qoppa — violated OSS requirement), Pure JavaScript PDF libs (pdf-lib, pdfjs-dist — lack robust PDF/A conversion), Sharp.js (fast but less robust for complex deskewing/binarization), opencv4nodejs/opencv-wasm inside NestJS workers (compilation issues, outdated bindings, and container bloat).

### Decision: GPT-4o Mini for Field-Level Categorization with Optional Llama 3 Fallback
- Rationale: Meets FR-027 by using GPT-4o Mini API for low-latency field categorization during the enrichment stage. For high-volume deployments, a fine-tuned Llama 3 model can replace API calls (requires initial training on validated corrections per active learning loop).
- Alternatives considered: Rule-based categorization (fails for ambiguous vendor names), GPT-4o (overkill, 3x cost of Mini for simple categorization), Claude 3 Haiku (comparable to GPT-4o Mini but less proven for structured output).

### Decision: Enrichment ordering and resiliency
- Rationale: Pre-validation enrichment is mandatory to satisfy FR-030; post-validation enrichment optional for export assembly. Both modeled as separate queues with retries/backoff and DLQ; partial documents allowed but state machine forbids skipping pre-validation enrichment before validation.
- Alternatives considered: Single enrichment stage (cannot guarantee pre-validation completion), synchronous enrichment in API (breaks async pipeline and throughput goals).

