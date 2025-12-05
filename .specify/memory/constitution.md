<!--
SYNC IMPACT REPORT
==================

Version change: none → 1.0.0
- MAJOR version bump: New constitution created for enterprise IDP platform

Added sections:
- Purpose & Scope
- Architecture & Stack
- Domain & Product Principles (10 principles)
- Quality & Testing Standards
- Security & Access Control
- UX Principles
- Observability & Operations
- Integration & Extensibility
- Out of Scope for v1
- Governance

Removed sections: none

Templates requiring updates: ✅ none - all templates reviewed and aligned

Follow-up TODOs: none - constitution is complete
-->
# Enterprise IDP Platform Constitution

## Purpose & Scope

The Enterprise IDP Platform is a modular document processing system that transforms complex, unstructured documents into structured business data through a six-stage pipeline: Capture, Classify, Extract, Validate, Review, and Integrate. Human-in-the-loop validation is a first-class requirement, ensuring enterprise-grade data integrity for mission-critical workflows.

## Architecture & Stack

### Technology Foundation
- **Monorepo Management**: Nx workspace with strict TypeScript ("strict" mode enabled)
- **Backend**: NestJS with Domain-Driven Design (DDD) folder structure
- **Frontend**: React with Mantine UI components and TanStack Query for data management
- **Database**: PostgreSQL for relational data persistence
- **Queue System**: Redis + BullMQ for asynchronous OCR and processing workloads
- **Storage**: S3-compatible interface (MinIO for development, AWS S3 for production)
- **Infrastructure**: Docker containerization with Helm/Kubernetes deployment

### Integration Patterns
Event-driven architecture is mandatory: webhooks and message queues are the default communication mechanism between components.

## Domain & Product Principles

### I. Modular Pipeline Architecture (NON-NEGOTIABLE)
Every document must flow through the complete six-stage pipeline: Capture → Classify → Extract → Validate → Review → Integrate. Pipeline stages must be independently scalable and observable.

### II. Human-in-the-Loop Validation
Validation is not an afterthought—human review is embedded in the core workflow. The Review Station integrates Label Studio UI directly into the React application for seamless document correction.

### III. Multi-Channel Ingestion
Multi-channel document ingestion is core capability: S3 watchers, REST API uploads, and extensible to new channels. Minimum supported formats include PDFs (native and scanned) and common image formats (JPG/PNG/TIFF).

### IV. Active Learning & Model Improvement
Validated data must be versioned and fed back to continuously fine-tune ML models (OCR, LayoutLM, LLMs). This reduces repeated errors over time through supervised learning.

### V. Schema Versioning & Rollbacks
Every extraction template and rule set is versioned (e.g., Invoice_Schema_v1.2). Rollbacks must be supported to maintain data processing continuity.

### VI. Configurable Pre-processing
Document pre-processing (deskewing, noise reduction, binarization) is a configurable pipeline step using OpenCV and similar libraries.

### VII. Flexible ML Stack
- OCR: Open-source engines like PaddleOCR with handwriting support
- Layout Analysis: LayoutLM or equivalent for high-volume structured forms
- Classification: LLMs (Mistral/Llama via API or local quantized models) for zero-shot semantic classification
- Model Flexibility: Models must be swappable without pipeline redesign

### VIII. Dual Extraction Strategies
Support both template-based (zonal) extraction and key-value extraction for semi-structured documents.

### IX. Business Rule Validation
Internal validation operates only on extracted data with configurable business rules. External validation supports third-party API/database calls with failure routing to dedicated review queues.

### X. Data Enrichment
Configurable data enrichment using external APIs or databases (e.g., postal_code → city/province lookup) is a first-class pipeline step.

## Quality & Testing Standards

### Test-Driven Development (NON-NEGOTIABLE)
No work is complete until automated tests pass. Every functional requirement must have at least one automated test.

### Backend Testing Requirements
- **Integration Tests**: supertest + test containers for API validation (inputs, HTTP codes, database effects)
- **Unit Tests**: Jest mandatory for validation rules and data transformations
- **External Service Mocking**: S3, OCR engines, LLM APIs, and business systems must be mocked via dependency injection

### Frontend Testing Requirements
- **Component Tests**: React Testing Library for user interaction behavior (not implementation details)
- **End-to-End Tests**: Playwright/Cypress for critical Review Station flows

### Coverage Enforcement
Minimum 80% test coverage required. Builds must fail if coverage drops below this threshold.

## Security & Access Control

### Role-Based Access Control (NON-NEGOTIABLE)
RBAC is mandatory with minimum roles: Viewer, Validator, Admin. Validation, review, and administration capabilities must be clearly separated.

### Concurrency Control
Review Station requires document-level locking: one validator exclusively locks a document to prevent concurrent edits.

## UX Principles

### Review Station Optimization
The Review Station is the primary user interface and must be optimized for enterprise throughput with keyboard-first navigation.

### Keyboard-First Design
All critical actions (accept, reject, field navigation, document navigation) must support hotkeys using react-hotkeys-hook or equivalent.

### UI Consistency
Mantine's native props and layout conventions must be used to maintain consistent, maintainable design system.

## Observability & Operations

### Pipeline Traceability
OpenTelemetry instrumentation required across the entire pipeline. Every document journey from Ingestion → OCR → Validation → Export must be fully traceable.

### Operational Readiness
Logs, metrics, and traces must enable debugging of any pipeline stage failure without speculation.

### Horizontal Scaling
System design must support independent scaling of ingestion, OCR, and validation workloads.

## Integration & Extensibility

### Event-Driven Integration
Webhooks must be emitted for important document state changes: DOCUMENT_RECEIVED, VALIDATION_REQUIRED, PROCESSING_COMPLETE.

### API Design Standards
Code-first APIs with explicit DTOs and validation decorators. DTOs must be centrally defined in shared Nx libraries and used by both backend and frontend to maintain contract synchronization.

## Out of Scope for v1

- Document redaction capabilities
- Full BPM/workflow engine integration
- End-user self-service schema design tools
- Mobile application interfaces

## Governance

This constitution supersedes all other development practices and architectural decisions. Amendments require:

1. **Documentation**: Clear rationale for changes with impact analysis
2. **Approval**: Technical lead review and stakeholder alignment
3. **Migration Plan**: Implementation timeline and backward compatibility strategy
4. **Testing**: Constitution compliance must be verified in all PRs and code reviews

Complexity must be justified against these principles. All specifications and implementations must demonstrate constitution compliance.

**Version**: 1.0.0 | **Ratified**: 2025-12-05 | **Last Amended**: 2025-12-05