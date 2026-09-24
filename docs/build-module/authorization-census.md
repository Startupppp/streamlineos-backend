# Build module — authorization census

GENERATED FILE. Do not hand-edit. Regenerate with `pnpm check:build-authz-census`; the generator is `scripts/build-authorization-census.mjs`.

Scope: every `*.controller.ts` under `src/modules/build/`. 49 controller files, 325 HTTP handlers.

## Counts

| classification | handlers |
| --- | --- |
| VULNERABLE | 0 |
| CLOSED-IN-FLIGHT | 0 |
| NEEDS-REVIEW | 0 |
| CLOSED | 42 |
| VERIFIED | 283 |
| **total** | **325** |

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

### CLOSED — `PATCH /build/:projectId/automations/:automationId`

`ProjectsAutomationsController.update` — `src/modules/build/core/projects-automations.controller.ts:81`

Finding: `parent-binding-missing`

PATCH /build/:projectId/automations/:automationId. ProjectsAutomationsService.updateAutomation authorized the caller via assertCanManageProject(u, projectId), which a project-scoped manager of the NAMED project alone can satisfy, but the mutation's WHERE clause only bound id+orgId — never projectId — so that caller could rewrite any other project's automation by ID. Fixed by adding eq(projectAutomations.projectId, projectId) to the UPDATE's WHERE, so a foreign automationId now 404s instead of matching.

Blast radius: Was intra-tenant cross-project rules-tampering; now closed. orgId was always bound, so this was never cross-tenant.

Evidence:

- `src/modules/build/core/projects-automations.controller.ts:85` — handler binds both projectId and automationId and forwards both to the service
- `src/modules/build/core/projects-automations.controller.ts:91` — projectId is passed into the service call
- `src/modules/build/core/projects-automations.service.ts:81` — authorizes the caller against the named projectId only — this can be a project-scoped standing
- `src/modules/build/core/projects-automations.service.ts:92` — fix: the UPDATE's WHERE now re-binds projectId, so a foreign automationId 404s

### CLOSED — `DELETE /build/:projectId/automations/:automationId`

`ProjectsAutomationsController.delete` — `src/modules/build/core/projects-automations.controller.ts:94`

Finding: `parent-binding-missing`

DELETE /build/:projectId/automations/:automationId. Identical defect shape to #update, now fixed the same way: the DELETE's WHERE clause is bound to id+orgId+projectId, so a project-scoped manager of one project can no longer destroy another project's automation by guessing its id.

Blast radius: Was intra-tenant cross-project deletion, non-recoverable through the API; now closed. orgId was always bound, so this was never cross-tenant.

Evidence:

- `src/modules/build/core/projects-automations.controller.ts:99` — handler binds both projectId and automationId and forwards both to the service
- `src/modules/build/core/projects-automations.controller.ts:104` — projectId is passed into the service call
- `src/modules/build/core/projects-automations.service.ts:101` — authorizes the caller against the named projectId only — this can be a project-scoped standing
- `src/modules/build/core/projects-automations.service.ts:108` — fix: the DELETE's WHERE now re-binds projectId, so a foreign automationId 404s

### CLOSED — `PATCH /build/:projectId/custom-fields/:fieldId`

`ProjectsCustomFieldsController.updateField` — `src/modules/build/core/projects-custom-fields.controller.ts:60`

Finding: `parent-binding-missing`

PATCH /build/:projectId/custom-fields/:fieldId. The controller declares no @Param("projectId"), so the path segment is never read; the service UPDATEs on (id, orgId, entityType) only. The same service file's listFields binds customFieldDefinitions.projectId, and the column exists and is NOT NULL — so the omission is asymmetry inside one file, not an absent column. Any :projectId in the URL edits a field owned by any other project in the same org, and the row's own projectId is left untouched.

Blast radius: Intra-tenant, not cross-tenant: orgId is still bound, so the write cannot leave the organisation. The caller already holds org-wide build:manage. The defect is the unverified path segment — it breaks the 404 contract for a foreign :projectId and defeats any project-scoped gate layered on later.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:65` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:143` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:87` — listFields DOES bind projectId — the control proving the column is usable here

### CLOSED — `DELETE /build/:projectId/custom-fields/:fieldId`

`ProjectsCustomFieldsController.deleteField` — `src/modules/build/core/projects-custom-fields.controller.ts:73`

Finding: `parent-binding-missing`

DELETE /build/:projectId/custom-fields/:fieldId. Identical shape to updateField: no @Param("projectId"), and the DELETE where clause is (id, orgId, entityType). Unlike listFields/createField this path does not even call assertProjectInOrg, so a :projectId belonging to another organisation still deletes an in-org field.

Blast radius: Intra-tenant. orgId is bound, so no cross-tenant delete. Cross-PROJECT delete inside the org is reachable by anyone holding build:manage.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:79` — bound to the URL project
- `src/modules/build/core/projects-custom-fields.service.ts:166` — bound to the URL project

### CLOSED — `GET /build/:projectId/tickets/:ticketId/custom-field-values`

`ProjectsCustomFieldsController.getTicketValues` — `src/modules/build/core/projects-custom-fields.controller.ts:86`

Finding: `ticket-data-scope-missing`

GET /build/:projectId/tickets/:ticketId/custom-field-values. Closed: getTicketValues calls assertTicketReadAccess before querying values. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope; the values query then remains scoped to ticketId+orgId.

Blast radius: None: an inaccessible or mismatched ticket is rejected before any custom-field value is read.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:90` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-custom-fields.service.ts:174` — the terminal service receives the authenticated actor and route ids
- `src/modules/build/core/projects-custom-fields.service.ts:175` — canonical ticket authorization runs before the values query
- `src/modules/build/core/build-ticket-read-access.ts:37` — tenant, project, and ticket are bound in one lookup
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `POST /build/:projectId/tickets/:ticketId/custom-field-values`

`ProjectsCustomFieldsController.upsertTicketValues` — `src/modules/build/core/projects-custom-fields.controller.ts:98`

Finding: `ticket-data-scope-missing`

POST /build/:projectId/tickets/:ticketId/custom-field-values. Closed: upsertTicketValues calls assertTicketReadAccess before validating field definitions or writing values. The helper enforces tenant, project membership, URL binding, and ticket DataScope; assertFieldDefinitionsInProject separately binds every body field id to the same project.

Blast radius: None: an inaccessible or mismatched ticket is rejected before validation or mutation, and foreign field definitions are rejected separately.

Evidence:

- `src/modules/build/core/projects-custom-fields.controller.ts:103` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-custom-fields.service.ts:231` — the terminal service receives the authenticated actor and route ids
- `src/modules/build/core/projects-custom-fields.service.ts:237` — canonical ticket authorization runs before validation or mutation
- `src/modules/build/core/projects-custom-fields.service.ts:242` — body field ids are independently bound to the same project
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

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

GET /build/:projectId/tickets/:ticketId/subtasks. Closed: the handler forwards the authenticated actor with projectId and ticketId, and getSubtasks calls assertTicketReadAccess before reading children. That helper binds tenant+project+ticket, verifies project membership, and applies the ticket DataScope predicate.

Blast radius: None: a mismatched ticket 404s, while an inaccessible project or ticket scope is rejected before any subtask row is read.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:68` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:236` — actor-aware ticket authorization runs before the subtask query
- `src/modules/build/core/build-ticket-read-access.ts:37` — the lookup binds tenant, project, and ticket
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `GET /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.getWatchers` — `src/modules/build/core/projects-ticket-associations.controller.ts:115`

Finding: `parent-binding-missing`

GET /build/:projectId/tickets/:ticketId/watchers. Closed: the handler forwards the actor and both route ids, and getWatchers calls assertTicketReadAccess before reading watcher rows. The helper enforces tenant, project membership, route binding, and ticket DataScope.

Blast radius: None: authorization completes before watcher storage is queried.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:120` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:255` — actor-aware authorization runs before the watcher query
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `POST /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.addWatcher` — `src/modules/build/core/projects-ticket-associations.controller.ts:127`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/watchers. Closed: addWatcher receives the actor and both route ids and calls assertTicketReadAccess before resolving the requested organization member or inserting a watcher.

Blast radius: None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:133` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:294` — authorization precedes member resolution and insertion
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/watchers`

`ProjectsTicketAssociationsController.removeWatcher` — `src/modules/build/core/projects-ticket-associations.controller.ts:141`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/watchers. Closed: removeWatcher carries the authenticated actor and calls assertTicketReadAccess before resolving membership and deleting the actor's watcher row.

Blast radius: None: tenant, project membership, route binding, and ticket DataScope are enforced before the delete.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:147` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:342` — authorization precedes the watcher delete
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `POST /build/:projectId/tickets/:ticketId/labels`

`ProjectsTicketAssociationsController.addLabel` — `src/modules/build/core/projects-ticket-associations.controller.ts:154`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/labels. Closed: addLabel receives the actor and both route ids and calls assertTicketReadAccess before inserting a tenant-scoped label mapping.

Blast radius: None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:160` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:372` — authorization precedes the label mapping insert
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `POST /build/:projectId/tickets/:ticketId/attachments`

`ProjectsTicketAssociationsController.addAttachment` — `src/modules/build/core/projects-ticket-associations.controller.ts:182`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/attachments. Closed: addAttachment receives the actor and both route ids and calls assertTicketReadAccess before inserting the tenant-scoped attachment row.

Blast radius: None: tenant, project membership, route binding, and ticket DataScope are enforced before the write.

Evidence:

- `src/modules/build/core/projects-ticket-associations.controller.ts:188` — bound to the URL project
- `src/modules/build/core/projects-ticket-subresources.service.ts:428` — authorization precedes the attachment insert
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### CLOSED — `GET /build/:projectId/tickets/:ticketId/related-links`

`ProjectsTicketAssociationsController.listRelatedLinks` — `src/modules/build/core/projects-ticket-associations.controller.ts:208`

Finding: `project-membership-gate-missing`

GET /build/:projectId/tickets/:ticketId/related-links. The lead was real. ticket_related_links has no project_id column, so the parent could only ever be bound through the ticket; the service did that with a private assertTicketAccess that selected the ticket on (id, orgId) and compared ticket.projectId !== projectId in JavaScript. That comparison did bind the parent for addressing, which is why the static pass — which only recognises a parent reaching an eq() — could not see it. But it was the whole gate: nothing checked that the caller had any access to the project named in the url, and nothing applied the tickets data scope. The direct sibling in the same controller, relations, calls assertTicketReadAccess (projects-ticket-relations.service.ts:61), which binds tickets.projectId in SQL at build-ticket-read-access.ts:37 AND calls resolveProjectAccess at :44. The fix makes assertTicketAccess delegate to that same helper (projects-ticket-links.service.ts:38), so all four related-link methods now enforce the sibling's gate. New spec projects-ticket-links-project-access.spec.ts fails pre-fix with 'promise resolved instead of rejected' and passes after.

Blast radius: Intra-tenant, not cross-tenant: ticketRelatedLinks.orgId was already bound in every query, so nothing left the organisation. The hole was project-level. Any member of the org holding the org-wide build:tickets:view key — with no project membership, no team assignment, not the project manager and without build:manage — could read the related links of any ticket in any project of the org by naming that project and ticket in the url. The paired POST let the same actor, holding build:tickets:update, write a link onto that ticket.

Evidence:

- `src/modules/build/core/projects-ticket-links.service.ts:38` — the fix — the private helper now delegates to the shared gate the sibling already used
- `src/modules/build/core/build-ticket-read-access.ts:37` — the parent is now bound in SQL, not only compared in JavaScript
- `src/modules/build/core/build-ticket-read-access.ts:44` — the project-membership assertion that was entirely absent before
- `src/modules/build/core/projects-ticket-relations.service.ts:61` — the sibling in the same controller whose shape the fix copies

### CLOSED — `POST /build/:projectId/tickets/:ticketId/related-links`

`ProjectsTicketAssociationsController.addRelatedLink` — `src/modules/build/core/projects-ticket-associations.controller.ts:220`

Finding: `project-membership-gate-missing`

POST /build/:projectId/tickets/:ticketId/related-links. Same defect and same fix as listRelatedLinks — both went through the one private assertTicketAccess in projects-ticket-links.service.ts. The INSERT itself was correctly org-bound (orgId: u.orgId at :151) and the parent was bound to the ticket by a JavaScript comparison the static pass cannot read, but no project-access gate ran, so an org-wide build:tickets:update holder could attach a link to a ticket in a project they are not on. assertTicketAccess now delegates to assertTicketReadAccess at :38, matching addRelation in projects-ticket-relations.service.ts. The spec asserts the write is refused AND that db.insert was never called.

Blast radius: Intra-tenant write, not cross-tenant: orgId was and is bound on the insert, so no row can be planted in another organisation. Within the org, any holder of build:tickets:update could write a related link onto any ticket in any project without belonging to it — a stored, user-visible URL on someone else's work item.

Evidence:

- `src/modules/build/core/projects-ticket-links.service.ts:38` — the shared helper both related-link handlers call — now gated
- `src/modules/build/core/projects-ticket-links.service.ts:151` — org was already bound on the INSERT — the org dimension was never the hole
- `src/modules/build/core/build-ticket-read-access.ts:50` — the refusal the outsider now hits

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId`

`ProjectsTicketChecklistsController.updateChecklist` — `src/modules/build/core/projects-ticket-checklists.controller.ts:70`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId. Closed: the handler forwards the actor and every route id; the facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before the update.

Blast radius: None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before mutation.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:502` — project membership and ticket DataScope are enforced in the actor-aware facade
- `src/modules/build/core/projects-ticket-checklists.service.ts:161` — the checklist is bound to the authorized ticket

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId`

`ProjectsTicketChecklistsController.deleteChecklist` — `src/modules/build/core/projects-ticket-checklists.controller.ts:84`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId. Closed: the actor-aware facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before deletion.

Blast radius: None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before deletion.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:518` — project membership and ticket DataScope are enforced in the actor-aware facade
- `src/modules/build/core/projects-ticket-checklists.service.ts:185` — bound to the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/checklists/:checklistId/items`

`ProjectsTicketChecklistsController.createChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:98`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/checklists/:checklistId/items. Closed: the actor-aware facade applies assertTicketReadAccess, then requireChecklistInTicket binds checklistId to the authorized ticket before creating the item.

Blast radius: None: tenant, project membership, ticket DataScope, ticket binding, and checklist binding are all checked before insertion.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:539` — project membership and ticket DataScope are enforced in the actor-aware facade
- `src/modules/build/core/projects-ticket-checklists.service.ts:212` — the checklist is bound to the authorized ticket

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId`

`ProjectsTicketChecklistsController.updateChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:113`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. Closed: the actor-aware facade enforces project membership and ticket DataScope, requireChecklistInTicket binds the checklist to that ticket, and the item lookup and update both bind itemId to checklistId+orgId.

Blast radius: None: every route parent and the item itself are bound before the mutation.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:563` — project membership and ticket DataScope are enforced in the actor-aware facade
- `src/modules/build/core/projects-ticket-checklists.service.ts:243` — the checklist is bound to the authorized ticket
- `src/modules/build/core/projects-ticket-checklists.service.ts:248` — the item is bound to the URL checklist

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId`

`ProjectsTicketChecklistsController.deleteChecklistItem` — `src/modules/build/core/projects-ticket-checklists.controller.ts:128`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId. Closed: the actor-aware facade enforces project membership and ticket DataScope, requireChecklistInTicket binds the checklist to that ticket, and the item lookup and delete bind itemId to checklistId+orgId.

Blast radius: None: every route parent and the item itself are bound before deletion.

Evidence:

- `src/modules/build/core/projects-ticket-subresources.service.ts:581` — project membership and ticket DataScope are enforced in the actor-aware facade
- `src/modules/build/core/projects-ticket-checklists.service.ts:277` — the checklist is bound to the authorized ticket
- `src/modules/build/core/projects-ticket-checklists.service.ts:282` — the item is bound to the URL checklist

### CLOSED — `POST /build/:projectId/tickets/:ticketId/comments`

`ProjectsTicketCommentsController.addComment` — `src/modules/build/core/projects-ticket-comments.controller.ts:43`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/comments. Closed: the handler forwards the actor and route ids, and resolveTicketForComment calls assertTicketReadAccess before resolving the ticket and creating the comment.

Blast radius: None: tenant, project membership, route binding, and ticket DataScope are enforced before the comment write.

Evidence:

- `src/modules/build/core/projects-ticket-comments.controller.ts:54` — the actor and both route ids reach the service
- `src/modules/build/core/projects-ticket-comments.service.ts:42` — actor-aware authorization runs before ticket and comment storage
- `src/modules/build/core/projects-ticket-comments.service.ts:46` — the ticket lookup also binds the URL project

### CLOSED — `POST /build/:projectId/tickets/:ticketId/comments/:commentId/reactions`

`ProjectsTicketCommentsController.addReaction` — `src/modules/build/core/projects-ticket-comments.controller.ts:98`

Finding: `parent-binding-missing`

POST /build/:projectId/tickets/:ticketId/comments/:commentId/reactions. Closed: the handler and facade carry the authenticated actor plus every route id, and the terminal service calls assertTicketReadAccess before binding the comment to ticketId+orgId and inserting the actor's membership-scoped reaction.

Blast radius: None: tenant, project membership, route binding, ticket DataScope, comment binding, and organization membership are enforced before insertion.

Evidence:

- `src/modules/build/core/projects-ticket-comments.controller.ts:103` — handler declares every route parent
- `src/modules/build/core/projects-ticket-comments.controller.ts:110` — the actor and route ids are forwarded together
- `src/modules/build/core/projects-ticket-subresources.service.ts:119` — facade carries the actor and route ids to the terminal service
- `src/modules/build/core/projects-ticket-comments.service.ts:293` — terminal implementation receives the actor
- `src/modules/build/core/projects-ticket-comments.service.ts:295` — project membership and ticket DataScope are enforced before the comment lookup

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji`

`ProjectsTicketCommentsController.removeReaction` — `src/modules/build/core/projects-ticket-comments.controller.ts:113`

Finding: `parent-binding-missing`

DELETE /build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji. Closed: the handler and facade carry the authenticated actor plus every route id, and the terminal service applies assertTicketReadAccess before binding the comment and deleting only the actor membership's tenant-scoped reaction.

Blast radius: None: tenant, project membership, route binding, ticket DataScope, comment binding, and reaction ownership are enforced before deletion.

Evidence:

