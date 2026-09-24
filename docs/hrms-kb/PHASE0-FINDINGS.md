# HRMS → KB linking — Phase 0 findings

Read-only reconnaissance of `origin/main` @ `c3ff68b41` (backend) and `4bb523b4a` (frontend), 2026-09-25.
Nothing in Phase 0 changed application behaviour, and nothing was applied to any shared or live database.

**Labels.** *Confirmed* = I read the code path end to end. *Agent-read* = a reconnaissance agent reported it with a
file reference and I did not re-read it myself. *Suspected* = inferred, not traced. Severity is by reachability:
**High** = reachable by an ordinary employee, or breaks the PERSONAL invariant on its own; **Medium** = reachable by
scoped HR-side holders, or a latent route to the invariant; **Low** = integrity/hygiene.

Paths are relative to the backend repo unless prefixed `FE/` (= `streamlineos-frontend/frontend/`).

---

## 1. Spec guess → real name

| Brief said | Reality | Evidence |
|---|---|---|
| D1: "No KB module exists" | **A large KB exists** (~30 tables, hybrid search, RAG "Ask", outbox ingestion). `kb_articles` was folded into `kb_pages`. | `src/modules/kb/`, `src/db/schema/kb/`, migrations `1168`–`1176` |
| `tenant_id` | `org_id` (outbox and SQL-managed HRMS tables use `organization_id`) | `src/db/schema/hr/documents.ts:26`, `common/audit/…` |
| `Hr Module Owner` / `Hr Module Admin` | Real: slugs `HR_MODULE_OWNER`, `HR_MODULE_ADMIN` (names `${Module} Module …`). Older templates `HR_ADMIN` "HR Administrator", `BRANCH_HR` also exist | `src/modules/rbac/seed-system-roles.ts:163-179`, `role-templates-hr.constants.ts` |
| `kb.hr_documents.publish` | Naming rule is `module:resource:action`, so `hr:documents:publish` (a `publish` verb already exists: `hr:payroll:publish`) | BE-26, `hr-foundation.permissions.ts` |
| Flags `hrms.kb.link/search/ai` | No such flag exists. Live per-tenant mechanisms: `organizations.settings.features` (closed 6-value AI enum) and per-module settings rows (`kb_settings`). The `feature_flags` table is **not read by any code** | `settings.helpers.ts`, `db/schema/kb/settings.ts`, `db/schema/common/feature-flags.ts` |
| `requestId` | Wire name is `correlationId` (also echoed as `x-request-id`); stored in `audit_logs.metadata.requestId`. **No UI shows or copies it** | `common/http/all-exceptions.filter.ts:17-22`, `FE/lib/api-envelope.ts:67,152` |
| Audit table | `audit_logs`, append-only (UPDATE/DELETE revoked, trigger, TRUNCATE guard), retention = keep forever, no purge worker (matches D10) | migrations `0840`, `0930`, `1070` |
| Signed URL 300 s attachment (D8) | **Already** 300 s on `GET /hr/documents/:id/file`; the URL is returned, not redirected | `hr/performance/documents.controller.ts:127-136` |
| Documents import re-run dedupe (D12) | **Already shipped by the HRMS-remediation lane** (`document_metadata` entity, provisional key `(org_id, user_id, category, name)`, no unique index). See §4 for defects in it | `hr/import/hr-import-commit.service.ts:454`, `HRMS_E2E_TODO.md` §007 |
| "Approve v2" of a followed document | `documents.version` is always 1 and `parent_document_id` is never written. **There is no version or approval model** | `db/schema/hr/documents.ts:37-38`, agent-read: no writer |
| Assistant | "Ask OS" (`POST /chat`, `ai:chat:use`) plus `KbAskService` (`POST /kb/ask`). Neither reads HR `documents` today | `ai/core/services/chat-assistant.service.ts`, `kb/retrieval/kb-ask.service.ts` |

---

## 2. Tenant-ID check

**Result: no tenant-isolation defect found on the document or KB surface.**

Method: cold-built a local database from the journal (`scratch_hrmskb`; 946 of 948 migrations — see §6) and read the catalog.

