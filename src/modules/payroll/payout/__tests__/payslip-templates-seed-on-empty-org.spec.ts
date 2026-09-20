jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  ),
}));

import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { PayslipTemplatesService } from "../payslip-templates.service";

const mockedRunInNew = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

function makeEmptyOrgDb() {
  const returning = jest.fn().mockResolvedValue([
    { id: 1, orgId: "org-empty", name: "Classic Table", layout: "CLASSIC", config: { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false }, isDefault: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 2, orgId: "org-empty", name: "Modern Compact", layout: "MODERN", config: { accent: "#3b82f6", showEmployerContributions: false, showYtd: false }, isDefault: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 3, orgId: "org-empty", name: "Detailed Compliance", layout: "COMPLIANCE", config: { accent: "#1e293b", showEmployerContributions: true, showYtd: false }, isDefault: false, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });

  const existingLimit = jest.fn().mockResolvedValue([]);
  const existingFrom = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({ limit: existingLimit }),
  });
  const select = jest.fn().mockReturnValueOnce({ from: existingFrom });

  return { db: { select, insert } as never, insert };
}

describe("PayslipTemplatesService.list seeding on an empty org", () => {
  beforeEach(() => {
    mockedRunInNew.mockClear();
  });

  it("seeds default templates in a new independent transaction so the INSERT does not execute inside the read-only request transaction", async () => {
    const { db, insert } = makeEmptyOrgDb();
    const svc = new PayslipTemplatesService(db);

    const result = await svc.list("org-empty");

    expect(mockedRunInNew).toHaveBeenCalledWith(db, "org-empty", expect.any(Function));
    expect(insert).toHaveBeenCalled();
    expect(result.data).toHaveLength(3);
  });

  it("returns the three seeded rows with their database ids so callers can reference templateId for PATCH and DELETE", async () => {
    const { db } = makeEmptyOrgDb();
    const result = await new PayslipTemplatesService(db).list("org-empty");

    const ids = result.data.map((row) => (row as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
  });
});
