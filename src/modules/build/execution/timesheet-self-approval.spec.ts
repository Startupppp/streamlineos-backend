import { ForbiddenException } from "@nestjs/common";
import { TimesheetsService } from "./timesheets.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL, humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { EntriesPeriodService } from "../../timesheets/core/entries-period.service";

const ORG_ID = "org-1";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "approver-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

describe("TimesheetsService — approver cannot action their own entry", () => {
  let svc: TimesheetsService;
  let findFirst: jest.Mock;
  let updateWhere: jest.Mock;

  beforeEach(() => {
    findFirst = jest.fn();
    updateWhere = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { timesheets: { findFirst } },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: updateWhere }),
      }),
      // Approving now resolves the approver's membership, because
      // `timesheets.approved_by` was contracted onto the membership actor.
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 7, userId: "approver", status: "ACTIVE" }]),
          }),
        }),
      }),
    } as unknown as Db;
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:timesheets:manage"])),
      holds: jest.fn().mockResolvedValue(true),
    } as unknown as AccessService;
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined), del: jest.fn(), get: jest.fn(), set: jest.fn() } as unknown as CacheService;
    const periods = {} as unknown as EntriesPeriodService;
    svc = new TimesheetsService(db, cache, access, periods);
  });

  it("rejects approving an entry the actor logged themselves", async () => {
    findFirst.mockResolvedValueOnce({
      id: 1,
      orgId: ORG_ID,
      userMembershipId: 1,
      status: "PENDING",
      payrollStatus: null,
    });
    await expect(svc.approveEntry(makeUser(), 1)).rejects.toThrow(ForbiddenException);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("rejects rejecting an entry the actor logged themselves", async () => {
    findFirst.mockResolvedValueOnce({
      id: 1,
      orgId: ORG_ID,
      userMembershipId: 1,
      status: "PENDING",
      payrollStatus: null,
    });
    await expect(
      svc.rejectEntry(makeUser(), 1, { reason: "no" } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("rejects approving when the actor has no membership identity — fails closed", async () => {
    findFirst.mockResolvedValueOnce({ id: 1, orgId: ORG_ID, userMembershipId: 2, status: "PENDING", payrollStatus: null });
    await expect(svc.approveEntry(makeUser({ principal: ACCOUNT_ONLY_PRINCIPAL }), 1)).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects rejecting when the actor has no membership identity — fails closed", async () => {
    findFirst.mockResolvedValueOnce({ id: 1, orgId: ORG_ID, userMembershipId: 2, status: "PENDING", payrollStatus: null });
    await expect(
      svc.rejectEntry(makeUser({ principal: ACCOUNT_ONLY_PRINCIPAL }), 1, { reason: "no" } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("allows approving another person's entry", async () => {
    findFirst.mockResolvedValueOnce({
      id: 2,
      orgId: ORG_ID,
      userMembershipId: 2,
      status: "PENDING",
      payrollStatus: null,
    });
    await expect(svc.approveEntry(makeUser(), 2)).resolves.toEqual({ success: true });
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});