- `src/modules/build/core/projects-ticket-comments.controller.ts:118` — handler declares every route parent
- `src/modules/build/core/projects-ticket-comments.controller.ts:125` — the actor and route ids are forwarded together
- `src/modules/build/core/projects-ticket-subresources.service.ts:129` — facade carries the actor and route ids to the terminal service
- `src/modules/build/core/projects-ticket-comments.service.ts:316` — terminal implementation receives the actor
- `src/modules/build/core/projects-ticket-comments.service.ts:318` — project membership and ticket DataScope are enforced before the comment lookup

### CLOSED — `GET /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.getTicket` — `src/modules/build/core/projects-tickets.controller.ts:214`

Finding: `parent-binding-missing`

GET /build/:projectId/tickets/:ticketId. Closed: the selector binds ticketId+projectId, readTicket binds orgId and deletedAt, resolves the ticket DataScope, and separately verifies project membership before returning the record.

Blast radius: None: tenant, route binding, project membership, and ticket DataScope are enforced.

Evidence:

- `src/modules/build/core/projects-tickets-detail.service.ts:52` — bound to the URL project
- `src/modules/build/core/projects-tickets-detail.service.ts:61` — the ticket DataScope is resolved
- `src/modules/build/core/projects-tickets-detail.service.ts:100` — project membership is checked before the record is returned

### CLOSED — `PATCH /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.updateTicket` — `src/modules/build/core/projects-tickets.controller.ts:226`

Finding: `parent-binding-missing`

PATCH /build/:projectId/tickets/:ticketId. Closed: the pre-read binds ticketId+projectId+orgId, project access is checked, and authorizeMutation applies the canonical record-level mutation policy before the transaction updates the ticket.

Blast radius: None: tenant, route binding, project membership, and ticket record scope are enforced before mutation.

Evidence:

- `src/modules/build/core/projects-tickets-update.service.ts:197` — bound to the URL project
- `src/modules/build/core/projects-tickets-update.service.ts:272` — canonical record-level mutation authorization runs inside the transaction

### CLOSED — `DELETE /build/:projectId/tickets/:ticketId`

`ProjectsTicketsController.deleteTicket` — `src/modules/build/core/projects-tickets.controller.ts:239`

Finding: `ticket-data-scope-missing`

DELETE /build/:projectId/tickets/:ticketId. Closed: the controller forwards CurrentUserContext, and deleteTicket calls assertTicketReadAccess before its tenant/project-bound pre-read or any delete work. The helper verifies project membership and ticket DataScope.

Blast radius: None: an inaccessible or mismatched ticket is rejected before blocker inspection or deletion.

Evidence:

- `src/modules/build/core/projects-tickets.controller.ts:250` — the complete authenticated actor reaches the service
- `src/modules/build/core/projects-tickets.service.ts:115` — the terminal service accepts CurrentUserContext
- `src/modules/build/core/projects-tickets.service.ts:122` — canonical ticket authorization runs before the pre-read and delete path
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

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

GET /build/:projectId/sprints/:sprintId. The parent-binding gap is moot: the handler is frozen and throws GoneException before any read, so no sprint row is resolved by any key. The route and its @RequirePermission are retained on purpose; only the query body is gone.

Blast radius: None — the handler reads nothing.

Evidence:

- `src/modules/build/execution/sprints.service.ts:24` — every parameter is unused
- `src/modules/build/execution/sprints.service.ts:25` — throws before any query

### CLOSED — `PATCH /build/:projectId/sprints/:sprintId`

`SprintsController.updateSprint` — `src/modules/build/execution/iterations.controller.ts:104`

Finding: `parent-binding-missing`

PATCH /build/:projectId/sprints/:sprintId. The parent-binding gap is moot: the handler is frozen and throws GoneException before any pre-read or UPDATE, so no sprint row is written by any key.

Blast radius: None — the handler writes nothing.

Evidence:

- `src/modules/build/execution/sprints.service.ts:28` — every parameter is unused
- `src/modules/build/execution/sprints.service.ts:35` — throws before any query

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

- `src/modules/build/execution/timesheets.service.ts:424` — bound to the URL project

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

### VERIFIED — `GET /build/:projectId/approvals/:approvalId`

`BuildApprovalsController.getApproval` — `src/modules/build/approvals/approvals.controller.ts:96`

GET /build/:projectId/approvals/:approvalId. The handler declares both @Param("projectId") and @Param("approvalId") and forwards both into ApprovalsReadService.getApproval(u, projectId, approvalId). That method calls assertProjectAccess(u, projectId) and then the shared loadApproval(db, orgId, projectId, approvalId) helper, whose single WHERE clause binds id=approvalId AND orgId=orgId AND projectId=projectId together and throws NotFoundException when they do not all match. A real approval that belongs to a different project (or a different org) 404s; the URL's :projectId is not decorative.

- `src/modules/build/approvals/approvals.controller.ts:100` — handler binds both projectId and approvalId route params and forwards both
- `src/modules/build/approvals/approvals-read.service.ts:77` — projectId is passed into loadApproval alongside approvalId and orgId
- `src/modules/build/approvals/approval-lookup.ts:6` — shared lookup takes projectId as a required parameter
- `src/modules/build/approvals/approval-lookup.ts:11` — WHERE clause binds the approval row to the named project; NotFoundException on any mismatch

### VERIFIED — `PATCH /build/:projectId/approvals/:approvalId/decide`

`BuildApprovalsController.decideApproval` — `src/modules/build/approvals/approvals.controller.ts:122`

PATCH /build/:projectId/approvals/:approvalId/decide. The handler binds projectId+approvalId and calls ApprovalsService.decideApproval(user, projectId, approvalId, input). The method's first statement is loadApproval(this.db, orgId, projectId, approvalId), which binds id+orgId+projectId in one WHERE and 404s on any mismatch — so an approvalId belonging to a different project never reaches the decision logic or the UPDATE below it. The UPDATE itself is keyed by id+orgId only, but approvalId is a global-identity PK already proven by loadApproval to belong to this exact project, so re-stating projectId there would be redundant, not protective (verify-then-act-by-PK pattern, same shape as the loadApproval-gated methods throughout this file).

- `src/modules/build/approvals/approvals.controller.ts:127` — handler binds both projectId and approvalId and forwards both
- `src/modules/build/approvals/approvals.service.ts:162` — first statement binds id+orgId+projectId; 404 on mismatch before any further logic
- `src/modules/build/approvals/approvals.service.ts:183` — mutation keyed by already-verified PK+org
- `src/modules/build/approvals/approval-lookup.ts:11` — loadApproval's project binding

### VERIFIED — `PATCH /build/:projectId/approvals/:approvalId`

`BuildApprovalsController.updateApproval` — `src/modules/build/approvals/approvals.controller.ts:136`

PATCH /build/:projectId/approvals/:approvalId. Same shape as decideApproval: ApprovalsService.updateApproval(orgId, userId, projectId, approvalId, input) opens with loadApproval(this.db, orgId, projectId, approvalId), which binds id+orgId+projectId and 404s on mismatch, before building the patch and running the UPDATE keyed by the now-verified id+orgId.

- `src/modules/build/approvals/approvals.controller.ts:140` — handler binds both projectId and approvalId and forwards both
- `src/modules/build/approvals/approvals.service.ts:206` — binds id+orgId+projectId; 404 on mismatch before the patch is built
- `src/modules/build/approvals/approvals.service.ts:224` — UPDATE keyed by the already-verified PK

### VERIFIED — `DELETE /build/:projectId/approvals/:approvalId`

`BuildApprovalsController.softDeleteApproval` — `src/modules/build/approvals/approvals.controller.ts:149`

DELETE /build/:projectId/approvals/:approvalId. ApprovalsService.softDeleteApproval(orgId, projectId, approvalId) opens with the same loadApproval(this.db, orgId, projectId, approvalId) binding (id+orgId+projectId, 404 on mismatch) before setting deletedAt via an UPDATE keyed by the now-verified id+orgId.

- `src/modules/build/approvals/approvals.controller.ts:154` — handler binds both projectId and approvalId and forwards both
- `src/modules/build/approvals/approvals.service.ts:264` — binds id+orgId+projectId; 404 on mismatch before the delete
- `src/modules/build/approvals/approvals.service.ts:268` — soft-delete UPDATE keyed by the already-verified PK

### VERIFIED — `GET /build/:projectId/change-requests/:changeRequestId/affected-tickets`

`ChangeRequestAffectedItemsController.listAffectedTickets` — `src/modules/build/client-portal/change-request-affected-items.controller.ts:56`

GET /build/:projectId/change-requests/:changeRequestId/affected-tickets. ChangeRequestAffectedItemsService.listAffectedTickets opens with ChangeRequestsService.getChangeRequest(u, projectId, changeRequestId), which asserts project access and binds the change request row to id+orgId+projectId, 404 otherwise. Only after that does it query changeRequestAffectedItems, itself filtered by orgId+changeRequestId — a changeRequestId already proven to belong to this exact project.

- `src/modules/build/client-portal/change-request-affected-items.service.ts:68` — binds the change request to id+orgId+projectId; 404 on mismatch
- `src/modules/build/client-portal/change-requests.service.ts:165` — getChangeRequest's own WHERE re-binds projectId

### VERIFIED — `POST /build/:projectId/change-requests/:changeRequestId/affected-tickets`

`ChangeRequestAffectedItemsController.linkTicket` — `src/modules/build/client-portal/change-request-affected-items.controller.ts:69`

POST /build/:projectId/change-requests/:changeRequestId/affected-tickets. Same getChangeRequest binding as listAffectedTickets, plus a second parent check: the target ticket (from the body, not the URL) is looked up by id+orgId and its own projectId is compared against the URL's projectId (`ticket.projectId !== projectId`), 404 on mismatch — so a caller cannot link a ticket from a different project into this change request either.

- `src/modules/build/client-portal/change-request-affected-items.service.ts:118` — binds the change request to id+orgId+projectId; 404 on mismatch
- `src/modules/build/client-portal/change-request-affected-items.service.ts:125` — explicit compare: the body-supplied ticketId must belong to this exact project too

### VERIFIED — `DELETE /build/:projectId/change-requests/:changeRequestId/affected-tickets/:affectedItemId`

`ChangeRequestAffectedItemsController.unlinkTicket` — `src/modules/build/client-portal/change-request-affected-items.controller.ts:84`

DELETE /build/:projectId/change-requests/:changeRequestId/affected-tickets/:affectedItemId. Same getChangeRequest binding as the other two handlers, then the affected-item row itself is looked up bound to id+orgId+changeRequestId — a changeRequestId already proven to belong to this exact project — before the delete proceeds.

- `src/modules/build/client-portal/change-request-affected-items.service.ts:170` — binds the change request to id+orgId+projectId; 404 on mismatch
- `src/modules/build/client-portal/change-request-affected-items.service.ts:179` — the affected-item lookup re-binds changeRequestId, itself already proven project-scoped

### VERIFIED — `GET /build/:projectId/change-requests/:changeRequestId`

`ChangeRequestsController.getChangeRequest` — `src/modules/build/client-portal/change-requests.controller.ts:69`

GET /build/:projectId/change-requests/:changeRequestId. ChangeRequestsService.getChangeRequest(u, projectId, crId) first calls assertProjectAccess(u, projectId), then SELECTs the row with id=crId AND orgId=u.orgId AND projectId=projectId all in the same WHERE, throwing NotFoundException when no row matches. The :projectId segment is a real predicate on the query, not just a permission check.

- `src/modules/build/client-portal/change-requests.controller.ts:73` — handler binds both projectId and changeRequestId and forwards both
- `src/modules/build/client-portal/change-requests.service.ts:156` — signature takes projectId
- `src/modules/build/client-portal/change-requests.service.ts:163` — SELECT WHERE binds id+orgId+projectId together (see surrounding and(...))

### VERIFIED — `PATCH /build/:projectId/change-requests/:changeRequestId`

`ChangeRequestsController.updateChangeRequest` — `src/modules/build/client-portal/change-requests.controller.ts:94`

PATCH /build/:projectId/change-requests/:changeRequestId. ChangeRequestsService.updateChangeRequest(u, projectId, crId, input) first SELECTs the existing row bound to id+orgId+projectId (404 if it does not match), then the actual UPDATE repeats the identical id+orgId+projectId binding in its own WHERE clause. Both the existence check and the mutation itself are project-scoped, not just the pre-check.

- `src/modules/build/client-portal/change-requests.controller.ts:98` — handler binds both projectId and changeRequestId and forwards both
- `src/modules/build/client-portal/change-requests.service.ts:246` — existence check binds id+orgId+projectId
- `src/modules/build/client-portal/change-requests.service.ts:300` — the UPDATE's own WHERE re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/change-requests/:changeRequestId`

`ChangeRequestsController.deleteChangeRequest` — `src/modules/build/client-portal/change-requests.controller.ts:107`

DELETE /build/:projectId/change-requests/:changeRequestId. Same shape as updateChangeRequest: ChangeRequestsService.deleteChangeRequest(u, projectId, crId) SELECTs the existing row bound to id+orgId+projectId (404 on mismatch), then the soft-delete UPDATE repeats the identical id+orgId+projectId binding.

- `src/modules/build/client-portal/change-requests.controller.ts:112` — handler binds both projectId and changeRequestId and forwards both
- `src/modules/build/client-portal/change-requests.service.ts:338` — existence check binds id+orgId+projectId
- `src/modules/build/client-portal/change-requests.service.ts:351` — soft-delete UPDATE re-binds id+orgId+projectId

### VERIFIED — `PATCH /build/:projectId/client-visibility/tickets/:ticketId`

`ClientVisibilityController.toggleTicketVisibility` — `src/modules/build/client-portal/client-visibility.controller.ts:49`

PATCH /build/:projectId/client-visibility/tickets/:ticketId. ClientVisibilityService.toggleTicketVisibility(orgId, userId, projectId, ticketId, clientVisible) first looks up the ticket bound to id=ticketId AND orgId AND projectId (404 if absent), then the UPDATE is keyed by id+orgId — ticketId is a global PK already proven by the preceding lookup to belong to this exact project, so the UPDATE's narrower key is still safe (verify-then-act-by-PK).

- `src/modules/build/client-portal/client-visibility.controller.ts:53` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/client-portal/client-visibility.service.ts:54` — existence check binds id+orgId+projectId
- `src/modules/build/client-portal/client-visibility.service.ts:61` — UPDATE keyed by the already-verified PK

### VERIFIED — `PATCH /build/:projectId/client-visibility/milestones/:milestoneId`

`ClientVisibilityController.toggleMilestoneVisibility` — `src/modules/build/client-portal/client-visibility.controller.ts:62`

PATCH /build/:projectId/client-visibility/milestones/:milestoneId. Same shape: toggleMilestoneVisibility looks up the milestone bound to id+orgId+projectId (404 if absent) before the UPDATE keyed by the already-verified id+orgId.

- `src/modules/build/client-portal/client-visibility.controller.ts:66` — handler binds both projectId and milestoneId and forwards both
- `src/modules/build/client-portal/client-visibility.service.ts:78` — existence check binds id+orgId+projectId
- `src/modules/build/client-portal/client-visibility.service.ts:89` — UPDATE keyed by the already-verified PK

### VERIFIED — `PATCH /build/:projectId/client-visibility/comments/:commentId`

`ClientVisibilityController.toggleCommentVisibility` — `src/modules/build/client-portal/client-visibility.controller.ts:75`

PATCH /build/:projectId/client-visibility/comments/:commentId. toggleCommentVisibility resolves the comment through an INNER JOIN to tickets that explicitly binds tickets.projectId=projectId AND tickets.orgId=orgId AND ticketComments.id=commentId AND ticketComments.orgId=orgId (404 if no row), before the UPDATE keyed by the already-verified id+orgId. The join is the parent-binding: a comment on a ticket in a different project produces zero rows.

- `src/modules/build/client-portal/client-visibility.controller.ts:79` — handler binds both projectId and commentId and forwards both
- `src/modules/build/client-portal/client-visibility.service.ts:107` — join binds the comment's ticket to the named project via tickets.projectId
- `src/modules/build/client-portal/client-visibility.service.ts:119` — UPDATE keyed by the already-verified PK

### VERIFIED — `PATCH /build/:projectId/client-visibility/attachments/:attachmentId`

`ClientVisibilityController.toggleAttachmentVisibility` — `src/modules/build/client-portal/client-visibility.controller.ts:88`

PATCH /build/:projectId/client-visibility/attachments/:attachmentId. Same join-based binding as toggleCommentVisibility: the attachment is resolved through an INNER JOIN to tickets requiring tickets.projectId=projectId AND tickets.orgId=orgId (404 if no row), before the UPDATE keyed by the already-verified id+orgId.

- `src/modules/build/client-portal/client-visibility.controller.ts:92` — handler binds both projectId and attachmentId and forwards both
- `src/modules/build/client-portal/client-visibility.service.ts:131` — signature carries the authenticated actor and projectId
- `src/modules/build/client-portal/client-visibility.service.ts:139` — join binds the attachment's ticket to the named project

### VERIFIED — `PATCH /build/:projectId/members/:memberUserId`

`ProjectResourcesController.updateMemberRole` — `src/modules/build/core/project-resources.controller.ts:119`

PATCH /build/:projectId/members/:memberUserId. ProjectsMembersService.updateMemberRole(projectId, memberUserId, input, u) calls assertProjectOwnership(orgId, projectId) (404 unless the project belongs to this org) and assertCanManageProject(u, projectId) before resolving memberUserId to a membership via assertOrganizationActor(db, orgId, {userId}), which itself only resolves memberships that belong to orgId. The UPDATE then runs where(projectMembers.projectId=projectId AND projectMembers.membershipId=targetActor.membershipId) — both sides of that predicate are already tenant/project-verified by the time the query runs, and the update 404s (NotFoundException) if the target actor is not actually a member of this specific project.

- `src/modules/build/core/project-resources.controller.ts:123` — handler binds both projectId and memberUserId and forwards both
- `src/modules/build/core/projects-members.service.ts:359` — confirms projectId belongs to this org, 404 otherwise
- `src/modules/build/core/projects-members.service.ts:361` — resolves the target membership scoped to this org
- `src/modules/build/core/projects-members.service.ts:368` — UPDATE's WHERE requires the target membership to belong to this exact project; 404 otherwise

### VERIFIED — `POST /build/:projectId/labels`

`ProjectResourcesController.createProjectLabel` — `src/modules/build/core/project-resources.controller.ts:213`

POST /build/:projectId/labels. Org is bound twice. The handler first calls assertCanManageProject, whose project lookup is predicated on the caller's own org at projects-members.service.ts:71, so a foreign :projectId answers 404 before any write. The write itself is an INSERT into ticket_labels and scopes the row by writing orgId into .values({ orgId, ... }) at projects-labels.service.ts:23. The static pass reports PASSED-UNBOUND because its binding detection is syntactic — it looks for eq()/inArray()/a sql interpolation in a predicate — and an INSERT has no predicate; the ES6 shorthand property `orgId,` in a .values() object is invisible to it. The delegation controller -> ProjectsMembersService.createLabel (a one-line re-export at projects-members.service.ts:434) -> ProjectsLabelsService.createLabel also adds a hop. ticket_labels carries no project_id column, so there is no parent dimension to bind; the :projectId segment is verified for addressing only.

- `src/modules/build/core/project-resources.controller.ts:223` — the url project is resolved under the caller's org before the write
- `src/modules/build/core/projects-members.service.ts:71` — the project lookup that makes a foreign :projectId a 404
- `src/modules/build/core/projects-labels.service.ts:23` — org is bound as an INSERT column, not a predicate — the form the static pass cannot see

### VERIFIED — `POST /build/templates`

`ProjectsTemplatesController.createTemplate` — `src/modules/build/core/projects-templates.controller.ts:46`

POST /build/templates. An org-level route with no :projectId, so there is no parent dimension. The controller forwards u.orgId and the service INSERTs into project_templates with orgId as a column of .values() at projects-templates.service.ts:69, and the nested project_template_tickets rows carry the same orgId. The static pass reports PASSED-UNBOUND for the reason its own documentation gives for create endpoints: an INSERT scopes the row by writing orgId into .values({ orgId, ... }), which is not a predicate, so syntactic eq()/inArray() detection finds nothing. The read-back at the end of the method is keyed on the id just returned by the insert, so it cannot reach another org's row.

- `src/modules/build/core/projects-templates.service.ts:67` — the write is an INSERT — no WHERE clause exists for the static pass to inspect
- `src/modules/build/core/projects-templates.service.ts:69` — org bound as an ES6 shorthand column in .values()

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/relations`

