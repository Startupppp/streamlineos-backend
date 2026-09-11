import {
  ALERT_RUNBOOK,
  FAILURE_RUNBOOK,
  type ServiceLevelObjective,
  type SloOwner,
} from "./slo-types";

const OUTBOX_MAX_PENDING_AGE_SECONDS = 300;
const OUTBOX_MAX_RETRY_PRESSURE = 500;
const JOB_MAX_PENDING_AGE_SECONDS = 900;
const DEAD_LETTER_WINDOW_HOURS = 24;

interface QueueSubject {
  readonly id: string;
  readonly sourceFile: string;
  readonly drains: string;
  readonly owner: SloOwner;
  readonly channel: "outbox" | "job" | "delivery";
}

export const QUEUE_SUBJECTS: readonly QueueSubject[] = [
  {
    id: "workflow-outbox-relay",
    sourceFile: "src/common/workflow/workflow-outbox-relay.service.ts",
    drains: "outbox_events",
    owner: "delivery-team",
    channel: "outbox",
  },
  {
    /*
      The in-process half of the same drain. `workflow-outbox-relay` is what an
      external scheduler drives through /cron; this ticks every 15s inside the
      application under a lease, and when it is disabled the relay above is the
      only thing draining `outbox_events`. Both carry the objective, because a
      backlog is a backlog whichever one was meant to clear it.
    */
    id: "cron-outbox-worker",
    sourceFile: "src/modules/cron/cron-outbox-worker.service.ts",
    drains: "outbox_events",
    owner: "delivery-team",
    channel: "outbox",
  },
  {
    id: "notification-outbox-relay",
    sourceFile: "src/modules/notifications/notification-outbox-relay.service.ts",
    drains: "notification_outbox",
    owner: "notifications-team",
    channel: "outbox",
  },
  {
    id: "chat-fanout-outbox",
    sourceFile: "src/modules/chat/chat-fanout-outbox.consumer.ts",
    drains: "outbox_events",
    owner: "communications-team",
    channel: "outbox",
  },
  {
    id: "expense-outbox",
    sourceFile: "src/modules/expenses/expense-outbox.consumer.ts",
    drains: "outbox_events",
    owner: "finance-team",
    channel: "outbox",
  },
  {
    id: "accounting-journal-posted",
    sourceFile: "src/modules/accounting/adapters/journal-posted.consumer.ts",
    drains: "outbox_events",
    owner: "finance-team",
    channel: "outbox",
  },
  {
    id: "gdpr-export-outbox",
    sourceFile: "src/modules/gdpr/gdpr-export-outbox.consumer.ts",
    drains: "outbox_events",
    owner: "platform-reliability",
    channel: "outbox",
  },
  {
    id: "hr-helpdesk-events",
    sourceFile: "src/modules/hr/helpdesk/hr-helpdesk-events.consumer.ts",
    drains: "outbox_events",
    owner: "people-team",
    channel: "outbox",
  },
  {
    id: "sign-bulk-send",
    sourceFile: "src/modules/e-sign/sign-bulk-send.consumer.ts",
    drains: "outbox_events",
    owner: "delivery-team",
    channel: "outbox",
  },
  {
    // No domain team owns `reporting` — it has no module objective and no route
    // attribution — so the queue sits with the owner of the dead-outbox alert it
    // pages on, as the other cross-cutting consumers here do.
    id: "report-schedule",
    sourceFile: "src/modules/reporting/report-schedule.consumer.ts",
    drains: "outbox_events",
    owner: "platform-reliability",
    channel: "outbox",
  },
  {
    id: "timesheet-lifecycle",
    sourceFile: "src/modules/timesheets/core/events/timesheet-lifecycle.consumer.ts",
    drains: "outbox_events",
    owner: "people-team",
    channel: "outbox",
  },
  {
    id: "timesheets-payroll-handoff",
    sourceFile: "src/modules/timesheets/payroll/handoff/payroll-handoff.consumer.ts",
    drains: "outbox_events",
    owner: "people-team",
    channel: "outbox",
  },
  {
    id: "timesheets-payroll-ack",
    sourceFile: "src/modules/timesheets/payroll/handoff/payroll-ack.consumer.ts",
    drains: "outbox_events",
    owner: "people-team",
    channel: "outbox",
  },
  {
    id: "notification-delivery",
    sourceFile: "src/modules/notifications/notification-delivery-worker.service.ts",
    drains: "notification_deliveries",
    owner: "notifications-team",
    channel: "delivery",
  },
  {
    id: "ai-jobs",
    sourceFile: "src/modules/ai/jobs/ai-jobs-worker.service.ts",
    drains: "ai_jobs",
    owner: "platform-reliability",
    channel: "job",
  },
  {
    id: "payroll-jobs",
    sourceFile: "src/modules/payroll/jobs/payroll-jobs-worker.service.ts",
    drains: "payroll_jobs",
    owner: "people-team",
    channel: "job",
  },
  {
    id: "payroll-run-export",
    sourceFile: "src/modules/payroll/runs/payroll-export-worker.service.ts",
    drains: "payroll_run_export_jobs",
    owner: "people-team",
    channel: "job",
  },
  {
    id: "payroll-posting-intent",
    sourceFile: "src/modules/payroll/payout/payroll-posting-intent.consumer.ts",
    drains: "outbox_events",
    owner: "finance-team",
    channel: "outbox",
  },
  {
    id: "payroll-payout-posting-intent",
    sourceFile:
      "src/modules/payroll/payout/payroll-payout-posting-intent.consumer.ts",
    drains: "outbox_events",
    owner: "finance-team",
    channel: "outbox",
  },
  {
    id: "expense-export",
    sourceFile: "src/modules/expenses/expense-export-worker.service.ts",
    drains: "expense_export_jobs",
    owner: "finance-team",
    channel: "job",
  },
  {
    id: "hr-export",
    sourceFile: "src/modules/hr/import/hr-export-worker.service.ts",
    drains: "hr_export_jobs",
    owner: "people-team",
    channel: "job",
  },
  {
    id: "gdpr-export",
    sourceFile: "src/modules/gdpr/gdpr-export-worker.service.ts",
    drains: "gdpr_export_jobs",
    owner: "platform-reliability",
    channel: "job",
  },
  {
    id: "org-purge",
    sourceFile: "src/modules/cron/cron-org-purge-worker.service.ts",
    drains: "organization_purge_confirmations",
    owner: "platform-reliability",
    channel: "job",
  },
];

