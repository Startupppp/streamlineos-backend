jest.mock("../../../../common/tenant/for-each-org", () => ({
  forEachOrg: async (
    db: unknown,
    _sweep: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(db, "org-1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { computeNextCronDate } from "../cron-next";
import { WorkflowScheduleTickService } from "../workflow-schedule-tick.service";
import type { Db } from "../../../../db/drizzle.module";

describe("computeNextCronDate", () => {
  const tz = "UTC";

  it("returns the next matching minute for every-minute cron", () => {
    const after = new Date("2026-08-31T10:00:00.000Z");
    const next = computeNextCronDate("* * * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBe(new Date("2026-08-31T10:01:00.000Z").getTime());
  });

  it("returns the next hourly slot for '0 * * * *'", () => {
    const after = new Date("2026-08-31T10:15:00.000Z");
    const next = computeNextCronDate("0 * * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-08-31T11:00:00.000Z");
  });

  it("returns the next daily midnight for '0 0 * * *'", () => {
    const after = new Date("2026-08-31T10:00:00.000Z");
    const next = computeNextCronDate("0 0 * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("advances past the month boundary for '0 9 1 * *'", () => {
    const after = new Date("2026-08-31T09:30:00.000Z");
    const next = computeNextCronDate("0 9 1 * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("returns null for an invalid cron expression", () => {
    expect(computeNextCronDate("not a cron", tz, new Date())).toBeNull();
    expect(computeNextCronDate("* * *", tz, new Date())).toBeNull();
  });

  it("handles step expressions like '*/15 * * * *'", () => {
    const after = new Date("2026-08-31T10:00:00.000Z");
    const next = computeNextCronDate("*/15 * * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-08-31T10:15:00.000Z");
  });

  it("handles comma-separated minute lists like '5,30 * * * *'", () => {
    const after = new Date("2026-08-31T10:07:00.000Z");
    const next = computeNextCronDate("5,30 * * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-08-31T10:30:00.000Z");
  });

  it("skips back to the after date — does not fire for the same minute as after", () => {
    const after = new Date("2026-08-31T10:00:00.000Z");
    const next = computeNextCronDate("0 10 * * *", tz, after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("respects a non-UTC timezone", () => {
    const after = new Date("2026-08-31T22:00:00.000Z");
    const next = computeNextCronDate("0 0 * * *", "America/New_York", after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });
});

describe("WorkflowScheduleTickService — idempotency and tenant isolation", () => {
  function makeTerminal(rows: unknown[]) {
    return Object.assign(Promise.resolve(rows), {
      limit: jest.fn().mockResolvedValue(rows),
      orderBy: jest.fn().mockReturnValue(
        Object.assign(Promise.resolve(rows), {
          limit: jest.fn().mockResolvedValue(rows),
        }),
      ),
    });
  }

  function makeDb(overrides: {
    dueSchedules?: unknown[];
    claimRows?: unknown[];
    workflowRow?: unknown;
    versionRow?: unknown;
    insertFn?: jest.Mock;
  } = {}): Db {
    const {
      dueSchedules = [],
      claimRows = [],
      workflowRow = undefined,
      versionRow = undefined,
      insertFn = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    } = overrides;

    const selectCalls = [
      dueSchedules,
      workflowRow !== undefined ? [workflowRow] : [],
      versionRow !== undefined ? [versionRow] : [],
    ];

    let selectCallCount = 0;

    return {
      select: jest.fn().mockImplementation(() => {
        const rows = selectCalls[selectCallCount] ?? [];
        selectCallCount++;
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(makeTerminal(rows)),
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
              where: jest.fn().mockReturnValue(makeTerminal(rows)),
            }),
          }),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(claimRows),
          }),
        }),
      }),
      insert: insertFn,
      query: { workflows: { findFirst: jest.fn() } },
    } as unknown as Db;
  }

  it("does not create an execution when no schedule is due", async () => {
    const insertFn = jest.fn().mockReturnValue({ values: jest.fn() });
    const db = makeDb({ dueSchedules: [], insertFn });
    const svc = new WorkflowScheduleTickService(db);

    const result = await svc.schedulesTick();

    expect(result.schedulesTriggered).toBe(0);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("skips execution creation when the UPDATE claim returns 0 rows (concurrent worker won)", async () => {
    const schedule = {
      id: "sched-1",
      workflowId: "wf-1",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-08-31T09:00:00.000Z"),
    };
    const insertFn = jest.fn().mockReturnValue({ values: jest.fn() });
    const db = makeDb({ dueSchedules: [schedule], claimRows: [], insertFn });
    const svc = new WorkflowScheduleTickService(db);

    const result = await svc.schedulesTick();

    expect(result.schedulesTriggered).toBe(0);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("creates a pending execution when a schedule is claimed successfully", async () => {
    const schedule = {
      id: "sched-1",
      workflowId: "wf-1",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-08-31T09:00:00.000Z"),
    };
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const insertFn = jest.fn().mockReturnValue({ values: insertValues });
    const db = makeDb({
      dueSchedules: [schedule],
      claimRows: [{ id: "sched-1" }],
      workflowRow: { id: "wf-1" },
      versionRow: { id: "ver-1" },
      insertFn,
    });
    const svc = new WorkflowScheduleTickService(db);

    const result = await svc.schedulesTick();

    expect(result.schedulesTriggered).toBe(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        workflowVersionId: "ver-1",
        triggerType: "schedule",
        triggeredBy: null,
        status: "pending",
      }),
    );
  });

  it("does not create an execution when the workflow is not published", async () => {
    const schedule = {
      id: "sched-2",
      workflowId: "wf-unpublished",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      nextRunAt: null,
    };
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const insertFn = jest.fn().mockReturnValue({ values: insertValues });
    const db = makeDb({
      dueSchedules: [schedule],
      claimRows: [{ id: "sched-2" }],
      workflowRow: undefined,
      insertFn,
    });
    const svc = new WorkflowScheduleTickService(db);

    const result = await svc.schedulesTick();

    expect(result.schedulesTriggered).toBe(1);
    expect(insertFn).not.toHaveBeenCalled();
  });
});

describe("WorkflowScheduleTickService — triggeredBy is always null for scheduled executions", () => {
  it("proof — the execution row has triggeredBy: null so the runner uses system context", async () => {
    const schedule = {
      id: "sched-3",
      workflowId: "wf-1",
      cronExpression: "* * * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-08-31T09:59:00.000Z"),
    };
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const insertFn = jest.fn().mockReturnValue({ values: insertValues });

    const makeTerminal = (rows: unknown[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve(rows), {
            limit: jest.fn().mockResolvedValue(rows),
          }),
        ),
      });

    let call = 0;
    const calls = [[schedule], [{ id: "wf-1" }], [{ id: "ver-1" }]];
    const db = {
      select: jest.fn().mockImplementation(() => {
        const rows = calls[call++] ?? [];
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(makeTerminal(rows)),
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
              where: jest.fn().mockReturnValue(makeTerminal(rows)),
            }),
          }),
        };
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: "sched-3" }]),
          }),
        }),
      }),
      insert: insertFn,
      query: {},
    } as unknown as Db;

    const svc = new WorkflowScheduleTickService(db);
    await svc.schedulesTick();

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: null }),
    );
  });
});
