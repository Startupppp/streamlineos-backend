export default [
  {
    key: "modules/build/client-portal/change-request-affected-items.controller.ts#listAffectedTickets",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "GET /build/:projectId/change-requests/:changeRequestId/affected-tickets. ChangeRequestAffectedItemsService.listAffectedTickets opens with ChangeRequestsService.getChangeRequest(u, projectId, changeRequestId), which asserts project access and binds the change request row to id+orgId+projectId, 404 otherwise. Only after that does it query changeRequestAffectedItems, itself filtered by orgId+changeRequestId — a changeRequestId already proven to belong to this exact project.",
    blastRadius:
      "None: a changeRequestId belonging to a different project 404s at getChangeRequest before any affected-item row is read.",
    evidence: [
      { file: "src/modules/build/client-portal/change-request-affected-items.service.ts", line: 68, anchor: /await this\.changeRequests\.getChangeRequest\(u, projectId, changeRequestId\);/, note: "binds the change request to id+orgId+projectId; 404 on mismatch" },
      { file: "src/modules/build/client-portal/change-requests.service.ts", line: 166, anchor: /eq\(changeRequests\.projectId, projectId\),/, note: "getChangeRequest's own WHERE re-binds projectId" },
    ],
  },
  {
    key: "modules/build/client-portal/change-request-affected-items.controller.ts#linkTicket",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "POST /build/:projectId/change-requests/:changeRequestId/affected-tickets. Same getChangeRequest binding as listAffectedTickets, plus a second parent check: the target ticket (from the body, not the URL) is looked up by id+orgId and its own projectId is compared against the URL's projectId (`ticket.projectId !== projectId`), 404 on mismatch — so a caller cannot link a ticket from a different project into this change request either.",
    blastRadius:
      "None: both the change request and the ticket must genuinely belong to the URL's project, or the call 404s before any row is written.",
    evidence: [
      { file: "src/modules/build/client-portal/change-request-affected-items.service.ts", line: 118, anchor: /await this\.changeRequests\.getChangeRequest\(u, projectId, changeRequestId\);/, note: "binds the change request to id+orgId+projectId; 404 on mismatch" },
      { file: "src/modules/build/client-portal/change-request-affected-items.service.ts", line: 125, anchor: /if \(!ticket \|\| ticket\.projectId !== projectId\) \{/, note: "explicit compare: the body-supplied ticketId must belong to this exact project too" },
    ],
  },
  {
    key: "modules/build/client-portal/change-request-affected-items.controller.ts#unlinkTicket",
    verdict: "VERIFIED",
    finding: "parent-binding-verified",
    summary:
      "DELETE /build/:projectId/change-requests/:changeRequestId/affected-tickets/:affectedItemId. Same getChangeRequest binding as the other two handlers, then the affected-item row itself is looked up bound to id+orgId+changeRequestId — a changeRequestId already proven to belong to this exact project — before the delete proceeds.",
    blastRadius:
      "None: a changeRequestId belonging to a different project 404s at getChangeRequest, and an affectedItemId belonging to a different change request 404s at the follow-up lookup, before any row is deleted.",
    evidence: [
      { file: "src/modules/build/client-portal/change-request-affected-items.service.ts", line: 170, anchor: /await this\.changeRequests\.getChangeRequest\(u, projectId, changeRequestId\);/, note: "binds the change request to id+orgId+projectId; 404 on mismatch" },
      { file: "src/modules/build/client-portal/change-request-affected-items.service.ts", line: 179, anchor: /eq\(changeRequestAffectedItems\.changeRequestId, changeRequestId\),/, note: "the affected-item lookup re-binds changeRequestId, itself already proven project-scoped" },
    ],
  },
];