function freshnessObjective(subject: QueueSubject): ServiceLevelObjective {
  if (subject.channel === "outbox")
    return {
      id: `queue:${subject.id}:freshness`,
      kind: "queue",
      subject: subject.sourceFile,
      statement: `No ${subject.drains} row stays PENDING longer than ${OUTBOX_MAX_PENDING_AGE_SECONDS}s, and cumulative retry pressure stays at or below ${OUTBOX_MAX_RETRY_PRESSURE}.`,
      indicator: {
        kind: "queue-age",
        maxPendingAgeSeconds: OUTBOX_MAX_PENDING_AGE_SECONDS,
        maxRetryPressure: OUTBOX_MAX_RETRY_PRESSURE,
      },
      owner: subject.owner,
      alertId: "queue-age",
      runbookFile: FAILURE_RUNBOOK,
      runbookAnchor: "#queue-backlog",
    };

  if (subject.channel === "job")
    return {
      id: `queue:${subject.id}:freshness`,
      kind: "queue",
      subject: subject.sourceFile,
      statement: `No ${subject.drains} row stays queued or running longer than ${JOB_MAX_PENDING_AGE_SECONDS}s.`,
      indicator: {
        kind: "queue-age",
        maxPendingAgeSeconds: JOB_MAX_PENDING_AGE_SECONDS,
        maxRetryPressure: OUTBOX_MAX_RETRY_PRESSURE,
      },
      owner: subject.owner,
      alertId: "job-queue-age",
      runbookFile: ALERT_RUNBOOK,
      runbookAnchor: "#job-queue-age",
    };

  return {
    id: `queue:${subject.id}:freshness`,
    kind: "queue",
    subject: subject.sourceFile,
    statement: `No ${subject.drains} row reaches DEAD state within a ${DEAD_LETTER_WINDOW_HOURS}h window.`,
    indicator: {
      kind: "dead-letter",
      maxDeadRowsInWindow: 0,
      windowHours: DEAD_LETTER_WINDOW_HOURS,
    },
    owner: subject.owner,
    alertId: "dead-delivery",
    runbookFile: ALERT_RUNBOOK,
    runbookAnchor: "#dead-delivery",
  };
}

/**
 * The alert is chosen by the table, not by the channel. `notification-outbox-relay`
 * declared `drains: "outbox_events"` and inherited `alertId: "dead-outbox"` from it,
 * so the DEAD-letter objective for `notification_outbox` was satisfied by a script
 * (`alert-dead-outbox.mjs`) that queries a different table entirely — the objective
 * could never fail, however many notification intents dead-lettered. Every DEAD-letter
 * objective now names the watcher that reads the table it is about.
 */
const DEAD_LETTER_ALERTS: Record<string, { alertId: string; anchor: string }> = {
  outbox_events: { alertId: "dead-outbox", anchor: "#dead-outbox" },
  notification_outbox: {
    alertId: "dead-notification-outbox",
    anchor: "#dead-notification-outbox",
  },
};

function durabilityObjective(subject: QueueSubject): ServiceLevelObjective | null {
  if (subject.channel !== "outbox") return null;
  const alert = DEAD_LETTER_ALERTS[subject.drains];
  if (alert === undefined)
    throw new Error(
      `Queue subject ${subject.id} drains ${subject.drains}, which no DEAD-letter alert reads. ` +
        `Add a watcher for that table and register it in DEAD_LETTER_ALERTS.`,
    );
  return {
    id: `queue:${subject.id}:durability`,
    kind: "queue",
    subject: subject.sourceFile,
    statement: `No ${subject.drains} row this consumer owns reaches DEAD state within a ${DEAD_LETTER_WINDOW_HOURS}h window.`,
    indicator: {
      kind: "dead-letter",
      maxDeadRowsInWindow: 0,
      windowHours: DEAD_LETTER_WINDOW_HOURS,
    },
    owner: subject.owner,
    alertId: alert.alertId,
    runbookFile: ALERT_RUNBOOK,
    runbookAnchor: alert.anchor,
  };
}

export const QUEUE_SLOS: readonly ServiceLevelObjective[] = QUEUE_SUBJECTS.flatMap(
  (subject) => {
    const durability = durabilityObjective(subject);
    return durability === null
      ? [freshnessObjective(subject)]
      : [freshnessObjective(subject), durability];
  },
);
