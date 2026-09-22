import { BadRequestException } from "@nestjs/common";
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

/**
 * The schema only enforces `hours > 0` at the surface (`z.number().positive()`);
 * rounding happens after that check, in the service. `roundHours` truncates to
 * two decimal places, so an input as small as 0.004 survives the schema and
 * rounds to exactly 0 — the same "empty hours" case the schema was meant to
 * reject, reached through a different door.
 */
describe("EntriesService – zero-after-rounding guard", () => {
  const buildService = async () => {
    const mockDb = {
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([{ total: "0" }]),
        }),
      }),
      transaction: jest.fn(),
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
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions: jest.fn().mockResolvedValue({ has: () => false }),
          },
        },
        { provide: TimesheetsAuditService, useValue: {} },
        { provide: EntriesReadService, useValue: {} },
        { provide: EntriesPeriodService, useValue: mockPeriod },
      ],
    }).compile();
    return { service: mod.get(EntriesService), mockDb };
  };

  it("rejects a create whose rounded hours are 0, before touching the database", async () => {
    const { service, mockDb } = await buildService();

    await expect(
      service.createEntry(humanSession(1), {
        date: "2026-06-30",
        hours: 0.004,
        description: "test entry",
      }),
    ).rejects.toThrow(BadRequestException);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("rejects an update whose rounded hours are 0", async () => {
    const { service, mockDb } = await buildService();
    (mockDb as Record<string, unknown>).query = {
      timesheets: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          orgId: "aaaaaaaa-0000-0000-0000-000000000001",
          userMembershipId: 1,
          date: "2026-06-30",
          voidedAt: null,
          lockedAt: null,
          payrollStatus: "UNPROCESSED",
          invoicingStatus: "UNINVOICED",
          status: "PENDING",
          submittedAt: null,
        }),
      },
    };

    await expect(
      service.updateEntry(humanSession(1), 1, { hours: 0.004 }),
    ).rejects.toThrow(BadRequestException);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
