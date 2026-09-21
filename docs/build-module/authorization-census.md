# Build module — authorization census

GENERATED FILE. Do not hand-edit. Regenerate with `pnpm check:build-authz-census`; the generator is `scripts/build-authorization-census.mjs`.

Scope: every `*.controller.ts` under `src/modules/build/`. 47 controller files, 321 HTTP handlers.

## Counts

| classification | handlers |
| --- | --- |
| VULNERABLE | 0 |
| CLOSED-IN-FLIGHT | 0 |
| NEEDS-REVIEW | 111 |
| CLOSED | 34 |
| VERIFIED | 176 |
| **total** | **321** |

## How to read a verdict

- **VULNERABLE** — hand-read, with the exact line named below. The static pass never emits this on its own.
- **NEEDS-REVIEW** — the static pass raised a lead it cannot rule on, OR the handler is a nested route whose parent binding a static reader may not certify alone.
- **CLOSED-IN-FLIGHT** — the defect is REAL AND PRESENT in this tree; a fix is already committed on another branch. The evidence anchors pin the OLD lines on purpose, so this report fails loudly the moment the fix merges here and the verdict must be re-cut to CLOSED. Do not read this row as safe.
- **CLOSED** — a previously-raised finding this tree provably fixes.
- **VERIFIED** — guard chain complete, org identity bound in the service, every route param declared, and either no nested parent resource or a hand read that names the binding line.

## Reviewed findings

### CLOSED — `PATCH /build/:projectId/custom-states/:stateId`

`ProjectResourcesController.updateCustomState` — `src/modules/build/core/project-resources.controller.ts:168`

Finding: `parent-binding-missing`

PATCH /build/:projectId/custom-states/:stateId. The controller DOES declare @Param("projectId") but binds it to `_` and throws it away; the service finds the state by (id, orgId) alone. The permission check that follows uses the ROW's own projectId, so the caller is re-authorised against whatever project the state really belongs to — the URL segment is decorative.

Blast radius: Intra-tenant. A state belonging to project A is editable through project B's URL by a caller holding build:manage on A.

Evidence:

- `src/modules/build/core/project-resources.controller.ts:173` — bound to the URL project
- `src/modules/build/core/projects-custom-states.service.ts:171` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/custom-states/:stateId`

`ProjectResourcesController.deleteCustomState` — `src/modules/build/core/project-resources.controller.ts:181`

Finding: `parent-binding-missing`

DELETE /build/:projectId/custom-states/:stateId. Identical to updateCustomState: @Param("projectId") is bound to `_` and discarded, and the delete resolves the state by (id, orgId).

Blast radius: Intra-tenant cross-project delete.

Evidence:

- `src/modules/build/core/project-resources.controller.ts:187` — bound to the URL project
- `src/modules/build/core/projects-custom-states.service.ts:307` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/custom-fields/:fieldId`

`ProjectsCustomFieldsController.updateField` — `src/modules/build/core/projects-custom-fields.controller.ts:60`

Finding: `parent-binding-missing`

PATCH /build/:projectId/custom-fields/:fieldId. The controller declares no @Param("projectId"), so the path segment is never read; the service UPDATEs on (id, orgId, entityType) only. The same service file's listFields binds customFieldDefinitions.projectId, and the column exists and is NOT NULL — so the omission is asymmetry inside one file, not an absent column. Any :projectId in the URL edits a field owned by any other project in the same org, and the row's own projectId is left untouched.

Blast radius: Intra-tenant, not cross-tenant: orgId is still bound, so the write cannot leave the organisation. The caller already holds org-wide build:manage. The defect is the unverified path segment — it breaks the 404 contract for a foreign :projectId and defeats any project-scoped gate layered on later.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:65` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:114` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:54` — listFields DOES bind projectId — the control proving the column is usable here

### CLOSED — `DELETE /build/:projectId/custom-fields/:fieldId`

`ProjectsCustomFieldsController.deleteField` — `src/modules/build/core/projects-custom-fields.controller.ts:73`

Finding: `parent-binding-missing`

DELETE /build/:projectId/custom-fields/:fieldId. Identical shape to updateField: no @Param("projectId"), and the DELETE where clause is (id, orgId, entityType). Unlike listFields/createField this path does not even call assertProjectInOrg, so a :projectId belonging to another organisation still deletes an in-org field.

Blast radius: Intra-tenant. orgId is bound, so no cross-tenant delete. Cross-PROJECT delete inside the org is reachable by anyone holding build:manage.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:79` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:137` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/releases/:releaseId`

`ProjectsReleasesController.updateRelease` — `src/modules/build/core/projects-releases.controller.ts:62`

Finding: `parent-binding-missing`

PATCH /build/:projectId/releases/:releaseId. The release was resolved by (id, orgId) while assertProjectAccess gated only the URL project, so the UPDATE could land on a release owned by another project. Closed in d714ae8ff: the UPDATE now binds projectReleases.projectId, and the ticketCount subquery binds releaseTickets.orgId (it previously counted rows from every tenant).

Blast radius: Was intra-tenant cross-project write. Closed.

Evidence:

- `src/modules/build/core/projects-releases.service.ts:77` — UPDATE binds id + projectId + orgId
- `src/modules/build/core/projects-releases.service.ts:105` — ticketCount now bound to the caller's organisation

### CLOSED — `DELETE /build/:projectId/releases/:releaseId`

`ProjectsReleasesController.deleteRelease` — `src/modules/build/core/projects-releases.controller.ts:75`

Finding: `parent-binding-missing`

DELETE /build/:projectId/releases/:releaseId. Soft delete was resolved by (id, orgId). Closed in d714ae8ff.

Blast radius: Was intra-tenant cross-project delete. Closed.

Evidence:

- `src/modules/build/core/projects-releases.service.ts:115` — soft delete binds id + projectId + orgId

### CLOSED — `POST /build/:projectId/releases/:releaseId/tickets`

`ProjectsReleasesController.addTicket` — `src/modules/build/core/projects-releases.controller.ts:88`

Finding: `parent-binding-missing`

POST /build/:projectId/releases/:releaseId/tickets. Release and ticket were each resolved by (id, orgId), so a ticket from project A could be attached to a release in project B. Closed in d714ae8ff: both now bind projectId.

Blast radius: Was intra-tenant cross-project link. Closed.

Evidence:

- `src/modules/build/core/projects-releases.service.ts:125` — release bound to the URL project
- `src/modules/build/core/projects-releases.service.ts:131` — ticket bound to the URL project

### CLOSED — `DELETE /build/:projectId/releases/:releaseId/tickets/:ticketId`

`ProjectsReleasesController.removeTicket` — `src/modules/build/core/projects-releases.controller.ts:102`

Finding: `parent-binding-missing`

DELETE /build/:projectId/releases/:releaseId/tickets/:ticketId. The release was resolved by (id, orgId) and the join-row DELETE bound only (releaseId, ticketId) — no orgId at all, so it spanned organisations. Closed in d714ae8ff.

Blast radius: Was intra-tenant cross-project, and the unqualified join delete was cross-TENANT. Closed.

Evidence:

- `src/modules/build/core/projects-releases.service.ts:144` — release bound to the URL project
- `src/modules/build/core/projects-releases.service.ts:150` — join delete now bound to the caller's organisation

### CLOSED — `GET /build/:projectId/tickets/:ticketId/subtasks`

`ProjectsTicketAssociationsController.getSubtasks` — `src/modules/build/core/projects-ticket-associations.controller.ts:63`

Finding: `parent-binding-missing`

GET /build/:projectId/tickets/:ticketId/subtasks. No @Param("projectId"); the ticket is resolved by assertTicketInOrg, which binds (id, orgId) and has no projectId parameter at all. Eight OTHER handlers in this same controller do declare and forward @Param("projectId") — the omission is asymmetry inside one file.

Blast radius: Intra-tenant: any org ticket is readable through any project's URL.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:68` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:249` — bound to the URL project
- `src/modules/build/core/project-access.ts:42` — bound to the URL project

### CLOSED — `GET /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.getWatchers` — `src/modules/build/core/projects-ticket-associations.controller.ts:115`

Finding: `parent-binding-missing`

GET /build/:projectId/tickets/:ticketId/watchers. No @Param("projectId"); the ticket is resolved by the private requireTicket(orgId, ticketId), which binds (id, orgId) only.

Blast radius: Intra-tenant cross-project read of a ticket's watchers.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:120` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:281` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:254` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.addWatcher` — `src/modules/build/core/projects-ticket-associations.controller.ts:127`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/watchers. No @Param("projectId"); requireTicket(orgId, ticketId) is the only check.

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:133` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:320` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.removeWatcher` — `src/modules/build/core/projects-ticket-associations.controller.ts:141`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/watchers. No @Param("projectId"); requireTicket(orgId, ticketId) is the only check.

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:147` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:368` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/labels`

`ProjectsTicketAssociationsController.addLabel` — `src/modules/build/core/projects-ticket-associations.controller.ts:154`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/labels. No @Param("projectId"); requireTicket(orgId, ticketId) is the only check.

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:160` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:368` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/attachments`

`ProjectsTicketAssociationsController.addAttachment` — `src/modules/build/core/projects-ticket-associations.controller.ts:182`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/attachments. No @Param("projectId"); requireTicket(orgId, ticketId) is the only check.

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:188` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:416` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId`

