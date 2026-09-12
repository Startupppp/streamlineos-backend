import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntriesService } from "./entries.service";
import { AccessService } from "../../access/access.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { EntriesReadService } from "./entries-read.service";
import { EntriesPeriodService } from "./entries-period.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function humanSession(membershipId: number): CurrentUserContext {
  return {
    userId: "bbbbbbbb-0000-0000-0000-000000000001",
    orgId: "aaaaaaaa-0000-0000-0000-000000000001",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId, isOrgOwner: false },
  };
}

function makeUniqueViolation(constraintName: string): Error {
  const cause = Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint_name: constraintName,
  });
  return Object.assign(new Error("Failed query: insert into timesheets (...)"), { cause });
}

/**
 * The guard catches around the INSERT, inside the transaction (TS-13), so the
 * transaction double runs its callback against a handle whose insert raises. A
 * double that rejected from `transaction()` itself never reaches that catch and
 * would only pass against a guard wrapped around the whole transaction.
 */
function txWhoseInsertRejects(error: Error) {
  return {
    insert: () => ({ values: () => ({ returning: () => Promise.reject(error) }) }),
  };
}

function runsCallbackAgainst(tx: unknown) {
  return jest.fn((body: (handle: unknown) => Promise<unknown>) => body(tx));
}

describe("EntriesService.createEntry – 23505 guard", () => {
  it(
    "maps a unique-index violation on uniq_timesheets_work_log to ConflictException (409) " +
      "instead of letting it surface as an unhandled 500",
    async () => {
      const dbError = makeUniqueViolation("uniq_timesheets_work_log");

      const mockDb = {
        select: jest.fn().mockReturnValue({
          from: () => ({
            where: () => Promise.resolve([{ total: "0" }]),
          }),
        }),
        transaction: runsCallbackAgainst(txWhoseInsertRejects(dbError)),
      };

      const mockPeriod = {
        loadSettings: jest.fn().mockResolvedValue(null),
        getOrCreatePeriod: jest.fn().mockResolvedValue(1),
        syncTicketTimeSpent: jest.fn(),
        recomputePeriodTotals: jest.fn(),
      };

      const mod = await Test.createTestingModule({
        providers: [
          EntriesService,
          { provide: DRIZZLE, useValue: mockDb },
          { provide: AccessService, useValue: {} },
          { provide: TimesheetsAuditService, useValue: {} },
          { provide: EntriesReadService, useValue: {} },
          { provide: EntriesPeriodService, useValue: mockPeriod },
        ],
      }).compile();

      const service = mod.get(EntriesService);

      await expect(
        service.createEntry(humanSession(1), {
          date: "2026-06-30",
          hours: 1,
          description: "test entry",
        }),
      ).rejects.toThrow(ConflictException);
    },
  );

  it("re-throws unrelated database errors unchanged", async () => {
    const unrelated = Object.assign(new Error("Failed query: insert into timesheets"), {
      cause: Object.assign(new Error("connection reset"), { code: "08006" }),
    });

    const mockDb = {
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([{ total: "0" }]),
        }),
      }),
      transaction: runsCallbackAgainst(txWhoseInsertRejects(unrelated)),
    };

    const mockPeriod = {
      loadSettings: jest.fn().mockResolvedValue(null),
      getOrCreatePeriod: jest.fn().mockResolvedValue(1),
      syncTicketTimeSpent: jest.fn(),
      recomputePeriodTotals: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        EntriesService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: {} },
        { provide: TimesheetsAuditService, useValue: {} },
        { provide: EntriesReadService, useValue: {} },
        { provide: EntriesPeriodService, useValue: mockPeriod },
      ],
    }).compile();

    const service = mod.get(EntriesService);

    await expect(
      service.createEntry(humanSession(1), {
        date: "2026-06-30",
        hours: 1,
      }),
    ).rejects.toBe(unrelated);
  });
});
