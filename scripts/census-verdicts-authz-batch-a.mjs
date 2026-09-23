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
// Result: 47 VERIFIED, 4 VULNERABLE (both projects-automations.controller.ts
// mutating handlers, and both projects-ticket-comments.controller.ts reaction
// handlers). See the VULNERABLE entries below for full narrative + blast radius.

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
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 100, anchor: /getApproval\(/, note: "handler binds both projectId and approvalId route params and forwards both" },
      { file: "src/modules/build/approvals/approvals-read.service.ts", line: 77, anchor: /return loadApproval\(this\.db, u\.orgId, projectId, approvalId\);/, note: "projectId is passed into loadApproval alongside approvalId and orgId" },
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
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 127, anchor: /decideApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 162, anchor: /const approval = await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "first statement binds id+orgId+projectId; 404 on mismatch before any further logic" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 182, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\)/, note: "mutation keyed by already-verified PK+org" },
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
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 140, anchor: /updateApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 204, anchor: /await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the patch is built" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 222, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\)/, note: "UPDATE keyed by the already-verified PK" },
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
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 154, anchor: /softDeleteApproval\(/, note: "handler binds both projectId and approvalId and forwards both" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 260, anchor: /await loadApproval\(this\.db, orgId, projectId, approvalId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the delete" },
      { file: "src/modules/build/approvals/approvals.service.ts", line: 264, anchor: /\.where\(and\(eq\(projectApprovals\.id, approvalId\), eq\(projectApprovals\.orgId, orgId\), isNull\(projectApprovals\.deletedAt\)\)\);/, note: "soft-delete UPDATE keyed by the already-verified PK" },
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
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 72, anchor: /getChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 139, anchor: /async getChangeRequest\(u: CurrentUserContext, projectId: number, crId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 146, anchor: /eq\(changeRequests\.id, crId\),/, note: "SELECT WHERE binds id+orgId+projectId together (see surrounding and(...))" },
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
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 97, anchor: /updateChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 229, anchor: /eq\(changeRequests\.id, crId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 283, anchor: /eq\(changeRequests\.id, crId\),/, note: "the UPDATE's own WHERE re-binds id+orgId+projectId" },
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
      { file: "src/modules/build/client-portal/change-requests.controller.ts", line: 111, anchor: /deleteChangeRequest\(/, note: "handler binds both projectId and changeRequestId and forwards both" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 321, anchor: /eq\(changeRequests\.id, crId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 334, anchor: /eq\(changeRequests\.id, crId\),/, note: "soft-delete UPDATE re-binds id+orgId+projectId" },
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
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 53, anchor: /toggleTicketVisibility\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 52, anchor: /eq\(tickets\.id, ticketId\), eq\(tickets\.orgId, orgId\), eq\(tickets\.projectId, projectId\), isNull\(tickets\.deletedAt\)/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 59, anchor: /\.where\(and\(eq\(tickets\.id, ticketId\), eq\(tickets\.orgId, orgId\)\)\);/, note: "UPDATE keyed by the already-verified PK" },
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
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 66, anchor: /toggleMilestoneVisibility\(/, note: "handler binds both projectId and milestoneId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 74, anchor: /eq\(projectMilestones\.id, milestoneId\),/, note: "existence check binds id+orgId+projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 85, anchor: /\.where\(and\(eq\(projectMilestones\.id, milestoneId\), eq\(projectMilestones\.orgId, orgId\)\)\);/, note: "UPDATE keyed by the already-verified PK" },
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
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 79, anchor: /toggleCommentVisibility\(/, note: "handler binds both projectId and commentId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 101, anchor: /\.innerJoin\(tickets, and\(/, note: "join binds the comment's ticket to the named project via tickets.projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 113, anchor: /\.where\(and\(eq\(ticketComments\.id, commentId\), eq\(ticketComments\.orgId, orgId\)\)\);/, note: "UPDATE keyed by the already-verified PK" },
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
      { file: "src/modules/build/client-portal/client-visibility.controller.ts", line: 92, anchor: /toggleAttachmentVisibility\(/, note: "handler binds both projectId and attachmentId and forwards both" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 125, anchor: /async toggleAttachmentVisibility\(orgId: string, userId: string, projectId: number, attachmentId: number, clientVisible: boolean\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/client-portal/client-visibility.service.ts", line: 131, anchor: /eq\(tickets\.projectId, projectId\),/, note: "join binds the attachment's ticket to the named project" },
    ],
  },

  // ── core/project-resources.controller.ts ────────────────────────────────────
  {
    key: "modules/build/core/project-resources.controller.ts#updateMemberRole",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/members/:memberUserId. ProjectsMembersService.updateMemberRole(projectId, memberUserId, input, u) calls assertProjectOwnership(orgId, projectId) (404 unless the project belongs to this org) and assertCanManageProject(u, projectId) before resolving memberUserId to a membership via assertOrganizationActor(db, orgId, {userId}), which itself only resolves memberships that belong to orgId. The UPDATE then runs where(projectMembers.projectId=projectId AND projectMembers.membershipId=targetActor.membershipId) — both sides of that predicate are already tenant/project-verified by the time the query runs, and the update 404s (NotFoundException) if the target actor is not actually a member of this specific project.",
    blastRadius:
      "None cross-tenant, and none cross-project either: the UPDATE's own WHERE requires the target membership to be a member of this exact :projectId, so a memberUserId who is only a member of a different project in the same org gets 404, not a role change.",
    evidence: [
      { file: "src/modules/build/core/project-resources.controller.ts", line: 123, anchor: /updateMemberRole\(/, note: "handler binds both projectId and memberUserId and forwards both" },
      { file: "src/modules/build/core/projects-members.service.ts", line: 359, anchor: /await assertProjectOwnership\(this\.db, orgId, projectId\);/, note: "confirms projectId belongs to this org, 404 otherwise" },
      { file: "src/modules/build/core/projects-members.service.ts", line: 361, anchor: /const targetActor = await assertOrganizationActor\(this\.db, orgId, \{ kind: "user", userId: memberUserId \}\);/, note: "resolves the target membership scoped to this org" },
      { file: "src/modules/build/core/projects-members.service.ts", line: 368, anchor: /eq\(projectMembers\.projectId, projectId\),/, note: "UPDATE's WHERE requires the target membership to belong to this exact project; 404 otherwise" },
    ],
  },

  // ── core/projects-automations.controller.ts ─────────────────────────────────
  {
    key: "modules/build/core/projects-automations.controller.ts#update",
    verdict: "VULNERABLE",
    finding: "parent-binding-missing",
    summary:
      "PATCH /build/:projectId/automations/:automationId. The controller binds projectId and automationId and calls ProjectsAutomationsService.updateAutomation(u, projectId, automationId, data). The method calls this.members.assertCanManageProject(u, projectId), which authorizes the caller against the NAMED :projectId (org owner, OR org-wide build:manage, OR the caller's own project.managerMembershipId, OR the caller holding role 'ADMIN' in projectMembers for THAT project) — but the actual mutation, `update(projectAutomations).where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, u.orgId)))`, never repeats eq(projectAutomations.projectId, projectId). A caller whose only standing is project-scoped (project.managerMembershipId or a projectMembers ADMIN role on project A — i.e. no org-wide build:manage) passes assertCanManageProject for their OWN project A, and can then supply any other project's automationId in the same org: the UPDATE matches on id+orgId alone and silently rewrites (or, in delete, destroys) an automation that belongs to a project the caller has no standing over. This is the same shape as the CLOSED projects-custom-fields.controller.ts#updateField finding: an authority check against the URL's :projectId that the actual mutation's WHERE clause never repeats.",
    blastRadius:
      "Intra-tenant, not cross-tenant: orgId is still bound, so the mutation cannot leave the organisation. But it breaks the 404 contract for a foreign :automationId and lets a project-scoped manager (one without org-wide build:manage) silently edit trigger/condition/action logic on automations belonging to ANY other project in the same org — a rules-tampering and business-logic-integrity issue for every other project team.",
    evidence: [
      { file: "src/modules/build/core/projects-automations.controller.ts", line: 60, anchor: /update\(/, note: "handler binds both projectId and automationId and forwards both to the service" },
      { file: "src/modules/build/core/projects-automations.controller.ts", line: 66, anchor: /return this\.automations\.updateAutomation\(u, projectId, automationId, body\);/, note: "projectId is passed into the service call" },
      { file: "src/modules/build/core/projects-automations.service.ts", line: 81, anchor: /await this\.members\.assertCanManageProject\(u, projectId\);/, note: "authorizes the caller against the named projectId only — this can be a project-scoped standing" },
      { file: "src/modules/build/core/projects-automations.service.ts", line: 88, anchor: /\.where\(and\(eq\(projectAutomations\.id, automationId\), eq\(projectAutomations\.orgId, u\.orgId\)\)\)/, note: "the actual UPDATE's WHERE omits projectId entirely — any automation in the org matches" },
      { file: "src/modules/build/core/projects-members.service.ts", line: 91, anchor: /if \(membership\[0\]\?\.role === "ADMIN"\) return;/, note: "assertCanManageProject accepts a per-project ADMIN standing, not only org-wide build:manage — confirming the caller's authority can be strictly project-scoped" },
    ],
  },
  {
    key: "modules/build/core/projects-automations.controller.ts#delete",
    verdict: "VULNERABLE",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/automations/:automationId. Identical defect shape to #update: ProjectsAutomationsService.deleteAutomation(u, projectId, automationId) calls assertCanManageProject(u, projectId) — which can be satisfied by project-scoped authority over the NAMED project alone — but the actual DELETE, `delete(projectAutomations).where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, u.orgId)))`, never re-binds projectId. A project-scoped manager of project A can delete any automation in the org by ID, regardless of which project it actually belongs to.",
    blastRadius:
      "Intra-tenant, not cross-tenant: orgId is still bound. A project-scoped manager (project.managerMembershipId or a projectMembers ADMIN role on their own project, without org-wide build:manage) can permanently destroy any other project's automation rules in the same org by guessing/enumerating automationId — worse than the update case, since deletion is not recoverable through the API.",
    evidence: [
      { file: "src/modules/build/core/projects-automations.controller.ts", line: 74, anchor: /delete\(/, note: "handler binds both projectId and automationId and forwards both to the service" },
      { file: "src/modules/build/core/projects-automations.controller.ts", line: 79, anchor: /return this\.automations\.deleteAutomation\(u, projectId, automationId\);/, note: "projectId is passed into the service call" },
      { file: "src/modules/build/core/projects-automations.service.ts", line: 95, anchor: /await this\.members\.assertCanManageProject\(u, projectId\);/, note: "authorizes the caller against the named projectId only — this can be a project-scoped standing" },
      { file: "src/modules/build/core/projects-automations.service.ts", line: 98, anchor: /\.where\(and\(eq\(projectAutomations\.id, automationId\), eq\(projectAutomations\.orgId, u\.orgId\)\)\)/, note: "the actual DELETE's WHERE omits projectId entirely — any automation in the org matches" },
    ],
  },

  // ── core/projects-custom-fields.controller.ts ───────────────────────────────
  {
    key: "modules/build/core/projects-custom-fields.controller.ts#getTicketValues",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/custom-field-values. ProjectsCustomFieldsService.getTicketValues(orgId, projectId, ticketId) first looks up the ticket bound to id=ticketId AND projectId=projectId AND orgId=orgId (404 if absent), then reads ticketCustomFieldValues filtered by ticketId+orgId — ticketId is a global PK already proven by the preceding lookup to belong to this exact project, so the narrower filter on the values query is still safe.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the ticket lookup before any custom-field values are read.",
    evidence: [
      { file: "src/modules/build/core/projects-custom-fields.controller.ts", line: 90, anchor: /getTicketValues\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-custom-fields.service.ts", line: 145, anchor: /async getTicketValues\(orgId: string, projectId: number, ticketId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-custom-fields.service.ts", line: 149, anchor: /eq\(tickets\.projectId, projectId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-custom-fields.controller.ts#upsertTicketValues",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/custom-field-values. Same route-parent binding as getTicketValues: upsertTicketValues(orgId, projectId, ticketId, data) looks up the ticket bound to id+projectId+orgId (404 if absent) before writing any values, so the :projectId/:ticketId route-param claim under review here is genuinely enforced. Separately noted for follow-up, outside this route-binding question: the insert trusts each body-supplied values[].fieldId as-is (`fieldDefinitionId: fieldId`) with no lookup confirming that field id belongs to customFieldDefinitions scoped to this org/project — that is a body-payload object-reference gap, not a URL parent-binding gap, and is not one of the findings in scope for this census dimension, but is worth a follow-up pass.",
    blastRadius:
      "None for the route-parent-binding claim under review: a ticketId belonging to a different project 404s at the ticket lookup before any value is written. (The separately-noted body-fieldId gap is a distinct, not-yet-scoped issue with its own blast radius that a future pass should size.)",
    evidence: [
      { file: "src/modules/build/core/projects-custom-fields.controller.ts", line: 103, anchor: /upsertTicketValues\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-custom-fields.service.ts", line: 210, anchor: /async upsertTicketValues\(/, note: "signature; the ticket lookup a few lines below binds id+projectId+orgId identically to getTicketValues, 404 on mismatch" },
    ],
  },

  // ── core/projects-ticket-associations.controller.ts ─────────────────────────
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#listRelations",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/relations. ProjectsTicketRelationsService.listRelations(u, projectId, ticketId) opens with assertTicketReadAccess(db, access, u, projectId, ticketId), whose SELECT WHERE binds tickets.orgId=actor.orgId AND tickets.projectId=projectId AND tickets.id=ticketId together and 404s if no row matches, before any relation is queried.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at assertTicketReadAccess before any relation row is read.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 79, anchor: /listRelations\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-relations.service.ts", line: 56, anchor: /async listRelations\(/, note: "signature" },
      { file: "src/modules/build/core/build-ticket-read-access.ts", line: 37, anchor: /eq\(tickets\.projectId, projectId\),/, note: "assertTicketReadAccess binds orgId+projectId+ticketId together; 404 (via NotFoundException) on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#addRelation",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/relations. addRelation(u, projectId, ticketId, body) also opens with assertTicketReadAccess(db, access, u, projectId, ticketId) (id+orgId+projectId bound, 404 on mismatch), and separately re-verifies that body.relatedTicketId belongs to the same projectId+orgId before inserting the relation row.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketReadAccess, and a relatedTicketId from a different project independently 404s (\"Related ticket not found in this project\") before the INSERT runs.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 92, anchor: /addRelation\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-relations.service.ts", line: 130, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId" },
      { file: "src/modules/build/core/projects-ticket-relations.service.ts", line: 139, anchor: /eq\(tickets\.projectId, projectId\),/, note: "relatedTicketId is independently bound to the same project before the relation is created" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#removeRelation",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/relations. removeRelation(u, projectId, ticketId, relatedId) opens with the same assertTicketReadAccess binding (id+orgId+projectId, 404 on mismatch) before deleting the workItemRelations edge, which is itself scoped to orgId and to the (already-verified) ticketId on either side of the edge.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketReadAccess before the DELETE runs; a wrong relatedId simply matches zero rows rather than deleting anything cross-tenant.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 106, anchor: /removeRelation\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-relations.service.ts", line: 210, anchor: /async removeRelation\(/, note: "signature" },
      { file: "src/modules/build/core/projects-ticket-relations.service.ts", line: 216, anchor: /await assertTicketReadAccess\(this\.db, this\.access, u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before the delete" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#removeLabel",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/labels/:labelId. ProjectsTicketSubresourcesService.removeLabel(orgId, userId, projectId, ticketId, labelId) opens with the private requireTicket(orgId, projectId, ticketId) helper, whose WHERE binds id+projectId+orgId together and 404s on mismatch, before deleting the ticketLabelMappings row (itself scoped to the already-verified ticketId+orgId).",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at requireTicket before the label mapping is deleted.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 173, anchor: /removeLabel\(/, note: "handler binds projectId, ticketId and labelId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-subresources.service.ts", line: 416, anchor: /await this\.requireTicket\(orgId, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId; 404 on mismatch" },
      { file: "src/modules/build/core/projects-ticket-subresources.service.ts", line: 271, anchor: /eq\(tickets\.projectId, projectId\),/, note: "requireTicket's WHERE clause binds id+projectId+orgId" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#getGitLinks",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/git-links. ProjectsTicketLinksService.getGitLinks(orgId, projectId, ticketId) first confirms the project exists in this org, then looks up the ticket bound to id=ticketId AND projectId=projectId AND orgId=orgId (404 if absent), before querying gitTicketLinks filtered by the already-verified ticketId+orgId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the ticket lookup before any git link row is read.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 200, anchor: /getGitLinks\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 41, anchor: /async getGitLinks\(orgId: string, projectId: number, ticketId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 50, anchor: /eq\(tickets\.id, ticketId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#updateRelatedLink",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/related-links/:linkId. ProjectsTicketLinksService.updateRelatedLink(u, projectId, ticketId, linkId, body) opens with assertTicketAccess (which wraps assertTicketReadAccess: id+orgId+projectId bound, 404 on mismatch), then both the SELECT and the UPDATE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId — the already-verified ticketId is repeated in the mutation's own WHERE, not just the pre-check.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketAccess, and the UPDATE's own WHERE independently requires ticketId=ticketId, so a linkId belonging to a different ticket/project also 404s.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 238, anchor: /updateRelatedLink\(/, note: "handler binds projectId, ticketId and linkId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 163, anchor: /async updateRelatedLink\(/, note: "signature" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 170, anchor: /await this\.assertTicketAccess\(u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before any read or write" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-associations.controller.ts#deleteRelatedLink",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/related-links/:linkId. Same shape as updateRelatedLink: deleteRelatedLink(u, projectId, ticketId, linkId) opens with assertTicketAccess (id+orgId+projectId bound, 404 on mismatch), then both the ownership SELECT and the DELETE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId.",
    blastRadius:
      "None: a foreign :ticketId 404s at assertTicketAccess, and the DELETE's own WHERE independently requires ticketId=ticketId.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-associations.controller.ts", line: 253, anchor: /deleteRelatedLink\(/, note: "handler binds projectId, ticketId and linkId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 205, anchor: /async deleteRelatedLink\(/, note: "signature" },
      { file: "src/modules/build/core/projects-ticket-links.service.ts", line: 211, anchor: /await this\.assertTicketAccess\(u, projectId, ticketId\);/, note: "binds ticketId to this projectId+orgId before any read or write" },
    ],
  },

  // ── core/projects-ticket-checklists.controller.ts ───────────────────────────
  {
    key: "modules/build/core/projects-ticket-checklists.controller.ts#getChecklists",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/checklists. ProjectsTicketChecklistsService.getChecklists(orgId, projectId, ticketId) first looks up the ticket bound to id=ticketId AND projectId=projectId AND orgId=orgId (404 if absent), before querying ticketChecklists filtered by the already-verified ticketId+orgId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the ticket lookup before any checklist is read.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-checklists.controller.ts", line: 48, anchor: /getChecklists\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-checklists.service.ts", line: 57, anchor: /async getChecklists\(orgId: string, projectId: number, ticketId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-ticket-checklists.service.ts", line: 61, anchor: /eq\(tickets\.projectId, projectId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-checklists.controller.ts#createChecklist",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/tickets/:ticketId/checklists. createChecklist(orgId, projectId, ticketId, data) performs the identical ticket lookup as getChecklists (id+projectId+orgId bound, 404 if absent) before inserting the new checklist row against the already-verified ticketId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the ticket lookup before any checklist is created.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-checklists.controller.ts", line: 61, anchor: /createChecklist\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-checklists.service.ts", line: 92, anchor: /async createChecklist\(/, note: "signature" },
      { file: "src/modules/build/core/projects-ticket-checklists.service.ts", line: 101, anchor: /eq\(tickets\.projectId, projectId\),/, note: "ticket lookup binds id+projectId+orgId; 404 on mismatch" },
    ],
  },

  // ── core/projects-ticket-comments.controller.ts ─────────────────────────────
  {
    key: "modules/build/core/projects-ticket-comments.controller.ts#getComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/comments/:commentId. ProjectsTicketCommentsService.getComment(u, projectId, ticketId, commentId) resolves the ticket by id+orgId via resolveTicketForComment, reads ticket.projectId, and immediately compares it against the route's projectId — `if (ticket.projectId !== projectId) throw new NotFoundException(...)` — an explicit parent-binding check, not an inferred one. Only after that passes does loadCommentRow bind the comment to id=commentId AND ticketId=ticketId AND orgId=orgId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the explicit projectId comparison before the comment is read.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 63, anchor: /getComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 204, anchor: /async getComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 206, anchor: /if \(ticket\.projectId !== projectId\) throw new NotFoundException\("Ticket not found"\);/, note: "explicit parent-binding compare, 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-comments.controller.ts#editComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/comments/:commentId. Same explicit-compare pattern as getComment: editComment(u, projectId, ticketId, commentId, content) resolves the ticket and checks `if (ticket.projectId !== projectId) throw new NotFoundException(...)` before loading the comment bound to id+ticketId+orgId, checking author ownership, and finally updating it by id+orgId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the explicit projectId comparison before the comment is loaded or edited.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 76, anchor: /editComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 212, anchor: /async editComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number, content: string\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 214, anchor: /if \(ticket\.projectId !== projectId\) throw new NotFoundException\("Ticket not found"\);/, note: "explicit parent-binding compare, 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-comments.controller.ts#deleteComment",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/comments/:commentId. Same explicit-compare pattern: deleteComment(u, projectId, ticketId, commentId) resolves the ticket and checks `if (ticket.projectId !== projectId) throw new NotFoundException(...)` before loading the comment (id+ticketId+orgId), checking author ownership, and soft-deleting it (and its replies) by id/parentCommentId+orgId.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at the explicit projectId comparison before the comment is loaded or deleted.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 91, anchor: /deleteComment\(/, note: "handler binds projectId, ticketId and commentId and forwards all three" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 242, anchor: /async deleteComment\(u: CurrentUserContext, projectId: number, ticketId: number, commentId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 244, anchor: /if \(ticket\.projectId !== projectId\) throw new NotFoundException\("Ticket not found"\);/, note: "explicit parent-binding compare, 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-comments.controller.ts#addReaction",
    verdict: "VULNERABLE",
    finding: "parent-binding-missing",
    summary:
      "POST /build/:projectId/tickets/:ticketId/comments/:commentId/reactions. Unlike its siblings getComment/editComment/deleteComment on the same controller, the addReaction handler's parameter list is `addReaction(@Param(\"ticketId\") ticketId, @Param(\"commentId\") commentId, @Body() body, @CurrentUser() u)` — there is no `@Param(\"projectId\")` at all. @Validate({ params: projectIdticketIdcommentIdParams_ }) still requires the :projectId segment to be present and non-empty in the URL (so the route 400s if it is missing), but the handler never reads the value it validated, and never passes it to the service. The call chain — controller → ProjectsTicketSubresourcesService.addReaction(commentId, userId, orgId, emoji, membershipId, ticketId) → ProjectsTicketCommentsService.addReaction — carries no projectId parameter anywhere; the service's own WHERE binds only `eq(ticketComments.id, commentId), eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId)`, with no ticket→project check at all (not even the explicit compare that getComment/editComment/deleteComment use). This is a stronger version of the CLOSED updateField pattern: it is not merely that the mutation's WHERE omits projectId — the :projectId segment is discarded before the service boundary and never reconstructed anywhere downstream.",
    blastRadius:
      "Intra-tenant, not cross-tenant: orgId is still bound to the comment lookup, so a reaction cannot be written against another organisation's data. But any caller holding build:tickets:update permission can add or remove an emoji reaction on ANY comment on ANY ticket in the org — regardless of which project the URL names or which project the comment's ticket actually belongs to — by supplying a real ticketId/commentId pair from a different project alongside an arbitrary (even unrelated) :projectId they do have access to. Breaks the 404 contract for a foreign ticket/project pairing and lets a caller reach comment threads on projects they otherwise have no route into.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 105, anchor: /addReaction\(/, note: "handler's parameter list has no @Param(\"projectId\") at all, even though the route and its @Validate params schema both name :projectId" },
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 111, anchor: /return this\.subresources\.addReaction\(commentId, u\.userId, u\.orgId, body\.emoji, actingMembershipId\(u\.principal\), ticketId\);/, note: "call into the service carries no projectId argument" },
      { file: "src/modules/build/core/projects-ticket-subresources.service.ts", line: 120, anchor: /addReaction\(/, note: "facade method signature also has no projectId parameter" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 279, anchor: /async addReaction\(commentId: number, userId: string, orgId: string, emoji: string, membershipId: number \| null, ticketId: number\) \{/, note: "terminal implementation's signature has no projectId parameter; its WHERE below binds only id+ticketId+orgId with no ticket-to-project check" },
    ],
  },
  {
    key: "modules/build/core/projects-ticket-comments.controller.ts#removeReaction",
    verdict: "VULNERABLE",
    finding: "parent-binding-missing",
    summary:
      "DELETE /build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji. Identical defect shape to addReaction: `removeReaction(@Param(\"ticketId\") ticketId, @Param(\"commentId\") commentId, @Param(\"emoji\") emoji, @CurrentUser() u)` has no @Param(\"projectId\"), even though @Validate({ params: projectIdticketIdcommentIdemojiParams }) requires :projectId to be present in the URL. The value is validated for presence and then discarded — never read, never forwarded. ProjectsTicketCommentsService.removeReaction(commentId, userId, orgId, emoji, membershipId, ticketId) binds only id+ticketId+orgId when looking up the comment before deleting the reaction row; there is no ticket-to-project check anywhere in the chain.",
    blastRadius:
      "Intra-tenant, not cross-tenant: orgId is still bound. Any caller holding build:tickets:update can remove any reaction from any comment on any ticket in the org regardless of the named :projectId, by supplying a real ticketId/commentId from a different project. Breaks the 404 contract for a foreign ticket/project pairing.",
    evidence: [
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 119, anchor: /removeReaction\(/, note: "handler's parameter list has no @Param(\"projectId\") at all, even though the route and its @Validate params schema both name :projectId" },
      { file: "src/modules/build/core/projects-ticket-comments.controller.ts", line: 125, anchor: /return this\.subresources\.removeReaction\(commentId, u\.userId, u\.orgId, decodeURIComponent\(emoji\), actingMembershipId\(u\.principal\), ticketId\);/, note: "call into the service carries no projectId argument" },
      { file: "src/modules/build/core/projects-ticket-subresources.service.ts", line: 138, anchor: /removeReaction\(/, note: "facade method signature also has no projectId parameter" },
      { file: "src/modules/build/core/projects-ticket-comments.service.ts", line: 299, anchor: /async removeReaction\(commentId: number, userId: string, orgId: string, emoji: string, membershipId: number \| null, ticketId: number\) \{/, note: "terminal implementation's signature has no projectId parameter; its WHERE below binds only id+ticketId+orgId with no ticket-to-project check" },
    ],
  },

  // ── core/projects-tickets.controller.ts ─────────────────────────────────────
  {
    key: "modules/build/core/projects-tickets.controller.ts#rankTicket",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "PATCH /build/:projectId/tickets/:ticketId/rank. The controller forwards to ProjectsTicketsService.rankTicket → the standalone rankTicket() helper in projects-tickets-rank-utils.ts. That helper authorizes and locks against the named projectId, reads the mutation candidates via readMutationTickets(tx, actor, projectId, ids, policy), and — decisively — the final UPDATE itself binds `eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), eq(tickets.id, ticketId)` all together, throwing NotFoundException if no row matches. The mutation, not just a pre-check, re-asserts the parent binding.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s directly at the final UPDATE's WHERE clause, which independently requires projectId=projectId.",
    evidence: [
      { file: "src/modules/build/core/projects-tickets.controller.ts", line: 177, anchor: /rankTicket\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-tickets-rank-utils.ts", line: 26, anchor: /export async function rankTicket\(db: Db, cache: CacheService, access: AccessService, actor: CurrentUserContext, projectId: number, ticketId: number, body: RankTicketInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-tickets-rank-utils.ts", line: 70, anchor: /eq\(tickets\.orgId, actor\.orgId\), eq\(tickets\.projectId, projectId\), eq\(tickets\.id, ticketId\), isNull\(tickets\.deletedAt\)/, note: "the actual UPDATE's WHERE binds orgId+projectId+id together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-tickets.controller.ts#getActivity",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/:ticketId/activity. The controller forwards to ProjectsTicketSubresourcesService.getActivity(u, projectId, ticketId, opts), which opens with assertTicketReadAccess(db, access, actor, projectId, ticketId) — the same helper used throughout the associations/relations/links services — whose SELECT WHERE binds orgId+projectId+id together and 404s (NotFoundException) on mismatch, before any activity log row is queried.",
    blastRadius:
      "None: a ticketId belonging to a different project 404s at assertTicketReadAccess before any activity is read.",
    evidence: [
      { file: "src/modules/build/core/projects-tickets.controller.ts", line: 190, anchor: /getActivity\(/, note: "handler binds both projectId and ticketId and forwards both" },
      { file: "src/modules/build/core/projects-ticket-subresources.service.ts", line: 160, anchor: /async getActivity\(/, note: "signature" },
      { file: "src/modules/build/core/build-ticket-read-access.ts", line: 37, anchor: /eq\(tickets\.projectId, projectId\),/, note: "assertTicketReadAccess binds orgId+projectId+id together; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-tickets.controller.ts#getTicketByKey",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/tickets/key/:ticketNumber. ProjectsTicketsDetailService.getTicketByKey(u, projectId, ticketNumber) calls the shared readTicket helper with a selector of `eq(tickets.projectId, projectId), eq(tickets.ticketNumber, ticketNumber)`, and readTicket's own findFirst WHERE additionally ANDs in `eq(tickets.orgId, u.orgId), isNull(tickets.deletedAt)`. The ticket is only ever resolved by the composite projectId+ticketNumber+orgId key.",
    blastRadius:
      "None: a ticketNumber that exists in a different project (ticket numbers are only unique per-project) resolves to no row for this org+project combination, so the route 404s rather than returning the wrong project's ticket.",
    evidence: [
      { file: "src/modules/build/core/projects-tickets.controller.ts", line: 206, anchor: /getTicketByKey\(/, note: "handler binds both projectId and ticketNumber and forwards both" },
      { file: "src/modules/build/core/projects-tickets-detail.service.ts", line: 32, anchor: /async getTicketByKey\(/, note: "signature" },
      { file: "src/modules/build/core/projects-tickets-detail.service.ts", line: 40, anchor: /eq\(tickets\.projectId, projectId\),/, note: "selector binds the lookup to the named project" },
    ],
  },

  // ── core/projects-webhooks.controller.ts ────────────────────────────────────
  {
    key: "modules/build/core/projects-webhooks.controller.ts#listDeliveries",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/webhooks/:webhookId/deliveries. ProjectsWebhooksService.listDeliveries(orgId, projectId, webhookId) opens with assertWebhookOwnership(orgId, projectId, webhookId), whose WHERE binds id=webhookId AND orgId=orgId AND projectId=projectId together and 404s on mismatch, before querying webhookDeliveries filtered by the already-verified webhookId.",
    blastRadius:
      "None: a webhookId belonging to a different project 404s at assertWebhookOwnership before any delivery row is read.",
    evidence: [
      { file: "src/modules/build/core/projects-webhooks.controller.ts", line: 76, anchor: /listDeliveries\(/, note: "handler binds both projectId and webhookId and forwards both" },
      { file: "src/modules/build/core/projects-webhooks.service.ts", line: 83, anchor: /async listDeliveries\(orgId: string, projectId: number, webhookId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/core/projects-webhooks.service.ts", line: 68, anchor: /async assertWebhookOwnership\(orgId: string, projectId: number, webhookId: number\): Promise<void> \{/, note: "ownership check binds id+orgId+projectId; 404 on mismatch" },
    ],
  },
  {
    key: "modules/build/core/projects-webhooks.controller.ts#sendTest",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/webhooks/:webhookId/test. The controller itself calls `await this.webhooks.assertWebhookOwnership(u.orgId, projectId, webhookId)` (id+orgId+projectId bound, 404 on mismatch) BEFORE calling `this.dispatch.sendTest(u.orgId, projectId, webhookId)`. Belt-and-suspenders: sendTest's own SELECT independently re-binds id=webhookId AND orgId=orgId AND projectId=projectId and returns a no-op failure result if the row is absent.",
    blastRadius:
      "None: a webhookId belonging to a different project 404s at the controller-level assertWebhookOwnership call before dispatch.sendTest is even invoked, and sendTest's own query independently re-verifies the same binding.",
    evidence: [
      { file: "src/modules/build/core/projects-webhooks.controller.ts", line: 90, anchor: /async sendTest\(/, note: "handler binds both projectId and webhookId" },
      { file: "src/modules/build/core/projects-webhooks.controller.ts", line: 95, anchor: /await this\.webhooks\.assertWebhookOwnership\(u\.orgId, projectId, webhookId\);/, note: "controller-level ownership check runs before dispatch.sendTest" },
      { file: "src/modules/build/core/projects-webhooks-dispatch.service.ts", line: 311, anchor: /async sendTest\(/, note: "signature" },
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
      { file: "src/modules/build/execution/iterations.controller.ts", line: 167, anchor: /updateCycle\(/, note: "handler binds both projectId and cycleId and forwards both" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 109, anchor: /async updateCycle\(orgId: string, projectId: number, cycleId: number, input: UpdateCycleInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 127, anchor: /\.where\(and\(eq\(cycles\.id, cycleId\), eq\(cycles\.projectId, projectId\), eq\(cycles\.orgId, orgId\)\)\)/, note: "UPDATE's own WHERE binds id+projectId+orgId" },
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
      { file: "src/modules/build/execution/iterations.controller.ts", line: 181, anchor: /deleteCycle\(/, note: "handler binds both projectId and cycleId and forwards both" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 134, anchor: /async deleteCycle\(orgId: string, projectId: number, cycleId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/cycles.service.ts", line: 140, anchor: /\.where\(and\(eq\(cycles\.id, cycleId\), eq\(cycles\.projectId, projectId\), eq\(cycles\.orgId, orgId\)\)\)/, note: "DELETE's own WHERE binds id+projectId+orgId" },
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
      { file: "src/modules/build/execution/iterations.controller.ts", line: 281, anchor: /updateEpic\(/, note: "handler binds both projectId and epicId and forwards both" },
      { file: "src/modules/build/execution/epics.service.ts", line: 61, anchor: /async updateEpic\(orgId: string, projectId: number, epicId: number, input: UpdateEpicInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/epics.service.ts", line: 67, anchor: /eq\(tickets\.id, epicId\),/, note: "UPDATE's own WHERE binds id+orgId+projectId+type" },
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
      { file: "src/modules/build/execution/iterations.controller.ts", line: 295, anchor: /deleteEpic\(/, note: "handler binds both projectId and epicId and forwards both" },
      { file: "src/modules/build/execution/epics.service.ts", line: 78, anchor: /async deleteEpic\(orgId: string, projectId: number, epicId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/epics.service.ts", line: 81, anchor: /eq\(tickets\.id, epicId\),/, note: "existence check binds id+orgId+projectId+type; 404 on mismatch" },
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
      { file: "src/modules/build/execution/whiteboard-board-helpers.ts", line: 46, anchor: /export async function requireWhiteboardManageAccess\(/, note: "signature takes projectId; its WHERE (a few lines below) binds id+projectId+orgId, 404 on mismatch" },
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
      { file: "src/modules/build/execution/workspace.controller.ts", line: 323, anchor: /getWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 202, anchor: /async getWhiteboard\(u: CurrentUserContext, projectId: number, whiteboardId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 64, anchor: /private async loadBoardWithAccess\(/, note: "private helper's WHERE (a few lines below) binds id+projectId+orgId together; 404 on mismatch" },
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
      { file: "src/modules/build/execution/workspace.controller.ts", line: 335, anchor: /updateWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 229, anchor: /async updateWhiteboard\(/, note: "signature" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 253, anchor: /eq\(projectWhiteboards\.id, whiteboardId\),/, note: "the UPDATE's own WHERE re-binds id+projectId+orgId" },
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
      { file: "src/modules/build/execution/workspace.controller.ts", line: 349, anchor: /deleteWhiteboard\(/, note: "handler binds both projectId and whiteboardId and forwards both" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 266, anchor: /async deleteWhiteboard\(u: CurrentUserContext, projectId: number, whiteboardId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/execution/whiteboards.service.ts", line: 280, anchor: /eq\(projectWhiteboards\.id, whiteboardId\),/, note: "the soft-delete UPDATE's own WHERE re-binds id+projectId+orgId" },
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
      { file: "src/modules/build/files/files.service.ts", line: 188, anchor: /eq\(projectAttachments\.id, fileId\),/, note: "the soft-delete UPDATE's own WHERE re-binds id+orgId+projectId" },
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
      { file: "src/modules/build/forms/forms.service.ts", line: 72, anchor: /async getForm\(u: CurrentUserContext, projectId: number, formId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 24, anchor: /private async loadForm\(orgId: string, projectId: number, formId: number\): Promise<FormRow> \{/, note: "loadForm's WHERE (a few lines below) binds id+orgId+projectId together; 404 on mismatch" },
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
      { file: "src/modules/build/forms/forms.service.ts", line: 113, anchor: /async updateForm\(u: CurrentUserContext, projectId: number, formId: number, input: UpdateFormInput\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 114, anchor: /const existing = await this\.loadForm\(u\.orgId, projectId, formId\);/, note: "binds id+orgId+projectId; 404 on mismatch before any patch logic runs" },
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
      { file: "src/modules/build/forms/forms.service.ts", line: 151, anchor: /async deleteForm\(u: CurrentUserContext, projectId: number, formId: number\) \{/, note: "signature takes projectId" },
      { file: "src/modules/build/forms/forms.service.ts", line: 152, anchor: /await this\.loadForm\(u\.orgId, projectId, formId\);/, note: "binds id+orgId+projectId; 404 on mismatch before the delete" },
    ],
  },
];
