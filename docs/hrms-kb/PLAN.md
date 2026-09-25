# HRMS → Knowledge Base linking — Plan

Status: **Reconciled with what was built (2026-09-25).** This began as the Phase 0 plan; where the build differed, the section now says
what shipped and why, and §5.1 lists the PRs as they actually landed. The final report and the QA checklist with real routes are
in [`REPORT.md`](./REPORT.md). Original Phase 0 evidence is in [`PHASE0-FINDINGS.md`](./PHASE0-FINDINGS.md); the read-only census
script is [`sql/phase0-duplicate-documents.sql`](./sql/phase0-duplicate-documents.sql).
Branch `hrms-kb/phase-0`, cut from `origin/main` @ `c3ff68b41` in a dedicated worktree (the HRMS-remediation session is
working on `main` in the shared trees and is not touched).

## 0. What this plan is based on

The brief received covers the acceptance criteria, the final-report format, the QA re-test checklist and §14 (open
product decisions). **§§1–13 (goals, phase list, PR breakdown, names of the listed audited actions) were not received.**
So:

- Everything under *Design* is derived from the acceptance criteria, the QA checklist and the code as it really is.
- The **PR breakdown (§5) is my proposal**, not the brief's. If the brief's PR 1 is not "security fixes on the HR-documents
  surface", tell me and I will re-cut. Phase 1 does not start until the breakdown is confirmed.
- Audited-action names in §4.6 are proposals for the same reason.

## 1. Where reality differs from the brief (consequences)

| Brief | Reality | Consequence |
|---|---|---|
| D1 "no KB module exists, build a minimal one" | A large KB exists | **Extend it; build no KB.** Only a linked-document entity and its read surface are new |
| `tenant_id` | `org_id` | Every new table: `org_id text NOT NULL`, `UNIQUE(org_id,id)`, RLS `tenant_isolation` |
| Flags `hrms.kb.*` | No mechanism | Three booleans on `kb_settings` (§4.5) |
| `kb.hr_documents.publish` | Key grammar is `module:resource:action` | `hr:documents:publish` |
| Signed URL 300 s | Already so | Reuse the mechanism, do not reinvent it |
| Import dedupe (D12) | Already shipped provisionally, with defects | Harden it (PR 6); unique index stays BLOCKED |
| "Approve v2" | No version/approval model exists | Minimal version table (§3.6) |
| `requestId` | `correlationId`, with no UI | New shared UI element only |
| D3/D4 | Org Admin and HR-module *members* already read all documents | Honoured on the **KB path** only; not enforceable by permission on `/hr/documents` (BLOCKED, §6) |

## 2. Non-negotiable properties

1. **Fail closed.** Every existing document becomes `PERSONAL` when the column lands. Nothing is publishable until a
   human with `hr:documents:publish` classifies it.
2. **Exclusion by construction, not by filtering.** Linked entries live in **their own tables and their own read
   surface**. They are *not* `kb_pages` rows. Every existing KB reader (pages, full-search, Ask, chunks, exports,
   public tokens, duplicate, versions, helpdesk suggest, the legacy chunk predicate) is therefore blind to them without
   a single change — the alternative (a marker on `kb_pages`) would require every one of those readers, including the
   ones that bypass the canonical predicate, to remember to exclude it (Phase 0 §5 K-03, K-05, K-07, K-08).
3. **Live guard on every read.** A linked entry is readable only if, *in the same SQL statement*, the source document is
   `is_active`, publishable, and the caller is in the audience. Revocation is therefore immediate: no cache, no queue.
4. **Defence in depth for PERSONAL** (four independent layers; any one is enough, all four are tested):
   L1 service guard · L2 database trigger · L3 read-time join · L4 reconciliation gate (§4.7).
5. **Flags OFF ⇒ nothing changes.** Routes answer 404 as if absent; no link rows can be created; nothing is indexed.

## 3. Design

### 3.1 Data model (all new, all under `src/db/schema/kb/` except where noted)

**Columns added to `documents`** (nullable-then-default per BE-61; the table is hot, so additive only):
- `classification document_classification NOT NULL DEFAULT 'PERSONAL'` — enum `PERSONAL | CONFIDENTIAL | RESTRICTED | INTERNAL`.
- `effective_date date NULL` — shown on the badge.
- Audience for the *document* (the ceiling) is stored in `hr_document_audiences`, below.

