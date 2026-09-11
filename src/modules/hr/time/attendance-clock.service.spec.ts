process.env.APP_URL ??= "http://localhost:1000";

import { checkInSchema, checkOutSchema } from "./dto/attendance.schemas";
import { AttendanceClockService } from "./attendance-clock.service";

jest.mock("./organization-membership", () => ({
  requireOrganizationMembershipId: jest.fn().mockResolvedValue(1),
}));

function queryResult<T>(result: T) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn(),
    for: jest.fn(),
    orderBy: jest.fn(),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.for.mockResolvedValue(result);
  return query;
}

describe("AttendanceClockService", () => {
  it("rejects caller-selected attendance dates", () => {
    expect(checkInSchema.safeParse({ localDate: "2026-08-12" }).success).toBe(
      false,
    );
    expect(checkOutSchema.safeParse({ localDate: "2026-08-12" }).success).toBe(
      false,
    );
    expect(checkOutSchema.safeParse({}).success).toBe(true);
  });

  it("locks the organization, employee, and business date before check-in reads", async () => {
    const organizationQuery = queryResult([{ timezone: "Asia/Kolkata" }]);
    organizationQuery.limit.mockResolvedValue([{ timezone: "Asia/Kolkata" }]);

    const openSessionQuery = queryResult([]);
    const latestSessionQuery = queryResult([]);
    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest
        .fn()
        .mockReturnValueOnce(openSessionQuery)
        .mockReturnValueOnce(latestSessionQuery),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const db = {
      select: jest.fn().mockReturnValue(organizationQuery),
      transaction: jest.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
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
    };
    const eventWriter = {
      prepareCommand: jest.fn().mockResolvedValue(null),
      appendEvents: jest.fn(),
    };
    const service = new AttendanceClockService(
      db as never,
      automations as never,
      policies as never,
      eventWriter as never,
    );

    await expect(
      service.checkIn("org-1", "user-1", { location: null }, "command-1"),
    ).resolves.toEqual({ success: true });

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      tx.select.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(policies.getAttendanceRules).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });
});
