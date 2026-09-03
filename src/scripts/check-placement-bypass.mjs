/**
 * Enumerates every path that reaches the database outside a tenant transaction
 * and fails the build on any one that is not on the allowlist with a reason.
 *
 * Bypass classes detected:
 *   @NoTenantTransaction() on a handler or controller class
 *   runOutsideTenantContext( call sites
 *   withIdentity( call sites
 *   cron-like files (src/modules/cron/** or files containing @Cron/@Interval) that
 *     access this.db without forEachOrg / runIn*TenantTransaction
 *   registerAfterCommit( callbacks whose body accesses this.db without a transaction wrapper
 *   provider-in-transaction: a route handler that KEEPS the request transaction and
 *     transitively reaches an AI provider adapter call (see below)
 *
 * ## Why `provider-in-transaction` exists
 *
 * Every rule above this one enumerates a bypass by finding the thing that DECLARES
 * it — a decorator, a named call. That makes the whole check structurally blind to
 * the defect class it matters most for: a handler that holds a pooled connection
 * across a network call declares nothing at all, so it produces no finding, while
 * the handlers that correctly release the connection are the ones flagged and
 * allowlisted. The check was exactly inverted for it. Found 2026-09-03 on the eight
 * buffered KB document AI handlers (`kb-article-ai` / `kb-page-ai` summarize · ask ·
 * improve · suggest-related), which awaited `invokeTextWithUsage` inside the ambient
 * request transaction while their streamed siblings — the ones the allowlist named —
 * did the right thing.
 *
 * The rule is stated in the negative because there is no "unless" to it:
 * `runInTenantTransaction` REUSES an ambient request transaction rather than opening
 * a short one (`common/tenant/run-in-tenant-transaction.ts:30`), so inside a handler
 * that keeps the request transaction there is no way to release the connection
 * before the provider call. Reaching a provider adapter from such a handler is the
 * violation; `@NoTenantTransaction()` plus an explicit short
 * `runInTenantTransaction(db, fn, { orgId })` is the only correct shape.
 * `common/tenant/README.md` ("Choosing a mechanism for side effects") prescribes it.
 *
 * Known limits (require call-graph analysis; not detectable by text scanning):
 *   registerAfterCommit(() => this.doDbWork()) — the db access lives in the called method, not the callback body.
 *   A closure defined inside a guard block but invoked later (e.g. process.nextTick(fn)) — textually inside the guard, executes outside it.
 *   provider-in-transaction follows `this.<field>.<method>()` through constructor-injected
 *     collaborators whose class is imported by a relative path, and `this.<method>()`
 *     within a class, to PROVIDER_REACH_MAX_DEPTH. It does NOT follow a provider call
 *     reached through an interface token, a callback passed in as an argument, a
 *     dynamically resolved service (`this.moduleRef.get(...)`), or a re-export barrel
 *     it cannot resolve to a file. Those stay invisible; see the residual-risk note in
 *     PROVIDER_IN_TRANSACTION_ALLOWLIST.
 *
 * Usage:  node src/scripts/check-placement-bypass.mjs [--self-test] [--root=<dir>]
 * Exit:   0 clean · 1 a bypass not on the allowlist · 2 broken pattern
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const ROOT_ARG = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_SRC = join(BACKEND_ROOT, "src");
const SCAN_ROOT = ROOT_ARG ? resolve(ROOT_ARG) : DEFAULT_SRC;
const EXTERNAL_ROOT = ROOT_ARG !== undefined;

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;
const MIN_BYPASS_SITES = 30;

/**
 * The classes whose methods leave the process for an AI provider. Named by TYPE
 * rather than by method name alone, so a local `invokeText` on some unrelated
 * service is not mistaken for one — and by method as well as type, so
 * `isConfigured()` on the same service is not either.
 */
export const PROVIDER_ADAPTER_TYPES = new Set([
  "AiGatewayService",
  "LlmService",
  "EmbeddingsService",
]);

export const PROVIDER_CALL_METHODS = new Set([
  "invokeText",
  "invokeTextWithUsage",
  "invokeJson",
  "invokeStructured",
  "invokeStructuredWithUsage",
  "invokeStructuredWithImage",
  "invokeStructuredWithImageWithUsage",
  "streamText",
  "streamTextWithUsage",
  "embedQueryWithCredit",
  "embedBatchWithCredit",
  "embedQueryRaw",
  "embedBatchRaw",
]);

const PROVIDER_REACH_MAX_DEPTH = 5;