`ProjectsTicketAssociationsController.listRelations` — `src/modules/build/core/projects-ticket-associations.controller.ts:75`

GET /build/:projectId/tickets/:ticketId/relations. ProjectsTicketRelationsService.listRelations(u, projectId, ticketId) opens with assertTicketReadAccess(db, access, u, projectId, ticketId), whose SELECT WHERE binds tickets.orgId=actor.orgId AND tickets.projectId=projectId AND tickets.id=ticketId together and 404s if no row matches, before any relation is queried.

- `src/modules/build/core/projects-ticket-associations.controller.ts:79` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-relations.service.ts:56` — signature
- `src/modules/build/core/build-ticket-read-access.ts:37` — assertTicketReadAccess binds orgId+projectId+ticketId together; 404 (via NotFoundException) on mismatch

### VERIFIED — `POST /build/:projectId/tickets/:ticketId/relations`

`ProjectsTicketAssociationsController.addRelation` — `src/modules/build/core/projects-ticket-associations.controller.ts:87`

POST /build/:projectId/tickets/:ticketId/relations. addRelation(u, projectId, ticketId, body) also opens with assertTicketReadAccess(db, access, u, projectId, ticketId) (id+orgId+projectId bound, 404 on mismatch), and separately re-verifies that body.relatedTicketId belongs to the same projectId+orgId before inserting the relation row.

- `src/modules/build/core/projects-ticket-associations.controller.ts:92` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-relations.service.ts:130` — binds ticketId to this projectId+orgId
- `src/modules/build/core/projects-ticket-relations.service.ts:139` — relatedTicketId is independently bound to the same project before the relation is created

### VERIFIED — `DELETE /build/:projectId/tickets/:ticketId/relations`

`ProjectsTicketAssociationsController.removeRelation` — `src/modules/build/core/projects-ticket-associations.controller.ts:101`

DELETE /build/:projectId/tickets/:ticketId/relations. removeRelation(u, projectId, ticketId, relatedId) opens with the same assertTicketReadAccess binding (id+orgId+projectId, 404 on mismatch) before deleting the workItemRelations edge, which is itself scoped to orgId and to the (already-verified) ticketId on either side of the edge.

- `src/modules/build/core/projects-ticket-associations.controller.ts:106` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-relations.service.ts:210` — signature
- `src/modules/build/core/projects-ticket-relations.service.ts:216` — binds ticketId to this projectId+orgId before the delete

### VERIFIED — `DELETE /build/:projectId/tickets/:ticketId/labels/:labelId`

`ProjectsTicketAssociationsController.removeLabel` — `src/modules/build/core/projects-ticket-associations.controller.ts:168`

DELETE /build/:projectId/tickets/:ticketId/labels/:labelId. ProjectsTicketSubresourcesService.removeLabel receives the actor and calls assertTicketReadAccess before deleting the tenant-scoped mapping. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope.

- `src/modules/build/core/projects-ticket-associations.controller.ts:173` — handler binds projectId, ticketId and labelId and forwards all three
- `src/modules/build/core/projects-ticket-subresources.service.ts:389` — actor-aware authorization runs before deletion
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/git-links`

`ProjectsTicketAssociationsController.getGitLinks` — `src/modules/build/core/projects-ticket-associations.controller.ts:196`

GET /build/:projectId/tickets/:ticketId/git-links. The actor-aware subresource facade calls assertTicketReadAccess before delegating to ProjectsTicketLinksService, so tenant, project membership, route binding, and ticket DataScope are established before git links are queried.

- `src/modules/build/core/projects-ticket-associations.controller.ts:200` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-subresources.service.ts:596` — actor-aware authorization runs before delegation
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### VERIFIED — `PATCH /build/:projectId/tickets/:ticketId/related-links/:linkId`

`ProjectsTicketAssociationsController.updateRelatedLink` — `src/modules/build/core/projects-ticket-associations.controller.ts:234`

PATCH /build/:projectId/tickets/:ticketId/related-links/:linkId. ProjectsTicketLinksService.updateRelatedLink(u, projectId, ticketId, linkId, body) opens with assertTicketAccess (which wraps assertTicketReadAccess: id+orgId+projectId bound, 404 on mismatch), then both the SELECT and the UPDATE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId — the already-verified ticketId is repeated in the mutation's own WHERE, not just the pre-check.

- `src/modules/build/core/projects-ticket-associations.controller.ts:238` — handler binds projectId, ticketId and linkId and forwards all three
- `src/modules/build/core/projects-ticket-links.service.ts:163` — signature
- `src/modules/build/core/projects-ticket-links.service.ts:170` — binds ticketId to this projectId+orgId before any read or write

### VERIFIED — `DELETE /build/:projectId/tickets/:ticketId/related-links/:linkId`

`ProjectsTicketAssociationsController.deleteRelatedLink` — `src/modules/build/core/projects-ticket-associations.controller.ts:248`

DELETE /build/:projectId/tickets/:ticketId/related-links/:linkId. Same shape as updateRelatedLink: deleteRelatedLink(u, projectId, ticketId, linkId) opens with assertTicketAccess (id+orgId+projectId bound, 404 on mismatch), then both the ownership SELECT and the DELETE of ticketRelatedLinks are keyed by orgId+id=linkId+ticketId=ticketId.

- `src/modules/build/core/projects-ticket-associations.controller.ts:253` — handler binds projectId, ticketId and linkId and forwards all three
- `src/modules/build/core/projects-ticket-links.service.ts:205` — signature
- `src/modules/build/core/projects-ticket-links.service.ts:211` — binds ticketId to this projectId+orgId before any read or write

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/checklists`

`ProjectsTicketChecklistsController.getChecklists` — `src/modules/build/core/projects-ticket-checklists.controller.ts:44`

GET /build/:projectId/tickets/:ticketId/checklists. The actor-aware facade calls assertTicketReadAccess before delegating to ProjectsTicketChecklistsService, which independently binds the ticket to projectId+orgId before reading checklist rows.

- `src/modules/build/core/projects-ticket-checklists.controller.ts:48` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-subresources.service.ts:476` — actor-aware project and DataScope authorization runs first
- `src/modules/build/core/projects-ticket-checklists.service.ts:61` — ticket lookup binds id+projectId+orgId; 404 on mismatch

### VERIFIED — `POST /build/:projectId/tickets/:ticketId/checklists`

`ProjectsTicketChecklistsController.createChecklist` — `src/modules/build/core/projects-ticket-checklists.controller.ts:56`

POST /build/:projectId/tickets/:ticketId/checklists. The actor-aware facade calls assertTicketReadAccess, then createChecklist independently binds ticketId to projectId+orgId before inserting the checklist.

- `src/modules/build/core/projects-ticket-checklists.controller.ts:61` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-subresources.service.ts:486` — actor-aware project and DataScope authorization runs first
- `src/modules/build/core/projects-ticket-checklists.service.ts:101` — ticket lookup binds id+projectId+orgId; 404 on mismatch

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/comments/:commentId`

`ProjectsTicketCommentsController.getComment` — `src/modules/build/core/projects-ticket-comments.controller.ts:57`

GET /build/:projectId/tickets/:ticketId/comments/:commentId. getComment calls resolveTicketForComment, which applies assertTicketReadAccess before loading the comment by id+ticketId+orgId. Tenant, project membership, route binding, ticket DataScope, and comment-to-ticket binding are all enforced.

- `src/modules/build/core/projects-ticket-comments.controller.ts:61` — handler binds projectId, ticketId and commentId and forwards all three
- `src/modules/build/core/projects-ticket-comments.service.ts:221` — signature carries the authenticated actor and route parents
- `src/modules/build/core/projects-ticket-comments.service.ts:222` — actor-aware ticket authorization runs before the comment lookup
- `src/modules/build/core/projects-ticket-comments.service.ts:111` — the comment lookup binds commentId to ticketId+orgId

### VERIFIED — `PATCH /build/:projectId/tickets/:ticketId/comments/:commentId`

`ProjectsTicketCommentsController.editComment` — `src/modules/build/core/projects-ticket-comments.controller.ts:70`

PATCH /build/:projectId/tickets/:ticketId/comments/:commentId. editComment first applies actor-aware ticket authorization through resolveTicketForComment, then binds the comment to id+ticketId+orgId, verifies author ownership, and updates the already-verified row.

- `src/modules/build/core/projects-ticket-comments.controller.ts:74` — handler binds projectId, ticketId and commentId and forwards all three
- `src/modules/build/core/projects-ticket-comments.service.ts:228` — signature carries the authenticated actor and route parents
- `src/modules/build/core/projects-ticket-comments.service.ts:229` — actor-aware ticket authorization runs before the comment lookup
- `src/modules/build/core/projects-ticket-comments.service.ts:234` — the comment lookup binds commentId to ticketId+orgId

### VERIFIED — `DELETE /build/:projectId/tickets/:ticketId/comments/:commentId`

`ProjectsTicketCommentsController.deleteComment` — `src/modules/build/core/projects-ticket-comments.controller.ts:84`

DELETE /build/:projectId/tickets/:ticketId/comments/:commentId. deleteComment first applies actor-aware ticket authorization through resolveTicketForComment, then binds the comment to id+ticketId+orgId, verifies author ownership, and soft-deletes it and its replies within the tenant.

- `src/modules/build/core/projects-ticket-comments.controller.ts:89` — handler binds projectId, ticketId and commentId and forwards all three
- `src/modules/build/core/projects-ticket-comments.service.ts:257` — signature carries the authenticated actor and route parents
- `src/modules/build/core/projects-ticket-comments.service.ts:258` — actor-aware ticket authorization runs before the comment lookup
- `src/modules/build/core/projects-ticket-comments.service.ts:263` — the comment lookup binds commentId to ticketId+orgId

### VERIFIED — `PATCH /build/:projectId/tickets/:ticketId/rank`

`ProjectsTicketsController.rankTicket` — `src/modules/build/core/projects-tickets.controller.ts:173`

PATCH /build/:projectId/tickets/:ticketId/rank. The controller forwards to ProjectsTicketsService.rankTicket → the standalone rankTicket() helper in projects-tickets-rank-utils.ts. That helper authorizes and locks against the named projectId, reads the mutation candidates via readMutationTickets(tx, actor, projectId, ids, policy), and — decisively — the final UPDATE itself binds `eq(tickets.orgId, actor.orgId), eq(tickets.projectId, projectId), eq(tickets.id, ticketId)` all together, throwing NotFoundException if no row matches. The mutation, not just a pre-check, re-asserts the parent binding.

- `src/modules/build/core/projects-tickets.controller.ts:177` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-tickets-rank-utils.ts:26` — signature takes projectId
- `src/modules/build/core/projects-tickets-rank-utils.ts:70` — the actual UPDATE's WHERE binds orgId+projectId+id together; 404 on mismatch

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/activity`

`ProjectsTicketsController.getActivity` — `src/modules/build/core/projects-tickets.controller.ts:186`

GET /build/:projectId/tickets/:ticketId/activity. The controller forwards the actor and both route ids to getActivity, which calls assertTicketReadAccess before querying activity. The helper binds tenant+project+ticket, verifies project membership, and applies ticket DataScope.

- `src/modules/build/core/projects-tickets.controller.ts:190` — handler binds both projectId and ticketId and forwards both
- `src/modules/build/core/projects-ticket-subresources.service.ts:143` — signature carries the actor and route ids
- `src/modules/build/core/build-ticket-read-access.ts:37` — assertTicketReadAccess binds orgId+projectId+id together; 404 on mismatch
- `src/modules/build/core/build-ticket-read-access.ts:50` — project membership and ticket DataScope are both enforced

### VERIFIED — `GET /build/:projectId/tickets/key/:ticketNumber`

`ProjectsTicketsController.getTicketByKey` — `src/modules/build/core/projects-tickets.controller.ts:202`

GET /build/:projectId/tickets/key/:ticketNumber. getTicketByKey passes a projectId+ticketNumber selector into readTicket; readTicket adds orgId, resolves ticket DataScope, and verifies project membership before returning the ticket.

- `src/modules/build/core/projects-tickets.controller.ts:206` — handler binds both projectId and ticketNumber and forwards both
- `src/modules/build/core/projects-tickets-detail.service.ts:33` — signature
- `src/modules/build/core/projects-tickets-detail.service.ts:42` — selector binds the lookup to the named project
- `src/modules/build/core/projects-tickets-detail.service.ts:61` — ticket DataScope is resolved
- `src/modules/build/core/projects-tickets-detail.service.ts:100` — project membership is verified

### VERIFIED — `GET /build/:projectId/webhooks/:webhookId/deliveries`

`ProjectsWebhooksController.listDeliveries` — `src/modules/build/core/projects-webhooks.controller.ts:72`

GET /build/:projectId/webhooks/:webhookId/deliveries. ProjectsWebhooksService.listDeliveries(orgId, projectId, webhookId) opens with assertWebhookOwnership(orgId, projectId, webhookId), whose WHERE binds id=webhookId AND orgId=orgId AND projectId=projectId together and 404s on mismatch, before querying webhookDeliveries filtered by the already-verified webhookId.

- `src/modules/build/core/projects-webhooks.controller.ts:76` — handler binds both projectId and webhookId and forwards both
- `src/modules/build/core/projects-webhooks.service.ts:83` — signature takes projectId
- `src/modules/build/core/projects-webhooks.service.ts:68` — ownership check binds id+orgId+projectId; 404 on mismatch

### VERIFIED — `POST /build/:projectId/webhooks/:webhookId/test`

`ProjectsWebhooksController.sendTest` — `src/modules/build/core/projects-webhooks.controller.ts:84`

POST /build/:projectId/webhooks/:webhookId/test. The controller itself calls `await this.webhooks.assertWebhookOwnership(u.orgId, projectId, webhookId)` (id+orgId+projectId bound, 404 on mismatch) BEFORE calling `this.dispatch.sendTest(u.orgId, projectId, webhookId)`. Belt-and-suspenders: sendTest's own SELECT independently re-binds id=webhookId AND orgId=orgId AND projectId=projectId and returns a no-op failure result if the row is absent.

- `src/modules/build/core/projects-webhooks.controller.ts:90` — handler binds both projectId and webhookId
- `src/modules/build/core/projects-webhooks.controller.ts:95` — controller-level ownership check runs before dispatch.sendTest
- `src/modules/build/core/projects-webhooks-dispatch.service.ts:328` — signature

### VERIFIED — `POST /build/labels`

`ProjectsController.createLabel` — `src/modules/build/core/projects.controller.ts:106`

POST /build/labels. An org-level route with no path parameters at all, so there is no parent dimension. The controller passes u.orgId straight through ProjectsMembersService.createLabel (a one-line re-export) to ProjectsLabelsService.createLabel, which INSERTs into ticket_labels with orgId as a column of .values() at projects-labels.service.ts:23. PASSED-UNBOUND is the expected reading for a create endpoint: the binding is an INSERT column, not a predicate, and the static pass only recognises eq()/inArray()/sql interpolation inside a WHERE. ticket_labels is org-scoped by design — it carries no project_id — so this route and #createProjectLabel write the same kind of row.

- `src/modules/build/core/projects.controller.ts:115` — the org passed is the caller's own, taken from the verified context
- `src/modules/build/core/projects-labels.service.ts:23` — org bound as an INSERT column

### VERIFIED — `GET /build/:projectId/sprints`

`SprintsController.listSprints` — `src/modules/build/execution/iterations.controller.ts:67`

GET /build/:projectId/sprints. The lead is vacuous: there is no query to bind. The sprints table was dropped when Build cut over to the Cycle model, and SprintsService is a tombstone — every method, listSprints included, throws GoneException with the FROZEN message declared at sprints.service.ts:7 and never touches the database. The static pass follows the handler into a service method that accepts _orgId and _projectId and never uses them, which is exactly the shape of PASSED-UNBOUND; it cannot tell a 410 stub from an unbound query. The live route is /build/:projectId/cycles.

- `src/modules/build/execution/sprints.service.ts:7` — the tombstone message — the sprints table no longer exists
- `src/modules/build/execution/sprints.service.ts:17` — listSprints body in full — no query, so nothing to bind

### VERIFIED — `POST /build/:projectId/sprints`

`SprintsController.createSprint` — `src/modules/build/execution/iterations.controller.ts:78`

POST /build/:projectId/sprints. Same tombstone as listSprints: createSprint's entire body is a GoneException throw at sprints.service.ts:21, so no INSERT exists and the orgId and projectId the controller forwards are discarded parameters (_orgId, _projectId). The static pass reads unused forwarded parameters as PASSED-UNBOUND. Cycle creation, the live replacement, is POST /build/:projectId/cycles on CyclesController.

- `src/modules/build/execution/sprints.service.ts:21` — createSprint body in full — no INSERT is reachable

### VERIFIED — `DELETE /build/:projectId/sprints/:sprintId`

`SprintsController.deleteSprint` — `src/modules/build/execution/iterations.controller.ts:117`

DELETE /build/:projectId/sprints/:sprintId. Flagged on BOTH org and parent scoping, and both leads are vacuous for the same reason: deleteSprint's body is a single GoneException throw at sprints.service.ts:39. No DELETE statement exists, so neither orgId nor projectId can appear in a predicate. The static pass sees three forwarded-and-unused parameters and reports each unbound dimension.

- `src/modules/build/execution/sprints.service.ts:39` — deleteSprint body in full — no DELETE is reachable
- `src/modules/build/execution/sprints.service.ts:7` — the model that replaced sprints; the sprints table was dropped

### VERIFIED — `PATCH /build/:projectId/cycles/:cycleId`

`CyclesController.updateCycle` — `src/modules/build/execution/iterations.controller.ts:163`

PATCH /build/:projectId/cycles/:cycleId. CyclesService.updateCycle(orgId, projectId, cycleId, input) confirms the project exists in this org, then the actual UPDATE's WHERE binds `eq(cycles.id, cycleId), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)` directly — the mutation itself, not just a pre-check, requires the cycle to belong to the named project.

- `src/modules/build/execution/iterations.controller.ts:167` — handler binds both projectId and cycleId and forwards both
- `src/modules/build/execution/cycles.service.ts:109` — signature takes projectId
- `src/modules/build/execution/cycles.service.ts:127` — UPDATE's own WHERE binds id+projectId+orgId

### VERIFIED — `DELETE /build/:projectId/cycles/:cycleId`

`CyclesController.deleteCycle` — `src/modules/build/execution/iterations.controller.ts:176`

DELETE /build/:projectId/cycles/:cycleId. Same shape as updateCycle: CyclesService.deleteCycle(orgId, projectId, cycleId) confirms the project exists in this org, then the DELETE's own WHERE binds `eq(cycles.id, cycleId), eq(cycles.projectId, projectId), eq(cycles.orgId, orgId)` directly, 404ing if zero rows are removed.

- `src/modules/build/execution/iterations.controller.ts:181` — handler binds both projectId and cycleId and forwards both
- `src/modules/build/execution/cycles.service.ts:134` — signature takes projectId
- `src/modules/build/execution/cycles.service.ts:140` — DELETE's own WHERE binds id+projectId+orgId

### VERIFIED — `PATCH /build/:projectId/epics/:epicId`

`EpicsController.updateEpic` — `src/modules/build/execution/iterations.controller.ts:277`

PATCH /build/:projectId/epics/:epicId. EpicsService.updateEpic(orgId, projectId, epicId, input) runs the UPDATE directly with WHERE `eq(tickets.id, epicId), eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), eq(tickets.type, "EPIC")` — the mutation itself binds the epic to the named project, no separate pre-check needed.

- `src/modules/build/execution/iterations.controller.ts:281` — handler binds both projectId and epicId and forwards both
- `src/modules/build/execution/epics.service.ts:61` — signature takes projectId
- `src/modules/build/execution/epics.service.ts:67` — UPDATE's own WHERE binds id+orgId+projectId+type

### VERIFIED — `DELETE /build/:projectId/epics/:epicId`

`EpicsController.deleteEpic` — `src/modules/build/execution/iterations.controller.ts:290`

DELETE /build/:projectId/epics/:epicId. EpicsService.deleteEpic(orgId, projectId, epicId) first looks up the epic bound to id+orgId+projectId+type=EPIC (404 if absent), then deletes it by id+orgId — epicId is a global PK already proven by the preceding lookup to belong to this exact project, so the narrower delete key is still safe (verify-then-act-by-PK).

- `src/modules/build/execution/iterations.controller.ts:295` — handler binds both projectId and epicId and forwards both
- `src/modules/build/execution/epics.service.ts:78` — signature takes projectId
- `src/modules/build/execution/epics.service.ts:81` — existence check binds id+orgId+projectId+type; 404 on mismatch

### VERIFIED — `GET /build/:projectId/tickets/:ticketId/time-entries`

`TicketTimeEntriesController.listTicketTimeEntries` — `src/modules/build/execution/timesheets.controller.ts:158`

GET /build/:projectId/tickets/:ticketId/time-entries. The parent is genuinely bound, three times over. listTicketTimeEntries is a one-line adapter at timesheets.service.ts:410 that repacks its positional projectId and ticketId into the query object of listTimeEntries; that is why the static pass loses the trail, since it follows the named method and never sees projectId reach an eq(). Inside listTimeEntries the project is resolved under the caller's org by assertProjectInOrg at :75, the ticket must belong to that project at :79, and the entry list itself carries eq(timesheets.projectId, query.projectId) at :109. Org is bound at :87, and the row set is further narrowed by the timesheets scope predicate, so a caller without 'all' scope sees only their own entries. Residual noted and deliberately not changed: there is no project-membership assert here, but the identical rows are already reachable through the org-level GET /build/time-entries?projectId=&ticketId= on the same service method, so gating only the project-addressed route would close nothing.

- `src/modules/build/execution/timesheets.service.ts:410` — the repack that hides the parent from a static reader following the named method
- `src/modules/build/execution/timesheets.service.ts:79` — the ticket must belong to the url project — a foreign pairing 404s
- `src/modules/build/execution/timesheets.service.ts:109` — the parent is bound in the list predicate itself
- `src/modules/build/execution/timesheets.service.ts:75` — the url project is resolved under the caller's org first

### VERIFIED — `PATCH /build/:projectId/whiteboards/:whiteboardId/sharing`

`WhiteboardSharingController.updateSharing` — `src/modules/build/execution/whiteboard-sharing.controller.ts:57`

PATCH /build/:projectId/whiteboards/:whiteboardId/sharing. WhiteboardSharingService.updateSharing(u, projectId, whiteboardId, input) opens with requireWhiteboardManageAccess(db, access, u, projectId, whiteboardId), whose SELECT WHERE binds `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)` together and 404s on mismatch, before the sharing settings are updated by the already-verified id+orgId.

- `src/modules/build/execution/whiteboard-sharing.controller.ts:61` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboard-sharing.service.ts:46` — binds whiteboardId to this projectId+orgId before any mutation
- `src/modules/build/execution/whiteboard-board-helpers.ts:46` — signature takes projectId; its WHERE (a few lines below) binds id+projectId+orgId, 404 on mismatch

