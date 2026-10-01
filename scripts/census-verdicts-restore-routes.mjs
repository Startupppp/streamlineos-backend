const PA = /await assertProjectAccess\(this\.db, this\.access, u, projectId\);/;
const TICKET = /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId, \{/;

export default [
  {
    key: "modules/build/core/releases/projects-releases.controller.ts#restoreRelease",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/releases/:releaseId/restore. restoreRelease calls assertProjectAccess(projectId), then both the existence lookup and the restoring UPDATE bind id+projectId+orgId together, so a release from another project or tenant 404s.",
    blastRadius: "None: a foreign releaseId matches no row in the lookup or the UPDATE.",
    evidence: [
      { file: "src/modules/build/core/releases/projects-releases.controller.ts", line: 114, anchor: /return this\.releases\.restoreRelease\(u, projectId, releaseId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 224, anchor: PA, note: "project membership is enforced first" },
      { file: "src/modules/build/core/releases/projects-releases.service.ts", line: 242, anchor: /eq\(projectReleases\.projectId, projectId\),/, note: "the restoring UPDATE binds the URL project" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#restoreTicket",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/restore. restoreTicket runs assertTicketReadAccess with includeDeleted, which binds tenant+project+ticket and enforces project membership and ticket DataScope, then re-reads the ticket on id+projectId+orgId before restoring.",
    blastRadius: "None: a ticket outside the URL project or the caller's access is rejected before any write.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets.controller.ts", line: 285, anchor: /return this\.restore\.restoreTicket\(u, projectId, ticketId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/core/tickets/projects-tickets-restore.service.ts", line: 39, anchor: TICKET, note: "canonical ticket decision, including deleted rows" },
      { file: "src/modules/build/core/tickets/projects-tickets-restore.service.ts", line: 46, anchor: /eq\(tickets\.projectId, projectId\),/, note: "the ticket re-read binds the URL project" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#restoreComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/comments/:commentId/restore. restoreComment runs assertTicketReadAccess with includeDeleted, binds the comment to ticketId+orgId, requires the caller to be the comment author, and re-reads the parent ticket on id+projectId+orgId.",
    blastRadius: "None: every route parent is bound and only the author may restore.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 115, anchor: /return this\.restore\.restoreComment\(u, projectId, ticketId, commentId\);/, note: "actor and every route id reach the service" },
      { file: "src/modules/build/core/tickets/projects-tickets-restore.service.ts", line: 139, anchor: TICKET, note: "canonical ticket decision, including deleted rows" },
      { file: "src/modules/build/core/tickets/projects-tickets-restore.service.ts", line: 146, anchor: /eq\(ticketComments\.ticketId, ticketId\),/, note: "the comment is bound to the URL ticket" },
      { file: "src/modules/build/core/tickets/projects-tickets-restore.service.ts", line: 167, anchor: /eq\(tickets\.projectId, projectId\),/, note: "the parent ticket is bound to the URL project" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#restoreMilestone",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/milestones/:milestoneId/restore. restoreMilestone resolves the project under the caller's org with assertProjectInOrg, then the lookup and the restoring UPDATE bind id+projectId+orgId. Like its delete sibling it relies on the build:workspace:restore permission rather than project membership.",
    blastRadius: "None cross-tenant or cross-project: a foreign milestoneId matches no row.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 143, anchor: /return this\.milestones\.restoreMilestone\(u\.orgId, u\.userId, projectId, milestoneId\);/, note: "org comes from the verified actor" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 226, anchor: /await assertProjectInOrg\(this\.db, orgId, projectId\);/, note: "the URL project is resolved under the caller's org" },
      { file: "src/modules/build/execution/workspace.service.ts", line: 243, anchor: /eq\(projectMilestones\.projectId, projectId\),/, note: "the restoring UPDATE binds the URL project" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#restoreWhiteboard",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/whiteboards/:whiteboardId/restore. restoreWhiteboard resolves the project under the caller's org, binds the board to id+projectId+orgId, and requires manage access on the board before the restoring UPDATE, which binds the same three columns.",
    blastRadius: "None: a foreign board matches no row and a non-manager is refused.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 393, anchor: /return this\.whiteboards\.restoreWhiteboard\(u, projectId, whiteboardId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 338, anchor: /await assertProjectInOrg\(this\.db, u\.orgId, projectId\);/, note: "the URL project is resolved under the caller's org" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 342, anchor: /eq\(projectWhiteboards\.projectId, projectId\),/, note: "the board lookup binds the URL project" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 355, anchor: /throw new ForbiddenException\("Only board managers can restore whiteboards"\);/, note: "board manage access is required" },
    ],
  },
  {
    key: "modules/build/qa/test-cases.controller.ts#restoreCase",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/test-cases/:caseId/restore. restoreCase calls assertProjectAccess(projectId), then the lookup and the restoring UPDATE bind id+orgId+projectId.",
    blastRadius: "None: a foreign caseId matches no row.",
    evidence: [
      { file: "src/modules/build/qa/test-cases.controller.ts", line: 118, anchor: /return this\.svc\.restoreCase\(u, projectId, caseId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/qa/test-management.service.ts", line: 338, anchor: PA, note: "project membership is enforced first" },
      { file: "src/modules/build/qa/test-management.service.ts", line: 357, anchor: /eq\(testCases\.projectId, projectId\),/, note: "the restoring UPDATE binds the URL project" },
    ],
  },
  {
    key: "modules/build/qa/test-runs.controller.ts#restoreRun",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/test-runs/:runId/restore. restoreRun calls assertProjectAccess(projectId), then the lookup and the restoring UPDATE bind id+orgId+projectId.",
    blastRadius: "None: a foreign runId matches no row.",
    evidence: [
      { file: "src/modules/build/qa/test-runs.controller.ts", line: 160, anchor: /return this\.svc\.restoreRun\(u, projectId, runId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/qa/test-runs.service.ts", line: 357, anchor: PA, note: "project membership is enforced first" },
      { file: "src/modules/build/qa/test-runs.service.ts", line: 376, anchor: /eq\(testRuns\.projectId, projectId\),/, note: "the restoring UPDATE binds the URL project" },
    ],
  },
  {
    key: "modules/build/qa/test-suites.controller.ts#restoreSuite",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/test-suites/:suiteId/restore. restoreSuite calls assertProjectAccess(projectId), then the lookup and the restoring UPDATE bind id+orgId+projectId.",
    blastRadius: "None: a foreign suiteId matches no row.",
    evidence: [
      { file: "src/modules/build/qa/test-suites.controller.ts", line: 106, anchor: /return this\.svc\.restoreSuite\(u, projectId, suiteId\);/, note: "actor and both route ids reach the service" },
      { file: "src/modules/build/qa/test-management.service.ts", line: 168, anchor: PA, note: "project membership is enforced first" },
      { file: "src/modules/build/qa/test-management.service.ts", line: 187, anchor: /eq\(testSuites\.projectId, projectId\),/, note: "the restoring UPDATE binds the URL project" },
    ],
  },
];