const ROUTE_DECORATOR_RE = /@(?:Get|Post|Put|Patch|Delete|Options|Head|All|Sse)\s*\(/;

// -- allowlists --------------------------------------------------------------

/**
 * Patterns take three shapes, and the third is the one to reach for:
 *   "src/a/b.ts"                  — every finding in that file
 *   "src/a/**"                    — every finding under that directory
 *   "src/a/b.ts#handlerA,handlerB" — ONLY those named handlers in that file
 *
 * The `#` form exists because the first two are file-scoped, so an entry written
 * for four audited handlers silently excuses the FIFTH `@NoTenantTransaction()`
 * somebody adds to the same file a year later — which is how the eight KB
 * document AI handlers below arrived at a state where four were audited, four
 * were not, and the check reported clean. A `#` entry names what was audited and
 * nothing else. It only applies to findings that carry a handler name (a
 * decorator on a method); a class-level decorator has no handler and therefore
 * still needs a file entry, which is correct — it covers every route in the file.
 */
export const NO_TENANT_TRANSACTION_ALLOWLIST = new Map([
  [
    "src/modules/ai/**",
    "SSE streaming handlers: pipeTextStreamToResponse returns before the stream ends, so holding a request transaction open would commit while tools still run",
  ],
  [
    "src/modules/notifications/notifications.controller.ts#stream",
    "SSE notification stream that consumes a short-lived token and never touches the database; no tenant context is needed",
  ],
  [
    "src/modules/organization/core/organization.controller.ts#listOrganizations,listArchivedOrganizations,switchOrg,restoreOrg",
    "identity-scoped organization discovery and switching; each handler opens its own withIdentity or runInTenantTransaction before touching the database",
  ],
  // The entries below are NOT the SSE shape above. `respondWithAiTextStream` AWAITS
  // `pipeAiTextStream`, and the two CSV exports await `drain` between pages, so the
  // request transaction would not commit early — it would stay OPEN and IDLE for the
  // whole provider stream or the whole download, pinning a pooled connection and
  // tripping the 60s `idle_in_transaction_session_timeout` that `withTenant` sets.
  // Each does its tenant-scoped work in a short explicit
  // `runInTenantTransaction(db, fn, { orgId })` that commits BEFORE the long phase,
  // which is what `common/tenant/README.md` prescribes for exactly this class.
  //
  // The four KB files are handler-scoped on purpose. They used to be file-scoped,
  // and that is precisely why the four BUFFERED handlers on each KB controller sat
  // undetected for as long as they did: they had no decorator so they produced no
  // finding, and had one ever been added carelessly the file entry would have
  // excused it unexamined. Splitting streamed from buffered forces the two
  // rationales to be written and checked separately.
  [
    "src/modules/kb/help-centre/kb-article-ai.controller.ts#summarizeStream,askStream,improveStream,suggestRelatedStream",
    "the four STREAMED article actions: respondWithAiTextStream awaits the pipe, so a request transaction would be held open for the full stream — up to AI_TEXT_STREAM_DEADLINE_MS (60s), the same 60s as the idle_in_transaction_session_timeout withTenant sets — holding a pooled connection across the provider call. KbArticleAiService.stream reads the article and runs assertCanViewArticle inside loadArticle's runInTenantTransaction(db, fn, { orgId }) that commits before the provider call, and the credit ledger opens its own; no database access on this path reaches the pool without a tenant GUC",
  ],
  [
    "src/modules/kb/help-centre/kb-article-ai.controller.ts#summarize,ask,improve,suggestRelated",
    "the four BUFFERED article actions, decorated 2026-09-03 to fix the defect this file's provider-in-transaction rule now detects: KbArticleAiService.run awaits gateway.invokeTextWithUsage, a provider round trip, and until now did it inside the ambient request transaction — a pooled connection idle in transaction for the whole call, against a 60s idle_in_transaction_session_timeout. They now share loadArticle with the streamed siblings, so the tenant read and assertCanViewArticle commit before the provider call; cancellation is preserved by AiRequestAbortInterceptor on the class, since the decorator removes the tenant context's disconnect signal that getAmbientAiAbortSignal was reading",
  ],
  [
    "src/modules/kb/help-centre/kb-authoring.controller.ts#draft,improve,summarize",
    "the three KB authoring actions, decorated to clear this file's provider-in-transaction rule: KbAuthoringService.run awaits gateway.invokeTextWithUsage inside what was the ambient request transaction, pinning a pooled connection idle-in-transaction for the whole provider round trip against the 60s idle_in_transaction_session_timeout withTenant sets. Nothing on this path reads a tenant row BEFORE the provider call — the prompt is built entirely from the request body — and the only database access is the kb_events write afterwards, which KbEventsService.record now wraps in runInTenantTransaction(db, fn, { orgId }) so it gets a short transaction of its own rather than a 42501 (kb_events is RLS-enabled, verified in pg_class). AiRequestAbortInterceptor on the class restores the cancellation signal the decorator removes",
  ],
  [
    "src/modules/kb/retrieval/kb-ask.controller.ts#askQuestion",
    "KB Ask, decorated for the same reason and the largest hold of the four: KbAskService.ask awaits gateway.invokeTextWithUsage after a vector retrieval, so the request transaction spanned retrieval AND the provider call. It is now split into three short tenant transactions — gatherContext (orgHasIndexedContent, retrieveTopArticles, retrieveTopSources, retrieveAttachmentSnippets) commits BEFORE the provider call; the kb_events write and resolveCitations run in one afterwards; and the controller's own conversation create and two appendToConversation writes each open their own. The ACL filtering is unchanged and still in the SQL predicate on both sides, so the post-call citation re-verification still runs under the asker's own visibility. Creating the conversation is deliberately no longer atomic with the answer — it cannot be, the provider call sits between them — and an empty conversation from a failed answer is a better outcome than a connection held across the provider",
  ],
  [
    "src/modules/kb/retrieval/kb-page-indexing.controller.ts#reindexPage,reindexAllPages",
    "the two KB reindex handlers, audited 2026-09-03. They are the batch shape of the AI entries above, and the worst hold of the set: KbIndexingService.reindexAllPages loops `for (const page of batch) await this.indexPage(...)` with REINDEX_ALL_BATCH_SIZE = 100, and every indexPage awaits an embedding round trip through embedChunksWithResumption -> aiGateway.embedBatchWithCredit. Under the request transaction that is up to a hundred sequential provider calls with one pooled connection checked out and idle in transaction, against the 60s idle_in_transaction_session_timeout withTenant sets — ten to sixty seconds in, the timeout kills the transaction mid-embed with every embedding already issued already billed, and under pool pressure that is a tenant-wide 500 rather than one slow request. POST :pageId/reindex is the same shape with one page instead of a hundred. Removing the transaction is only half of it and the missing half fails SILENTLY: kb_pages' policy is `org_id = app.current_org_id_or_null() OR public_token = app.current_public_token_or_null()` (read from pg_policy, not assumed), and the _or_null variant RETURNS NULL where app.current_org_id() raises 42501, so the bare listing at the top of reindexAllPages would have matched nothing and answered {\"reindexed\":0,\"nextPageId\":null} for a tenant with a thousand pages. That listing now opens its own short runInTenantTransaction(db, fn, { orgId }) which commits before the loop, and each indexPage, loadPageChunkState and replacePageBodyChunks already opened their own — so nothing on the path reaches the pool without a tenant GUC, and no transaction spans an embedding call. Both halves are pinned by kb-page-reindex-placement.db.spec.ts against a real Postgres. AiRequestAbortInterceptor is declared on the class for the same PRD-C091 reason as the entries above: the decorator removes the tenant context's disconnect signal, which getAmbientAiAbortSignal was the gateway's only cancellation source",
  ],
  [
    "src/modules/kb/wiki/kb-page-ai.controller.ts#summarizeStream,askStream,improveStream,suggestRelatedStream",
    "the four STREAMED wiki actions, the twin of kb-article-ai.controller and the same shape: respondWithAiTextStream awaits the pipe, so the request transaction would be held across the provider stream. KbPageAiService.stream resolves accessible project ids and the page visibility predicate inside loadPage's runInTenantTransaction(db, fn, { orgId }) that commits before the provider call; kb-doc-ai-stream.spec.ts drives both surfaces from one table so the two cannot diverge",
  ],
  [
    "src/modules/kb/wiki/kb-page-ai.controller.ts#summarize,ask,improve,suggestRelated",
    "the four BUFFERED wiki actions, the twin of the kb-article-ai buffered entry and fixed in the same change: KbPageAiService.run awaited gateway.invokeTextWithUsage inside the ambient request transaction. They now share loadPage with the streamed siblings so the project-access lookup and the visibility predicate commit before the provider call, and AiRequestAbortInterceptor on the class keeps the provider call cancellable now that the tenant context's signal is gone",
  ],
  [
    "src/modules/audit-log/audit-log.controller.ts#exportCsv",
    "GET /audit-log/export streams an async generator to the client socket and awaits `drain` between writes, so one request transaction would be pinned to a slow client for the whole download. AuditLogService.exportCsvChunks opens one runInTenantTransaction(db, fn, { orgId }) per 500-row keyset page — the minimum correct unit, one page not one row — and holds none across a res.write. The controller's other three handlers keep the request transaction",
  ],
  [
    "src/modules/contacts/contacts.controller.ts#exportCsv",
    "GET /contacts/export is the same paged-generator export as audit-log: ContactsService.exportCsvChunks opens one runInTenantTransaction(db, fn, { orgId }) per 500-row keyset page, and contacts.service.spec.ts pins one transaction per page. The DataScope is resolved first through AccessService.scopeFor, which opens its own explicit tenant transaction. The controller's other eight handlers keep the request transaction",
  ],
  // The two below are the AI shape again, and they arrived the other way round
  // from the KB pair: the CODE was fixed first (the decorator plus a short
  // runInTenantTransaction in the service) and the audit reason was never
  // written, so this check failed on six correctly-shaped handlers while their
  // stale PRE-EXISTING, UNAUDITED entries still sat in
  // PROVIDER_IN_TRANSACTION_ALLOWLIST excusing the defect they no longer had.
  // Those entries are deleted; these replace them. Handler-scoped, so the sixth
  // route somebody adds to either controller has to be argued on its own.
  [
    "src/modules/e-sign/sign-ai.controller.ts#summarize",
    "e-sign summarize, audited 2026-09-03: the only handler on this controller, and the longest hold of the set — SignAiService.summarizeDocument fetches each document from the object store and drains the whole stream, extracts its text on the CPU, and only then awaits gateway.invokeText. Under the request transaction a pooled connection sat idle in transaction across all three, against the 60s idle_in_transaction_session_timeout withTenant sets from resolveTransactionGuards (pool.config.ts:122) and a direct Neon endpoint whose safe max is 10 connections (pool.config.ts:15), so a slow provider is a tenant-wide pool exhaustion, not one slow request. The envelope visibility check (mustGetVisibleEnvelope, which carries the caller's EnvelopeViewScope) and the signDocuments read now share ONE short runInTenantTransaction(db, fn, { orgId }) that commits before the store fetch begins; resolveEnvelopeViewScope runs through AccessService in the controller before that, and the gateway's credit reservation, settlement and ai_usage_logs insert each pass an explicit orgId, so nothing on the path reaches the pool without a tenant GUC. AiRequestAbortInterceptor is declared on the class because the decorator removes the tenant context's disconnect signal that getAmbientAiAbortSignal was reading — without it the released connection would have been bought with an uncancellable, still-billed provider call (PRD-C091)",
  ],
  [
    "src/modules/timesheets/core/timesheets-ai.controller.ts#summarize,draftRejectionReason,describeEntry,billingNarrative,reportsNarrative",
    "the five timesheets AI actions, audited 2026-09-03 and the same fix as the KB pair above: each one ends in an AiGatewayService call, and under the request transaction that provider round trip was made with a pooled connection still checked out and idle in transaction, against the 60s idle_in_transaction_session_timeout withTenant sets. TimesheetsAiService now routes every evidence read through readEvidence, one short runInTenantTransaction(db, fn, { orgId }) that commits before the gateway call — periods.getPeriod for summarize and draftRejectionReason, reports.getOverview for reportsNarrative, billing.getBillableWorkForNarrative for billingNarrative. describeEntry reads nothing at all: its prompt is built entirely from the request body, the same shape as kb-authoring. The delegate services keep their signatures because this.db is the tenant-aware proxy and resolves to the transaction opened here. Everything the gateway itself touches — credit reservation, settlement and the ai_usage_logs insert — already passes an explicit orgId. AiRequestAbortInterceptor is declared on the class for the same PRD-C091 reason as the e-sign entry above: the decorator removes the tenant context's disconnect signal, which was the only cancellation source these five had",
  ],
]);

export const CONTEXT_EXIT_ALLOWLIST = new Map([
  [
    "src/common/audit/audit.service.ts",
    "audit log dispatched outside the request transaction so a rolled-back mutation does not suppress the audit entry; write() re-opens withTenant when orgId is known",
  ],
  [
    "src/common/region/placement-lookup.ts",
    "placement is a control-plane read that runs before any tenant is known and must not be tied to a caller's tenant connection in a multi-region deployment",
  ],
  [
    "src/modules/gdpr/gdpr-subject-erasure-identity.ts",
    "audited 2026-09-04: the exit IS the correctness requirement, not a shortcut around it. Before redacting the shared `users` row, erasure must answer 'does this subject still belong to any OTHER organisation?' — and the erasing org's tenant transaction is structurally unable to see another org's membership, so asking on it returns zero rows and the answer is always 'no'. That is the P0 this fixed: a two-org subject erased by one controller lost their global identity, and with it their access to the other. The question is asked under `withIdentity` scoped to the SUBJECT, which is the narrowest principal that can see their own memberships, and it reads nothing but `organization_members` joined to `organizations` — no tenant data crosses. It is deliberately asked BEFORE the erasure takes row locks on the subject's PII, so the wait for a pool slot does not happen while those locks are held. Covered by gdpr-subject-erasure-global-identity.db.spec.ts, which measures as a non-BYPASSRLS role and proves both directions: erasing from org A leaves the org B membership and the identity intact, and erasing from the LAST org still redacts",
  ],
  [
    "src/common/region/cell-admission.ts",
    "chooses the cell a NEW organisation is placed into by reading cell_capacity_measurements, which necessarily runs before that organisation and therefore any tenant context exists; same class as the placement lookup above",
  ],
  [
    "src/common/tenant/run-in-tenant-transaction.ts",
    "runInNewTenantTransaction implementation: deliberately escapes any ambient context before opening a fresh isolated tenant transaction",
  ],
  [
    "src/modules/crm/import/import-pump.ts",
    "import pump escapes the HTTP request transaction so each workflow step can open its own tenant transaction and steps are safe to replay on retry",
  ],
  [
    "src/modules/organization/setup/org-setup.service.ts",
    "post-setup work fires after the setup transaction commits via setImmediate; running outside the ambient context is the design",
  ],
  [
    "src/modules/organization/core/org-membership.service.ts",
    "exits the ambient admin transaction before opening a user-identity-scoped one so app.user_id cannot widen later RLS reads in the enclosing request",
  ],
  [
    "src/modules/organization/core/org-membership-access-revocation.ts",
    "exits the tenant context to count remaining active memberships across other organizations after revocation; a tenant-scoped GUC would restrict visibility to only the current org and produce an incorrect zero count",
  ],
  [
    "src/modules/organization/core/org-membership-status.service.ts",
    "planLastActiveOrganizationChange exits the tenant context to query the user's active memberships across all organizations when computing the new lastActiveOrgId after suspension or reactivation; a tenant-scoped GUC would restrict the query to only the current org",
  ],
]);

export const WITH_IDENTITY_ALLOWLIST = new Map([
  [
    "src/common/auth/jwt-auth.guard.ts",
    "pre-tenant: reads organization memberships to determine which org the request targets; org context is being established, not yet known",
  ],
  [
    "src/modules/users/users.service.ts",
    "pre-tenant: membership count for plan enforcement during sign-in; org context is not yet established",
  ],
  [
    "src/modules/gdpr/gdpr-subject-erasure-identity.ts",
    "cross-tenant by necessity, scoped to the subject: erasure may only redact the shared `users` row once NO other organisation still holds this person, and the erasing org's own tenant transaction cannot see another org's membership. `withIdentity` on the subject is the narrowest principal that can answer it. Reads only organization_members joined to organizations, filtered to ACTIVE/SUSPENDED memberships in live orgs — see the entry in CONTEXT_EXIT_ALLOWLIST for the full audit",
  ],
  [
    "src/modules/auth/auth-membership-resolver.service.ts",
    "pre-tenant membership resolution: resolvePreferredOrgId, resolveActiveMembership and resolveSuspendedMembership all run before the org context is known, reading cross-org identity tables under user identity",
  ],
  [
    "src/modules/auth/auth-tokens.service.ts",
    "same pre-tenant identity resolution as auth-membership-resolver: resolvePreferredOrgId reads the cross-org accountOrganizationIndex, and the membership and suspended-membership lookups run at sign-in before an org is chosen, so a tenant-scoped GUC would return no rows",
  ],
  [
    "src/modules/auth/auth.service.ts",
    "register() writes and resolvePreferredOrg() reads the cross-org accountOrganizationIndex under user identity; the table is a global identity projection that cannot be read or written under a single org's tenant context",
  ],
  [
    "src/modules/organization/core/account-organization-index.service.ts",
    "the account-to-organization discovery projection answers which organizations an account may enter, so it necessarily runs before one is chosen; its RLS policy admits rows by app.user_id and a read on the pool would silently return none",
  ],
  [
    "src/modules/organization/setup/org-setup.service.ts",
    "creates the first org membership under user identity, before the new org's tenant context exists",
  ],
  [
    "src/modules/organization/core/org-lifecycle.service.ts",
    "org listing, switching, and restoration run under user identity before the target org's tenant context is known",
  ],
  [
    "src/modules/organization/core/org-purge.service.ts",
    "split out of org-lifecycle.service: resolveReplacementOrgIds asks, for each departing member, which org they should land in next, which is a cross-org question about that member's own memberships and cannot be answered inside the purged org's tenant context",
  ],
  [
    "src/modules/organization/setup/org-setup-resolver.service.ts",
    "split out of org-setup.service: listSetupMemberships enumerates a user's memberships to choose a setup target, so it necessarily runs before one org is chosen",
  ],
  [
    "src/modules/organization/core/org-membership.service.ts",
    "membership switch reads under user identity to exit the ambient admin transaction before the switch completes",
  ],
  [
    "src/modules/organization/core/org-profile.service.ts",
    "lists all orgs a user belongs to, which is a cross-org identity read that cannot run under a single org's tenant context",
  ],
  [
    "src/modules/organization/core/invitation-acceptance.service.ts",
    "updates the cross-org accountOrganizationIndex under user identity after invitation acceptance; the table is a global identity projection and must not be written under a single org's tenant context",
  ],
  [
    "src/modules/organization/core/org-membership-access-revocation.ts",
    "reads organizationMembers cross-org under user identity to determine whether the removed member has other active organizations; must run outside any single org's tenant context",
  ],
  [
    "src/modules/organization/core/org-membership-status.service.ts",
    "planLastActiveOrganizationChange reads cross-org membership under user identity to determine which organization should become the user's new lastActiveOrgId after suspension or reactivation; must not run under any single org's tenant context",
  ],
]);

export const CRON_BYPASS_ALLOWLIST = new Map([
  [
    "src/modules/cron/cron-org-purge-worker.service.ts",
    "purge worker selects from the global organizations table (no RLS policy) using FOR UPDATE SKIP LOCKED; the only cron service that must run without a per-org tenant GUC",
  ],
  // The five below were INVISIBLE until 2026-08-28: the cron rule matched whole
  // files, so one forEachOrg anywhere excused every bare this.db in the file.
  // Each of these mixes guarded sweeps with unguarded this.db.transaction blocks.
  // They are NOT asserted safe — they are pre-existing sweeps their owning session
  // must migrate to forEachOrg or justify per site. Tracked in CROSS-SESSION.md.
  [
    "src/modules/cron/cron-leave.service.ts",
    "PRE-EXISTING, UNAUDITED (16 sites): mixes forEachOrg sweeps with bare this.db.transaction blocks; hidden by the old file-level rule; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-hr-engines.service.ts",
    "PRE-EXISTING, UNAUDITED (4 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-recruitment.service.ts",
    "PRE-EXISTING, UNAUDITED (3 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-notification-retention.service.ts",
    "PRE-EXISTING, UNAUDITED (2 sites): retention sweep addresses partitions by name outside a tenant context; owner must confirm the tables carry no RLS policy",
  ],
  [
    "src/modules/cron/cron-billing.service.ts",
    "PRE-EXISTING, UNAUDITED (2 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
]);

export const AFTER_COMMIT_DB_ALLOWLIST = new Map([]);

/**
 * Handlers that keep the request transaction across a provider round trip.
 *
 * Nothing here is asserted safe. These were INVISIBLE until the
 * provider-in-transaction rule was written on 2026-09-03, for the same reason the
 * eight KB handlers were: no decorator, no finding. They are pre-existing and
 * belong to their owning modules; the correct fix for each is the one applied to
 * the KB pair — `@NoTenantTransaction()` on the handler, the tenant-scoped read
 * and the authorization check moved into a short explicit
 * `runInTenantTransaction(db, fn, { orgId })` that commits before the provider
 * call, and `AiRequestAbortInterceptor` on the controller so the provider call
 * stays cancellable once the tenant context's disconnect signal is gone.
 *
 * RESIDUAL RISK, recorded deliberately rather than papered over:
 *   1. Every entry below is a live instance of the defect. Each one holds a
 *      pooled connection idle in transaction for a provider round trip, against
 *      the 60s `idle_in_transaction_session_timeout` `resolveTransactionGuards`
 *      sets. Under pool pressure that is a tenant-wide failure shape.
 *   2. The detector is not sound in the other direction either: see the "Known
 *      limits" note at the top of this file. A provider call reached through an
 *      interface token, a `moduleRef.get`, or a callback argument produces no
 *      finding at all, so an empty violation list is evidence, not proof.
 */
export const PROVIDER_IN_TRANSACTION_ALLOWLIST = new Map([
  [
    "src/modules/accounting/ai/accounting-ai.controller.ts#explainVariance,explainReconciliation,extractDocument",
    "PRE-EXISTING, UNAUDITED — explainVariance -> AccountingAiService.explainVariance -> AiGatewayService.invokeStructured; explainReconciliation -> AccountingAiService.explainReconciliation -> AiGatewayService.invokeStructured; extractDocument -> AccountingAiService.extractDocument -> AiGatewayService.invokeStructuredWithImage",
  ],
  [
    "src/modules/automation/automation.controller.ts#testAutomation",
    "PRE-EXISTING, UNAUDITED — testAutomation -> AutomationService.testRule -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/cron/cron-hr-notifications.controller.ts#getWeeklyExecRecap,postWeeklyExecRecap",
    "PRE-EXISTING, UNAUDITED — getWeeklyExecRecap -> CronHrNotificationsController.runWeeklyExecRecap -> CronWeeklyRecapService.sendWeeklyExecRecaps -> CronWeeklyRecapService.generateNarrative -> AiGatewayService.invokeText; postWeeklyExecRecap -> CronHrNotificationsController.runWeeklyExecRecap -> CronWeeklyRecapService.sendWeeklyExecRecaps -> CronWeeklyRecapService.generateNarrative -> AiGatewayService.invokeText",
  ],
  [
    "src/modules/deals/deals.controller.ts#updateDeal",
    "PRE-EXISTING, UNAUDITED — updateDeal -> DealsService.updateDeal -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  // e-sign summarize and the five timesheets handlers used to sit here as
  // PRE-EXISTING, UNAUDITED. They are fixed, so they no longer produce a finding
  // of this kind at all and their entries are DELETED rather than left behind:
  // a dead excuse is worse than no excuse, because it silently re-excuses the
  // same handler the day somebody drops the decorator. Their audited rationales
  // now live in NO_TENANT_TRANSACTION_ALLOWLIST, where the fixed shape belongs.
  [
    "src/modules/feedbucket/feedbucket-public.controller.ts#aiAssist",
    "PRE-EXISTING, UNAUDITED — aiAssist -> FeedbucketAiService.analyzePublic -> FeedbucketAiService.runVisionAnalysis -> AiGatewayService.invokeStructuredWithImageWithUsage",
  ],
  [
    "src/modules/feedbucket/feedbucket.controller.ts#analyzeSubmission,createTicketFromAnalysis",
    "PRE-EXISTING, UNAUDITED — analyzeSubmission -> FeedbucketAiService.analyze -> FeedbucketAiService.runVisionAnalysis -> AiGatewayService.invokeStructuredWithImageWithUsage; createTicketFromAnalysis -> FeedbucketAiService.createTicketFromAnalysis -> FeedbucketAiService.analyze -> FeedbucketAiService.runVisionAnalysis -> AiGatewayService.invokeStructuredWithImageWithUsage",
  ],
  [
    "src/modules/hr/config/hr-email-templates.controller.ts#generateAi",
    "PRE-EXISTING, UNAUDITED — generateAi -> HrEmailTemplatesService.generateWithAi -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/hr/directory/employees.controller.ts#onboard",
    "PRE-EXISTING, UNAUDITED — onboard -> EmployeeOnboardingService.onboardEmployee -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/hr/recruitment/recruitment-candidate-records.controller.ts#resumeParse,aiScore,compositeScore",
    "PRE-EXISTING, UNAUDITED — resumeParse -> RecruitmentCandidateAiService.parseResume -> RecruitmentCandidateAiService.parseResumeText -> AiGatewayService.invokeStructured; aiScore -> RecruitmentCandidateAiService.aiScore -> AiGatewayService.invokeStructured; compositeScore -> RecruitmentCandidateAiService.compositeScore -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/hr/recruitment/recruitment-candidates.controller.ts#moveStage,updateBgvStatus",
    "PRE-EXISTING, UNAUDITED — moveStage -> RecruitmentCandidatesService.moveStage -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured; updateBgvStatus -> RecruitmentCandidateOpsService.updateBgvStatus -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/inventory/ai/inv-ai-explain.controller.ts#explainInsight,getDigest,getReorderProposal,getSupplierDelayBriefing",
    "PRE-EXISTING, UNAUDITED — explainInsight -> InvAiExplainService.explainInsight -> AiGatewayService.invokeStructured; getDigest -> InvAiExplainService.getDigest -> AiGatewayService.invokeText; getReorderProposal -> InvAiExplainService.getReorderProposal -> AiGatewayService.invokeStructured; getSupplierDelayBriefing -> InvAiExplainService.getSupplierDelayBriefing -> AiGatewayService.invokeText",
  ],
  [
    "src/modules/kb/help-centre/kb-authoring.controller.ts#draft,improve,summarize",
    "PRE-EXISTING, UNAUDITED — draft -> KbAuthoringService.draft -> KbAuthoringService.run -> AiGatewayService.invokeTextWithUsage; improve -> KbAuthoringService.improve -> KbAuthoringService.run -> AiGatewayService.invokeTextWithUsage; summarize -> KbAuthoringService.summarize -> KbAuthoringService.run -> AiGatewayService.invokeTextWithUsage",
  ],
  [
    "src/modules/kb/retrieval/kb-ask.controller.ts#askQuestion",
    "PRE-EXISTING, UNAUDITED — askQuestion -> KbAskService.ask -> AiGatewayService.invokeTextWithUsage",
  ],
  [
    "src/modules/kb/wiki/kb-media.controller.ts#upload",
    "PRE-EXISTING, UNAUDITED — upload -> KbMediaService.upload -> KbAttachmentIndexingService.indexPageDocument -> KbAttachmentIndexingService.embedInBatches -> AiGatewayService.embedBatchWithCredit",
  ],
  [
    "src/modules/kb/wiki/kb-sources.controller.ts#upload,createNote",
    "PRE-EXISTING, UNAUDITED — upload -> KbSourcesService.createFile -> KbSourcesService.processFile -> KbSourcesService.processText -> KbAttachmentIndexingService.indexSource -> KbAttachmentIndexingService.embedInBatches -> AiGatewayService.embedBatchWithCredit; createNote -> KbSourcesService.createNote -> KbSourcesService.processText -> KbAttachmentIndexingService.indexSource -> KbAttachmentIndexingService.embedInBatches -> AiGatewayService.embedBatchWithCredit",
  ],
  [
    "src/modules/leads/leads-detail.controller.ts#assign",
    "PRE-EXISTING, UNAUDITED — assign -> LeadsDetailService.assign -> LeadsDetailService.enrichAssignmentNotification -> LeadNotificationAiService.generateSmartNotification -> AiGatewayService.invokeText",
  ],
  [
    "src/modules/leads/leads.controller.ts#update,create",
    "PRE-EXISTING, UNAUDITED — update -> LeadsService.update -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured; create -> LeadsService.create -> AutomationService.runAutomationsForEvent -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/mail/mail.controller.ts#aiInboxSummary,aiThreadSummary,aiDraft",
    "PRE-EXISTING, UNAUDITED — aiInboxSummary -> MailAiService.inboxSummary -> AiGatewayService.invokeStructuredWithUsage; aiThreadSummary -> MailAiService.threadSummary -> AiGatewayService.invokeStructured; aiDraft -> MailAiService.draft -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/payroll/insights/payroll-ai-explain.controller.ts#explainPayslip",
    "PRE-EXISTING, UNAUDITED — explainPayslip -> PayrollAiExplainService.explainPayslip -> AiGatewayService.invokeTextWithUsage",
  ],
  [
    "src/modules/support/core/support-ai.controller.ts#findDuplicates,suggestKbArticles,suggestReply,suggestMacro,translateMessage,generateHandoffSummary,findRootCauseCluster,improveReply,translateDraft,analyze",
    "PRE-EXISTING, UNAUDITED — findDuplicates -> SupportAiService.findDuplicates -> SupportAiTriageAnalysisService.findDuplicates -> SupportAiEmbeddingsHelper.upsertAndSearchSimilar -> AiGatewayService.embedQueryWithCredit; suggestKbArticles -> SupportAiService.suggestKbArticles -> SupportAiTriageService.suggestKbArticles -> SupportAiTriageDataService.searchKbForTicket -> AiGatewayService.embedQueryWithCredit; suggestReply -> SupportAiService.suggestReply -> SupportAiTriageService.suggestReply -> AiGatewayService.invokeText; suggestMacro -> SupportAiService.suggestMacro -> SupportAiTriageService.suggestMacro -> AiGatewayService.invokeStructured; translateMessage -> SupportAiService.translateMessage -> SupportAiTranslationService.translateMessage -> AiGatewayService.invokeStructured; generateHandoffSummary -> SupportAiService.generateHandoffSummary -> SupportAiTriageService.generateHandoffSummary -> AiGatewayService.invokeStructured; findRootCauseCluster -> SupportAiService.findRootCauseCluster -> SupportAiTriageAnalysisService.findRootCauseCluster -> AiGatewayService.invokeStructured; improveReply -> SupportAiService.improveReply -> SupportAiTranslationService.improveReply -> AiGatewayService.invokeStructured; translateDraft -> SupportAiService.translateDraft -> SupportAiTranslationService.translateDraft -> AiGatewayService.invokeStructured; analyze -> SupportAiService.analyzeTicket -> SupportAiTriageAnalysisService.analyzeTicket -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/support/core/support-automations.controller.ts#testAutomation",
    "PRE-EXISTING, UNAUDITED — testAutomation -> AutomationService.testRule -> AutomationService.runRule -> AutomationService.executeAction -> AiNodeExecutorService.executeNode -> AiGatewayService.invokeStructured",
  ],
  [
    "src/modules/support/core/support-kb.controller.ts#askQuestion,reindexArticle,reindexAll",
    "PRE-EXISTING, UNAUDITED — askQuestion -> KbAskService.ask -> AiGatewayService.invokeTextWithUsage; reindexArticle -> KbArticleReindexService.reindexArticle -> KbAttachmentIndexingService.indexAttachment -> KbAttachmentIndexingService.embedInBatches -> AiGatewayService.embedBatchWithCredit; reindexAll -> KbArticleReindexService.reindexAll -> KbArticleReindexService.reindexArticle -> KbAttachmentIndexingService.indexAttachment -> KbAttachmentIndexingService.embedInBatches -> AiGatewayService.embedBatchWithCredit",
  ],
]);

// -- helpers -----------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let inString = null;

  while (i < src.length) {
    const ch = src[i];

    if (inBlock) {
      if (ch === "*" && src[i + 1] === "/") {
        out.push(" ", " ");
        i += 2;
        inBlock = false;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    if (inString !== null) {
      if (ch === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === inString) {
        out.push(" ");
        inString = null;
        i++;
        continue;
      }
      if (ch === "\n" && inString !== "`") {
        out.push("\n");
        inString = null;
        i++;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      inBlock = true;
      continue;
    }

    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out.push(" ");
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

function collectImportAliases(src, originalNames) {
  const locals = new Set(originalNames);
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const specifiers = m[1];
    for (const orig of originalNames) {
      const aliasRe = new RegExp(`\\b${escapeRe(orig)}\\b\\s+as\\s+(\\w+)`);
      const aliasMatch = aliasRe.exec(specifiers);
      if (aliasMatch) locals.add(aliasMatch[1]);
    }
  }
  return locals;
}

function isCronLike(src, rel) {
  return rel.includes("/modules/cron/") || /[@]Cron\(|[@]Interval\(/.test(src);
}

export function balanced(src, from) {
  let depth = 0;
  let inString = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (inString !== null) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

function toRelPath(absPath) {
  return relative(BACKEND_ROOT, absPath).replace(/\\/g, "/");
}

/**
 * `handler` is the method a finding sits on, or undefined/null when the finding
 * has none (a class-level decorator, a call site in a plain service). A `#`
 * pattern requires one and must name it; the file and `/**` forms ignore it, so
 * every entry written before handler scoping keeps behaving exactly as it did.
 */
export function matchesPattern(filePath, pattern, handler) {
  const hash = pattern.indexOf("#");
  if (hash !== -1) {
    if (!handler) return false;
    if (filePath !== pattern.slice(0, hash)) return false;
    return pattern
      .slice(hash + 1)
      .split(",")
      .map((h) => h.trim())
      .includes(handler);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  return filePath === pattern;
}

export function allowlistReason(filePath, allowlist, handler) {
  for (const [pattern, reason] of allowlist) {
    if (matchesPattern(filePath, pattern, handler)) return reason;
  }
  return null;
}

function validateAllowlists() {
  for (const [kind, list] of [
    ["no-tenant-transaction", NO_TENANT_TRANSACTION_ALLOWLIST],
    ["context-exit", CONTEXT_EXIT_ALLOWLIST],
    ["with-identity", WITH_IDENTITY_ALLOWLIST],
    ["cron-bypass", CRON_BYPASS_ALLOWLIST],
    ["after-commit-db", AFTER_COMMIT_DB_ALLOWLIST],
    ["provider-in-transaction", PROVIDER_IN_TRANSACTION_ALLOWLIST],
  ]) {
    for (const [pattern, reason] of list) {
      if (!reason || !reason.trim()) {
        process.stderr.write(`BROKEN ALLOWLIST: ${kind} entry "${pattern}" has no reason\n`);
        process.exit(2);
      }
    }
  }
}

function resolveAllowlist(finding) {
  const h = finding.handler;
  if (finding.kind === "no-tenant-transaction")
    return allowlistReason(finding.file, NO_TENANT_TRANSACTION_ALLOWLIST, h);
  if (finding.kind === "context-exit")
    return allowlistReason(finding.file, CONTEXT_EXIT_ALLOWLIST, h);
  if (finding.kind === "with-identity")
    return allowlistReason(finding.file, WITH_IDENTITY_ALLOWLIST, h);
  if (finding.kind === "cron-bypass")
    return allowlistReason(finding.file, CRON_BYPASS_ALLOWLIST, h);
  if (finding.kind === "after-commit-db")
    return allowlistReason(finding.file, AFTER_COMMIT_DB_ALLOWLIST, h);
  if (finding.kind === "provider-in-transaction")
    return allowlistReason(finding.file, PROVIDER_IN_TRANSACTION_ALLOWLIST, h);
  return null;
}

// -- class / method structure ------------------------------------------------

const MEMBER_MODIFIERS = "(?:public |private |protected |static |readonly |override |abstract |async |get |set |\\* )*";
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "super", "typeof",
  "await", "new", "do", "else", "with", "yield", "throw", "import", "export",
  "constructor",
]);

/**
 * `stripCommentsAndStrings` is length-preserving (every removed character becomes
 * a space or a newline), so an offset in the stripped text is the same offset in
 * the original and a line number computed on one is correct for the other. Every
 * structural scan below therefore runs on the stripped text, where a brace inside
 * a template literal cannot be mistaken for a block.
 */
function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/** True when every bracket opened in `text` is also closed in it. */
function isTopLevel(text) {
  let depth = 0;
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The opening brace of a method BODY, skipping any brace that belongs to the
 * return type — `Promise<{ text: string }>` has one, and taking it would treat
 * the type as the body and find nothing in the method at all.
 */
export function findBodyStart(stripped, from) {
  let angle = 0;
  for (let i = from; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === ";") return -1;
    else if (ch === "{") {
      if (angle === 0) return i;
      const inner = balanced(stripped, i);
      if (!inner) return -1;
      i += inner.length - 1;
    }
  }
  return -1;
}

/**
 * Every method of the file's first class, with the decorator text that precedes
 * it. Decorators are taken as the whole slice between the previous member's body
 * and this signature rather than by walking `@`-prefixed lines, so a decorator
 * spanning several lines is still attributed to the method it decorates.
 */
export function findClassMethods(stripped) {
  const classMatch = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
    stripped,
  );
  if (!classMatch) return { className: null, classAt: -1, methods: [] };

  const className = classMatch[1];
  const classAt = classMatch.index;
  const bodyStart = stripped.indexOf("{", classAt);
  if (bodyStart === -1) return { className, classAt, methods: [] };
  const classBody = balanced(stripped, bodyStart);
  if (!classBody) return { className, classAt, methods: [] };
  const classEnd = bodyStart + classBody.length;

  const sigRe = new RegExp(`(?:^|\\n)[ \\t]*${MEMBER_MODIFIERS}([A-Za-z_$][\\w$]*)\\s*(?:<[^<>()]*>)?\\s*\\(`, "g");
  sigRe.lastIndex = bodyStart;

  const methods = [];
  let cursor = bodyStart + 1;
  let m;
  while ((m = sigRe.exec(stripped)) !== null) {
    if (m.index >= classEnd) break;
    // Anything textually inside an already-accepted body is a call, not a member.
    if (m.index < cursor - 1) continue;
    const name = m[1];
    if (NOT_A_METHOD.has(name)) continue;
    // A line-leading `Name(` inside a multi-line decorator argument —
    // `@UseInterceptors(\n  FileInterceptor("file", …)\n)` — looks exactly like a
    // member signature. It is only one if nothing is still open above it.
    if (!isTopLevel(stripped.slice(cursor, m.index))) continue;

    const parenAt = m.index + m[0].length - 1;
    const params = balanced(stripped, parenAt);
    if (!params) continue;
    const start = findBodyStart(stripped, parenAt + params.length);
    if (start === -1) continue;
    const body = balanced(stripped, start);
    if (!body) continue;

    methods.push({
      name,
      line: lineOf(stripped, m.index + (m[0].startsWith("\n") ? 1 : 0)),
      decorators: stripped.slice(cursor, m.index),
      body,
    });
    cursor = start + body.length;
    sigRe.lastIndex = cursor;
  }

  return { className, classAt, methods };
}

/** `field -> declared type` for every parameter property on the constructor. */
export function constructorFieldTypes(stripped) {
  const fields = new Map();
  const at = stripped.indexOf("constructor");
  if (at === -1) return fields;
  const parenAt = stripped.indexOf("(", at);
  if (parenAt === -1) return fields;
  const params = balanced(stripped, parenAt);
  if (!params) return fields;
  const re = /(?:private|protected|public)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(params)) !== null) fields.set(m[1], m[2]);
  return fields;
}

/** The relative-import specifier a named type was imported from, or null. */
export function importSpecifierFor(stripped, typeName) {
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const local = (parts[1] ?? parts[0] ?? "").trim();
      if (local === typeName) return m[2];
    }
  }
  return null;
}

// -- analysis ----------------------------------------------------------------

/**
 * `handler` is the method the decorator sits on. A class-level decorator gets
 * `null`, which is what stops a `file#handler` allowlist entry from excusing it —
 * a class-level opt-out covers every route in the file and must be reasoned about
 * as such.
 */
export function findAnnotationSites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["NoTenantTransaction"]);
  const decoratorRe = new RegExp(
    `@(${[...localNames].map(escapeRe).join("|")})\\s*\\(\\s*\\)`,
  );
  const { methods } = findClassMethods(stripped);
  const byLine = new Map();
  for (const method of methods)
    for (const line of decoratorLineNumbers(stripped, method)) byLine.set(line, method.name);

  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (!decoratorRe.test(lines[i])) continue;
    const handler = byLine.get(i + 1) ?? null;
    results.push({ file: filePath, line: i + 1, kind: "no-tenant-transaction", handler });
  }
  return results;
}

