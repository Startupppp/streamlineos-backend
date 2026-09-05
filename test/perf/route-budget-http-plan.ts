import { randomUUID } from "node:crypto";

/**
 * One executable request per declared route budget.
 *
 * The manifest keys operations by `METHOD /path` against the OpenAPI template. A template is not
 * a request: `GET /build/{projectId}/tickets` needs a project that exists in the tenant being
 * measured, `GET /calendar/events` refuses without a window, and every `@Idempotent` write 400s
 * without an `Idempotency-Key` — with an error that reads like a body validation failure, which is
 * how a measurement run silently turns into a measurement of the 400 path.
 *
 * So each entry carries the concrete request, and the fixtures come from the tenant's own rows
 * rather than from constants: measuring tenant A's project id against tenant B is a 404, and a 404
 * has a cost that is not the route's.
 */

export interface RouteFixtures {
  readonly projectId: number | null;
  readonly channelId: number | null;
  readonly spaceId: number | null;
  readonly payrollRunId: number | null;
  readonly clientId: number | null;
  readonly ticketId: number | null;
  /**
   * A status name that exists in this project's `build.project_statuses`.
   *
   * `build.tickets.status` is a composite FK to `(org_id, project_id, name)`, and the seed writes
   * title case while `DEFAULT_PROJECT_STATUSES` is UPPER_SNAKE. Letting the service fall back to
   * its default therefore violates `fk_tickets_status` and measures the 500, so the plan asks the
   * database what this project actually accepts instead of hard-coding either vocabulary.
   */
  readonly projectStatusName: string | null;
}

export type RouteAuth = "member" | "cron";

export interface RoutePlanEntry {
  /** The manifest key. Every entry must resolve to one, and every plan entry is asserted against it. */
  readonly key: string;
  readonly method: "get" | "post";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /**
   * A factory, not a value: a write measured N times must vary the row it writes, or the second
   * sample measures a unique-constraint violation instead of the insert.
   */
  readonly body?: () => unknown;
  readonly auth: RouteAuth;
  /** A fresh Idempotency-Key per sample — a replayed key measures the replay path, not the write. */
  readonly idempotent?: boolean;
  /** Declared, not silent: an entry the plan refuses to attempt says why. */
  readonly unattemptable?: string;
}

let harnessDay = 0;

