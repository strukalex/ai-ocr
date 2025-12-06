# Data Model

## Core Entities

- Document: id, source_channel, checksum, original_uri (immutable), canonical_uri (PDF/A-2b), status (Uploaded|Classified|Extracted|EnrichedPre|Validated|PendingReview|EnrichedPost|Exported|Failed|Exception), classification {type, confidence, ambiguous_candidates[]}, processing_profile_id, template_version_id?, extraction_rule_version_id, validation_rule_version_id, pre_enrichment_snapshot_id, post_enrichment_snapshot_id, export_schema_version, current_lock_id?, audit_trail_id
- PageArtifact: id, document_id, page_number, image_uri, ocr_payload (primary/secondary), layout_blocks (for LayoutLM), checksum
- TemplateVersion: id, template_id, version, status (draft|live|retired), coordinates (kv, tables, marks, signatures), tolerances, fields -> output mapping, validators, created_by, deployed_at
- ProcessingProfile: id, name, strategy (fast|accurate|balanced), ocr_primary (PaddleOCR), ocr_secondary (Azure DI), classification_tier (traditional|layoutlm|llm), enrichment_policies, retry/backoff config, enabled
- ExtractionRuleVersion: id, document_type, version, schema_id/version, model_slot (v1/v2/v3...), rollout_policy, rollback_pointer
- ValidationRuleVersion: id, document_type, version, ruleset (business checks), blocking vs warning, rollback_pointer
- EnrichmentJob: id, document_id, stage (pre|post), payload, status, attempts, next_retry_at, dlq_reason?
- ValidationSession: id, document_id, lock_id, opened_by, opened_at, shortcuts_profile, submitted_at, result (validated|exception|illegible), corrections[]
- Lock: id, document_id, holder_user_id, acquired_at, ttl, state (active|expired|released)
- WebhookSubscription: id, event_types[], endpoint, secret, retries, backoff, disabled?, last_failure
- ActiveLearningSample: id, document_id, field_path, pre_value, corrected_value, confidence, labels, ingested_at, mlflow_run_id
- AuditEvent: id, document_id, actor_id (user/system), type, from_state, to_state, reason, metadata, created_at
- User & Role: user_id, roles (viewer|validator|operator|admin), sso_identity?, local_auth?, status; roles define access per FR-018

## Relationships

- Document 1..* PageArtifact (immutable link to canonical pages)
- Document 0..1 TemplateVersion (when matched to structured form)
- Document 1 ProcessingProfile; 1 ExtractionRuleVersion; 1 ValidationRuleVersion
- Document 0..* EnrichmentJob (pre must complete before validation; post after validation/review)
- Document 0..1 ValidationSession (active) guarded by Lock (1..1)
- Document 0..* ActiveLearningSample (generated from validated corrections)
- Document 0..* AuditEvent (state changes, corrections, exports)
- TemplateVersion belongs to Template; multiple versions with live flag and rollback pointer
- WebhookSubscription subscribed to lifecycle events (state change, DLQ, review required)

## State Machine

- Uploaded → Classified → Extracted → EnrichedPre → Validated → EnrichedPost → Exported (happy path)
- Validated → PendingReview (low confidence, high-risk flags, recoverable failures) → Validated (after corrections) → EnrichedPost → Exported
- Validated → Exception (uncorrectable business rule failure or external unavailable after retries)
- Any stage → Failed (unrecoverable: corrupted file, unsupported format, missing pages)
- Classified with ambiguity → PendingReview (classification confirmation) → Extracted
- Partial template match → flexible extraction; if still low confidence → PendingReview/Exception
- DLQ in any stage pauses progression; manual retry restores to prior stage with idempotent re-run

## Validation & Business Rules

- Pre-validation enrichment is mandatory: validation cannot start until EnrichedPre jobs success.
- Validation rules evaluate totals, dates, required fields, external verification statuses; blocking failures route to PendingReview or Exception per configuration.
- Post-validation enrichment allowed only after validation/review success; composes export payload (schema-versioned JSON).
- Locks enforce single active ValidationSession; lock TTL with heartbeat to prevent stale ownership.

## Template & Rule Versioning

- Templates, extraction rules, and validation rules are schema-versioned with rollback pointers; documents store the exact version ids used.
- Deployments promote a new version to live with canary option (profile-based) and retain prior versions for rollback.
- Template compilation validates coordinate completeness (kv, tables, marks, signatures) and tolerated drift; deploy must complete < minutes to satisfy FR-026.