function decoratorLineNumbers(stripped, method) {
  const end = method.line - 1;
  const start = end - method.decorators.split("\n").length + 1;
  const lines = [];
  for (let l = Math.max(1, start); l <= end; l++) lines.push(l);
  lines.push(method.line);
  return lines;
}

export function findContextExitSites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["runOutsideTenantContext"]);
  const callRe = new RegExp(`\\b(${[...localNames].map(escapeRe).join("|")})\\s*\\(`);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (callRe.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "context-exit" });
  }
  return results;
}

export function findIdentitySites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["withIdentity"]);
  const callRe = new RegExp(`\\b(${[...localNames].map(escapeRe).join("|")})\\s*\\(`);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (callRe.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "with-identity" });
  }
  return results;
}

export function findCronBypassSites(src, filePath) {
  const strippedSrc = stripCommentsAndStrings(src);

  const guarded = [];
  for (const guard of ["forEachOrg(", "runInNewTenantTransaction(", "runInTenantTransaction("]) {
    let at = 0;
    while (true) {
      const pos = strippedSrc.indexOf(guard, at);
      if (pos === -1) break;
      const body = balanced(src, pos + guard.length - 1);
      if (body) guarded.push([pos, pos + body.length]);
      at = pos + guard.length;
    }
  }

  const results = [];
  const site =
    /\bthis\.db(?:(?:\?\.|\s*\.\s*)(?:select|insert|update|delete|execute|transaction|query)\b|\s*\[)/g;
  let match;
  while ((match = site.exec(strippedSrc)) !== null) {
    const pos = match.index;
    if (guarded.some(([from, to]) => pos > from && pos < to)) continue;
    results.push({
      file: filePath,
      line: src.slice(0, pos).split("\n").length,
      kind: "cron-bypass",
    });
  }

  const aliasPat = /(?:=\s*this\.db\b|\{\s*\bdb\b[^}]*\}\s*=\s*this\b)/g;
  let aliasMatch;
  while ((aliasMatch = aliasPat.exec(strippedSrc)) !== null) {
    const pos = aliasMatch.index;
    if (guarded.some(([from, to]) => pos > from && pos < to)) continue;
    results.push({
      file: filePath,
      line: src.slice(0, pos).split("\n").length,
      kind: "cron-bypass",
    });
  }

  return results;
}

