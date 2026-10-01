// scripts/build-authorization-census.mjs
//
// Census: per-method authorization facts for every controller in
// backend/src/modules/build/**.
//
// WHY THIS EXISTS
//   A prior pass asserted "2 VULNERABLE + 14 NEEDS-REVIEW" across the Build
//   controllers with no reproducible artefact behind it. This script is the
//   artefact: it re-derives every fact from the AST on each run, so the counts
//   in docs/build-module/authorization-census.md can never drift from source
//   without the file changing.
//
// WHAT IT RECORDS, PER HTTP HANDLER
//   controller file, class, method name
//   HTTP verb + full route path (@Controller prefix + verb path)
//   guards         — @RequirePermission / @RequireModule / @Public / @Universal
//                    / @AuthorizedInService, AND whether @UseGuards(JwtAuthGuard,
//                    PermissionGuard) is actually on the class or the method.
//                    Rule BE-29: the classification decorator ALONE gates
//                    nothing — without the guard in the chain there is no
//                    PermissionGuard to read it.
//   orgScoping     — does the org identity (u.orgId, or the whole CurrentUser
//                    context) reach the service method, and does that method
//                    bind it in a where clause / access assert?
//   parentScoping  — for a nested route (:projectId/releases/:releaseId), does
//                    the PARENT route param reach the service method, and is the
//                    child row bound to it there?
//   validation     — @Validate({ params }) present, and does the params schema
//                    declare EVERY route param? Rule BE-14: one undeclared param
//                    under .strict() 400s every call to the route.
//   idempotency    — @Idempotent() on mutating verbs (POST/PUT/PATCH/DELETE)
//   classification — VERIFIED | VULNERABLE | NEEDS-REVIEW | CLOSED
//   evidence       — file:line for each claim
//
// CLASSIFICATION CONTRACT
//   The static pass NEVER emits VULNERABLE on its own. A heuristic that says
//   "this looks unbound" is a lead, not a finding. VULNERABLE and CLOSED come
//   only from REVIEWED below — hand-read entries that name the exact line. Each
//   REVIEWED entry carries an `anchor` regex that the script re-tests against the
//   live source; if the code moves or is fixed, the entry fails loudly (exit 1)
//   rather than reporting a stale verdict.
//
//     VULNERABLE   — REVIEWED entry, verdict VULNERABLE. A named line where a
//                    nested resource is looked up without its parent binding, or
//                    a route reachable with no guard.
//     CLOSED       — REVIEWED entry, verdict CLOSED. A previously-raised finding
//                    this tree provably fixes; the anchor pins the fix.
//     CLOSED-IN-FLIGHT
//                  — REVIEWED entry. The defect is REAL AND PRESENT in this tree,
//                    and a fix for it is already committed on another branch. The
//                    anchor pins the OLD line deliberately: when the fix merges
//                    here the anchor breaks and forces re-classification to
//                    CLOSED. Never report this as if the tree were safe.
//     NEEDS-REVIEW — the static pass raised >=1 lead the reviewer has not ruled
//                    on, or could not resolve the service method at all.
//     VERIFIED     — every dimension resolved clean. Two shapes may NOT reach
//                    VERIFIED on the static pass alone, because they are exactly
//                    what a static reader is worst at, and both need a REVIEWED
//                    entry on top:
//                      - handlers with >=2 route params (the parent-binding class)
//                      - @Public handlers, where the whole authorization decision
//                        is the token check inside the service and there is no
//                        guard, orgId or route param for the static pass to read.
//
// DESIGN CONSTRAINTS
//   - Static AST parse only. No Nest bootstrap, no DB connection, no .env read.
//   - A census that resolves nothing reports zero vacuously. CONTROLLER_FLOOR /
//     METHOD_FLOOR make that an exit 2, and --self-test asserts a known-present
//     route is actually seen in the real tree.
//
// Usage:
//   node scripts/build-authorization-census.mjs             # analyse + write reports
//   node scripts/build-authorization-census.mjs --check     # analyse, fail if reports stale
//   node scripts/build-authorization-census.mjs --self-test
//
// Exit codes:
//   0 = census produced (and, under --check, byte-identical to what is committed)
//   1 = a REVIEWED anchor no longer matches source, or --check found drift,
//       or --self-test failed
//   2 = INCONCLUSIVE: the walker did not reach the controller tree

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const ts = req("typescript");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SRC = join(REPO_ROOT, "src");
const BUILD_MODULE = join(SRC, "modules", "build");
const OUT_DIR = join(REPO_ROOT, "docs", "build-module");
const OUT_MD = join(OUT_DIR, "authorization-census.md");
const OUT_JSON = join(OUT_DIR, "authorization-census.json");
const OUT_RATCHET = join(OUT_DIR, "authorization-census-ratchet.json");

// Vacuity floors. Raise when the build module grows; never lower to make a run pass.
const CONTROLLER_FLOOR = 40;
const METHOD_FLOOR = 250;

const HTTP_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Head", "Options", "All"]);
const MUTATING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// ── REVIEWED: hand-read verdicts ─────────────────────────────────────────────
//
// key    — "<rel controller path>#<method>"
// anchor — regex re-tested against the named evidence file. Its job is to fail
//          when the code it describes changes, so a verdict cannot go stale.

