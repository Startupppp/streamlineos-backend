export default [
  {
    key: "modules/build/approvals/approvals.controller.ts#getInbox",
    verdict: "VERIFIED",
    finding: "project-relationship-not-applicable",
    projectRelationshipExempt:
      "lists only approvals assigned to the caller's acting membership; assignment is the relationship authorizeApprovalDecision honours without project reach",
    summary:
      "GET /build/approvals/inbox. Every row is bound to approverMembershipId = the caller's acting membership in the caller's org, and only pending or escalated rows are listed. Approvers are any active org member chosen by a requester with project write access, not necessarily project members, and authorizeApprovalDecision deliberately lets the assigned approver decide without project reach. Filtering the inbox by project reach would hide approvals the caller is entitled and expected to act on, so the assignment, not project reach, is the relationship this read rests on. A caller with no acting membership gets an empty page before any query runs.",
    blastRadius:
      "The title, project name and key of approvals the caller was explicitly named to decide; nothing about other approvals or other projects.",
    evidence: [
      { file: "src/modules/build/approvals/approvals.controller.ts", line: 75, anchor: /return this\.reads\.getInbox\(u\.orgId, mid, query\);/, note: "the acting membership from the authenticated principal reaches the read" },
      { file: "src/modules/build/approvals/approvals-read.service.ts", line: 82, anchor: /pendingApprovalsForActorCondition\(orgId, membershipId\),/, note: "the inbox predicate is the per-approver condition" },
      { file: "src/modules/build/approvals/build-inbox-count.service.ts", line: 13, anchor: /eq\(projectApprovals\.approverMembershipId, membershipId\),/, note: "rows are bound to the caller as the assigned approver" },
      { file: "src/modules/build/core/project-crud/project-access.ts", line: 479, anchor: /if \(!assigned && !hasAccess\) throw new ForbiddenException/, note: "the decision path lets the assigned approver act without project reach" },
    ],
  },
];