export function isCronBypass(src) {
  return findCronBypassSites(src, "x").length > 0;
}

export function findAfterCommitDbSites(src, filePath) {
  const strippedSrc = stripCommentsAndStrings(src);
  const needle = "registerAfterCommit(";
  const results = [];
  let idx = 0;

  while (true) {
    const pos = strippedSrc.indexOf(needle, idx);
    if (pos === -1) break;

    const line = src.slice(0, pos).split("\n").length;
    const body = balanced(src, pos + needle.length - 1);
    const strippedBody = body ? stripCommentsAndStrings(body) : null;

    if (
      strippedBody &&
      /\bthis\.db\b/.test(strippedBody) &&
      !/runIn(?:New)?TenantTransaction|withTenant\b/.test(strippedBody)
    )
      results.push({ file: filePath, line, kind: "after-commit-db" });

    idx = pos + needle.length;
  }

  return results;
}

// -- provider-in-transaction -------------------------------------------------

/**
 * A `read(path) -> source | null` over the real filesystem. The self-test swaps
 * in a virtual one so the rule can be bitten by a fixture rather than only by the
 * repository happening to contain a violation — which is the difference between a
 * gate that is proven to fail and one that has merely never fired.
 */
export function fsSourceReader() {
  const cache = new Map();
  return (absPath) => {
    if (cache.has(absPath)) return cache.get(absPath);
    let value = null;
    for (const candidate of [absPath, `${absPath}.ts`, join(absPath, "index.ts")]) {
      if (!existsSync(candidate)) continue;
      try {
        value = readFileSync(candidate, "utf8");
      } catch {
        value = null;
      }
      if (value !== null) break;
    }
    cache.set(absPath, value);
    return value;
  };
}