/** Distinct, deterministic and inside a plausible period — one day per sample, walking backwards. */
function nextHarnessDate(): string {
  harnessDay += 1;
  const base = Date.UTC(2026, 6, 1) - harnessDay * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

const CALENDAR_WINDOW = {
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
} as const;

/**
 * Mail is provider-backed: `mail_message_metadata` mirrors headers, but the message body, the
 * thread and the attachment all come from Gmail/Outlook through Composio, and the account list
 * comes from `user_integration_connections`. On a seeded database with no connected account there
 * is no message id to ask for, so four of the eight are declared unattemptable rather than
 * measured against a fabricated id — a 404 is not this route's cost.
 */
const MAIL_UNCONNECTED =
  "provider-backed: no connected mail account in the seed, so no real message/thread/attachment id exists to request";
const REALTIME_UNCONFIGURED =
  "provider-backed: the isolated seeded process carries no ABLY_API_KEY, so the token mint answers a provider error rather than the route";

export function buildRoutePlan(fx: RouteFixtures): RoutePlanEntry[] {
  const project = (suffix: string): string =>
    fx.projectId === null ? "" : `/build/${String(fx.projectId)}${suffix}`;
  const channel = (suffix: string): string =>
    fx.channelId === null ? "" : `/chat/channels/${String(fx.channelId)}${suffix}`;

  const entries: RoutePlanEntry[] = [
    { key: "GET /me/access", method: "get", path: "/me/access", auth: "member" },
    { key: "GET /notifications", method: "get", path: "/notifications", auth: "member" },
    { key: "GET /notifications/unread-count", method: "get", path: "/notifications/unread-count", auth: "member" },
    { key: "GET /chat/unread", method: "get", path: "/chat/unread", auth: "member" },
    { key: "GET /chat/ably-token", method: "get", path: "/chat/ably-token", auth: "member", unattemptable: REALTIME_UNCONFIGURED },
    { key: "GET /support/ably-token", method: "get", path: "/support/ably-token", auth: "member", unattemptable: REALTIME_UNCONFIGURED },
    { key: "GET /me/inbox/unified", method: "get", path: "/me/inbox/unified", auth: "member" },
    { key: "GET /me/inbox/unified/count", method: "get", path: "/me/inbox/unified/count", auth: "member" },
    { key: "GET /dashboard/personal", method: "get", path: "/dashboard/personal", auth: "member" },
    { key: "GET /calendar/events", method: "get", path: "/calendar/events", query: CALENDAR_WINDOW, auth: "member" },
    { key: "GET /organization/members", method: "get", path: "/organization/members", auth: "member" },
    { key: "GET /directory/people", method: "get", path: "/directory/people", auth: "member" },

    ...(fx.projectId === null
      ? ([
          { key: "GET /build/{projectId}/tickets", method: "get", path: "", auth: "member", unattemptable: "no project in this tenant" },
          { key: "GET /build/{projectId}/sprints", method: "get", path: "", auth: "member", unattemptable: "no project in this tenant" },
          { key: "POST /build/{projectId}/tickets", method: "post", path: "", auth: "member", unattemptable: "no project in this tenant" },
        ] as RoutePlanEntry[])
      : ([
          { key: "GET /build/{projectId}/tickets", method: "get", path: project("/tickets"), auth: "member" },
          { key: "GET /build/{projectId}/sprints", method: "get", path: project("/sprints"), auth: "member" },
          {
            key: "POST /build/{projectId}/tickets",
            method: "post",
            path: project("/tickets"),
            auth: "member",
            idempotent: true,
            body: () => ({
              title: `route-budget harness ticket ${randomUUID().slice(0, 8)}`,
              type: "TASK",
              priority: "LOW",
              ...(fx.projectStatusName === null ? {} : { status: fx.projectStatusName }),
            }),
          },
        ] as RoutePlanEntry[])),

    { key: "GET /build/roadmap", method: "get", path: "/build/roadmap", auth: "member" },
    { key: "GET /build/feedback", method: "get", path: "/build/feedback", auth: "member" },
    { key: "GET /build/changelog", method: "get", path: "/build/changelog", auth: "member" },
    { key: "GET /build/all-work", method: "get", path: "/build/all-work", auth: "member" },

    { key: "GET /dashboard/my-issues", method: "get", path: "/dashboard/my-issues", auth: "member" },
    { key: "GET /dashboard/announcements", method: "get", path: "/dashboard/announcements", auth: "member" },
    { key: "GET /dashboard/stats", method: "get", path: "/dashboard/stats", auth: "member" },
    { key: "GET /dashboard/leaves-today", method: "get", path: "/dashboard/leaves-today", auth: "member" },
    { key: "GET /dashboard/team-attendance", method: "get", path: "/dashboard/team-attendance", auth: "member" },
    { key: "GET /dashboard/active-sprint", method: "get", path: "/dashboard/active-sprint", auth: "member" },
    { key: "GET /dashboard/recent-projects", method: "get", path: "/dashboard/recent-projects", auth: "member" },

    { key: "GET /chat/channels", method: "get", path: "/chat/channels", auth: "member" },
    ...(fx.channelId === null
      ? ([
          { key: "GET /chat/channels/{channelId}/messages", method: "get", path: "", auth: "member", unattemptable: "no channel this member belongs to" },
          { key: "GET /chat/channels/{channelId}/members", method: "get", path: "", auth: "member", unattemptable: "no channel this member belongs to" },
          { key: "POST /chat/channels/{channelId}/messages", method: "post", path: "", auth: "member", unattemptable: "no channel this member belongs to" },
        ] as RoutePlanEntry[])
      : ([
          { key: "GET /chat/channels/{channelId}/messages", method: "get", path: channel("/messages"), auth: "member" },
          { key: "GET /chat/channels/{channelId}/members", method: "get", path: channel("/members"), auth: "member" },
          {
            key: "POST /chat/channels/{channelId}/messages",
            method: "post",
            path: channel("/messages"),
            auth: "member",
            idempotent: true,
            body: () => ({ content: `route-budget harness message ${randomUUID().slice(0, 8)}` }),
          },
        ] as RoutePlanEntry[])),
    { key: "GET /chat/saved", method: "get", path: "/chat/saved", auth: "member" },

    { key: "GET /kb/spaces", method: "get", path: "/kb/spaces", auth: "member" },
    fx.spaceId === null
      ? { key: "GET /kb/spaces/{spaceId}", method: "get", path: "", auth: "member", unattemptable: "no KB space in this tenant" }
      : { key: "GET /kb/spaces/{spaceId}", method: "get", path: `/kb/spaces/${String(fx.spaceId)}`, auth: "member" },
    { key: "GET /kb/pages/recent", method: "get", path: "/kb/pages/recent", auth: "member" },
    { key: "GET /kb/pages/search", method: "get", path: "/kb/pages/search", query: { q: "sdf" }, auth: "member" },

    { key: "GET /hr/employees", method: "get", path: "/hr/employees", auth: "member" },
    { key: "GET /hr/people", method: "get", path: "/hr/people", auth: "member" },
    { key: "GET /hr/leaves", method: "get", path: "/hr/leaves", auth: "member" },
    { key: "GET /hr/leaves/my", method: "get", path: "/hr/leaves/my", auth: "member" },
    { key: "GET /me/attendance/history", method: "get", path: "/me/attendance/history", auth: "member" },
    { key: "GET /hr/leaves/balance", method: "get", path: "/hr/leaves/balance", auth: "member" },

    { key: "GET /timesheets/entries", method: "get", path: "/timesheets/entries", auth: "member" },
    { key: "GET /timesheets/approvals", method: "get", path: "/timesheets/approvals", auth: "member" },
    {
      key: "POST /timesheets/entries",
      method: "post",
      path: "/timesheets/entries",
      auth: "member",
      idempotent: true,
      // `uniq_timesheets_work_log` is unique per (member, date, work item), so every sample needs
      // its own day: a fixed date measures the duplicate-key path from the second request onward.
      body: () => ({ date: nextHarnessDate(), hours: 1, description: "route-budget harness entry" }),
    },

    { key: "GET /contacts", method: "get", path: "/contacts", auth: "member" },
    { key: "GET /leads", method: "get", path: "/leads", auth: "member" },
    { key: "GET /deals", method: "get", path: "/deals", auth: "member" },
    { key: "GET /clients", method: "get", path: "/clients", auth: "member" },
    { key: "GET /party/parties", method: "get", path: "/party/parties", auth: "member" },
    {
      key: "POST /leads",
      method: "post",
      path: "/leads",
      auth: "member",
      idempotent: true,
      body: () => ({ name: `route-budget harness lead ${randomUUID().slice(0, 8)}`, source: "other", priority: "WARM" }),
    },
    {
      key: "POST /deals",
      method: "post",
      path: "/deals",
      auth: "member",
      idempotent: true,
      body: () => ({ name: `route-budget harness deal ${randomUUID().slice(0, 8)}`, value: 1000 }),
    },

    { key: "GET /invoices", method: "get", path: "/invoices", auth: "member" },
    { key: "GET /accounting/purchase-bills", method: "get", path: "/accounting/purchase-bills", auth: "member" },
    { key: "GET /accounting/journal", method: "get", path: "/accounting/journal", auth: "member" },
    { key: "GET /accounting/reports/aged-receivables", method: "get", path: "/accounting/reports/aged-receivables", auth: "member" },
    { key: "GET /accounting/taxes/payments", method: "get", path: "/accounting/taxes/payments", auth: "member" },
    { key: "GET /accounting/reminders/policies", method: "get", path: "/accounting/reminders/policies", auth: "member" },
    fx.clientId === null
      ? { key: "POST /invoices", method: "post", path: "", auth: "member", unattemptable: "no client in this tenant to bill" }
      : {
          key: "POST /invoices",
          method: "post",
          path: "/invoices",
          auth: "member",
          idempotent: true,
          body: () => ({
            clientId: fx.clientId,
            items: [{ description: "route-budget harness line", quantity: 1, rate: 100, gstRate: 0 }],
          }),
        },

    { key: "GET /payroll/runs", method: "get", path: "/payroll/runs", auth: "member" },
    fx.payrollRunId === null
      ? { key: "GET /payroll/runs/{runId}/employees", method: "get", path: "", auth: "member", unattemptable: "no payroll run in this tenant" }
      : {
          key: "GET /payroll/runs/{runId}/employees",
          method: "get",
          path: `/payroll/runs/${String(fx.payrollRunId)}/employees`,
          auth: "member",
        },

    { key: "GET /inventory/products", method: "get", path: "/inventory/products", auth: "member" },
    { key: "GET /inventory/stock", method: "get", path: "/inventory/stock", auth: "member" },
    { key: "GET /inventory/stock/transactions", method: "get", path: "/inventory/stock/transactions", auth: "member" },
    { key: "GET /inventory/purchase-orders", method: "get", path: "/inventory/purchase-orders", auth: "member" },
    { key: "GET /inventory/vendors", method: "get", path: "/inventory/vendors", auth: "member" },

    { key: "GET /support", method: "get", path: "/support", auth: "member" },
    {
      key: "POST /support",
      method: "post",
      path: "/support",
      auth: "member",
      idempotent: true,
      body: () => ({ title: `route-budget harness ticket ${randomUUID().slice(0, 8)}`, category: "General", priority: "LOW" }),
    },

    { key: "GET /search", method: "get", path: "/search", query: { q: "sdf", limit: "5" }, auth: "member" },

    { key: "GET /mail/accounts", method: "get", path: "/mail/accounts", auth: "member" },
    { key: "GET /mail/messages", method: "get", path: "/mail/messages", query: { folder: "inbox", accountId: "all", limit: "25" }, auth: "member" },
    { key: "GET /mail/messages/{messageId}", method: "get", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
    { key: "GET /mail/threads/{threadId}", method: "get", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
    { key: "POST /mail/send", method: "post", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
    { key: "POST /mail/reply", method: "post", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
    { key: "POST /mail/messages/{messageId}/actions", method: "post", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
    { key: "GET /mail/messages/{messageId}/attachments/{attachmentId}", method: "get", path: "", auth: "member", unattemptable: MAIL_UNCONNECTED },
  ];

  for (const job of CRON_JOBS)
    entries.push({ key: `GET /cron/${job}`, method: "get", path: `/cron/${job}`, auth: "cron" });

  for (const job of CRON_JOBS_ALSO_POST)
    entries.push({ key: `POST /cron/${job}`, method: "post", path: `/cron/${job}`, auth: "cron" });

  return entries;
}

/**
 * All declared worker batches that carry a budget entry in contracts/route-budgets.json.
 *
 * A cron route is `@Public()` and gated on `CRON_SECRET`, so it is reachable from the harness
 * with a header rather than a token — and unlike every other entry it iterates tenants rather than
 * serving one, which is exactly why its budget is a batch budget and not a route budget.
 *
 * Every entry here must have a corresponding `GET /cron/<name>` budget with `kind: worker-batch`
 * in contracts/route-budgets.json. The list is maintained here alongside the plan so that a newly
 * budgeted batch is visible in a single diff rather than split across two files.
 */
export const CRON_JOBS = [
  "notification-outbox-flush",
  "notification-delivery-flush",
  "notification-digest-flush",
  "outbox-events-worker",
  "email-outbox-flush",
  "notifications-retention-sweep",
  "notifications-retention-detach",
  "notification-outbox-retention-sweep",
  "monthly-leave-reset",
  "build-due-sweep",
  "ai-reservations-sweep",
  "idempotency-fence-sweep",
  "storage-sweep",
  "outbox-events-retention-sweep",
  "calendar-provider-sync-sweep",
  "announcements-retention-sweep",
  "mail-metadata-retention-sweep",
  "helpdesk-retention-sweep",
  "retention-delete-sweep",
  "ai-usage-retention-sweep",
  "build-retention-prune",
  "kb-chat-history-purge",
  "kb-chunk-retention-sweep",
  "hr-policy-retention-sweep",
  "kb-telemetry-retention-sweep",
] as const;

/**
 * Worker batches whose controller exposes BOTH a GET and a POST method for the same handler.
 * Each name here must also appear in CRON_JOBS (for the GET entry) and must have a corresponding
 * `POST /cron/<name>` budget entry in contracts/route-budgets.json.
 */
export const CRON_JOBS_ALSO_POST = ["retention-delete-sweep"] as const;
