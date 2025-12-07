# Data Model

## Core Entities

- Document: id, source_channel, checksum, original_uri (immutable), canonical_uri (PDF/A-2b), status (Uploaded|Classified|Split|Extracted|EnrichedPre|Validated|PendingReview|EnrichedPost|Exported|Failed|Exception), classification {type, confidence, ambiguous_candidates[]}, processing_profile_id, template_version_id?, extraction_rule_version_id, validation_rule_version_id, pre_enrichment_snapshot_id, post_enrichment_snapshot_id, export_schema_version, current_lock_id?, audit_trail_id, parent_document_id?, root_document_id?
- Document lifecycle detail: state_reason, validation_issues[] {field_path?, issue_code, message, severity}, external_status {system, status, message}
- PageArtifact: id, document_id, page_number, image_uri, ocr_payload (primary/secondary), layout_blocks (for LayoutLM), checksum
- Template: id, name, document_type, description?, created_at, updated_at
- TemplateVersion: id, template_id, version, status (draft|live|retired), coordinates (kv, tables, marks, signatures), tolerances, match_policy {min_confidence, max_shift_px, max_rotation_deg, partial_match_action}, fallback_extraction_enabled, fields -> output mapping, validators, output_schema_version, created_by, deployed_at
- TemplateField: field_id, page, bbox, type (kv|table|mark|signature), mapping_path, table_config {columns[], header_rows, allow_multipage, merge_tolerance_px}?, categorization_config { enabled, categories[], model_tier }?, confidence_threshold?
- ProcessingProfile: id, name, strategy (fast|accurate|balanced), ocr_primary (PaddleOCR), ocr_secondary (Azure DI), classification_tier (traditional|layoutlm|llm), enrichment_policies { pre_validation[], post_validation[] }, retry/backoff config, enabled, created_at, updated_at
- ExtractionRuleVersion: id, document_type, version, schema_id/version, model_slot (v1/v2/v3...), definition (JSON model config, prompts, or field definitions), rollout_policy, rollback_pointer
- ValidationRuleVersion: id, document_type, version, ruleset (business checks), definition (json-rules-engine schema with conditions/events), blocking vs warning, rollback_pointer
- EnrichmentJob: id, document_id, stage (pre|post), payload, status, attempts, next_retry_at, dlq_reason?
- ValidationSession: id, document_id, lock_id, opened_by, opened_at, shortcuts_profile, submitted_at, result (validated|exception|illegible), corrections[]
- Lock: id, document_id, holder_user_id, acquired_at, ttl, expires_at, state (active|expired|released)
- ExportJob: id, document_id, payload_uri, schema_version, attempts, next_retry_at, status (pending|delivering|delivered|failed|dlq), last_error?, delivered_at?
- ExportPayload (if stored separately): schema_version, document_id, status, payload, delivered_at?, last_error?
- WebhookDelivery: id, subscription_id, document_id?, event_type, payload_uri, attempt, status (pending|delivering|delivered|failed|dlq), next_retry_at?, last_error?, delivered_at?
- IntakeSource: id, type (upload|watched_storage), uri, credentials_ref?, polling_interval_s?, last_seen_marker?, active
- WebhookSubscription: id, event_types[], endpoint, secret, retries, backoff_seconds, disabled?, last_failure_at?, last_failure_reason?
- ActiveLearningSample: id, document_id, field_path, pre_value, corrected_value, confidence, labels, ingested_at, mlflow_run_id
- CorrectionLog (validator corrections): id, document_id, document_type, field_path, previous_value, corrected_value?, confidence, reason_code?, validator_id, created_at
- CorrectionAggregate (rollup for retrain triggers): document_type, field_path, occurrences, latest_correction_at
- RetrainJob: id, document_type, min_corrections, dry_run?, status (pending|running|completed|failed), started_at, completed_at?, last_error?, triggered_by
- AuditEvent: id, document_id, actor_id (user/system), type, from_state, to_state, reason, metadata, created_at
- DlqItem (queue store or DB-backed): queue, job_id, payload, attempts, reason, created_at
- IntakeRequest (optional for idempotency tracking): id, document_id, idempotency_key, received_at, status
- User & Role: user_id, roles (viewer|validator|operator|admin), sso_identity?, local_auth? (password_hash/ref), status; roles define access per FR-018

## Relationships

- Document 1..* PageArtifact (immutable link to canonical pages)
- Document 0..* Document (Parent-Child relationship for split documents)
- Document 0..1 TemplateVersion (when matched to structured form)
- Document 1 ProcessingProfile; 1 ExtractionRuleVersion; 1 ValidationRuleVersion
- Document 0..* EnrichmentJob (pre must complete before validation; post after validation/review)
- Document 0..1 ValidationSession (active) guarded by Lock (1..1)
- Document 0..* ActiveLearningSample (generated from validated corrections)
- Document 0..* AuditEvent (state changes, corrections, exports)
- Document 0..* ExportJob (retryable export deliveries)
- Template 1..* TemplateVersion (parent template with versioned definitions; one version live at a time)
- TemplateVersion belongs to Template; multiple versions with live flag and rollback pointer
- WebhookSubscription 1..* WebhookDelivery (history + retries per subscription)
- IntakeSource maps to Document creation (watched storage and direct upload registry)
- WebhookSubscription subscribed to lifecycle events (state change, DLQ, review required)
- RetrainJob 0..* CorrectionAggregate (triggered when aggregate occurrences exceed min_corrections threshold)

## State Machine

**Happy path:**
- Uploaded → Classified → (Optional: Split) → Extracted → EnrichedPre → Validated → EnrichedPost → Exported

**Review/Exception flows:**
- Uploaded → Classified (Multi-part detected) → Split → [Child Documents start at Classified/Extracted]
- Validated → PendingReview (low confidence, high-risk flags, recoverable failures) → Validated (after corrections + re-validation) → EnrichedPost → Exported
- Validated → Exception (uncorrectable business rule failure or external unavailable after retries)
- PendingReview → Exception (if marked illegible/unprocessable by validator)
- Classified (ambiguous) → PendingReview (classification confirmation) → Classified → Extracted

**Error flows:**
- Any non-terminal stage → Failed (unrecoverable: corrupted file, unsupported format, missing pages)
- DLQ in any stage pauses progression; manual retry restores to prior stage with idempotent re-run

**Template matching:**
- Partial template match → flexible extraction; if still low confidence → PendingReview/Exception

**Terminal states** (require operator action to restart or abandon):
- Failed: Unrecoverable processing errors
- Exception: Requires manual intervention but potentially recoverable
- Exported: Successfully completed (terminal success state)
- Split: Parent document successfully processed into child documents (terminal for parent, children proceed)

## Validation & Business Rules

- Pre-validation enrichment is mandatory: validation cannot start until EnrichedPre jobs success.
- Validation rules evaluate totals, dates, required fields, external verification statuses; blocking failures route to PendingReview or Exception per configuration.
- Post-validation enrichment allowed only after validation/review success; composes export payload (schema-versioned JSON).
- Locks enforce single active ValidationSession; lock TTL with heartbeat to prevent stale ownership.

## Template & Rule Versioning

- Templates, extraction rules, and validation rules are schema-versioned with rollback pointers; documents store the exact version ids used.
- Deployments promote a new version to live with canary option (profile-based) and retain prior versions for rollback.
- Template compilation validates coordinate completeness (kv, tables, marks, signatures) and tolerated drift; deploy must complete < minutes to satisfy FR-026.

