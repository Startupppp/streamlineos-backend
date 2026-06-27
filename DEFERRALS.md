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
| /deals/:dealId (WON webhook) | PATCH | ~~inngest `dispatchWebhook("deal.won")`~~ — IMPLEMENTED via `WebhooksDispatchService` (see outbound-webhook section) | DONE |
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

## b7 (accounting, chat, invoices)

No integration-gated routes. All side effects are in-DB: accounting ledger / journal posting, invoice + payment writes, chat messages, and DB-backed chat presence. Chat typing uses optional Redis (degrades gracefully when unconfigured), which is not a deferral.

## hra (hr-config, hr-time, hr-directory)

No integration-gated routes. All side effects are in-DB: departments / holidays / leave-blackout / document types & templates / email-template records / salary structures / career ladders / learning paths / skills / certifications / interview questions / handbook / notification-preference flags (hr-config); leave, attendance, WFH and work-log writes (hr-time); employee, org-structure, team-event, asset and background-verification writes (hr-directory). The `/hr/employees/:employeeId/profile-pdf` and `/hr/work-logs/export` routes generate their output in-process and stream it directly (no R2). `smsEnabled` is a stored preference flag (no SMS send) and the background-verification `provider` is a stored string (no external vendor call). `users` is read-only here (no users-table writes).

## hrb (hr-performance, hr-payroll, hr-lifecycle)

No integration-gated routes. All side effects are in-DB: performance goals / reviews / engagement surveys / document & rich-document records / compliance flags (hr-performance); payroll, bonus, loan, incentive, reimbursement and full-and-final settlement writes (hr-payroll); exit, termination, alumni, onboarding-doc-view, HR analytics and dashboard records (hr-lifecycle). Payslip HTML (`lib/payslip-html.ts`), resignation/relieving letters (`letters.ts`) and HR dashboard reports are generated in-process and streamed/returned directly (no R2). Bank-detail encryption (`lib/encryption.ts`) is in-process node `crypto` keyed off the optional `ENCRYPTION_KEY` env var (degrades to plaintext passthrough when unconfigured), not an external KMS, so it is not a deferral. `users` is read-only across the batch (no users-table writes).

## now-implemented integrations (integration batch)

The integration modules that previously blocked the deferred routes above have landed. Each module degrades gracefully when its provider env vars are unset (returns a `*_NOT_CONFIGURED` style error or no-ops) so the API boots without secrets.

| Module | Routes | Provider(s) / deps | Unblocks |
| --- | --- | --- | --- |
| email | 3 | Resend + SendGrid fallback (`resend`, `@sendgrid/mail`), `exceljs` for xlsx attachments, Twilio gateway for SMS | notifications-email rows under deals / organization / projects |
| ai | 22 | `@langchain/openai` (chat + embeddings, OpenAI), `ai` + `@ai-sdk/google` (streaming chat / RAG generation, Gemini) | kb-rag rows under support (KB semantic Q&A, reindex, index-status) |
| storage | 7 | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (R2/S3 presign + delete), `multer` upload interceptor | object-storage-r2 row under support (KB attachment download presign + delete) |
| billing | 4 | Razorpay (HMAC-verified REST + webhook); no extra npm dep | — (new) |
| google-calendar | 3 | Google Calendar REST (OAuth token passthrough); no extra npm dep | interview-scheduling calendar invites |
| realtime | 1 | `ably` (token auth) + `web-push` (VAPID push) | live presence / push fan-out |
| automation | 1 | automation rule engine; sends via its own `AutomationEmailService` (Resend/SendGrid) and injected `NotificationsService` | automation-engine row under deals (`runAutomationsForEvent`) |
| webhooks-dispatch | 3 | `WebhooksDispatchService` — fire-and-forget HMAC-signed outbound delivery to org `webhook_endpoints`, logged to `webhook_logs` (node `crypto` + global `fetch`; no new dep) | outbound `dispatchWebhook` rows: `deal.won` (deals), `lead.created` (leads), `leave.approved` (hr-time) |

Wiring notes: `email`, `storage` are `@Global` (their services are app-wide); `realtime` exports `AblyService`/`WebPushService`; `automation` imports `NotificationsModule` for `NotificationsService` and uses its own email sender (no dependency on `EmailModule`). All seven modules are registered in `src/app.module.ts`. Four service return types (`ChannelResult`, `TaskSuggestion`/`WorkloadAnalysis`, `KbAnswerSource`, `ActionResult`) were exported so controllers can name them (TS4053).

