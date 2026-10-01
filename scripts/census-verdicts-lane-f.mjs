export default [
  {
    key: "modules/build/core/webhooks/projects-webhooks.controller.ts#updateWebhook",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/webhooks/:webhookId. Query-enforced, the strongest of the six read in this pass: the service hoists one `tenantMatch` conjunction binding orgId and projectId and applies it to the pre-read SELECT, to the UPDATE itself, and to the optimistic-concurrency re-read. The parent binding is therefore inside the mutating statement rather than in a preceding assert, so it survives the deletion of any helper. A valid webhookId under a foreign projectId 404s. orgId comes from u.orgId and is never read from the body.",
    blastRadius:
      "None: there is no read-then-write window in which the projectId predicate is dropped, and a version conflict re-reads under the same tenantMatch so it cannot leak a foreign row's version.",
    evidence: [
      { file: "src/modules/build/core/webhooks/projects-webhooks.controller.ts", line: 77, anchor: /return this\.webhooks\.updateWebhook\(u\.orgId, projectId, webhookId, body\);/, note: "the controller supplies the tenant from the authenticated actor" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 206, anchor: /const tenantMatch = and\(/, note: "one conjunction is reused by every statement in the method" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 208, anchor: /eq\(projectWebhooks\.orgId, orgId\),/, note: "the tenant is a predicate, not a written value" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 209, anchor: /eq\(projectWebhooks\.projectId, projectId\),/, note: "the URL project is bound in the same conjunction" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 237, anchor: /\.where\(and\(tenantMatch, eq\(projectWebhooks\.version, before\.version\)\)\)/, note: "the UPDATE itself carries the binding, so it is not assert-dependent" },
    ],
  },
  {
    key: "modules/build/import-export/ticket-import-export.controller.ts#exportTickets",
    verdict: "VERIFIED",
    finding: "org-scoping-verified",
    summary:
      "GET /build/:projectId/import-export/tickets/export. An export is the highest-value target here and it is the best-bound handler of the six. The tenant predicate is not written by this service at all: ScopedRead mints an unforgeable where-token whose first clause is eq(tickets.orgId, actor.orgId), and the token class is unexported with a private field so no call site can hand-roll a where that omits it. The URL project is AND-ed into the same token, the caller's DataScope narrows further, a `none` scope short-circuits to an empty array, and the read is capped. The permission key on the route matches the key the row scope resolves.",
    blastRadius:
      "None: the caller-supplied ticketIds filter is an additional narrowing clause, so foreign ids intersect to zero rows rather than overriding the org and project predicates.",
    evidence: [
      { file: "src/modules/build/import-export/ticket-import-export.controller.ts", line: 83, anchor: /return this\.exports\.exportTickets\(u, projectId, query\);/, note: "the complete authenticated actor reaches the service" },
      { file: "src/modules/build/import-export/ticket-export.service.ts", line: 53, anchor: /const read = await authorizeProjectTicketRead\(this\.db, this\.access, u, projectId\);/, note: "project-access enforces project membership and issues the ticket ScopedRead before the read" },
      { file: "src/modules/build/import-export/ticket-export.service.ts", line: 58, anchor: /tenant: tickets\.orgId,/, note: "the tenant column is declared to ScopedRead rather than filtered by hand" },
      { file: "src/modules/build/import-export/ticket-export.service.ts", line: 61, anchor: /eq\(tickets\.projectId, projectId\),/, note: "the URL project is a predicate on the exported rows" },
      { file: "src/modules/build/import-export/ticket-export.service.ts", line: 85, anchor: /\.where\(and\(where\.sql\)\)/, note: "the query consumes the token wholesale; it cannot drop a clause" },
      { file: "src/modules/access/scoped-read.ts", line: 101, anchor: /const parts: SQL\[\] = \[eq\(spec\.tenant, this\.orgId\), this\.#predicate\(spec\.scope\), \.\.\.domain\];/, note: "the tenant clause is prepended by the token, not by the caller" },
    ],
  },
  {
    key: "modules/build/files/files.controller.ts#uploadFile",
    verdict: "VERIFIED",
    finding: "org-scoping-verified",
    summary:
      "POST /build/:projectId/files. Assert-enforced, with the strong assert. The INSERT's tenant binding is values-only and constrains nothing on its own, but assertProjectAccess runs first and resolves through resolveProjectAccess, whose predicate binds eq(projects.orgId, u.orgId): a foreign org 404s and a same-org project the caller is not on 403s. Storage keys are org-prefixed from the same actor, so there is no cross-org object path either, and a composite (org_id, project_id) foreign key backstops the row.",
    blastRadius:
      "None. Recorded because the shape matters for the next reader: were the assert removed, the values-only orgId would let a caller stamp their own tenant onto a foreign project's attachment, and the only remaining backstop would surface as an uncaught 23503 rather than a 404.",
    evidence: [
      { file: "src/modules/build/files/files.controller.ts", line: 70, anchor: /return this\.svc\.uploadFile\(u, projectId, body\);/, note: "the complete authenticated actor reaches the service" },
      { file: "src/modules/build/files/files.service.ts", line: 115, anchor: /async uploadFile\(u: CurrentUserContext, projectId: number, input: UploadFileInput\) \{/, note: "the terminal service accepts CurrentUserContext" },
      { file: "src/modules/build/files/files.service.ts", line: 143, anchor: /orgId: u\.orgId,/, note: "the INSERT writes the tenant from the actor; this is a value, not a predicate" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 99, anchor: /eq\(projects\.orgId, u\.orgId\),/, note: "resolveProjectAccess supplies the predicate form the INSERT cannot" },
      { file: "src/db/schema/build/project-attachments.ts", line: 27, anchor: /name: "fk_project_attachments_org_project",/, note: "a composite tenant foreign key backstops the row" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#createEpic",
    verdict: "VERIFIED",
    finding: "org-scoping-verified",
    summary:
      "POST /build/:projectId/epics. Assert-enforced with the weaker assert. The INSERT stamps orgId as a value; the predicate form lives in assertProjectInOrg, which binds project id AND org id on one row and 404s a soft-deleted or foreign project before any write. reporterId is taken from the authenticated actor, so authorship cannot be forged. Tenant isolation holds. What does NOT hold is intra-org project scope: assertProjectInOrg checks that the project belongs to the caller's org, not that the caller belongs to the project, so any holder of build:tickets:create in the org can create an epic in any project in that org.",
    blastRadius:
      "No cross-tenant reach. Within one org, a caller holding build:tickets:create can create an epic in a project they are not a member of. That is this handler's deliberate coarser model, not a defect of this verdict; it is recorded here because the census's parent-scoping dimension answers a narrower question than a reader may assume.",
    evidence: [
      { file: "src/modules/build/execution/iterations.controller.ts", line: 297, anchor: /return this\.epics\.createEpic\(u\.orgId, u\.userId, projectId, body\);/, note: "the tenant and actor come from the authenticated context" },
      { file: "src/modules/build/execution/epics.service.ts", line: 107, anchor: /async createEpic\(orgId: string, userId: string, projectId: number, input: CreateEpicInput\) \{/, note: "the service takes orgId and projectId, never a client-supplied tenant" },
      { file: "src/modules/build/execution/epics.service.ts", line: 110, anchor: /^ +orgId,$/, note: "the INSERT writes the tenant as a value, which constrains nothing on its own" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 30, anchor: /eq\(projects\.id, projectId\),/, note: "assertProjectInOrg binds the project id" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 31, anchor: /eq\(projects\.orgId, orgId\),/, note: "and the tenant, in the same conjunction — this is the decisive predicate" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#createIntake",
    verdict: "VERIFIED",
    finding: "org-scoping-verified",
    summary:
      "POST /build/:projectId/intake. Assert-enforced with the weaker assert, and the only one of the six that was once actually unsafe: the service's own record states that listIntake resolved the project while this path did not, so a cross-tenant :projectId reached the INSERT and the composite tenant foreign key refused it with an uncaught 23503 — a corrupted write prevented, but not an authorization decision. assertProjectInOrg now runs first and 404s. As with createEpic, intra-org project membership is not checked. Also worth a reader's attention though not a defect of this route: submitterEmail is caller-supplied with no tie to u.userId, so the recorded submitter is unauthenticated data on a route that is itself permission-gated.",
    blastRadius:
      "No cross-tenant reach as of the assert. Within one org, a holder of build:workspace:manage can file intake against any project in that org.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 175, anchor: /return this\.intake\.createIntake\(u\.orgId, projectId, body\);/, note: "the tenant comes from the authenticated context" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 310, anchor: /async createIntake\(orgId: string, projectId: number, input: CreateIntakeInput\) \{/, note: "the terminal service signature" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 313, anchor: /\.insert\(intakeItems\)/, note: "the write whose tenant binding is values-only" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 31, anchor: /eq\(projects\.orgId, orgId\),/, note: "the predicate that makes the write safe, reached through assertProjectInOrg" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 30, anchor: /throw new NotFoundException\("Project not found"\);/, note: "a foreign or soft-deleted project 404s before the INSERT" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#createView",
    verdict: "VERIFIED",
    finding: "org-scoping-verified",
    summary:
      "POST /build/:projectId/views. Assert-enforced with the weaker assert and no read to filter, so the tenant appears only as an INSERT value plus assertProjectInOrg's predicate plus a composite (org_id, project_id) foreign key. Tenant isolation holds on all three. The intra-org gap is the widest of the six and is worth its own ticket rather than a census row: createView takes (orgId, userId) and so discards the CurrentUserContext that assertProjectAccess needs, which is why the weaker assert is used. Closing it is a signature change at the service and controller, shared with three sibling call sites in the same file.",
    blastRadius:
      "No cross-tenant reach. Within one org, a holder of build:workspace:manage can create a project view on any project in that org, including one they are not a member of and have no team assignment to.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 220, anchor: /return this\.views\.createView\(u\.orgId, u\.userId, projectId, body\);/, note: "the tenant and actor come from the authenticated context" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 444, anchor: /async createView\(orgId: string, userId: string, projectId: number, input: CreateViewInput\) \{/, note: "the signature that discards CurrentUserContext and so forces the weaker assert" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 31, anchor: /eq\(projects\.orgId, orgId\),/, note: "the decisive tenant predicate, reached through assertProjectInOrg" },
      { file: "src/db/schema/build/members.ts", line: 66, anchor: /name: "fk_project_views_org_project" \}\)/, note: "a composite tenant foreign key backstops the row" },
    ],
  },
];
