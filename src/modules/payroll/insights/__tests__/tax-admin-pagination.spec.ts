import { TaxAdminService } from "../tax-admin.service";

function makeDb(rows: unknown[] = []) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("TaxAdminService.listDeclarations — pagination cap", () => {
  const orgId = "org-1";

  it("caps at 100 when caller requests more", async () => {
    const { db, limit } = makeDb();
    const svc = new TaxAdminService(db);
    await svc.listDeclarations(orgId, {}, 1, 500);
    expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
  });

  it("uses default limit=50 when none supplied", async () => {
    const { db, limit } = makeDb();
    const svc = new TaxAdminService(db);
    await svc.listDeclarations(orgId, {});
    expect(limit.mock.calls[0]?.[0]).toBe(50);
  });
});