const REVIEWED_INLINE = [
  {
    key: "modules/build/core/custom-fields/projects-custom-fields.controller.ts#updateField",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/custom-fields/:fieldId. The controller declares no @Param(\"projectId\"), so the path segment is never read; the service UPDATEs on (id, orgId, entityType) only. The same service file's listFields binds customFieldDefinitions.projectId, and the column exists and is NOT NULL — so the omission is asymmetry inside one file, not an absent column. Any :projectId in the URL edits a field owned by any other project in the same org, and the row's own projectId is left untouched.",
    blastRadius:
      "Intra-tenant, not cross-tenant: orgId is still bound, so the write cannot leave the organisation. The caller already holds org-wide build:manage. The defect is the unverified path segment — it breaks the 404 contract for a foreign :projectId and defeats any project-scoped gate layered on later.",
    evidence: [
      {
        file: "src/modules/build/core/custom-fields/projects-custom-fields.controller.ts",
        line: 65,
        anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/,
        note: "bound to the URL project",
      },
      {
        file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts",
        line: 143,
        anchor: /eq\(customFieldDefinitions\.projectId, projectId\),/,
        note: "bound to the URL project",
      },
      {
        file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts",
        line: 87,
        anchor: /eq\(customFieldDefinitions\.projectId, projectId\)/,
        note: "listFields DOES bind projectId — the control proving the column is usable here",
      },
    ],
  },
  {
    key: "modules/build/core/custom-fields/projects-custom-fields.controller.ts#deleteField",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/custom-fields/:fieldId. Identical shape to updateField: no @Param(\"projectId\"), and the DELETE where clause is (id, orgId, entityType). Unlike listFields/createField this path does not even call assertProjectInOrg, so a :projectId belonging to another organisation still deletes an in-org field.",
    blastRadius:
      "Intra-tenant. orgId is bound, so no cross-tenant delete. Cross-PROJECT delete inside the org is reachable by anyone holding build:manage.",
    evidence: [
      {
        file: "src/modules/build/core/custom-fields/projects-custom-fields.controller.ts",
        line: 79,
        anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/,
        note: "bound to the URL project",
      },
      {
        file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts",
        line: 166,
        anchor: /eq\(customFieldDefinitions\.projectId, projectId\),/,
        note: "bound to the URL project",
      },
    ],
  },
  {
    key: "modules/build/core/webhooks/projects-webhooks.controller.ts#deleteWebhook",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/webhooks/:webhookId. No @Param(\"projectId\"); the service DELETEs on (id, orgId). The same service file already owns assertWebhookOwnership(orgId, projectId, webhookId), which binds projectWebhooks.projectId and is called by sendTest — so the correct helper exists and this one path skips it.",
    blastRadius:
      "Intra-tenant. orgId is bound. A webhook registered against project A is deletable through project B's URL by any holder of build:manage.",
    evidence: [
      {
        file: "src/modules/build/core/webhooks/projects-webhooks.controller.ts",
        line: 60,
        anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/,
        note: "bound to the URL project",
      },
      {
        file: "src/modules/build/core/webhooks/projects-webhooks.service.ts",
        line: 48,
        anchor: /eq\(projectWebhooks\.projectId, projectId\),/,
        note: "bound to the URL project",
      },
      {
        file: "src/modules/build/core/webhooks/projects-webhooks.service.ts",
        line: 48,
        anchor: /eq\(projectWebhooks\.projectId, projectId\),/,
        note: "bound to the URL project",
      },
    ],
  },

  // ── The :projectId-never-bound family ────────────────────────────────────
  // Every entry below was hand-read. They share one shape: the route advertises
  // a parent `:projectId` (or `:ticketId` / `:checklistId`), @Validate accepts it,
  // and then nothing ever compares it to the row being read or written. orgId IS
  // bound in all of them, so none is cross-tenant; the reachable blast radius is
  // another PROJECT inside the caller's own organisation, plus a broken 404.

  {
    key: "modules/build/core/project-crud/project-resources.controller.ts#updateCustomState",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/custom-states/:stateId. The controller DOES declare @Param(\"projectId\") but binds it to `_` and throws it away; the service finds the state by (id, orgId) alone. The permission check that follows uses the ROW's own projectId, so the caller is re-authorised against whatever project the state really belongs to — the URL segment is decorative.",
    blastRadius:
      "Intra-tenant. A state belonging to project A is editable through project B's URL by a caller holding build:manage on A.",
    evidence: [
      { file: "src/modules/build/core/project-crud/project-resources.controller.ts", line: 178, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/custom-states/projects-custom-states.service.ts", line: 171, anchor: /eq\(projectStatuses\.projectId, projectId\),/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/core/project-crud/project-resources.controller.ts#deleteCustomState",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/custom-states/:stateId. Identical to updateCustomState: @Param(\"projectId\") is bound to `_` and discarded, and the delete resolves the state by (id, orgId).",
    blastRadius: "Intra-tenant cross-project delete.",
    evidence: [
      { file: "src/modules/build/core/project-crud/project-resources.controller.ts", line: 192, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/custom-states/projects-custom-states.service.ts", line: 307, anchor: /eq\(projectStatuses\.projectId, projectId\),/, note: "bound to the URL project" },
    ],
  },

  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#getSubtasks",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "GET /build/:projectId/tickets/:ticketId/subtasks. Closed: the handler forwards the authenticated actor with projectId and ticketId, and getSubtasks calls assertTicketReadAccess before reading children. That helper binds tenant+project+ticket, verifies project membership, and applies the ticket DataScope predicate.",
    blastRadius: "None: a mismatched ticket 404s, while an inaccessible project or ticket scope is rejected before any subtask row is read.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 68, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 237, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "actor-aware ticket authorization runs before the subtask query" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 37, anchor: /eq\(tickets\.projectId, projectId\),/, note: "the lookup binds tenant, project, and ticket" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#getWatchers",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "GET /build/:projectId/tickets/:ticketId/watchers. Closed: the handler forwards the actor and both route ids, and getWatchers calls assertTicketReadAccess before reading watcher rows. The helper enforces tenant, project membership, route binding, and ticket DataScope.",
    blastRadius: "None: authorization completes before watcher storage is queried.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 120, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 256, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "actor-aware authorization runs before the watcher query" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#addWatcher",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "POST /build/:projectId/tickets/:ticketId/watchers. Closed: addWatcher receives the actor and both route ids and calls assertTicketReadAccess before resolving the requested organization member or inserting a watcher.",
    blastRadius: "None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 133, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 295, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "authorization precedes member resolution and insertion" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#removeWatcher",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/tickets/:ticketId/watchers. Closed: removeWatcher carries the authenticated actor and calls assertTicketReadAccess before resolving membership and deleting the actor's watcher row.",
    blastRadius: "None: tenant, project membership, route binding, and ticket DataScope are enforced before the delete.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 147, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 343, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "authorization precedes the watcher delete" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#addLabel",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "POST /build/:projectId/tickets/:ticketId/labels. Closed: addLabel receives the actor and both route ids and calls assertTicketReadAccess before inserting a tenant-scoped label mapping.",
    blastRadius: "None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 160, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 373, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "authorization precedes the label mapping insert" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#addAttachment",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "POST /build/:projectId/tickets/:ticketId/attachments. Closed: addAttachment receives the actor and both route ids and calls assertTicketReadAccess before inserting the tenant-scoped attachment row.",
    blastRadius: "None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 188, anchor: /@Param\("projectId", ParseIntPipe\) projectId: number,/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 429, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "authorization precedes the attachment insert" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#addComment",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/comments. Closed: the handler forwards the actor and route ids, and resolveTicketForComment calls assertTicketReadAccess before resolving the ticket and creating the comment.",
    blastRadius: "None: tenant, project membership, route binding, and ticket DataScope are enforced before the comment write.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 54, anchor: /return this\.subresources\.addComment\(u, projectId, ticketId, body\);/, note: "the actor and both route ids reach the service" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 43, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "actor-aware authorization runs before ticket and comment storage" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 47, anchor: /\.\.\.\(projectId === null \? \[\] : \[eq\(tickets\.projectId, projectId\)\]\),/, note: "the ticket lookup also binds the URL project" },
    ],
  },

  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#updateChecklist",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId. Closed: the handler forwards the actor and every route id; the facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before the update.",
    blastRadius: "None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before mutation.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 503, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced in the actor-aware facade" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 168, anchor: /await this\.requireChecklistInTicket\(orgId, projectId, ticketId, checklistId\);/, note: "the checklist is bound to the authorized ticket" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#deleteChecklist",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId. Closed: the actor-aware facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before deletion.",
    blastRadius: "None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before deletion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 519, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced in the actor-aware facade" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 192, anchor: /await this\.requireChecklistInTicket\(orgId, projectId, ticketId, checklistId\);/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#createChecklistItem",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "POST /build/:projectId/tickets/:ticketId/checklists/:checklistId/items. Closed: the actor-aware facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before creating the item.",
    blastRadius: "None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before insertion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 540, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced in the actor-aware facade" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 219, anchor: /await this\.requireChecklistInTicket\(orgId, projectId, ticketId, checklistId\);/, note: "the checklist is bound to the authorized ticket" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#updateChecklistItem",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. Closed: the actor-aware facade enforces project membership and ticket DataScope, requireChecklistInTicket binds the checklist to that ticket, and the item lookup and update both bind itemId to checklistId+orgId.",
    blastRadius:
      "None: every route parent and the item itself are bound before the mutation.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 564, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced in the actor-aware facade" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 250, anchor: /await this\.requireChecklistInTicket\(orgId, projectId, ticketId, checklistId\);/, note: "the checklist is bound to the authorized ticket" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 255, anchor: /eq\(ticketChecklistItems\.checklistId, checklistId\),/, note: "the item is bound to the URL checklist" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#deleteChecklistItem",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. Closed: the actor-aware facade enforces project membership and ticket DataScope, requireChecklistInTicket binds the checklist to that ticket, and the item lookup and delete bind itemId to checklistId+orgId.",
    blastRadius: "None: every route parent and the item itself are bound before deletion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-subresources.service.ts", line: 582, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced in the actor-aware facade" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 284, anchor: /await this\.requireChecklistInTicket\(orgId, projectId, ticketId, checklistId\);/, note: "the checklist is bound to the authorized ticket" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 289, anchor: /eq\(ticketChecklistItems\.checklistId, checklistId\),/, note: "the item is bound to the URL checklist" },
    ],
  },

  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#getTicket",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "GET /build/:projectId/tickets/:ticketId. Closed: the selector binds ticketId+projectId, readTicket binds orgId and deletedAt, resolves the ticket DataScope, and separately verifies project membership before returning the record.",
    blastRadius: "None: tenant, route binding, project membership, and ticket DataScope are enforced.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 54, anchor: /and\(eq\(tickets\.id, ticketId\), eq\(tickets\.projectId, projectId\)\),/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 63, anchor: /const read = await resolveTicketsScope\(this\.access, u\);/, note: "the ticket DataScope is resolved" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 108, anchor: /const projectAccess = await resolveProjectAccess\(/, note: "project membership is checked before the record is returned" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#updateTicket",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId. Closed: the pre-read binds ticketId+projectId+orgId, project access is checked, and authorizeMutation applies the canonical record-level mutation policy before the transaction updates the ticket. The body moved to apply-ticket-change.ts, which added a system-job arm: when systemJobCovers(u.principal, \"build:tickets:update\") the transaction takes lockProjectTicketMutation alone and authorizeMutation does not run. That arm is reachable only by a system-job principal, and resolveProjectAccess still gates it above the transaction; it is recorded here because the claim \"authorizeMutation runs before the update\" is now true of human actors only.",
    blastRadius:
      "None: tenant, route binding, project membership, and ticket record scope are enforced before mutation.",
    evidence: [
      { file: "src/modules/build/core/tickets/apply-ticket-change.ts", line: 206, anchor: /\.\.\.\(projectId === null \? \[\] : \[eq\(tickets\.projectId, projectId\)\]\),/, note: "bound to the URL project" },
      { file: "src/modules/build/core/tickets/apply-ticket-change.ts", line: 257, anchor: /if \(systemJobCovers\(u\.principal, "build:tickets:update"\)\)/, note: "a system-job principal takes the lock-only arm and does NOT run authorizeMutation" },
      { file: "src/modules/build/core/tickets/apply-ticket-change.ts", line: 260, anchor: /await deps\.query\.authorizeMutation\(tx, u, ticketProjectId, \[ticketId\]\);/, note: "for every human actor, canonical record-level mutation authorization runs inside the transaction" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#deleteTicket",
    verdict: "CLOSED",
    finding: "ticket-data-scope-missing",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId. Closed: the controller forwards CurrentUserContext, and deleteTicket calls assertTicketReadAccess before its tenant/project-bound pre-read or any delete work. The helper verifies project membership and ticket DataScope.",
    blastRadius: "None: an inaccessible or mismatched ticket is rejected before blocker inspection or deletion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets.controller.ts", line: 270, anchor: /return this\.del\.deleteTicket\(u, projectId, ticketId, force === "true"\);/, note: "the complete authenticated actor reaches the service" },
      { file: "src/modules/build/core/tickets/projects-tickets-delete.service.ts", line: 43, anchor: /async deleteTicket\(/, note: "the terminal service accepts CurrentUserContext" },
      { file: "src/modules/build/core/tickets/projects-tickets-delete.service.ts", line: 50, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "canonical ticket authorization runs before the pre-read and delete path" },
      { file: "src/modules/build/core/tickets/build-ticket-read-access.ts", line: 50, anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },

  {
    key: "modules/build/execution/iterations.controller.ts#getSprint",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "GET /build/:projectId/sprints/:sprintId. The parent-binding gap is moot: the handler is frozen and throws GoneException before any read, so no sprint row is resolved by any key. The route and its @RequirePermission are retained on purpose; only the query body is gone.",
    blastRadius: "None — the handler reads nothing.",
    evidence: [
      { file: "src/modules/build/execution/sprints.service.ts", line: 24, anchor: /async getSprint\(_orgId: string, _projectId: number, _sprintId: number\): Promise<never> \{/, note: "every parameter is unused" },
      { file: "src/modules/build/execution/sprints.service.ts", line: 25, anchor: /throw new GoneException\(FROZEN\);/, note: "throws before any query" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#updateSprint",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "PATCH /build/:projectId/sprints/:sprintId. The parent-binding gap is moot: the handler is frozen and throws GoneException before any pre-read or UPDATE, so no sprint row is written by any key.",
    blastRadius: "None — the handler writes nothing.",
    evidence: [
      { file: "src/modules/build/execution/sprints.service.ts", line: 28, anchor: /async updateSprint\($/, note: "every parameter is unused" },
      { file: "src/modules/build/execution/sprints.service.ts", line: 35, anchor: /throw new GoneException\(FROZEN\);/, note: "throws before any query" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#updateModule",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "PATCH /build/:projectId/modules/:moduleId. No @Param(\"projectId\"); the UPDATE binds (id, orgId).",
    blastRadius: "Intra-tenant cross-project write.",
    evidence: [
      { file: "src/modules/build/execution/modules.service.ts", line: 170, anchor: /eq\(modules\.projectId, projectId\),/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#deleteModule",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/modules/:moduleId. No @Param(\"projectId\"). The transaction also nulls tickets.moduleId across the org by (moduleId, orgId) before deleting the module by (id, orgId).",
    blastRadius: "Intra-tenant cross-project delete, with a side effect on every ticket referencing the module.",
    evidence: [
      { file: "src/modules/build/execution/modules.service.ts", line: 205, anchor: /eq\(tickets\.projectId, projectId\),/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/timesheets.controller.ts#logTicketTime",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/time-entries. No @Param(\"projectId\"); the ticket is resolved by (id, orgId) and the access checks that follow use the ticket's own project.",
    blastRadius: "Intra-tenant; row-derived access check narrows it as with updateTicket.",
    evidence: [
      { file: "src/modules/build/execution/timesheets.service.ts", line: 424, anchor: /eq\(tickets\.projectId, projectId\),/, note: "bound to the URL project" },
    ],
  },

  {
    key: "modules/build/execution/workspace.controller.ts#updateMilestone",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/milestones/:milestoneId. The @Controller prefix itself is \"build/:projectId/milestones\", yet no @Param(\"projectId\") is declared and the UPDATE binds (id, orgId).",
    blastRadius: "Intra-tenant cross-project write; org-wide permission is sufficient, there is no row-derived re-check.",
    evidence: [
      { file: "src/modules/build/execution/workspace.service.ts", line: 185, anchor: /\.where\(and\(eq\(projectMilestones\.id, milestoneId\), eq\(projectMilestones\.projectId, projectId\), eq\(projectMilestones\.orgId, orgId\), isNull\(projectMilestones\.deletedAt\), eq\(projectMilestones\.version, before\.version\)\)\)/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#deleteMilestone",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/milestones/:milestoneId. Same as updateMilestone.",
    blastRadius: "Intra-tenant cross-project delete.",
    evidence: [
      { file: "src/modules/build/execution/workspace.service.ts", line: 205, anchor: /\.where\(and\(eq\(projectMilestones\.id, milestoneId\), eq\(projectMilestones\.projectId, projectId\), eq\(projectMilestones\.orgId, orgId\), isNull\(projectMilestones\.deletedAt\)\)\)/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#updateIntake",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/intake/:requestId. No @Param(\"projectId\"); every one of the four statements in this method binds (id, orgId). listIntake and createIntake in the same service DO call assertProjectInOrg — updateIntake does not.",
    blastRadius: "Intra-tenant cross-project write.",
    evidence: [
      { file: "src/modules/build/execution/workspace.service.ts", line: 281, anchor: /\.where\(and\(eq\(intakeItems\.id, requestId\), eq\(intakeItems\.projectId, projectId\), eq\(intakeItems\.orgId, orgId\)\)\)/, note: "bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#updateView",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/views/:viewId. No @Param(\"projectId\"); the view is resolved by (id, orgId). A per-user guard rejects mutating a PRIVATE view the caller does not own — but shared views bypass it entirely, and neither branch compares the URL projectId.",
    blastRadius:
      "Intra-tenant. Private views are additionally user-scoped; SHARED views have no project or user constraint, so any org member can edit a shared view belonging to any project.",
    evidence: [
      { file: "src/modules/build/execution/workspace.service.ts", line: 417, anchor: /where: and\(eq\(projectViews\.id, viewId\), eq\(projectViews\.projectId, projectId\), eq\(projectViews\.orgId, orgId\)\),/, note: "bound to the URL project" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 427, anchor: /\.where\(and\(eq\(projectViews\.id, viewId\), eq\(projectViews\.orgId, orgId\)\)\)/, note: "UPDATE binds id + orgId" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#deleteView",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/views/:viewId. Same as updateView, including the shared-view bypass.",
    blastRadius: "Intra-tenant; shared views are deletable across projects by any org member.",
    evidence: [
      { file: "src/modules/build/execution/workspace.service.ts", line: 417, anchor: /where: and\(eq\(projectViews\.id, viewId\), eq\(projectViews\.projectId, projectId\), eq\(projectViews\.orgId, orgId\)\),/, note: "bound to the URL project" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 441, anchor: /await this\.db\.delete\(projectViews\)\.where\(and\(eq\(projectViews\.id, viewId\), eq\(projectViews\.orgId, orgId\)\)\);/, note: "DELETE binds id + orgId" },
    ],
  },

  // ── Fixed and merged: verified against the current tree ─────────────────

  {
    key: "modules/build/core/releases/projects-releases.controller.ts#updateRelease",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/releases/:releaseId. The release was resolved by (id, orgId) while assertProjectAccess gated only the URL project, so the UPDATE could land on a release owned by another project. Closed in d714ae8ff: the UPDATE now binds projectReleases.projectId, and the ticketCount subquery binds releaseTickets.orgId (it previously counted rows from every tenant).",
    blastRadius: "Was intra-tenant cross-project write. Closed.",
    evidence: [
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 203, anchor: /\.where\(and\(eq\(projectReleases\.id, releaseId\), eq\(projectReleases\.projectId, projectId\), eq\(projectReleases\.orgId, orgId\), isNull\(projectReleases\.deletedAt\)\)\)/, note: "UPDATE binds id + projectId + orgId" },
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 193, anchor: /\.where\(and\(eq\(releaseTickets\.releaseId, releaseId\), eq\(releaseTickets\.orgId, orgId\)\)\);/, note: "ticketCount now bound to the caller's organisation" },
    ],
  },
  {
    key: "modules/build/core/releases/projects-releases.controller.ts#deleteRelease",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "DELETE /build/:projectId/releases/:releaseId. Soft delete was resolved by (id, orgId). Closed in d714ae8ff.",
    blastRadius: "Was intra-tenant cross-project delete. Closed.",
    evidence: [
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 203, anchor: /\.where\(and\(eq\(projectReleases\.id, releaseId\), eq\(projectReleases\.projectId, projectId\), eq\(projectReleases\.orgId, orgId\), isNull\(projectReleases\.deletedAt\)\)\)/, note: "soft delete binds id + projectId + orgId" },
    ],
  },
  {
    key: "modules/build/core/releases/projects-releases.controller.ts#addTicket",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary: "POST /build/:projectId/releases/:releaseId/tickets. Release and ticket were each resolved by (id, orgId), so a ticket from project A could be attached to a release in project B. Closed in d714ae8ff: both now bind projectId.",
    blastRadius: "Was intra-tenant cross-project link. Closed.",
    evidence: [
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 147, anchor: /where: and\(eq\(projectReleases\.id, releaseId\), eq\(projectReleases\.projectId, projectId\), eq\(projectReleases\.orgId, orgId\), isNull\(projectReleases\.deletedAt\)\),/, note: "release bound to the URL project" },
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 219, anchor: /where: and\(eq\(tickets\.id, ticketId\), eq\(tickets\.projectId, projectId\), eq\(tickets\.orgId, orgId\), isNull\(tickets\.deletedAt\)\),/, note: "ticket bound to the URL project" },
    ],
  },
  {
    key: "modules/build/core/releases/projects-releases.controller.ts#removeTicket",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/releases/:releaseId/tickets/:ticketId. The release was resolved by (id, orgId) and the join-row DELETE bound only (releaseId, ticketId) — no orgId at all, so it spanned organisations. Closed in d714ae8ff.",
    blastRadius: "Was intra-tenant cross-project, and the unqualified join delete was cross-TENANT. Closed.",
    evidence: [
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 147, anchor: /where: and\(eq\(projectReleases\.id, releaseId\), eq\(projectReleases\.projectId, projectId\), eq\(projectReleases\.orgId, orgId\), isNull\(projectReleases\.deletedAt\)\),/, note: "release bound to the URL project" },
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 238, anchor: /\.where\(and\(eq\(releaseTickets\.releaseId, releaseId\), eq\(releaseTickets\.ticketId, ticketId\), eq\(releaseTickets\.orgId, orgId\)\)\);/, note: "join delete now bound to the caller's organisation" },
    ],
  },

  // ── @Public: hand-read, and sound ────────────────────────────────────────

  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#getByToken",
    verdict: "VERIFIED",
    finding: "public-token-addressed",
    summary:
      "GET /public/whiteboard-links/:token. Unauthenticated by design. The token is the capability: it is HASHED before lookup, the row must be visibility=public and unexpired, the read runs inside withPublicToken which sets the app.public_token GUC for RLS, and the handler is IP rate-limited before touching the database. No orgId is needed because none is trusted from the caller.",
    blastRadius: "None beyond the shared board the token names.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 190, anchor: /where: and\(eq\(projectWhiteboards\.shareToken, tokenHash\), isNull\(projectWhiteboards\.deletedAt\)\),/, note: "lookup is by token HASH, not the raw token" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 205, anchor: /board\.visibility !== "public"/, note: "visibility + expiry enforced before returning" },
    ],
  },
  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#updateByToken",
    verdict: "VERIFIED",
    finding: "public-token-addressed",
    summary:
      "PATCH /public/whiteboard-links/:token. An unauthenticated write, and correctly built: view-only links are rejected with 403, and the UPDATE re-asserts every predicate it depends on (token hash, visibility, editor access, not deleted, not expired) in its own where clause rather than trusting the earlier read, so the check cannot be raced. The write runs in a tenant transaction pinned to the board's own orgId.",
    blastRadius: "Confined to the one board the editor token names.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 237, anchor: /if \(board\.publicAccess !== "editor"\)/, note: "view-only links rejected" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 253, anchor: /eq\(projectWhiteboards\.publicAccess, "editor"\),/, note: "the UPDATE re-asserts the predicate — TOCTOU-safe" },
    ],
  },
  {
    key: "modules/build/forms/submissions.controller.ts#submitPublicForm",
    verdict: "VERIFIED",
    finding: "public-token-addressed",
    summary:
      "POST /public/build-forms/:publicToken/submissions. Unauthenticated by design and IP rate-limited. One withPublicToken transaction resolves the active public form and performs capacity reservation, ticket allocation/inserts, and the submission insert under the same token-scoped RLS context. orgId and projectId come only from the resolved form row. The plaintext token comparison remains a storage hardening opportunity, not an access-control defect.",
    blastRadius: "A submission against the one form the token names.",
    evidence: [
      { file: "src/modules/build/forms/submissions.service.ts", line: 64, anchor: /eq\(projectForms\.publicToken, publicToken\),/, note: "resolved by token inside withPublicToken; orgId derived from the row" },
      { file: "src/modules/build/forms/submissions.service.ts", line: 65, anchor: /eq\(projectForms\.isPublic, true\),/, note: "non-public forms are not reachable through this route" },
      { file: "src/modules/build/forms/submissions.service.ts", line: 230, anchor: /const \{ form, result \} = await withPublicToken\(this\.db, publicToken, async \(tx\) => \{/, note: "lookup and every write share one token-scoped transaction" },
      { file: "src/modules/build/forms/submissions.service.ts", line: 232, anchor: /const result = await this\.runSubmission\(form, input, null, tx\);/, note: "the existing token transaction is passed into the write path" },
    ],
  },
];

const LANE_VERDICT_PATTERN = /^census-verdicts-[a-z0-9-]+\.mjs$/;

async function loadLaneVerdicts() {
  const files = readdirSync(SCRIPT_DIR).filter((f) => LANE_VERDICT_PATTERN.test(f)).sort();
  const loaded = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(SCRIPT_DIR, file)).href);
    const entries = mod.default;
    if (!Array.isArray(entries))
      throw new Error(`${file} must 'export default' an array of REVIEWED entries`);
    for (const entry of entries) loaded.push({ ...entry, laneFile: file });
  }
  return loaded;
}

const REVIEWED = [...REVIEWED_INLINE, ...(await loadLaneVerdicts())];

function assertNoDuplicateVerdicts(reviewed) {
  const seen = new Map();
  const clashes = [];
  for (const entry of reviewed) {
    const where = entry.laneFile ?? "build-authorization-census.mjs";
    if (seen.has(entry.key)) clashes.push(`${entry.key}: claimed by both ${seen.get(entry.key)} and ${where}`);
    else seen.set(entry.key, where);
  }
  return clashes;
}

// ── File walker ──────────────────────────────────────────────────────────────

function* walkControllers(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
      yield* walkControllers(full);
    } else if (e.name.endsWith(".controller.ts")) {
      yield full;
    }
  }
}

function* walkTs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
      yield* walkTs(full);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// ── Evidence identity ────────────────────────────────────────────────────────

const AMBIGUOUS = Symbol("ambiguous");

let TS_BY_BASENAME = null;

function tsIndexByBasename() {
  if (TS_BY_BASENAME) return TS_BY_BASENAME;
  TS_BY_BASENAME = new Map();
  for (const abs of walkTs(SRC)) {
    const rel = `src/${relative(SRC, abs).replace(/\\/g, "/")}`;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const bucket = TS_BY_BASENAME.get(base);
    if (bucket) bucket.push(rel);
    else TS_BY_BASENAME.set(base, [rel]);
  }
  return TS_BY_BASENAME;
}

function resolveEvidenceFile(relPath) {
  if (existsSync(join(REPO_ROOT, relPath))) return { file: relPath };
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const hits = tsIndexByBasename().get(base) ?? [];
  if (hits.length === 1) return { file: hits[0] };
  return { file: null, candidates: hits };
}

const REGEX_META = "^$.*+?|()[]{}";
const ESCAPE_CLASSES = /[dDwWsSbBnrtfv0-9uxkcpP]/;

function anchorLiteral(anchor) {
  const src = anchor.source;
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\\") {
      const next = src[i + 1];
      if (next === undefined || ESCAPE_CLASSES.test(next)) return null;
      out += next;
      i++;
      continue;
    }
    if (REGEX_META.includes(src[i])) return null;
    out += src[i];
  }
  return out;
}

function squashText(text) {
  const chars = [];
  const lineAt = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      line++;
      continue;
    }
    if (/\s/.test(ch)) continue;
    chars.push(ch);
    lineAt.push(line);
  }
  const out = [];
  const outLine = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "," && ")]}".includes(chars[i + 1])) continue;
    out.push(chars[i]);
    outLine.push(lineAt[i]);
  }
  return { text: out.join(""), lineAt: outLine };
}

function squashLiteral(literal) {
  return squashText(literal).text;
}

const squashCache = new Map();

function squashedOf(absPath, text) {
  if (!squashCache.has(absPath)) squashCache.set(absPath, squashText(text));
  return squashCache.get(absPath);
}

function looseKey(key) {
  const hash = key.lastIndexOf("#");
  const path = key.slice(0, hash);
  return `${path.slice(path.lastIndexOf("/") + 1)}${key.slice(hash)}`;
}

function looseVerdictIndex(rows) {
  const index = new Map();
  for (const r of rows) {
    const l = looseKey(r.key);
    index.set(l, index.has(l) ? AMBIGUOUS : r);
  }
  return index;
}

// ── AST helpers ──────────────────────────────────────────────────────────────

const sfCache = new Map();

function parseFile(filePath) {
  if (sfCache.has(filePath)) return sfCache.get(filePath);
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    sfCache.set(filePath, null);
    return null;
  }
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  sfCache.set(filePath, sf);
  return sf;
}

function lineOf(node, sf) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function decoratorsOf(node, sf) {
  const out = [];
  const decs = ts.canHaveDecorators?.(node) ? (ts.getDecorators(node) ?? []) : (node.modifiers ?? []).filter(ts.isDecorator);
  for (const d of decs) {
    const expr = d.expression;
    let name = null;
    let args = [];
    if (ts.isCallExpression(expr)) {
      if (ts.isIdentifier(expr.expression)) name = expr.expression.text;
      args = [...expr.arguments];
    } else if (ts.isIdentifier(expr)) {
      name = expr.text;
    }
    if (name) out.push({ name, args, line: lineOf(d, sf), node: d });
  }
  return out;
}

function strLit(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function joinRoute(prefix, path) {
  const parts = [prefix ?? "", path ?? ""]
    .flatMap((p) => String(p).split("/"))
    .filter((p) => p.length > 0);
  return `/${parts.join("/")}`;
}

function routeParamsOf(fullPath) {
  return [...fullPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

// Collect every identifier text appearing anywhere under a node.
function identifiersIn(node) {
  const out = new Set();
  (function visit(n) {
    if (ts.isIdentifier(n)) out.add(n.text);
    n.forEachChild(visit);
  })(node);
  return out;
}

// ── Import / symbol resolution (relative specifiers only) ────────────────────

function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

// name -> { file, initializer } for a top-level const, following relative re-exports.
function resolveConst(sf, name, seen = new Set()) {
  if (!sf || seen.has(`${sf.fileName}#${name}`)) return null;
  seen.add(`${sf.fileName}#${name}`);
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer)
          return { file: sf.fileName, sf, initializer: d.initializer };
      }
    }
  }
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
      for (const el of s.importClause.namedBindings.elements) {
        if (el.name.text !== name) continue;
        const target = resolveRelativeImport(sf.fileName, strLit(s.moduleSpecifier) ?? "");
        if (!target) return null;
        const orig = el.propertyName?.text ?? name;
        return resolveConst(parseFile(target), orig, seen);
      }
    }
  }
  return null;
}

// Keys declared by a zod params schema: z.object({...}), plus .extend({...}) and
// .merge(other) up the call chain.
function zodObjectKeys(node, sf, depth = 0) {
  const keys = new Set();
  if (!node || depth > 6) return keys;

  (function visit(n) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const fn = callee.name.text;
        if ((fn === "object" || fn === "extend") && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
          for (const p of n.arguments[0].properties) {
            if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name) {
              const k = ts.isIdentifier(p.name) ? p.name.text : strLit(p.name);
              if (k) keys.add(k);
            }
          }
        }
        if (fn === "merge" && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
          const other = resolveConst(sf, n.arguments[0].text);
          if (other) for (const k of zodObjectKeys(other.initializer, other.sf, depth + 1)) keys.add(k);
        }
      }
    }
    n.forEachChild(visit);
  })(node);

  return keys;
}

