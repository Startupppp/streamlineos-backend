import { TimesheetRemindersSweepService } from "../reminders-sweep.service";
import type { Db } from "../../../../db/drizzle.module";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";

/**
 * The sweep's decisions, with the database and the notification pipeline stubbed.
 *
 * What this can prove: which periods are considered, which reminder each one
 * earns, and — the two that matter most — that an organisation with unreadable
 * rules is reported rather than crashed on, and that a period someone has
 * already submitted is left alone.
 *
 * What it cannot prove is that the sweep reaches anything at all under RLS,
 * since `forEachOrg` and the real `emit` are not exercised here. That is the
 * `remindAllOrgs` half, and it needs a database.
 */

interface StubQuery {
  rows: unknown[];
}

/**
 * Answers `select().from().where().limit()` and `select().from().where()` in
 * the order the service asks: settings first, then periods.
 */
function stubDb(...responses: StubQuery[]): Db {
  const queue = [...responses];
  const next = () => queue.shift()?.rows ?? [];
  return {
    select: () => ({
      from: () => {
        const rows = next();
        const where = () => {
          const promise = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          promise.limit = async () => rows;
          return promise;
        };
        return { where };
      },
    }),
  } as unknown as Db;
}

interface Emitted {
  eventKey: string;
  targetUserIds: string[];
  entityId?: string;
  title?: string;
}

function stubNotifications() {
  const sent: Emitted[] = [];
  const service = {
    emit: async (input: Emitted) => {
      sent.push(input);
      return {
        eventKey: input.eventKey,
        notified: 1,
        deliveriesQueued: 1,
        suppressed: 0,
        deduped: 0,
      };
    },
  } as unknown as NotificationDispatchService;
  return { service, sent };
}

const ENABLED = { enabled: true, remindBeforeDueDays: [2], remindAfterDueDays: [1] };

const PERIOD = {
  id: 11,
  userId: "u-1",
  periodStart: "2026-03-01",
  periodEnd: "2026-03-31",
};

describe("TimesheetRemindersSweepService.remindOrg", () => {
  it("returns null for an organisation with no timesheet settings at all", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(stubDb({ rows: [] }), notifications);

    expect(await sweep.remindOrg("org-1", "2026-04-03")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("sends nothing, and reads no periods, when reminders are disabled", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb({ rows: [{ reminderRules: { ...ENABLED, enabled: false }, submissionGraceDays: 5 }] }),
      notifications,
    );

    const result = await sweep.remindOrg("org-1", "2026-04-03");

    expect(result).toEqual({ malformed: false, periodsConsidered: 0, remindersSent: 0 });
    expect(sent).toHaveLength(0);
  });

  /**
   * The reason `resolveReminderRules` does not throw. Before this, one row of
   * pre-schema junk in one organisation would have aborted that organisation's
   * sweep; the count is what makes it visible instead of merely survivable.
   */
  it("reports an organisation whose stored rules do not parse, and sends nothing", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb({ rows: [{ reminderRules: { every: "friday" }, submissionGraceDays: 5 }] }),
      notifications,
    );

    const result = await sweep.remindOrg("org-1", "2026-04-03");

    expect(result).toEqual({ malformed: true, periodsConsidered: 0, remindersSent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("sends the due-soon reminder two days before the grace-adjusted due date", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb(
        { rows: [{ reminderRules: ENABLED, submissionGraceDays: 5 }] },
        { rows: [PERIOD] },
      ),
      notifications,
    );

    /** Period ends 03-31, grace 5 -> due 04-05; two days before is 04-03. */
    const result = await sweep.remindOrg("org-1", "2026-04-03");

    expect(result).toMatchObject({ periodsConsidered: 1, remindersSent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.eventKey).toBe("timesheets.period.due_soon");
    expect(sent[0]!.targetUserIds).toEqual(["u-1"]);
    expect(sent[0]!.entityId).toBe("11");
  });

  it("sends the overdue reminder the day after, with the harsher wording", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb(
        { rows: [{ reminderRules: ENABLED, submissionGraceDays: 5 }] },
        { rows: [PERIOD] },
      ),
      notifications,
    );

    const result = await sweep.remindOrg("org-1", "2026-04-06");

    expect(result).toMatchObject({ remindersSent: 1 });
    expect(sent[0]!.eventKey).toBe("timesheets.period.overdue");
    expect(sent[0]!.title).toContain("overdue");
  });

  it("counts a period it considers but does not remind about", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb(
        { rows: [{ reminderRules: ENABLED, submissionGraceDays: 5 }] },
        { rows: [PERIOD] },
      ),
      notifications,
    );

    /** 04-04 matches neither [2] before nor [1] after. */
    const result = await sweep.remindOrg("org-1", "2026-04-04");

    expect(result).toMatchObject({ periodsConsidered: 1, remindersSent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("reminds each unsubmitted period separately", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb(
        { rows: [{ reminderRules: ENABLED, submissionGraceDays: 5 }] },
        { rows: [PERIOD, { ...PERIOD, id: 12, userId: "u-2" }] },
      ),
      notifications,
    );

    const result = await sweep.remindOrg("org-1", "2026-04-03");

    expect(result).toMatchObject({ periodsConsidered: 2, remindersSent: 2 });
    expect(sent.map((s) => s.targetUserIds[0])).toEqual(["u-1", "u-2"]);
  });

  it("treats a null submission grace as due on the period end", async () => {
    const { service: notifications, sent } = stubNotifications();
    const sweep = new TimesheetRemindersSweepService(
      stubDb(
        { rows: [{ reminderRules: ENABLED, submissionGraceDays: null }] },
        { rows: [PERIOD] },
      ),
      notifications,
    );

    /** Due 03-31; two days before is 03-29. */
    const result = await sweep.remindOrg("org-1", "2026-03-29");

    expect(result).toMatchObject({ remindersSent: 1 });
    expect(sent[0]!.eventKey).toBe("timesheets.period.due_soon");
  });
});
