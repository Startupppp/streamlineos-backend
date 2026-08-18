process.env.APP_URL ??= "http://localhost:1000";

import { ServiceUnavailableException } from "@nestjs/common";
import {
  AttendanceEventWriterService,
  type AttendanceCommandIdentity,
  type PreparedAttendanceCommand,
} from "./attendance-event-writer.service";

function limitedQuery<Row>(rows: readonly Row[]) {
  const query = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
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

const commandIdentity: AttendanceCommandIdentity = {
  organizationId: "organization-1",
  actorUserId: "user-1",
  businessDate: "2026-08-18",
  organizationTimezone: "Asia/Kolkata",
  commandScope: "hr.attendance.check-in",
  commandId: " command-1 ",
};

const canonicalCommand: Extract<
  PreparedAttendanceCommand,
  { state: "CANONICAL" }
> = {
  state: "CANONICAL",
  organizationId: "organization-1",
  actorUserId: "user-1",
  actorMembershipId: 17,
  businessDate: "2026-08-18",
  organizationTimezone: "Asia/Kolkata",
  commandScope: "hr.attendance.check-out",
  commandId: "command-2",
  workerId: "worker-1",
  workerEngagementId: "engagement-1",
};

describe("AttendanceEventWriterService", () => {
  const service = new AttendanceEventWriterService();

  it("keeps legacy mode available when the migration profile relation is absent", async () => {
    const transaction = {
      execute: jest
        .fn()
        .mockResolvedValue([{ relationAvailable: false }]),
      select: jest.fn(),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).resolves.toBeNull();
    expect(transaction.select).not.toHaveBeenCalled();
  });

  it("defaults an organization without a migration profile row to legacy mode", async () => {
    const profileQuery = limitedQuery([]);
    const transaction = {
      execute: jest.fn().mockResolvedValue([{ relationAvailable: true }]),
      select: jest.fn().mockReturnValue(profileQuery),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).resolves.toBeNull();
    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it("fails closed when dual mode is enabled before canonical relations exist", async () => {
    const profileQuery = limitedQuery([{ attendanceWriteMode: "DUAL" }]);
    const transaction = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([{ relationAvailable: true }])
        .mockResolvedValueOnce([{ relationsAvailable: false }]),
      select: jest.fn().mockReturnValue(profileQuery),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });

  it("fails closed for canonical projection mode until its writer is active", async () => {
    const profileQuery = limitedQuery([
      { attendanceWriteMode: "EVENT_WITH_PROJECTION" },
    ]);
    const transaction = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([{ relationAvailable: true }])
        .mockResolvedValueOnce([{ relationsAvailable: true }]),
      select: jest.fn().mockReturnValue(profileQuery),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });

  it("resolves one active tenant-scoped worker engagement in dual mode", async () => {
    const profileQuery = limitedQuery([{ attendanceWriteMode: "DUAL" }]);
    const locatorQuery = limitedQuery([]);
    const subjectQuery = limitedQuery([
      {
        workerId: "worker-1",
        workerEngagementId: "engagement-1",
        actorMembershipId: 17,
      },
    ]);
    const transaction = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([{ relationAvailable: true }])
        .mockResolvedValueOnce([{ relationsAvailable: true }]),
      select: jest
        .fn()
        .mockReturnValueOnce(profileQuery)
        .mockReturnValueOnce(locatorQuery)
        .mockReturnValueOnce(subjectQuery),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).resolves.toEqual({
      state: "CANONICAL",
      ...commandIdentity,
      commandId: "command-1",
      workerId: "worker-1",
      workerEngagementId: "engagement-1",
      actorMembershipId: 17,
    });
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    expect(transaction.select).toHaveBeenCalledTimes(3);
  });

  it("returns replay before loading the workforce subject for a retried command", async () => {
    const profileQuery = limitedQuery([{ attendanceWriteMode: "DUAL" }]);
    const locatorQuery = limitedQuery([{ eventId: 91n }]);
    const transaction = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([{ relationAvailable: true }])
        .mockResolvedValueOnce([{ relationsAvailable: true }]),
      select: jest
        .fn()
        .mockReturnValueOnce(profileQuery)
        .mockReturnValueOnce(locatorQuery),
    };

    await expect(
      service.prepareCommand(transaction as never, commandIdentity),
    ).resolves.toEqual({ state: "REPLAY" });
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    expect(transaction.select).toHaveBeenCalledTimes(2);
  });

  it("writes permanent locators before immutable event facts in effect order", async () => {
    const locatorReturning = jest.fn().mockResolvedValue([
      { eventId: 100n, effectOrdinal: 0 },
      { eventId: 101n, effectOrdinal: 1 },
    ]);
    const locatorConflict = jest
      .fn()
      .mockReturnValue({ returning: locatorReturning });
    const locatorValues = jest
      .fn()
      .mockReturnValue({ onConflictDoNothing: locatorConflict });
    const eventValues = jest.fn().mockResolvedValue(undefined);
    const transaction = {
      insert: jest
        .fn()
        .mockReturnValueOnce({ values: locatorValues })
        .mockReturnValueOnce({ values: eventValues }),
    };
    const occurredAt = new Date("2026-08-18T10:00:00.000Z");

    await service.appendEvents(transaction as never, canonicalCommand, [
      { eventKind: "BREAK_END", occurredAt },
      { eventKind: "CHECK_OUT", occurredAt },
    ]);

    expect(locatorValues).toHaveBeenCalledWith([
      expect.objectContaining({
        organizationId: "organization-1",
        commandScope: "hr.attendance.check-out",
        commandId: "command-2",
        effectOrdinal: 0,
        sourceType: "COMMAND",
        sourceId: "command-2",
        sourceOrdinal: 0,
      }),
      expect.objectContaining({
        effectOrdinal: 1,
        sourceType: "COMMAND",
        sourceId: "command-2",
        sourceOrdinal: 1,
      }),
    ]);
    expect(eventValues).toHaveBeenCalledWith([
      expect.objectContaining({
        eventId: 100n,
        eventKind: "BREAK_END",
        workerId: "worker-1",
        workerEngagementId: "engagement-1",
        actorMembershipId: 17,
        actorUserId: "user-1",
        sourceType: "COMMAND",
        sourceId: "command-2",
        effectOrdinal: 0,
      }),
      expect.objectContaining({
        eventId: 101n,
        eventKind: "CHECK_OUT",
        effectOrdinal: 1,
      }),
    ]);
    expect(locatorValues.mock.invocationCallOrder[0]).toBeLessThan(
      eventValues.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("does not duplicate facts when every effect locator already exists", async () => {
    const locatorReturning = jest.fn().mockResolvedValue([]);
    const locatorConflict = jest
      .fn()
      .mockReturnValue({ returning: locatorReturning });
    const locatorValues = jest
      .fn()
      .mockReturnValue({ onConflictDoNothing: locatorConflict });
    const replayQuery = resolvedWhereQuery([
      { effectOrdinal: 0 },
      { effectOrdinal: 1 },
    ]);
    const transaction = {
      insert: jest.fn().mockReturnValue({ values: locatorValues }),
      select: jest.fn().mockReturnValue(replayQuery),
    };

    await expect(
      service.appendEvents(transaction as never, canonicalCommand, [
        { eventKind: "BREAK_END", occurredAt: new Date() },
        { eventKind: "CHECK_OUT", occurredAt: new Date() },
      ]),
    ).resolves.toBeUndefined();
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });
});