// ── Service index ────────────────────────────────────────────────────────────

let SERVICE_INDEX = null;

function buildServiceIndex(roots) {
  const idx = new Map();
  for (const root of roots) {
    for (const file of walkTs(root)) {
      const sf = parseFile(file);
      if (!sf) continue;
      for (const s of sf.statements) {
        if (ts.isClassDeclaration(s) && s.name) {
          if (!idx.has(s.name.text)) idx.set(s.name.text, { file, sf, cls: s });
        }
      }
    }
  }
  return idx;
}

function methodOfClass(cls, name) {
  for (const m of cls.members) {
    if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name && ts.isIdentifier(m.name) && m.name.text === name)
      return m;
  }
  return null;
}

// Constructor property name -> type name, for `constructor(private readonly x: Foo)`.
function injectedTypes(cls) {
  const map = new Map();
  for (const m of cls.members) {
    if (!ts.isConstructorDeclaration(m)) continue;
    for (const p of m.parameters) {
      if (!ts.isIdentifier(p.name)) continue;
      const t = p.type;
      if (t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) map.set(p.name.text, t.typeName.text);
    }
  }
  return map;
}

// ── Service-side binding analysis ────────────────────────────────────────────
//
// A binding is the value reaching a SQL predicate. Three shapes count:
//   eq(table.col, p) / inArray(table.col, p)      — drizzle comparator
//   sql`... ${p} ...`                             — raw predicate interpolation
//   .where({ col: p })                            — object where form
//
// Two indirections are followed, because the codebase uses both heavily and a
// binder that stops at the method boundary reports PASSED-UNBOUND on correct
// code (agent-pulse delegates every query to a private finder; approvals
// destructures CurrentUserContext before calling a module-level loader):
//   alias    — `const { orgId } = user` and `const o = user.orgId`
//   delegate — `this.privateFinder(p, …)` and `loadApproval(db, p, …)`, resolved
//              to the same class / same file / relatively-imported function and
//              re-entered with the matching parameter name (depth <= CALL_DEPTH).

