# Deferred Routes Registry

This is a living registry of routes (and route side effects) that are intentionally NOT yet
ported into the NestJS backend because they depend on an integration that lives in a later
extraction batch. Extend this file every batch: add new rows when a route is deferred, and
remove rows once the blocking integration lands and the route/side effect is ported.

Each row records: the route, the HTTP method, the specific blocking integration, and the
future batch that owns unblocking it.

## deals

| Route | Method | Blocking integration | Owning future batch |
| --- | --- | --- | --- |
| /deals/:dealId (NEGOTIATION side effect) | PATCH | `maybeCreateNegotiationChannel` writes `chat_channels` / `chat_channel_members` — chat module not yet extracted; stays event-bridged | chat |
| /deals/:dealId (stage-change email) | PATCH | `sendDealStageChangeEmail` (`sendStageChangeNotification`) — email provider integration | notifications-email |
| /deals/:dealId (WON webhook) | PATCH | inngest `dispatchWebhook("deal.won")` — outbound webhook / inngest dispatch | webhooks-inngest |
| /deals/:dealId (automation) | PATCH | `runAutomationsForEvent("deal.stage_changed")` — automation engine | automation-engine |

## organization

| Route | Method | Blocking integration | Owning future batch |
| --- | --- | --- | --- |
| /organization/setup | PATCH | writes `users` rows + `invalidateUserSession` (session/cache invalidation primitive) | users-sessions |
| /organization/members | POST | invitation email send | notifications-email |
| /organization/invitations/resend | POST | invitation email send | notifications-email |
| /organization/members/:memberId | PATCH | writes `users.role` (user record mutation) | users-sessions |
| /organization/security | PATCH | session invalidation on security-policy change | users-sessions |

## branches

| Route | Method | Blocking integration | Owning future batch |
| --- | --- | --- | --- |
| /branches | POST | writes `users.branchId` when a manager is supplied (user record mutation) | users-sessions |

## projects

| Route | Method | Blocking integration | Owning future batch |
| --- | --- | --- | --- |
| /projects/:projectId | PATCH | `sendProjectAssignmentEmail` on manager (re)assignment — email provider integration (in-app data is written) | notifications-email |
| /projects/:projectId/tickets | POST | `sendTicketAssignmentEmail` to new assignees — email provider integration (in-app assignment notifications are ported) | notifications-email |
| /projects/:projectId/tickets/:ticketId/comments | POST | mention emails via `processCommentMentions` — email provider integration (in-app mention notifications are ported) | notifications-email |

## support

| Route | Method | Blocking integration | Owning future batch |
| --- | --- | --- | --- |
| /support/kb/ask | POST | `answerQuestion` semantic Q&A over pgvector embeddings (`kb-rag`) — embeddings/OpenAI provider not extracted | kb-rag |
| /support/kb/reindex-all | POST | bulk `reindexArticle` embedding generation (`kb-rag`) | kb-rag |
| /support/kb/articles/:articleId/reindex | POST | per-article `reindexArticle` embedding generation (`kb-rag`) | kb-rag |
| /support/kb/articles/:articleId/index-status | GET | KB embedding index status (`kb-rag`) | kb-rag |
| /support/kb/articles/:articleId/attachments/:attachmentId | GET, DELETE | `getFileUrl`/`deleteFile` R2 object storage (`@/lib/storage`) presign + cleanup; GET (download presign) not ported and DELETE skips the R2 object delete; both routes also skip `reindexArticleSafe` (`kb-rag`) | object-storage-r2 |