### VERIFIED — `POST /build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token`

`WhiteboardSharingController.rotateShareToken` — `src/modules/build/execution/whiteboard-sharing.controller.ts:70`

POST /build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token. Same requireWhiteboardManageAccess binding as updateSharing (id+projectId+orgId, 404 on mismatch) before the share token is rotated by the already-verified id+orgId.

- `src/modules/build/execution/whiteboard-sharing.controller.ts:76` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboard-sharing.service.ts:84` — binds whiteboardId to this projectId+orgId before rotating the token

### VERIFIED — `PUT /build/:projectId/whiteboards/:whiteboardId/shares`

`WhiteboardSharingController.setShares` — `src/modules/build/execution/whiteboard-sharing.controller.ts:84`

PUT /build/:projectId/whiteboards/:whiteboardId/shares. Same requireWhiteboardManageAccess binding (id+projectId+orgId, 404 on mismatch) before the whiteboard's share rows are replaced; the replace transaction itself is scoped to the already-verified whiteboardId.

- `src/modules/build/execution/whiteboard-sharing.controller.ts:88` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboard-sharing.service.ts:108` — binds whiteboardId to this projectId+orgId before the share rows are replaced

### VERIFIED — `DELETE /build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId`

`WhiteboardSharingController.removeShare` — `src/modules/build/execution/whiteboard-sharing.controller.ts:97`

DELETE /build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId. Same requireWhiteboardManageAccess binding (id+projectId+orgId, 404 on mismatch) before the share row for targetUserId is removed; the DELETE itself is scoped to the already-verified whiteboardId and to a membership subquery scoped to u.orgId.

- `src/modules/build/execution/whiteboard-sharing.controller.ts:102` — handler binds projectId, whiteboardId and targetUserId and forwards all three
- `src/modules/build/execution/whiteboard-sharing.service.ts:174` — binds whiteboardId to this projectId+orgId before the delete

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

### VERIFIED — `POST /build/views`

`WorkspaceViewsController.createWorkspaceView` — `src/modules/build/execution/workspace.controller.ts:238`

POST on the workspace views controller. An org-level route with no :projectId, and the row is deliberately project-less: the INSERT into project_views sets projectId: null and scope: 'workspace' explicitly (workspace.service.ts:316) and binds the tenant by writing orgId as a column at :317. PASSED-UNBOUND is the documented false reading for create endpoints — the binding is an INSERT column, not a predicate. The sibling readers and mutators of the same table (listWorkspaceViews, updateWorkspaceView, deleteWorkspaceView) all bind eq(projectViews.orgId, orgId) in their WHERE clauses and additionally refuse a private view the caller does not own.

- `src/modules/build/execution/workspace.service.ts:316` — the row is intentionally project-less, so there is no parent dimension
- `src/modules/build/execution/workspace.service.ts:317` — org bound as an ES6 shorthand column in .values()

### VERIFIED — `GET /build/:projectId/whiteboards/:whiteboardId`

`WhiteboardsController.getWhiteboard` — `src/modules/build/execution/workspace.controller.ts:319`

GET /build/:projectId/whiteboards/:whiteboardId. WhiteboardsService.getWhiteboard(u, projectId, whiteboardId) confirms the project exists in this org, then loadBoardWithAccess's SELECT WHERE binds `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)` together and throws NotFoundException on mismatch, before the DTO is built.

- `src/modules/build/execution/workspace.controller.ts:323` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboards.service.ts:202` — signature takes projectId
- `src/modules/build/execution/whiteboards.service.ts:64` — private helper's WHERE (a few lines below) binds id+projectId+orgId together; 404 on mismatch

### VERIFIED — `PATCH /build/:projectId/whiteboards/:whiteboardId`

`WhiteboardsController.updateWhiteboard` — `src/modules/build/execution/workspace.controller.ts:331`

PATCH /build/:projectId/whiteboards/:whiteboardId. WhiteboardsService.updateWhiteboard(u, projectId, whiteboardId, input) calls loadBoardWithAccess (id+projectId+orgId, 404 on mismatch) for the access-level check, and the subsequent UPDATE independently repeats the identical binding in its own WHERE: `eq(projectWhiteboards.id, whiteboardId), eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, u.orgId)`.

- `src/modules/build/execution/workspace.controller.ts:335` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboards.service.ts:229` — signature
- `src/modules/build/execution/whiteboards.service.ts:253` — the UPDATE's own WHERE re-binds id+projectId+orgId

### VERIFIED — `DELETE /build/:projectId/whiteboards/:whiteboardId`

`WhiteboardsController.deleteWhiteboard` — `src/modules/build/execution/workspace.controller.ts:344`

DELETE /build/:projectId/whiteboards/:whiteboardId. Same shape as updateWhiteboard: deleteWhiteboard(u, projectId, whiteboardId) calls loadBoardWithAccess (id+projectId+orgId, 404 on mismatch), and the soft-delete UPDATE independently repeats the identical id+projectId+orgId binding in its own WHERE.

- `src/modules/build/execution/workspace.controller.ts:349` — handler binds both projectId and whiteboardId and forwards both
- `src/modules/build/execution/whiteboards.service.ts:266` — signature takes projectId
- `src/modules/build/execution/whiteboards.service.ts:280` — the soft-delete UPDATE's own WHERE re-binds id+projectId+orgId

### VERIFIED — `GET /build/:projectId/files/:fileId/url`

`FilesController.getSignedUrl` — `src/modules/build/files/files.controller.ts:73`

GET /build/:projectId/files/:fileId/url. FilesService.getSignedUrl(u, projectId, fileId) confirms project access, then loadFile(orgId, projectId, fileId) binds id=fileId AND orgId=orgId AND projectId=projectId together (404 on mismatch) before the signed URL is generated from the already-verified row's storageKey.

- `src/modules/build/files/files.controller.ts:77` — handler binds both projectId and fileId and forwards both
- `src/modules/build/files/files.service.ts:167` — signature takes projectId
- `src/modules/build/files/files.service.ts:64` — loadFile's WHERE (a few lines below) binds id+orgId+projectId together; 404 on mismatch

### VERIFIED — `DELETE /build/:projectId/files/:fileId`

`FilesController.softDeleteFile` — `src/modules/build/files/files.controller.ts:85`

DELETE /build/:projectId/files/:fileId. FilesService.softDeleteFile(u, projectId, fileId) also opens with loadFile(orgId, projectId, fileId) (id+orgId+projectId bound, 404 on mismatch), checks uploader/manage authority, and the soft-delete UPDATE independently repeats the identical id+orgId+projectId binding in its own WHERE.

- `src/modules/build/files/files.controller.ts:90` — handler binds both projectId and fileId and forwards both
- `src/modules/build/files/files.service.ts:174` — signature takes projectId
- `src/modules/build/files/files.service.ts:188` — the soft-delete UPDATE's own WHERE re-binds id+orgId+projectId

### VERIFIED — `GET /build/:projectId/forms/:formId`

`FormsController.getForm` — `src/modules/build/forms/forms.controller.ts:54`

GET /build/:projectId/forms/:formId. FormsService.getForm(u, projectId, formId) delegates directly to loadForm(orgId, projectId, formId), whose WHERE binds id=formId AND orgId=orgId AND projectId=projectId together and throws NotFoundException on mismatch.

- `src/modules/build/forms/forms.controller.ts:58` — handler binds both projectId and formId and forwards both
- `src/modules/build/forms/forms.service.ts:72` — signature takes projectId
- `src/modules/build/forms/forms.service.ts:24` — loadForm's WHERE (a few lines below) binds id+orgId+projectId together; 404 on mismatch

### VERIFIED — `PATCH /build/:projectId/forms/:formId`

`FormsController.updateForm` — `src/modules/build/forms/forms.controller.ts:79`

PATCH /build/:projectId/forms/:formId. FormsService.updateForm(u, projectId, formId, input) opens with loadForm(orgId, projectId, formId) (id+orgId+projectId bound, 404 on mismatch) before building the patch and running the UPDATE keyed by the now-verified id+orgId (formId is a global PK already proven to belong to this exact project — verify-then-act-by-PK).

- `src/modules/build/forms/forms.controller.ts:83` — handler binds both projectId and formId and forwards both
- `src/modules/build/forms/forms.service.ts:114` — signature takes projectId
- `src/modules/build/forms/forms.service.ts:116` — binds id+orgId+projectId; 404 on mismatch before any patch logic runs

### VERIFIED — `DELETE /build/:projectId/forms/:formId`

`FormsController.deleteForm` — `src/modules/build/forms/forms.controller.ts:92`

DELETE /build/:projectId/forms/:formId. Same shape as updateForm: FormsService.deleteForm(u, projectId, formId) opens with loadForm(orgId, projectId, formId) (id+orgId+projectId bound, 404 on mismatch) before the soft-delete UPDATE keyed by the now-verified id+orgId.

- `src/modules/build/forms/forms.controller.ts:97` — handler binds both projectId and formId and forwards both
- `src/modules/build/forms/forms.service.ts:153` — signature takes projectId
- `src/modules/build/forms/forms.service.ts:155` — binds id+orgId+projectId; 404 on mismatch before the delete

### VERIFIED — `GET /build/:projectId/forms/:formId/submissions`

`SubmissionsController.listSubmissions` — `src/modules/build/forms/submissions.controller.ts:57`

GET /build/:projectId/forms/:formId/submissions. The handler forwards CurrentUserContext, listSubmissions asserts project membership, and loadForm binds formId+orgId+projectId before the tenant/form-scoped submissions query runs.

- `src/modules/build/forms/submissions.controller.ts:67` — route handler forwards the actor and path params
- `src/modules/build/forms/submissions.service.ts:154` — project membership is enforced
- `src/modules/build/forms/submissions.service.ts:155` — listSubmissions binds via loadForm before querying
- `src/modules/build/forms/submissions.service.ts:39` — loadForm's WHERE binds formId to projectId and orgId together

### VERIFIED — `POST /build/:projectId/forms/:formId/submissions`

`SubmissionsController.createSubmission` — `src/modules/build/forms/submissions.controller.ts:70`

POST /build/:projectId/forms/:formId/submissions. The handler forwards CurrentUserContext, createSubmission asserts project membership, and loadForm binds formId+orgId+projectId. runSubmission derives every insert key from that validated form row.

- `src/modules/build/forms/submissions.controller.ts:81` — route handler forwards the actor and path params
- `src/modules/build/forms/submissions.service.ts:188` — project membership is enforced
- `src/modules/build/forms/submissions.service.ts:189` — createSubmission binds via loadForm before running the submission
- `src/modules/build/forms/submissions.service.ts:78` — runSubmission derives tenant and parent ids from the validated row

### VERIFIED — `PATCH /build/:projectId/forms/:formId/submissions/:submissionId`

`SubmissionsController.updateSubmission` — `src/modules/build/forms/submissions.controller.ts:84`

PATCH /build/:projectId/forms/:formId/submissions/:submissionId. The handler forwards CurrentUserContext, updateSubmission asserts project membership, loadForm binds the form to project+tenant, loadSubmission binds the submission to form+tenant, and the UPDATE repeats id+orgId+formId.

- `src/modules/build/forms/submissions.controller.ts:95` — route handler forwards the actor and all path params
- `src/modules/build/forms/submissions.service.ts:241` — project membership is enforced
- `src/modules/build/forms/submissions.service.ts:242` — binds formId to projectId
- `src/modules/build/forms/submissions.service.ts:243` — binds submissionId to formId
- `src/modules/build/forms/submissions.service.ts:250` — UPDATE WHERE clause re-binds formId

### VERIFIED — `POST /public/build-forms/:publicToken/submissions`

`SubmissionsPublicController.submitPublicForm` — `src/modules/build/forms/submissions.controller.ts:106`

POST /public/build-forms/:publicToken/submissions. Unauthenticated by design and IP rate-limited. One withPublicToken transaction resolves the active public form and performs capacity reservation, ticket allocation/inserts, and the submission insert under the same token-scoped RLS context. orgId and projectId come only from the resolved form row. The plaintext token comparison remains a storage hardening opportunity, not an access-control defect.

- `src/modules/build/forms/submissions.service.ts:50` — resolved by token inside withPublicToken; orgId derived from the row
- `src/modules/build/forms/submissions.service.ts:51` — non-public forms are not reachable through this route
- `src/modules/build/forms/submissions.service.ts:207` — lookup and every write share one token-scoped transaction
- `src/modules/build/forms/submissions.service.ts:209` — the existing token transaction is passed into the write path

### VERIFIED — `GET /build/:projectId/decisions/:decisionId`