| Check | Result |
|---|---|
| Every document-related and KB table (`documents`, `rich_documents`, `policy_acknowledgments`, `hr_template_renders`, `hr_templates`, `handbook_versions`, `hr_import_jobs`, and 32 of the 33 `kb_*` tables) has `org_id NOT NULL` | **Yes**; the one exception is `kb_tenant_backfill_issues` (no tenant column, no RLS, a one-off backfill ledger) |
| … RLS enabled with a `tenant_isolation` policy on `app.current_org_id()` | **Yes** for all of them (`FORCE` is off, as on the rest of the schema — BE-72) |
| Whole schema: tables with an `org_id` column | 882 |
| … of which RLS **off** | 6 — `build.managed_product_memberships`, `build.project_attachments`, `build.project_updates`, `public.impersonation_sessions`, `public.organization_relocation_checksums`, `public.organization_saga_steps`. None touch documents or KB; reported, not fixed here |
| … of which `org_id` **nullable** | 9 — `audit_logs` (platform events, by design), `coupons`, `email_suppressions`, `guided_tours`, `login_history`, `notification_events`, `payroll_statutory_rule_sets`, `payroll_templates`, `platform_payments`. Our new audit rows always set `org_id` |
| Cross-tenant key reads | `assertKeySignable` refuses a foreign-org key even when `preauthorized: true` (`storage/storage.service.ts:271-274`). **Verified not-a-finding.** |

