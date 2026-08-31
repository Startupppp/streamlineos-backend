import { PayslipTemplatesService } from "../payslip-templates.service";

function makeDb(rows: unknown[]) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const existingCheck = jest.fn().mockResolvedValue(rows.length > 0 ? [{ id: 1 }] : []);
  const fromCheck = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: existingCheck }) });
  const select = jest.fn()
    .mockReturnValueOnce({ from: fromCheck })
    .mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("PayslipTemplatesService.list — pagination cap", () => {
  const orgId = "org-1";

  it("caps at 100 when caller requests more", async () => {
    const { db, limit } = makeDb([{ id: 1 }]);
    const svc = new PayslipTemplatesService(db);
    await svc.list(orgId, 1, 200);
    expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
  });

  it("uses default limit=50 when none supplied", async () => {
    const { db, limit } = makeDb([{ id: 1 }]);
    const svc = new PayslipTemplatesService(db);
    await svc.list(orgId);
    expect(limit.mock.calls[0]?.[0]).toBe(50);
  });
});