const BIND_FNS = new Set(["eq", "inArray"]);
const CALL_DEPTH = 3;

// Names inside `body` that alias `paramName` or one of its properties.
function aliasesOf(body, paramName) {
  const aliases = new Set([paramName]);
  let grew = true;
  while (grew) {
    grew = false;
    (function visit(n) {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = n.initializer;
        const src =
          ts.isIdentifier(init)
            ? init.text
            : ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)
              ? init.expression.text
              : null;
        if (src && aliases.has(src)) {
          if (ts.isIdentifier(n.name) && !aliases.has(n.name.text)) {
            aliases.add(n.name.text);
            grew = true;
          } else if (ts.isObjectBindingPattern(n.name)) {
            for (const el of n.name.elements) {
              if (ts.isIdentifier(el.name) && !aliases.has(el.name.text)) {
                aliases.add(el.name.text);
                grew = true;
              }
            }
          }
        }
      }
      n.forEachChild(visit);
    })(body);
  }
  return aliases;
}

function argMatches(arg, aliases) {
  if (ts.isIdentifier(arg)) return aliases.has(arg.text);
  if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression))
    return aliases.has(arg.expression.text);
  return false;
}

// Resolve a callee to a function-like node we can re-enter.
function resolveCallee(callee, cls, sf) {
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const m = cls ? methodOfClass(cls, callee.name.text) : null;
    return m ? { node: m, cls, sf } : null;
  }
  // this.<injectedService>.<method>() — the facade shape. Several Build services
  // are pure delegators (projects-members, projects-ticket-subresources), so a
  // binder that stops at the class boundary reports PASSED-UNBOUND on code that
  // binds orgId perfectly well one hop away.
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    if (!cls) return null;
    const typeName = injectedTypes(cls).get(callee.expression.name.text);
    const entry = typeName ? SERVICE_INDEX?.get(typeName) : null;
    if (!entry) return null;
    const m = methodOfClass(entry.cls, callee.name.text);
    const esf = parseFile(entry.file);
    return m && esf ? { node: m, cls: entry.cls, sf: esf } : null;
  }
  if (!ts.isIdentifier(callee)) return null;
  const name = callee.text;
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { node: s, cls: null, sf };
    if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isArrowFunction(d.initializer))
          return { node: d.initializer, cls: null, sf };
  }
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
      for (const el of s.importClause.namedBindings.elements) {
        if (el.name.text !== name) continue;
        const target = resolveRelativeImport(sf.fileName, strLit(s.moduleSpecifier) ?? "");
        const tsf = target ? parseFile(target) : null;
        if (!tsf) return null;
        const orig = el.propertyName?.text ?? name;
        for (const t of tsf.statements) {
          if (ts.isFunctionDeclaration(t) && t.name?.text === orig) return { node: t, cls: null, sf: tsf };
          if (ts.isVariableStatement(t))
            for (const d of t.declarationList.declarations)
              if (ts.isIdentifier(d.name) && d.name.text === orig && d.initializer && ts.isArrowFunction(d.initializer))
                return { node: d.initializer, cls: null, sf: tsf };
        }
        return null;
      }
    }
  }
  return null;
}

// Does `paramName` reach a SQL predicate inside this function body?
// Returns "BOUND" | "PASSED-UNBOUND".
function bindingOfParam(fnNode, paramName, cls, sf, depth = 0, seen = new Set()) {
  const body = fnNode?.body;
  if (!body || depth > CALL_DEPTH) return "PASSED-UNBOUND";
  const sig = `${sf.fileName}#${fnNode.pos}#${paramName}`;
  if (seen.has(sig)) return "PASSED-UNBOUND";
  seen.add(sig);

  const aliases = aliasesOf(body, paramName);
  let bound = false;

  (function visit(n) {
    if (bound) return;

    // sql`... ${alias} ...`
    if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === "sql") {
      if (ts.isTemplateExpression(n.template))
        for (const span of n.template.templateSpans) if (argMatches(span.expression, aliases)) bound = true;
    }

    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const fnName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;

      if (fnName && BIND_FNS.has(fnName) && n.arguments.some((a) => argMatches(a, aliases))) bound = true;

      if (fnName === "where" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        for (const p of n.arguments[0].properties)
          if (ts.isPropertyAssignment(p) && argMatches(p.initializer, aliases)) bound = true;
      }

      // Delegation: re-enter the callee with the parameter that receives an alias.
      if (!bound && !(fnName && BIND_FNS.has(fnName))) {
        const idxs = n.arguments.map((a, i) => (argMatches(a, aliases) ? i : -1)).filter((i) => i >= 0);
        if (idxs.length) {
          const target = resolveCallee(callee, cls, sf);
          if (target?.node?.parameters) {
            for (const i of idxs) {
              const p = target.node.parameters[i];
              if (!p) continue;
              const pname = ts.isIdentifier(p.name)
                ? p.name.text
                : ts.isObjectBindingPattern(p.name)
                  ? null
                  : null;
              if (pname && bindingOfParam(target.node, pname, target.cls, target.sf, depth + 1, seen) === "BOUND")
                bound = true;
            }
          }
        }
      }
    }
    n.forEachChild(visit);
  })(body);

  return bound ? "BOUND" : "PASSED-UNBOUND";
}

// ── Controller analysis ──────────────────────────────────────────────────────

