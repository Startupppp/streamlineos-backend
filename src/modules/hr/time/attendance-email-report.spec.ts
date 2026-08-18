import { BadRequestException, ForbiddenException, PayloadTooLargeException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";

jest.mock("../../rbac/permissions", () => ({
  ...jest.requireActual("../../rbac/permissions"),
  isScopable: jest.fn(() => true),
}));

import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";
import { attendanceEmailReportSchema } from "./dto/attendance.schemas";

const USER: CurrentUserContext = {
  userId: "manager-1",
  orgId: "org-1",
  role: "MEMBER",
  permissions: [],
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

function orgSelect(row: unknown) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(row ? [row] : []),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function recipientSelect(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

function reportSelect(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function makeService(options: {
  scope?: "none" | "own" | "team" | "all";
  recipientRows?: Array<{ email: string }>;
  reportRows?: unknown[];
} = {}) {
  const orgQuery = orgSelect({ name: "Acme", timezone: "Asia/Kolkata" });
  const recipientQuery = recipientSelect(
    options.recipientRows ?? [{ email: "manager@example.com" }],
  );
  const reportQuery = reportSelect(
    options.reportRows ?? [
      {
        userId: "employee-1",
        userName: "Employee One",
        totalHours: "160.00",
        autoCheckoutDays: 1,
        overtimeDays: 2,
        daysPresent: 20,
      },
    ],
  );
  const db = {
    select: jest
      .fn()
      .mockReturnValueOnce(orgQuery)
      .mockReturnValueOnce(recipientQuery)
      .mockReturnValueOnce(reportQuery),
  };
  const access = {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(
        new Map([["hr:attendance:manage", options.scope ?? "own"]]),
      ),
  };
  const queueAttendanceReportEmail = jest.fn().mockResolvedValue(1);
  const logCritical = jest.fn().mockResolvedValue(undefined);
  const service = new AttendanceService(
    db as never,
    access as never,
    { queueAttendanceReportEmail } as never,
    {} as never,
    {} as never,
    { logCritical } as never,
  );
  return {
    service,
    db,
    orgQuery,
    recipientQuery,
    reportQuery,
    queueAttendanceReportEmail,
    logCritical,
  };
}

describe("attendance email report contract", () => {
  it("normalizes recipients and accepts a 31-day range", () => {
    const result = attendanceEmailReportSchema.parse({
      to: [" Manager@Example.com "],
      startDate: "2020-01-01",
      endDate: "2020-01-31",
    });
    expect(result.to).toEqual(["manager@example.com"]);
  });

  it.each([
    {
      name: "more than ten recipients",
      input: {
        to: Array.from({ length: 11 }, (_, index) => `user${index}@example.com`),
      },
    },
    {
      name: "a duplicate recipient across fields",
      input: { to: ["USER@example.com"], cc: ["user@example.com"] },
    },
    {
      name: "only one date boundary",
      input: { to: ["user@example.com"], startDate: "2020-01-01" },
    },
    {
      name: "more than 31 days",
      input: {
        to: ["user@example.com"],
        startDate: "2020-01-01",
        endDate: "2020-02-01",
      },
    },
    {
      name: "an invalid calendar date",
      input: {
        to: ["user@example.com"],
        startDate: "2020-02-30",
        endDate: "2020-02-30",
      },
    },
  ])("rejects $name", ({ input }) => {
    expect(attendanceEmailReportSchema.safeParse(input).success).toBe(false);
  });

  it("requires manage permission and the attendance-report rate tier", () => {
    const handler = AttendanceController.prototype.emailReport;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION, handler)).toBe(
      "hr:attendance:manage",
    );
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe(
      "hr:attendance-report",
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      RateLimitGuard,
    );
  });
});

describe("AttendanceService.emailReport", () => {
  const input = {
    to: ["manager@example.com"],
    cc: [],
    bcc: [],
    startDate: "2020-01-01",
    endDate: "2020-01-31",
  };

  it("applies database scope and queues an audited aggregate", async () => {
    const test = makeService({ scope: "own" });

    await expect(test.service.emailReport(USER, input)).resolves.toEqual({
      queued: 1,
    });

    const whereSql = new PgDialect().sqlToQuery(
      test.reportQuery.where.mock.calls[0]?.[0],
    );
    expect(whereSql.params).toEqual(
      expect.arrayContaining(["org-1", "manager-1", "2020-01-01", "2020-01-31"]),
    );
    expect(test.reportQuery.groupBy).toHaveBeenCalled();
    expect(test.reportQuery.limit).toHaveBeenCalledWith(101);
    expect(test.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.attendance_report.email_requested",
        userId: "manager-1",
        orgId: "org-1",
        metadata: expect.objectContaining({
          dataScope: "own",
          employeeCount: 1,
          recipientCount: 1,
          deliveryStatus: "QUEUED",
        }),
      }),
    );
    expect(JSON.stringify(test.logCritical.mock.calls)).not.toContain(
      "manager@example.com",
    );
    expect(test.logCritical.mock.invocationCallOrder[0]).toBeLessThan(
      test.queueAttendanceReportEmail.mock.invocationCallOrder[0] ?? 0,
    );
    expect(test.queueAttendanceReportEmail).toHaveBeenCalledWith(
      "2020-01-01 to 2020-01-31",
      "Acme",
      [
        expect.objectContaining({
          name: "Employee One",
          totalHours: "160.00",
          daysPresent: 20,
        }),
      ],
      ["manager@example.com"],
      "org-1",
    );
  });

  it("fails closed when database permission resolution returns none", async () => {
    const test = makeService({ scope: "none" });
    await expect(test.service.emailReport(USER, input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(test.db.select).not.toHaveBeenCalled();
  });

  it("rejects recipients without an active tenant membership", async () => {
    const test = makeService({ recipientRows: [] });
    await expect(test.service.emailReport(USER, input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(test.reportQuery.from).not.toHaveBeenCalled();
    expect(test.queueAttendanceReportEmail).not.toHaveBeenCalled();
  });

  it("refuses an oversized synchronous report before auditing or queuing", async () => {
    const test = makeService({
      reportRows: Array.from({ length: 101 }, (_, index) => ({
        userId: `employee-${index}`,
        userName: `Employee ${index}`,
        totalHours: "8.00",
        autoCheckoutDays: 0,
        overtimeDays: 0,
        daysPresent: 1,
      })),
    });
    await expect(test.service.emailReport(USER, input)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(test.logCritical).not.toHaveBeenCalled();
    expect(test.queueAttendanceReportEmail).not.toHaveBeenCalled();
  });
});
