import { ForbiddenException } from "@nestjs/common";
import { TimesheetsService } from "./timesheets.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
    } as unknown as Db;
    /**
     * The manage grant, expressed through the method the service actually calls.
     *
     * `TimesheetsService` asks `access.holds`; this described only
     * `resolveUserPermissions`, so every call threw a `TypeError` — which the
     * self-approval cases mistook for the `ForbiddenException` they assert,
     * while the case that should succeed simply failed. The set below stays the
     * one place the grant is stated.
     */
    const granted = new Set(["build:timesheets:manage"]);
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(granted),
      holds: jest.fn(async (_user: unknown, key: string) => granted.has(key)),
    } as unknown as AccessService;
    const cache = { del: jest.fn(), get: jest.fn(), set: jest.fn() } as unknown as CacheService;
    const periods = {} as unknown as EntriesPeriodService;
    svc = new TimesheetsService(db, cache, access, periods);
  });

  it("rejects approving an entry the actor logged themselves", async () => {
    findFirst.mockResolvedValueOnce({
      id: 1,
      orgId: ORG_ID,
      userId: "approver-1",
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
      userId: "approver-1",
      status: "PENDING",
      payrollStatus: null,
    });
    await expect(
      svc.rejectEntry(makeUser(), 1, { reason: "no" } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("allows approving another person's entry", async () => {
    findFirst.mockResolvedValueOnce({
      id: 2,
      orgId: ORG_ID,
      userId: "someone-else",
      status: "PENDING",
      payrollStatus: null,
    });
    await expect(svc.approveEntry(makeUser(), 2)).resolves.toEqual({ success: true });
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });
});
