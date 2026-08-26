import { PayrollCalendarReminderScheduler } from "../payroll-calendar-reminder.scheduler";
import { logger } from "../../../../common/logger/logger.service";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

type FakeDbOptions = {
  claimRows: { jobName: string }[];
};

function createFakeDb(options: FakeDbOptions) {
  const selectCalls: number[] = [];
  const db = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          const result = Promise.resolve(undefined) as Promise<unknown> & {
            returning: () => Promise<{ jobName: string }[]>;
          };
          result.returning = () => Promise.resolve(options.claimRows);
          return result;
        }),
      }),
    })),
    select: jest.fn().mockImplementation(() => {
      selectCalls.push(1);
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      };
    }),
  };
  return { db, selectCalls };
}

describe("PayrollCalendarReminderScheduler daily claim", () => {
  it("runs the reminder sweep when the daily claim succeeds", async () => {
    const { db, selectCalls } = createFakeDb({ claimRows: [{ jobName: "payroll.calendar_reminders" }] });
    const notifications = { remindCalendarEvent: jest.fn() };
    const scheduler = new PayrollCalendarReminderScheduler(db as never, notifications as never);

    await scheduler.run();

    expect(selectCalls.length).toBe(1);
    expect(notifications.remindCalendarEvent).not.toHaveBeenCalled();
  });

  it("skips the sweep entirely when another instance already claimed today", async () => {
    const { db, selectCalls } = createFakeDb({ claimRows: [] });
    const notifications = { remindCalendarEvent: jest.fn() };
    const scheduler = new PayrollCalendarReminderScheduler(db as never, notifications as never);

    await scheduler.run();

    expect(selectCalls.length).toBe(0);
    expect(notifications.remindCalendarEvent).not.toHaveBeenCalled();
  });
});

describe("PayrollCalendarReminderScheduler markFinished error handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("logs a warning when markFinished rejects after a run error and rethrows the run error", async () => {
    const runError = new Error("select failed");
    const markFinishedError = new Error("db write failed");

    let updateCallCount = 0;
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            updateCallCount++;
            if (updateCallCount === 1) {
              const result = Promise.resolve(undefined) as Promise<unknown> & {
                returning: () => Promise<{ jobName: string }[]>;
              };
              result.returning = () => Promise.resolve([{ jobName: "payroll.calendar_reminders" }]);
              return result;
            }
            return Promise.reject(markFinishedError);
          }),
        }),
      })),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockRejectedValue(runError),
          }),
        }),
      }),
    };

    const notifications = { remindCalendarEvent: jest.fn() };
    const scheduler = new PayrollCalendarReminderScheduler(db as never, notifications as never);

    await expect(scheduler.run()).rejects.toBe(runError);
    expect(logger.warn as jest.Mock).toHaveBeenCalledWith(
      "payroll-calendar-reminder: markFinished failed after run error",
      expect.objectContaining({ cause: "db write failed" }),
    );
  });
});