/**
 * Reads the RAW source, not the stripped copy: `stripCommentsAndStrings` blanks
 * every string literal, and the module specifier IS a string literal, so the
 * import map is unrecoverable from the stripped text.
 */
function resolveCollaborator(fromFile, rawSrc, typeName) {
  const specifier = importSpecifierFor(rawSrc, typeName);
  if (specifier === null || !specifier.startsWith(".")) return null;
  return resolve(fromFile, "..", specifier);
}

/**
 * The trail from one method to a provider adapter call, or null. Returned as a
 * trail rather than a boolean so the failure message names the hops — a bare
 * "this handler is bad" on a five-file chain is unactionable, and an unactionable
 * gate gets allowlisted rather than fixed.
 */
/**
 * Keyed on the source TEXT, not the path: one collaborator is reached from many
 * handlers, and re-stripping and re-parsing it each time took the whole check
 * from two seconds to eight. Text-keyed rather than path-keyed so the self-test
 * can serve three different fixtures from one virtual path.
 */
const PARSE_CACHE = new Map();

function parseFile(src) {
  const hit = PARSE_CACHE.get(src);
  if (hit) return hit;
  const stripped = stripCommentsAndStrings(src);
  const parsed = { ...findClassMethods(stripped), fields: constructorFieldTypes(stripped) };
  PARSE_CACHE.set(src, parsed);
  return parsed;
}