`ProjectsTicketChecklistsController.updateChecklist` — `src/modules/build/core/projects-ticket-checklists.controller.ts:70`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId. TWO parents go unbound: neither :projectId nor :ticketId is declared with @Param, and the UPDATE resolves the checklist by (id, orgId).

Blast radius: Intra-tenant cross-ticket AND cross-project write.

Evidence:

- `src/modules/build/core/projects-ticket-checklists.service.ts:142` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId`

`ProjectsTicketChecklistsController.deleteChecklist` — `src/modules/build/core/projects-ticket-checklists.controller.ts:84`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId. Same shape: neither parent is bound; DELETE resolves by (id, orgId).

Blast radius: Intra-tenant cross-ticket AND cross-project delete.

Evidence:

- `src/modules/build/core/projects-ticket-checklists.service.ts:185` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/checklists/:checklistId/items`

`ProjectsTicketChecklistsController.createChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:98`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/checklists/:checklistId/items. The parent checklist is resolved by (id, orgId); the URL's ticketId and projectId are never checked.

Blast radius: Intra-tenant: an item can be appended to a checklist on another project's ticket.

Evidence:

- `src/modules/build/core/projects-ticket-checklists.service.ts:161` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId`

`ProjectsTicketChecklistsController.updateChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:113`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. THREE parents unbound. Only :itemId is declared. The pre-read selects the item by id ALONE — the tenant is then checked in JavaScript against the joined checklist's orgId, not in SQL — and the UPDATE binds (orgId, id). The URL's checklistId is never compared to the item's own checklistId.

Blast radius: Intra-tenant. orgId is enforced (in JS on the pre-read, in SQL on the write), so no cross-tenant write; an item under any checklist in the org is editable through any checklist/ticket/project path.

Evidence:

- `src/modules/build/core/projects-ticket-checklists.service.ts:212` — bound to the URL project
- `src/modules/build/core/projects-ticket-checklists.service.ts:212` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId`

`ProjectsTicketChecklistsController.deleteChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:128`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. Identical to updateChecklistItem.

Blast radius: Intra-tenant cross-checklist delete.

Evidence:

- `src/modules/build/core/projects-ticket-checklists.service.ts:212` — bound to the URL project
- `src/modules/build/core/projects-ticket-checklists.service.ts:212` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/comments`

`ProjectsTicketCommentsController.addComment` — `src/modules/build/core/projects-ticket-comments.controller.ts:45`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/comments. No @Param("projectId"); the subresources facade drops it before delegating, and the comments service resolves the ticket by (id, orgId).

Blast radius: Intra-tenant: a comment can be posted to a ticket in another project through this project's URL.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:249` — bound to the URL project
- `src/modules/build/core/projects-ticket-comments.service.ts:129` — bound to the URL project

### CLOSED — `GET /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.getTicket` — `src/modules/build/core/projects-tickets.controller.ts:214`

Finding: `parent-binding-missing`

GET /build/:projectId/tickets/:ticketId. No @Param("projectId"); the detail reader binds (orgId, deletedAt) plus an id selector. The scope resolver narrows all-vs-own by permission and carries no project predicate.

Blast radius: Intra-tenant: any org ticket is readable through any project's URL.

Evidence:

- `src/modules/build/core/projects-tickets-detail.service.ts:34` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.updateTicket` — `src/modules/build/core/projects-tickets.controller.ts:226`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId. No @Param("projectId"). The service DOES re-derive the ticket's real project from the row and re-authorises against THAT, so a caller cannot mutate a project they have no rights to — but the URL segment is still never compared, so the route resolves a foreign-project ticket instead of 404ing.

Blast radius: Intra-tenant, and narrower than the rest of this family: the row-derived access check means the caller must already hold rights on the ticket's true project. What breaks is the routing/404 contract, and any future project-scoped gate that trusts the URL.

Evidence:

- `src/modules/build/core/projects-tickets-update.service.ts:180` — bound to the URL project
- `src/modules/build/core/projects-tickets-update.service.ts:180` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.deleteTicket` — `src/modules/build/core/projects-tickets.controller.ts:239`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId. No @Param("projectId"); the ticket is resolved by (id, orgId) and the access check that follows uses the row's own projectId.

Blast radius: Intra-tenant; same row-derived mitigation as updateTicket.

Evidence:

- `src/modules/build/core/projects-tickets.service.ts:120` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/webhooks/:webhookId`

`ProjectsWebhooksController.deleteWebhook` — `src/modules/build/core/projects-webhooks.controller.ts:59`

Finding: `parent-binding-missing`

DELETE /build/:projectId/webhooks/:webhookId. No @Param("projectId"); the service DELETEs on (id, orgId). The same service file already owns assertWebhookOwnership(orgId, projectId, webhookId), which binds projectWebhooks.projectId and is called by sendTest — so the correct helper exists and this one path skips it.

Blast radius: Intra-tenant. orgId is bound. A webhook registered against project A is deletable through project B's URL by any holder of build:manage.

Evidence:

- `src/modules/build/core/projects-webhooks.controller.ts:65` — bound to the URL project
- `src/modules/build/core/projects-webhooks.service.ts:60` — bound to the URL project
- `src/modules/build/core/projects-webhooks.service.ts:76` — bound to the URL project

### CLOSED — `GET /build/:projectId/sprints/:sprintId`

`SprintsController.getSprint` — `src/modules/build/execution/iterations.controller.ts:92`

Finding: `parent-binding-missing`

GET /build/:projectId/sprints/:sprintId. No @Param("projectId"); the sprint is resolved by (id, orgId). deleteSprint in the SAME service DOES bind sprints.projectId, proving the column is available and the omission is asymmetry.

Blast radius: Intra-tenant cross-project read.

Evidence:

- `src/modules/build/execution/sprints.service.ts:88` — bound to the URL project
- `src/modules/build/execution/sprints.service.ts:167` — deleteSprint DOES bind projectId — the in-file control

### CLOSED — `PATCH /build/:projectId/sprints/:sprintId`

`SprintsController.updateSprint` — `src/modules/build/execution/iterations.controller.ts:104`

Finding: `parent-binding-missing`

PATCH /build/:projectId/sprints/:sprintId. No @Param("projectId"); both the pre-read and the UPDATE bind (id, orgId).

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/execution/sprints.service.ts:105` — bound to the URL project
- `src/modules/build/execution/sprints.service.ts:120` — UPDATE binds id + orgId

### CLOSED — `PATCH /build/:projectId/modules/:moduleId`

`ModulesController.updateModule` — `src/modules/build/execution/iterations.controller.ts:220`

Finding: `parent-binding-missing`

PATCH /build/:projectId/modules/:moduleId. No @Param("projectId"); the UPDATE binds (id, orgId).

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/execution/modules.service.ts:133` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/modules/:moduleId`

`ModulesController.deleteModule` — `src/modules/build/execution/iterations.controller.ts:233`

Finding: `parent-binding-missing`

DELETE /build/:projectId/modules/:moduleId. No @Param("projectId"). The transaction also nulls tickets.moduleId across the org by (moduleId, orgId) before deleting the module by (id, orgId).

Blast radius: Intra-tenant cross-project delete, with a side effect on every ticket referencing the module.

Evidence:

- `src/modules/build/execution/modules.service.ts:148` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/time-entries`

`TicketTimeEntriesController.logTicketTime` — `src/modules/build/execution/timesheets.controller.ts:183`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/time-entries. No @Param("projectId"); the ticket is resolved by (id, orgId) and the access checks that follow use the ticket's own project.

Blast radius: Intra-tenant; row-derived access check narrows it as with updateTicket.

Evidence:

- `src/modules/build/execution/timesheets.service.ts:425` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/milestones/:milestoneId`

`MilestonesController.updateMilestone` — `src/modules/build/execution/workspace.controller.ts:96`

Finding: `parent-binding-missing`

PATCH /build/:projectId/milestones/:milestoneId. The @Controller prefix itself is "build/:projectId/milestones", yet no @Param("projectId") is declared and the UPDATE binds (id, orgId).

Blast radius: Intra-tenant cross-project write; org-wide permission is sufficient, there is no row-derived re-check.

Evidence:

- `src/modules/build/execution/workspace.service.ts:68` — bound to the URL project

### CLOSED — `DELETE /build/:projectId/milestones/:milestoneId`

`MilestonesController.deleteMilestone` — `src/modules/build/execution/workspace.controller.ts:109`

Finding: `parent-binding-missing`

DELETE /build/:projectId/milestones/:milestoneId. Same as updateMilestone.

Blast radius: Intra-tenant cross-project delete.

Evidence:

