import { PayslipTemplatesService } from "../payslip-templates.service";

function makeDb(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const existingLimit = jest.fn().mockResolvedValue([{ id: 1 }]);
  const existingFrom = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({ limit: existingLimit }),
  });
  const select = jest
    .fn()
    .mockReturnValueOnce({ from: existingFrom })
    .mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("PayslipTemplatesService.list cursor pagination", () => {
  it("caps at 100 and requests a sentinel row", async () => {
    const { db, limit } = makeDb([]);
    await new PayslipTemplatesService(db).list("org-1", undefined, 200);
    expect(limit).toHaveBeenCalledWith(101);
  });

  it("trims the sentinel from the response", async () => {
    const { db } = makeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const result = await new PayslipTemplatesService(db).list(
      "org-1",
      undefined,
      2,
    );
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.pagination.hasMore).toBe(true);
  });
});