## outbound webhook dispatch (implemented)

`WebhooksModule` now provides and exports `WebhooksDispatchService.dispatch(orgId, eventName, payload)` — a fire-and-forget public method that mirrors the frontend `dispatchWebhook` (`inngest webhook/dispatch` → `webhook-dispatcher`): it reads active `webhook_endpoints` for the org, keeps endpoints whose `events` array is empty / includes the event / includes `"*"`, POSTs `{ event, data, timestamp }` with an HMAC-SHA256 `X-StreamlineOS-Signature` (10s timeout), and logs each attempt to `webhook_logs`. All errors are swallowed internally so a delivery failure never affects the caller's response (the caller does not await it).

Wired outbound `dispatchWebhook` events (route on backend → fired post-commit, matching the frontend trigger + payload):

| Event | Route | Module / call site | Trigger | Payload |
| --- | --- | --- | --- | --- |
| `deal.won` | PATCH /deals/:dealId | deals → `DealsService.updateDeal` | `input.stage === "WON"` | `{ id, name, value, assignedToId }` |
| `lead.created` | POST /leads | leads → `LeadsService.create` | after insert succeeds | `{ id, name, email, source, assignedToId }` |
| `leave.approved` | PATCH /hr/leaves/:leaveId/approve | hr-time → `LeavesWriteService.updateStatus` | `PENDING → APPROVED` | `{ leaveId, userId, startDate, endDate, leaveTypeId }` |

Not wired — `employee.hired` (POST /hr/employees/onboard): the onboard write-path itself is **not yet ported** to the backend (hr-directory `EmployeesService` has no `onboard` method), so there is no backend call site. Re-add this `dispatch("employee.hired", { userId, email, firstName, lastName, joiningDate })` when that route is ported.

## inngest async-function jobs — now implemented

The async cross-domain HR jobs that previously had no NestJS equivalent now land without an external queue. Immediate fan-outs run fire-and-forget in-process (`void task().catch(...)` so a job failure never affects the caller's response); scheduled jobs are exposed as cron-secret-gated `/cron/*` routes (same pattern as the existing attendance/leave/holiday crons) for an external scheduler to invoke. AI enrichments degrade gracefully when `OPENAI_API_KEY` is unset (return the plain fallback).

| Former inngest event | Origin route | Implementation |
| --- | --- | --- |
| `hr/resignation.submitted` | POST /hr/exit | `ResignationJobsService.notifyResignationSubmitted` (fan-out to CEO/HR) — called from `ExitWriteService.create` |
| `hr/resignation.hr_approved` | PATCH /hr/exit/:resignationId (status=HR_APPROVED) | `ResignationJobsService.notifyHrApproved` (fan-out to CEO) — called from `ExitWriteService.update` HR-approval path |
| `hr/resignation.ceo_approved` | PATCH /hr/exit/:resignationId/ceo-review | `ResignationJobsService.notifyCeoDecision` (notifies employee) — called from `ExitWriteService` CEO-review path |
| `hr/offer.deadline.reminder` | (scheduled) | `CronRecruitmentService.sendOfferDeadlineReminders` via GET/POST `/cron/offer-deadline-reminders` — emails candidates whose offer `validUntil` is tomorrow |
| `hr/interview.no_show` | (scheduled) | `CronRecruitmentService.processInterviewNoShows` via GET/POST `/cron/interview-no-shows` — flags `NO_SHOW`, creates HR follow-up task + notifications, emails candidate to reschedule |
| `hr/interview.scorecard.submitted` | POST /hr/recruitment/interviews/:interviewId/scorecard | `HrInterviewResultsService.sendCandidateFeedbackEmail` (fire-and-forget candidate-feedback email) |

Lead-assignment notifications are additionally enriched by `LeadNotificationAiService.generateSmartNotification` (`LEAD_ASSIGNED` event): `LeadsDetailService` writes the plain in-app notification first, then asynchronously rewrites its title/message with the AI-generated copy when configured.

## still-deferred: inngest async-function jobs (need a queue)

| Inngest event | Origin route | Purpose |
| --- | --- | --- |
| `hr/employee.onboarded` | POST /hr/employees/onboard | onboarding follow-up job (route also unported) |