- `src/modules/build/execution/workspace.service.ts:78` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/intake/:requestId`

`IntakeController.updateIntake` — `src/modules/build/execution/workspace.controller.ts:154`

Finding: `parent-binding-missing`

PATCH /build/:projectId/intake/:requestId. No @Param("projectId"); every one of the four statements in this method binds (id, orgId). listIntake and createIntake in the same service DO call assertProjectInOrg — updateIntake does not.

Blast radius: Intra-tenant cross-project write.

Evidence:

- `src/modules/build/execution/workspace.service.ts:154` — bound to the URL project

### CLOSED — `PATCH /build/:projectId/views/:viewId`

`ViewsController.updateView` — `src/modules/build/execution/workspace.controller.ts:198`

Finding: `parent-binding-missing`

PATCH /build/:projectId/views/:viewId. No @Param("projectId"); the view is resolved by (id, orgId). A per-user guard rejects mutating a PRIVATE view the caller does not own — but shared views bypass it entirely, and neither branch compares the URL projectId.

Blast radius: Intra-tenant. Private views are additionally user-scoped; SHARED views have no project or user constraint, so any org member can edit a shared view belonging to any project.

Evidence:

- `src/modules/build/execution/workspace.service.ts:269` — bound to the URL project
- `src/modules/build/execution/workspace.service.ts:279` — UPDATE binds id + orgId

### CLOSED — `DELETE /build/:projectId/views/:viewId`

`ViewsController.deleteView` — `src/modules/build/execution/workspace.controller.ts:211`

Finding: `parent-binding-missing`

DELETE /build/:projectId/views/:viewId. Same as updateView, including the shared-view bypass.

Blast radius: Intra-tenant; shared views are deletable across projects by any org member.

Evidence:

- `src/modules/build/execution/workspace.service.ts:286` — bound to the URL project
- `src/modules/build/execution/workspace.service.ts:293` — DELETE binds id + orgId

## Reviewed and cleared

Handlers the static pass may not certify alone, read by hand and found sound. Listed so the clearance carries its evidence rather than an assurance.

### VERIFIED — `GET /public/whiteboard-links/:token`

`PublicWhiteboardLinksController.getByToken` — `src/modules/build/execution/whiteboard-sharing.controller.ts:120`

GET /public/whiteboard-links/:token. Unauthenticated by design. The token is the capability: it is HASHED before lookup, the row must be visibility=public and unexpired, the read runs inside withPublicToken which sets the app.public_token GUC for RLS, and the handler is IP rate-limited before touching the database. No orgId is needed because none is trusted from the caller.

- `src/modules/build/execution/whiteboard-sharing.service.ts:190` — lookup is by token HASH, not the raw token
- `src/modules/build/execution/whiteboard-sharing.service.ts:205` — visibility + expiry enforced before returning

### VERIFIED — `PATCH /public/whiteboard-links/:token`

`PublicWhiteboardLinksController.updateByToken` — `src/modules/build/execution/whiteboard-sharing.controller.ts:134`

PATCH /public/whiteboard-links/:token. An unauthenticated write, and correctly built: view-only links are rejected with 403, and the UPDATE re-asserts every predicate it depends on (token hash, visibility, editor access, not deleted, not expired) in its own where clause rather than trusting the earlier read, so the check cannot be raced. The write runs in a tenant transaction pinned to the board's own orgId.

- `src/modules/build/execution/whiteboard-sharing.service.ts:237` — view-only links rejected
- `src/modules/build/execution/whiteboard-sharing.service.ts:253` — the UPDATE re-asserts the predicate — TOCTOU-safe

### VERIFIED — `POST /public/build-forms/:publicToken/submissions`

`SubmissionsPublicController.submitPublicForm` — `src/modules/build/forms/submissions.controller.ts:106`

POST /public/build-forms/:publicToken/submissions. Unauthenticated by design and IP rate-limited. The form is resolved by (publicToken, isPublic=true, not deleted) inside withPublicToken, and must be active; orgId and projectId for the submission are taken from the resolved form row, never from the caller. NOTE: unlike the whiteboard token this one is compared in plaintext rather than by hash — a storage-exposure hardening opportunity, not an access-control defect.

- `src/modules/build/forms/submissions.service.ts:46` — resolved by token inside withPublicToken; orgId derived from the row
- `src/modules/build/forms/submissions.service.ts:47` — non-public forms are not reachable through this route

## Every handler

| verdict | verb | route | controller:line | method | classification | module | guard chain | org scoping | parent scoping | @Validate params | @Idempotent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NEEDS-REVIEW | GET | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:96` | `getApproval` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/approvals/:approvalId/decide` | `src/modules/build/approvals/approvals.controller.ts:122` | `decideApproval` | @RequirePermission("build:approvals:decide") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | yes |
| NEEDS-REVIEW | PATCH | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:136` | `updateApproval` | @RequirePermission("build:approvals:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:149` | `softDeleteApproval` | @RequirePermission("build:approvals:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:65` | `getChangeRequest` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:90` | `updateChangeRequest` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:103` | `deleteChangeRequest` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/client-visibility/tickets/:ticketId` | `src/modules/build/client-portal/client-visibility.controller.ts:49` | `toggleTicketVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/client-visibility/milestones/:milestoneId` | `src/modules/build/client-portal/client-visibility.controller.ts:62` | `toggleMilestoneVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, milestoneId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/client-visibility/comments/:commentId` | `src/modules/build/client-portal/client-visibility.controller.ts:75` | `toggleCommentVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, commentId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/client-visibility/attachments/:attachmentId` | `src/modules/build/client-portal/client-visibility.controller.ts:88` | `toggleAttachmentVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, attachmentId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/members/:memberUserId` | `src/modules/build/core/project-resources.controller.ts:119` | `updateMemberRole` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, memberUserId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/labels` | `src/modules/build/core/project-resources.controller.ts:213` | `createProjectLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/automations/:automationId` | `src/modules/build/core/projects-automations.controller.ts:56` | `update` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, automationId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/automations/:automationId` | `src/modules/build/core/projects-automations.controller.ts:69` | `delete` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, automationId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/custom-field-values` | `src/modules/build/core/projects-custom-fields.controller.ts:86` | `getTicketValues` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/tickets/:ticketId/custom-field-values` | `src/modules/build/core/projects-custom-fields.controller.ts:98` | `upsertTicketValues` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/templates` | `src/modules/build/core/projects-templates.controller.ts:46` | `createTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:75` | `listRelations` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:87` | `addRelation` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:101` | `removeRelation` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/tickets/:ticketId/labels/:labelId` | `src/modules/build/core/projects-ticket-associations.controller.ts:168` | `removeLabel` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, labelId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/git-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:196` | `getGitLinks` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/related-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:208` | `listRelatedLinks` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | PASSED-UNBOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/tickets/:ticketId/related-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:220` | `addRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | PASSED-UNBOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/tickets/:ticketId/related-links/:linkId` | `src/modules/build/core/projects-ticket-associations.controller.ts:234` | `updateRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, linkId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/tickets/:ticketId/related-links/:linkId` | `src/modules/build/core/projects-ticket-associations.controller.ts:248` | `deleteRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, linkId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/checklists` | `src/modules/build/core/projects-ticket-checklists.controller.ts:44` | `getChecklists` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/tickets/:ticketId/checklists` | `src/modules/build/core/projects-ticket-checklists.controller.ts:56` | `createChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:59` | `getComment` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:72` | `editComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:86` | `deleteComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/tickets/:ticketId/comments/:commentId/reactions` | `src/modules/build/core/projects-ticket-comments.controller.ts:100` | `addReaction` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji` | `src/modules/build/core/projects-ticket-comments.controller.ts:114` | `removeReaction` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId, emoji] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/tickets/:ticketId/rank` | `src/modules/build/core/projects-tickets.controller.ts:173` | `rankTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/activity` | `src/modules/build/core/projects-tickets.controller.ts:186` | `getActivity` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/key/:ticketNumber` | `src/modules/build/core/projects-tickets.controller.ts:202` | `getTicketByKey` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketNumber] | n/a |
| NEEDS-REVIEW | GET | `/build/:projectId/webhooks/:webhookId/deliveries` | `src/modules/build/core/projects-webhooks.controller.ts:72` | `listDeliveries` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/webhooks/:webhookId/test` | `src/modules/build/core/projects-webhooks.controller.ts:84` | `sendTest` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/labels` | `src/modules/build/core/projects.controller.ts:101` | `createLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:117` | `deleteSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, sprintId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/cycles/:cycleId` | `src/modules/build/execution/iterations.controller.ts:163` | `updateCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, cycleId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/cycles/:cycleId` | `src/modules/build/execution/iterations.controller.ts:176` | `deleteCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, cycleId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/epics/:epicId` | `src/modules/build/execution/iterations.controller.ts:277` | `updateEpic` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, epicId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/epics/:epicId` | `src/modules/build/execution/iterations.controller.ts:290` | `deleteEpic` | @RequirePermission("build:tickets:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, epicId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/tickets/:ticketId/time-entries` | `src/modules/build/execution/timesheets.controller.ts:158` | `listTicketTimeEntries` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | PASSED-UNBOUND | complete [projectId, ticketId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/whiteboards/:whiteboardId/sharing` | `src/modules/build/execution/whiteboard-sharing.controller.ts:57` | `updateSharing` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:70` | `rotateShareToken` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| NEEDS-REVIEW | PUT | `/build/:projectId/whiteboards/:whiteboardId/shares` | `src/modules/build/execution/whiteboard-sharing.controller.ts:84` | `setShares` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId` | `src/modules/build/execution/whiteboard-sharing.controller.ts:97` | `removeShare` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId, targetUserId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/views` | `src/modules/build/execution/workspace.controller.ts:238` | `createWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:319` | `getWhiteboard` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:331` | `updateWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:344` | `deleteWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/files/:fileId/url` | `src/modules/build/files/files.controller.ts:73` | `getSignedUrl` | @RequirePermission("build:files:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fileId] | n/a |
| NEEDS-REVIEW | DELETE | `/build/:projectId/files/:fileId` | `src/modules/build/files/files.controller.ts:85` | `softDeleteFile` | @RequirePermission("build:files:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fileId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:54` | `getForm` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:79` | `updateForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:92` | `deleteForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/forms/:formId/submissions` | `src/modules/build/forms/submissions.controller.ts:57` | `listSubmissions` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | unresolved | n/a |
| NEEDS-REVIEW | POST | `/build/:projectId/forms/:formId/submissions` | `src/modules/build/forms/submissions.controller.ts:70` | `createSubmission` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | BOUND | unresolved | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/forms/:formId/submissions/:submissionId` | `src/modules/build/forms/submissions.controller.ts:84` | `updateSubmission` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId, submissionId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:54` | `getDecision` | @RequirePermission("build:decisions:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:79` | `updateDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:92` | `softDeleteDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:72` | `getRisk` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:97` | `updateRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:110` | `softDeleteRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:68` | `getIncident` | @RequirePermission("build:incidents:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:93` | `updateIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:106` | `deleteIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/incidents/:incidentId/updates` | `src/modules/build/incidents/incidents.controller.ts:119` | `addUpdate` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/meetings/:meetingId/action-items` | `src/modules/build/meetings/action-items.controller.ts:39` | `createItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/meetings/:meetingId/action-items/:itemId` | `src/modules/build/meetings/action-items.controller.ts:53` | `updateItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/meetings/:meetingId/action-items/:itemId` | `src/modules/build/meetings/action-items.controller.ts:67` | `deleteItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task` | `src/modules/build/meetings/action-items.controller.ts:81` | `convertToTask` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:67` | `getMeeting` | @RequirePermission("build:meetings:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:92` | `updateMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:105` | `deleteMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/meetings/:meetingId/attendees` | `src/modules/build/meetings/meetings.controller.ts:118` | `addAttendee` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/meetings/:meetingId/attendees/:attendeeUserId` | `src/modules/build/meetings/meetings.controller.ts:132` | `removeAttendee` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, attendeeUserId] | NO (mutating) |
| NEEDS-REVIEW | PUT | `/build/:projectId/meetings/:meetingId/standup` | `src/modules/build/meetings/meetings.controller.ts:146` | `upsertStandup` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/workspaces` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:81` | `createWorkspace` | @RequirePermission("build:workspaces:create") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/workspaces/:pmWorkspaceId/members/:pmWorkspaceMembershipId` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:142` | `updateMemberRole` | @RequirePermission("build:workspaces:members:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [pmWorkspaceId, pmWorkspaceMembershipId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/workspaces/:pmWorkspaceId/members/:pmWorkspaceMembershipId` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:162` | `removeMember` | @RequirePermission("build:workspaces:members:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [pmWorkspaceId, pmWorkspaceMembershipId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/portfolios` | `src/modules/build/portfolios/portfolios.controller.ts:72` | `createPortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/portfolios/:portfolioId/projects/:projectId` | `src/modules/build/portfolios/portfolios.controller.ts:121` | `unlinkProject` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [portfolioId, projectId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/programs/:programId/projects/:projectId` | `src/modules/build/portfolios/programs.controller.ts:121` | `unlinkProject` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [programId, projectId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:59` | `getBug` | @RequirePermission("build:bugs:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:84` | `updateBug` | @RequirePermission("build:bugs:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:97` | `deleteBug` | @RequirePermission("build:bugs:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:54` | `getCase` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:79` | `updateCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:92` | `deleteCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:82` | `getRun` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | n/a |
| NEEDS-REVIEW | GET | `/build/:projectId/test-runs/:runId/results` | `src/modules/build/qa/test-runs.controller.ts:94` | `listRunResults` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:120` | `updateRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:133` | `deleteRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/test-runs/:runId/results/:resultId` | `src/modules/build/qa/test-runs.controller.ts:146` | `updateResult` | @RequirePermission("build:qa:execute") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId, resultId] | NO (mutating) |
| NEEDS-REVIEW | POST | `/build/:projectId/test-runs/:runId/results/:resultId/bug` | `src/modules/build/qa/test-runs.controller.ts:160` | `createBugFromResult` | @RequirePermission("build:bugs:create") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId, resultId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/test-suites/:suiteId` | `src/modules/build/qa/test-suites.controller.ts:67` | `updateSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, suiteId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/test-suites/:suiteId` | `src/modules/build/qa/test-suites.controller.ts:80` | `deleteSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, suiteId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/teams/:teamId/members/:memberUserId` | `src/modules/build/teams/teams.controller.ts:151` | `updateMemberRole` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, memberUserId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/teams/:teamId/members/:memberId` | `src/modules/build/teams/teams.controller.ts:170` | `removeMember` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, memberId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/teams/:teamId/projects/:projectId` | `src/modules/build/teams/teams.controller.ts:207` | `removeProject` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, projectId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/updates/:updateId` | `src/modules/build/updates/updates.controller.ts:71` | `editUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, updateId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/updates/:updateId` | `src/modules/build/updates/updates.controller.ts:84` | `softDeleteUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, updateId] | NO (mutating) |
| NEEDS-REVIEW | PATCH | `/build/:projectId/workflow/transitions/:transitionId` | `src/modules/build/workflow/workflow.controller.ts:69` | `updateTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, transitionId] | NO (mutating) |
| NEEDS-REVIEW | DELETE | `/build/:projectId/workflow/transitions/:transitionId` | `src/modules/build/workflow/workflow.controller.ts:82` | `deleteTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, transitionId] | NO (mutating) |
| NEEDS-REVIEW | GET | `/build/:projectId/workflow/allowed/:fromStatusId` | `src/modules/build/workflow/workflow.controller.ts:95` | `getAllowedTransitions` | @RequirePermission("build:workflow:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fromStatusId] | n/a |
| NEEDS-REVIEW | PATCH | `/build/:projectId/workflow/statuses/:statusId/wip` | `src/modules/build/workflow/workflow.controller.ts:107` | `updateWipLimit` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, statusId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/custom-states/:stateId` | `src/modules/build/core/project-resources.controller.ts:168` | `updateCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, stateId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/custom-states/:stateId` | `src/modules/build/core/project-resources.controller.ts:181` | `deleteCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, stateId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/custom-fields/:fieldId` | `src/modules/build/core/projects-custom-fields.controller.ts:60` | `updateField` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fieldId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/custom-fields/:fieldId` | `src/modules/build/core/projects-custom-fields.controller.ts:73` | `deleteField` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fieldId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/releases/:releaseId` | `src/modules/build/core/projects-releases.controller.ts:62` | `updateRelease` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, releaseId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/releases/:releaseId` | `src/modules/build/core/projects-releases.controller.ts:75` | `deleteRelease` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, releaseId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/releases/:releaseId/tickets` | `src/modules/build/core/projects-releases.controller.ts:88` | `addTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, releaseId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/releases/:releaseId/tickets/:ticketId` | `src/modules/build/core/projects-releases.controller.ts:102` | `removeTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, releaseId, ticketId] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/tickets/:ticketId/subtasks` | `src/modules/build/core/projects-ticket-associations.controller.ts:63` | `getSubtasks` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | GET | `/build/:projectId/tickets/:ticketId/watchers` | `src/modules/build/core/projects-ticket-associations.controller.ts:115` | `getWatchers` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/watchers` | `src/modules/build/core/projects-ticket-associations.controller.ts:127` | `addWatcher` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/watchers` | `src/modules/build/core/projects-ticket-associations.controller.ts:141` | `removeWatcher` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/labels` | `src/modules/build/core/projects-ticket-associations.controller.ts:154` | `addLabel` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/attachments` | `src/modules/build/core/projects-ticket-associations.controller.ts:182` | `addAttachment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId/checklists/:checklistId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:70` | `updateChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/checklists/:checklistId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:84` | `deleteChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items` | `src/modules/build/core/projects-ticket-checklists.controller.ts:98` | `createChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:113` | `updateChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId, itemId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:128` | `deleteChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId, itemId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/comments` | `src/modules/build/core/projects-ticket-comments.controller.ts:45` | `addComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:214` | `getTicket` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:226` | `updateTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:239` | `deleteTicket` | @RequirePermission("build:tickets:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/webhooks/:webhookId` | `src/modules/build/core/projects-webhooks.controller.ts:59` | `deleteWebhook` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:92` | `getSprint` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, sprintId] | n/a |
| CLOSED | PATCH | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:104` | `updateSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, sprintId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/modules/:moduleId` | `src/modules/build/execution/iterations.controller.ts:220` | `updateModule` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, moduleId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/modules/:moduleId` | `src/modules/build/execution/iterations.controller.ts:233` | `deleteModule` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, moduleId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/time-entries` | `src/modules/build/execution/timesheets.controller.ts:183` | `logTicketTime` | @RequirePermission("build:timesheets:create") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/milestones/:milestoneId` | `src/modules/build/execution/workspace.controller.ts:96` | `updateMilestone` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, milestoneId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/milestones/:milestoneId` | `src/modules/build/execution/workspace.controller.ts:109` | `deleteMilestone` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, milestoneId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/intake/:requestId` | `src/modules/build/execution/workspace.controller.ts:154` | `updateIntake` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, requestId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:198` | `updateView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, viewId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:211` | `deleteView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, viewId] | NO (mutating) |
| VERIFIED | GET | `/build/agent-pulse/top-signal` | `src/modules/build/agent-pulse/agent-pulse.controller.ts:27` | `getTopSignal` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/agent-pulse/badge` | `src/modules/build/agent-pulse/agent-pulse.controller.ts:36` | `badge` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | POST | `/build/agent-pulse/proposals/:draftId/apply` | `src/modules/build/agent-pulse/agent-pulse.controller.ts:44` | `applyDraft` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [draftId] | NO (mutating) |
| VERIFIED | GET | `/build/approvals/inbox/count` | `src/modules/build/approvals/approvals.controller.ts:55` | `getInboxCount` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/approvals/inbox` | `src/modules/build/approvals/approvals.controller.ts:64` | `getInbox` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/approvals` | `src/modules/build/approvals/approvals.controller.ts:84` | `listApprovals` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/approvals` | `src/modules/build/approvals/approvals.controller.ts:108` | `createApproval` | @RequirePermission("build:approvals:request") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/change-requests` | `src/modules/build/client-portal/change-requests.controller.ts:53` | `listChangeRequests` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/change-requests` | `src/modules/build/client-portal/change-requests.controller.ts:77` | `createChangeRequest` | @RequirePermission("build:changerequests:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/portal/projects` | `src/modules/build/client-portal/client-portal.controller.ts:36` | `listPortalProjects` | @RequirePermission("build:portal:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/portal/projects/:projectId/overview` | `src/modules/build/client-portal/client-portal.controller.ts:43` | `getProjectOverview` | @RequirePermission("build:portal:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/portal/projects/:projectId/change-requests` | `src/modules/build/client-portal/client-portal.controller.ts:54` | `listPortalChangeRequests` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/portal/projects/:projectId/change-requests` | `src/modules/build/client-portal/client-portal.controller.ts:65` | `createPortalChangeRequest` | @RequirePermission("build:changerequests:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/client-visibility` | `src/modules/build/client-portal/client-visibility.controller.ts:38` | `getVisibilitySummary` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/comment-drafts/mine` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:52` | `listMine` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | PUT | `/build/comment-drafts/tickets/:ticketId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:59` | `upsert` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | POST | `/build/comment-drafts/tickets/:ticketId/generate-draft` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:71` | `generateDraft` | @RequirePermission("build:ai:use") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | POST | `/build/comment-drafts/:draftId/failures` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:89` | `recordFailure` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [draftId] | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/mine` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:107` | `deleteAll` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/tickets/:ticketId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:115` | `deleteByTicket` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/:draftId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:127` | `deleteOne` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [draftId] | NO (mutating) |
| VERIFIED | GET | `/build/org-custom-states` | `src/modules/build/core/project-resources.controller.ts:62` | `listOrgCustomStates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:71` | `listMembers` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/roster` | `src/modules/build/core/project-resources.controller.ts:82` | `getRoster` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:93` | `addMember` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:106` | `removeMember` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PUT | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:132` | `bulkReorderCustomStates` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:144` | `listCustomStates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:155` | `createCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/labels` | `src/modules/build/core/project-resources.controller.ts:201` | `listProjectLabels` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/automations` | `src/modules/build/core/projects-automations.controller.ts:32` | `list` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/automations` | `src/modules/build/core/projects-automations.controller.ts:43` | `create` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/budget` | `src/modules/build/core/projects-budget.controller.ts:31` | `getBudget` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/budget` | `src/modules/build/core/projects-budget.controller.ts:42` | `updateBudget` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId` | `src/modules/build/core/projects-by-id.controller.ts:42` | `getProject` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | PATCH | `/build/:projectId` | `src/modules/build/core/projects-by-id.controller.ts:53` | `updateProject` | @RequirePermission("build:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId` | `src/modules/build/core/projects-by-id.controller.ts:65` | `deleteProject` | @RequirePermission("build:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/managed-product` | `src/modules/build/core/projects-by-id.controller.ts:77` | `linkManagedProduct` | @RequirePermission("build:managed-products:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/custom-fields` | `src/modules/build/core/projects-custom-fields.controller.ts:36` | `listFields` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/custom-fields` | `src/modules/build/core/projects-custom-fields.controller.ts:47` | `createField` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/customers` | `src/modules/build/core/projects-customers.controller.ts:23` | `list` | @RequirePermission("build:customers:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/releases` | `src/modules/build/core/projects-releases.controller.ts:37` | `listReleases` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/releases` | `src/modules/build/core/projects-releases.controller.ts:48` | `createRelease` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/resource-allocation` | `src/modules/build/core/projects-reports.controller.ts:55` | `resourceAllocation` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/:projectId/analytics` | `src/modules/build/core/projects-reports.controller.ts:63` | `getAnalytics` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/burnup` | `src/modules/build/core/projects-reports.controller.ts:75` | `burnup` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/cfd` | `src/modules/build/core/projects-reports.controller.ts:87` | `cfd` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/critical-path` | `src/modules/build/core/projects-reports.controller.ts:99` | `criticalPath` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/velocity` | `src/modules/build/core/projects-reports.controller.ts:110` | `velocity` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/cycle-time` | `src/modules/build/core/projects-reports.controller.ts:134` | `getCycleTime` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/lead-time` | `src/modules/build/core/projects-reports.controller.ts:145` | `getLeadTime` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/reports/snapshot` | `src/modules/build/core/projects-reports.controller.ts:156` | `snapshot` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/roadmap` | `src/modules/build/core/projects-roadmap.controller.ts:64` | `listRoadmap` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/roadmap` | `src/modules/build/core/projects-roadmap.controller.ts:75` | `createRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/roadmap/:itemId` | `src/modules/build/core/projects-roadmap.controller.ts:87` | `updateRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [itemId] | NO (mutating) |
| VERIFIED | DELETE | `/build/roadmap/:itemId` | `src/modules/build/core/projects-roadmap.controller.ts:99` | `deleteRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [itemId] | NO (mutating) |
| VERIFIED | GET | `/build/feedback` | `src/modules/build/core/projects-roadmap.controller.ts:111` | `listFeedback` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/feedback` | `src/modules/build/core/projects-roadmap.controller.ts:122` | `createFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/feedback/:postId` | `src/modules/build/core/projects-roadmap.controller.ts:134` | `updateFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | POST | `/build/feedback/:postId/merge` | `src/modules/build/core/projects-roadmap.controller.ts:146` | `mergeFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | DELETE | `/build/feedback/:postId` | `src/modules/build/core/projects-roadmap.controller.ts:158` | `deleteFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | GET | `/build/changelog` | `src/modules/build/core/projects-roadmap.controller.ts:170` | `listChangelog` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/changelog` | `src/modules/build/core/projects-roadmap.controller.ts:181` | `createChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/changelog/:entryId` | `src/modules/build/core/projects-roadmap.controller.ts:193` | `updateChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | DELETE | `/build/changelog/:entryId` | `src/modules/build/core/projects-roadmap.controller.ts:205` | `deleteChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | GET | `/build/templates` | `src/modules/build/core/projects-templates.controller.ts:39` | `listTemplates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | DELETE | `/build/templates/:templateId` | `src/modules/build/core/projects-templates.controller.ts:58` | `deleteTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [templateId] | NO (mutating) |
| VERIFIED | POST | `/build/templates/:templateId/apply` | `src/modules/build/core/projects-templates.controller.ts:70` | `applyTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [templateId] | yes |
| VERIFIED | GET | `/build/all-work` | `src/modules/build/core/projects-tickets.controller.ts:75` | `getAllWork` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/search/tickets` | `src/modules/build/core/projects-tickets.controller.ts:86` | `searchTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/column-counts` | `src/modules/build/core/projects-tickets.controller.ts:97` | `getColumnCounts` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/export` | `src/modules/build/core/projects-tickets.controller.ts:108` | `exportTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets/import` | `src/modules/build/core/projects-tickets.controller.ts:119` | `importTickets` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/tickets` | `src/modules/build/core/projects-tickets.controller.ts:133` | `listTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets` | `src/modules/build/core/projects-tickets.controller.ts:145` | `createTicket` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | POST | `/build/:projectId/tickets/bulk` | `src/modules/build/core/projects-tickets.controller.ts:159` | `bulkUpdate` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/webhooks` | `src/modules/build/core/projects-webhooks.controller.ts:34` | `listWebhooks` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/webhooks` | `src/modules/build/core/projects-webhooks.controller.ts:45` | `createWebhook` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/members` | `src/modules/build/core/projects-workspace-members.controller.ts:41` | `list` | @RequirePermission("build:members:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/members` | `src/modules/build/core/projects-workspace-members.controller.ts:52` | `add` | @RequirePermission("build:members:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | DELETE | `/build/members/:userId` | `src/modules/build/core/projects-workspace-members.controller.ts:64` | `remove` | @RequirePermission("build:members:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [userId] | NO (mutating) |
| VERIFIED | GET | `/build` | `src/modules/build/core/projects.controller.ts:57` | `listProjects` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build` | `src/modules/build/core/projects.controller.ts:68` | `createProject` | @RequirePermission("build:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | POST | `/build/from-deal` | `src/modules/build/core/projects.controller.ts:81` | `createFromDeal` | @RequirePermission("build:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | GET | `/build/labels` | `src/modules/build/core/projects.controller.ts:94` | `listLabels` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | PATCH | `/build/labels/:labelId` | `src/modules/build/core/projects.controller.ts:113` | `updateLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [labelId] | NO (mutating) |
| VERIFIED | DELETE | `/build/labels/:labelId` | `src/modules/build/core/projects.controller.ts:125` | `deleteLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [labelId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/sprints` | `src/modules/build/execution/iterations.controller.ts:67` | `listSprints` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/sprints` | `src/modules/build/execution/iterations.controller.ts:78` | `createSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/cycles` | `src/modules/build/execution/iterations.controller.ts:137` | `listCycles` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/cycles` | `src/modules/build/execution/iterations.controller.ts:149` | `createCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/modules` | `src/modules/build/execution/iterations.controller.ts:196` | `listModules` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/modules` | `src/modules/build/execution/iterations.controller.ts:207` | `createModule` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/epics` | `src/modules/build/execution/iterations.controller.ts:253` | `listEpics` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/epics` | `src/modules/build/execution/iterations.controller.ts:264` | `createEpic` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/time-entries` | `src/modules/build/execution/timesheets.controller.ts:61` | `listTimeEntries` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/time-entries/team` | `src/modules/build/execution/timesheets.controller.ts:72` | `teamTimesheets` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | PATCH | `/build/time-entries/:entryId/approve` | `src/modules/build/execution/timesheets.controller.ts:83` | `approveEntry` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | yes |
| VERIFIED | PATCH | `/build/time-entries/:entryId/reject` | `src/modules/build/execution/timesheets.controller.ts:96` | `rejectEntry` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | yes |
| VERIFIED | PATCH | `/build/time-entries/:entryId` | `src/modules/build/execution/timesheets.controller.ts:109` | `updateEntry` | @RequirePermission("build:timesheets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | DELETE | `/build/time-entries/:entryId` | `src/modules/build/execution/timesheets.controller.ts:121` | `deleteEntry` | @RequirePermission("build:timesheets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | GET | `/build/billing-summary` | `src/modules/build/execution/timesheets.controller.ts:140` | `billingSummary` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/public/whiteboard-links/:token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:120` | `getByToken` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [token] | n/a |
| VERIFIED | PATCH | `/public/whiteboard-links/:token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:134` | `updateByToken` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [token] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/milestones` | `src/modules/build/execution/workspace.controller.ts:72` | `listMilestones` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/milestones` | `src/modules/build/execution/workspace.controller.ts:83` | `createMilestone` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/intake` | `src/modules/build/execution/workspace.controller.ts:129` | `listIntake` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/intake` | `src/modules/build/execution/workspace.controller.ts:141` | `createIntake` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/views` | `src/modules/build/execution/workspace.controller.ts:174` | `listViews` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/views` | `src/modules/build/execution/workspace.controller.ts:185` | `createView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/views` | `src/modules/build/execution/workspace.controller.ts:231` | `listWorkspaceViews` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | PATCH | `/build/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:250` | `updateWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [viewId] | NO (mutating) |
| VERIFIED | DELETE | `/build/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:262` | `deleteWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [viewId] | NO (mutating) |
| VERIFIED | GET | `/build/whiteboards` | `src/modules/build/execution/workspace.controller.ts:281` | `listAllWhiteboards` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/:projectId/whiteboards` | `src/modules/build/execution/workspace.controller.ts:295` | `listWhiteboards` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/whiteboards` | `src/modules/build/execution/workspace.controller.ts:306` | `createWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/files` | `src/modules/build/files/files.controller.ts:48` | `listFiles` | @RequirePermission("build:files:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/files` | `src/modules/build/files/files.controller.ts:60` | `uploadFile` | @RequirePermission("build:files:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/forms` | `src/modules/build/forms/forms.controller.ts:42` | `listForms` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/forms` | `src/modules/build/forms/forms.controller.ts:66` | `createForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | POST | `/public/build-forms/:publicToken/submissions` | `src/modules/build/forms/submissions.controller.ts:106` | `submitPublicForm` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [publicToken] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/decisions` | `src/modules/build/governance/decisions.controller.ts:42` | `listDecisions` | @RequirePermission("build:decisions:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/decisions` | `src/modules/build/governance/decisions.controller.ts:66` | `createDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/risks` | `src/modules/build/governance/risks.controller.ts:50` | `listRisks` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/risks/stats` | `src/modules/build/governance/risks.controller.ts:62` | `getRiskStats` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | ABSENT (route has params) | n/a |
| VERIFIED | POST | `/build/:projectId/risks` | `src/modules/build/governance/risks.controller.ts:84` | `createRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/incidents` | `src/modules/build/incidents/incidents.controller.ts:56` | `listIncidents` | @RequirePermission("build:incidents:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/incidents` | `src/modules/build/incidents/incidents.controller.ts:80` | `createIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/managed-products` | `src/modules/build/managed-products/managed-products.controller.ts:43` | `listManagedProducts` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:54` | `getManagedProduct` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | n/a |
| VERIFIED | POST | `/build/managed-products` | `src/modules/build/managed-products/managed-products.controller.ts:65` | `createManagedProduct` | @RequirePermission("build:managed-products:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:77` | `updateManagedProduct` | @RequirePermission("build:managed-products:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | NO (mutating) |
| VERIFIED | GET | `/build/managed-products/:managedProductId/insights` | `src/modules/build/managed-products/managed-products.controller.ts:89` | `getProductInsights` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | n/a |
| VERIFIED | DELETE | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:100` | `deleteManagedProduct` | @RequirePermission("build:managed-products:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/meetings` | `src/modules/build/meetings/meetings.controller.ts:55` | `listMeetings` | @RequirePermission("build:meetings:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/meetings` | `src/modules/build/meetings/meetings.controller.ts:79` | `createMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/workspaces` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:59` | `listWorkspaces` | @RequirePermission("build:workspaces:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/workspaces/:pmWorkspaceId` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:70` | `getWorkspace` | @RequirePermission("build:workspaces:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [pmWorkspaceId] | n/a |
| VERIFIED | PATCH | `/build/workspaces/:pmWorkspaceId` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:93` | `updateWorkspace` | @RequirePermission("build:workspaces:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [pmWorkspaceId] | NO (mutating) |
| VERIFIED | DELETE | `/build/workspaces/:pmWorkspaceId` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:105` | `deleteWorkspace` | @RequirePermission("build:workspaces:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [pmWorkspaceId] | NO (mutating) |
| VERIFIED | GET | `/build/workspaces/:pmWorkspaceId/members` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:117` | `listMembers` | @RequirePermission("build:workspaces:members:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [pmWorkspaceId] | n/a |
| VERIFIED | POST | `/build/workspaces/:pmWorkspaceId/members` | `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:129` | `addMember` | @RequirePermission("build:workspaces:members:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [pmWorkspaceId] | NO (mutating) |
| VERIFIED | GET | `/build/portfolios` | `src/modules/build/portfolios/portfolios.controller.ts:50` | `listPortfolios` | @RequirePermission("build:portfolios:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:61` | `getPortfolio` | @RequirePermission("build:portfolios:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | n/a |
| VERIFIED | PATCH | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:84` | `updatePortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | DELETE | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:96` | `deletePortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | POST | `/build/portfolios/:portfolioId/projects` | `src/modules/build/portfolios/portfolios.controller.ts:108` | `linkProject` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | GET | `/build/programs` | `src/modules/build/portfolios/programs.controller.ts:50` | `listPrograms` | @RequirePermission("build:programs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:61` | `getProgram` | @RequirePermission("build:programs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | n/a |
| VERIFIED | POST | `/build/programs` | `src/modules/build/portfolios/programs.controller.ts:72` | `createProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:84` | `updateProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | DELETE | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:96` | `deleteProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | POST | `/build/programs/:programId/projects` | `src/modules/build/portfolios/programs.controller.ts:108` | `linkProject` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/bugs` | `src/modules/build/qa/bugs.controller.ts:47` | `listBugs` | @RequirePermission("build:bugs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/bugs` | `src/modules/build/qa/bugs.controller.ts:71` | `createBug` | @RequirePermission("build:bugs:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-cases` | `src/modules/build/qa/test-cases.controller.ts:42` | `listCases` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/test-cases` | `src/modules/build/qa/test-cases.controller.ts:66` | `createCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-runs` | `src/modules/build/qa/test-runs.controller.ts:70` | `listRuns` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/test-runs` | `src/modules/build/qa/test-runs.controller.ts:107` | `createRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-suites` | `src/modules/build/qa/test-suites.controller.ts:42` | `listSuites` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/test-suites` | `src/modules/build/qa/test-suites.controller.ts:54` | `createSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | POST | `/build/scope-directory/resolve` | `src/modules/build/scope-directory/scope-directory.controller.ts:27` | `resolve` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/scope-directory/search` | `src/modules/build/scope-directory/scope-directory.controller.ts:45` | `search` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/teams` | `src/modules/build/teams/teams.controller.ts:68` | `listTeams` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:79` | `getTeam` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams` | `src/modules/build/teams/teams.controller.ts:90` | `createTeam` | @RequirePermission("build:teams:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:102` | `updateTeam` | @RequirePermission("build:teams:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | DELETE | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:114` | `deleteTeam` | @RequirePermission("build:teams:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | GET | `/build/teams/:teamId/members` | `src/modules/build/teams/teams.controller.ts:126` | `listTeamMembers` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams/:teamId/members` | `src/modules/build/teams/teams.controller.ts:138` | `addMember` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | GET | `/build/teams/:teamId/projects` | `src/modules/build/teams/teams.controller.ts:183` | `listTeamProjects` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams/:teamId/projects` | `src/modules/build/teams/teams.controller.ts:194` | `addProject` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/updates` | `src/modules/build/updates/updates.controller.ts:45` | `listUpdates` | @RequirePermission("build:updates:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/updates` | `src/modules/build/updates/updates.controller.ts:57` | `createUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | GET | `/build/:projectId/workflow/transitions` | `src/modules/build/workflow/workflow.controller.ts:46` | `listTransitions` | @RequirePermission("build:workflow:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | ABSENT (route has params) | n/a |
| VERIFIED | POST | `/build/:projectId/workflow/transitions` | `src/modules/build/workflow/workflow.controller.ts:56` | `createTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |

## NEEDS-REVIEW — open leads

- `GET /build/:projectId/approvals/:approvalId` — `src/modules/build/approvals/approvals.controller.ts:96` (`getApproval`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/approvals/:approvalId/decide` — `src/modules/build/approvals/approvals.controller.ts:122` (`decideApproval`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/approvals/:approvalId` — `src/modules/build/approvals/approvals.controller.ts:136` (`updateApproval`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/approvals/:approvalId` — `src/modules/build/approvals/approvals.controller.ts:149` (`softDeleteApproval`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/change-requests/:changeRequestId` — `src/modules/build/client-portal/change-requests.controller.ts:65` (`getChangeRequest`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/change-requests/:changeRequestId` — `src/modules/build/client-portal/change-requests.controller.ts:90` (`updateChangeRequest`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/change-requests/:changeRequestId` — `src/modules/build/client-portal/change-requests.controller.ts:103` (`deleteChangeRequest`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/client-visibility/tickets/:ticketId` — `src/modules/build/client-portal/client-visibility.controller.ts:49` (`toggleTicketVisibility`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/client-visibility/milestones/:milestoneId` — `src/modules/build/client-portal/client-visibility.controller.ts:62` (`toggleMilestoneVisibility`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/client-visibility/comments/:commentId` — `src/modules/build/client-portal/client-visibility.controller.ts:75` (`toggleCommentVisibility`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/client-visibility/attachments/:attachmentId` — `src/modules/build/client-portal/client-visibility.controller.ts:88` (`toggleAttachmentVisibility`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/members/:memberUserId` — `src/modules/build/core/project-resources.controller.ts:119` (`updateMemberRole`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/labels` — `src/modules/build/core/project-resources.controller.ts:213` (`createProjectLabel`): org scoping: PASSED-UNBOUND
- `PATCH /build/:projectId/automations/:automationId` — `src/modules/build/core/projects-automations.controller.ts:56` (`update`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/automations/:automationId` — `src/modules/build/core/projects-automations.controller.ts:69` (`delete`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/custom-field-values` — `src/modules/build/core/projects-custom-fields.controller.ts:86` (`getTicketValues`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/tickets/:ticketId/custom-field-values` — `src/modules/build/core/projects-custom-fields.controller.ts:98` (`upsertTicketValues`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/templates` — `src/modules/build/core/projects-templates.controller.ts:46` (`createTemplate`): org scoping: PASSED-UNBOUND
- `GET /build/:projectId/tickets/:ticketId/relations` — `src/modules/build/core/projects-ticket-associations.controller.ts:75` (`listRelations`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/tickets/:ticketId/relations` — `src/modules/build/core/projects-ticket-associations.controller.ts:87` (`addRelation`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/tickets/:ticketId/relations` — `src/modules/build/core/projects-ticket-associations.controller.ts:101` (`removeRelation`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/tickets/:ticketId/labels/:labelId` — `src/modules/build/core/projects-ticket-associations.controller.ts:168` (`removeLabel`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/git-links` — `src/modules/build/core/projects-ticket-associations.controller.ts:196` (`getGitLinks`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/related-links` — `src/modules/build/core/projects-ticket-associations.controller.ts:208` (`listRelatedLinks`): parent scoping: PASSED-UNBOUND
- `POST /build/:projectId/tickets/:ticketId/related-links` — `src/modules/build/core/projects-ticket-associations.controller.ts:220` (`addRelatedLink`): parent scoping: PASSED-UNBOUND
- `PATCH /build/:projectId/tickets/:ticketId/related-links/:linkId` — `src/modules/build/core/projects-ticket-associations.controller.ts:234` (`updateRelatedLink`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/tickets/:ticketId/related-links/:linkId` — `src/modules/build/core/projects-ticket-associations.controller.ts:248` (`deleteRelatedLink`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/checklists` — `src/modules/build/core/projects-ticket-checklists.controller.ts:44` (`getChecklists`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/tickets/:ticketId/checklists` — `src/modules/build/core/projects-ticket-checklists.controller.ts:56` (`createChecklist`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/comments/:commentId` — `src/modules/build/core/projects-ticket-comments.controller.ts:59` (`getComment`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/tickets/:ticketId/comments/:commentId` — `src/modules/build/core/projects-ticket-comments.controller.ts:72` (`editComment`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/tickets/:ticketId/comments/:commentId` — `src/modules/build/core/projects-ticket-comments.controller.ts:86` (`deleteComment`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/tickets/:ticketId/comments/:commentId/reactions` — `src/modules/build/core/projects-ticket-comments.controller.ts:100` (`addReaction`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji` — `src/modules/build/core/projects-ticket-comments.controller.ts:114` (`removeReaction`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/tickets/:ticketId/rank` — `src/modules/build/core/projects-tickets.controller.ts:173` (`rankTicket`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/activity` — `src/modules/build/core/projects-tickets.controller.ts:186` (`getActivity`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/key/:ticketNumber` — `src/modules/build/core/projects-tickets.controller.ts:202` (`getTicketByKey`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/webhooks/:webhookId/deliveries` — `src/modules/build/core/projects-webhooks.controller.ts:72` (`listDeliveries`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/webhooks/:webhookId/test` — `src/modules/build/core/projects-webhooks.controller.ts:84` (`sendTest`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/labels` — `src/modules/build/core/projects.controller.ts:101` (`createLabel`): org scoping: PASSED-UNBOUND
- `DELETE /build/:projectId/sprints/:sprintId` — `src/modules/build/execution/iterations.controller.ts:117` (`deleteSprint`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/cycles/:cycleId` — `src/modules/build/execution/iterations.controller.ts:163` (`updateCycle`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/cycles/:cycleId` — `src/modules/build/execution/iterations.controller.ts:176` (`deleteCycle`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/epics/:epicId` — `src/modules/build/execution/iterations.controller.ts:277` (`updateEpic`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/epics/:epicId` — `src/modules/build/execution/iterations.controller.ts:290` (`deleteEpic`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/tickets/:ticketId/time-entries` — `src/modules/build/execution/timesheets.controller.ts:158` (`listTicketTimeEntries`): parent scoping: PASSED-UNBOUND
- `PATCH /build/:projectId/whiteboards/:whiteboardId/sharing` — `src/modules/build/execution/whiteboard-sharing.controller.ts:57` (`updateSharing`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token` — `src/modules/build/execution/whiteboard-sharing.controller.ts:70` (`rotateShareToken`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PUT /build/:projectId/whiteboards/:whiteboardId/shares` — `src/modules/build/execution/whiteboard-sharing.controller.ts:84` (`setShares`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId` — `src/modules/build/execution/whiteboard-sharing.controller.ts:97` (`removeShare`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/views` — `src/modules/build/execution/workspace.controller.ts:238` (`createWorkspaceView`): org scoping: PASSED-UNBOUND
- `GET /build/:projectId/whiteboards/:whiteboardId` — `src/modules/build/execution/workspace.controller.ts:319` (`getWhiteboard`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/whiteboards/:whiteboardId` — `src/modules/build/execution/workspace.controller.ts:331` (`updateWhiteboard`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/whiteboards/:whiteboardId` — `src/modules/build/execution/workspace.controller.ts:344` (`deleteWhiteboard`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/files/:fileId/url` — `src/modules/build/files/files.controller.ts:73` (`getSignedUrl`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/files/:fileId` — `src/modules/build/files/files.controller.ts:85` (`softDeleteFile`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/forms/:formId` — `src/modules/build/forms/forms.controller.ts:54` (`getForm`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/forms/:formId` — `src/modules/build/forms/forms.controller.ts:79` (`updateForm`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/forms/:formId` — `src/modules/build/forms/forms.controller.ts:92` (`deleteForm`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/forms/:formId/submissions` — `src/modules/build/forms/submissions.controller.ts:57` (`listSubmissions`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/forms/:formId/submissions` — `src/modules/build/forms/submissions.controller.ts:70` (`createSubmission`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/forms/:formId/submissions/:submissionId` — `src/modules/build/forms/submissions.controller.ts:84` (`updateSubmission`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/decisions/:decisionId` — `src/modules/build/governance/decisions.controller.ts:54` (`getDecision`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/decisions/:decisionId` — `src/modules/build/governance/decisions.controller.ts:79` (`updateDecision`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/decisions/:decisionId` — `src/modules/build/governance/decisions.controller.ts:92` (`softDeleteDecision`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/risks/:riskId` — `src/modules/build/governance/risks.controller.ts:72` (`getRisk`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/risks/:riskId` — `src/modules/build/governance/risks.controller.ts:97` (`updateRisk`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/risks/:riskId` — `src/modules/build/governance/risks.controller.ts:110` (`softDeleteRisk`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/incidents/:incidentId` — `src/modules/build/incidents/incidents.controller.ts:68` (`getIncident`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/incidents/:incidentId` — `src/modules/build/incidents/incidents.controller.ts:93` (`updateIncident`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/incidents/:incidentId` — `src/modules/build/incidents/incidents.controller.ts:106` (`deleteIncident`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/incidents/:incidentId/updates` — `src/modules/build/incidents/incidents.controller.ts:119` (`addUpdate`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/meetings/:meetingId/action-items` — `src/modules/build/meetings/action-items.controller.ts:39` (`createItem`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/meetings/:meetingId/action-items/:itemId` — `src/modules/build/meetings/action-items.controller.ts:53` (`updateItem`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/meetings/:meetingId/action-items/:itemId` — `src/modules/build/meetings/action-items.controller.ts:67` (`deleteItem`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task` — `src/modules/build/meetings/action-items.controller.ts:81` (`convertToTask`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/meetings/:meetingId` — `src/modules/build/meetings/meetings.controller.ts:67` (`getMeeting`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/meetings/:meetingId` — `src/modules/build/meetings/meetings.controller.ts:92` (`updateMeeting`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/meetings/:meetingId` — `src/modules/build/meetings/meetings.controller.ts:105` (`deleteMeeting`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/meetings/:meetingId/attendees` — `src/modules/build/meetings/meetings.controller.ts:118` (`addAttendee`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/meetings/:meetingId/attendees/:attendeeUserId` — `src/modules/build/meetings/meetings.controller.ts:132` (`removeAttendee`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PUT /build/:projectId/meetings/:meetingId/standup` — `src/modules/build/meetings/meetings.controller.ts:146` (`upsertStandup`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/workspaces` — `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:81` (`createWorkspace`): org scoping: PASSED-UNBOUND
- `PATCH /build/workspaces/:pmWorkspaceId/members/:pmWorkspaceMembershipId` — `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:142` (`updateMemberRole`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/workspaces/:pmWorkspaceId/members/:pmWorkspaceMembershipId` — `src/modules/build/pm-workspaces/pm-workspaces.controller.ts:162` (`removeMember`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/portfolios` — `src/modules/build/portfolios/portfolios.controller.ts:72` (`createPortfolio`): org scoping: PASSED-UNBOUND
- `DELETE /build/portfolios/:portfolioId/projects/:projectId` — `src/modules/build/portfolios/portfolios.controller.ts:121` (`unlinkProject`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/programs/:programId/projects/:projectId` — `src/modules/build/portfolios/programs.controller.ts:121` (`unlinkProject`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/bugs/:bugId` — `src/modules/build/qa/bugs.controller.ts:59` (`getBug`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/bugs/:bugId` — `src/modules/build/qa/bugs.controller.ts:84` (`updateBug`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/bugs/:bugId` — `src/modules/build/qa/bugs.controller.ts:97` (`deleteBug`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/test-cases/:caseId` — `src/modules/build/qa/test-cases.controller.ts:54` (`getCase`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/test-cases/:caseId` — `src/modules/build/qa/test-cases.controller.ts:79` (`updateCase`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/test-cases/:caseId` — `src/modules/build/qa/test-cases.controller.ts:92` (`deleteCase`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/test-runs/:runId` — `src/modules/build/qa/test-runs.controller.ts:82` (`getRun`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/test-runs/:runId/results` — `src/modules/build/qa/test-runs.controller.ts:94` (`listRunResults`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/test-runs/:runId` — `src/modules/build/qa/test-runs.controller.ts:120` (`updateRun`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/test-runs/:runId` — `src/modules/build/qa/test-runs.controller.ts:133` (`deleteRun`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/test-runs/:runId/results/:resultId` — `src/modules/build/qa/test-runs.controller.ts:146` (`updateResult`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `POST /build/:projectId/test-runs/:runId/results/:resultId/bug` — `src/modules/build/qa/test-runs.controller.ts:160` (`createBugFromResult`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/test-suites/:suiteId` — `src/modules/build/qa/test-suites.controller.ts:67` (`updateSuite`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/test-suites/:suiteId` — `src/modules/build/qa/test-suites.controller.ts:80` (`deleteSuite`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/teams/:teamId/members/:memberUserId` — `src/modules/build/teams/teams.controller.ts:151` (`updateMemberRole`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/teams/:teamId/members/:memberId` — `src/modules/build/teams/teams.controller.ts:170` (`removeMember`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/teams/:teamId/projects/:projectId` — `src/modules/build/teams/teams.controller.ts:207` (`removeProject`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/updates/:updateId` — `src/modules/build/updates/updates.controller.ts:71` (`editUpdate`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/updates/:updateId` — `src/modules/build/updates/updates.controller.ts:84` (`softDeleteUpdate`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/workflow/transitions/:transitionId` — `src/modules/build/workflow/workflow.controller.ts:69` (`updateTransition`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `DELETE /build/:projectId/workflow/transitions/:transitionId` — `src/modules/build/workflow/workflow.controller.ts:82` (`deleteTransition`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `GET /build/:projectId/workflow/allowed/:fromStatusId` — `src/modules/build/workflow/workflow.controller.ts:95` (`getAllowedTransitions`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)
- `PATCH /build/:projectId/workflow/statuses/:statusId/wip` — `src/modules/build/workflow/workflow.controller.ts:107` (`updateWipLimit`): static pass clean, but a nested route's parent binding is not a claim a static reader may make alone (see CLASSIFICATION CONTRACT)

## Recorded notes (non-blocking)

A note is recorded because the census must record it, but does not on its own make a route unsafe and never forces NEEDS-REVIEW.

| note | handlers |
| --- | --- |
| mutating verb without @Idempotent | 192 |
| route params unvalidated (@Validate has no params key) | 23 |
| route params unvalidated (no @Validate) | 2 |

## Limitations of the static pass

- Service resolution is name-based: `this.<prop>.<method>()` is followed through the constructor parameter's type annotation to the first class of that name under `src/`. An interface-typed or factory-provided dependency resolves to nothing and reports UNRESOLVED.
- Only ONE service call per handler is followed — the returned one, else the last. A handler that calls an access assert and then a second service resolves parent scoping against whichever of the two is picked; the other is reported as `PASSED-ELSEWHERE`.
- Binding detection is syntactic: `eq(...)` / `inArray(...)`, a `sql` template interpolation, or an object `.where({ col: p })`. Delegation is followed to a depth of 3 through `this.method()` and `this.injectedService.method()`, so the facade services resolve; past that a binding shows as `PASSED-UNBOUND`.
- Two known FALSE-POSITIVE classes remain, both deliberately left noisy. This census prefers a false `NEEDS-REVIEW` over a false `VERIFIED`, because the second hides a real defect and the first only costs a read:
    1. **Create endpoints.** An INSERT scopes the row by writing `orgId` into `.values({ orgId, ... })`, which is not a predicate. Every `create*` handler therefore reads as `org scoping: PASSED-UNBOUND` while being correctly scoped.
    2. **Parent checks written in JavaScript.** `projects-ticket-links.service.ts` fetches the ticket by `(id, orgId)` and then rejects with `if (ticket.projectId !== projectId)`. The parent IS verified, but in JS rather than SQL, so the binder cannot see it. Teaching the binder to accept a post-fetch comparison was rejected on purpose: the heuristic would also mark genuinely unbound code as bound.
- A param passed inside an object literal (`this.listTimeEntries(user, { ...query, projectId })`) is not tracked into the callee, because the binder matches arguments by identifier, not by destructured shape.
- RLS is not modelled. A row that is unreachable at the database because a tenant policy denies it still reads as unbound here. Conversely a passing census says nothing about whether the table has RLS at all.
- Permission KEY semantics are not modelled. The census records which key a route requires; whether that key is the right one, or whether the catalog grants it too widely, is out of scope.
- Dynamically registered routes (`RouteModule.forChild`, mixins) are invisible. Every handler here is a decorated method on a `@Controller` class.
- `@Validate` params completeness is checked against the literal path. A param introduced by a global prefix or a versioning middleware would not appear.