Classification is a **new column, never a new `type` value**: the frontend enum-locks `type` and one unknown value fails the
whole list parse.

**`document_audiences`** `(id, org_id, document_id, kind, ref_id, created_by, created_at)` — `kind ∈ ALL_EMPLOYEES |
DEPARTMENT | LOCATION`; `ref_id` is an `org_units`/location id (null for `ALL_EMPLOYEES`). No rows = **HR-only**.
Composite FK `(org_id, document_id)` → `documents`. **Not named `hr_*`**: HR's `hr_*` table count is frozen
(`check:hr-table-freeze`), and `job_templates` set the precedent of naming a domain table without the prefix. **As built:** the gate
counts by schema directory, not by name, so `document_audiences` and `document_versions` are recorded in its `APPROVED_EXCEPTIONS`
with reasons (a set of (kind, ref) pairs and a many-row history fit neither "an existing lifecycle column" nor "a custom field").

**`kb_linked_documents`** `(id, org_id, document_id NULL, version_mode, pinned_version NULL, status, space_id NULL,
published_by_membership_id, published_at, unpublished_by_membership_id, unpublished_at, unpublish_reason,
source_removed_at, created_at, updated_at)`
- `status ∈ active | unpublished | source_removed`; `version_mode ∈ FOLLOW_LATEST | PINNED`.
- `UNIQUE(org_id, document_id) WHERE status = 'active'` (one live link per document).
- Composite FK `(org_id, document_id)` → `documents ON DELETE SET NULL (document_id)` (column-list form; a bare
  `SET NULL` on a composite key nulls `org_id` and aborts the delete). A hard-deleted source becomes `source_removed`.
- `space_id` is **browse grouping only**; it never grants access.

**`kb_linked_document_audiences`** `(org_id, linked_document_id, kind, ref_id)` — the *link's* audience, which must be a
subset of the document's (§3.4).

**`document_versions`** `(id, org_id, document_id, version, file_url, file_name, file_size, mime_type, status,
effective_date, uploaded_by_membership_id, approved_by_membership_id, approved_at)` — `status ∈ pending | approved |
rejected`. `documents` keeps holding the **current approved** file, so `GET /hr/documents/:id/file` and every existing
reader are unchanged (§3.6).

**`kb_settings`** gains `hrms_kb_link_enabled`, `hrms_kb_search_enabled`, `hrms_kb_ai_enabled` — `boolean NOT NULL
DEFAULT false`.

**Migrations as built (four, not the two or three first estimated):** `1198` (`documents.classification`, `effective_date`),
`1199` (`document_audiences`, `document_versions`), `1200` (`kb_linked_documents`, `kb_linked_document_audiences`, the three
`kb_settings` switches), `1201` (`app.hr_document_is_publishable`, the link guard and the unlink trigger). All hand-authored, journalled
(idx 1082–1085; renumbered from 1197–1200 on merge, because `main` took 1197 for `1197_build_cycle_permissions` while the chain was open), each with a rollback; every one of the 15 `NOT VALID` foreign keys is validated inside its own migration.

Every table: `ENABLE ROW LEVEL SECURITY` + explicit `tenant_isolation` policy (BE-72/74), grants to `streamline_app`,
composite tenant FKs added `NOT VALID` then validated (BE-62), `lock_timeout`, a rollback file, journal entry, Drizzle
declaration (the `check:declaration-*-drift` gates compare it to the database).

### 3.2 Publishability — one definition, four enforcement points

A document is **publishable** iff *all* hold:

```
classification IN ('INTERNAL','RESTRICTED')
AND (user_id IS NULL OR user_id = uploaded_by)          -- company-level: nobody's file but the uploader's own
AND type IN ('POLICY','OTHER')                          -- allowlist, not a denylist
AND is_active
AND metadata is not a recruitment/onboarding artefact   -- no candidateId / onboarding source keys
```

- **Why the owner rule is not just `user_id IS NULL`** (found while writing PR 1): `POST /hr/documents` assigns the
  *uploader* as owner when no employee is chosen, and the CSV import cannot express a company-wide row at all, so an
  HR-uploaded handbook has `user_id = uploaded_by`. A row owned by a **different** user, or with an owner and no
  recorded uploader (import, onboarding, recruitment handoff), is that person's file. This is the same rule PR 1 uses
  for `is_public` (`isCompanyLevelDocument` / `companyLevelDocumentSql` in `documents-helpers.ts`); the link layer reuses
  it rather than restating it.