`DecisionsController.getDecision` — `src/modules/build/governance/decisions.controller.ts:54`

GET /build/:projectId/decisions/:decisionId. getDecision calls assertProjectAccess(projectId) (404 if the project isn't in the caller's org) then loadDecision(orgId, projectId, decisionId), whose WHERE binds id=decisionId AND orgId AND projectId together. A decisionId belonging to another project 404s.

- `src/modules/build/governance/decisions.controller.ts:63` — route handler passes raw path params straight to the service
- `src/modules/build/governance/decisions.service.ts:72` — getDecision delegates to loadDecision
- `src/modules/build/governance/decisions.service.ts:41` — loadDecision's WHERE binds decisionId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/decisions/:decisionId`

`DecisionsController.updateDecision` — `src/modules/build/governance/decisions.controller.ts:79`

PATCH /build/:projectId/decisions/:decisionId. updateDecision calls assertProjectAccess(projectId), then loadDecision(orgId, projectId, decisionId) (404 on mismatch), then the UPDATE's own WHERE independently re-binds id+orgId+projectId. Both the pre-check and the write itself scope the row to the named project.

- `src/modules/build/governance/decisions.controller.ts:89` — route handler passes raw path params straight to the service
- `src/modules/build/governance/decisions.service.ts:122` — binds decisionId to projectId via loadDecision before patching
- `src/modules/build/governance/decisions.service.ts:137` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/decisions/:decisionId`

`DecisionsController.softDeleteDecision` — `src/modules/build/governance/decisions.controller.ts:92`

DELETE /build/:projectId/decisions/:decisionId (soft delete). Same binding as updateDecision: assertProjectAccess + loadDecision(orgId, projectId, decisionId) 404s a foreign decisionId, and the soft-delete UPDATE's own WHERE independently repeats id+orgId+projectId.

- `src/modules/build/governance/decisions.controller.ts:102` — route handler passes raw path params straight to the service
- `src/modules/build/governance/decisions.service.ts:154` — binds decisionId to projectId via loadDecision before deleting
- `src/modules/build/governance/decisions.service.ts:158` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `GET /build/:projectId/risks/:riskId`

`RisksController.getRisk` — `src/modules/build/governance/risks.controller.ts:72`

GET /build/:projectId/risks/:riskId. getRisk calls assertProjectAccess(projectId) then loadRisk(orgId, projectId, riskId), whose WHERE binds id=riskId AND orgId AND projectId. A riskId from another project 404s.

- `src/modules/build/governance/risks.controller.ts:81` — route handler passes raw path params straight to the service
- `src/modules/build/governance/risks.service.ts:125` — getRisk delegates to loadRisk
- `src/modules/build/governance/risks.service.ts:33` — loadRisk's WHERE binds riskId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/risks/:riskId`

`RisksController.updateRisk` — `src/modules/build/governance/risks.controller.ts:97`

PATCH /build/:projectId/risks/:riskId. updateRisk calls assertProjectAccess(projectId) then loadRisk(orgId, projectId, riskId) before patching, and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/governance/risks.controller.ts:107` — route handler passes raw path params straight to the service
- `src/modules/build/governance/risks.service.ts:174` — binds riskId to projectId via loadRisk before patching
- `src/modules/build/governance/risks.service.ts:188` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/risks/:riskId`

`RisksController.softDeleteRisk` — `src/modules/build/governance/risks.controller.ts:110`

DELETE /build/:projectId/risks/:riskId (soft delete). Same binding as updateRisk: assertProjectAccess + loadRisk(orgId, projectId, riskId) 404s a foreign riskId, and the soft-delete UPDATE's own WHERE independently repeats id+orgId+projectId.

- `src/modules/build/governance/risks.controller.ts:120` — route handler passes raw path params straight to the service
- `src/modules/build/governance/risks.service.ts:205` — binds riskId to projectId via loadRisk before deleting
- `src/modules/build/governance/risks.service.ts:209` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `GET /build/:projectId/incidents/:incidentId`

`IncidentsController.getIncident` — `src/modules/build/incidents/incidents.controller.ts:86`

GET /build/:projectId/incidents/:incidentId. getIncident calls assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId), whose WHERE binds id=incidentId AND orgId AND projectId. A foreign incidentId 404s before the bounded child-resource queries run.

- `src/modules/build/incidents/incidents.controller.ts:96` — route handler passes both path params and the validated child query to the service
- `src/modules/build/incidents/incidents.service.ts:116` — getIncident binds via loadIncident before reading child resources
- `src/modules/build/incidents/incidents.service.ts:50` — loadIncident's WHERE binds incidentId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/incidents/:incidentId`

`IncidentsController.updateIncident` — `src/modules/build/incidents/incidents.controller.ts:112`

PATCH /build/:projectId/incidents/:incidentId. updateIncident calls assertProjectAccess(projectId), then binds via loadIncident(orgId, projectId, incidentId) (404 on a foreign incidentId), and the subsequent UPDATE's own WHERE independently re-binds id+orgId+projectId inside the same transaction.

- `src/modules/build/incidents/incidents.controller.ts:122` — route handler passes raw path params straight to the service
- `src/modules/build/incidents/incidents.service.ts:167` — project-membership gate
- `src/modules/build/incidents/incidents.service.ts:168` — binds incidentId to projectId via loadIncident before patching
- `src/modules/build/incidents/incidents.service.ts:208` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/incidents/:incidentId`

`IncidentsController.deleteIncident` — `src/modules/build/incidents/incidents.controller.ts:125`

DELETE /build/:projectId/incidents/:incidentId (soft delete). deleteIncident calls assertProjectAccess(projectId), then loadIncident(orgId, projectId, incidentId) 404s a foreign incidentId, and the soft-delete UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/incidents/incidents.controller.ts:135` — route handler passes raw path params straight to the service
- `src/modules/build/incidents/incidents.service.ts:284` — project-membership gate
- `src/modules/build/incidents/incidents.service.ts:285` — binds incidentId to projectId via loadIncident before deleting
- `src/modules/build/incidents/incidents.service.ts:293` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `POST /build/:projectId/incidents/:incidentId/updates`

`IncidentsController.addUpdate` — `src/modules/build/incidents/incidents.controller.ts:138`

POST /build/:projectId/incidents/:incidentId/updates. addUpdate calls assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) (404 on mismatch) before inserting the incidentUpdates row and, when the status changes, updating projectIncidents with a WHERE that independently re-binds id+orgId+projectId — all inside one transaction.

- `src/modules/build/incidents/incidents.controller.ts:149` — route handler passes raw path params straight to the service
- `src/modules/build/incidents/incidents.service.ts:313` — binds incidentId to projectId via loadIncident before writing
- `src/modules/build/incidents/incidents.service.ts:344` — in-transaction status UPDATE independently re-binds id+orgId+projectId

### VERIFIED — `POST /build/:projectId/incidents/:incidentId/decisions`

`IncidentsController.addDecision` — `src/modules/build/incidents/incidents.controller.ts:152`

POST /build/:projectId/incidents/:incidentId/decisions. addDecision calls assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) — the same helper proven elsewhere in this file to bind id+orgId+projectId together, 404 on mismatch — before inserting the decision row, which is itself scoped to the now-confirmed incidentId+orgId.

- `src/modules/build/incidents/incidents.service.ts:399` — project-membership gate
- `src/modules/build/incidents/incidents.service.ts:400` — binds incidentId to projectId via loadIncident before writing

### VERIFIED — `POST /build/:projectId/incidents/:incidentId/follow-ups`

`IncidentsController.addFollowUpAction` — `src/modules/build/incidents/incidents.controller.ts:166`

POST /build/:projectId/incidents/:incidentId/follow-ups. Same binding shape as addDecision: assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) before inserting the follow-up-action row.

- `src/modules/build/incidents/incidents.service.ts:430` — project-membership gate
- `src/modules/build/incidents/incidents.service.ts:431` — binds incidentId to projectId via loadIncident before writing

### VERIFIED — `PATCH /build/:projectId/incidents/:incidentId/follow-ups/:followUpActionId`

`IncidentsController.updateFollowUpAction` — `src/modules/build/incidents/incidents.controller.ts:180`

PATCH /build/:projectId/incidents/:incidentId/follow-ups/:followUpActionId. assertProjectAccess(projectId) then loadIncident(orgId, projectId, incidentId) bind the parent incident to this project; the UPDATE's own WHERE independently re-binds id=followUpActionId AND orgId AND incidentId, so a foreign followUpActionId (even one belonging to a different incident in the same org) 404s rather than matching.

- `src/modules/build/incidents/incidents.service.ts:464` — project-membership gate
- `src/modules/build/incidents/incidents.service.ts:465` — binds incidentId to projectId via loadIncident before updating
- `src/modules/build/incidents/incidents.service.ts:481` — UPDATE WHERE independently re-binds id+orgId+incidentId

### VERIFIED — `POST /build/managed-products`

`ManagedProductsController.createManagedProduct` — `src/modules/build/managed-products/managed-products.controller.ts:65`

POST /build/managed-products. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into managed_products with orgId as a column of .values() at managed-products.service.ts:83; the unique-key conflict it catches is the per-org key constraint, which is itself evidence the row is org-scoped. PASSED-UNBOUND is the expected static reading because an INSERT carries no predicate for eq() detection. The sibling updateManagedProduct binds eq(managedProducts.orgId, orgId) in its WHERE, so the table's org column is genuinely the tenant key.

- `src/modules/build/managed-products/managed-products.service.ts:81` — an INSERT — no WHERE clause exists to carry a predicate
- `src/modules/build/managed-products/managed-products.service.ts:83` — org bound as an ES6 shorthand column in .values()

### VERIFIED — `POST /build/:projectId/meetings/:meetingId/action-items`

`ActionItemsController.createItem` — `src/modules/build/meetings/action-items.controller.ts:39`

POST /build/:projectId/meetings/:meetingId/action-items. createItem calls assertMeeting(orgId, projectId, meetingId), whose WHERE binds id=meetingId AND orgId AND projectId, before inserting the action item. A meetingId belonging to another project 404s before any row is written.

- `src/modules/build/meetings/action-items.controller.ts:50` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/action-items.service.ts:62` — createItem binds via assertMeeting before inserting
- `src/modules/build/meetings/action-items.service.ts:34` — assertMeeting's WHERE binds meetingId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/meetings/:meetingId/action-items/:itemId`

`ActionItemsController.updateItem` — `src/modules/build/meetings/action-items.controller.ts:53`

PATCH /build/:projectId/meetings/:meetingId/action-items/:itemId — three route params. updateItem binds all three: assertMeeting(orgId, projectId, meetingId) confirms the meeting belongs to the project, then loadItem(orgId, meetingId, itemId) confirms the item belongs to that meeting and org (404 otherwise). The final UPDATE's WHERE only re-checks id+orgId (not meetingId), but that is safe: loadItem already proved this exact primary-key row belongs to the named meeting, meetingId is never reassigned by any other endpoint in this file, and the UPDATE targets the row by its immutable primary key — so it can only ever touch the row already confirmed to be under the right parent.

- `src/modules/build/meetings/action-items.controller.ts:64` — route handler passes all three raw path params straight to the service
- `src/modules/build/meetings/action-items.service.ts:96` — binds meetingId to projectId via assertMeeting
- `src/modules/build/meetings/action-items.service.ts:97` — binds itemId to meetingId via loadItem before patching
- `src/modules/build/meetings/action-items.service.ts:107` — UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `DELETE /build/:projectId/meetings/:meetingId/action-items/:itemId`

`ActionItemsController.deleteItem` — `src/modules/build/meetings/action-items.controller.ts:67`

DELETE /build/:projectId/meetings/:meetingId/action-items/:itemId. Same binding shape as updateItem: assertMeeting(orgId, projectId, meetingId) then loadItem(orgId, meetingId, itemId) 404s a foreign itemId or meetingId before the soft-delete UPDATE runs, which targets the already-verified row by primary key.

- `src/modules/build/meetings/action-items.controller.ts:78` — route handler passes all three raw path params straight to the service
- `src/modules/build/meetings/action-items.service.ts:122` — binds meetingId to projectId via assertMeeting
- `src/modules/build/meetings/action-items.service.ts:123` — binds itemId to meetingId via loadItem before deleting
- `src/modules/build/meetings/action-items.service.ts:127` — soft-delete UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `POST /build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task`

`ActionItemsController.convertToTask` — `src/modules/build/meetings/action-items.controller.ts:81`

POST /build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task. convertToTask does its own inline binding inside one transaction: it looks up the meeting by id/org/project (404 otherwise), then the action item by id/org/meetingId (404 otherwise), and only then creates the ticket and updates the action item row (WHERE id=itemId AND orgId, targeting the row already proven to belong to the right meeting/project in the same transaction).

- `src/modules/build/meetings/action-items.controller.ts:93` — route handler passes all three raw path params straight to the service
- `src/modules/build/meetings/action-items.service.ts:144` — inline meeting lookup binds meetingId to projectId and orgId
- `src/modules/build/meetings/action-items.service.ts:155` — inline item lookup binds itemId to meetingId and orgId
- `src/modules/build/meetings/action-items.service.ts:187` — final UPDATE targets the already-verified row by primary key id + orgId, inside the same transaction

### VERIFIED — `GET /build/:projectId/meetings/:meetingId`

`MeetingsController.getMeeting` — `src/modules/build/meetings/meetings.controller.ts:67`

GET /build/:projectId/meetings/:meetingId. getMeeting calls assertProjectAccess(projectId) then loadMeeting(orgId, projectId, meetingId), whose WHERE binds id=meetingId AND orgId AND projectId. The attendees/action-items/standup queries that follow are filtered by meetingId+orgId, which is safe because meetingId was already proven to belong to this project.

- `src/modules/build/meetings/meetings.controller.ts:76` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:173` — getMeeting binds via loadMeeting before reading child rows
- `src/modules/build/meetings/meetings.service.ts:57` — loadMeeting's WHERE binds meetingId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/meetings/:meetingId`

`MeetingsController.updateMeeting` — `src/modules/build/meetings/meetings.controller.ts:92`

PATCH /build/:projectId/meetings/:meetingId. updateMeeting binds via loadMeeting(orgId, projectId, meetingId) (404 on a foreign meetingId) before the UPDATE, which targets the row by primary key id + orgId — safe because meetingId was already proven bound to this project. NOTE: like updateIncident/deleteIncident, this handler does not call assertProjectAccess (unlike getMeeting/listMeetings/createMeeting in the same file); that is a project-membership-scoping asymmetry, not a parent-binding gap — the object itself is still correctly scoped and a cross-project meetingId still 404s.

- `src/modules/build/meetings/meetings.controller.ts:102` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:283` — binds meetingId to projectId via loadMeeting; no assertProjectAccess call precedes it
- `src/modules/build/meetings/meetings.service.ts:299` — UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `DELETE /build/:projectId/meetings/:meetingId`

`MeetingsController.deleteMeeting` — `src/modules/build/meetings/meetings.controller.ts:105`

DELETE /build/:projectId/meetings/:meetingId (soft delete). Same shape as updateMeeting: loadMeeting(orgId, projectId, meetingId) 404s a foreign meetingId, and the soft-delete UPDATE targets the already-verified row by primary key. Also skips assertProjectAccess like updateMeeting (see that entry's note).

- `src/modules/build/meetings/meetings.controller.ts:115` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:314` — binds meetingId to projectId via loadMeeting; no assertProjectAccess call precedes it
- `src/modules/build/meetings/meetings.service.ts:318` — soft-delete UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `POST /build/:projectId/meetings/:meetingId/attendees`

`MeetingsController.addAttendee` — `src/modules/build/meetings/meetings.controller.ts:118`

POST /build/:projectId/meetings/:meetingId/attendees. addAttendee binds via loadMeeting(orgId, projectId, meetingId) (404 on a foreign meetingId), then additionally resolves the target user to a project member of this exact projectId (a project-membership subquery scoped by orgId) before inserting the attendee row — so both the meeting and the attendee being added are independently proven to belong to this project/org.

- `src/modules/build/meetings/meetings.controller.ts:129` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:330` — binds meetingId to projectId via loadMeeting
- `src/modules/build/meetings/meetings.service.ts:334` — resolves the attendee to a member of this exact projectId, scoped by orgId, before inserting

### VERIFIED — `DELETE /build/:projectId/meetings/:meetingId/attendees/:attendeeUserId`

`MeetingsController.removeAttendee` — `src/modules/build/meetings/meetings.controller.ts:132`

DELETE /build/:projectId/meetings/:meetingId/attendees/:attendeeUserId. removeAttendee binds via loadMeeting(orgId, projectId, meetingId) (404 on a foreign meetingId), then the DELETE's WHERE scopes to meetingId + a membership subquery filtered by orgId + the named attendeeUserId — meetingId was already proven to belong to the named project.

- `src/modules/build/meetings/meetings.controller.ts:143` — route handler passes all three raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:349` — binds meetingId to projectId via loadMeeting
- `src/modules/build/meetings/meetings.service.ts:356` — DELETE WHERE clause re-binds orgId alongside meetingId

### VERIFIED — `PUT /build/:projectId/meetings/:meetingId/standup`

`MeetingsController.upsertStandup` — `src/modules/build/meetings/meetings.controller.ts:146`

PUT /build/:projectId/meetings/:meetingId/standup. upsertStandup binds via loadMeeting(orgId, projectId, meetingId) (404 on a foreign meetingId) before the insert/onConflictDoUpdate, whose conflict target is (meetingId, userId) — meetingId was already proven to belong to this project, so the upsert can only ever touch a standup entry scoped to this meeting.

- `src/modules/build/meetings/meetings.controller.ts:156` — route handler passes raw path params straight to the service
- `src/modules/build/meetings/meetings.service.ts:362` — binds meetingId to projectId via loadMeeting before the upsert

### VERIFIED — `POST /build/portfolios`

`PortfoliosController.createPortfolio` — `src/modules/build/portfolios/portfolios.controller.ts:75`

POST /build/portfolios. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into project_portfolios with orgId as a column of .values() and records createdBy from the verified context. PASSED-UNBOUND is the documented create-endpoint reading: the binding is an INSERT column and the static pass only recognises predicates. The sibling updatePortfolio binds eq(projectPortfolios.orgId, orgId) in its WHERE, confirming the column is the tenant key.

- `src/modules/build/portfolios/portfolios.service.ts:237` — an INSERT — no WHERE clause exists to carry a predicate
- `src/modules/build/portfolios/portfolios.service.ts:239` — org bound as an ES6 shorthand column in .values()

### VERIFIED — `DELETE /build/portfolios/:portfolioId/projects/:projectId`

