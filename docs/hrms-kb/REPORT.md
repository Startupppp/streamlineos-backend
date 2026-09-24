# HRMS → Knowledge Base linking — Final report

Written 2026-09-25 at the end of PR 8. The plan is [`PLAN.md`](./PLAN.md); the Phase 0 evidence is
[`PHASE0-FINDINGS.md`](./PHASE0-FINDINGS.md). Every number below was measured in this project's own runs and says where;
anything not measured says so under **BLOCKED / not verified**. **Nothing has been merged to `main`.** All PRs are open,
stacked, and waiting for a decision (see §1).

The brief received to me covered the acceptance criteria, this report's format, the QA checklist and §14. Its §§1–13 (goals,
phase list, PR breakdown, the listed audited actions) were never received, so the PR breakdown and the audit-action names
are my proposals (PLAN §0, §5).

---

## 1. PRs

CI: **no run link exists for any of them.** On 2026-09-25 the latest runs of `ci.yml`, *Database gates* and *Legacy Actor
Ratchet* on `main` conclude `failure` with **zero jobs** ("likely a workflow file issue"), so no PR can show a green run.
Local gate output is cited instead. "Merge commit" is empty because nothing is merged.

Backend — `Startupppp/streamlineos-backend`

| PR | Title | Base | State |
|---|---|---|---|
| [#46](https://github.com/Startupppp/streamlineos-backend/pull/46) | docs(hrms-kb): Phase 0 plan, findings and read-only duplicate census | `main` | open |
| [#45](https://github.com/Startupppp/streamlineos-backend/pull/45) | fix(hr,kb): close five HR-document exposure paths (PR 1) | `main` | open |
| [#48](https://github.com/Startupppp/streamlineos-backend/pull/48) | feat(hrms-kb): classification, audiences, linked-document tables, publish permission and switches (PR 2) | #45 | open |
| [#49](https://github.com/Startupppp/streamlineos-backend/pull/49) | feat(hr): classify HR documents and set who they are for (PR 3) | #48 | open |
| [#50](https://github.com/Startupppp/streamlineos-backend/pull/50) | feat(kb,hr): publish HR documents to the knowledge base and read them there (PR 4) | #49 | open |
| [#51](https://github.com/Startupppp/streamlineos-backend/pull/51) | feat(kb): find linked HR documents by their words, and let the assistants cite them (PR 5) | #50 | open |
| [#52](https://github.com/Startupppp/streamlineos-backend/pull/52) | fix(hr-import): a document row that names nobody is an error, not a company document (PR 6, SEC-06) | #51 | open |
| [#53](https://github.com/Startupppp/streamlineos-backend/pull/53) | feat(kb): backfill classifications for existing HR documents, and purge removed-source entries (PR 7) | #52 | open |
| [#54](https://github.com/Startupppp/streamlineos-backend/pull/54) | test(kb): prove no personal document reaches the knowledge base; reconciliation gate; withdraw with a reason (PR 8) | #53 | open |

Frontend — `Startupppp/streamlineos-frontend`

| PR | Title | Base | State |
|---|---|---|---|
| [#194](https://github.com/Startupppp/streamlineos-frontend/pull/194) | feat(rbac): `hr:documents:publish` in the frontend catalog + re-vendored contracts (FE PR 2) | `main` | open |
| [#195](https://github.com/Startupppp/streamlineos-frontend/pull/195) | feat(hr): classify documents and choose who may see them (FE PR 3) | #194 | open |
| [#196](https://github.com/Startupppp/streamlineos-frontend/pull/196) | feat(kb): company documents in the Knowledge Base, and the HR side that feeds them (FE PR 4) | #195 | open |
| [#197](https://github.com/Startupppp/streamlineos-frontend/pull/197) | feat(kb): search company documents, and let the assistants cite them (FE PR 5) | #196 | open |
| [#198](https://github.com/Startupppp/streamlineos-frontend/pull/198) | feat(hr): say what an import did, and why a row failed (FE PR 6) | #197 | open |
| [#199](https://github.com/Startupppp/streamlineos-frontend/pull/199) | feat(hr): classify the documents you already have, from the Document Library (FE PR 7) | #198 | open |
| [#200](https://github.com/Startupppp/streamlineos-frontend/pull/200) | feat(kb): say why a withdrawn company document shows no details (FE PR 8) | #199 | open |
| [#201](https://github.com/Startupppp/streamlineos-frontend/pull/201) | feat(hr): take a document out of the Knowledge Base with a reason (FE PR 9) | #200 | open |

Two chains, each stacked on its own first PR, and the two repos pair by capability (backend #49–#54 ↔ frontend #195–#201).
**Merge order:** #46 and #45 (independent, both onto `main`), then #48 → #54 in order; frontend #194 → #201 in order. A stacked
PR must be retargeted to `main` after its base merges. Backend PR 1 (#45) is security-only and needs no migration; it is the
one that can and probably should go first on its own.

---

## 2. What shipped, by capability

**Flags.** All three default **OFF** for every organisation. Stored on `kb_settings` (migration 1199), read **uncached** on
every new route so turning one off takes effect on the next request; each needs the one before it and the HR module.

| Brief's name | Stored as | Toggle | Read |
|---|---|---|---|
| `hrms.kb.link` | `kb_settings.hrms_kb_link_enabled` | `PATCH /kb/settings/hr-link-flags` (`kb:settings:manage`; audited `kb.hr_link.setting_updated`) | `GET /kb/hr-link/config` (every member); `GET /kb/settings/hr-link-flags` (admin: stored, effective, HR enabled) |
| `hrms.kb.search` | `…_search_enabled` (needs `link`) | same | same |
| `hrms.kb.ai` | `…_ai_enabled` (needs `search`) | same | same |

With every flag OFF, every new route answers **404** as if absent, no link row can be created, nothing is indexed, and no new
UI renders (proved: seeded e2e "is off by default" and the frontend tests). The only behaviour changes with flags off are PR 1's
security fixes and PR 6's import hardening (both listed below and both intended).

| Capability | What it does | Where |
|---|---|---|
| **Security fixes** (no flag) | SEC-01 `isPublic` honoured only on company-level documents (read and write); SEC-02/03 scope on rich documents, letters and template renders; SEC-04 sensitive folder roots refused at KB attachment ingestion **and** at indexing read (existing offending rows are only *reported*, nothing deleted); SEC-05 acknowledgment recipients must be members, de-duplicated | BE #45 |
| **Permission** | `hr:documents:publish` (module `hr`, not scopable), in both catalogs, held by Org Owner/Admin and `HR_MODULE_OWNER`/`ADMIN` and the `HR_ADMIN` template via the role reconciler — no backfill migration | BE #48, FE #194 |
| **Classification** | Every document is `PERSONAL` by column default. HR sets `PERSONAL / CONFIDENTIAL / RESTRICTED / INTERNAL` and who it is for (all employees, departments, locations; none = HR only). Moving *into* Internal/Restricted needs `hr:documents:publish`; moving *up* needs only `manage`. Reasons a document cannot be shared are one list, used by the server and shown in the UI | BE #49, FE #195; `PATCH /hr/documents/{documentId}/classification`, `PUT …/audiences` |
| **Publish and read** (`link`) | A linked entry is its **own entity**, never a `kb_pages` row. Add / re-scope / withdraw / bring back (same id), versions with approval (`FOLLOW_LATEST` default, optional `PINNED`, "newer version available" to HR), a Company documents area in the Knowledge Base with a source badge, detail, and *Open* (signed URL **300 s**, attachment, `no-store`, never logged, audited without the URL). "Source removed" for 30 days | BE #50, FE #196; `…/kb-link`, `…/versions`, `GET /kb/linked-documents[/{id}]`, `POST …/open` |
| **Search** (`search`) | The same list with `q`: full text over name, description, category and tags **of the joined document at read time** (no copy to go stale). Metadata only | BE #51, FE #197 |
| **AI** (`ai`) | The existing assistants (Ask KB, Ask OS) gain one opt-in source: linked entries the *asker could open*, filtered in SQL, cited as kind `document`, citations re-verified on replay and stream. Metadata only; no new vendor | BE #51, FE #197 |
| **Import hardening** | A document row that names nobody is a row **error**, not an organisation-wide document; case-insensitive match on active rows; one normaliser in SQL and TypeScript; exact match ⇒ `unchanged`; `created/updated/unchanged` counts reach the API and the wizard | BE #52, FE #198 |
| **Backfill** (`link`) | `POST /hr/documents/kb-link/backfill`: **dry run by default**, resumable by cursor, proposes Internal (all employees only if it was public today, else HR only), never publishes, never overwrites HR's choice, audited per run | BE #53, FE #199 |
| **Purge** | Entries whose source was removed > 30 days ago are deleted (with audiences) inside the existing scheduled `kb-trash-purge` sweep, bounded, audited per organisation | BE #53 |
| **Proof** | The personal-document matrix, `pnpm check:hr-kb-invariants`, HTTP e2e | BE #54 |
| **Withdraw with a reason** | `DELETE …/kb-link` takes an optional `{ reason }`, stored and audited | BE #54, FE #201 |

**Audit rows** (each written in the mutation's transaction, or outside it for reads and refusals; signed URLs and storage keys
never appear): `hr.document.classified`, `hr.document.audience_changed`, `hr.document.kb_published`,
`hr.document.kb_link_updated`, `hr.document.kb_unpublished` (with reason), `hr.document.version_uploaded`,
`hr.document.version_approved`, `kb.hr_link.document_opened`, `kb.hr_link.publish_refused`, `kb.hr_link.setting_updated`,
`kb.hr_link.backfill_run`, `kb.hr_link.purged`, `kb.hr_link.auto_unpublished` (written by the database trigger when a shared
document stops being shareable; it covers both "unpublished" and "source removed", so the `kb.hr_link.source_removed` I
proposed in PLAN §4.6 does not exist as a separate action).

**Four independent layers keep a personal document out** (PLAN §3.2), each with its own tests: (1) the publish service
refuses with `DOCUMENT_NOT_PUBLISHABLE` and audits the refusal; (2) a database trigger refuses a link row for an unshareable
document and unlinks a shared one in the same transaction the moment it stops being shareable; (3) every read re-checks
`app.hr_document_is_publishable` in the same SQL statement; (4) `check:hr-kb-invariants` asks the database after the fact.
Plus a fifth by construction: nothing in this project extracts, chunks or embeds any HR file, and a linked entry is not a
page, so every existing KB reader is blind to it.

---

## 3. BLOCKED, and not verified

**BLOCKED** — could not be delivered as briefed.

| Item | Why | Unblocks when |
|---|---|---|
| Unique index on the D12 import key | No live duplicate counts; the index would abort or destroy rows. The census script is ready (`docs/hrms-kb/sql/phase0-duplicate-documents.sql`) | Someone with read access runs it; zero duplicates, or an approved cleanup; then a *partial* unique index (`WHERE is_active`) |
| Live tenant census and tenant-ID check on real rows | `streamlineos-backend/.env` points at an IAM-authenticated RDS instance; minting a token from personal AWS credentials against a live database is not done unprompted | You run the read-only scripts, or approve read-only access for this task |
| Rich-document handbooks as a source | `rich_documents` mixes personal letters with handbooks and has no owner or classification column | A `classification` (default `PERSONAL`) column on `rich_documents` and a classification pass |
| Content-level search and AI over file text | D7/D9; needs extraction, chunk ACLs and a leak review | A separate approved project on top of this one |
| D3 on `/hr/documents` (org admin cannot read personal documents) | Org Admin holds every key structurally and `HR_MODULE_MEMBER` holds `hr:documents:view` at `all`. Honoured **on the KB path only** | A product decision to change those grants |
| CI run links | CI has no runner (§1) | Whoever owns the workflows fixes it |
| Green `check:migration-chain` on `main` | Cold build fails at `1155` and `1174` (other lanes) | Those lanes repair them |
| A separate audience on an entry, in the UI | The API supports narrowing an entry inside its document's audience (`PATCH …/kb-link { audiences }`); the UI has no control for it, so an entry is for the same people as its document | Product decides it is wanted |

**Not verified** — built and tested, but not exercised the way a person or a real deployment would.

- **No browser run at all.** Nothing was looked at on screen at 375 / 768 / 1280, driven with a keyboard, or checked in dark
  mode. jsdom cannot see layout, focus order or paint. Every frontend PR body says so.
- **The assistants were never run against a model.** Retrieval, the `document` citation kind, replay and stream verification
  are tested with doubles and against real Postgres; "ask about a department-only SOP as the other employee" is unproven end to
  end (checklist line 16).
- **`check:hr-kb-invariants` has never run against real tenant data**, only seeded organisations. An empty database is
  INCONCLUSIVE by design.
- **The 300-second expiry on real storage** was not exercised: the URL's `expiresIn` and `no-store` are asserted, but
  "copy it to another browser after five minutes" needs real object storage.
- **The scheduler tick** that runs the purge was not driven; the unit that does the work runs against real Postgres and the
  sweep's wiring is unit-tested with `forEachOrg` mocked.
- **The official seeded-e2e runner refuses the scratch database** (its preflight stops at migration 1174, another lane's), so
  the HTTP e2e ran through a local wrapper that skips only that preflight, against `scratch_hrmskb` as the application's own
  non-owner role. That wrapper is not committed.
- **`to_tsvector` is computed per row at query time with no GIN index.** Correct and bounded (≤ 100 rows a page), unmeasured at
  tenant scale.
- **Saved assistant conversations keep the answer text already given.** On replay the citation is re-verified and dropped, but
  the stored answer is not rewritten when access is later revoked.
- **Full suites are red on `main` for reasons that are not this work** (measured against a merge-base worktree, by failing
  list): see §8.
- Observed and left alone: on a cold-built database `kb_article_chunks.attachment_id`'s foreign key points at the legacy
  `kb_article_attachments` table while the code writes `kb_page_attachments`.

---

## 4. Provisional defaults used (§14)

| # | Decision | Applied |
|---|---|---|
| D1 | Build a minimal KB? | **Not applied as written**: a large KB exists. Extended it with linked-document entries (their own tables), a browse/search/detail surface; no editor, no new KB |
| D2 | Who publishes | `hr:documents:publish`, held by Org Owner/Admin and `HR_MODULE_OWNER`/`ADMIN`; anyone else through an explicit grant. (The brief's `kb.hr_documents.publish` does not fit the key grammar `module:resource:action`.) Org Admin holds it structurally, which is the honest boundary of D2/D3 |
| D3 | Org admins without an HR role view personal docs? | No on the KB path (a personal document is never a link, result, snippet or context, whoever asks, the Org Owner included). `/hr/documents` unchanged — BLOCKED above |
| D4 | Managers view reports' personal docs? | No. The `team` scope already collapses to `own` in HR documents; managers get nothing on the KB path |
| D5 | `CONFIDENTIAL` to HR-only spaces? | Not in v1: `CONFIDENTIAL` is never shareable; no HR-only space |
| D6 | Version mode | `FOLLOW_LATEST` by default; `PINNED` optional; "newer version available" shown to HR |
| D7 | External `fileUrl` | Metadata-only entry, no *Open*, never fetched or indexed |
| D8 | Signed URL | 300 s, attachment, `Cache-Control: no-store` — already the platform behaviour, reused |
| D9 | AI answers over HR docs | Existing assistants only, opt-in per call site *and* per tenant, SQL-filtered, metadata only, no new vendor |
| D10 | Audit retention | Keep forever; no purge job (matches the table's own retention) |
| D11 | Deleted source documents | Hidden from readers immediately; publishers see "Source removed" for 30 days; then purged by the existing `kb-trash-purge` sweep |
| D12 | Import identity key | Provisional key `(org_id, user_id or null, category, normalised name)` shipped by another lane and hardened in PR 6; **unique index BLOCKED** (§3). An exact match is `unchanged`; on a match `type` and `fileUrl` update |
| D13 | Backfill default audience | Preserves today's visibility: all employees only if it was public, else HR only; **never publishes**, never overwrites |
| D14 | Employees uploading personal docs | Unchanged: `POST /onboarding/documents` is untouched; such rows are `PERSONAL` by default and fail the owner rule anyway |

Further defaults I chose (not in §14) — each is easy to change:

- **Unpublish reason: required in the UI, optional in the API** (a caller written against the earlier route keeps working).
  Stored on the entry and in the audit row with `reasonGiven`, so the fixed default is never passed off as one.
- **A withdrawn entry whose document stopped being shareable shows no detail of it** — not even to a publisher. The publisher
  keeps the record (id, status, reason) to manage it (PR 8 finding, §5).
- **A withdrawn entry is never brought back by making the document shareable again.** A person publishes it again, keeping
  the entry's id.
- **Backfill proposes Internal, never Restricted**, and only for `POLICY` / `OTHER` documents owned by nobody or by their uploader.
- **The reason and the server's own codes share one column.** The UI never shows `manual` or `source_no_longer_publishable`
  as if a person had written them.

---

## 5. Phase 0 findings, and what the proof found later

Full evidence: [`PHASE0-FINDINGS.md`](./PHASE0-FINDINGS.md). The headline results:

- **Real names replaced guesses.** `tenant_id` → `org_id`; `Hr Module Owner/Admin` → `HR_MODULE_OWNER`/`HR_MODULE_ADMIN`;
  `kb.hr_documents.publish` → `hr:documents:publish`; `hrms.kb.*` flags → three booleans on `kb_settings` (no flag mechanism
  existed; the `feature_flags` table is read by no code); `requestId` → `correlationId` (echoed as `x-request-id`; no UI showed
  it, so a shared *error reference* element was built); no version or approval model existed, so a minimal one was built.
- **A large KB already existed** (~30 tables, hybrid search, RAG "Ask"), so D1 was not applied as written.
- **Tenant-ID check: no defect found** on the document or KB surface, by reading the catalog of a cold-built database
  (every document and KB table has `org_id NOT NULL`, RLS on with a `tenant_isolation` policy; `assertKeySignable` refuses a
  foreign-org key even when `preauthorized`). **No live tenant was measured** (§3). Six other tables have RLS off and nine
  `org_id` columns are nullable; none touch documents or the KB, reported and not fixed here.
- **Duplicate counts for the D12 key: `scratch_hrmskb` 0 active documents, 0 duplicate groups; `streamline_hrms_e2e` 3 active
  documents, 0 duplicate groups; any live tenant: not measured.**
- **Security findings on the HR-documents surface**, ten in all: SEC-01 public flag on personal types (medium), SEC-02/03 no scope
  on rich documents, letters and renders (medium), SEC-04 a KB attachment route that would index a personal file (**a path by
  which a personal document could reach a chunk**), SEC-05 acknowledgment recipients (low), SEC-06 an unmatched import email
  silently became an organisation-wide document (medium); SEC-07…10 informational. SEC-01…05 are closed by PR 1 and SEC-06 by
  PR 6. Eight KB-side observations (K-01…K-08) are reported for the KB owners and untouched.
- **Found later, by the proof (PR 8):** (1) a publisher could read the name, description, type and file name of an HR
  document that had since become Personal, through the KB's withdrawn-entry routes — fixed in SQL; (2) the brief's checklist
  says to unpublish "with a reason" and the route I had shipped could not take one — fixed.

---

## 6. Migrations

Four, all hand-authored, journalled (idx 1081–1084), each with a rollback in `migrations/rollback/`:

| Migration | Adds |
|---|---|
| `1197_document_classification` | `documents.classification` (default `PERSONAL`) and `effective_date` |
| `1198_document_audiences_and_versions` | `document_audiences`, `document_versions` |
| `1199_kb_linked_documents` | `kb_linked_documents`, `kb_linked_document_audiences`, the three `kb_settings` switches (default `false`), RLS `tenant_isolation` on each |
| `1200_kb_linked_document_guard` | `app.hr_document_is_publishable(documents)`; the `BEFORE` trigger on links; the `AFTER UPDATE` trigger on documents that unlinks in the same transaction and audits |

**Applied where:** only to a local cold-built database (`scratch_hrmskb`, journal replay) and to seeded organisations in it. **No
migration was applied to any shared, live, Neon or RDS database**, and the census scripts were not run against one.

**`NOT VALID` constraints still pending validation: none.** 15 composite and tenant foreign keys were added `NOT VALID` and each
is `VALIDATE`d within its own migration (1198: 7 of 7; 1199: 8 of 8) — checked by script over the four files, not by eye.
Migration 1197 and 1200 add none. PR 1 and PR 6 ship **no** migration.

---

## 7. QA re-test checklist, with the real routes

Use two organisations, A and B; in A an HR admin, a manager, and two employees in different departments and locations. "Auto"
names the automated evidence that already proves the line; **every line still needs a person in a browser** for what jsdom and
an API test cannot see (layout, focus, real storage, a real model), and the last column says which lines are *only* that.

Frontend routes: HR Documents `/hr/documents`; Knowledge Base `/knowledge/wiki`; search `/knowledge/wiki/search`; company
documents `/knowledge/wiki/company-documents` and `…/{linkedDocumentId}`; HR import `/hr/settings/import-export`;
assistant `/knowledge/chat`.

| # | Checklist line | Route(s) | Automated evidence | Person only |
|---|---|---|---|---|
| 1 | Flags OFF: `/hr/documents` and the KB behave exactly as before | `/hr/documents`, `/knowledge/wiki`; every route below answers 404 | e2e "is off by default: three false switches and every new route answers 404, the admin's included"; FE documents-page and switch tests | Visual comparison before/after |
| 2 | Turn on `link` and `search` for A only; B sees no change | `PATCH /kb/settings/hr-link-flags` `{link:true}` then `{search:true}`; `GET /kb/hr-link/config` as a B member | e2e "refuses search while link is off, then lets the admin turn link on"; "tenants"; switch is a per-organisation row | — |
| 3 | HR classifies a handbook POLICY/INTERNAL, publishes to all employees; both find it in search; badge shows version and effective date | `PATCH /hr/documents/{documentId}/classification`; `PUT …/audiences`; `POST …/kb-link`; `GET /kb/linked-documents?q=`. UI: `/hr/documents` → row menu *Classification and sharing*; `/knowledge/wiki/search` → *Company documents* | e2e "classifies … Internal", "publishes once", "shows the entry to an employee … badge-ready projection", "finds the entry by its words"; FE source-badge, search-group and list tests | Badge legibility |
| 4 | Department SOP as RESTRICTED to department X: only X's employee finds it; the other gets no result and a 404 on the entry URL | as 3 with `audiences:[{kind:"DEPARTMENT",refId}]`; `GET /kb/linked-documents/{id}` as the other employee | e2e "gives an employee outside the audience the same 404", "tells nobody else it exists"; DB search spec; matrix | — |
| 5 | Offer letter / Aadhaar / PAN / payslip is not offered in the UI; a direct API call returns `DOCUMENT_NOT_PUBLISHABLE` | `POST /hr/documents/{documentId}/kb-link` → 422 `DOCUMENT_NOT_PUBLISHABLE` with the blocker list. UI: *Add to Knowledge Base* is disabled and the reasons are listed | e2e "cannot make a payslip Internal or publish it, even for the admin who holds every key"; matrix: all 1,256 non-shareable cells refused, 8 types incl. `ID_PROOF`, `OFFER_LETTER`; FE panel tests | Confirm the button reads as "not offered" |
| 6 | Searching for exact text from a personal document returns nothing for everyone, HR admin and owner included | `GET /kb/linked-documents?q=` and `/knowledge/wiki/search` | Matrix: per-document word search as publisher, employee and assistant finds nothing for every non-shareable cell. **v1 never reads a file's text at all**, so text *inside* a file is not searchable by anyone; `check:hr-kb-invariants` proves no chunk holds an HR file | — |
| 7 | Raise the handbook to CONFIDENTIAL: gone from employee search immediately | `PATCH …/classification` `{classification:"CONFIDENTIAL"}`; re-run the search | e2e "takes an entry away from every reader on the next request"; matrix degrade cases (7 ways) **and with the unlink trigger off** | — |
| 8 | Unpublish the SOP with a reason: gone immediately; the audit log shows who, when and the reason | `DELETE /hr/documents/{documentId}/kb-link` `{reason}`; UI *Remove from Knowledge Base* asks for one; audit `hr.document.kb_unpublished` | e2e "records the reason a publisher gives"; DB spec (who = `user_id`, when = `created_at`, `reason`, `reasonGiven`); FE #201 tests | — |
| 9 | Upload and approve v2 of a followed doc: search reflects v2; a pinned doc shows "newer version available" to HR | `POST /hr/documents/{documentId}/versions`; `POST …/versions/{n}/approve`; `PATCH …/kb-link` `{versionMode:"PINNED",pinnedVersion}` | e2e "shows readers a followed entry's new version the moment it is approved, and not before"; "keeps a pinned entry on its version, and tells the publisher and nobody else". Search reads the live document, so there is **no delay** at all, "a few minutes" is conservative | — |
| 10 | Delete a published doc: readers 404, HR sees "Source removed" | `DELETE /hr/documents/{documentId}` | e2e "takes a deleted document away from readers with a 404 and shows the publisher Source removed"; purge specs for the 30-day clean-up | — |
| 11 | "Open document": the URL expires after 5 minutes; a copy used after expiry fails | `POST /kb/linked-documents/{linkedDocumentId}/open` | e2e "signs a 300 second URL, never caches it, and records the fact without the URL" | **Yes: expiry on real storage** |
| 12 | Widening the link audience beyond the document's is blocked with a clear message | `PATCH /hr/documents/{documentId}/kb-link` `{audiences:[…]}` → 422 `AUDIENCE_EXCEEDS_DOCUMENT`; the UI has no control to widen (§3) | DB publish spec ("refuses to widen"); e2e classify-and-scope | — |
| 13 | Re-import the same Documents CSV twice: the count doesn't change | `POST /hr/import/jobs` → `POST /hr/import/jobs/{jobId}/commit`, twice; UI `/hr/settings/import-export` shows created / updated / unchanged | `hr-import-idempotency.db.spec` and `hr-import-document-commit.db.spec` (18 cases: whitespace, NBSP, case, inactive rows, blank cells); FE #198 tests | — |
| 14 | Tenant B's IDs from an A session are always 404 or empty | any `{documentId}` / `{linkedDocumentId}` of B from A | e2e "tenants"; matrix "another tenant can neither read, open nor cite"; per-service tenant-isolation DB specs | — |
| 15 | Errors show a message and a copyable request id | any failing call in the panels above | FE `ErrorReference` (reads `correlationId`), used in every new panel and tested with a fake id | Copy control on a real clipboard |
| 16 | If an assistant exists and `ai` is on: ask about a department-only SOP as the other employee — no reveal, no citation | `POST /kb/ask`, `POST /chat`, `/knowledge/chat` | Ask-source and `KbAskService` specs, DB retrieval spec (only entries the caller can open; citations re-verified on replay/stream) | **Yes: never run against a model** |
| 17 | Backfill dry run on A reports counts and changes nothing | `POST /hr/documents/kb-link/backfill` `{dryRun:true}` (the default); UI: *Classify the documents you already have* → Preview | e2e "is a dry run by default"; DB backfill spec (10 cases); FE #199 tests | — |

Before turning any switch on in a real organisation, run the reconciliation read-only as the table owner:

```
HR_KB_DATABASE_URL=postgresql://<owner>@<host>/<db> pnpm check:hr-kb-invariants --org=<orgId>
```

Exit 0 = every invariant holds; 1 = a violation is named with counts and opaque ids; **2 = it could not compare (no URL,
unreadable, or the organisation has no documents) and is never a pass.**

---

## 8. What was run

Everything below ran locally; the shared database was never touched.

| Check | Result |
|---|---|
| Backend `typecheck:test` (12 GB heap) | EXIT 0 on PR 8 head |
| Personal-document matrix (real Postgres, 1,280 documents) | 34 tests pass; three mutations each turn the right cases red |
| Reconciliation gate: self-test (48) + DB spec (13, real script, each violation planted) | pass; one mutation turns its test red |
| Every linked-document, backfill, purge, import, versions, schema, parity and gate DB spec | **184 tests / 12 suites green at the final tip** |
| Seeded HTTP e2e (guards, RBAC, RLS as `streamline_app`) | **34/34** |
| Backend whole unit suite at the final tip | 2,926 of 2,993 suites pass; the 67 failures are exactly the ones that fail on `main`'s merge-base (below) |
| Frontend `type-check` | only 2 pre-existing `geist` module errors; `type-check:specs` EXIT 0 |
| Frontend whole unit suite at the final tip | 1,123 of 1,150 suites pass; the 27 failures (45 tests) are exactly the ones that fail on `main`'s merge-base |
| Gates | each PR body names the gates it ran and which are red on `main` with none naming a file of mine |

**Whole backend unit suite at the final tip: 2,993 suites, 67 fail, 2,926 pass; 30,965 tests pass, 156 fail, 26 skipped.** The same
67 suites fail at `main`'s own merge-base with this chain (`4d135a043`; measured by running the failing set there), so none was
introduced by this work: they are `main`'s existing red (AI gateway, org setup, BOLA sweeps, cold-build integrity, KB purge
specs, and so on). Getting to that statement found **two defects of mine** that the per-PR targeted runs had missed, both now fixed
in the layer that introduced them (branches rebased and force-pushed with a lease, so commit SHAs quoted anywhere before
2026-09-25 have changed):

1. PR 5 gave `KbAskService` a constructor dependency, and `test/security/bola/bola-rag-object-scope.spec.ts` builds the service by
   hand without it (three cases died with "Nest can't resolve dependencies"). Fixed at PR 5.
2. PRs 3, 4 and 7 named `hr:documents:publish` through a constant in `@RequirePermission(...)`. `gated-keys-are-catalogued` cannot
   read a constant and ratchets how many it meets (28 on `main`; the chain made it 33). Fixed at PR 3, PR 4 and PR 7 by naming the
   key literally.

The method that found both, worth keeping: run the **whole** suite on the branch, run the failing set on a merge-base worktree,
and read only the difference. Running the suites you think you touched, or comparing against the previous PR rather than
against `main`, hid both.

**Whole frontend unit suite at the final tip: 1,150 suites, 27 fail, 1,123 pass; 10,988 tests pass, 45 fail.** The same 27 suites
(the same 45 tests) fail at `main`'s merge-base with this chain (`ede215e3f`), measured in a detached worktree by the same
method; the chain adds 26 suites and 182 passing tests and no failing one. Earlier in the project the same method caught a
regression from FE PR 3 (a shared component change broke a partial `jest.mock` factory in an unrelated test), fixed at PR 3 and
the branches above it rebased.