function analyzeControllerFile(file, srcRoot) {
  const sf = parseFile(file);
  if (!sf) return [];
  const rel = srcRoot ? relative(srcRoot, file).replace(/\\/g, "/") : file;
  const repoRel = `src/${rel}`;
  const rows = [];

  for (const s of sf.statements) {
    if (!ts.isClassDeclaration(s) || !s.name) continue;
    const classDecs = decoratorsOf(s, sf);
    const ctrlDec = classDecs.find((d) => d.name === "Controller");
    if (!ctrlDec) continue;

    const prefix = strLit(ctrlDec.args[0]) ?? "";
    const classGuards = classDecs
      .filter((d) => d.name === "UseGuards")
      .flatMap((d) => d.args.map((a) => (ts.isIdentifier(a) ? a.text : a.getText(sf))));
    const classModule = classDecs.find((d) => d.name === "RequireModule");
    const classPerm = classDecs.find((d) => d.name === "RequirePermission");
    const classPublic = classDecs.find((d) => d.name === "Public");
    const classUniversal = classDecs.find((d) => d.name === "Universal");
    const classAIS = classDecs.find((d) => d.name === "AuthorizedInService");
    const injected = injectedTypes(s);

    for (const m of s.members) {
      if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name)) continue;
      const decs = decoratorsOf(m, sf);
      const verbDec = decs.find((d) => HTTP_VERBS.has(d.name));
      if (!verbDec) continue;

      const verb = verbDec.name.toUpperCase();
      const subPath = strLit(verbDec.args[0]) ?? "";
      const fullPath = joinRoute(prefix, subPath);
      const routeParams = routeParamsOf(fullPath);
      const methodLine = lineOf(m, sf);

      // ── guards ──
      const methodGuards = decs
        .filter((d) => d.name === "UseGuards")
        .flatMap((d) => d.args.map((a) => (ts.isIdentifier(a) ? a.text : a.getText(sf))));
      const guards = [...new Set([...classGuards, ...methodGuards])];
      const mPerm = decs.find((d) => d.name === "RequirePermission");
      const mPublic = decs.find((d) => d.name === "Public");
      const mUniversal = decs.find((d) => d.name === "Universal");
      const mAIS = decs.find((d) => d.name === "AuthorizedInService");
      const mModule = decs.find((d) => d.name === "RequireModule");

      const permDec = mPerm ?? classPerm;
      const moduleDec = mModule ?? classModule;
      const publicDec = mPublic ?? classPublic;
      const universalDec = mUniversal ?? classUniversal;
      const aisDec = mAIS ?? classAIS;

      const classification = publicDec
        ? "@Public"
        : universalDec
          ? "@Universal"
          : permDec
            ? `@RequirePermission("${strLit(permDec.args[0]) ?? "?"}")`
            : aisDec
              ? "@AuthorizedInService"
              : "UNDECLARED";

      const hasJwt = guards.includes("JwtAuthGuard");
      const hasPermGuard = guards.includes("PermissionGuard");
      const guardChainOk = publicDec ? true : hasJwt && hasPermGuard;

      // ── validation (BE-14) ──
      // Three distinct states, and only the third is the BE-14 defect:
      //   no `params` key at all  → route params simply are not validated
      //   params key, unresolved  → the schema identifier did not resolve
      //   params key, resolved    → compare its keys against the route's params
      const validateDec = decs.find((d) => d.name === "Validate");
      let declaredParams = null;
      let validateLine = null;
      let paramsKeyPresent = false;
      if (validateDec) {
        validateLine = validateDec.line;
        const arg = validateDec.args[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const pp = arg.properties.find(
            (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "params",
          );
          if (pp && ts.isPropertyAssignment(pp)) {
            paramsKeyPresent = true;
            const init = pp.initializer;
            if (ts.isIdentifier(init)) {
              const r = resolveConst(sf, init.text);
              declaredParams = r ? [...zodObjectKeys(r.initializer, r.sf)] : null;
            } else {
              declaredParams = [...zodObjectKeys(init, sf)];
            }
          }
        }
      }
      const missingParams =
        declaredParams === null ? null : routeParams.filter((p) => !declaredParams.includes(p));
      const extraParams =
        declaredParams === null ? null : declaredParams.filter((p) => !routeParams.includes(p));

      // ── idempotency ──
      const idemDec = decs.find((d) => d.name === "Idempotent");
      const mutating = MUTATING_VERBS.has(verb);

      // ── @CurrentUser param name ──
      let cuName = null;
      const paramDecorated = new Map(); // route param name -> handler arg identifier
      for (const p of m.parameters) {
        const pdecs = decoratorsOf(p, sf);
        if (pdecs.some((d) => d.name === "CurrentUser") && ts.isIdentifier(p.name)) cuName = p.name.text;
        const pd = pdecs.find((d) => d.name === "Param");
        if (pd && ts.isIdentifier(p.name)) {
          const key = strLit(pd.args[0]);
          if (key) paramDecorated.set(key, p.name.text);
        }
      }

      // ── service call ──
      const call = findServiceCall(m, sf);
      let svc = null;
      if (call) {
        const typeName = injected.get(call.prop);
        const entry = typeName ? SERVICE_INDEX?.get(typeName) : null;
        const svcMethod = entry ? methodOfClass(entry.cls, call.method) : null;
        svc = {
          prop: call.prop,
          method: call.method,
          argTexts: call.argTexts,
          line: call.line,
          typeName: typeName ?? null,
          file: entry ? `src/${relative(SRC, entry.file).replace(/\\/g, "/")}` : null,
          params: svcMethod ? svcMethod.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "?")) : null,
          node: svcMethod,
        };
      }

      // ── org scoping ──
      const svcEntry = svc?.typeName ? SERVICE_INDEX?.get(svc.typeName) : null;
      const svcSf = svcEntry ? parseFile(svcEntry.file) : null;
      const bind = (pname) =>
        svc?.node && svcSf ? bindingOfParam(svc.node, pname, svcEntry.cls, svcSf) : "PASSED-UNBOUND";

      const orgArgIdx = svc
        ? svc.argTexts.findIndex((a) => cuName && (a === `${cuName}.orgId` || a === cuName))
        : -1;
      let orgScoping;
      let orgEvidence = null;
      if (!cuName) {
        orgScoping = publicDec ? "N/A (@Public)" : "UNRESOLVED (no @CurrentUser param)";
      } else if (!svc) {
        orgScoping = "UNRESOLVED (no single service call)";
      } else if (orgArgIdx === -1) {
        orgScoping = "NOT-PASSED";
        orgEvidence = `${repoRel}:${svc.line}`;
      } else if (!svc.node || !svc.params) {
        orgScoping = "UNRESOLVED (service method not found)";
        orgEvidence = `${repoRel}:${svc.line}`;
      } else {
        const sp = svc.params[orgArgIdx];
        orgScoping = sp ? bind(sp) : "UNRESOLVED (arity mismatch)";
        orgEvidence = `${svc.file}:${lineOf(svc.node, svcSf)}`;
      }

      // ── parent scoping ──
      const parentParams = routeParams.slice(0, -1);
      let parentScoping;
      let parentEvidence = null;
      if (routeParams.length < 2) {
        parentScoping = "N/A (not nested)";
      } else {
        const parent = parentParams[parentParams.length - 1];
        const handlerArg = paramDecorated.get(parent);
        if (!handlerArg) {
          parentScoping = "NOT-PASSED (no @Param on parent)";
          parentEvidence = `${repoRel}:${methodLine}`;
        } else if (!svc) {
          parentScoping = "UNRESOLVED (no single service call)";
          parentEvidence = `${repoRel}:${methodLine}`;
        } else {
          const idx = svc.argTexts.findIndex((a) => a === handlerArg);
          const referencedInBody = identifiersIn(m.body ?? m).has(handlerArg);
          if (idx === -1) {
            parentScoping = referencedInBody
              ? "PASSED-ELSEWHERE (used in handler body, not in the main call)"
              : "NOT-PASSED (parent never reaches the service)";
            parentEvidence = `${repoRel}:${svc.line}`;
          } else if (!svc.node || !svc.params) {
            parentScoping = "UNRESOLVED (service method not found)";
            parentEvidence = `${repoRel}:${svc.line}`;
          } else {
            const sp = svc.params[idx];
            parentScoping = sp ? bind(sp) : "UNRESOLVED (arity mismatch)";
            parentEvidence = `${svc.file}:${lineOf(svc.node, svcSf)}`;
          }
        }
      }

      // ── leads vs notes ──
      // A LEAD is authorization-material and forces NEEDS-REVIEW until a human
      // rules on it. A NOTE is recorded because the census must record it, but
      // does not by itself make a route unsafe.
      const leads = [];
      const notes = [];

      if (classification === "UNDECLARED") leads.push("no route classification decorator");
      if (!guardChainOk)
        leads.push(
          `BE-29: guard chain incomplete (JwtAuthGuard=${hasJwt}, PermissionGuard=${hasPermGuard})`,
        );
      if (!moduleDec && !publicDec) leads.push("no @RequireModule");

      // BE-14 bites only when a params schema EXISTS and omits a route param:
      // .strict() then rejects the extra key and 400s every call. No params key
      // at all means params are unvalidated, which is a different (smaller) thing.
      if (missingParams && missingParams.length)
        leads.push(`BE-14: params schema omits [${missingParams.join(", ")}]`);
      if (paramsKeyPresent && declaredParams === null && routeParams.length)
        leads.push("BE-14: params schema present but unresolvable — completeness unknown");
      if (routeParams.length && !paramsKeyPresent)
        notes.push(
          validateDec
            ? "route params unvalidated (@Validate has no params key)"
            : "route params unvalidated (no @Validate)",
        );

      if (mutating && !idemDec) notes.push("mutating verb without @Idempotent");

      if (
        orgScoping.startsWith("NOT-PASSED") ||
        orgScoping === "PASSED-UNBOUND" ||
        orgScoping.startsWith("UNRESOLVED")
      )
        leads.push(`org scoping: ${orgScoping}`);
      if (
        parentScoping.startsWith("NOT-PASSED") ||
        parentScoping === "PASSED-UNBOUND" ||
        parentScoping.startsWith("UNRESOLVED") ||
        parentScoping.startsWith("PASSED-ELSEWHERE")
      )
        leads.push(`parent scoping: ${parentScoping}`);

      rows.push({
        key: `modules/${relative(join(SRC, "modules"), file).replace(/\\/g, "/")}#${m.name.text}`,
        file: repoRel,
        class: s.name.text,
        method: m.name.text,
        line: methodLine,
        verb,
        path: fullPath,
        routeParams,
        classification,
        moduleGuard: moduleDec ? `@RequireModule("${strLit(moduleDec.args[0]) ?? "?"}")` : null,
        guards,
        guardChainOk,
        validate: validateDec ? "present" : "absent",
        validateLine,
        declaredParams,
        missingParams,
        extraParams,
        idempotent: idemDec ? `@Idempotent("${strLit(idemDec.args[0]) ?? ""}")` : null,
        mutating,
        service: svc
          ? { call: `this.${svc.prop}.${svc.method}(${svc.argTexts.join(", ")})`, type: svc.typeName, file: svc.file, resolved: !!svc.node }
          : null,
        orgScoping,
        orgEvidence,
        parentScoping,
        parentEvidence,
        leads,
        notes,
        evidence: `${repoRel}:${methodLine}`,
      });
    }
  }

  return rows;
}