- `CONFIDENTIAL` is never publishable in v1 (D5). `PERSONAL` never, by anyone, including Org Owner.
- A stored file must sit under `documents|hr-documents|hr`; an external `https` `fileUrl` is linkable as **metadata only**
  (D7) and its entry has no *Open* action.
- **L1 service**: `assertPublishable(document)` throws `DOCUMENT_NOT_PUBLISHABLE` (HTTP 422) *and writes a refusal audit
  row outside the request transaction*.
- **L2 database**: a `BEFORE INSERT OR UPDATE` trigger on `kb_linked_documents` re-evaluates the definition against
  `documents` and raises; an `AFTER UPDATE OF classification, user_id, uploaded_by, type, is_active, metadata` trigger on
  `documents` (only on the *transition* from publishable to not) sets any active link for that document to `unpublished`/`source_removed`
  and writes the audit row `kb.hr_link.auto_unpublished`. This catches writers that never
  touch the new code — notably the CSV import, which can update `type` on a match.
- **L3 read**: every read query joins `documents` and repeats the predicate (§3.5). **As built this also masks what an entry says about
  its document**: for a withdrawn entry whose document is no longer shareable, name, description, category, tags, type, dates, version and
  file details are returned as null even to a publisher, and word search requires the document to be shareable now (found by the PR 8
  matrix: a publisher could otherwise read a now-personal document's name through the withdrawn-entry routes).
- **L4 reconciliation**: §4.7.

Moving a document *into* `INTERNAL`/`RESTRICTED` needs `hr:documents:publish`; moving it *up* to `CONFIDENTIAL`/`PERSONAL`
needs only `hr:documents:manage`. So a manage-holder cannot bypass the publish gate by classifying.

### 3.3 Classification defaults for existing rows (D13)

The column default makes everything `PERSONAL`. The **backfill** (§4.9) proposes a classification and audience for rows
that already look company-level (`user_id IS NULL`, `type IN ('POLICY','OTHER')`), preserving today's effective
visibility: `ALL_EMPLOYEES` only if all members can read company documents today, otherwise HR-only. It writes proposals
and **never publishes**.

### 3.4 Audience model

Kinds: `ALL_EMPLOYEES`, `DEPARTMENT`, `LOCATION`, or none (HR-only). An employee is in a `DEPARTMENT`/`LOCATION` audience
when their **live employment** (`hr_employments`, not soft-deleted, lifecycle `ACTIVE|PROBATION|CONFIRMED|NOTICE`,
primary first) carries that `department_id`/`location_id`. Mapping: caller `user_id` → `hr_people` → `hr_employments`.
`ALL_EMPLOYEES` means every such employee, not every org member.

- **Widening is blocked**: a link's audience must be a subset of the document's. A department link under a department
  document is fine; `ALL_EMPLOYEES` under a `DEPARTMENT` document → `AUDIENCE_EXCEEDS_DOCUMENT` (422) with a clear message.
- **Audience changes on the document narrow its links in the same transaction** (rows outside the new ceiling are
  removed), and the read guard re-checks anyway.
- Who may see an active entry regardless of audience: holders of `hr:documents:publish` (so publishers can verify what
  employees see). **Org Owner/KB admin get no bypass to restricted entries** beyond that — the whole point of exclusion by
  construction. (An Org Admin holds every key, so they hold `hr:documents:publish` structurally; that is the honest
  boundary of D2/D3 and is listed in §6.)

### 3.5 KB read surface (new, self-contained; all behind `hrms_kb_link_enabled`)

| Route | Permission | Behaviour |
|---|---|---|
| `GET /kb/linked-documents?q=&status=&cursor=&limit=` | `kb:pages:view` (every member; `status` other than `active` is for publishers) | Audience + live guard in SQL. `q` is full-text over `name`, `description`, `category`, `tags` **computed at read time from the joined document** — there is no denormalised copy to go stale, so v2 metadata is visible immediately. Requires `hrms_kb_search_enabled` for `q`; without it the list is browse-only |
| `GET /kb/linked-documents/:id` | `kb:pages:view` | Detail + source badge. **404** for anyone outside the audience (BE-91), also for cross-tenant ids |
| `POST /kb/linked-documents/:id/open` | `kb:pages:view` | Authorises via the link, then reuses the storage path: `parseStorageKey`, foreign-org refusal, folder allowlist, `getFileUrl(..., 300, …, { preauthorized: true })`, attachment disposition. `Cache-Control: no-store`. Audit `kb.hr_link.document_opened` (outside the transaction). The URL is **never** logged |

Pagination: cursor keyset, `pageSizeField`, `limit ≤ 100`. Each new file gets an entry in the unbounded-reads
classification.

Frontend: KB search shows a separate **Company documents** group beside page results (own cursor, not merged into the page
cursor — merging two sources' cursors is where bugs live), with the source badge; a detail route
`/knowledge/documents/[linkId]`. The badge is a shared component on `SemanticBadge` (cross-feature import baseline is 0).

### 3.6 Versions and approval (D6: follow latest approved)

`POST /hr/documents/:id/versions` uploads v(n+1) as `pending`; `POST …/versions/:n/approve` (needs `hr:documents:publish`
or `manage` — decided in PR 4) atomically: marks it approved, copies `file_url/file_name/size/mime/effective_date` and the
new `version` onto the `documents` row, and audits. A `FOLLOW_LATEST` link therefore follows the `documents` row and needs
no propagation. A `PINNED` link resolves its `pinned_version` from `document_versions`; HR sees "newer version
available" when an approved version above the pin exists.

### 3.7 Deletion (D11)

Soft-deleting a document (`is_active = false`) hides the entry from readers **immediately** via the live guard; the L2
trigger marks the link `source_removed`. Publishers see "Source removed" for 30 days; the purge then deletes the link and its audience
rows and audits `kb.hr_link.purged`. **As built** it is a step inside the existing scheduled `kb-trash-purge` sweep
(`CronKbService.purgeExpiredTrash`: `forEachOrg`, lease, retention scheduler), so there is no new job, endpoint or schedule entry; it is
bounded at 200 per organisation per run and restates status and age on the delete. Hard deletes by the retention cron take the `ON DELETE SET NULL (document_id)` path to the same state.

### 3.8 Search and AI (D9)

- **v1 is metadata search.** Nothing in this project extracts, chunks or embeds any HR file's text, and nothing writes to
  `kb_article_chunks`. This is a deliberate scope call: it makes "no PERSONAL text reaches a chunk or an LLM" true by
  construction, and matches D7/D9. Content-level search is listed as BLOCKED (§6).
- **`hrms_kb_ai_enabled`**: the existing assistants (Ask OS `searchKnowledgeBase`, `KbAskService`) gain one *opt-in*
  retrieval source — `KbLinkedDocumentQueryService.searchForCaller(caller, q)` — that returns title, badge fields and the
  entry link **only for entries the caller can open**, enforced in SQL (BE-96), and cites them as kind `document`.
  Non-audience callers get no result and no citation. No new model vendor, no new prompt path.
- **SEC-04 is fixed in PR 1**, otherwise a personal file could still reach a KB chunk through the support-article
  attachment route regardless of this design.

### 3.9 Import (D12) and backfill

PR 6 hardens `commitDocument` (Phase 0 SEC-06): unresolved employee is a **row error**, not an org-wide document; email
match case-insensitive; the lookup considers `is_active` explicitly; SQL and TS normalise names identically (**as built:** one expression,
`lower(btrim(regexp_replace(v, '[[:space:]\u00a0]+', ' ', 'g')))`, applied to both the stored column and the incoming value; no generated
column was added, so no migration); exact match ⇒ `unchanged`; blank cell does not erase
a stored expiry; `created/updated/unchanged` counts reach the API and the wizard; the "committed successfully" toast stops
appearing for a `failed` job. The unique partial index on `(org_id, user_id, category, name_normalized) WHERE is_active`
ships only after the census shows zero duplicates — **BLOCKED** until then.

The backfill is `POST /hr/documents/kb-link/backfill {dryRun}`: dry-run is the default, prints counts and changes
nothing, is resumable (**as built:** a stateless keyset cursor, the last document id, that the caller sends back; no job table), is behind `hrms_kb_link_enabled`, audits each run, and never
publishes.

## 4. Cross-cutting

### 4.1 Permission
`hr:documents:publish` (module `hr`, non-scopable — publishing is organisational authority). Added to the backend catalog
and the frontend union together (BE-112), catalogs regenerated. It reaches Org Owner/Admin and `HR_MODULE_OWNER`/`ADMIN`
automatically; **not** `HR_MODULE_MEMBER` (which only gets `:view|:read` keys). Add to `HR_ADMIN` via the role template and
let the reconciler converge at boot; **no backfill migration** (BE-111).

### 4.2 Routes
`@RequireModule("hr")` on HR routes, `@UseGuards(JwtAuthGuard, PermissionGuard)` + `@RequirePermission`, `@Idempotent(
"hr.document.kb-publish")` on publish/unpublish/approve, a `TIERS` rate-limit entry, `@ResponseSchema`, `.strict()`
boundaries, `@CurrentUser()` identity. KB routes carry **no** `@RequireModule("kb")` (pinned by `kb-module-gate.spec`).

### 4.3 Errors
Domain codes inline, SCREAMING_SNAKE: `DOCUMENT_NOT_PUBLISHABLE` (422), `AUDIENCE_EXCEEDS_DOCUMENT` (422),
`LINK_ALREADY_ACTIVE` (409). Flag off ⇒ 404. The QA line "errors show a message and a copyable request id" needs new
shared UI: the wire field is `correlationId`; `ErrorState`/`PageState` get a reference line with a copy control fed by
`getCorrelationId(error)` (plus a `UI-KIT.md` row, per FE-62).

### 4.4 Tenant safety
Every query carries `org_id` from `@CurrentUser()`; cross-tenant ids are **404**, never 403 (BE-91). A `*-tenant-isolation`
spec per new service (a repo gate requires one) plus one cross-tenant HTTP e2e over every new route with two seeded orgs.

### 4.5 Flags
`hrms.kb.link` ⇒ `kb_settings.hrms_kb_link_enabled`; `hrms.kb.search` ⇒ `…_search_enabled` (requires link);
`hrms.kb.ai` ⇒ `…_ai_enabled` (requires search). Read **uncached** (one indexed row) on the new routes, so turning a flag off
takes effect on the next request. Toggle: `PATCH /kb/settings/hr-link-flags`, `kb:settings:manage` (Org Admin only) and the
HR module must be enabled; audited `kb.hr_link.setting_updated`. Employees cannot read `/settings/*`, so the frontend gets
effective flags from `GET /kb/hr-link/config` (every member); the admin reads `GET /kb/settings/hr-link-flags` (stored, effective, HR enabled). The unused
`feature_flags` table is deliberately not used.

### 4.6 Audit
Awaited `logCritical` inside the mutation transaction; `logCriticalOutsideTransaction` for reads and refusals. Proposed
actions: `hr.document.classified`, `hr.document.audience_changed`, `hr.document.kb_published`,
`hr.document.kb_link_updated`, `hr.document.kb_unpublished` (with reason), `hr.document.version_uploaded`,
`hr.document.version_approved`, `kb.hr_link.document_opened`, `kb.hr_link.publish_refused`,
`kb.hr_link.setting_updated`, `kb.hr_link.backfill_run`, `kb.hr_link.purged`. **As built**, `kb.hr_link.source_removed` does not exist as a
separate action: the database trigger writes `kb.hr_link.auto_unpublished` for both "unpublished" and "source removed". The new
services are added to `HRMS_MUTATION_SERVICES` in `hrms-critical-audit-invariants.spec.ts`. Signed URLs and storage keys
are never placed in metadata.

### 4.7 The PERSONAL proof

**Matrix (table-driven, DB-backed, two tenants):** every `type` (8) × ownership (person / company) × classification (4) ×
`is_public` × `is_active` × file shape (stored / external) × caller (owner, org admin, HR admin, manager, in-audience
employee, out-of-audience employee, other-tenant admin) × surface (publish API, link row, list, search, detail, open,
AI retrieval, chunk existence). Expected result for every PERSONAL cell is *absent / refused*; for every other cell it is
computed from §3.2/§3.4, so the test cannot agree with a bug by being copied from the implementation.

**Reconciliation check** (`pnpm check:hr-kb-invariants`, DB-backed, exit 2 when its prerequisite is unmet like the other DB
gates, run in CI and runnable against any environment read-only) asserts: every active link's document is publishable;
no link exists for a `PERSONAL`/`CONFIDENTIAL`/person-owned document; `kb_linked_document_audiences ⊆ document_audiences`;
**no `kb_article_chunks`, `kb_page_attachments`, `kb_sources` or `kb_ingestion_checkpoints` row references a key under a
sensitive folder root or equal to any `documents.file_url`**; no chunk has `source` outside the known set. **As built:** the env var is `HR_KB_DATABASE_URL` (a table owner or BYPASSRLS role, with `row_security = off`
so a filtered role fails loudly), `--org=<id>` scopes it, and it is read-only in a repeatable-read transaction. CI runs its self-test
(48 assertions planting every class) and the DB-spec tier runs the real script against a seeded organisation; it is an *operator* gate
against real tenant data, so `check-gate-wiring` lists it with that reason. The `is_public` census stayed in the Phase 0 census script.
The matrix is `kb-linked-documents-personal-matrix.db.spec.ts`: 1,280 documents through publish, direct link write, list, word search,
assistant retrieval, another tenant, and seven ways of degrading a shared document (each again with the unlink trigger off).

## 5. Proposed PR breakdown (to be reconciled with the brief's §§1–13)

| # | Repo | Content | Migrations | Flag | Depends |
|---|---|---|---|---|---|
| 0 | BE | This plan, findings, census SQL | — | — | — |
| 1 | BE | **Security**: SEC-01 (`isPublic` honoured only on company-level documents, on read and write), SEC-02/03 (scope on rich-documents, letters, template renders), SEC-04 (sensitive roots refused at KB attachment ingestion **and** at indexing read; existing offending attachments/chunks are only *reported* by a read-only query — nothing is deleted from your KB without your explicit approval), SEC-05 (ack recipients must be members; de-dupe) | **none** — a `CHECK` on `is_public` would fail every unrelated `UPDATE` (the expiry cron included) of a legacy row that already violates it, so the DB-level constraint waits for the census and a data decision | none | — |
| 2 | BE | Schema + inert plumbing: `classification`, audiences, links, versions, `kb_settings` flags, `hr:documents:publish`, L2 triggers, audit registrations | 2–3 | all OFF | 1 |
| 3 | BE+FE | Classification API + HR UI (classify, audience), `DOCUMENT_NOT_PUBLISHABLE`, shared error reference UI | — | `link` | 2 |
| 4 | BE+FE | Publish/unpublish/link service, versions + approve, KB list/detail/open, source badge, "newer version"/"Source removed" | — | `link` | 3 |
| 5 | BE+FE | Search group in KB search; AI opt-in retrieval; assistants made access-safe | — | `search`,`ai` | 4 |
| 6 | BE+FE | Import hardening (SEC-06), counts in API/UI; census-gated unique index (**BLOCKED**) | 0–1 | — | 1 |
| 7 | BE | Backfill (dry-run first, resumable, never publishes); purge cron for `source_removed` | — | `link` | 4 |
| 8 | BE+FE | Matrix, reconciliation gate, cross-tenant e2e, QA checklist with real routes, `REPORT.md` | — | — | 1–7 |

### 5.1 As built

| PR | Backend | Frontend | Differs from the proposal |
|---|---|---|---|
| 0 | #46 | — | — |
| 1 | #45 | — | as proposed; no migration |
| 2 | #48 | #194 | **four** migrations (1198–1201), not two or three; the switches and the permission landed here with the schema |
| 3 | #49 | #195 | as proposed |
| 4 | #50 | #196 | as proposed; versions and approval included |
| 5 | #51 | #197 | assistants opt in per call site *and* per tenant (the support Ask response schema has no `document` kind) |
| 6 | #52 | #198 | stacked on PR 5, not on PR 1 (to avoid a contract regeneration conflict); no generated column |
| 7 | #53 | #199 | purge folded into `kb-trash-purge`; stateless backfill cursor instead of a job row |
| 8 | #54 | #200, #201 | matrix, gate, e2e, `REPORT.md`, **plus two gaps the proof found**: a withdrawn entry leaked its now-personal document's details to publishers (fixed by masking), and unpublish could not take the reason the QA checklist asks for (added, with its screen in FE #201) |

**Coordination.** PR 1 and PR 6 touch files the HRMS-remediation session is also editing
(`hr/import/*`, `hr/performance/documents*`). I will branch from a fresh `origin/main` for each, keep diffs surgical, and
tell that session which lines I am changing before I push, rather than discover a conflict afterwards.

## 6. BLOCKED / not deliverable as briefed

| Item | Why | Unblocks when |
|---|---|---|
| Unique index on the D12 key | No live duplicate counts; index would abort or destroy rows | Someone with read access runs the census script; zero duplicates, or an approved cleanup |
| Live tenant tenant-ID / duplicate census | `.env` DB is IAM-authenticated RDS; not queried without explicit go-ahead | You run the script, or approve read-only IAM access for this task |
| Rich-document handbooks as a source | `rich_documents` mixes personal letters with company handbooks and has no owner or classification column | A `classification` (default `PERSONAL`) column on `rich_documents` and a classification pass |
| Content-level search / AI over file text | D7/D9; would need extraction, chunk ACLs and a leak review | A separate approved project on top of this one |
| D3 on `/hr/documents` (org admin cannot read personal docs) | Org Admin holds every key structurally; `HR_MODULE_MEMBER` holds `documents:view@all` | A product decision to change those grants (a behaviour change beyond this project) |
| CI run links in the report | Measured 2026-09-25 with `gh run list`/`view` on `Startupppp/streamlineos-backend`: the latest runs on `main` (`ci.yml`, *Database gates*, *Legacy Actor Ratchet*) conclude `failure` with **zero jobs** ("likely a workflow file issue"). No PR can show a green CI run, so the report will cite local gate output instead and say so | Whoever owns the workflows/runner fixes it |
| Green `check:migration-chain` on `main` | Cold build fails at `1155` and `1174` (other lanes) | Those lanes repair them |
| A separate audience on an entry, in the UI | The API narrows an entry inside its document's audience; the UI has no control for it | Product decides it is wanted |
| Browser QA, assistants against a model, real-storage URL expiry, a live run of `check:hr-kb-invariants` | Not exercised in this project; see `REPORT.md` §3 | A person runs the checklist in `REPORT.md` §7 |

## 7. Provisional defaults applied (§14)

| # | Applied | Note |
|---|---|---|
| D1 | **Not applied as written** — the KB exists; extend it with linked-document entries, browse, search | §1 |
| D2 | `hr:documents:publish`; held by Org Owner/Admin and HR Module Owner/Admin, plus explicit grants | Org Admin holds it structurally |
| D3 | On the KB path nobody sees a personal document, Org Owner included. `/hr/documents` unchanged | §6 |
| D4 | Same: managers get nothing on the KB path; `team` scope already collapses to `own` in HR documents | verified |
| D5 | `CONFIDENTIAL` is never publishable; no HR-only space in v1 | — |
| D6 | `FOLLOW_LATEST` default; `PINNED` optional | — |
| D7 | External `fileUrl` ⇒ metadata-only entry, no *Open*, never fetched or indexed | — |
| D8 | 300 s, attachment | already the behaviour |
| D9 | Existing assistants gain an opt-in, SQL-filtered, metadata-only source; no new vendor | §3.8 |
| D10 | Keep audit forever; no purge job | matches the table's retention |
| D11 | Hidden immediately; "Source removed" for 30 days; then purged by a cron endpoint | §3.7 |
| D12 | Provisional key already shipped; unique index BLOCKED | §6 |
| D13 | Backfill preserves today's effective visibility; never publishes | §3.3 |
| D14 | Unchanged. Employees upload today through `POST /onboarding/documents` (universal, `self:onboarding-docs`), which writes a `documents` row with `user_id` set; that route is not touched. Such rows are `PERSONAL` by the column default *and* fail the `user_id IS NULL` rule | agent-read |

## 8. Verification approach

- Backend: `pnpm typecheck` **and** `typecheck:test`, lint, and every gate named by a rule I touch, `:self-test` first.
  Capped runners only (3 jest workers, `nice`, always with `--testPathPattern`); one heavy command at a time; a 12 GB heap for
  `tsc`.
- DB-backed specs run against a cold-built local database as a **non-owner** role (a dedicated login role that is a member
  of `streamline_app`), because running as the owner hides every RLS defect. Never against the RDS instance or the shared
  Neon branch.
- Every new route: authorisation tested with two accounts in two orgs; denial is 404 cross-tenant, 403 in-tenant.
- Frontend: `type-check`, `type-check:specs`, lint, `check:*` gates, then the flow in a real browser (mint a session cookie,
  force dark mode) before I call any UI done.
- I will state explicitly what I did **not** run.

## 9. QA re-test checklist

Filled in with real routes, automated evidence and what only a person can check in [`REPORT.md`](./REPORT.md) §7, using the brief's list verbatim.