`PortfoliosController.unlinkProject` — `src/modules/build/portfolios/portfolios.controller.ts:124`

DELETE /build/portfolios/:portfolioId/projects/:projectId. unlinkProject calls loadPortfolio(orgId, portfolioId) first, whose WHERE binds id=portfolioId AND orgId (404 on a foreign portfolioId), then deletes the link row scoped by portfolioId+projectId+orgId. Because portfolioId is already proven to belong to this org, and orgId is repeated on the delete, a projectId belonging to another org's portfolio simply matches zero rows — it can never unlink a link row outside the caller's own org, and cannot affect the project row itself (only the join-table association).

- `src/modules/build/portfolios/portfolios.controller.ts:134` — route handler passes both raw path params straight to the service
- `src/modules/build/portfolios/portfolios.service.ts:349` — binds portfolioId to orgId via loadPortfolio before the delete
- `src/modules/build/portfolios/portfolios.service.ts:356` — DELETE WHERE clause scopes to portfolioId + projectId + orgId together

### VERIFIED — `DELETE /build/programs/:programId/projects/:projectId`

`ProgramsController.unlinkProject` — `src/modules/build/portfolios/programs.controller.ts:124`

DELETE /build/programs/:programId/projects/:projectId. Structurally identical to portfolios#unlinkProject: loadProgram(orgId, programId) binds programId to orgId (404 on a foreign programId), then the DELETE's WHERE scopes to programId+projectId+orgId. A projectId belonging to another org's program matches zero rows.

- `src/modules/build/portfolios/programs.controller.ts:134` — route handler passes both raw path params straight to the service
- `src/modules/build/portfolios/programs.service.ts:433` — binds programId to orgId via loadProgram before the delete
- `src/modules/build/portfolios/programs.service.ts:440` — DELETE WHERE clause scopes to programId + projectId + orgId together

### VERIFIED — `GET /build/:projectId/bugs/:bugId`

`BugsController.getBug` — `src/modules/build/qa/bugs.controller.ts:59`

GET /build/:projectId/bugs/:bugId. getBug calls assertProjectAccess(projectId) then selects the ticket WHERE id=bugId AND orgId AND projectId AND type='BUG' (not deleted), throwing NotFoundException on zero rows. A bugId belonging to another project 404s.

- `src/modules/build/qa/bugs.controller.ts:68` — route handler passes raw path params straight to the service
- `src/modules/build/qa/bugs.service.ts:118` — SELECT WHERE clause binds bugId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/bugs/:bugId`

`BugsController.updateBug` — `src/modules/build/qa/bugs.controller.ts:84`

PATCH /build/:projectId/bugs/:bugId. updateBug calls assertProjectAccess(projectId) then an existence check WHERE id=bugId AND orgId AND projectId AND type='BUG' (404 otherwise) before touching anything. The subsequent tickets UPDATE and workItemQaDetails UPDATE both target the row by primary key (bugId/workItemId) + orgId — safe because bugId was already proven bound to this project.

- `src/modules/build/qa/bugs.controller.ts:94` — route handler passes raw path params straight to the service
- `src/modules/build/qa/bugs.service.ts:225` — existence check binds bugId to projectId and orgId before patching
- `src/modules/build/qa/bugs.service.ts:268` — tickets UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `DELETE /build/:projectId/bugs/:bugId`

`BugsController.deleteBug` — `src/modules/build/qa/bugs.controller.ts:97`

DELETE /build/:projectId/bugs/:bugId (soft delete). deleteBug calls assertProjectAccess(projectId) then an existence check WHERE id=bugId AND orgId AND projectId AND type='BUG' (404 otherwise) before the soft-delete UPDATE, which targets the row by primary key id + orgId.

- `src/modules/build/qa/bugs.controller.ts:107` — route handler passes raw path params straight to the service
- `src/modules/build/qa/bugs.service.ts:324` — existence check binds bugId to projectId and orgId before deleting
- `src/modules/build/qa/bugs.service.ts:334` — soft-delete UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `GET /build/:projectId/test-cases/:caseId`

`TestCasesController.getCase` — `src/modules/build/qa/test-cases.controller.ts:54`

GET /build/:projectId/test-cases/:caseId. getCase calls assertProjectAccess(projectId) then queries testCases WHERE id=caseId AND orgId AND projectId (not deleted), throwing NotFoundException on zero rows.

- `src/modules/build/qa/test-cases.controller.ts:63` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-management.service.ts:181` — SELECT WHERE clause binds caseId to projectId and orgId together

### VERIFIED — `PATCH /build/:projectId/test-cases/:caseId`

`TestCasesController.updateCase` — `src/modules/build/qa/test-cases.controller.ts:79`

PATCH /build/:projectId/test-cases/:caseId. updateCase calls assertProjectAccess(projectId) then an existence check WHERE id=caseId AND orgId AND projectId (404 otherwise), and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-cases.controller.ts:89` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-management.service.ts:232` — existence check binds caseId to projectId and orgId before patching
- `src/modules/build/qa/test-management.service.ts:252` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/test-cases/:caseId`

`TestCasesController.deleteCase` — `src/modules/build/qa/test-cases.controller.ts:92`

DELETE /build/:projectId/test-cases/:caseId (soft delete). deleteCase calls assertProjectAccess(projectId) then an existence check WHERE id=caseId AND orgId AND projectId (404 otherwise), and the soft-delete UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-cases.controller.ts:102` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-management.service.ts:264` — existence check binds caseId to projectId and orgId before deleting
- `src/modules/build/qa/test-management.service.ts:273` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `GET /build/:projectId/test-runs/:runId`

`TestRunsController.getRun` — `src/modules/build/qa/test-runs.controller.ts:82`

GET /build/:projectId/test-runs/:runId. getRun calls assertProjectAccess(projectId) then queries testRuns WHERE id=runId AND orgId AND projectId (not deleted), throwing NotFoundException on zero rows. The joined results query that follows filters by runId+orgId, safe because runId was already proven bound to this project.

- `src/modules/build/qa/test-runs.controller.ts:91` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:109` — SELECT WHERE clause binds runId to projectId and orgId together

### VERIFIED — `GET /build/:projectId/test-runs/:runId/results`

`TestRunsController.listRunResults` — `src/modules/build/qa/test-runs.controller.ts:94`

GET /build/:projectId/test-runs/:runId/results. listRunResults calls assertProjectAccess(projectId) then an explicit existence check WHERE id=runId AND orgId AND projectId (404 otherwise) before listing results filtered by runId+orgId — safe because runId was already proven bound to this project.

- `src/modules/build/qa/test-runs.controller.ts:104` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:149` — existence check binds runId to projectId and orgId before listing results

### VERIFIED — `PATCH /build/:projectId/test-runs/:runId`

`TestRunsController.updateRun` — `src/modules/build/qa/test-runs.controller.ts:120`

PATCH /build/:projectId/test-runs/:runId. updateRun calls assertProjectAccess(projectId) then an existence check WHERE id=runId AND orgId AND projectId (404 otherwise), and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-runs.controller.ts:130` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:281` — existence check binds runId to projectId and orgId before patching
- `src/modules/build/qa/test-runs.service.ts:303` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/test-runs/:runId`

`TestRunsController.deleteRun` — `src/modules/build/qa/test-runs.controller.ts:133`

DELETE /build/:projectId/test-runs/:runId (soft delete). deleteRun calls assertProjectAccess(projectId) then an existence check WHERE id=runId AND orgId AND projectId (404 otherwise), and the soft-delete UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-runs.controller.ts:143` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:325` — existence check binds runId to projectId and orgId before deleting
- `src/modules/build/qa/test-runs.service.ts:334` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `PATCH /build/:projectId/test-runs/:runId/results/:resultId`

`TestRunsController.updateResult` — `src/modules/build/qa/test-runs.controller.ts:146`

PATCH /build/:projectId/test-runs/:runId/results/:resultId — three route params. updateResult calls assertProjectAccess(projectId) then an existence check whose WHERE binds ALL of id=resultId, runId, orgId AND projectId in one query (404 if any mismatch), and the subsequent UPDATE's WHERE re-binds id+orgId+projectId, targeting the row already proven to belong to the named run.

- `src/modules/build/qa/test-runs.controller.ts:157` — route handler passes all three raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:351` — existence check binds resultId to runId, orgId, and projectId together in one WHERE
- `src/modules/build/qa/test-runs.service.ts:370` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `POST /build/:projectId/test-runs/:runId/results/:resultId/bug`

`TestRunsController.createBugFromResult` — `src/modules/build/qa/test-runs.controller.ts:160`

POST /build/:projectId/test-runs/:runId/results/:resultId/bug. createBugFromResultConsolidated calls assertProjectAccess(projectId) then binds resultId to runId+orgId+projectId in one WHERE (404 otherwise). The linked test case is then looked up by the *result row's own* testCaseId (a trusted DB value, not a client-supplied param) scoped to orgId. The final testRunResults UPDATE (linking the new ticket) targets the row by primary key id + orgId — safe because resultId was already proven bound to this run/project.

- `src/modules/build/qa/test-runs.controller.ts:172` — route handler passes all three raw path params straight to the service
- `src/modules/build/qa/test-runs.service.ts:390` — existence check binds resultId to runId, orgId, and projectId together in one WHERE
- `src/modules/build/qa/test-runs.service.ts:396` — linked test case is resolved from the already-validated result row's own testCaseId, not a client param

### VERIFIED — `PATCH /build/:projectId/test-suites/:suiteId`

`TestSuitesController.updateSuite` — `src/modules/build/qa/test-suites.controller.ts:67`

PATCH /build/:projectId/test-suites/:suiteId. updateSuite calls assertProjectAccess(projectId) then an existence check WHERE id=suiteId AND orgId AND projectId (404 otherwise), and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-suites.controller.ts:77` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-management.service.ts:114` — existence check binds suiteId to projectId and orgId before patching
- `src/modules/build/qa/test-management.service.ts:128` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/test-suites/:suiteId`

`TestSuitesController.deleteSuite` — `src/modules/build/qa/test-suites.controller.ts:80`

DELETE /build/:projectId/test-suites/:suiteId (soft delete). deleteSuite calls assertProjectAccess(projectId) then an existence check WHERE id=suiteId AND orgId AND projectId (404 otherwise), and the soft-delete UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/qa/test-suites.controller.ts:90` — route handler passes raw path params straight to the service
- `src/modules/build/qa/test-management.service.ts:140` — existence check binds suiteId to projectId and orgId before deleting
- `src/modules/build/qa/test-management.service.ts:149` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `POST /build/teams`

`TeamsController.createTeam` — `src/modules/build/teams/teams.controller.ts:90`

POST /build/teams. An org-level route with no path parameters, so no parent dimension exists. The service INSERTs into project_teams with orgId as a column of .values() at teams.service.ts:135, and the unique-violation branch it catches reports the key clash as per-organisation, which is what the org-scoped unique index enforces. PASSED-UNBOUND is the expected reading for a create endpoint. The sibling updateTeam binds eq(projectTeams.orgId, orgId) in its WHERE.

- `src/modules/build/teams/teams.service.ts:133` — an INSERT — no WHERE clause exists to carry a predicate
- `src/modules/build/teams/teams.service.ts:135` — org bound as an ES6 shorthand column in .values()

### VERIFIED — `PATCH /build/teams/:teamId/members/:memberUserId`

`TeamsController.updateMemberRole` — `src/modules/build/teams/teams.controller.ts:151`

PATCH /build/teams/:teamId/members/:memberUserId. updateMemberRole calls teams.loadTeam(orgId, teamId) (WHERE id=teamId AND orgId, 404 otherwise), then resolves memberUserId to a membership via assertOrganizationActor(db, orgId, ...) — which itself queries organizationMembers scoped to that exact orgId and throws if the user isn't a member of this org. The UPDATE's WHERE then binds teamId + that org-scoped membershipId + orgId together.

- `src/modules/build/teams/teams.controller.ts:161` — route handler passes teamId and memberUserId straight to the service
- `src/modules/build/teams/team-members.service.ts:166` — binds teamId to orgId via loadTeam before updating
- `src/modules/build/teams/team-members.service.ts:175` — memberUserId is resolved to a membership scoped to this exact orgId via assertOrganizationActor

### VERIFIED — `DELETE /build/teams/:teamId/members/:memberId`

`TeamsController.removeMember` — `src/modules/build/teams/teams.controller.ts:170`

DELETE /build/teams/:teamId/members/:memberId. Same binding shape as updateMemberRole: teams.loadTeam(orgId, teamId) binds teamId to orgId (404 otherwise), and memberId is resolved to an org-scoped membership via assertOrganizationActor before the DELETE's WHERE binds teamId + membershipId + orgId together.

- `src/modules/build/teams/teams.controller.ts:180` — route handler passes teamId and memberId straight to the service
- `src/modules/build/teams/team-members.service.ts:136` — binds teamId to orgId via loadTeam before deleting
- `src/modules/build/teams/team-members.service.ts:144` — memberId is resolved to a membership scoped to this exact orgId via assertOrganizationActor

### VERIFIED — `DELETE /build/teams/:teamId/projects/:projectId`

`TeamsController.removeProject` — `src/modules/build/teams/teams.controller.ts:207`

DELETE /build/teams/:teamId/projects/:projectId. removeProject calls teams.loadTeam(orgId, teamId), whose WHERE binds id=teamId AND orgId (404 on a foreign teamId), then deletes the assignment row scoped by teamId+projectId+orgId. Because teamId is already proven to belong to this org and orgId is repeated on the delete, a projectId belonging to another team/org simply matches zero rows.

- `src/modules/build/teams/teams.controller.ts:217` — route handler passes teamId and projectId straight to the service
- `src/modules/build/teams/team-projects.service.ts:91` — binds teamId to orgId via loadTeam before deleting
- `src/modules/build/teams/team-projects.service.ts:97` — DELETE WHERE clause scopes to teamId + projectId + orgId together

### VERIFIED — `PATCH /build/:projectId/updates/:updateId`

`UpdatesController.editUpdate` — `src/modules/build/updates/updates.controller.ts:71`

PATCH /build/:projectId/updates/:updateId. editUpdate calls assertProjectAccess(projectId) then loadUpdate(orgId, projectId, updateId), whose WHERE binds id=updateId AND orgId AND projectId (not deleted) — 404 on a foreign updateId — followed by an authorship/permission check, and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/updates/updates.controller.ts:81` — route handler passes raw path params straight to the service
- `src/modules/build/updates/updates.service.ts:117` — binds updateId to projectId via loadUpdate before patching
- `src/modules/build/updates/updates.service.ts:131` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/updates/:updateId`

`UpdatesController.softDeleteUpdate` — `src/modules/build/updates/updates.controller.ts:84`

DELETE /build/:projectId/updates/:updateId (soft delete). softDeleteUpdate calls assertProjectAccess(projectId) then loadUpdate(orgId, projectId, updateId) (404 on a foreign updateId) followed by an authorship/permission check, then the soft-delete UPDATE targets the row by primary key id + orgId — safe because updateId was already proven bound to this project.

- `src/modules/build/updates/updates.controller.ts:94` — route handler passes raw path params straight to the service
- `src/modules/build/updates/updates.service.ts:150` — binds updateId to projectId via loadUpdate before deleting
- `src/modules/build/updates/updates.service.ts:160` — soft-delete UPDATE targets the already-verified row by primary key id + orgId

### VERIFIED — `PATCH /build/:projectId/workflow/transitions/:transitionId`

`WorkflowController.updateTransition` — `src/modules/build/workflow/workflow.controller.ts:69`

PATCH /build/:projectId/workflow/transitions/:transitionId. updateTransition calls assertProjectAccess(projectId) then loadTransition(orgId, projectId, transitionId), whose WHERE binds id=transitionId AND orgId AND projectId (not deleted) — 404 on a foreign transitionId — and the UPDATE's own WHERE independently re-binds id+orgId+projectId. Any changed fromStatusId/toStatusId are additionally re-validated against this project via assertStatusInProject.

- `src/modules/build/workflow/workflow.controller.ts:79` — route handler passes raw path params straight to the service
- `src/modules/build/workflow/workflow.service.ts:110` — binds transitionId to projectId via loadTransition before patching
- `src/modules/build/workflow/workflow.service.ts:132` — UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `DELETE /build/:projectId/workflow/transitions/:transitionId`

`WorkflowController.deleteTransition` — `src/modules/build/workflow/workflow.controller.ts:82`

DELETE /build/:projectId/workflow/transitions/:transitionId (soft delete). deleteTransition calls assertProjectAccess(projectId) then loadTransition(orgId, projectId, transitionId) (404 on a foreign transitionId), and the soft-delete UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/workflow/workflow.controller.ts:92` — route handler passes raw path params straight to the service
- `src/modules/build/workflow/workflow.service.ts:150` — binds transitionId to projectId via loadTransition before deleting
- `src/modules/build/workflow/workflow.service.ts:157` — soft-delete UPDATE WHERE clause independently re-binds id+orgId+projectId

### VERIFIED — `GET /build/:projectId/workflow/allowed/:fromStatusId`

`WorkflowController.getAllowedTransitions` — `src/modules/build/workflow/workflow.controller.ts:95`

GET /build/:projectId/workflow/allowed/:fromStatusId. getAllowedTransitions calls assertProjectAccess(projectId) then queries workflowTransitions filtered directly by orgId+projectId (not deleted), with fromStatusId used only inside an OR-predicate that further narrows which already-org/project-scoped rows come back. fromStatusId is never independently existence-checked, but a nonexistent or foreign fromStatusId cannot widen the result set beyond org+project — it can only return fewer or zero rows.

- `src/modules/build/workflow/workflow.controller.ts:104` — route handler passes raw path params straight to the service
- `src/modules/build/workflow/workflow.service.ts:176` — query is unconditionally filtered by orgId and projectId before the fromStatusId OR-predicate is applied

### VERIFIED — `PATCH /build/:projectId/workflow/statuses/:statusId/wip`

`WorkflowController.updateWipLimit` — `src/modules/build/workflow/workflow.controller.ts:107`

PATCH /build/:projectId/workflow/statuses/:statusId/wip. updateWipLimit calls assertProjectAccess(projectId) then assertStatusInProject(orgId, projectId, statusId), whose WHERE binds id=statusId AND projectId AND orgId (404 on a foreign statusId), and the UPDATE's own WHERE independently re-binds id+orgId+projectId.

- `src/modules/build/workflow/workflow.controller.ts:117` — route handler passes raw path params straight to the service
- `src/modules/build/workflow/workflow.service.ts:190` — binds statusId to projectId via assertStatusInProject before patching
- `src/modules/build/workflow/workflow.service.ts:197` — UPDATE WHERE clause independently re-binds id+orgId+projectId

## Every handler