export function traceProviderReach(file, methodName, read, depth = 0, seen = new Set()) {
  const key = `${file}#${methodName}`;
  if (depth > PROVIDER_REACH_MAX_DEPTH || seen.has(key)) return null;
  seen.add(key);

  const src = read(file);
  if (src === null || src === undefined) return null;
  const { className, methods, fields } = parseFile(src);
  const method = methods.find((mm) => mm.name === methodName);
  if (!method) return null;
  const memberCalls = [];
  const memberRe = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = memberRe.exec(method.body)) !== null) memberCalls.push([m[1], m[2]]);

  for (const [field, called] of memberCalls) {
    const type = fields.get(field);
    if (type && PROVIDER_ADAPTER_TYPES.has(type) && PROVIDER_CALL_METHODS.has(called))
      return [`${type}.${called}`];
  }

  for (const [field, called] of memberCalls) {
    const type = fields.get(field);
    if (type === undefined) continue;
    const target = resolveCollaborator(file, src, type);
    if (target === null) continue;
    const trail = traceProviderReach(target, called, read, depth + 1, seen);
    if (trail) return [`${type}.${called}`, ...trail];
  }

  const ownRe = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = ownRe.exec(method.body)) !== null) {
    const trail = traceProviderReach(file, m[1], read, depth + 1, seen);
    if (trail) return [`${className ?? "this"}.${m[1]}`, ...trail];
  }

  return null;
}

