import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PeriodsSubmitService } from "./periods-submit.service";

describe("PeriodsSubmitService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeTx() {
    const updateChain = { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([]) };
    return { update: jest.fn().mockReturnValue(updateChain) };
  }

  function makeSvc(periodRow: unknown) {
    let calledWithOrg: string | undefined;
    const reader = {
      getPeriodWithUser: jest.fn().mockImplementation(async (orgId: string) => {
        calledWithOrg = orgId;
        return periodRow;
      }),
      getSettings: jest.fn().mockResolvedValue(null),
      mapPeriod: jest.fn().mockImplementation((r: unknown) => r),
    };
    const db = {
      query: { timesheets: { findMany: jest.fn().mockResolvedValue([]) } },
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(makeTx())),
    } as unknown as Db;
    const entries = { recomputePeriodTotals: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    const svc = new PeriodsSubmitService(db, reader as never, entries as never, audit as never);
    return { svc, getCalledOrg: () => calledWithOrg };
  }

  it("DENY: submitPeriod throws NotFoundException when the period does not belong to the requesting org (cross-tenant isolation)", async () => {
    const { svc, getCalledOrg } = makeSvc(null);
    const u = {
      orgId: ATTACKER_ORG,
      userId: "attacker",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 55, isOrgOwner: false },
    };

    await expect(svc.submitPeriod(u as never, 999)).rejects.toThrow(NotFoundException);
    expect(getCalledOrg()).toBe(ATTACKER_ORG);
    expect(getCalledOrg()).not.toBe(OWNER_ORG);
  });

  it("CONTROL: submitPeriod proceeds when the period belongs to the requesting org", async () => {
    const fakeRow = {
      id: 1, orgId: OWNER_ORG, userMembershipId: 10, status: "OPEN",
      periodStart: "2026-01-01", periodEnd: "2026-01-07",
      totalHours: "8", billableHours: "8", nonBillableHours: "0",
      submittedAt: null, approvedAt: null, rejectedAt: null, lockedAt: null,
      currentApproverMembershipId: null, rejectionReason: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const { svc, getCalledOrg } = makeSvc(fakeRow);
    const u = {
      orgId: OWNER_ORG,
      userId: "owner-user",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 10, isOrgOwner: false },
    };

    await svc.submitPeriod(u as never, 1);

    expect(getCalledOrg()).toBe(OWNER_ORG);
  });
});