**Not measured:** any live tenant's rows. `streamlineos-backend/.env` now points at an AWS RDS instance that uses IAM
authentication; reaching it would mean minting a token from personal AWS credentials against what looks like a live
database, which this workflow does not do unprompted (the HRMS-remediation lane recorded the same rule). The empirical
row-level check (null or foreign `org_id`, user not a member of the document's org) is in
`docs/hrms-kb/sql/phase0-duplicate-documents.sql`, section 4, ready to run read-only by someone with access.

---

## 3. Duplicate census for the D12 identity key

Key: `(org_id, user_id or NULL, category, name_normalized)` with
`name_normalized = lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))`, active rows only.

| Environment | Active documents | Duplicate groups |
|---|---|---|
| `scratch_hrmskb` (cold build) | 0 | 0 |
| `streamline_hrms_e2e` (HRMS lane's local DB, read-only) | 3 (one tenant, all company-wide, all external `https` URLs) | 0 |
| **Any live tenant** | **not measured — BLOCKED** | **unknown** |

Consequence: the unique index on the D12 key **stays BLOCKED** (brief: "or the unique index is BLOCKED with duplicate
counts reported"). The census script is read-only, aggregate-only, prints 8-character org prefixes, and also reports
`public_but_personal_type` (see SEC-01) and external-vs-stored file shapes. Unblock = run it against a real environment,
review counts, approve a cleanup, then ship a *partial* unique index (`WHERE is_active`).

---

## 4. Security findings on the HR-documents surface (candidates for PR 1)

Who holds `hr:documents:view`, because it bounds every severity below (`rbac/*`, confirmed):
Org Owner and Org Admin (every catalog key, scope `all`) · `HR_MODULE_OWNER`/`HR_MODULE_ADMIN` (all `hr:*`, `all`) ·
`HR_MODULE_MEMBER` (every `hr:*:view|read` key, so `hr:documents:view` at **`all`**) · `HR_ADMIN`/`BRANCH_HR` templates ·
custom roles or per-user grants (the only way to get `own`/`team`). **A plain employee holds no `hr:documents:*` key**
(`rbac/permissions/role-defaults.ts`); employees reach KB through `kb:pages:view` (universal) only.

| ID | Sev | Finding | Reach | Evidence |
|---|---|---|---|---|
| SEC-01 | Med | `isPublic` is accepted on **any** document type, including `PAYSLIP`/`ID_PROOF`, and it widens the *file* route (`documentReadableScope`) for every viewer, while the list route ignores it. IDs are serial integers, so a public personal file is enumerable. Confirmed | Custom `own`/`team` holders of `hr:documents:view` | `hr/performance/dto/documents.schemas.ts` (`createDocumentSchema.isPublic`), `documents-helpers.ts:21-30`, `documents.service.ts` `getFileReference` |
| SEC-02 | Med | `GET/PATCH/DELETE /hr/rich-documents[/:id]` and `…/publish` apply **no scope and no owner check**; drafts are returned. `rich_documents` has no owner column and holds **personal letters**: experience certificates (`Experience Certificate - <Name>`) and offers. Confirmed | Any holder below `all` scope | `hr/performance/rich-documents.service.ts`, `documents.controller.ts:237-300`, writers `hr/lifecycle/experience-letter.service.ts:126`, `hr/interviews/hr-offers.service.ts:170` |
| SEC-03 | Med | `GET /hr/documents/letters` lists every employee's rendered letters (template, employment id, renderer) ignoring scope; `GET /hr/templates/:id/renders` does `select()` and returns full `outputHtml` and `contextSnapshot` to any `hr:templates:view` holder. Confirmed | Scoped `hr:documents:view` / any `hr:templates:view` holder | `hr/performance/letters.service.ts:63-89`, `hr/templates/hr-templates.service.ts:257-290` |
| SEC-04 | Med (latent) | `POST /support/kb/articles/:id/attachments` accepts **any own-org storage key** — `isOwnOrgStorageKey` checks the org prefix only, not the folder root. `KbAttachmentIndexingService` then reads it from the default bucket with `getFileStream`, which applies **no sensitive-folder or quarantine check**, extracts text and embeds it. A key under `hr-documents/`, `documents/` or `payroll/` therefore becomes a KB chunk, and reaches KB Ask. Needs `support:kb:manage` plus knowledge of a UUID-bearing key (keys appear in audit metadata and signed URLs). **This is a path by which a personal document can reach a KB chunk** and must be closed for the brief's invariant. Confirmed | `support:kb:manage` holders | `support/core/support-kb-engagement.service.ts:143-160`, `storage/storage-key.ts:142`, `kb/retrieval/kb-attachment-indexing.service.ts:168-175`, `storage/storage.service.ts:400` |
| SEC-05 | Low | `POST /hr/compliance` inserts acknowledgment rows for any `userIds` without checking they are members of the org, and without de-duplicating; `listAcknowledgments` then joins `users` (global) and returns the name. Confirmed | `hr:compliance:manage` | `hr/performance/compliance.service.ts:38-51` |
| SEC-06 | Med | Documents import: if `employeeEmail` matches no employee, `userId` becomes **NULL** — i.e. the file silently becomes an *organisation-wide* document (`commitDocument`, `userId = person[0]?.userId ?? null`). The email match is case-sensitive while in-file dedupe lowercases. A mistyped personal document turns into a "company" document. Also: the lookup ignores `is_active` (re-activates soft-deleted rows), a blank `expiryDate` cell nulls a stored expiry, an exact match reports `updated` never `unchanged`, and the SQL side compares `lower(trim(name))` while the TS side collapses inner whitespace (`normalizeName`), so a name containing a double space **duplicates on re-import**. Confirmed | `hr:import:manage` | `hr/import/hr-import-commit.service.ts:454-519`, `hr/import/schemas/import-row-identity.ts:42-44` |
| SEC-07 | Info | Audit metadata (`hr.document_uploaded/deleted/viewed`, `file.upload/download`) carries document names and storage keys, readable through `GET /audit-log` by any `audit-log:read` holder (Org Admin, `HR_ADMIN`). By design; noted so nobody adds signed URLs to metadata. Agent-read | `audit-log:read` | `audit-log.service.ts:57` |
| SEC-08 | Info | `document.expiring` automation payload (document name, employee, type) can reach admin-configured webhooks, `hr_automation_runs.eventPayload` and workflow `ai_action` prompts. By design. Agent-read | admin-configured rules | `cron/cron-hr-documents.service.ts:71-100` |
| SEC-09 | Info | Log redaction is **key-based** and does not withhold `url`, `key`, `fileKey` or signatures. No current call site logs a signed URL (16 `getFileUrl` sites return it in the response only). The new code must never log it, and needs a test asserting that. Agent-read | — | `common/observability/redact.ts:18-81` |
| SEC-10 | Info | `HR_MODULE_MEMBER` and Org Admin/Owner read all documents including personal types. So D3/D4 (org admin / manager cannot view personal docs) **cannot be enforced by permission** on `/hr/documents` today; it can only be honoured on the new KB path. Managers already cannot read reports' documents: `team` scope collapses to `own` (`documents-helpers.ts:17`) | — | `rbac/seed-system-roles.ts:111-121`, `access/access-policy.ts:130` |

**Verified not-a-finding:** foreign-org key signing (§2); the expiry cron notifies only each document's owner
(`cron-hr-documents.service.ts`); `getDocumentFile` restricts folder roots to `documents|hr-documents|hr`; the global
`/search` module indexes only leads, deals, contacts, clients and tickets; no Ask OS tool reads `documents`,
`rich_documents`, `hr_template_renders`, e-sign or candidate documents (grep terms in the agent log: `documents`,
`richDocuments`, `fileUrl`, `resume`, `candidateDocuments`, `esign` under `src/modules/ai`).

**Existing LLM exposure of HR-adjacent text (not documents, reported for completeness):** resume text (`aiScore`,
`parseResume`, up to 12 000 chars) and e-sign contract text (`sign-ai.service.ts`, 6 000 chars) go to OpenAI/OpenRouter
for their own scope-checked callers; `chat-assistant.service.ts:220` and `payroll-ai-explain` pass `redact:false`. Out of
scope for this project; the plan neither widens nor narrows them.

## 5. KB-side observations (out of scope; reported for the KB owners)

I re-read K-01, K-02 and K-06; the rest are agent-read.

| ID | Finding |
|---|---|
| K-01 | `GET /kb/sources` and `/:id` filter by org only, so any `kb:pages:view` holder sees titles and `fileUrl` of sources in spaces they cannot access (`kb/wiki/kb-sources.service.ts:108,154`). Confirmed |
| K-02 | `DELETE` of a record link checks org only, not page edit access (`kb/wiki/kb-page-record-links.service.ts:65-76`). Confirmed |
| K-03 | `GET /hr/helpdesk/suggest` returns title/slug/excerpt of every published support article without page ACL (`hr/helpdesk/hr-helpdesk.service.ts:547-590`); needs `hr:helpdesk:view`. Confirmed. **Design consequence:** linked HR entries must not be modelled as support articles |
| K-04 | KB media upload with a `pageId`, page restore, hard delete and empty-trash skip page-level access checks; page create does not check the caller can see `spaceId`/`parentPageId`. Agent-read |
| K-05 | `POST /kb/pages/import` accepts any `externalSource`, so the `external_source` namespace is forgeable. Agent-read. **Design consequence:** do not key a security boundary on it |
| K-06 | KB Ask falls back to raw `kb_pages.content_text` when a page has no chunks, so "no chunks" is not "no AI context". Agent-read |
| K-07 | The canonical KB predicate short-circuits to "whole tenant" for org owners and `kb:spaces:manage` holders, and a space in `accessibleSpaceIds` grants view on every page in it. Confirmed by reading `knowledge-page-scope.ts`. **Design consequence:** an audience-restricted entry cannot rely on page visibility |
| K-08 | Two visibility predicates exist: canonical (`knowledge-page-scope.ts`) and a legacy one for chunk candidates (`kb/retrieval/kb-page-visibility.ts`). Legacy under-grants; passages are re-read with the canonical predicate. Agent-read |

## 6. Database and migration observations

- **Cold build of `origin/main` does not reach head.** 910 of 948 apply; `1155_build_cycles_drift_reconcile` fails
  (`column "cycle_id" does not exist`; it reconciles off-journal `migrations/sql/a-sprint-cycle-*` files). I applied the
  37 that follow it individually with `db:apply-one`; 36 applied, and **`1174_kb_articles_cutover_contract` fails**
  (`constraint "kb_article_tags_org_id_article_id_tag_id_pk" for table "kb_page_tags" does not exist`), so a cold build
  leaves the retired `kb_article_*` tables in place. Neither belongs to this project; both are reported. Consequence: my
  scratch DB has every table this project touches, but a green `check:migration-chain` cannot be assumed on `main`.
- Next free migration number is `1192`, journal `idx` 1076, `when` > `1803000010706`. **Re-read the journal immediately
  before writing** — the HRMS lane is adding migrations concurrently (a lesson from earlier sessions).
- `_chain.sha256.json` is sealed only through 1061; a rollback file is required above 839 (`check-migration-rollback`).
- `check:hr-table-freeze` blocks new tables under the HR schema unless allow-listed (agent-read; probably already red at
  HEAD). New tables therefore go under `src/db/schema/kb/`.
- Cluster-wide role `streamline_app` has an unknown password, and changing it would break other sessions' seeded runs.
  DB-backed specs in this project will use a dedicated login role granted membership in `streamline_app` instead.

## 7. Existing surfaces the design must respect

- HR downloads go **only** through `GET /hr/documents/:id/file` (300 s, audited `hr.document_viewed`); external `https`
  `fileUrl` values (what the import writes) make that route 404 while `hasFile` stays true — imported documents show an
  enabled button that cannot open. Owners under `own` scope likely cannot see imported/onboarding/recruitment-handoff rows
  at all (`userMembershipId` is not set by those writers). Agent-read; relevant to backfill.
- Every writer of `documents` rows (agent-read): `POST /hr/documents`, the CSV import, `POST /onboarding/documents`,
  recruitment handoff (`RESUME`, category `HIRE_PACKET`), and one seed script. Payslips, e-sign and letters write **no**
  `documents` rows.
- Frontend: `type` is enum-locked on the client (an unknown value fails the whole list parse), so classification must be
  a **new column**, never new `type` values. `/hr/documents` has no `RequireModule`, breaks the page-state rules and keeps
  its cursor in component state.
- Frontend gates a new UI must clear: `check:import-direction` (cross-feature baseline 0 → shared code in
  `components/shared`), `check:over-300`, `check:colors`, `no-raw-visual-values`, `check:permission-catalog`,
  `check:contract-vendor` (re-vendor `openapi.json` and `permission-catalog.json` after any backend change).
