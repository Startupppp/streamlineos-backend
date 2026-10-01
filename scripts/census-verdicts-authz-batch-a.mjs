// scripts/census-verdicts-authz-batch-a.mjs
//
// Hand-review batch A: the 51 NEEDS-REVIEW findings in these 16 controller files:
//   approvals/approvals.controller.ts
//   client-portal/change-requests.controller.ts
//   client-portal/client-visibility.controller.ts
//   core/project-resources.controller.ts
//   core/projects-automations.controller.ts
//   core/projects-custom-fields.controller.ts
//   core/projects-ticket-associations.controller.ts
//   core/projects-ticket-checklists.controller.ts
//   core/projects-ticket-comments.controller.ts
//   core/projects-tickets.controller.ts
//   core/projects-webhooks.controller.ts
//   execution/iterations.controller.ts
//   execution/whiteboard-sharing.controller.ts
//   execution/workspace.controller.ts
//   files/files.controller.ts
//   forms/forms.controller.ts
//
// Every entry below was resolved by reading the controller handler AND the full
// call chain down to the query/mutation that actually touches the database —
// never by trusting the static pass's orgEvidence/parentEvidence pointer alone.
//
export default [
  // ── approvals/approvals.controller.ts ──────────────────────────────────────
  {
    key: "modules/build/approvals/approvals.controller.ts#getApproval",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/approvals/:approvalId. The handler declares both @Param(\"projectId\") and @Param(\"approvalId\") and forwards both into ApprovalsReadService.getApproval(u, projectId, approvalId). That method calls assertProjectAccess(u, projectId) and then the shared loadApproval(db, orgId, projectId, approvalId) helper, whose single WHERE clause binds id=approvalId AND orgId=orgId AND projectId=projectId together and throws NotFoundException when they do not all match. A real approval that belongs to a different project (or a different org) 404s; the URL's :projectId is not decorative.",
    blastRadius:
      "None: an approvalId that does not belong to the named :projectId (whether in the caller's org or another org) 404s at loadApproval before any row is returned.",
    evidence: [
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 104, anchor: /getApproval\(/, note: "handler binds both projectId and approvalId route params and forwards both" },
      { file: "src/modules/build/approvals/approvals-read.service.ts", line: 137, anchor: /return loadApproval\(this\.db, u\.orgId, projectId, approvalId\);/, note: "projectId is passed into loadApproval alongside approvalId and orgId" },
      { file: "src/modules/build/approvals/approval-lookup.ts", line: 6, anchor: /export async function loadApproval\(db: Db, orgId: string, projectId: number, approvalId: number\)/, note: "shared lookup takes projectId as a required parameter" },
      { file: "src/modules/build/approvals/approval-lookup.ts", line: 11, anchor: /eq\(projectApprovals\.projectId, projectId\),/, note: "WHERE clause binds the approval row to the named project; NotFoundException on any mismatch" },
    ],
  },
  {
    key: "modules/build/approvals/approvals.controller.ts#decideApproval",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/approvals/:approvalId/decide. The handler binds projectId+approvalId and calls ApprovalsService.decideApproval(user, projectId, approvalId, input). The method's first statement is loadApproval(this.db, orgId, projectId, approvalId), which binds id+orgId+projectId in one WHERE and 404s on any mismatch — so an approvalId belonging to a different project never reaches the decision logic or the UPDATE below it. The UPDATE itself is keyed by id+orgId only, but approvalId is a global-identity PK already proven by loadApproval to belong to this exact project, so re-stating projectId there would be redundant, not protective (verify-then-act-by-PK pattern, same shape as the loadApproval-gated methods throughout this file).",
    blastRadius:
      "None: a foreign :approvalId (wrong project or wrong org) 404s at loadApproval before the decision logic or the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 131, anchor: /decideApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 186, anchor: /const approval = await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "first statement binds id+orgId+projectId; 404 on mismatch before any further logic" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 207, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\)/, note: "mutation keyed by already-verified PK+org" },
      { file: "src/modules/build/approvals/approval-lookup.ts", line: 11, anchor: /eq\(projectApprovals\.projectId, projectId\),/, note: "loadApproval's project binding" },
    ],
  },
  {
    key: "modules/build/approvals/approvals.controller.ts#updateApproval",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/approvals/:approvalId. Same shape as decideApproval: ApprovalsService.updateApproval(orgId, userId, projectId, approvalId, input) opens with loadApproval(this.db, orgId, projectId, approvalId), which binds id+orgId+projectId and 404s on mismatch, before building the patch and running the UPDATE keyed by the now-verified id+orgId.",
    blastRadius:
      "None: a foreign :approvalId 404s at loadApproval before the patch is built or the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 144, anchor: /updateApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 186, anchor: /await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the patch is built" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 207, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\)/, note: "UPDATE keyed by the already-verified PK" },
    ],
  },
  {
    key: "modules/build/approvals/approvals.controller.ts#softDeleteApproval",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/approvals/:approvalId. ApprovalsService.softDeleteApproval(orgId, projectId, approvalId) opens with the same loadApproval(this.db, orgId, projectId, approvalId) binding (id+orgId+projectId, 404 on mismatch) before setting deletedAt via an UPDATE keyed by the now-verified id+orgId.",
    blastRadius:
      "None: a foreign :approvalId 404s at loadApproval before the soft-delete UPDATE runs.",
    evidence: [
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 158, anchor: /softDeleteApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 288, anchor: /await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the delete" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 292, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\);/, note: "soft-delete UPDATE keyed by the already-verified PK" },
    ],
  },

  // ── client-portal/change-requests.controller.ts ─────────────────────────────
  {
    key: "modules/build/client-portal/change-requests.controller.ts#getChangeRequest",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/change-requests/:changeRequestId. ChangeRequestsService.getChangeRequest(u, projectId, crId) first calls assertProjectAccess(u, projectId), then SELECTs the row with id=crId AND orgId=u.orgId AND projectId=projectId all in the same WHERE, throwing NotFoundException when no row matches. The :projectId segment is a real predicate on the query, not just a permission check.",
    blastRadius:
      "None: a changeRequestId belonging to a different project (or org) 404s directly at the SELECT's WHERE clause.",
    evidence: [
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 73, anchor: /getChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 157, anchor: /async getChangeRequest\(u: CurrentUserContext, projectId: number, crId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 164, anchor: /eq\(changeRequests\.id, crId\),/, note: "SELECT WHERE binds id+orgId+projectId together (see surrounding and(...))" },
    ],
  },
  {
    key: "modules/build/client-portal/change-requests.controller.ts#updateChangeRequest",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/change-requests/:changeRequestId. ChangeRequestsService.updateChangeRequest(u, projectId, crId, input) first SELECTs the existing row bound to id+orgId+projectId (404 if it does not match), then the actual UPDATE repeats the identical id+orgId+projectId binding in its own WHERE clause. Both the existence check and the mutation itself are project-scoped, not just the pre-check.",
    blastRadius:
      "None: a foreign :changeRequestId 404s at the existence check before the UPDATE is even attempted, and the UPDATE's own WHERE independently re-asserts the same binding.",
    evidence: [
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 98, anchor: /updateChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 237, anchor: /eq\(changeRequests\.id, crId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 291, anchor: /eq\(changeRequests\.id, crId\),/, note: "the UPDATE's own WHERE re-binds id+orgId+projectId" },
    ],
  },
  {
    key: "modules/build/client-portal/change-requests.controller.ts#deleteChangeRequest",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/change-requests/:changeRequestId. Same shape as updateChangeRequest: ChangeRequestsService.deleteChangeRequest(u, projectId, crId) SELECTs the existing row bound to id+orgId+projectId (404 on mismatch), then the soft-delete UPDATE repeats the identical id+orgId+projectId binding.",
    blastRadius:
      "None: a foreign :changeRequestId 404s at the existence check, and the UPDATE's own WHERE independently re-asserts the binding.",
    evidence: [
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 112, anchor: /deleteChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 329, anchor: /eq\(changeRequests\.id, crId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 342, anchor: /eq\(changeRequests\.id, crId\),/, note: "soft-delete UPDATE re-binds id+orgId+projectId" },
    ],
  },

  // ── client-portal/client-visibility.controller.ts ───────────────────────────
  {
    key: "modules/build/client-portal/client-visibility.controller.ts#toggleTicketVisibility",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/client-visibility/tickets/:ticketId. ClientVisibilityService.toggleTicketVisibility(orgId, userId, projectId, ticketId, clientVisible) first looks up the ticket bound to id=ticketId AND orgId AND projectId (404 if absent), then the UPDATE is keyed by id+orgId — ticketId is a global PK already proven by the preceding lookup to belong to this exact project, so the UPDATE's narrower key is still safe (verify-then-act-by-PK).",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the existence check before the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 55, anchor: /toggleTicketVisibility\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 92, anchor: /eq\(tickets\.id, ticketId\), eq\(tickets\.orgId, orgId\), eq\(tickets\.projectId, projectId\), isNull\(tickets\.deletedAt\)/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 104, anchor: /eq\(tickets\.id, ticketId\),$/, note: "UPDATE keyed by the already-verified PK" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 104, anchor: /eq\(tickets\.orgId, orgId\),$/, note: "the UPDATE also binds the tenant" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 104, anchor: /version !== undefined \? eq\(tickets\.version, version\) : undefined,/, note: "an optional optimistic-lock arm was added to the UPDATE; it narrows the key, never widens it" },
    ],
  },
  {
    key: "modules/build/client-portal/client-visibility.controller.ts#toggleMilestoneVisibility",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/client-visibility/milestones/:milestoneId. Same shape: toggleMilestoneVisibility looks up the milestone bound to id+orgId+projectId (404 if absent) before the UPDATE keyed by the already-verified id+orgId.",
    blastRadius:
      "None: a milestoneId belonging to a different project 404s at the existence check before the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 68, anchor: /toggleMilestoneVisibility\(/, note: "handler binds both projectId and milestoneId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 127, anchor: /eq\(projectMilestones\.id, milestoneId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 138, anchor: /\.where\(and\(eq\(projectMilestones\.id, milestoneId\), eq\(projectMilestones\.orgId, orgId\)\)\);/, note: "UPDATE keyed by the already-verified PK" },
    ],
  },
  {
    key: "modules/build/client-portal/client-visibility.controller.ts#toggleCommentVisibility",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/client-visibility/comments/:commentId. toggleCommentVisibility resolves the comment through an INNER JOIN to tickets that explicitly binds tickets.projectId=projectId AND tickets.orgId=orgId AND ticketComments.id=commentId AND ticketComments.orgId=orgId (404 if no row), before the UPDATE keyed by the already-verified id+orgId. The join is the parent-binding: a comment on a ticket in a different project produces zero rows.",
    blastRadius:
      "None: a commentId whose parent ticket belongs to a different project 404s at the join before the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 81, anchor: /toggleCommentVisibility\(/, note: "handler binds both projectId and commentId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 156, anchor: /\.innerJoin\(tickets, and\(/, note: "join binds the comment's ticket to the named project via tickets.projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 156, anchor: /\.where\(and\(eq\(ticketComments\.id, commentId\), eq\(ticketComments\.orgId, orgId\)\)\);/, note: "UPDATE keyed by the already-verified PK" },
    ],
  },
  {
    key: "modules/build/client-portal/client-visibility.controller.ts#toggleAttachmentVisibility",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/client-visibility/attachments/:attachmentId. Same join-based binding as toggleCommentVisibility: the attachment is resolved through an INNER JOIN to tickets requiring tickets.projectId=projectId AND tickets.orgId=orgId (404 if no row), before the UPDATE keyed by the already-verified id+orgId.",
    blastRadius:
      "None: an attachmentId whose parent ticket belongs to a different project 404s at the join before the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 94, anchor: /toggleAttachmentVisibility\(/, note: "handler binds both projectId and attachmentId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 156, anchor: /async toggleAttachmentVisibility\(u: CurrentUserContext, projectId: number, attachmentId: number, clientVisible: boolean\) \{/, note: "signature carries the authenticated actor and projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 188, anchor: /eq\(tickets\.projectId, projectId\),/, note: "join binds the attachment's ticket to the named project" },
    ],
  },

  // ── core/project-resources.controller.ts ────────────────────────────────────
  {
    key: "modules/build/core/project-crud/project-resources.controller.ts#updateMemberRole",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/members/:memberUserId. ProjectsMembersService.updateMemberRole(projectId, memberUserId, input, u) calls assertProjectOwnership(orgId, projectId) (404 unless the project belongs to this org) and assertCanManageProject(u, projectId) before resolving memberUserId to a membership via assertOrganizationActor(db, orgId, {userId}), which itself only resolves memberships that belong to orgId. The UPDATE then runs where(projectMembers.projectId=projectId AND projectMembers.membershipId=targetActor.membershipId) — both sides of that predicate are already tenant/project-verified by the time the query runs, and the update 404s (NotFoundException) if the target actor is not actually a member of this specific project.",
    blastRadius:
      "None cross-tenant, and none cross-project either: the UPDATE's own WHERE requires the target membership to be a member of this exact :projectId, so a memberUserId who is only a member of a different project in the same org gets 404, not a role change.",
    evidence: [
      { file: "src/modules/build/core/project-crud/project-resources.controller.ts", line: 128, anchor: /updateMemberRole\(/, note: "handler binds both projectId and memberUserId and forwards both" },
      { file: "src/modules/build/core/members/projects-members.service.ts", line: 392, anchor: /await assertProjectAccess\(this\.db, this\.access, u, projectId\);/, note: "confirms projectId belongs to this org, 404 otherwise" },
      { file: "src/modules/build/core/members/projects-members.service.ts", line: 350, anchor: /const targetActor = await assertOrganizationActor\(this\.db, orgId, \{ kind: "user", userId: memberUserId \}\);/, note: "resolves the target membership scoped to this org" },
      { file: "src/modules/build/core/members/projects-members.service.ts", line: 361, anchor: /eq\(projectMembers\.projectId, projectId\),/, note: "UPDATE's WHERE requires the target membership to belong to this exact project; 404 otherwise" },
    ],
  },

  // ── core/projects-automations.controller.ts ─────────────────────────────────
  {
    key: "modules/build/core/automation/projects-automations.controller.ts#update",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/automations/:automationId. ProjectsAutomationsService.updateAutomation authorized the caller via assertCanManageProject(u, projectId), which a project-scoped manager of the NAMED project alone can satisfy, but the mutation's WHERE clause only bound id+orgId — never projectId — so that caller could rewrite any other project's automation by ID. Fixed by adding eq(projectAutomations.projectId, projectId) to the UPDATE's WHERE, so a foreign automationId now 404s instead of matching.",
    blastRadius:
      "Was intra-tenant cross-project rules-tampering; now closed. orgId was always bound, so this was never cross-tenant.",
    evidence: [
      { file: "src/modules/build/core/automation/projects-automations.controller.ts", line: 107, anchor: /update\(/, note: "handler binds both projectId and automationId and forwards both to the service" },
      { file: "src/modules/build/core/automation/projects-automations.controller.ts", line: 113, anchor: /return this\.automations\.updateAutomation\(u, projectId, automationId, body\);/, note: "projectId is passed into the service call" },
      { file: "src/modules/build/core/automation/projects-automations.service.ts", line: 128, anchor: /await assertCanManageProject\(this\.db, this\.access, u, projectId\);/, note: "authorizes the caller against the named projectId only — this can be a project-scoped standing" },
      { file: "src/modules/build/core/automation/projects-automations.service.ts", line: 61, anchor: /eq\(projectAutomations\.projectId, projectId\),/, note: "fix: the UPDATE's WHERE now re-binds projectId, so a foreign automationId 404s" },
    ],
  },
  {
    key: "modules/build/core/automation/projects-automations.controller.ts#delete",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/automations/:automationId. Identical defect shape to #update, now fixed the same way: the DELETE's WHERE clause is bound to id+orgId+projectId, so a project-scoped manager of one project can no longer destroy another project's automation by guessing its id.",
    blastRadius:
      "Was intra-tenant cross-project deletion, non-recoverable through the API; now closed. orgId was always bound, so this was never cross-tenant.",
    evidence: [
      { file: "src/modules/build/core/automation/projects-automations.controller.ts", line: 121, anchor: /delete\(/, note: "handler binds both projectId and automationId and forwards both to the service" },
      { file: "src/modules/build/core/automation/projects-automations.controller.ts", line: 126, anchor: /return this\.automations\.deleteAutomation\(u, projectId, automationId\);/, note: "projectId is passed into the service call" },
      { file: "src/modules/build/core/automation/projects-automations.service.ts", line: 128, anchor: /await assertCanManageProject\(this\.db, this\.access, u, projectId\);/, note: "authorizes the caller against the named projectId only — this can be a project-scoped standing" },
      { file: "src/modules/build/core/automation/projects-automations.service.ts", line: 139, anchor: /eq\(projectAutomations\.projectId, projectId\),/, note: "fix: the DELETE's WHERE now re-binds projectId, so a foreign automationId 404s" },
    ],
  },

  // ── core/projects-custom-fields.controller.ts ───────────────────────────────
  {
    key: "modules/build/core/custom-fields/projects-custom-fields.controller.ts#getTicketValues",
    verdict: "CLOSED",
    finding: "ticket-data-scope-missing",
    summary:
      "GET /build/:projectId/tickets/:ticketId/custom-field-values. Closed: getTicketValues calls assertTicketReadAccess before querying values. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope; the values query then remains scoped to ticketId+orgId.",
    blastRadius:
      "None: an inaccessible or mismatched ticket is rejected before any custom-field value is read.",
    evidence: [
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.controller.ts", line: 90, anchor: /getTicketValues\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts", line: 174, anchor: /async getTicketValues\(u: CurrentUserContext, projectId: number, ticketId: number\) \{/, note: "the terminal service receives the authenticated actor and route ids" },
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts", line: 175, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "canonical ticket authorization runs before the values query" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 341, anchor: /eq\(tickets\.projectId, projectId\),/, note: "tenant, project, and ticket are bound in one lookup" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 349, anchor: /if \(decision\.kind === "denied"\) throw new ForbiddenException\("Ticket is outside your access scope"\);/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/custom-fields/projects-custom-fields.controller.ts#upsertTicketValues",
    verdict: "CLOSED",
    finding: "ticket-data-scope-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/custom-field-values. Closed: upsertTicketValues calls assertTicketReadAccess before validating field definitions or writing values. The helper enforces tenant, project membership, URL binding, and ticket DataScope; assertFieldDefinitionsInProject separately binds every body field id to the same project.",
    blastRadius:
      "None: an inaccessible or mismatched ticket is rejected before validation or mutation, and foreign field definitions are rejected separately.",
    evidence: [
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.controller.ts", line: 103, anchor: /upsertTicketValues\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts", line: 231, anchor: /async upsertTicketValues\(/, note: "the terminal service receives the authenticated actor and route ids" },
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts", line: 237, anchor: /await assertTicketWriteAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "canonical ticket authorization runs before validation or mutation" },
      { file: "src/modules/build/core/custom-fields/projects-custom-fields.service.ts", line: 242, anchor: /await this\.assertFieldDefinitionsInProject\(/, note: "body field ids are independently bound to the same project" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 349, anchor: /if \(decision\.kind === "denied"\) throw new ForbiddenException\("Ticket is outside your access scope"\);/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },

  // ── core/projects-ticket-associations.controller.ts ─────────────────────────
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#listRelations",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/relations. ProjectsTicketRelationsService.listRelations(u, projectId, ticketId) opens with assertTicketReadAccess(db, access, u, projectId, ticketId), whose SELECT WHERE binds tickets.orgId=actor.orgId AND tickets.projectId=projectId AND tickets.id=ticketId together and 404s if no row matches, before any relation is queried.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at assertTicketReadAccess before any relation row is read.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 89, anchor: /listRelations\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-relations.service.ts", line: 59, anchor: /async listRelations\(/, note: "signature" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 341, anchor: /eq\(tickets\.projectId, projectId\),/, note: "assertTicketReadAccess binds orgId+projectId+ticketId together; 404 (via NotFoundException) on mismatch" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#addRelation",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/relations. addRelation(u, projectId, ticketId, body) also opens with assertTicketReadAccess(db, access, u, projectId, ticketId) (id+orgId+projectId bound, 404 on mismatch), and separately re-verifies that body.relatedTicketId belongs to the same projectId+orgId before inserting the relation row.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketReadAccess, and a relatedTicketId from a different project independently 404s (\"Related ticket not found in this project\") before the INSERT runs.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 102, anchor: /addRelation\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-relations.service.ts", line: 138, anchor: /await assertTicketWriteAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId" },
      { file: "src/modules/build/core/tickets/projects-ticket-relations.service.ts", line: 147, anchor: /eq\(tickets\.projectId, projectId\),/, note: "relatedTicketId is independently bound to the same project before the relation is created" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#removeRelation",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/relations. removeRelation(u, projectId, ticketId, relatedId) opens with the same assertTicketReadAccess binding (id+orgId+projectId, 404 on mismatch) before deleting the workItemRelations edge, which is itself scoped to orgId and to the (already-verified) ticketId on either side of the edge.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketReadAccess before the DELETE runs; a wrong relatedId simply matches zero rows rather than deleting anything cross-tenant.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 116, anchor: /removeRelation\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-relations.service.ts", line: 249, anchor: /async removeRelation\(/, note: "signature" },
      { file: "src/modules/build/core/tickets/projects-ticket-relations.service.ts", line: 255, anchor: /await assertTicketWriteAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before the delete" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#removeLabel",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/labels/:labelId. ProjectsTicketLabelsService.removeTicketLabel receives the actor and calls assertTicketReadAccess before deleting the tenant-scoped mapping. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope.",
    blastRadius:
      "None: a mismatched ticket 404s, while an inaccessible project or ticket scope is rejected before the label mapping is deleted.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 183, anchor: /removeLabel\(/, note: "handler binds projectId, ticketId and labelId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-labels.service.ts", line: 48, anchor: /await assertTicketWriteAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "actor-aware authorization runs before deletion" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 349, anchor: /if \(decision\.kind === "denied"\) throw new ForbiddenException\("Ticket is outside your access scope"\);/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#getGitLinks",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/git-links. ProjectsTicketLinksService.getGitLinks receives the actor and calls assertTicketReadAccess first, so tenant, project membership, route binding, and ticket DataScope are established before git links are queried.",
    blastRadius:
      "None: an inaccessible or mismatched ticket is rejected before any git link row is read.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 210, anchor: /getGitLinks\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 41, anchor: /await this\.assertTicketAccess\(u, projectId, ticketId\);/, note: "actor-aware authorization runs before the git link query" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 37, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "the private guard is the canonical ticket decision" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 349, anchor: /if \(decision\.kind === "denied"\) throw new ForbiddenException\("Ticket is outside your access scope"\);/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#updateRelatedLink",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/related-links/:linkId. ProjectsTicketLinksService.updateRelatedLink(u, projectId, ticketId, linkId, body) opens with assertTicketAccess (which wraps assertTicketReadAccess: id+orgId+projectId bound, 404 on mismatch), then both the SELECT and the UPDATE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId — the already-verified ticketId is repeated in the mutation's own WHERE, not just the pre-check.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketAccess, and the UPDATE's own WHERE independently requires ticketId=ticketId, so a linkId belonging to a different ticket/project also 404s.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 248, anchor: /updateRelatedLink\(/, note: "handler binds projectId, ticketId and linkId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 169, anchor: /async updateRelatedLink\(/, note: "signature" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 176, anchor: /await this\.assertTicketAccess\(u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before any read or write" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-associations.controller.ts#deleteRelatedLink",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/related-links/:linkId. Same shape as updateRelatedLink: deleteRelatedLink(u, projectId, ticketId, linkId) opens with assertTicketAccess (id+orgId+projectId bound, 404 on mismatch), then both the ownership SELECT and the DELETE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketAccess, and the DELETE's own WHERE independently requires ticketId=ticketId.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-associations.controller.ts", line: 263, anchor: /deleteRelatedLink\(/, note: "handler binds projectId, ticketId and linkId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 210, anchor: /async deleteRelatedLink\(/, note: "signature" },
      { file: "src/modules/build/core/tickets/projects-ticket-links.service.ts", line: 216, anchor: /await this\.assertTicketAccess\(u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before any read or write" },
    ],
  },

  // ── core/projects-ticket-checklists.controller.ts ───────────────────────────
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#getChecklists",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/checklists. ProjectsTicketChecklistsService.getChecklists receives the actor and calls assertTicketReadAccess, which binds the ticket to projectId+orgId and enforces project membership and ticket DataScope before checklist rows are read.",
    blastRadius:
      "None: tenant, project membership, route binding, and ticket DataScope are enforced before any checklist is read.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.controller.ts", line: 48, anchor: /getChecklists\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 91, anchor: /await this\.requireTicketAccess\(u, projectId, ticketId\);/, note: "actor-aware project and DataScope authorization runs first" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 69, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "the private guard is the canonical ticket decision" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 341, anchor: /eq\(tickets\.projectId, projectId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-checklists.controller.ts#createChecklist",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/checklists. ProjectsTicketChecklistsService.createChecklist receives the actor and calls assertTicketReadAccess, which binds ticketId to projectId+orgId before the checklist is inserted.",
    blastRadius:
      "None: tenant, project membership, route binding, and ticket DataScope are enforced before any checklist is created.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.controller.ts", line: 61, anchor: /createChecklist\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 127, anchor: /await this\.requireTicketAccess\(u, projectId, ticketId\);/, note: "actor-aware project and DataScope authorization runs first" },
      { file: "src/modules/build/core/tickets/projects-ticket-checklists.service.ts", line: 69, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "the private guard is the canonical ticket decision" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 341, anchor: /eq\(tickets\.projectId, projectId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },

  // ── core/projects-ticket-comments.controller.ts ─────────────────────────────
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#getComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/comments/:commentId. getComment calls resolveTicketForComment, which applies assertTicketReadAccess before loading the comment by id+ticketId+orgId. Tenant, project membership, route binding, ticket DataScope, and comment-to-ticket binding are all enforced.",
    blastRadius:
      "None: an inaccessible or mismatched ticket is rejected before the comment is read, and a comment from another ticket cannot match.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 66, anchor: /getComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 224, anchor: /async getComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number\) \{/, note: "signature carries the authenticated actor and route parents" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 225, anchor: /await this\.resolveTicketForComment\(u, projectId, ticketId, "read"\);/, note: "actor-aware ticket authorization runs before the comment lookup" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 114, anchor: /eq\(ticketComments\.ticketId, ticketId\),/, note: "the comment lookup binds commentId to ticketId+orgId" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#editComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/comments/:commentId. editComment first applies actor-aware ticket authorization through resolveTicketForComment, then binds the comment to id+ticketId+orgId, verifies author ownership, and updates the already-verified row.",
    blastRadius:
      "None: project membership, ticket DataScope, route binding, comment-to-ticket binding, and authorship are enforced before the update.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 79, anchor: /editComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 231, anchor: /async editComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, content: string\) \{/, note: "signature carries the authenticated actor and route parents" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 232, anchor: /await this\.resolveTicketForComment\(u, projectId, ticketId, "write"\);/, note: "actor-aware ticket authorization runs before the comment lookup" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 237, anchor: /eq\(ticketComments\.ticketId, ticketId\),/, note: "the comment lookup binds commentId to ticketId+orgId" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#deleteComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/comments/:commentId. deleteComment first applies actor-aware ticket authorization through resolveTicketForComment, then binds the comment to id+ticketId+orgId, verifies author ownership, and soft-deletes it and its replies within the tenant.",
    blastRadius:
      "None: project membership, ticket DataScope, route binding, comment-to-ticket binding, and authorship are enforced before deletion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 94, anchor: /deleteComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 260, anchor: /async deleteComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number\) \{/, note: "signature carries the authenticated actor and route parents" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 261, anchor: /await this\.resolveTicketForComment\(u, projectId, ticketId, "write"\);/, note: "actor-aware ticket authorization runs before the comment lookup" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 266, anchor: /eq\(ticketComments\.ticketId, ticketId\),/, note: "the comment lookup binds commentId to ticketId+orgId" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#addReaction",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/comments/:commentId/reactions. Closed: the handler forwards the authenticated actor plus every route id straight to ProjectsTicketCommentsService, which calls assertTicketReadAccess before binding the comment to ticketId+orgId and inserting the actor's membership-scoped reaction.",
    blastRadius:
      "None: tenant, project membership, route binding, ticket DataScope, comment binding, and organization membership are enforced before insertion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 123, anchor: /addReaction\(/, note: "handler declares every route parent" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 130, anchor: /return this\.comments\.addReaction\(u, projectId, ticketId, commentId, body\.emoji\);/, note: "the actor and route ids are forwarded together" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 305, anchor: /async addReaction\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, emoji: string\) \{/, note: "terminal implementation receives the actor" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 307, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced before the comment lookup" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-ticket-comments.controller.ts#removeReaction",
    verdict: "CLOSED",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji. Closed: the handler forwards the authenticated actor plus every route id straight to ProjectsTicketCommentsService, which applies assertTicketReadAccess before binding the comment and deleting only the actor membership's tenant-scoped reaction.",
    blastRadius:
      "None: tenant, project membership, route binding, ticket DataScope, comment binding, and reaction ownership are enforced before deletion.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 138, anchor: /removeReaction\(/, note: "handler declares every route parent" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.controller.ts", line: 145, anchor: /return this\.comments\.removeReaction\(u, projectId, ticketId, commentId, decodeURIComponent\(emoji\)\);/, note: "the actor and route ids are forwarded together" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 328, anchor: /async removeReaction\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, emoji: string\) \{/, note: "terminal implementation receives the actor" },
      { file: "src/modules/build/core/tickets/projects-ticket-comments.service.ts", line: 330, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "project membership and ticket DataScope are enforced before the comment lookup" },
    ],
  },

  // ── core/projects-tickets.controller.ts ─────────────────────────────────────
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#rankTicket",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/rank. The controller forwards to ProjectsTicketsService.rankTicket → the standalone rankTicket() helper in projects-tickets-rank-utils.ts. That helper authorizes and locks against the named projectId, reads the mutation candidates via readMutationTickets(tx, actor, projectId, ids, policy), and — decisively — the final UPDATE itself binds `eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), eq(tickets.id, ticketId)` all together, throwing NotFoundException if no row matches. The mutation, not just a pre-check, re-asserts the parent binding.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s directly at the final UPDATE's WHERE clause, which independently requires projectId=projectId.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets.controller.ts", line: 198, anchor: /rankTicket\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-tickets-rank-utils.ts", line: 50, anchor: /export async function rankTicket\(/, note: "signature takes projectId" },
      { file: "src/modules/build/core/tickets/projects-tickets-rank-utils.ts", line: 155, anchor: /\.set\(\{ rank: rankValue, status, updatedAt: now \}\)/, note: "this is the mutation, not a pre-check" },
      { file: "src/modules/build/core/tickets/projects-tickets-rank-utils.ts", line: 158, anchor: /eq\(tickets\.orgId, actor\.orgId\), eq\(tickets\.projectId, projectId\), eq\(tickets\.id, ticketId\), isNull\(tickets\.deletedAt\),/, note: "the actual UPDATE's WHERE binds orgId+projectId+id together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#getActivity",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/activity. The controller forwards the actor and both route ids to ProjectsTicketsQueryService.getTicketActivity, which calls assertTicketReadAccess before querying activity. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at assertTicketReadAccess before any activity is read.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets.controller.ts", line: 211, anchor: /getActivity\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/tickets/projects-tickets-query.service.ts", line: 122, anchor: /async getTicketActivity\(/, note: "signature carries the actor and route ids" },
      { file: "src/modules/build/core/tickets/projects-tickets-query.service.ts", line: 128, anchor: /await assertTicketReadAccess\(this\.db, this\.access, actor, projectId, ticketId\);/, note: "canonical ticket authorization runs before the activity query" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 341, anchor: /eq\(tickets\.projectId, projectId\),/, note: "assertTicketReadAccess binds orgId+projectId+id together; 404 on mismatch" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 349, anchor: /if \(decision\.kind === "denied"\) throw new ForbiddenException\("Ticket is outside your access scope"\);/, note: "project membership and ticket DataScope are both enforced" },
    ],
  },
  {
    key: "modules/build/core/tickets/projects-tickets.controller.ts#getTicketByKey",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/key/:ticketNumber. getTicketByKey passes a projectId+ticketNumber selector into readTicket; readTicket adds orgId, resolves ticket DataScope, and verifies project membership before returning the ticket.",
    blastRadius:
      "None: tenant, project membership, composite key binding, and ticket DataScope are enforced before the record is returned.",
    evidence: [
      { file: "src/modules/build/core/tickets/projects-tickets.controller.ts", line: 227, anchor: /getTicketByKey\(/, note: "handler binds both projectId and ticketNumber and forwards both" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 35, anchor: /async getTicketByKey\(/, note: "signature" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 44, anchor: /eq\(tickets\.projectId, projectId\),/, note: "selector binds the lookup to the named project" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 63, anchor: /const read = await resolveTicketsScope\(this\.access, u\);/, note: "ticket DataScope is resolved" },
      { file: "src/modules/build/core/tickets/projects-tickets-detail.service.ts", line: 108, anchor: /const decision = await decideTicketRead\(this\.db, this\.access, u, ticket\.id, \{ projectId \}\);/, note: "project membership is verified" },
    ],
  },

  // ── core/projects-webhooks.controller.ts ────────────────────────────────────
  {
    key: "modules/build/core/webhooks/projects-webhooks.controller.ts#listDeliveries",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/webhooks/:webhookId/deliveries. ProjectsWebhooksService.listDeliveries(actor, projectId, webhookId) runs assertProjectVisible (404 when the caller does not reach the project) and then assertWebhookOwnership(orgId, projectId, webhookId), whose WHERE binds id=webhookId AND orgId=orgId AND projectId=projectId together and 404s on mismatch, before querying webhookDeliveries filtered by the already-verified webhookId.",
    blastRadius:
      "None: a webhookId belonging to a different project 404s at assertWebhookOwnership before any delivery row is read.",
    evidence: [
      { file: "src/modules/build/core/webhooks/projects-webhooks.controller.ts", line: 97, anchor: /listDeliveries\(/, note: "handler binds both projectId and webhookId and forwards both" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 314, anchor: /async listDeliveries\(actor: CurrentUserContext, projectId: number, webhookId: number\) \{/, note: "signature takes the actor and projectId" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 252, anchor: /private async assertWebhookOwnership\(/, note: "ownership check binds id+orgId+projectId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/webhooks/projects-webhooks.controller.ts#sendTest",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/webhooks/:webhookId/test. ProjectsWebhooksService.sendTest(actor, projectId, webhookId) runs assertCanManageProject, then assertWebhookOwnership(orgId, projectId, webhookId) (id+orgId+projectId bound, 404 on mismatch) BEFORE calling `this.dispatch.sendTest(orgId, projectId, webhookId)`. Belt-and-suspenders: sendTest's own SELECT independently re-binds id=webhookId AND orgId=orgId AND projectId=projectId and returns a no-op failure result if the row is absent.",
    blastRadius:
      "None: a webhookId belonging to a different project 404s at the controller-level assertWebhookOwnership call before dispatch.sendTest is even invoked, and sendTest's own query independently re-verifies the same binding.",
    evidence: [
      { file: "src/modules/build/core/webhooks/projects-webhooks.controller.ts", line: 112, anchor: /return this\.webhooks\.sendTest\(u, projectId, webhookId\);/, note: "handler binds both projectId and webhookId and forwards the actor" },
      { file: "src/modules/build/core/webhooks/projects-webhooks.service.ts", line: 279, anchor: /await this\.assertWebhookOwnership\(actor\.orgId, projectId, webhookId\);/, note: "ownership check runs after the manage decision and before dispatch.sendTest" },
      { file: "src/modules/build/core/webhooks/projects-webhooks-dispatch.service.ts", line: 133, anchor: /async sendTest\(/, note: "signature" },
    ],
  },

  // ── execution/iterations.controller.ts ──────────────────────────────────────
  {
    key: "modules/build/execution/iterations.controller.ts#updateCycle",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/cycles/:cycleId. CyclesService.updateCycle(orgId, projectId, cycleId, input) confirms the project exists in this org, then the actual UPDATE's WHERE binds `eq(cycles.id, cycleId), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)` directly — the mutation itself, not just a pre-check, requires the cycle to belong to the named project.",
    blastRadius:
      "None: a cycleId belonging to a different project 404s directly at the UPDATE's own WHERE clause.",
    evidence: [
      { file: "src/modules/build/execution/iterations.controller.ts", line: 188, anchor: /updateCycle\(/, note: "handler binds both projectId and cycleId and forwards both" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 202, anchor: /async updateCycle\(/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 247, anchor: /\.where\(and\(eq\(cycles\.id, cycleId\), eq\(cycles\.projectId, projectId\), eq\(cycles\.orgId, orgId\), eq\(cycles\.version, before\.version\)\)\)/, note: "UPDATE's own WHERE binds id+projectId+orgId" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#deleteCycle",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/cycles/:cycleId. Same shape as updateCycle: CyclesService.deleteCycle(orgId, projectId, cycleId) confirms the project exists in this org, then the DELETE's own WHERE binds `eq(cycles.id, cycleId), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)` directly, 404ing if zero rows are removed.",
    blastRadius:
      "None: a cycleId belonging to a different project 404s directly at the DELETE's own WHERE clause.",
    evidence: [
      { file: "src/modules/build/execution/iterations.controller.ts", line: 202, anchor: /deleteCycle\(/, note: "handler binds both projectId and cycleId and forwards both" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 281, anchor: /async deleteCycle\(actor: CurrentUserContext, projectId: number, cycleId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 290, anchor: /\.where\(and\(eq\(cycles\.id, cycleId\), eq\(cycles\.projectId, projectId\), eq\(cycles\.orgId, orgId\)\)\)/, note: "DELETE's own WHERE binds id+projectId+orgId" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#updateEpic",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/epics/:epicId. EpicsService.updateEpic(orgId, projectId, epicId, input) runs the UPDATE directly with WHERE `eq(tickets.id, epicId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), eq(tickets.type, \"EPIC\")` — the mutation itself binds the epic to the named project, no separate pre-check needed.",
    blastRadius:
      "None: an epicId belonging to a different project 404s directly at the UPDATE's own WHERE clause.",
    evidence: [
      { file: "src/modules/build/execution/iterations.controller.ts", line: 304, anchor: /updateEpic\(/, note: "handler binds both projectId and epicId and forwards both" },
      { file: "src/modules/build/execution/epics.service.ts", line: 129, anchor: /async updateEpic\(u: CurrentUserContext, projectId: number, epicId: number, input: UpdateEpicInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/epics.service.ts", line: 131, anchor: /eq\(tickets\.id, epicId\),/, note: "UPDATE's own WHERE binds id+orgId+projectId+type" },
    ],
  },
  {
    key: "modules/build/execution/iterations.controller.ts#deleteEpic",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/epics/:epicId. EpicsService.deleteEpic(orgId, projectId, epicId) first looks up the epic bound to id+orgId+projectId+type=EPIC (404 if absent), then deletes it by id+orgId — epicId is a global PK already proven by the preceding lookup to belong to this exact project, so the narrower delete key is still safe (verify-then-act-by-PK).",
    blastRadius:
      "None: an epicId belonging to a different project 404s at the existence check before the DELETE runs.",
    evidence: [
      { file: "src/modules/build/execution/iterations.controller.ts", line: 318, anchor: /deleteEpic\(/, note: "handler binds both projectId and epicId and forwards both" },
      { file: "src/modules/build/execution/epics.service.ts", line: 159, anchor: /async deleteEpic\(actor: CurrentUserContext, projectId: number, epicId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/epics.service.ts", line: 131, anchor: /eq\(tickets\.id, epicId\),/, note: "existence check binds id+orgId+projectId+type; 404 on mismatch" },
    ],
  },

  // ── execution/whiteboard-sharing.controller.ts ──────────────────────────────
  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#updateSharing",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/whiteboards/:whiteboardId/sharing. WhiteboardSharingService.updateSharing(u, projectId, whiteboardId, input) opens with requireWhiteboardManageAccess(db, access, u, projectId, whiteboardId), whose SELECT WHERE binds `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)` together and 404s on mismatch, before the sharing settings are updated by the already-verified id+orgId.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at requireWhiteboardManageAccess before any sharing setting is changed.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.controller.ts", line: 61, anchor: /updateSharing\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 46, anchor: /const board = await requireWhiteboardManageAccess\(this\.db, this\.access, u, projectId, whiteboardId\);/, note: "binds whiteboardId to this projectId+orgId before any mutation" },
      { file: "src/modules/build/execution/whiteboard-board-helpers.ts", line: 40, anchor: /export async function requireWhiteboardManageAccess\(/, note: "signature takes projectId; its WHERE (a few lines below) binds id+projectId+orgId, 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#rotateShareToken",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token. Same requireWhiteboardManageAccess binding as updateSharing (id+projectId+orgId, 404 on mismatch) before the share token is rotated by the already-verified id+orgId.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at requireWhiteboardManageAccess before the token is rotated.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.controller.ts", line: 76, anchor: /rotateShareToken\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 84, anchor: /await requireWhiteboardManageAccess\(this\.db, this\.access, u, projectId, whiteboardId\);/, note: "binds whiteboardId to this projectId+orgId before rotating the token" },
    ],
  },
  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#setShares",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PUT /build/:projectId/whiteboards/:whiteboardId/shares. Same requireWhiteboardManageAccess binding (id+projectId+orgId, 404 on mismatch) before the whiteboard's share rows are replaced; the replace transaction itself is scoped to the already-verified whiteboardId.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at requireWhiteboardManageAccess before any share row is touched.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.controller.ts", line: 88, anchor: /setShares\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 108, anchor: /const board = await requireWhiteboardManageAccess\(this\.db, this\.access, u, projectId, whiteboardId\);/, note: "binds whiteboardId to this projectId+orgId before the share rows are replaced" },
    ],
  },
  {
    key: "modules/build/execution/whiteboard-sharing.controller.ts#removeShare",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId. Same requireWhiteboardManageAccess binding (id+projectId+orgId, 404 on mismatch) before the share row for targetUserId is removed; the DELETE itself is scoped to the already-verified whiteboardId and to a membership subquery scoped to u.orgId.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at requireWhiteboardManageAccess before the DELETE runs.",
    evidence: [
      { file: "src/modules/build/execution/whiteboard-sharing.controller.ts", line: 102, anchor: /removeShare\(/, note: "handler binds projectId, whiteboardId and targetUserId and forwards all three" },
      { file: "src/modules/build/execution/whiteboard-sharing.service.ts", line: 174, anchor: /await requireWhiteboardManageAccess\(this\.db, this\.access, u, projectId, whiteboardId\);/, note: "binds whiteboardId to this projectId+orgId before the delete" },
    ],
  },

  // ── execution/workspace.controller.ts ───────────────────────────────────────
  {
    key: "modules/build/execution/workspace.controller.ts#getWhiteboard",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/whiteboards/:whiteboardId. WhiteboardsService.getWhiteboard(u, projectId, whiteboardId) confirms the project exists in this org, then loadBoardWithAccess's SELECT WHERE binds `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)` together and throws NotFoundException on mismatch, before the DTO is built.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at loadBoardWithAccess before any board data is returned.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 349, anchor: /getWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 242, anchor: /async getWhiteboard\(u: CurrentUserContext, projectId: number, whiteboardId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 74, anchor: /private async loadBoardWithAccess\(/, note: "private helper's WHERE (a few lines below) binds id+projectId+orgId together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#updateWhiteboard",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/whiteboards/:whiteboardId. WhiteboardsService.updateWhiteboard(u, projectId, whiteboardId, input) calls loadBoardWithAccess (id+projectId+orgId, 404 on mismatch) for the access-level check, and the subsequent UPDATE independently repeats the identical binding in its own WHERE: `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)`.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at loadBoardWithAccess, and the UPDATE's own WHERE independently re-asserts the same binding.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 375, anchor: /updateWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 269, anchor: /async updateWhiteboard\(/, note: "signature" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 293, anchor: /eq\(projectWhiteboards\.id, whiteboardId\),/, note: "the UPDATE's own WHERE re-binds id+projectId+orgId" },
    ],
  },
  {
    key: "modules/build/execution/workspace.controller.ts#deleteWhiteboard",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/whiteboards/:whiteboardId. Same shape as updateWhiteboard: deleteWhiteboard(u, projectId, whiteboardId) calls loadBoardWithAccess (id+projectId+orgId, 404 on mismatch), and the soft-delete UPDATE independently repeats the identical id+projectId+orgId binding in its own WHERE.",
    blastRadius:
      "None: a whiteboardId belonging to a different project 404s at loadBoardWithAccess, and the UPDATE's own WHERE independently re-asserts the same binding.",
    evidence: [
      { file: "src/modules/build/execution/workspace.controller.ts", line: 375, anchor: /deleteWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 306, anchor: /async deleteWhiteboard\(u: CurrentUserContext, projectId: number, whiteboardId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 320, anchor: /eq\(projectWhiteboards\.id, whiteboardId\),/, note: "the soft-delete UPDATE's own WHERE re-binds id+projectId+orgId" },
    ],
  },

  // ── files/files.controller.ts ────────────────────────────────────────────────
  {
    key: "modules/build/files/files.controller.ts#getSignedUrl",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/files/:fileId/url. FilesService.getSignedUrl(u, projectId, fileId) confirms project access, then loadFile(orgId, projectId, fileId) binds id=fileId AND orgId=orgId AND projectId=projectId together (404 on mismatch) before the signed URL is generated from the already-verified row's storageKey.",
    blastRadius:
      "None: a fileId belonging to a different project 404s at loadFile before any signed URL is issued.",
    evidence: [
      { file: "src/modules/build/files/files.controller.ts", line: 77, anchor: /getSignedUrl\(/, note: "handler binds both projectId and fileId and forwards both" },
      { file: "src/modules/build/files/files.service.ts", line: 167, anchor: /async getSignedUrl\(u: CurrentUserContext, projectId: number, fileId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/files/files.service.ts", line: 64, anchor: /private async loadFile\(orgId: string, projectId: number, fileId: number\) \{/, note: "loadFile's WHERE (a few lines below) binds id+orgId+projectId together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/files/files.controller.ts#softDeleteFile",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/files/:fileId. FilesService.softDeleteFile(u, projectId, fileId) also opens with loadFile(orgId, projectId, fileId) (id+orgId+projectId bound, 404 on mismatch), checks uploader/manage authority, and the soft-delete UPDATE independently repeats the identical id+orgId+projectId binding in its own WHERE.",
    blastRadius:
      "None: a fileId belonging to a different project 404s at loadFile, and the UPDATE's own WHERE independently re-asserts the same binding.",
    evidence: [
      { file: "src/modules/build/files/files.controller.ts", line: 90, anchor: /softDeleteFile\(/, note: "handler binds both projectId and fileId and forwards both" },
      { file: "src/modules/build/files/files.service.ts", line: 174, anchor: /async softDeleteFile\(u: CurrentUserContext, projectId: number, fileId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/files/files.service.ts", line: 189, anchor: /eq\(projectAttachments\.id, fileId\),/, note: "the soft-delete UPDATE's own WHERE re-binds id+orgId+projectId" },
    ],
  },

  // ── forms/forms.controller.ts ────────────────────────────────────────────────
  {
    key: "modules/build/forms/forms.controller.ts#getForm",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/forms/:formId. FormsService.getForm(u, projectId, formId) delegates directly to loadForm(orgId, projectId, formId), whose WHERE binds id=formId AND orgId=orgId AND projectId=projectId together and throws NotFoundException on mismatch.",
    blastRadius:
      "None: a formId belonging to a different project 404s at loadForm before any form data is returned.",
    evidence: [
      { file: "src/modules/build/forms/forms.controller.ts", line: 58, anchor: /getForm\(/, note: "handler binds both projectId and formId and forwards both" },
      { file: "src/modules/build/forms/forms.service.ts", line: 101, anchor: /async getForm\(u: CurrentUserContext, projectId: number, formId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 39, anchor: /private async loadForm\(orgId: string, projectId: number, formId: number\): Promise<FormRow> \{/, note: "loadForm's WHERE (a few lines below) binds id+orgId+projectId together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/forms/forms.controller.ts#updateForm",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/forms/:formId. FormsService.updateForm(u, projectId, formId, input) opens with loadForm(orgId, projectId, formId) (id+orgId+projectId bound, 404 on mismatch) before building the patch and running the UPDATE keyed by the now-verified id+orgId (formId is a global PK already proven to belong to this exact project — verify-then-act-by-PK).",
    blastRadius:
      "None: a formId belonging to a different project 404s at loadForm before the patch is built or the UPDATE runs.",
    evidence: [
      { file: "src/modules/build/forms/forms.controller.ts", line: 83, anchor: /updateForm\(/, note: "handler binds both projectId and formId and forwards both" },
      { file: "src/modules/build/forms/forms.service.ts", line: 143, anchor: /async updateForm\(u: CurrentUserContext, projectId: number, formId: number, input: UpdateFormInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 145, anchor: /const existing = await this\.loadForm\(u\.orgId, projectId, formId\);/, note: "binds id+orgId+projectId; 404 on mismatch before any patch logic runs" },
    ],
  },
  {
    key: "modules/build/forms/forms.controller.ts#deleteForm",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/forms/:formId. Same shape as updateForm: FormsService.deleteForm(u, projectId, formId) opens with loadForm(orgId, projectId, formId) (id+orgId+projectId bound, 404 on mismatch) before the soft-delete UPDATE keyed by the now-verified id+orgId.",
    blastRadius:
      "None: a formId belonging to a different project 404s at loadForm before the soft-delete UPDATE runs.",
    evidence: [
      { file: "src/modules/build/forms/forms.controller.ts", line: 97, anchor: /deleteForm\(/, note: "handler binds both projectId and formId and forwards both" },
      { file: "src/modules/build/forms/forms.service.ts", line: 182, anchor: /async deleteForm\(u: CurrentUserContext, projectId: number, formId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 184, anchor: /await this\.loadForm\(u\.orgId, projectId, formId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the delete" },
    ],
  },
];