/**
 * Route handlers that keep the ambient request transaction and still reach a
 * provider adapter. `@NoTenantTransaction()` on the handler OR anywhere before
 * the `class` keyword (a class-level opt-out) clears the handler, because in that
 * shape the connection has already been released and the service is free to open
 * its own short transaction around the read.
 */
export function findProviderInTransactionSites(src, filePath, absPath, read) {
  if (!/@Controller\s*\(/.test(src)) return [];

  const localNames = collectImportAliases(src, ["NoTenantTransaction"]);
  const optOutRe = new RegExp(`@(${[...localNames].map(escapeRe).join("|")})\\s*\\(\\s*\\)`);
  const { classAt, methods } = parseFile(src);
  if (classAt === -1) return [];
  if (optOutRe.test(stripCommentsAndStrings(src).slice(0, classAt))) return [];

  const results = [];
  for (const method of methods) {
    if (!ROUTE_DECORATOR_RE.test(method.decorators)) continue;
    if (optOutRe.test(method.decorators)) continue;
    const trail = traceProviderReach(absPath, method.name, read);
    if (!trail) continue;
    results.push({
      file: filePath,
      line: method.line,
      kind: "provider-in-transaction",
      handler: method.name,
      trail: trail.join(" -> "),
    });
  }
  return results;
}

// -- self-test ---------------------------------------------------------------

if (SELF_TEST) {
  const aiFile = "src/modules/ai/core/controllers/some-ai.controller.ts";
  const unknownFile = "src/modules/billing/billing.controller.ts";
  const placementFile = "src/common/region/placement-lookup.ts";
  const jwtFile = "src/common/auth/jwt-auth.guard.ts";

  const annotationSrc = "@NoTenantTransaction()\nasync stream() {}";
  const contextExitSrc = "return runOutsideTenantContext(async () => { return 1; });";
  const withIdentitySrc = "const rows = await withIdentity(this.db, userId, (tx) => tx.select().from(t));";

  const cronBypassSrc = "async run() {\n  const rows = await this.db.select().from(organizations);\n}";
  const cronSafeSrc =
    "async run() {\n  await forEachOrg(this.db, 'sweep', async (tx) => { await this.db.select().from(orgs); });\n}";
  const cronPartlyGuardedSrc = [
    "async run() {",
    "  await forEachOrg(this.db, 'sweep', async (tx) => { await this.db.select().from(a); });",
    "  await this.db.transaction(async (tx) => { await tx.update(organizations).set({}); });",
    "}",
  ].join("\n");

  const nakedHookSrc = [
    "registerAfterCommit(async () => {",
    "  await this.db.update(someTable).set({ x: 1 }).where(eq(someTable.id, id));",
    "});",
  ].join("\n");

  const guardedHookSrc = [
    "registerAfterCommit(async () => {",
    "  await runInNewTenantTransaction(this.db, orgId, async (tx) => {",
    "    await tx.update(someTable).set({ x: 1 }).where(eq(someTable.id, id));",
    "  });",
    "});",
  ].join("\n");

  const emptyReasonAllowlist = new Map([["src/foo/bar.ts", ""]]);
  let emptyReasonDetected = false;
  for (const [, reason] of emptyReasonAllowlist) {
    if (!reason || !reason.trim()) { emptyReasonDetected = true; break; }
  }

  const parenInStringSrc = [
    'await forEachOrg(this.db, "(", async (tx) => { await tx.select().from(a); });',
    "await this.db.select().from(bypass_table);",
  ].join("\n");

  const cronOutsidePathSrc = [
    "import { Cron } from '@nestjs/schedule';",
    "@Cron('0 * * * *')",
    "async run() { await this.db.select().from(organizations); }",
  ].join("\n");

  const optChainingEvadeSrc = [
    "async run() {",
    "  const rows = await this.db?.select().from(organizations);",
    "}",
  ].join("\n");

  const aliasedWithIdentitySrc = [
    "import { withIdentity as wi } from '../common/identity';",
    "async doWork() {",
    "  const rows = await wi(this.db, userId, (tx) => tx.select().from(t));",
    "}",
  ].join("\n");

  const commentAnnotationSrc = "const x = 1; // @NoTenantTransaction()\nasync method() {}";

  const spacedDecoratorSrc = "@NoTenantTransaction( )\nasync stream() {}";

  const hookWithCommentDbSrc = [
    "registerAfterCommit(async () => {",
    "  // this.db.update(someTable).set({ x: 1 });",
    "  doSomethingElse();",
    "});",
  ].join("\n");

  const aliasedDecoratorSrc = [
    "import { NoTenantTransaction as NTT } from './decorators';",
    "@NTT()",
    "async stream() {}",
  ].join("\n");

  // -- provider-in-transaction fixtures --------------------------------------
  //
  // The rule is bitten by a fixture rather than by whatever the repository
  // happens to contain, because a detector proven only by live findings stops
  // being proven the day somebody fixes the last one.

  const CTRL_PATH = "/v/fixture.controller.ts";
  const SVC_PATH = "/v/fixture.service";

  const providerService = [
    'import { AiGatewayService } from "../ai/gateway";',
    "export class FixtureService {",
    "  constructor(",
    "    @Inject(DRIZZLE) private readonly db: Db,",
    "    private readonly gateway: AiGatewayService,",
    "  ) {}",
    // The return type carries a brace: taking it for the body would find nothing.
    "  private async run(): Promise<{ text: string }> {",
    "    const r = await this.gateway.invokeTextWithUsage({ feature: 'f' });",
    "    return { text: r.data };",
    "  }",
    "  summarize() { return this.run(); }",
    "  probe() { return this.gateway.isConfigured(); }",
    "}",
  ].join("\n");

  const controllerBody = (decorators, method = "summarize") =>
    [
      'import { FixtureService } from "./fixture.service";',
      ...decorators.classLevel,
      '@Controller("fixture")',
      "export class FixtureController {",
      "  constructor(private readonly svc: FixtureService) {}",
      "",
      "  @UseInterceptors(",
      '    FileInterceptor("file", { limits: { fileSize: 1 } }),',
      "  )",
      '  @Post("summarize")',
      ...decorators.handler,
      "  async summarize(): Promise<unknown> {",
      `    return this.svc.${method}();`,
      "  }",
      "}",
    ].join("\n");

  const nakedController = controllerBody({ classLevel: [], handler: [] });
  const handlerOptOutController = controllerBody({
    classLevel: [],
    handler: ["  @NoTenantTransaction()"],
  });
  const classOptOutController = controllerBody({
    classLevel: ["@NoTenantTransaction()"],
    handler: [],
  });
  const harmlessCallController = controllerBody({ classLevel: [], handler: [] }, "probe");

  const virtualRead = (path) => {
    if (path === CTRL_PATH) return virtualControllerSrc;
    if (path === SVC_PATH) return providerService;
    return null;
  };
  let virtualControllerSrc = nakedController;

  const providerSites = (src) => {
    virtualControllerSrc = src;
    return findProviderInTransactionSites(src, "src/fixture.controller.ts", CTRL_PATH, virtualRead);
  };

  const nakedFindings = providerSites(nakedController);
  const nonControllerFindings = providerSites(
    nakedController.replace('@Controller("fixture")', "// plain class"),
  );

  const annotationInUnknown = findAnnotationSites(annotationSrc, unknownFile);
  const annotationInAi = findAnnotationSites(annotationSrc, aiFile);
  const contextExitInPlacement = findContextExitSites(contextExitSrc, placementFile);
  const contextExitInUnknown = findContextExitSites(contextExitSrc, unknownFile);
  const withIdentityInJwt = findIdentitySites(withIdentitySrc, jwtFile);
  const withIdentityInUnknown = findIdentitySites(withIdentitySrc, unknownFile);
  const nakedSites = findAfterCommitDbSites(nakedHookSrc, unknownFile);
  const guardedSites = findAfterCommitDbSites(guardedHookSrc, unknownFile);

  const checks = {
    annotationFoundInSource: annotationInUnknown.length === 1,
    annotationAllowedForAiGlob: allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST) !== null,
    annotationNotAllowedForUnknownFile: allowlistReason(unknownFile, NO_TENANT_TRANSACTION_ALLOWLIST) === null,
    annotationInAiFileNotFlagged: annotationInAi.length === 1 && allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST) !== null,
    contextExitFoundInSource: contextExitInPlacement.length === 1,
    contextExitAllowlistedWithReason: allowlistReason(placementFile, CONTEXT_EXIT_ALLOWLIST) !== null,
    contextExitNotAllowlistedForUnknown: allowlistReason(unknownFile, CONTEXT_EXIT_ALLOWLIST) === null,
    contextExitInUnknownIsFlagged: contextExitInUnknown.length === 1,
    withIdentityFoundInSource: withIdentityInJwt.length === 1,
    withIdentityAllowlistedWithReason: allowlistReason(jwtFile, WITH_IDENTITY_ALLOWLIST) !== null,
    withIdentityNotAllowlistedForUnknown: allowlistReason(unknownFile, WITH_IDENTITY_ALLOWLIST) === null,
    withIdentityInUnknownIsFlagged: withIdentityInUnknown.length === 1,
    cronBypassDetectedWhenNoGuard: isCronBypass(cronBypassSrc),
    cronBypassNotFlaggedWhenGuardPresent: !isCronBypass(cronSafeSrc),
    cronBypassFoundWhenOnlySomeWorkIsGuarded:
      findCronBypassSites(cronPartlyGuardedSrc, "x").length === 1,
    afterCommitDbFlaggedWhenNaked: nakedSites.length === 1,
    afterCommitDbCleanWhenGuarded: guardedSites.length === 0,
    emptyReasonInAllowlistIsDetected: emptyReasonDetected,
    balancedIgnoresParenInsideString: findCronBypassSites(parenInStringSrc, "x").length > 0,
    cronDetectedOutsideCronFolder: isCronLike(cronOutsidePathSrc, "src/modules/billing/billing.scheduler.ts"),
    optionalChainingDetected: findCronBypassSites(optChainingEvadeSrc, "x").length > 0,
    aliasedWithIdentityDetected: findIdentitySites(aliasedWithIdentitySrc, unknownFile).length > 0,
    annotationInCommentNotFlagged: findAnnotationSites(commentAnnotationSrc, unknownFile).length === 0,
    spacedDecoratorDetected: findAnnotationSites(spacedDecoratorSrc, unknownFile).length > 0,
    afterCommitDbCommentNotFlagged: findAfterCommitDbSites(hookWithCommentDbSrc, unknownFile).length === 0,
    aliasedDecoratorDetected: findAnnotationSites(aliasedDecoratorSrc, unknownFile).length > 0,

    // -- provider-in-transaction: the rule bites, and only on the bad shape ---
    providerInTransactionDetectedThroughInjectedService:
      nakedFindings.length === 1 && nakedFindings[0].handler === "summarize",
    providerInTransactionNamesTheTrail:
      nakedFindings[0]?.trail === "FixtureService.summarize -> FixtureService.run -> AiGatewayService.invokeTextWithUsage",
    providerInTransactionClearedByHandlerDecorator:
      providerSites(handlerOptOutController).length === 0,
    providerInTransactionClearedByClassDecorator:
      providerSites(classOptOutController).length === 0,
    providerInTransactionIgnoresNonProviderMethod:
      providerSites(harmlessCallController).length === 0,
    providerInTransactionIgnoresNonController: nonControllerFindings.length === 0,
    // The `Promise<{ text: string }>` return type in the fixture: a body finder
    // that stopped at the first brace would parse the TYPE as the body, find no
    // provider call, and report clean on a violation.
    returnTypeBraceIsNotMistakenForABody:
      findClassMethods(stripCommentsAndStrings(providerService))
        .methods.find((m) => m.name === "run")
        ?.body.includes("invokeTextWithUsage") === true,
    // `FileInterceptor(` sits at the start of a line inside a decorator argument.
    decoratorArgumentIsNotMistakenForAMethod: !findClassMethods(
      stripCommentsAndStrings(nakedController),
    ).methods.some((m) => m.name === "FileInterceptor"),

    // -- handler-scoped allowlist entries ------------------------------------
    handlerScopedEntryMatchesTheNamedHandler:
      allowlistReason(
        "src/modules/kb/wiki/kb-page-ai.controller.ts",
        NO_TENANT_TRANSACTION_ALLOWLIST,
        "summarize",
      ) !== null,
    handlerScopedEntryRejectsAnUnnamedHandlerInTheSameFile:
      allowlistReason(
        "src/modules/kb/wiki/kb-page-ai.controller.ts",
        NO_TENANT_TRANSACTION_ALLOWLIST,
        "somethingAddedLater",
      ) === null,
    handlerScopedEntryRejectsAFindingWithNoHandler:
      allowlistReason(
        "src/modules/kb/wiki/kb-page-ai.controller.ts",
        NO_TENANT_TRANSACTION_ALLOWLIST,
        null,
      ) === null,
    fileScopedEntryStillMatchesRegardlessOfHandler:
      allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST, "anything") !== null &&
      allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST, null) !== null,
    annotationSiteCarriesTheHandlerItDecorates:
      findAnnotationSites(handlerOptOutController, unknownFile)[0]?.handler === "summarize",
    classLevelAnnotationCarriesNoHandler:
      findAnnotationSites(classOptOutController, unknownFile)[0]?.handler === null,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

