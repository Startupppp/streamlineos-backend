import { PayeeEligibilityService } from "./payee-eligibility.service";
import type { Db } from "../../../db/drizzle.module";

function createDb(rows: Array<Array<Record<string, unknown>>>): Db {
  let cursor = 0;
  const chain = () => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where"]) link[method] = () => link;
    link["limit"] = () => Promise.resolve(rows[cursor++] ?? []);
    return link;
  };
  return { select: jest.fn(() => chain()) } as unknown as Db;
}

const ORG = "org-1";

describe("PayeeEligibilityService", () => {
  it("explains a login-less payee as payable through their worker record", async () => {
    const service = new PayeeEligibilityService(
      createDb([
        [{ organizationPersonId: "p-1", userId: null, membershipId: null }],
        [{ workerId: "w-1", isPayee: true }],
        [{ employmentId: 4, employeeNumber: "E-4", lifecycleStatus: "ACTIVE" }],
      ]),
    );
    const result = await service.getEligibility(ORG, "p-1");
    expect(result.payable).toBe(true);
    expect(result.payableAs).toBe("worker");
    expect(result.payeeWorkerId).toBe("w-1");
    expect(result.payeeUserId).toBeNull();
    expect(result.reason).toBe("payable");
  });

  it("surfaces the divergence the ticket exists for — employed, yet nobody can pay them", async () => {
    const service = new PayeeEligibilityService(
      createDb([
        [{ organizationPersonId: "p-2", userId: null, membershipId: null }],
        [{ workerId: "w-2", isPayee: false }],
        [{ employmentId: 5, employeeNumber: "E-5", lifecycleStatus: "ACTIVE" }],
      ]),
    );
    const result = await service.getEligibility(ORG, "p-2");
    expect(result.payable).toBe(false);
    expect(result.employment).not.toBeNull();
    expect(result.reason).toBe("employed-but-not-payable");
  });

  it("separates a person nobody employs from a person nobody recorded", async () => {
    const neverEmployed = new PayeeEligibilityService(
      createDb([[{ organizationPersonId: "p-3", userId: null, membershipId: null }], [], []]),
    );
    expect((await neverEmployed.getEligibility(ORG, "p-3")).reason).toBe("not-payable");

    const unknown = new PayeeEligibilityService(createDb([[]]));
    const result = await unknown.getEligibility(ORG, "ghost");
    expect(result.reason).toBe("unknown-person");
    expect(result.resolvedVia).toBeNull();
  });

  it("reports the payee identity for a person who holds a login", async () => {
    const service = new PayeeEligibilityService(
      createDb([[{ organizationPersonId: "p-4", userId: "user-4", membershipId: 2 }], [], []]),
    );
    const result = await service.getEligibility(ORG, "p-4");
    expect(result.payableAs).toBe("user");
    expect(result.payeeUserId).toBe("user-4");
    expect(result.payeeWorkerId).toBeNull();
  });
});
