import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/tenant", () => ({
  getTenantContext: jest.fn(),
}));

import { getTenantContext } from "../../../common/tenant";
import { TaxComplianceService } from "./tax-compliance.service";

const AMBIENT_ORG = "org-ambient";
const OTHER_ORG = "org-other";

function buildDb(selectCallCount: { count: number }) {
  const orgRows = [{ id: AMBIENT_ORG }, { id: OTHER_ORG }];
  const liabilityRow = [{ cgst: "0", sgst: "0", igst: "0" }];

  return {
    select: jest.fn().mockImplementation(() => {
      selectCallCount.count++;
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve(liabilityRow)),
          limit: jest.fn().mockResolvedValue(orgRows),
        }),
      };
    }),
  } as unknown as Db;
}

function makeService(db: Db) {
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  const svc = new TaxComplianceService(db, dispatch as never);
  jest.spyOn(svc as unknown as { daysBetween: () => number }, "daysBetween").mockReturnValue(3);
  return svc;
}

describe("TaxComplianceService — ambient org isolation (getTenantContext fix)", () => {
  it("with ambient context and no explicit orgId: issues 2 select calls (one org, two liability queries)", async () => {
    (getTenantContext as jest.Mock).mockReturnValue({ orgId: AMBIENT_ORG, audience: "INTERNAL", tx: {} });
    const calls = { count: 0 };
    const db = buildDb(calls);
    const svc = makeService(db);

    await svc.checkTaxDue();

    expect(calls.count).toBe(2);
  });

  it("with explicit orgId: issues 2 select calls regardless of ambient context", async () => {
    (getTenantContext as jest.Mock).mockReturnValue({ orgId: AMBIENT_ORG, audience: "INTERNAL", tx: {} });
    const calls = { count: 0 };
    const db = buildDb(calls);
    const svc = makeService(db);

    await svc.checkTaxDue("org-explicit");

    expect(calls.count).toBe(2);
  });

  it("without ambient context: queries org list + 2 per org = 5 total select calls", async () => {
    (getTenantContext as jest.Mock).mockReturnValue(undefined);
    const calls = { count: 0 };
    const db = buildDb(calls);
    const svc = makeService(db);

    await svc.checkTaxDue();

    expect(calls.count).toBe(5);
  });
});