validateAllowlists();

if (!existsSync(SCAN_ROOT)) {
  process.stderr.write(`Cannot read scan root: ${SCAN_ROOT}\n`);
  process.exit(2);
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) results.push(full);
  }
  return results;
}

const findings = [];
const readSource = fsSourceReader();

for (const file of walkTs(SCAN_ROOT)) {
  const rel = toRelPath(file);
  const src = readFileSync(file, "utf8");

  for (const f of findAnnotationSites(src, rel)) findings.push(f);
  for (const f of findContextExitSites(src, rel)) findings.push(f);
  for (const f of findIdentitySites(src, rel)) findings.push(f);
  for (const f of findAfterCommitDbSites(src, rel)) findings.push(f);
  for (const f of findProviderInTransactionSites(src, rel, file, readSource)) findings.push(f);

  if (isCronLike(src, rel)) for (const f of findCronBypassSites(src, rel)) findings.push(f);
}

if (!EXTERNAL_ROOT && findings.length < MIN_BYPASS_SITES) {
  process.stderr.write(
    `Found only ${findings.length} bypass sites. That is a broken pattern, not a clean codebase.\n`,
  );
  process.exit(2);
}

const excused = findings.filter((f) => resolveAllowlist(f) !== null);
const violations = findings.filter((f) => resolveAllowlist(f) === null);

const count = (kind) => findings.filter((f) => f.kind === kind).length;

console.log(`Bypass sites found       ${findings.length}`);
console.log(`  @NoTenantTransaction   ${count("no-tenant-transaction")}`);
console.log(`  runOutsideTenantCtx    ${count("context-exit")}`);
console.log(`  withIdentity           ${count("with-identity")}`);
console.log(`  cron direct db         ${count("cron-bypass")}`);
console.log(`  registerAfterCommit    ${count("after-commit-db")}`);
console.log(`  provider in tx         ${count("provider-in-transaction")}`);
console.log("");

const label = (f) => (f.handler ? `${f.file}:${f.line} ${f.handler}()` : `${f.file}:${f.line}`);

if (excused.length > 0) {
  console.log("ALLOWLISTED — each has a reason:");
  for (const f of excused)
    console.log(`  SKIP  [${f.kind}]  ${label(f)}  — ${resolveAllowlist(f)}`);
  console.log("");
}

if (violations.length === 0) {
  console.log("OK — every database bypass is on the allowlist with a reason.");
  process.exit(0);
}

console.error("DATABASE BYPASS NOT ALLOWLISTED:");
for (const f of violations.sort((a, b) =>
  `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`),
))
  console.error(
    `  FAIL  [${f.kind}]  ${label(f)}${f.trail ? `\n          holds the request transaction across  ${f.trail}` : ""}`,
  );
console.error("");
if (violations.some((f) => f.kind === "provider-in-transaction"))
  console.error(
    "A provider-in-transaction handler pins a pooled connection, idle in transaction,\n" +
      "for the whole provider round trip. Fix: @NoTenantTransaction() on the handler, move\n" +
      "the tenant-scoped read and the authorization check into a short\n" +
      "runInTenantTransaction(db, fn, { orgId }) that commits BEFORE the provider call, and\n" +
      "add AiRequestAbortInterceptor to the controller so the call stays cancellable.\n" +
      "Wrapping the read WITHOUT the decorator does nothing: runInTenantTransaction reuses\n" +
      "the ambient request transaction instead of opening a short one.\n",
  );
console.error(`FAIL — ${violations.length} of ${findings.length} bypass site(s) not on the allowlist.`);
process.exit(1);