// The service call that carries the handler: prefer the returned one, else the
// last awaited/called one in the body.
function findServiceCall(methodNode, sf) {
  const body = methodNode.body;
  if (!body) return null;
  const calls = [];

  function record(n, returned) {
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const inner = callee.expression;
    if (!ts.isPropertyAccessExpression(inner)) return;
    if (inner.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    calls.push({
      prop: inner.name.text,
      method: callee.name.text,
      argTexts: n.arguments.map((a) => a.getText(sf).replace(/\s+/g, " ")),
      line: lineOf(n, sf),
      returned,
    });
  }

  (function visit(n, inReturn) {
    if (ts.isCallExpression(n)) record(n, inReturn);
    n.forEachChild((c) => visit(c, inReturn || ts.isReturnStatement(n)));
  })(body, false);

  if (calls.length === 0) return null;
  return calls.find((c) => c.returned) ?? calls[calls.length - 1];
}

// ── Reviewed-anchor validation ───────────────────────────────────────────────

function validateReviewed(reviewed = REVIEWED) {
  const problems = [];
  const drift = [];
  for (const r of reviewed) {
    for (const e of r.evidence) {
      const resolved = resolveEvidenceFile(e.file);
      if (!resolved.file) {
        problems.push(
          resolved.candidates.length > 1
            ? `${r.key}: evidence file ${e.file} is gone and its basename is ambiguous under src/: ${resolved.candidates.join(", ")}`
            : `${r.key}: evidence file is gone and no file of that name exists under src/: ${e.file}`,
        );
        continue;
      }
      const abs = join(REPO_ROOT, resolved.file);
      const source = readFileSync(abs, "utf8");
      const lines = source.split(/\r?\n/);
      const hits = [];
      for (let i = 0; i < lines.length; i++) if (e.anchor.test(lines[i])) hits.push(i + 1);
      let reflowed = false;
      if (hits.length === 0) {
        const literal = anchorLiteral(e.anchor);
        if (literal !== null) {
          const squashed = squashedOf(abs, source);
          const needle = squashLiteral(literal);
          const at = needle.length > 0 ? squashed.text.indexOf(needle) : -1;
          if (at !== -1) {
            hits.push(squashed.lineAt[at]);
            reflowed = true;
          }
        }
      }
      if (hits.length === 0) {
        problems.push(
          `${r.key}: anchor matches nothing in ${resolved.file}, on one line or across wrapped lines\n    expected ${e.anchor}\n    the source this verdict rests on is absent — re-read the handler and re-cut the verdict`,
        );
        continue;
      }
      const line = hits.reduce((best, h) => (Math.abs(h - e.line) < Math.abs(best - e.line) ? h : best), hits[0]);
      e.resolvedFile = resolved.file;
      e.resolvedLine = line;
      e.anchorMatches = hits.length;
      e.anchorReflowed = reflowed;
      if (resolved.file !== e.file || line !== e.line)
        drift.push({
          key: r.key,
          laneFile: r.laneFile ?? "build-authorization-census.mjs",
          from: `${e.file}:${e.line}`,
          to: `${resolved.file}:${line}`,
        });
    }
  }
  return { problems, drift };
}

function evidenceFile(e) {
  return e.resolvedFile ?? e.file;
}

function evidenceLine(e) {
  return e.resolvedLine ?? e.line;
}

// ── Classification ───────────────────────────────────────────────────────────

function reviewedLooseIndex(reviewed) {
  const index = new Map();
  for (const r of reviewed) {
    const l = looseKey(r.key);
    index.set(l, index.has(l) ? AMBIGUOUS : r);
  }
  return index;
}

function matchReviewed(key, byKey, byLoose) {
  const exact = byKey.get(key);
  if (exact) return exact;
  const loose = byLoose.get(looseKey(key));
  return loose && loose !== AMBIGUOUS ? loose : undefined;
}

function reviewedKeyDrift(rows, reviewed = REVIEWED) {
  const rowKeys = new Set(rows.map((r) => r.key));
  const rowsLoose = looseVerdictIndex(rows);
  const moved = [];
  const orphans = [];
  for (const r of reviewed) {
    if (rowKeys.has(r.key)) continue;
    const loose = rowsLoose.get(looseKey(r.key));
    if (loose && loose !== AMBIGUOUS)
      moved.push({ key: r.key, laneFile: r.laneFile ?? "build-authorization-census.mjs", to: loose.key });
    else orphans.push(r.key);
  }
  return { moved, orphans };
}

function classify(rows, entries = REVIEWED) {
  const byKey = new Map(entries.map((r) => [r.key, r]));
  const byLoose = reviewedLooseIndex(entries);
  for (const row of rows) {
    const reviewed = matchReviewed(row.key, byKey, byLoose);
    row.reviewed = reviewed ?? null;
    if (reviewed) {
      row.verdict = reviewed.verdict;
      row.verdictReason = reviewed.summary;
      continue;
    }
    if (row.leads.length > 0) {
      row.verdict = "NEEDS-REVIEW";
      row.verdictReason = row.leads.join("; ");
      continue;
    }
    if (row.classification === "@Public") {
      row.verdict = "NEEDS-REVIEW";
      row.verdictReason =
        "@Public: the entire authorization decision lives in the service (token lookup, expiry, scope) where the static pass has no guard, orgId or route param to read — a hand read is required (see CLASSIFICATION CONTRACT)";
      continue;
    }
    if (row.routeParams.length >= 2) {
      row.verdict = "NEEDS-REVIEW";
      row.verdictReason =
        "static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)";
      continue;
    }
    row.verdict = "VERIFIED";
    row.verdictReason = "guard chain complete, org scoping bound, params declared, no nested parent";
  }
  return rows;
}

// ── Analysis entry ───────────────────────────────────────────────────────────

function analyze(controllerRoot, srcRoot, serviceRoots) {
  sfCache.clear();
  SERVICE_INDEX = buildServiceIndex(serviceRoots);
  const files = [...walkControllers(controllerRoot)];
  const rows = files.flatMap((f) => analyzeControllerFile(f, srcRoot));
  classify(rows);
  return { files, rows };
}

// ── Report rendering ─────────────────────────────────────────────────────────

const ORDER = { VULNERABLE: 0, "CLOSED-IN-FLIGHT": 1, "NEEDS-REVIEW": 2, CLOSED: 3, VERIFIED: 4 };
const VERDICTS = ["VULNERABLE", "CLOSED-IN-FLIGHT", "NEEDS-REVIEW", "CLOSED", "VERIFIED"];

const SAFETY_RANK = { VERIFIED: 0, CLOSED: 0, "NEEDS-REVIEW": 1, "CLOSED-IN-FLIGHT": 2, VULNERABLE: 3 };

function ratchetBreaches(rows, ratchet) {
  const c = counts(rows);
  const out = [];
  const rc = ratchet.counts ?? {};
  for (const k of ["VULNERABLE", "NEEDS-REVIEW"])
    if (rc[k] !== undefined && c[k] > rc[k]) out.push(`${k} rose from ${rc[k]} to ${c[k]}. It may only decrease.`);
  for (const k of ["CLOSED", "VERIFIED"])
    if (rc[k] !== undefined && c[k] < rc[k]) out.push(`${k} fell from ${rc[k]} to ${c[k]}. It may only increase.`);

  const frozen = ratchet.keys;
  if (!frozen) {
    out.push(
      "this ratchet has no `keys` block, so it is scoped by count alone. A handler that disappears then reads as an improvement. Re-scope it by identity.",
    );
    return out;
  }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const byLoose = looseVerdictIndex(rows);
  for (const [verdict, list] of Object.entries(frozen)) {
    for (const key of list) {
      const row = byKey.get(key) ?? (byLoose.get(looseKey(key)) !== AMBIGUOUS ? byLoose.get(looseKey(key)) : undefined);
      if (!row) {
        out.push(
          `${verdict} handler ${key} is no longer in the census. Name its replacement in the ratchet, or record its retirement — do not let it vanish.`,
        );
        continue;
      }
      if (SAFETY_RANK[row.verdict] > SAFETY_RANK[verdict])
        out.push(`${key} regressed from ${verdict} to ${row.verdict}.`);
    }
  }
  return out;
}

function counts(rows) {
  const c = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
}

function md(cell) {
  return String(cell ?? "—").replace(/\|/g, "\\|");
}

function renderMd(files, rows) {
  const c = counts(rows);
  const out = [];
  out.push("# Build module — authorization census");
  out.push("");
  out.push(
    "GENERATED FILE. Do not hand-edit. Regenerate with `pnpm check:build-authz-census`; the generator is `scripts/build-authorization-census.mjs`.",
  );
  out.push("");
  out.push(
    `Scope: every \`*.controller.ts\` under \`src/modules/build/\`. ${files.length} controller files, ${rows.length} HTTP handlers.`,
  );
  out.push("");
  out.push("## Counts");
  out.push("");
  out.push("| classification | handlers |");
  out.push("| --- | --- |");
  for (const k of VERDICTS) out.push(`| ${k} | ${c[k]} |`);
  out.push(`| **total** | **${rows.length}** |`);
  out.push("");
  out.push("## How to read a verdict");
  out.push("");
  out.push(
    "- **VULNERABLE** — hand-read, with the exact line named below. The static pass never emits this on its own.",
  );
  out.push(
    "- **NEEDS-REVIEW** — the static pass raised a lead it cannot rule on, OR the handler is a nested route whose parent binding a static reader may not certify alone.",
  );
  out.push(
    "- **CLOSED-IN-FLIGHT** — the defect is REAL AND PRESENT in this tree; a fix is already committed on another branch. The evidence anchors pin the OLD lines on purpose, so this report fails loudly the moment the fix merges here and the verdict must be re-cut to CLOSED. Do not read this row as safe.",
  );
  out.push("- **CLOSED** — a previously-raised finding this tree provably fixes.");
  out.push(
    "- **VERIFIED** — guard chain complete, org identity bound in the service, every route param declared, and either no nested parent resource or a hand read that names the binding line.",
  );
  out.push("");

  const vulnerable = rows.filter((r) => r.verdict === "VULNERABLE");
  const inFlight = rows.filter((r) => r.verdict === "CLOSED-IN-FLIGHT");
  const closed = rows.filter((r) => r.verdict === "CLOSED");
  if (vulnerable.length || inFlight.length || closed.length) {
    out.push("## Reviewed findings");
    out.push("");
    for (const r of [...vulnerable, ...inFlight, ...closed]) {
      out.push(`### ${r.verdict} — \`${r.verb} ${r.path}\``);
      out.push("");
      out.push(`\`${r.class}.${r.method}\` — \`${r.file}:${r.line}\``);
      out.push("");
      out.push(`Finding: \`${r.reviewed.finding}\``);
      out.push("");
      out.push(r.reviewed.summary);
      out.push("");
      if (r.reviewed.blastRadius) {
        out.push(`Blast radius: ${r.reviewed.blastRadius}`);
        out.push("");
      }
      out.push("Evidence:");
      out.push("");
      for (const e of r.reviewed.evidence) out.push(`- \`${evidenceFile(e)}:${evidenceLine(e)}\` — ${e.note}`);
      out.push("");
    }
  }

  const clearedByRead = rows.filter((r) => r.reviewed && r.verdict === "VERIFIED");
  if (clearedByRead.length) {
    out.push("## Reviewed and cleared");
    out.push("");
    out.push(
      "Handlers the static pass may not certify alone, read by hand and found sound. Listed so the clearance carries its evidence rather than an assurance.",
    );
    out.push("");
    for (const r of clearedByRead) {
      out.push(`### VERIFIED — \`${r.verb} ${r.path}\``);
      out.push("");
      out.push(`\`${r.class}.${r.method}\` — \`${r.file}:${r.line}\``);
      out.push("");
      out.push(r.reviewed.summary);
      out.push("");
      for (const e of r.reviewed.evidence) out.push(`- \`${evidenceFile(e)}:${evidenceLine(e)}\` — ${e.note}`);
      out.push("");
    }
  }

  out.push("## Every handler");
  out.push("");
  out.push(
    "| verdict | verb | route | controller:line | method | classification | module | guard chain | org scoping | parent scoping | @Validate params | @Idempotent |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  const sorted = [...rows].sort(
    (a, b) => (ORDER[a.verdict] - ORDER[b.verdict]) || a.file.localeCompare(b.file) || a.line - b.line,
  );
  for (const r of sorted) {
    const paramCell =
      r.validate === "absent"
        ? r.routeParams.length
          ? "ABSENT (route has params)"
          : "absent (no params)"
        : r.declaredParams === null
          ? "unresolved"
          : r.missingParams.length
            ? `MISSING [${r.missingParams.join(", ")}]`
            : `complete [${r.declaredParams.join(", ")}]`;
    out.push(
      `| ${r.verdict} | ${r.verb} | \`${md(r.path)}\` | \`${md(r.file)}:${r.line}\` | \`${md(r.method)}\` | ${md(r.classification)} | ${md(r.moduleGuard)} | ${r.guardChainOk ? "OK" : `INCOMPLETE [${r.guards.join(", ") || "none"}]`} | ${md(r.orgScoping)} | ${md(r.parentScoping)} | ${md(paramCell)} | ${r.idempotent ? "yes" : r.mutating ? "NO (mutating)" : "n/a"} |`,
    );
  }
  out.push("");

  const needs = sorted.filter((r) => r.verdict === "NEEDS-REVIEW");
  if (needs.length) {
    out.push("## NEEDS-REVIEW — open leads");
    out.push("");
    for (const r of needs) {
      out.push(`- \`${r.verb} ${r.path}\` — \`${r.file}:${r.line}\` (\`${r.method}\`): ${r.verdictReason}`);
    }
    out.push("");
  }

  const noteTally = new Map();
  for (const r of rows) for (const n of r.notes) noteTally.set(n, (noteTally.get(n) ?? 0) + 1);
  if (noteTally.size) {
    out.push("## Recorded notes (non-blocking)");
    out.push("");
    out.push(
      "A note is recorded because the census must record it, but does not on its own make a route unsafe and never forces NEEDS-REVIEW.",
    );
    out.push("");
    out.push("| note | handlers |");
    out.push("| --- | --- |");
    for (const [n, k] of [...noteTally].sort((a, b) => b[1] - a[1])) out.push(`| ${md(n)} | ${k} |`);
    out.push("");
  }

  out.push("## Limitations of the static pass");
  out.push("");
  out.push(
    "- Service resolution is name-based: `this.<prop>.<method>()` is followed through the constructor parameter's type annotation to the first class of that name under `src/`. An interface-typed or factory-provided dependency resolves to nothing and reports UNRESOLVED.",
  );
  out.push(
    "- Only ONE service call per handler is followed — the returned one, else the last. A handler that calls an access assert and then a second service resolves parent scoping against whichever of the two is picked; the other is reported as `PASSED-ELSEWHERE`.",
  );
  out.push(
    "- Binding detection is syntactic: `eq(...)` / `inArray(...)`, a `sql` template interpolation, or an object `.where({ col: p })`. Delegation is followed to a depth of 3 through `this.method()` and `this.injectedService.method()`, so the facade services resolve; past that a binding shows as `PASSED-UNBOUND`.",
  );
  out.push(
    "- Two known FALSE-POSITIVE classes remain, both deliberately left noisy. This census prefers a false `NEEDS-REVIEW` over a false `VERIFIED`, because the second hides a real defect and the first only costs a read:",
  );
  out.push(
    "    1. **Create endpoints.** An INSERT scopes the row by writing `orgId` into `.values({ orgId, ... })`, which is not a predicate. Every `create*` handler therefore reads as `org scoping: PASSED-UNBOUND` while being correctly scoped.",
  );
  out.push(
    "    2. **Parent checks written in JavaScript.** `projects-ticket-links.service.ts` fetches the ticket by `(id, orgId)` and then rejects with `if (ticket.projectId !== projectId)`. The parent IS verified, but in JS rather than SQL, so the binder cannot see it. Teaching the binder to accept a post-fetch comparison was rejected on purpose: the heuristic would also mark genuinely unbound code as bound.",
  );
  out.push(
    "- A param passed inside an object literal (`this.listTimeEntries(user, { ...query, projectId })`) is not tracked into the callee, because the binder matches arguments by identifier, not by destructured shape.",
  );
  out.push(
    "- RLS is not modelled. A row that is unreachable at the database because a tenant policy denies it still reads as unbound here. Conversely a passing census says nothing about whether the table has RLS at all.",
  );
  out.push(
    "- Permission KEY semantics are not modelled. The census records which key a route requires; whether that key is the right one, or whether the catalog grants it too widely, is out of scope.",
  );
  out.push(
    "- Dynamically registered routes (`RouteModule.forChild`, mixins) are invisible. Every handler here is a decorated method on a `@Controller` class.",
  );
  out.push(
    "- `@Validate` params completeness is checked against the literal path. A param introduced by a global prefix or a versioning middleware would not appear.",
  );
  out.push("");

  return `${out.join("\n")}\n`;
}

// The reports are written with LF, but this repo runs core.autocrlf=true and ships
// no .gitattributes, so a fresh Windows checkout hands them back with CRLF. Comparing
// raw bytes would then report drift on an untouched tree and make --check useless.
function sameText(a, b) {
  if (a === null || b === null) return false;
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

function renderJson(files, rows) {
  return `${JSON.stringify(
    {
      version: 1,
      generator: "scripts/build-authorization-census.mjs",
      scope: "src/modules/build/**/*.controller.ts",
      controllerFiles: files.length,
      handlers: rows.length,
      counts: counts(rows),
      handlersDetail: rows.map((r) => ({
        key: r.key,
        file: r.file,
        class: r.class,
        method: r.method,
        line: r.line,
        verb: r.verb,
        path: r.path,
        routeParams: r.routeParams,
        classification: r.classification,
        moduleGuard: r.moduleGuard,
        guards: r.guards,
        guardChainOk: r.guardChainOk,
        validate: r.validate,
        declaredParams: r.declaredParams,
        missingParams: r.missingParams,
        extraParams: r.extraParams,
        idempotent: r.idempotent,
        mutating: r.mutating,
        service: r.service,
        orgScoping: r.orgScoping,
        orgEvidence: r.orgEvidence,
        parentScoping: r.parentScoping,
        parentEvidence: r.parentEvidence,
        leads: r.leads,
        notes: r.notes,
        verdict: r.verdict,
        verdictReason: r.verdictReason,
        evidence: r.evidence,
        reviewedEvidence: r.reviewed
          ? r.reviewed.evidence.map((e) => ({ file: evidenceFile(e), line: evidenceLine(e), note: e.note }))
          : null,
      })),
    },
    null,
    2,
  )}\n`;
}

const RBAC_MATRIX_LEDGER = join(REPO_ROOT, ".artifacts", "rbac-matrix-ledger.json");

function printRbacMatrixLedger() {
  console.log("");
  if (!existsSync(RBAC_MATRIX_LEDGER)) {
    console.log("RBAC matrix ledger: not produced in this tree. Run `pnpm check:rbac-matrix-ledger` to execute it.");
    return;
  }
  const ledger = JSON.parse(readFileSync(RBAC_MATRIX_LEDGER, "utf8"));
  const executable = ledger.entries.filter((entry) => entry.kind === "executable").length;
  console.log(
    `RBAC matrix ledger: proven ${ledger.proven} · failed ${ledger.failed} · unrun ${ledger.unrun} · total ${ledger.total} (executable ${executable}, declared ${ledger.total - executable})`,
  );
  for (const entry of ledger.entries.filter((candidate) => candidate.status === "failed"))
    console.log(`  FAILED  ${entry.id}: ${entry.detail}`);
}

// ── Runner ───────────────────────────────────────────────────────────────────

function run(checkOnly) {
  console.log(`Scanning: ${BUILD_MODULE}`);
  const { files, rows } = analyze(BUILD_MODULE, SRC, [join(SRC, "modules"), join(SRC, "common")]);

  console.log(`Controller files found: ${files.length}`);
  console.log(`HTTP handlers found:    ${rows.length}`);
  console.log(`Service classes indexed: ${SERVICE_INDEX.size}`);

  if (files.length < CONTROLLER_FLOOR || rows.length < METHOD_FLOOR) {
    console.error(
      `\nINCONCLUSIVE — ${files.length} controllers / ${rows.length} handlers, floors are ${CONTROLLER_FLOOR} / ${METHOD_FLOOR}.`,
    );
    console.error("The walker is not reaching the controller tree; every count below would be vacuous.");
    console.error(`BUILD_MODULE path: ${BUILD_MODULE}`);
    return 2;
  }

  const duplicateVerdicts = assertNoDuplicateVerdicts(REVIEWED);
  if (duplicateVerdicts.length) {
    console.error(`\n${duplicateVerdicts.length} handler(s) carry more than one REVIEWED verdict:\n`);
    for (const d of duplicateVerdicts) console.error(`  ${d}`);
    console.error("\nTwo lanes claiming one handler means one of them read it without owning it. Resolve before trusting either.");
    return 1;
  }

  const { problems: anchorProblems, drift } = validateReviewed();
  if (anchorProblems.length) {
    console.error(`\n${anchorProblems.length} REVIEWED anchor(s) no longer exist in source:\n`);
    for (const p of anchorProblems) console.error(`  ${p}`);
    console.error("\nA verdict whose anchor text is gone rests on code that is gone. Re-read and re-cut it.");
    console.error("This is not position drift: the anchor was searched across the whole file and every file of that name under src/.");
    return 1;
  }

  const keyDrift = reviewedKeyDrift(rows);
  if (keyDrift.orphans.length) {
    console.error(`\n${keyDrift.orphans.length} REVIEWED key(s) name no handler in this tree:\n`);
    for (const k of keyDrift.orphans) console.error(`  ${k}`);
    console.error("\nA verdict on a handler that no longer exists is not a verdict. Retire it or re-key it.");
    return 1;
  }

  if (drift.length || keyDrift.moved.length) {
    console.log("");
    console.log(
      `Position drift: ${drift.length} evidence anchor(s) and ${keyDrift.moved.length} handler key(s) moved. The anchors all still match, so this is not a finding.`,
    );
    console.log("Run with --refresh-anchors to restamp the recorded positions; it never touches an anchor, verdict or summary.");
  }

  const c = counts(rows);
  console.log("");
  for (const k of VERDICTS) console.log(`  ${k.padEnd(17)} ${c[k]}`);
  console.log(`  ${"total".padEnd(17)} ${rows.length}`);
  console.log("");
  console.log("Verified: every Build controller handler classified for org-scoping, parent-scoping, and permission-guard presence.");
  console.log("Verified: REVIEWED hand-read verdicts all match their source anchors.");
  console.log("Not verified: actual runtime behavior (RLS, network calls, post-commit hooks) — use e2e/integration tests for those.");
  console.log("Not verified: non-Build modules (HR, KB, billing, etc.) — this census is scoped to src/modules/build/**.");
  printRbacMatrixLedger();

  if (existsSync(OUT_RATCHET)) {
    const ratchet = JSON.parse(readFileSync(OUT_RATCHET, "utf8"));
    const breaches = ratchetBreaches(rows, ratchet);
    if (breaches.length) {
      for (const b of breaches) console.error(`\nRATCHET BREACH: ${b}`);
      console.error("\nUpdate docs/build-module/authorization-census-ratchet.json only when a handler's verdict genuinely improves.");
      console.error("A handler that left the census is not a handler that improved.");
      return 1;
    }
  }

  const mdText = renderMd(files, rows);
  const jsonText = renderJson(files, rows);

  if (checkOnly) {
    let drift = false;
    for (const [p, want] of [
      [OUT_MD, mdText],
      [OUT_JSON, jsonText],
    ]) {
      const have = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (!sameText(have, want)) {
        console.error(`\nSTALE: ${relative(REPO_ROOT, p)} does not match a fresh run.`);
        drift = true;
      }
    }
    if (drift) {
      console.error("Run `pnpm check:build-authz-census` and commit the result.");
      return 1;
    }
    console.log(`\nOK — committed reports match a fresh run.`);
    return 0;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_MD, mdText);
  writeFileSync(OUT_JSON, jsonText);
  console.log(`\nWrote ${relative(REPO_ROOT, OUT_MD)}`);
  console.log(`Wrote ${relative(REPO_ROOT, OUT_JSON)}`);
  return 0;
}

// ── Self test ────────────────────────────────────────────────────────────────

function selfTest() {
  let passed = 0;
  let failed = 0;
  const check = (label, ok, detail) => {
    if (ok) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
      failed++;
    }
  };

  // ── Part 1: synthetic fixtures — the parser must find what is planted. ──
  const tmpBase = join(tmpdir(), `slos-authz-census-${Date.now()}`);
  try {
    mkdirSync(join(tmpBase, "modules", "fake"), { recursive: true });
    const fakeDir = join(tmpBase, "modules", "fake");

    writeFileSync(
      join(fakeDir, "fake.service.ts"),
      `
export class FakeService {
  async listKids(orgId: string, parentId: number) {
    return this.db.select().from(kids).where(and(eq(kids.orgId, orgId), eq(kids.parentId, parentId)));
  }
  async deleteKid(orgId: string, kidId: number) {
    return this.db.delete(kids).where(and(eq(kids.id, kidId), eq(kids.orgId, orgId)));
  }
  async updateKid(orgId: string, parentId: number, kidId: number) {
    return this.db.update(kids).where(and(eq(kids.id, kidId), eq(kids.orgId, orgId), eq(kids.parentId, parentId)));
  }
  async listTop(orgId: string) {
    return this.db.select().from(kids).where(eq(kids.orgId, orgId));
  }
  async orphan(somethingElse: number) {
    return this.db.select().from(kids).where(eq(kids.id, somethingElse));
  }
}
`,
    );

    writeFileSync(
      join(fakeDir, "fake.controller.ts"),
      `
import { FakeService } from "./fake.service";
const parentIdParams = z.object({ parentId: z.coerce.number() }).strict();
const parentKidParams = z.object({ parentId: z.coerce.number(), kidId: z.coerce.number() }).strict();
const kidOnlyParams = z.object({ kidId: z.coerce.number() }).strict();

@RequireModule("fake")
@Controller("fake")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class FakeController {
  constructor(private readonly svc: FakeService) {}

  @Get()
  @RequirePermission("fake:view")
  listTop(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listTop(u.orgId);
  }

  @Get(":parentId/kids")
  @RequirePermission("fake:view")
  @Validate({ params: parentIdParams })
  listKids(@Param("parentId") parentId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.listKids(u.orgId, parentId);
  }

  @Patch(":parentId/kids/:kidId")
  @RequirePermission("fake:manage")
  @Validate({ params: parentKidParams })
  updateKid(
    @Param("parentId") parentId: number,
    @Param("kidId") kidId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateKid(u.orgId, parentId, kidId);
  }

  @Delete(":parentId/kids/:kidId")
  @RequirePermission("fake:manage")
  @Validate({ params: kidOnlyParams })
  deleteKid(@Param("kidId") kidId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.deleteKid(u.orgId, kidId);
  }

  @Post("unguarded")
  unguarded(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listTop(u.orgId);
  }

  @Get("orphan/:kidId")
  @RequirePermission("fake:view")
  @Validate({ params: kidOnlyParams })
  orphan(@Param("kidId") kidId: number, @CurrentUser() u: CurrentUserContext) {
    return this.svc.orphan(kidId);
  }

  @Get("public-ping")
  @Public()
  ping() {
    return this.svc.listTop("x");
  }
}
`,
    );

    sfCache.clear();
    SERVICE_INDEX = buildServiceIndex([tmpBase]);
    const rows = classify([...walkControllers(tmpBase)].flatMap((f) => analyzeControllerFile(f, tmpBase)));
    const by = (n) => rows.find((r) => r.method === n);

    check("fixture: 7 handlers parsed", rows.length === 7, `got ${rows.length}`);
    check("fixture: route prefix joined", by("listKids")?.path === "/fake/:parentId/kids", by("listKids")?.path);
    check("fixture: bare @Get() yields the prefix", by("listTop")?.path === "/fake", by("listTop")?.path);
    check("fixture: verb recorded", by("updateKid")?.verb === "PATCH", by("updateKid")?.verb);
    check(
      "fixture: class @UseGuards inherited by methods",
      by("listTop")?.guardChainOk === true,
      JSON.stringify(by("listTop")?.guards),
    );
    check(
      "fixture: BE-29 lead when no classification decorator",
      by("unguarded")?.classification === "UNDECLARED",
      by("unguarded")?.classification,
    );
    check(
      "fixture: org scoping BOUND when orgId reaches an eq()",
      by("listTop")?.orgScoping === "BOUND",
      by("listTop")?.orgScoping,
    );
    check(
      "fixture: org scoping NOT-PASSED when orgId is never forwarded",
      by("orphan")?.orgScoping === "NOT-PASSED",
      by("orphan")?.orgScoping,
    );
    check(
      "fixture: parent scoping BOUND when parent reaches the service eq()",
      by("updateKid")?.parentScoping === "BOUND",
      by("updateKid")?.parentScoping,
    );
    check(
      "fixture: parent scoping NOT-PASSED when the handler omits @Param(parent)",
      by("deleteKid")?.parentScoping?.startsWith("NOT-PASSED") === true,
      by("deleteKid")?.parentScoping,
    );
    check(
      "fixture: parent scoping N/A on a single-param route",
      by("orphan")?.parentScoping === "N/A (not nested)",
      by("orphan")?.parentScoping,
    );
    check(
      "fixture: BE-14 missing param detected",
      by("deleteKid")?.missingParams?.includes("parentId") === true,
      JSON.stringify(by("deleteKid")?.missingParams),
    );
    check(
      "fixture: BE-14 clean when every param is declared",
      by("updateKid")?.missingParams?.length === 0,
      JSON.stringify(by("updateKid")?.missingParams),
    );
    check(
      "fixture: mutating verb without @Idempotent is a NOTE, not a lead",
      by("updateKid")?.notes?.some((n) => n.includes("@Idempotent")) === true &&
        by("updateKid")?.leads?.some((l) => l.includes("@Idempotent")) === false,
      `leads=${JSON.stringify(by("updateKid")?.leads)} notes=${JSON.stringify(by("updateKid")?.notes)}`,
    );
    check(
      "fixture: a note alone never forces NEEDS-REVIEW",
      by("listKids")?.notes?.length === 0 && by("listKids")?.verdict === "VERIFIED",
      `notes=${JSON.stringify(by("listKids")?.notes)} verdict=${by("listKids")?.verdict}`,
    );
    check(
      "fixture: a clean single-param handler classifies VERIFIED",
      by("listKids")?.verdict === "VERIFIED",
      JSON.stringify(by("listKids")),
    );
    check(
      "fixture: an unreviewed @Public handler is never auto-VERIFIED",
      by("ping")?.classification === "@Public" && by("ping")?.verdict === "NEEDS-REVIEW",
      `classification=${by("ping")?.classification} verdict=${by("ping")?.verdict}`,
    );
    check(
      "fixture: an unreviewed nested handler is never auto-VERIFIED",
      by("updateKid")?.verdict === "NEEDS-REVIEW",
      by("updateKid")?.verdict,
    );
  } finally {
    try {
      rmSync(tmpBase, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  // ── Part 2: real tree — a census that resolves nothing reports zero. ──
  const real = analyze(BUILD_MODULE, SRC, [join(SRC, "modules"), join(SRC, "common")]);
  check(
    `real tree: >= ${CONTROLLER_FLOOR} controller files walked`,
    real.files.length >= CONTROLLER_FLOOR,
    `got ${real.files.length}`,
  );
  check(
    `real tree: >= ${METHOD_FLOOR} handlers parsed`,
    real.rows.length >= METHOD_FLOOR,
    `got ${real.rows.length}`,
  );

  const anchorRoutes = [
    ["GET", "/build/:projectId/releases", "ProjectsReleasesController"],
    ["DELETE", "/build/:projectId/webhooks/:webhookId", "ProjectsWebhooksController"],
    ["PATCH", "/build/:projectId/custom-fields/:fieldId", "ProjectsCustomFieldsController"],
    ["GET", "/build/portal/projects", "ClientPortalController"],
  ];
  for (const [verb, path, cls] of anchorRoutes) {
    check(
      `real tree: sees ${verb} ${path}`,
      real.rows.some((r) => r.verb === verb && r.path === path && r.class === cls),
      "route not found — the parser is skipping files or mis-joining the @Controller prefix",
    );
  }

  const everyControllerRepresented = [...real.files].filter(
    (f) => !real.rows.some((r) => r.file === `src/${relative(SRC, f).replace(/\\/g, "/")}`),
  );
  check(
    "real tree: every controller file yielded >= 1 handler",
    everyControllerRepresented.length === 0,
    `files with zero handlers: ${everyControllerRepresented.map((f) => relative(SRC, f)).join(", ")}`,
  );

  check(
    "real tree: service index resolved the majority of handlers",
    real.rows.filter((r) => r.service?.resolved).length > real.rows.length * 0.6,
    `${real.rows.filter((r) => r.service?.resolved).length}/${real.rows.length} resolved`,
  );

  const { problems: anchorProblems, drift: anchorDrift } = validateReviewed();
  check(
    "REVIEWED anchors all still match source",
    anchorProblems.length === 0,
    anchorProblems.join("\n        "),
  );

  const sampleMd = renderMd(real.files, real.rows);
  check(
    "--check survives a CRLF checkout (core.autocrlf=true is set in this repo)",
    sameText(sampleMd.replace(/\n/g, "\r\n"), sampleMd) && !sameText(sampleMd, `${sampleMd}extra`),
    "a byte comparison would report drift on an untouched Windows checkout",
  );

  const realKeyDrift = reviewedKeyDrift(real.rows);
  check(
    "every REVIEWED key matches a real handler",
    realKeyDrift.orphans.length === 0,
    realKeyDrift.orphans.join(", "),
  );

  {
    const sample = REVIEWED.find((r) => r.evidence.length > 0);
    const clone = (over) => [{ ...sample, evidence: [{ ...sample.evidence[0], ...over }] }];

    const movedFile = `src/modules/build/core/${sample.evidence[0].file.slice(sample.evidence[0].file.lastIndexOf("/") + 1)}`;
    check(
      "identity: an anchor whose file moved and whose line moved is not a failure",
      validateReviewed(clone({ file: movedFile, line: 1 })).problems.length === 0,
      JSON.stringify(validateReviewed(clone({ file: movedFile, line: 1 })).problems),
    );
    check(
      "identity: a moved anchor is reported as drift so it can be restamped",
      validateReviewed(clone({ line: 1 })).drift.length === 1,
      JSON.stringify(validateReviewed(clone({ line: 1 })).drift),
    );

    const seeded = validateReviewed(clone({ anchor: /zzz-no-such-source-line-exists-anywhere/ }));
    const reflowTolerant = validateReviewed([
      {
        ...sample,
        evidence: [
          {
            file: "src/modules/build/execution/cycles.service.ts",
            line: 1,
            anchor: /\.where\(and\(eq\(cycles\.id, cycleId\), eq\(cycles\.projectId, projectId\), eq\(cycles\.orgId, orgId\), eq\(cycles\.version, before\.version\)\)\)/,
            note: "written on one line, present in source across five wrapped lines",
          },
        ],
      },
    ]);
    check(
      "identity: an anchor the formatter wrapped across lines still matches",
      reflowTolerant.problems.length === 0,
      JSON.stringify(reflowTolerant.problems),
    );
    check(
      "identity: SEEDED VIOLATION — an anchor matching nothing in the file is reported",
      seeded.problems.length === 1 && seeded.problems[0].includes("matches nothing"),
      JSON.stringify(seeded.problems),
    );
    const seededMissing = validateReviewed(clone({ file: "src/modules/build/core/zzz-no-such-file.ts" }));
    check(
      "identity: SEEDED VIOLATION — an evidence file with no counterpart under src/ is reported",
      seededMissing.problems.length === 1 && seededMissing.problems[0].includes("no file of that name"),
      JSON.stringify(seededMissing.problems),
    );
    check(
      "identity: VIOLATION REMOVED — the unmodified entry is quiet again",
      validateReviewed([sample]).problems.length === 0,
      JSON.stringify(validateReviewed([sample]).problems),
    );
  }

  {
    const row = (key, verdict) => ({ key, verdict });
    const rows = [
      row("modules/build/core/tickets/projects-tickets.controller.ts#deleteTicket", "VERIFIED"),
      row("modules/build/core/webhooks/projects-webhooks.controller.ts#deleteWebhook", "CLOSED"),
      row("modules/build/qa/bugs.controller.ts#deleteBug", "NEEDS-REVIEW"),
    ];
    const counted = { VULNERABLE: 0, "NEEDS-REVIEW": 1, CLOSED: 1, VERIFIED: 1 };
    const base = {
      counts: counted,
      keys: {
        VERIFIED: ["modules/build/core/tickets/projects-tickets.controller.ts#deleteTicket"],
        CLOSED: ["modules/build/core/webhooks/projects-webhooks.controller.ts#deleteWebhook"],
        "NEEDS-REVIEW": ["modules/build/qa/bugs.controller.ts#deleteBug"],
      },
    };

    check(
      "ratchet: an unchanged census does not breach",
      ratchetBreaches(rows, base).length === 0,
      JSON.stringify(ratchetBreaches(rows, base)),
    );

    const vanishedVerified = rows.filter((r) => !r.key.includes("projects-tickets.controller"));
    const vanishedBreach = ratchetBreaches(vanishedVerified, base);
    check(
      "ratchet: SEEDED VIOLATION — a frozen VERIFIED handler that vanished is a breach, not an improvement",
      vanishedBreach.some((b) => b.includes("no longer in the census")),
      JSON.stringify(vanishedBreach),
    );

    const vanishedNeedsReview = rows.filter((r) => !r.key.includes("bugs.controller"));
    const vanishedNrBreach = ratchetBreaches(vanishedNeedsReview, base);
    check(
      "ratchet: SEEDED VIOLATION — a frozen NEEDS-REVIEW handler that vanished is a breach, where the count alone reads as progress",
      counts(vanishedNeedsReview)["NEEDS-REVIEW"] < counted["NEEDS-REVIEW"] &&
        vanishedNrBreach.some((b) => b.includes("no longer in the census")),
      JSON.stringify(vanishedNrBreach),
    );

    const regressed = rows.map((r) =>
      r.key.includes("projects-tickets.controller") ? row(r.key, "VULNERABLE") : r,
    );
    check(
      "ratchet: SEEDED VIOLATION — a frozen VERIFIED handler now VULNERABLE is a breach",
      ratchetBreaches(regressed, base).some((b) => b.includes("regressed from VERIFIED to VULNERABLE")),
      JSON.stringify(ratchetBreaches(regressed, base)),
    );

    const relocated = rows.map((r) =>
      r.key.includes("projects-tickets.controller")
        ? row("modules/build/core/somewhere-else/projects-tickets.controller.ts#deleteTicket", r.verdict)
        : r,
    );
    check(
      "ratchet: a frozen handler whose file moved still matches by identity",
      ratchetBreaches(relocated, base).length === 0,
      JSON.stringify(ratchetBreaches(relocated, base)),
    );

    check(
      "ratchet: SEEDED VIOLATION — a ratchet with no keys block is refused as count-scoped",
      ratchetBreaches(rows, { counts: counted }).some((b) => b.includes("scoped by count alone")),
      JSON.stringify(ratchetBreaches(rows, { counts: counted })),
    );
    check(
      "ratchet: VIOLATION REMOVED — the identity-scoped ratchet is quiet again",
      ratchetBreaches(rows, base).length === 0,
      JSON.stringify(ratchetBreaches(rows, base)),
    );

    check(
      "ratchet: VULNERABLE rising above floor is detected",
      ratchetBreaches([...rows, row("modules/build/x/x.controller.ts#leak", "VULNERABLE")], base).some((b) =>
        b.includes("VULNERABLE rose"),
      ),
      "the count arm missed a VULNERABLE increase",
    );
    check(
      "ratchet: VERIFIED falling below floor is detected",
      ratchetBreaches(
        rows.map((r) => (r.key.includes("projects-tickets.controller") ? row(r.key, "NEEDS-REVIEW") : r)),
        base,
      ).some((b) => b.includes("VERIFIED fell")),
      "the count arm missed a VERIFIED decrease",
    );
  }

  check(
    "the committed ratchet is scoped by identity, not by count alone",
    !existsSync(OUT_RATCHET) || Boolean(JSON.parse(readFileSync(OUT_RATCHET, "utf8")).keys),
    "docs/build-module/authorization-census-ratchet.json has no `keys` block",
  );

  if (anchorDrift.length || realKeyDrift.moved.length)
    console.log(
      `\n  note  ${anchorDrift.length} evidence position(s) and ${realKeyDrift.moved.length} key(s) have drifted; --refresh-anchors restamps them.`,
    );

  console.log(`\nbuild-authorization-census self-test: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

// ── Entry point ──────────────────────────────────────────────────────────────

function refreshAnchors() {
  const { problems, drift } = validateReviewed();
  if (problems.length) {
    console.error(`${problems.length} anchor(s) match nothing — refresh cannot guess a position for code that is gone:\n`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }

  const { files, rows } = analyze(BUILD_MODULE, SRC, [join(SRC, "modules"), join(SRC, "common")]);
  if (files.length < CONTROLLER_FLOOR || rows.length < METHOD_FLOOR) {
    console.error(`INCONCLUSIVE — ${files.length} controllers / ${rows.length} handlers. Refusing to restamp against a vacuous walk.`);
    return 2;
  }
  const keyDrift = reviewedKeyDrift(rows);
  if (keyDrift.orphans.length) {
    console.error(`${keyDrift.orphans.length} REVIEWED key(s) name no handler; retire or re-key them by hand:\n`);
    for (const k of keyDrift.orphans) console.error(`  ${k}`);
    return 1;
  }

  const edits = new Map();
  const queue = (file, from, to) => {
    if (from === to) return;
    if (!edits.has(file)) edits.set(file, []);
    edits.get(file).push([from, to]);
  };
  for (const d of drift) {
    const [fromFile, fromLine] = [d.from.slice(0, d.from.lastIndexOf(":")), d.from.slice(d.from.lastIndexOf(":") + 1)];
    const [toFile, toLine] = [d.to.slice(0, d.to.lastIndexOf(":")), d.to.slice(d.to.lastIndexOf(":") + 1)];
    queue(d.laneFile, `file: "${fromFile}", line: ${fromLine},`, `file: "${toFile}", line: ${toLine},`);
    queue(d.laneFile, `file: "${fromFile}",\n        line: ${fromLine},`, `file: "${toFile}",\n        line: ${toLine},`);
  }
  for (const m of keyDrift.moved) queue(m.laneFile, `key: "${m.key}"`, `key: "${m.to}"`);

  let applied = 0;
  let unmatched = 0;
  for (const [file, pairs] of edits) {
    const abs = join(SCRIPT_DIR, file);
    let text = readFileSync(abs, "utf8");
    for (const [from, to] of pairs) {
      const parts = text.split(from);
      if (parts.length === 1) {
        unmatched++;
        continue;
      }
      text = parts.join(to);
      applied += parts.length - 1;
    }
    writeFileSync(abs, text);
  }
  console.log(`Restamped ${applied} position(s) across ${edits.size} verdict file(s). Anchors, verdicts and summaries untouched.`);
  if (unmatched) console.log(`${unmatched} position(s) are written in a form this pass cannot rewrite; update them by hand.`);
  return 0;
}

const args = process.argv.slice(2);
process.exit(
  args.includes("--self-test")
    ? selfTest()
    : args.includes("--refresh-anchors")
      ? refreshAnchors()
      : run(args.includes("--check")),
);
