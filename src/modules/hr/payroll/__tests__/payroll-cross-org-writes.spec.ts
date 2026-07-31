import { ForbiddenException } from "@nestjs/common";
import { BonusesService } from "../../bonuses.service";
import { LoansService } from "../../loans.service";

function makeDb(membershipRow: unknown, insertResult: unknown[] = [{ id: 1 }]) {
  const findFirst = jest.fn().mockResolvedValue(membershipRow);
  const query = { organizationMembers: { findFirst } };

  const returning = jest.fn().mockResolvedValue(insertResult);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });

  return { query, insert };
}

describe("BonusesService.createBonus — cross-org write guard", () => {
  it("rejects creating a bonus for a user who is not a member of the org", async () => {
    const db = makeDb(undefined);
    const service = new BonusesService(db as never);

    await expect(
      service.createBonus("org-a", {
        userId: "user-in-org-b",
        type: "PERFORMANCE",
        amount: 5000,
        month: "2025-06",
      } as never),
    ).rejects.toThrow(ForbiddenException);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows creating a bonus for a confirmed org member", async () => {
    const db = makeDb({ id: 1 }, [{ id: 42, userId: "user-in-org-a", status: "PENDING" }]);
    const service = new BonusesService(db as never);

    const result = await service.createBonus("org-a", {
      userId: "user-in-org-a",
      type: "PERFORMANCE",
      amount: 5000,
      month: "2025-06",
    } as never);

    expect(result).toMatchObject({ id: 42 });
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("LoansService.createLoan — cross-org write guard", () => {
  it("rejects an admin creating a loan on behalf of a user who is not an org member", async () => {
    const db = makeDb(undefined);
    const service = new LoansService(db as never);

    await expect(
      service.createLoan("org-a", "admin-user", true, {
        userId: "user-in-org-b",
        amount: 10000,
        totalEmis: 5,
        reason: "advance",
      } as never),
    ).rejects.toThrow(ForbiddenException);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows a self-service loan request without a membership lookup", async () => {
    const db = makeDb(undefined, [{ id: 7, userId: "self-user" }]);
    const service = new LoansService(db as never);

    const result = await service.createLoan("org-a", "self-user", false, {
      amount: 10000,
      totalEmis: 5,
      reason: "advance",
    } as never);

    expect(result).toMatchObject({ id: 7 });
    expect(db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
  });

  it("allows an admin creating a loan for a confirmed org member", async () => {
    const db = makeDb({ id: 1 }, [{ id: 8, userId: "user-in-org-a" }]);
    const service = new LoansService(db as never);

    const result = await service.createLoan("org-a", "admin-user", true, {
      userId: "user-in-org-a",
      amount: 10000,
      totalEmis: 5,
      reason: "advance",
    } as never);

    expect(result).toMatchObject({ id: 8 });
    expect(db.insert).toHaveBeenCalled();
  });
});
