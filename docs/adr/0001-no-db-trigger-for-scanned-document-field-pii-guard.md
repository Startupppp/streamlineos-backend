# ADR-0001: No database trigger for the scanned-document-field PII guard

**Date:** 2026-09-26
**Status:** Accepted

## Context

Migration 1201 (`kb_linked_document_guard`) installs `trg_documents_unlink_when_unpublishable`, which fires on `AFTER UPDATE OF "classification", "user_id", "uploaded_by", "type", "is_active", "metadata"` and unlinks a document from the knowledge base when `hr_document_is_publishable` transitions from true to false. That trigger was a sound fit: the publishability predicate is pure SQL over a bounded column set, and its TypeScript twin `isPublishableDocument` is verified by a parity spec.

Four further columns — `name`, `description`, `category`, `tags` — are concatenated into the KB search vector and injected verbatim into the AI prompt context. The TypeScript PII scanner (`SCANNED_DOCUMENT_FIELDS` and `scanDocumentMetadataForPii` in `document-pii-scan.ts`) guards against personal identifiers entering those fields on documents with a live KB link. The question was whether a second database trigger could backstop that guard.

## Decision

No database trigger is added to cover the four scanned fields. The application-layer guard in `DocumentsService.assertSearchableMetadataStillPassesPublishJudgement` remains the single enforcement point.

## Reasoning

**PostgreSQL offers no trusted-path attestation.**
The session GUC pattern (`set_config('app.pii_scan_passed', 'true', true)`) was considered as a way to mark that the service layer had already checked a write. It cannot be made sound. `set_config` is a `pg_catalog` builtin; no GRANT can restrict which sessions call it or which GUC names they set. Any session — including a DBA running ad-hoc SQL — can issue `SELECT set_config('app.pii_scan_passed', 'true', true)` before an UPDATE, defeating the check. Role-based checks are no more sound: `streamline_admin` (BYPASSRLS, migration role) can `SET ROLE streamline_app` after setting any GUC, making the attested context indistinguishable from a legitimately scanned write. Ordinary `streamline_app` sessions cannot `SET ROLE streamline_admin`; the vulnerability runs in one direction only.

The contrasting case is migration 0930 (`audit_logs_append_only_trigger`), which uses `app.audit_log_detachment`. That pattern is appropriate because the threat model is *accidental* mutation of audit rows: no ordinary codepath touches `audit_logs` rows after insert, so the implausibility of accidental access makes the GUC a meaningful signal. Direct edits to `documents.description` or `documents.name` by DBAs are entirely routine; the same implausibility argument does not hold.

**`streamline_admin` carries BYPASSRLS and is the migration connection.**
Every migration and ops script connects as `streamline_admin` via `DATABASE_URL`; runtime application connections use `streamline_app` via `APP_DATABASE_URL`. `streamline_app` is a non-superuser non-BYPASSRLS role subject to RLS; `streamline_admin` has BYPASSRLS and bypasses every tenant policy. Production Aurora is the only Postgres environment — `backend/.env` points both URLs at the same RDS instance; there is no non-production database. A `RAISE EXCEPTION` trigger on `UPDATE OF name, description, category, tags` would fire for every document rename run through a migration or maintenance script, breaking routine operations without any way to opt out without bypassing the trigger entirely.

**RLS, index, and GRANT caveats.**
RLS policy predicates use `app.current_org_id()`, which is not leakproof. A non-leakproof predicate prevents the planner from using a GIN or trigram index unless `org_id` is carried inside a covering index; expression indexes on non-leakproof functions are dead under RLS. `ALTER FUNCTION … LEAKPROOF` is not available on Aurora. Some tables have GRANTs but no RLS policy; others have no GRANTs at all — both gaps surface as `42501` and are tracked by `db-verify-rls.mjs`. These facts do not change the PII-scan decision but bound what a DB-layer check could ever achieve.

**An unconditional unlink trigger has an unmeasurable false-positive rate.**
Twelve-digit sequences, which Aadhaar patterns require, appear in order numbers, timestamps, and invoice references. An auto-unlink on a 12-digit group match would sever live KB links for documents with no PII. Measuring the false-positive rate on production was not possible: the production documents table holds 7 rows and 0 active KB links, providing no empirical baseline.

**A SQL regex detector would be a second source of truth.**
Encoding Aadhaar, PAN, IFSC, and bank-account patterns in PL/pgSQL creates a parallel detector that must be maintained in lockstep with `document-pii-scan.ts`. Any divergence silently widens or narrows the guard depending on which copy is checked. There is no mechanism to derive the SQL patterns from the TypeScript constant.

## Consequences

`assertSearchableMetadataStillPassesPublishJudgement` in `documents.service.ts` is the only gate. Its removal or bypass would not be caught by the 1201 trigger. The spec at `src/modules/hr/performance/1347-application-layer-guard-coverage.spec.ts` binds this: it iterates over `SCANNED_DOCUMENT_FIELDS` directly so any new scanned field automatically adds a test case, and its self-check test demonstrates that mocking `withMetadataPiiBlocker` to return no findings lets a PAN-bearing update through — proving the per-field refusal tests are sensitive to the scanner rather than vacuously passing.

Migration 1347 (`1347_kb_hr_documents_guard_scanned_fields.sql`) remains on disk, unjournalled and unapplied. Its spec (`1347-document-guard-scanned-field-coverage.spec.ts`) asserts that the file's trigger column list matches `SCANNED_DOCUMENT_FIELDS`, preserving a record of what was considered.

**Controlled direct-write path.** Any migration or maintenance script that writes directly to `name`, `description`, `category`, or `tags` on a `documents` row with an active `kb_linked_documents` entry must either: (a) call `assertSearchableMetadataStillPassesPublishJudgement` via the service layer for each affected row after the write, or (b) quarantine the KB link before the write — transition its status to a holding state, complete the write, then trigger revalidation. A script that skips both steps leaves KB links in an unverified PII state; `streamline_admin`'s BYPASSRLS means no trigger fires to detect it.
