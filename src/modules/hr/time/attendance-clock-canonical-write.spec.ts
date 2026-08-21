process.env.APP_URL ??= "http://localhost:1000";

import { AttendanceClockService } from "./attendance-clock.service";
import type { PreparedAttendanceCommand } from "./attendance-event-writer.service";

function limitedQuery<Row>(rows: readonly Row[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function lockedQuery<Row>(rows: readonly Row[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    for: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function resolvedWhereQuery<Row>(rows: readonly Row[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  return query;
}

const canonicalCommand: Extract<
  PreparedAttendanceCommand,
  { state: "CANONICAL" }
> = {
  state: "CANONICAL",
  organizationId: "organization-1",
  actorUserId: "user-1",
  actorMembershipId: 21,
  businessDate: "2026-08-18",
  organizationTimezone: "Asia/Kolkata",
  commandScope: "hr.attendance.command",
  commandId: "command-1",
  workerId: "worker-1",
  workerEngagementId: "engagement-1",
};

function serviceDependencies(
  transaction: Record<string, jest.Mock>,
  eventWriter: {
    prepareCommand: jest.Mock;
    appendEvents: jest.Mock;
  },
  transactionRunner?: (
    callback: (transactionValue: typeof transaction) => Promise<unknown>,
  ) => Promise<unknown>,
) {
  const organizationQuery = limitedQuery([{ timezone: "Asia/Kolkata" }]);
  const db = {
    select: jest.fn().mockReturnValue(organizationQuery),
    transaction: jest.fn(
      transactionRunner ??
        (async (
          callback: (transactionValue: typeof transaction) => Promise<unknown>,
        ) => callback(transaction)),
    ),
  };
  const automations = { emit: jest.fn().mockResolvedValue(undefined) };
  const policies = {
    getAttendanceRules: jest.fn().mockResolvedValue({
      enforceGeofence: false,
      minReclockInMinutes: 0,
    }),
    getEffectiveShiftStartWithGrace: jest.fn().mockResolvedValue({
      shiftStartMinutes: 1_440,
      graceMinutes: 0,
    }),
    getOvertimeRules: jest.fn().mockResolvedValue({
      dailyThresholdMinutes: 480,
    }),
  };
  return {
    service: new AttendanceClockService(
      db as never,
      automations as never,
      policies as never,
      eventWriter as never,
    ),
    automations,
  };
}

describe("AttendanceClockService canonical dual writes", () => {
  it("treats a permanent canonical locator as a completed command retry", async () => {
    const transaction = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn(),
      insert: jest.fn(),
    };
    const eventWriter = {
      prepareCommand: jest.fn().mockResolvedValue({ state: "REPLAY" }),
      appendEvents: jest.fn(),
    };
    const { service, automations } = serviceDependencies(
      transaction,
      eventWriter,
    );

    await expect(
      service.checkIn(
        "organization-1",
        "user-1",
        { location: null },
        "command-1",
      ),
    ).resolves.toEqual({ success: true });
    expect(transaction.select).not.toHaveBeenCalled();
    expect(transaction.insert).not.toHaveBeenCalled();
    expect(eventWriter.appendEvents).not.toHaveBeenCalled();
    expect(automations.emit).not.toHaveBeenCalled();
  });

  it("rolls back the staged legacy write when the canonical append fails", async () => {
    const openSessionQuery = lockedQuery([]);
    const latestSessionQuery = lockedQuery([]);
    const stagedLegacyWrites: unknown[] = [];
    const committedLegacyWrites: unknown[] = [];
    const transaction = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest
        .fn()
        .mockReturnValueOnce(openSessionQuery)
        .mockReturnValueOnce(latestSessionQuery),
      insert: jest.fn().mockReturnValue({
        values: jest.fn((values: unknown) => {
          stagedLegacyWrites.push(values);
          return Promise.resolve(undefined);
        }),
      }),
    };
    const eventWriter = {
      prepareCommand: jest.fn().mockResolvedValue(canonicalCommand),
      appendEvents: jest
        .fn()
        .mockRejectedValue(new Error("canonical append failed")),
    };
    const transactionRunner = async (
      callback: (transactionValue: typeof transaction) => Promise<unknown>,
    ) => {
      const result = await callback(transaction);
      committedLegacyWrites.push(...stagedLegacyWrites);
      return result;
    };
    const { service } = serviceDependencies(
      transaction,
      eventWriter,
      transactionRunner,
    );

    await expect(
      service.checkIn(
        "organization-1",
        "user-1",
        { location: null },
        "command-1",
      ),
    ).rejects.toThrow("canonical append failed");
    expect(stagedLegacyWrites).toHaveLength(1);
    expect(committedLegacyWrites).toHaveLength(0);
  });

  it.each([
    {
      sessionStatus: "PRESENT",
      currentBreaks: [],
      expectedEventKind: "BREAK_START",
      expectedStatus: "ON_BREAK",
    },
    {
      sessionStatus: "ON_BREAK",
      currentBreaks: [{ start: "2026-08-18T09:00:00.000Z" }],
      expectedEventKind: "BREAK_END",
      expectedStatus: "PRESENT",
    },
  ])(
    "appends $expectedEventKind without mutating a canonical fact",
    async ({
      sessionStatus,
      currentBreaks,
      expectedEventKind,
      expectedStatus,
    }) => {
      const sessionQuery = lockedQuery([
        {
          attendanceId: 81,
          status: sessionStatus,
          breaks: currentBreaks,
          breakHours: "0.00",
        },
      ]);
      const updatedValues: unknown[] = [];
      const updateWhere = jest.fn().mockResolvedValue(undefined);
      const updateSet = jest.fn((values: unknown) => {
        updatedValues.push(values);
        return { where: updateWhere };
      });
      const transaction = {
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn().mockReturnValue(sessionQuery),
        update: jest.fn().mockReturnValue({ set: updateSet }),
      };
      const eventWriter = {
        prepareCommand: jest.fn().mockResolvedValue(canonicalCommand),
        appendEvents: jest.fn().mockResolvedValue(undefined),
      };
      const { service } = serviceDependencies(transaction, eventWriter);

      await expect(
        service.toggleBreak("organization-1", "user-1", "command-1"),
      ).resolves.toEqual({ success: true });
      expect(updatedValues).toEqual([
        expect.objectContaining({
          status: expectedStatus,
          workerId: "worker-1",
          workerEngagementId: "engagement-1",
        }),
      ]);
      expect(eventWriter.appendEvents).toHaveBeenCalledWith(
        transaction,
        canonicalCommand,
        [expect.objectContaining({ eventKind: expectedEventKind })],
      );
      expect(currentBreaks).toEqual(
        expectedEventKind === "BREAK_START"
          ? []
          : [{ start: "2026-08-18T09:00:00.000Z" }],
      );
    },
  );

  it("orders an implicit break end before checkout in one command", async () => {
    const sessionQuery = lockedQuery([
      {
        attendanceId: 91,
        checkIn: new Date("2026-08-18T08:00:00.000Z"),
        breaks: [{ start: "2026-08-18T09:00:00.000Z" }],
        breakHours: "0.00",
      },
    ]);
    const dailyRowsQuery = resolvedWhereQuery([
      { attendanceId: 91, workHours: null },
    ]);
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const transaction = {
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest
        .fn()
        .mockReturnValueOnce(sessionQuery)
        .mockReturnValueOnce(dailyRowsQuery),
      update: jest.fn().mockReturnValue({ set: updateSet }),
    };
    const eventWriter = {
      prepareCommand: jest.fn().mockResolvedValue(canonicalCommand),
      appendEvents: jest.fn().mockResolvedValue(undefined),
    };
    const { service } = serviceDependencies(transaction, eventWriter);

    await expect(
      service.checkOut("organization-1", "user-1", "command-1"),
    ).resolves.toEqual({ success: true });
    const effects = eventWriter.appendEvents.mock.calls[0]?.[2];
    expect(effects).toEqual([
      expect.objectContaining({ eventKind: "BREAK_END" }),
      expect.objectContaining({ eventKind: "CHECK_OUT" }),
    ]);
    expect(effects[0]?.occurredAt).toBe(effects[1]?.occurredAt);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "CHECKED_OUT",
        workerId: "worker-1",
        workerEngagementId: "engagement-1",
      }),
    );
  });
});