| verdict | verb | route | controller:line | method | classification | module | guard chain | org scoping | parent scoping | @Validate params | @Idempotent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLOSED | PATCH | `/build/:projectId/custom-states/:stateId` | `src/modules/build/core/project-resources.controller.ts:168` | `updateCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, stateId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/custom-states/:stateId` | `src/modules/build/core/project-resources.controller.ts:181` | `deleteCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, stateId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/automations/:automationId` | `src/modules/build/core/projects-automations.controller.ts:81` | `update` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, automationId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/automations/:automationId` | `src/modules/build/core/projects-automations.controller.ts:94` | `delete` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, automationId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/custom-fields/:fieldId` | `src/modules/build/core/projects-custom-fields.controller.ts:60` | `updateField` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fieldId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/custom-fields/:fieldId` | `src/modules/build/core/projects-custom-fields.controller.ts:73` | `deleteField` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fieldId] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/tickets/:ticketId/custom-field-values` | `src/modules/build/core/projects-custom-fields.controller.ts:86` | `getTicketValues` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/custom-field-values` | `src/modules/build/core/projects-custom-fields.controller.ts:98` | `upsertTicketValues` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
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
| CLOSED | GET | `/build/:projectId/tickets/:ticketId/related-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:208` | `listRelatedLinks` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/related-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:220` | `addRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId/checklists/:checklistId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:70` | `updateChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/checklists/:checklistId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:84` | `deleteChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items` | `src/modules/build/core/projects-ticket-checklists.controller.ts:98` | `createChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId] | NO (mutating) |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:113` | `updateChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId, itemId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId` | `src/modules/build/core/projects-ticket-checklists.controller.ts:128` | `deleteChecklistItem` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, checklistId, itemId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/comments` | `src/modules/build/core/projects-ticket-comments.controller.ts:43` | `addComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | POST | `/build/:projectId/tickets/:ticketId/comments/:commentId/reactions` | `src/modules/build/core/projects-ticket-comments.controller.ts:98` | `addReaction` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji` | `src/modules/build/core/projects-ticket-comments.controller.ts:113` | `removeReaction` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId, emoji] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:214` | `getTicket` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| CLOSED | PATCH | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:226` | `updateTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/tickets/:ticketId` | `src/modules/build/core/projects-tickets.controller.ts:239` | `deleteTicket` | @RequirePermission("build:tickets:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| CLOSED | DELETE | `/build/:projectId/webhooks/:webhookId` | `src/modules/build/core/projects-webhooks.controller.ts:59` | `deleteWebhook` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | NO (mutating) |
| CLOSED | GET | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:92` | `getSprint` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | PASSED-UNBOUND | PASSED-UNBOUND | complete [projectId, sprintId] | n/a |
| CLOSED | PATCH | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:104` | `updateSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | PASSED-UNBOUND | complete [projectId, sprintId] | NO (mutating) |
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
| VERIFIED | GET | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:96` | `getApproval` | @RequirePermission("build:approvals:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | n/a |
| VERIFIED | POST | `/build/:projectId/approvals` | `src/modules/build/approvals/approvals.controller.ts:108` | `createApproval` | @RequirePermission("build:approvals:request") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | PATCH | `/build/:projectId/approvals/:approvalId/decide` | `src/modules/build/approvals/approvals.controller.ts:122` | `decideApproval` | @RequirePermission("build:approvals:decide") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | yes |
| VERIFIED | PATCH | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:136` | `updateApproval` | @RequirePermission("build:approvals:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/approvals/:approvalId` | `src/modules/build/approvals/approvals.controller.ts:149` | `softDeleteApproval` | @RequirePermission("build:approvals:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, approvalId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/change-requests/:changeRequestId/affected-tickets` | `src/modules/build/client-portal/change-request-affected-items.controller.ts:56` | `listAffectedTickets` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | n/a |
| VERIFIED | POST | `/build/:projectId/change-requests/:changeRequestId/affected-tickets` | `src/modules/build/client-portal/change-request-affected-items.controller.ts:69` | `linkTicket` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | yes |
| VERIFIED | DELETE | `/build/:projectId/change-requests/:changeRequestId/affected-tickets/:affectedItemId` | `src/modules/build/client-portal/change-request-affected-items.controller.ts:84` | `unlinkTicket` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId, affectedItemId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/change-requests` | `src/modules/build/client-portal/change-requests.controller.ts:57` | `listChangeRequests` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:69` | `getChangeRequest` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | n/a |
| VERIFIED | POST | `/build/:projectId/change-requests` | `src/modules/build/client-portal/change-requests.controller.ts:81` | `createChangeRequest` | @RequirePermission("build:changerequests:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:94` | `updateChangeRequest` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/change-requests/:changeRequestId` | `src/modules/build/client-portal/change-requests.controller.ts:107` | `deleteChangeRequest` | @RequirePermission("build:changerequests:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, changeRequestId] | NO (mutating) |
| VERIFIED | GET | `/build/portal/projects` | `src/modules/build/client-portal/client-portal.controller.ts:38` | `listPortalProjects` | @RequirePermission("build:portal:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/portal/projects/:projectId/overview` | `src/modules/build/client-portal/client-portal.controller.ts:47` | `getProjectOverview` | @RequirePermission("build:portal:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/portal/projects/:projectId/change-requests` | `src/modules/build/client-portal/client-portal.controller.ts:58` | `listPortalChangeRequests` | @RequirePermission("build:changerequests:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/portal/projects/:projectId/change-requests` | `src/modules/build/client-portal/client-portal.controller.ts:69` | `createPortalChangeRequest` | @RequirePermission("build:changerequests:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/client-visibility` | `src/modules/build/client-portal/client-visibility.controller.ts:38` | `getVisibilitySummary` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/client-visibility/tickets/:ticketId` | `src/modules/build/client-portal/client-visibility.controller.ts:49` | `toggleTicketVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/client-visibility/milestones/:milestoneId` | `src/modules/build/client-portal/client-visibility.controller.ts:62` | `toggleMilestoneVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, milestoneId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/client-visibility/comments/:commentId` | `src/modules/build/client-portal/client-visibility.controller.ts:75` | `toggleCommentVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, commentId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/client-visibility/attachments/:attachmentId` | `src/modules/build/client-portal/client-visibility.controller.ts:88` | `toggleAttachmentVisibility` | @RequirePermission("build:clientvisibility:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, attachmentId] | NO (mutating) |
| VERIFIED | GET | `/build/comment-drafts/mine` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:52` | `listMine` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | PUT | `/build/comment-drafts/tickets/:ticketId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:59` | `upsert` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | POST | `/build/comment-drafts/tickets/:ticketId/generate-draft` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:71` | `generateDraft` | @RequirePermission("build:ai:use") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | POST | `/build/comment-drafts/:draftId/failures` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:90` | `recordFailure` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [draftId] | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/mine` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:108` | `deleteAll` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/tickets/:ticketId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:116` | `deleteByTicket` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [ticketId] | NO (mutating) |
| VERIFIED | DELETE | `/build/comment-drafts/:draftId` | `src/modules/build/comment-drafts/comment-drafts.controller.ts:128` | `deleteOne` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [draftId] | NO (mutating) |
| VERIFIED | GET | `/build/members` | `src/modules/build/core/build-members.controller.ts:41` | `list` | @RequirePermission("build:members:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/members` | `src/modules/build/core/build-members.controller.ts:52` | `add` | @RequirePermission("build:members:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | DELETE | `/build/members/:userId` | `src/modules/build/core/build-members.controller.ts:64` | `remove` | @RequirePermission("build:members:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [userId] | NO (mutating) |
| VERIFIED | GET | `/build/org-custom-states` | `src/modules/build/core/project-resources.controller.ts:62` | `listOrgCustomStates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:71` | `listMembers` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/roster` | `src/modules/build/core/project-resources.controller.ts:82` | `getRoster` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:93` | `addMember` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/members` | `src/modules/build/core/project-resources.controller.ts:106` | `removeMember` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/members/:memberUserId` | `src/modules/build/core/project-resources.controller.ts:119` | `updateMemberRole` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, memberUserId] | NO (mutating) |
| VERIFIED | PUT | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:132` | `bulkReorderCustomStates` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:144` | `listCustomStates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/custom-states` | `src/modules/build/core/project-resources.controller.ts:155` | `createCustomState` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/labels` | `src/modules/build/core/project-resources.controller.ts:201` | `listProjectLabels` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/labels` | `src/modules/build/core/project-resources.controller.ts:213` | `createProjectLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/automations` | `src/modules/build/core/projects-automations.controller.ts:39` | `list` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/automations/runs` | `src/modules/build/core/projects-automations.controller.ts:56` | `listRuns` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/automations` | `src/modules/build/core/projects-automations.controller.ts:68` | `create` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
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
| VERIFIED | GET | `/build/resource-allocation` | `src/modules/build/core/projects-reports.controller.ts:60` | `resourceAllocation` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/analytics` | `src/modules/build/core/projects-reports.controller.ts:72` | `getAnalytics` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/burnup` | `src/modules/build/core/projects-reports.controller.ts:84` | `burnup` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/cfd` | `src/modules/build/core/projects-reports.controller.ts:96` | `cfd` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/critical-path` | `src/modules/build/core/projects-reports.controller.ts:108` | `criticalPath` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/velocity` | `src/modules/build/core/projects-reports.controller.ts:119` | `velocity` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/cycle-time` | `src/modules/build/core/projects-reports.controller.ts:143` | `getCycleTime` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/reports/lead-time` | `src/modules/build/core/projects-reports.controller.ts:154` | `getLeadTime` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/reports/snapshot` | `src/modules/build/core/projects-reports.controller.ts:165` | `snapshot` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/roadmap` | `src/modules/build/core/projects-roadmap.controller.ts:65` | `listRoadmap` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/roadmap/:itemId/signals` | `src/modules/build/core/projects-roadmap.controller.ts:76` | `getRoadmapSignals` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [itemId] | n/a |
| VERIFIED | POST | `/build/roadmap` | `src/modules/build/core/projects-roadmap.controller.ts:87` | `createRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/roadmap/:itemId` | `src/modules/build/core/projects-roadmap.controller.ts:99` | `updateRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [itemId] | NO (mutating) |
| VERIFIED | DELETE | `/build/roadmap/:itemId` | `src/modules/build/core/projects-roadmap.controller.ts:111` | `deleteRoadmap` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [itemId] | NO (mutating) |
| VERIFIED | GET | `/build/feedback` | `src/modules/build/core/projects-roadmap.controller.ts:123` | `listFeedback` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/feedback` | `src/modules/build/core/projects-roadmap.controller.ts:134` | `createFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/feedback/:postId` | `src/modules/build/core/projects-roadmap.controller.ts:146` | `updateFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | POST | `/build/feedback/:postId/merge` | `src/modules/build/core/projects-roadmap.controller.ts:158` | `mergeFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | DELETE | `/build/feedback/:postId` | `src/modules/build/core/projects-roadmap.controller.ts:170` | `deleteFeedback` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [postId] | NO (mutating) |
| VERIFIED | GET | `/build/changelog` | `src/modules/build/core/projects-roadmap.controller.ts:182` | `listChangelog` | @RequirePermission("build:roadmap:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/changelog` | `src/modules/build/core/projects-roadmap.controller.ts:193` | `createChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/changelog/:entryId` | `src/modules/build/core/projects-roadmap.controller.ts:205` | `updateChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | DELETE | `/build/changelog/:entryId` | `src/modules/build/core/projects-roadmap.controller.ts:217` | `deleteChangelog` | @RequirePermission("build:roadmap:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | GET | `/build/templates` | `src/modules/build/core/projects-templates.controller.ts:39` | `listTemplates` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | POST | `/build/templates` | `src/modules/build/core/projects-templates.controller.ts:46` | `createTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | DELETE | `/build/templates/:templateId` | `src/modules/build/core/projects-templates.controller.ts:58` | `deleteTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [templateId] | NO (mutating) |
| VERIFIED | POST | `/build/templates/:templateId/apply` | `src/modules/build/core/projects-templates.controller.ts:70` | `applyTemplate` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [templateId] | yes |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:75` | `listRelations` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:87` | `addRelation` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/tickets/:ticketId/relations` | `src/modules/build/core/projects-ticket-associations.controller.ts:101` | `removeRelation` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/tickets/:ticketId/labels/:labelId` | `src/modules/build/core/projects-ticket-associations.controller.ts:168` | `removeLabel` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, labelId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/git-links` | `src/modules/build/core/projects-ticket-associations.controller.ts:196` | `getGitLinks` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/tickets/:ticketId/related-links/:linkId` | `src/modules/build/core/projects-ticket-associations.controller.ts:234` | `updateRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, linkId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/tickets/:ticketId/related-links/:linkId` | `src/modules/build/core/projects-ticket-associations.controller.ts:248` | `deleteRelatedLink` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, linkId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/checklists` | `src/modules/build/core/projects-ticket-checklists.controller.ts:44` | `getChecklists` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets/:ticketId/checklists` | `src/modules/build/core/projects-ticket-checklists.controller.ts:56` | `createChecklist` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:57` | `getComment` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:70` | `editComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/tickets/:ticketId/comments/:commentId` | `src/modules/build/core/projects-ticket-comments.controller.ts:84` | `deleteComment` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId, commentId] | NO (mutating) |
| VERIFIED | GET | `/build/all-work` | `src/modules/build/core/projects-tickets.controller.ts:75` | `getAllWork` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/search/tickets` | `src/modules/build/core/projects-tickets.controller.ts:86` | `searchTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/column-counts` | `src/modules/build/core/projects-tickets.controller.ts:97` | `getColumnCounts` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/export` | `src/modules/build/core/projects-tickets.controller.ts:108` | `exportTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets/import` | `src/modules/build/core/projects-tickets.controller.ts:119` | `importTickets` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/tickets` | `src/modules/build/core/projects-tickets.controller.ts:133` | `listTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/tickets` | `src/modules/build/core/projects-tickets.controller.ts:145` | `createTicket` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | POST | `/build/:projectId/tickets/bulk` | `src/modules/build/core/projects-tickets.controller.ts:159` | `bulkUpdate` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | PATCH | `/build/:projectId/tickets/:ticketId/rank` | `src/modules/build/core/projects-tickets.controller.ts:173` | `rankTicket` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/activity` | `src/modules/build/core/projects-tickets.controller.ts:186` | `getActivity` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketId] | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/key/:ticketNumber` | `src/modules/build/core/projects-tickets.controller.ts:202` | `getTicketByKey` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, ticketNumber] | n/a |
| VERIFIED | GET | `/build/:projectId/webhooks` | `src/modules/build/core/projects-webhooks.controller.ts:34` | `listWebhooks` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/webhooks` | `src/modules/build/core/projects-webhooks.controller.ts:45` | `createWebhook` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | GET | `/build/:projectId/webhooks/:webhookId/deliveries` | `src/modules/build/core/projects-webhooks.controller.ts:72` | `listDeliveries` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | n/a |
| VERIFIED | POST | `/build/:projectId/webhooks/:webhookId/test` | `src/modules/build/core/projects-webhooks.controller.ts:84` | `sendTest` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, webhookId] | NO (mutating) |
| VERIFIED | GET | `/build` | `src/modules/build/core/projects.controller.ts:62` | `listProjects` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build` | `src/modules/build/core/projects.controller.ts:73` | `createProject` | @RequirePermission("build:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | POST | `/build/from-deal` | `src/modules/build/core/projects.controller.ts:86` | `createFromDeal` | @RequirePermission("build:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | GET | `/build/labels` | `src/modules/build/core/projects.controller.ts:99` | `listLabels` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | POST | `/build/labels` | `src/modules/build/core/projects.controller.ts:106` | `createLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/labels/:labelId` | `src/modules/build/core/projects.controller.ts:118` | `updateLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [labelId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/invoice-line-detail` | `src/modules/build/core/projects.controller.ts:130` | `getInvoiceLineDetail` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | DELETE | `/build/labels/:labelId` | `src/modules/build/core/projects.controller.ts:141` | `deleteLabel` | @RequirePermission("build:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [labelId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/sprints` | `src/modules/build/execution/iterations.controller.ts:67` | `listSprints` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/sprints` | `src/modules/build/execution/iterations.controller.ts:78` | `createSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | DELETE | `/build/:projectId/sprints/:sprintId` | `src/modules/build/execution/iterations.controller.ts:117` | `deleteSprint` | @RequirePermission("build:sprints:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | PASSED-UNBOUND | complete [projectId, sprintId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/cycles` | `src/modules/build/execution/iterations.controller.ts:137` | `listCycles` | @RequirePermission("build:sprints:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/cycles` | `src/modules/build/execution/iterations.controller.ts:149` | `createCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | yes |
| VERIFIED | PATCH | `/build/:projectId/cycles/:cycleId` | `src/modules/build/execution/iterations.controller.ts:163` | `updateCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, cycleId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/cycles/:cycleId` | `src/modules/build/execution/iterations.controller.ts:176` | `deleteCycle` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, cycleId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/modules` | `src/modules/build/execution/iterations.controller.ts:196` | `listModules` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/modules` | `src/modules/build/execution/iterations.controller.ts:207` | `createModule` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/epics` | `src/modules/build/execution/iterations.controller.ts:253` | `listEpics` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/epics` | `src/modules/build/execution/iterations.controller.ts:264` | `createEpic` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/epics/:epicId` | `src/modules/build/execution/iterations.controller.ts:277` | `updateEpic` | @RequirePermission("build:tickets:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, epicId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/epics/:epicId` | `src/modules/build/execution/iterations.controller.ts:290` | `deleteEpic` | @RequirePermission("build:tickets:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, epicId] | NO (mutating) |
| VERIFIED | GET | `/build/time-entries` | `src/modules/build/execution/timesheets.controller.ts:61` | `listTimeEntries` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/time-entries/team` | `src/modules/build/execution/timesheets.controller.ts:72` | `teamTimesheets` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | PATCH | `/build/time-entries/:entryId/approve` | `src/modules/build/execution/timesheets.controller.ts:83` | `approveEntry` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | yes |
| VERIFIED | PATCH | `/build/time-entries/:entryId/reject` | `src/modules/build/execution/timesheets.controller.ts:96` | `rejectEntry` | @RequirePermission("build:timesheets:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | yes |
| VERIFIED | PATCH | `/build/time-entries/:entryId` | `src/modules/build/execution/timesheets.controller.ts:109` | `updateEntry` | @RequirePermission("build:timesheets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | DELETE | `/build/time-entries/:entryId` | `src/modules/build/execution/timesheets.controller.ts:121` | `deleteEntry` | @RequirePermission("build:timesheets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [entryId] | NO (mutating) |
| VERIFIED | GET | `/build/billing-summary` | `src/modules/build/execution/timesheets.controller.ts:140` | `billingSummary` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/tickets/:ticketId/time-entries` | `src/modules/build/execution/timesheets.controller.ts:158` | `listTicketTimeEntries` | @RequirePermission("build:timesheets:view") | @RequireModule("build") | OK | BOUND | PASSED-UNBOUND | complete [projectId, ticketId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/whiteboards/:whiteboardId/sharing` | `src/modules/build/execution/whiteboard-sharing.controller.ts:57` | `updateSharing` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/whiteboards/:whiteboardId/sharing/rotate-token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:70` | `rotateShareToken` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| VERIFIED | PUT | `/build/:projectId/whiteboards/:whiteboardId/shares` | `src/modules/build/execution/whiteboard-sharing.controller.ts:84` | `setShares` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/whiteboards/:whiteboardId/shares/:targetUserId` | `src/modules/build/execution/whiteboard-sharing.controller.ts:97` | `removeShare` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId, targetUserId] | NO (mutating) |
| VERIFIED | GET | `/public/whiteboard-links/:token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:120` | `getByToken` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [token] | n/a |
| VERIFIED | PATCH | `/public/whiteboard-links/:token` | `src/modules/build/execution/whiteboard-sharing.controller.ts:134` | `updateByToken` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [token] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/workload/capacity` | `src/modules/build/execution/workload-capacity.controller.ts:39` | `capacity` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/milestones` | `src/modules/build/execution/workspace.controller.ts:72` | `listMilestones` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/milestones` | `src/modules/build/execution/workspace.controller.ts:83` | `createMilestone` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/intake` | `src/modules/build/execution/workspace.controller.ts:129` | `listIntake` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/intake` | `src/modules/build/execution/workspace.controller.ts:141` | `createIntake` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/views` | `src/modules/build/execution/workspace.controller.ts:174` | `listViews` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/views` | `src/modules/build/execution/workspace.controller.ts:185` | `createView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/views` | `src/modules/build/execution/workspace.controller.ts:231` | `listWorkspaceViews` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | POST | `/build/views` | `src/modules/build/execution/workspace.controller.ts:238` | `createWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:250` | `updateWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [viewId] | NO (mutating) |
| VERIFIED | DELETE | `/build/views/:viewId` | `src/modules/build/execution/workspace.controller.ts:262` | `deleteWorkspaceView` | @RequirePermission("build:workspace:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [viewId] | NO (mutating) |
| VERIFIED | GET | `/build/whiteboards` | `src/modules/build/execution/workspace.controller.ts:281` | `listAllWhiteboards` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | absent (no params) | n/a |
| VERIFIED | GET | `/build/:projectId/whiteboards` | `src/modules/build/execution/workspace.controller.ts:295` | `listWhiteboards` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | POST | `/build/:projectId/whiteboards` | `src/modules/build/execution/workspace.controller.ts:306` | `createWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:319` | `getWhiteboard` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:331` | `updateWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/whiteboards/:whiteboardId` | `src/modules/build/execution/workspace.controller.ts:344` | `deleteWhiteboard` | @RequirePermission("build:whiteboards:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, whiteboardId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/files` | `src/modules/build/files/files.controller.ts:48` | `listFiles` | @RequirePermission("build:files:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/files` | `src/modules/build/files/files.controller.ts:60` | `uploadFile` | @RequirePermission("build:files:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/files/:fileId/url` | `src/modules/build/files/files.controller.ts:73` | `getSignedUrl` | @RequirePermission("build:files:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fileId] | n/a |
| VERIFIED | DELETE | `/build/:projectId/files/:fileId` | `src/modules/build/files/files.controller.ts:85` | `softDeleteFile` | @RequirePermission("build:files:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fileId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/forms` | `src/modules/build/forms/forms.controller.ts:42` | `listForms` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:54` | `getForm` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | n/a |
| VERIFIED | POST | `/build/:projectId/forms` | `src/modules/build/forms/forms.controller.ts:66` | `createForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:79` | `updateForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/forms/:formId` | `src/modules/build/forms/forms.controller.ts:92` | `deleteForm` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/forms/:formId/submissions` | `src/modules/build/forms/submissions.controller.ts:57` | `listSubmissions` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/forms/:formId/submissions` | `src/modules/build/forms/submissions.controller.ts:70` | `createSubmission` | @RequirePermission("build:forms:view") | @RequireModule("build") | OK | BOUND | BOUND | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/forms/:formId/submissions/:submissionId` | `src/modules/build/forms/submissions.controller.ts:84` | `updateSubmission` | @RequirePermission("build:forms:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, formId, submissionId] | NO (mutating) |
| VERIFIED | POST | `/public/build-forms/:publicToken/submissions` | `src/modules/build/forms/submissions.controller.ts:106` | `submitPublicForm` | @Public | — | OK | N/A (@Public) | N/A (not nested) | complete [publicToken] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/decisions` | `src/modules/build/governance/decisions.controller.ts:42` | `listDecisions` | @RequirePermission("build:decisions:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:54` | `getDecision` | @RequirePermission("build:decisions:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | n/a |
| VERIFIED | POST | `/build/:projectId/decisions` | `src/modules/build/governance/decisions.controller.ts:66` | `createDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:79` | `updateDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/decisions/:decisionId` | `src/modules/build/governance/decisions.controller.ts:92` | `softDeleteDecision` | @RequirePermission("build:decisions:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, decisionId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/risks` | `src/modules/build/governance/risks.controller.ts:50` | `listRisks` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/risks/stats` | `src/modules/build/governance/risks.controller.ts:62` | `getRiskStats` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | ABSENT (route has params) | n/a |
| VERIFIED | GET | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:72` | `getRisk` | @RequirePermission("build:risks:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | n/a |
| VERIFIED | POST | `/build/:projectId/risks` | `src/modules/build/governance/risks.controller.ts:84` | `createRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:97` | `updateRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/risks/:riskId` | `src/modules/build/governance/risks.controller.ts:110` | `softDeleteRisk` | @RequirePermission("build:risks:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, riskId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/import-export/tickets/preview` | `src/modules/build/import-export/ticket-import-export.controller.ts:47` | `previewImport` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/import-export/tickets` | `src/modules/build/import-export/ticket-import-export.controller.ts:60` | `commitImport` | @RequirePermission("build:tickets:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/import-export/tickets/export` | `src/modules/build/import-export/ticket-import-export.controller.ts:74` | `exportTickets` | @RequirePermission("build:tickets:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/incidents` | `src/modules/build/incidents/incidents.controller.ts:74` | `listIncidents` | @RequirePermission("build:incidents:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:86` | `getIncident` | @RequirePermission("build:incidents:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | n/a |
| VERIFIED | POST | `/build/:projectId/incidents` | `src/modules/build/incidents/incidents.controller.ts:99` | `createIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:112` | `updateIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/incidents/:incidentId` | `src/modules/build/incidents/incidents.controller.ts:125` | `deleteIncident` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/incidents/:incidentId/updates` | `src/modules/build/incidents/incidents.controller.ts:138` | `addUpdate` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/incidents/:incidentId/decisions` | `src/modules/build/incidents/incidents.controller.ts:152` | `addDecision` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/incidents/:incidentId/follow-ups` | `src/modules/build/incidents/incidents.controller.ts:166` | `addFollowUpAction` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/incidents/:incidentId/follow-ups/:followUpActionId` | `src/modules/build/incidents/incidents.controller.ts:180` | `updateFollowUpAction` | @RequirePermission("build:incidents:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, incidentId, followUpActionId] | NO (mutating) |
| VERIFIED | GET | `/build/managed-products` | `src/modules/build/managed-products/managed-products.controller.ts:43` | `listManagedProducts` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:54` | `getManagedProduct` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | n/a |
| VERIFIED | POST | `/build/managed-products` | `src/modules/build/managed-products/managed-products.controller.ts:65` | `createManagedProduct` | @RequirePermission("build:managed-products:create") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:77` | `updateManagedProduct` | @RequirePermission("build:managed-products:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | NO (mutating) |
| VERIFIED | GET | `/build/managed-products/:managedProductId/insights` | `src/modules/build/managed-products/managed-products.controller.ts:89` | `getProductInsights` | @RequirePermission("build:managed-products:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | n/a |
| VERIFIED | DELETE | `/build/managed-products/:managedProductId` | `src/modules/build/managed-products/managed-products.controller.ts:100` | `deleteManagedProduct` | @RequirePermission("build:managed-products:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [managedProductId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/meetings/:meetingId/action-items` | `src/modules/build/meetings/action-items.controller.ts:39` | `createItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/meetings/:meetingId/action-items/:itemId` | `src/modules/build/meetings/action-items.controller.ts:53` | `updateItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/meetings/:meetingId/action-items/:itemId` | `src/modules/build/meetings/action-items.controller.ts:67` | `deleteItem` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/meetings/:meetingId/action-items/:itemId/convert-to-task` | `src/modules/build/meetings/action-items.controller.ts:81` | `convertToTask` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, itemId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/meetings` | `src/modules/build/meetings/meetings.controller.ts:55` | `listMeetings` | @RequirePermission("build:meetings:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | n/a |
| VERIFIED | GET | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:67` | `getMeeting` | @RequirePermission("build:meetings:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | n/a |
| VERIFIED | POST | `/build/:projectId/meetings` | `src/modules/build/meetings/meetings.controller.ts:79` | `createMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [projectId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:92` | `updateMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/meetings/:meetingId` | `src/modules/build/meetings/meetings.controller.ts:105` | `deleteMeeting` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/meetings/:meetingId/attendees` | `src/modules/build/meetings/meetings.controller.ts:118` | `addAttendee` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/meetings/:meetingId/attendees/:attendeeUserId` | `src/modules/build/meetings/meetings.controller.ts:132` | `removeAttendee` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId, attendeeUserId] | NO (mutating) |
| VERIFIED | PUT | `/build/:projectId/meetings/:meetingId/standup` | `src/modules/build/meetings/meetings.controller.ts:146` | `upsertStandup` | @RequirePermission("build:meetings:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, meetingId] | NO (mutating) |
| VERIFIED | GET | `/build/portfolios` | `src/modules/build/portfolios/portfolios.controller.ts:52` | `listPortfolios` | @RequirePermission("build:portfolios:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:63` | `getPortfolio` | @RequirePermission("build:portfolios:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | n/a |
| VERIFIED | POST | `/build/portfolios` | `src/modules/build/portfolios/portfolios.controller.ts:75` | `createPortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:87` | `updatePortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | DELETE | `/build/portfolios/:portfolioId` | `src/modules/build/portfolios/portfolios.controller.ts:99` | `deletePortfolio` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | POST | `/build/portfolios/:portfolioId/projects` | `src/modules/build/portfolios/portfolios.controller.ts:111` | `linkProject` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [portfolioId] | NO (mutating) |
| VERIFIED | DELETE | `/build/portfolios/:portfolioId/projects/:projectId` | `src/modules/build/portfolios/portfolios.controller.ts:124` | `unlinkProject` | @RequirePermission("build:portfolios:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [portfolioId, projectId] | NO (mutating) |
| VERIFIED | GET | `/build/programs` | `src/modules/build/portfolios/programs.controller.ts:52` | `listPrograms` | @RequirePermission("build:programs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:63` | `getProgram` | @RequirePermission("build:programs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | n/a |
| VERIFIED | POST | `/build/programs` | `src/modules/build/portfolios/programs.controller.ts:75` | `createProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:87` | `updateProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | DELETE | `/build/programs/:programId` | `src/modules/build/portfolios/programs.controller.ts:99` | `deleteProgram` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | POST | `/build/programs/:programId/projects` | `src/modules/build/portfolios/programs.controller.ts:111` | `linkProject` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [programId] | NO (mutating) |
| VERIFIED | DELETE | `/build/programs/:programId/projects/:projectId` | `src/modules/build/portfolios/programs.controller.ts:124` | `unlinkProject` | @RequirePermission("build:programs:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [programId, projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/bugs` | `src/modules/build/qa/bugs.controller.ts:47` | `listBugs` | @RequirePermission("build:bugs:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:59` | `getBug` | @RequirePermission("build:bugs:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | n/a |
| VERIFIED | POST | `/build/:projectId/bugs` | `src/modules/build/qa/bugs.controller.ts:71` | `createBug` | @RequirePermission("build:bugs:create") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:84` | `updateBug` | @RequirePermission("build:bugs:update") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/bugs/:bugId` | `src/modules/build/qa/bugs.controller.ts:97` | `deleteBug` | @RequirePermission("build:bugs:delete") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, bugId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-cases` | `src/modules/build/qa/test-cases.controller.ts:42` | `listCases` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:54` | `getCase` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | n/a |
| VERIFIED | POST | `/build/:projectId/test-cases` | `src/modules/build/qa/test-cases.controller.ts:66` | `createCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:79` | `updateCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/test-cases/:caseId` | `src/modules/build/qa/test-cases.controller.ts:92` | `deleteCase` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, caseId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-runs` | `src/modules/build/qa/test-runs.controller.ts:70` | `listRuns` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:82` | `getRun` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | n/a |
| VERIFIED | GET | `/build/:projectId/test-runs/:runId/results` | `src/modules/build/qa/test-runs.controller.ts:94` | `listRunResults` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | n/a |
| VERIFIED | POST | `/build/:projectId/test-runs` | `src/modules/build/qa/test-runs.controller.ts:107` | `createRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:120` | `updateRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/test-runs/:runId` | `src/modules/build/qa/test-runs.controller.ts:133` | `deleteRun` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId] | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/test-runs/:runId/results/:resultId` | `src/modules/build/qa/test-runs.controller.ts:146` | `updateResult` | @RequirePermission("build:qa:execute") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId, resultId] | NO (mutating) |
| VERIFIED | POST | `/build/:projectId/test-runs/:runId/results/:resultId/bug` | `src/modules/build/qa/test-runs.controller.ts:160` | `createBugFromResult` | @RequirePermission("build:bugs:create") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, runId, resultId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/test-suites` | `src/modules/build/qa/test-suites.controller.ts:42` | `listSuites` | @RequirePermission("build:qa:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/test-suites` | `src/modules/build/qa/test-suites.controller.ts:54` | `createSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/test-suites/:suiteId` | `src/modules/build/qa/test-suites.controller.ts:67` | `updateSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, suiteId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/test-suites/:suiteId` | `src/modules/build/qa/test-suites.controller.ts:80` | `deleteSuite` | @RequirePermission("build:qa:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, suiteId] | NO (mutating) |
| VERIFIED | POST | `/build/scope-directory/resolve` | `src/modules/build/scope-directory/scope-directory.controller.ts:27` | `resolve` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | GET | `/build/scope-directory/search` | `src/modules/build/scope-directory/scope-directory.controller.ts:45` | `search` | @RequirePermission("build:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/teams` | `src/modules/build/teams/teams.controller.ts:68` | `listTeams` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | GET | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:79` | `getTeam` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams` | `src/modules/build/teams/teams.controller.ts:90` | `createTeam` | @RequirePermission("build:teams:create") | @RequireModule("build") | OK | PASSED-UNBOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:102` | `updateTeam` | @RequirePermission("build:teams:update") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | DELETE | `/build/teams/:teamId` | `src/modules/build/teams/teams.controller.ts:114` | `deleteTeam` | @RequirePermission("build:teams:delete") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | GET | `/build/teams/:teamId/members` | `src/modules/build/teams/teams.controller.ts:126` | `listTeamMembers` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams/:teamId/members` | `src/modules/build/teams/teams.controller.ts:138` | `addMember` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | PATCH | `/build/teams/:teamId/members/:memberUserId` | `src/modules/build/teams/teams.controller.ts:151` | `updateMemberRole` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, memberUserId] | NO (mutating) |
| VERIFIED | DELETE | `/build/teams/:teamId/members/:memberId` | `src/modules/build/teams/teams.controller.ts:170` | `removeMember` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, memberId] | NO (mutating) |
| VERIFIED | GET | `/build/teams/:teamId/projects` | `src/modules/build/teams/teams.controller.ts:183` | `listTeamProjects` | @RequirePermission("build:teams:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | n/a |
| VERIFIED | POST | `/build/teams/:teamId/projects` | `src/modules/build/teams/teams.controller.ts:194` | `addProject` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | complete [teamId] | NO (mutating) |
| VERIFIED | DELETE | `/build/teams/:teamId/projects/:projectId` | `src/modules/build/teams/teams.controller.ts:207` | `removeProject` | @RequirePermission("build:teams:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [teamId, projectId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/updates` | `src/modules/build/updates/updates.controller.ts:45` | `listUpdates` | @RequirePermission("build:updates:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | n/a |
| VERIFIED | POST | `/build/:projectId/updates` | `src/modules/build/updates/updates.controller.ts:57` | `createUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | yes |
| VERIFIED | PATCH | `/build/:projectId/updates/:updateId` | `src/modules/build/updates/updates.controller.ts:71` | `editUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, updateId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/updates/:updateId` | `src/modules/build/updates/updates.controller.ts:84` | `softDeleteUpdate` | @RequirePermission("build:updates:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, updateId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/workflow/transitions` | `src/modules/build/workflow/workflow.controller.ts:46` | `listTransitions` | @RequirePermission("build:workflow:view") | @RequireModule("build") | OK | BOUND | N/A (not nested) | ABSENT (route has params) | n/a |
| VERIFIED | POST | `/build/:projectId/workflow/transitions` | `src/modules/build/workflow/workflow.controller.ts:56` | `createTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | N/A (not nested) | unresolved | NO (mutating) |
| VERIFIED | PATCH | `/build/:projectId/workflow/transitions/:transitionId` | `src/modules/build/workflow/workflow.controller.ts:69` | `updateTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, transitionId] | NO (mutating) |
| VERIFIED | DELETE | `/build/:projectId/workflow/transitions/:transitionId` | `src/modules/build/workflow/workflow.controller.ts:82` | `deleteTransition` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, transitionId] | NO (mutating) |
| VERIFIED | GET | `/build/:projectId/workflow/allowed/:fromStatusId` | `src/modules/build/workflow/workflow.controller.ts:95` | `getAllowedTransitions` | @RequirePermission("build:workflow:view") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, fromStatusId] | n/a |
| VERIFIED | PATCH | `/build/:projectId/workflow/statuses/:statusId/wip` | `src/modules/build/workflow/workflow.controller.ts:107` | `updateWipLimit` | @RequirePermission("build:workflow:manage") | @RequireModule("build") | OK | BOUND | BOUND | complete [projectId, statusId] | NO (mutating) |

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

