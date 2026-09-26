export default [
  {
    key: "modules/build/core/project-resources.controller.ts#createProjectLabel",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/:projectId/labels. Org is bound twice. The handler first calls assertCanManageProject, whose project lookup is predicated on the caller's own org at projects-members.service.ts:71, so a foreign :projectId answers 404 before any write. The write itself is an INSERT into ticket_labels and scopes the row by writing orgId into .values({ orgId, ... }) at projects-labels.service.ts:23. The static pass reports PASSED-UNBOUND because its binding detection is syntactic — it looks for eq()/inArray()/a sql interpolation in a predicate — and an INSERT has no predicate; the ES6 shorthand property `orgId,` in a .values() object is invisible to it. The delegation controller -> ProjectsMembersService.createLabel (a one-line re-export at projects-members.service.ts:434) -> ProjectsLabelsService.createLabel also adds a hop. ticket_labels carries no project_id column, so there is no parent dimension to bind; the :projectId segment is verified for addressing only.",
    blastRadius:
      "None. Neither cross-tenant nor intra-tenant: the row is created in the caller's own org, and a :projectId belonging to another organisation is rejected 404 by assertCanManageProject before the insert runs.",
    evidence: [
      {
        file: "src/modules/build/core/project-resources.controller.ts",
        line: 223,
        anchor: /await this\.members\.assertCanManageProject\(u, projectId\);/,
        note: "the url project is resolved under the caller's org before the write",
      },
      {
        file: "src/modules/build/core/projects-members.service.ts",
        line: 71,
        anchor: /where: and\(eq\(projects\.id, projectId\), eq\(projects\.orgId, u\.orgId\), isNull\(projects\.deletedAt\)\),/,
        note: "the project lookup that makes a foreign :projectId a 404",
      },
      {
        file: "src/modules/build/core/projects-labels.service.ts",
        line: 23,
        anchor: /\.values\(\{ orgId, name: body\.name, color: body\.color \?\? "#3B82F6" \}\)/,
        note: "org is bound as an INSERT column, not a predicate — the form the static pass cannot see",
      },
    ],
  },

  {
    key: "modules/build/core/projects-templates.controller.ts#createTemplate",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/templates. An org-level route with no :projectId, so there is no parent dimension. The controller forwards u.orgId and the service INSERTs into project_templates with orgId as a column of .values() at projects-templates.service.ts:69, and the nested project_template_tickets rows carry the same orgId. The static pass reports PASSED-UNBOUND for the reason its own documentation gives for create endpoints: an INSERT scopes the row by writing orgId into .values({ orgId, ... }), which is not a predicate, so syntactic eq()/inArray() detection finds nothing. The read-back at the end of the method is keyed on the id just returned by the insert, so it cannot reach another org's row.",
    blastRadius:
      "None. The created template is owned by the caller's org; there is no reachable row outside it.",
    evidence: [
      {
        file: "src/modules/build/core/projects-templates.service.ts",
        line: 67,
        anchor: /\.insert\(projectTemplates\)/,
        note: "the write is an INSERT — no WHERE clause exists for the static pass to inspect",
      },
      {
        file: "src/modules/build/core/projects-templates.service.ts",
        line: 69,
        anchor: /^\s*orgId,$/,
        note: "org bound as an ES6 shorthand column in .values()",
      },
    ],
  },

  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#listRelatedLinks",
    verdict: "CLOSED",
    finding: "project-membership-gate-missing",
    summary:
      "GET /build/:projectId/tickets/:ticketId/related-links. The lead was real. ticket_related_links has no project_id column, so the parent could only ever be bound through the ticket; the service did that with a private assertTicketAccess that selected the ticket on (id, orgId) and compared ticket.projectId !== projectId in JavaScript. That comparison did bind the parent for addressing, which is why the static pass — which only recognises a parent reaching an eq() — could not see it. But it was the whole gate: nothing checked that the caller had any access to the project named in the url, and nothing applied the tickets data scope. The direct sibling in the same controller, relations, calls assertTicketReadAccess (projects-ticket-relations.service.ts:61), which binds tickets.projectId in SQL at build-ticket-read-access.ts:37 AND calls resolveProjectAccess at :44. The fix makes assertTicketAccess delegate to that same helper (projects-ticket-links.service.ts:38), so all four related-link methods now enforce the sibling's gate. New spec projects-ticket-links-project-access.spec.ts fails pre-fix with 'promise resolved instead of rejected' and passes after.",
    blastRadius:
      "Intra-tenant, not cross-tenant: ticketRelatedLinks.orgId was already bound in every query, so nothing left the organisation. The hole was project-level. Any member of the org holding the org-wide build:tickets:view key — with no project membership, no team assignment, not the project manager and without build:manage — could read the related links of any ticket in any project of the org by naming that project and ticket in the url. The paired POST let the same actor, holding build:tickets:update, write a link onto that ticket.",
    evidence: [
      {
        file: "src/modules/build/core/projects-ticket-links.service.ts",
        line: 38,
        anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/,
        note: "the fix — the private helper now delegates to the shared gate the sibling already used",
      },
      {
        file: "src/modules/build/core/build-ticket-read-access.ts",
        line: 37,
        anchor: /eq\(tickets\.projectId, projectId\),/,
        note: "the parent is now bound in SQL, not only compared in JavaScript",
      },
      {
        file: "src/modules/build/core/build-ticket-read-access.ts",
        line: 44,
        anchor: /const projectAccess = await resolveProjectAccess\(/,
        note: "the project-membership assertion that was entirely absent before",
      },
      {
        file: "src/modules/build/core/projects-ticket-relations.service.ts",
        line: 61,
        anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/,
        note: "the sibling in the same controller whose shape the fix copies",
      },
    ],
  },

  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#addRelatedLink",
    verdict: "CLOSED",
    finding: "project-membership-gate-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/related-links. Same defect and same fix as listRelatedLinks — both went through the one private assertTicketAccess in projects-ticket-links.service.ts. The INSERT itself was correctly org-bound (orgId: u.orgId at :151) and the parent was bound to the ticket by a JavaScript comparison the static pass cannot read, but no project-access gate ran, so an org-wide build:tickets:update holder could attach a link to a ticket in a project they are not on. assertTicketAccess now delegates to assertTicketReadAccess at :38, matching addRelation in projects-ticket-relations.service.ts. The spec asserts the write is refused AND that db.insert was never called.",
    blastRadius:
      "Intra-tenant write, not cross-tenant: orgId was and is bound on the insert, so no row can be planted in another organisation. Within the org, any holder of build:tickets:update could write a related link onto any ticket in any project without belonging to it — a stored, user-visible URL on someone else's work item.",
    evidence: [
      {
        file: "src/modules/build/core/projects-ticket-links.service.ts",
        line: 38,
        anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/,
        note: "the shared helper both related-link handlers call — now gated",
      },
      {
        file: "src/modules/build/core/projects-ticket-links.service.ts",
        line: 151,
        anchor: /orgId: u\.orgId,/,
        note: "org was already bound on the INSERT — the org dimension was never the hole",
      },
      {
        file: "src/modules/build/core/build-ticket-read-access.ts",
        line: 50,
        anchor: /if \(!projectAccess\.hasAccess \|\| !ticket\.allowed\)/,
        note: "the refusal the outsider now hits",
      },
    ],
  },

  {
    key: "modules/build/core/projects.controller.ts#createLabel",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/labels. An org-level route with no path parameters at all, so there is no parent dimension. The controller passes u.orgId straight through ProjectsMembersService.createLabel (a one-line re-export) to ProjectsLabelsService.createLabel, which INSERTs into ticket_labels with orgId as a column of .values() at projects-labels.service.ts:23. PASSED-UNBOUND is the expected reading for a create endpoint: the binding is an INSERT column, not a predicate, and the static pass only recognises eq()/inArray()/sql interpolation inside a WHERE. ticket_labels is org-scoped by design — it carries no project_id — so this route and #createProjectLabel write the same kind of row.",
    blastRadius:
      "None. The label is created in the caller's own org and no caller-supplied identifier addresses an existing row.",
    evidence: [
      {
        file: "src/modules/build/core/projects.controller.ts",
        line: 115,
        anchor: /return this\.members\.createLabel\(u\.orgId, body\);/,
        note: "the org passed is the caller's own, taken from the verified context",
      },
      {
        file: "src/modules/build/core/projects-labels.service.ts",
        line: 23,
        anchor: /\.values\(\{ orgId, name: body\.name, color: body\.color \?\? "#3B82F6" \}\)/,
        note: "org bound as an INSERT column",
      },
    ],
  },

  {
    key: "modules/build/execution/iterations.controller.ts#listSprints",
    verdict: "VERIFIED",
    finding: "route-is-frozen-410",
    summary:
      "GET /build/:projectId/sprints. The lead is vacuous: there is no query to bind. The sprints table was dropped when Build cut over to the Cycle model, and SprintsService is a tombstone — every method, listSprints included, throws GoneException with the FROZEN message declared at sprints.service.ts:7 and never touches the database. The static pass follows the handler into a service method that accepts _orgId and _projectId and never uses them, which is exactly the shape of PASSED-UNBOUND; it cannot tell a 410 stub from an unbound query. The live route is /build/:projectId/cycles.",
    blastRadius:
      "None. No row of any kind is reachable through this handler — it returns 410 Gone before any database access, for every caller.",
    evidence: [
      {
        file: "src/modules/build/execution/sprints.service.ts",
        line: 7,
        anchor: /^const FROZEN = "Sprints are frozen\./,
        note: "the tombstone message — the sprints table no longer exists",
      },
      {
        file: "src/modules/build/execution/sprints.service.ts",
        line: 17,
        anchor: /throw new GoneException\(FROZEN\);/,
        note: "listSprints body in full — no query, so nothing to bind",
      },
    ],
  },

  {
    key: "modules/build/execution/iterations.controller.ts#createSprint",
    verdict: "VERIFIED",
    finding: "route-is-frozen-410",
    summary:
      "POST /build/:projectId/sprints. Same tombstone as listSprints: createSprint's entire body is a GoneException throw at sprints.service.ts:21, so no INSERT exists and the orgId and projectId the controller forwards are discarded parameters (_orgId, _projectId). The static pass reads unused forwarded parameters as PASSED-UNBOUND. Cycle creation, the live replacement, is POST /build/:projectId/cycles on CyclesController.",
    blastRadius:
      "None. The handler writes nothing — it returns 410 Gone before reaching the database.",
    evidence: [
      {
        file: "src/modules/build/execution/sprints.service.ts",
        line: 21,
        anchor: /throw new GoneException\(FROZEN\);/,
        note: "createSprint body in full — no INSERT is reachable",
      },
    ],
  },

  {
    key: "modules/build/execution/iterations.controller.ts#deleteSprint",
    verdict: "VERIFIED",
    finding: "route-is-frozen-410",
    summary:
      "DELETE /build/:projectId/sprints/:sprintId. Flagged on BOTH org and parent scoping, and both leads are vacuous for the same reason: deleteSprint's body is a single GoneException throw at sprints.service.ts:39. No DELETE statement exists, so neither orgId nor projectId can appear in a predicate. The static pass sees three forwarded-and-unused parameters and reports each unbound dimension.",
    blastRadius:
      "None. Nothing is deleted — the handler returns 410 Gone before any database access.",
    evidence: [
      {
        file: "src/modules/build/execution/sprints.service.ts",
        line: 39,
        anchor: /throw new GoneException\(FROZEN\);/,
        note: "deleteSprint body in full — no DELETE is reachable",
      },
      {
        file: "src/modules/build/execution/sprints.service.ts",
        line: 7,
        anchor: /Cycles are the only iteration identity/,
        note: "the model that replaced sprints; the sprints table was dropped",
      },
    ],
  },

  {
    key: "modules/build/execution/timesheets.controller.ts#listTicketTimeEntries",
    verdict: "VERIFIED",
    finding: "parent-bound-through-a-repacked-query-object",
    summary:
      "GET /build/:projectId/tickets/:ticketId/time-entries. The parent is genuinely bound, three times over. listTicketTimeEntries is a one-line adapter at timesheets.service.ts:410 that repacks its positional projectId and ticketId into the query object of listTimeEntries; that is why the static pass loses the trail, since it follows the named method and never sees projectId reach an eq(). Inside listTimeEntries the project is resolved under the caller's org by assertProjectInOrg at :75, the ticket must belong to that project at :79, and the entry list itself carries eq(timesheets.projectId, query.projectId) at :109. Org is bound at :87, and the row set is further narrowed by the timesheets scope predicate, so a caller without 'all' scope sees only their own entries. Residual noted and deliberately not changed: there is no project-membership assert here, but the identical rows are already reachable through the org-level GET /build/time-entries?projectId=&ticketId= on the same service method, so gating only the project-addressed route would close nothing.",
    blastRadius:
      "None beyond what the org-level list route already exposes. Not cross-tenant: timesheets.orgId is bound and a project outside the org 404s at assertProjectInOrg. Within the org a build:timesheets:manage holder at 'all' scope sees org-wide entries by design; everyone else is cut to their own membership by the scope predicate.",
    evidence: [
      {
        file: "src/modules/build/execution/timesheets.service.ts",
        line: 410,
        anchor: /return this\.listTimeEntries\(user, \{ \.\.\.query, projectId, ticketId \}\);/,
        note: "the repack that hides the parent from a static reader following the named method",
      },
      {
        file: "src/modules/build/execution/timesheets.service.ts",
        line: 79,
        anchor: /query\.projectId \? eq\(tickets\.projectId, query\.projectId\) : undefined,/,
        note: "the ticket must belong to the url project — a foreign pairing 404s",
      },
      {
        file: "src/modules/build/execution/timesheets.service.ts",
        line: 109,
        anchor: /conditions\.push\(eq\(timesheets\.projectId, query\.projectId\)\);/,
        note: "the parent is bound in the list predicate itself",
      },
      {
        file: "src/modules/build/execution/timesheets.service.ts",
        line: 75,
        anchor: /if \(query\.projectId\) await assertProjectInOrg\(this\.db, user\.orgId, query\.projectId\);/,
        note: "the url project is resolved under the caller's org first",
      },
    ],
  },

  {
    key: "modules/build/execution/workspace.controller.ts#createWorkspaceView",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST on the workspace views controller. An org-level route with no :projectId, and the row is deliberately project-less: the INSERT into project_views sets projectId: null and scope: 'workspace' explicitly (workspace.service.ts:316) and binds the tenant by writing orgId as a column at :317. PASSED-UNBOUND is the documented false reading for create endpoints — the binding is an INSERT column, not a predicate. The sibling readers and mutators of the same table (listWorkspaceViews, updateWorkspaceView, deleteWorkspaceView) all bind eq(projectViews.orgId, orgId) in their WHERE clauses and additionally refuse a private view the caller does not own.",
    blastRadius:
      "None. The view is created in the caller's own org with no project attachment, and no caller-supplied identifier addresses an existing row.",
    evidence: [
      {
        file: "src/modules/build/execution/workspace.service.ts",
        line: 316,
        anchor: /projectId: null,/,
        note: "the row is intentionally project-less, so there is no parent dimension",
      },
      {
        file: "src/modules/build/execution/workspace.service.ts",
        line: 317,
        anchor: /^\s*orgId,$/,
        note: "org bound as an ES6 shorthand column in .values()",
      },
    ],
  },

  {
    key: "modules/build/managed-products/managed-products.controller.ts#createManagedProduct",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/managed-products. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into managed_products with orgId as a column of .values() at managed-products.service.ts:83; the unique-key conflict it catches is the per-org key constraint, which is itself evidence the row is org-scoped. PASSED-UNBOUND is the expected static reading because an INSERT carries no predicate for eq() detection. The sibling updateManagedProduct binds eq(managedProducts.orgId, orgId) in its WHERE, so the table's org column is genuinely the tenant key.",
    blastRadius:
      "None. The product is created in the caller's own org; no existing row is addressed.",
    evidence: [
      {
        file: "src/modules/build/managed-products/managed-products.service.ts",
        line: 113,
        anchor: /\.insert\(managedProducts\)/,
        note: "an INSERT — no WHERE clause exists to carry a predicate",
      },
      {
        file: "src/modules/build/managed-products/managed-products.service.ts",
        line: 115,
        anchor: /^\s*orgId,$/,
        note: "org bound as an ES6 shorthand column in .values()",
      },
    ],
  },

  {
    key: "modules/build/portfolios/portfolios.controller.ts#createPortfolio",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/portfolios. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into project_portfolios with orgId as a column of .values() and records createdBy from the verified context. PASSED-UNBOUND is the documented create-endpoint reading: the binding is an INSERT column and the static pass only recognises predicates. The sibling updatePortfolio binds eq(projectPortfolios.orgId, orgId) in its WHERE, confirming the column is the tenant key.",
    blastRadius:
      "None. The portfolio is created in the caller's own org; no existing row is addressed.",
    evidence: [
      {
        file: "src/modules/build/portfolios/portfolios.service.ts",
        line: 247,
        anchor: /\.insert\(projectPortfolios\)/,
        note: "an INSERT — no WHERE clause exists to carry a predicate",
      },
      {
        file: "src/modules/build/portfolios/portfolios.service.ts",
        line: 249,
        anchor: /^\s*orgId,$/,
        note: "org bound as an ES6 shorthand column in .values()",
      },
    ],
  },

  {
    key: "modules/build/teams/teams.controller.ts#createTeam",
    verdict: "VERIFIED",
    finding: "insert-binds-org-in-values",
    summary:
      "POST /build/teams. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into project_teams with orgId as a column of .values() at teams.service.ts:135, and the unique-violation branch it catches reports the key clash as per-organisation, which is what the org-scoped unique index enforces. PASSED-UNBOUND is the expected reading for a create endpoint. The sibling updateTeam binds eq(projectTeams.orgId, orgId) in its WHERE.",
    blastRadius:
      "None. The team is created in the caller's own org; no existing row is addressed.",
    evidence: [
      {
        file: "src/modules/build/teams/teams.service.ts",
        line: 133,
        anchor: /\.insert\(projectTeams\)/,
        note: "an INSERT — no WHERE clause exists to carry a predicate",
      },
      {
        file: "src/modules/build/teams/teams.service.ts",
        line: 135,
        anchor: /^\s*orgId,$/,
        note: "org bound as an ES6 shorthand column in .values()",
      },
    ],
  },
];
