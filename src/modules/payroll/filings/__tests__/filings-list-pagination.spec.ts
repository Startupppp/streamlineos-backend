import { BadRequestException } from "@nestjs/common";
import { PayrollFilingsService } from "../filings.service";
import { decodePayrollTimestampCursor } from "../../payroll-cursor";

function makeDb(rows: unknown[] = []) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit, select };
}

const filing = (id: number) => ({
  id,
  orgId: "org-1",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
});

describe("PayrollFilingsService.list cursor pagination", () => {
  it("caps the page at 100 and requests one sentinel row", async () => {
    const { db, limit } = makeDb();
    await new PayrollFilingsService(db, {} as never, {} as never).list(
      "org-1",
      undefined,
      200,
    );
    expect(limit).toHaveBeenCalledWith(101);
  });

  it("uses the last kept duplicate-sort row for nextCursor", async () => {
    const { db } = makeDb([filing(3), filing(2), filing(1)]);
    const result = await new PayrollFilingsService(
      db,
      {} as never,
      {} as never,
    ).list("org-1", undefined, 2);

    expect(result.data.map((row) => row.id)).toEqual([3, 2]);
    expect(result.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(
      decodePayrollTimestampCursor(result.pagination.nextCursor ?? undefined, [
        "filings",
        "org-1",
      ]),
    ).toMatchObject({ id: 2 });
  });

  it("rejects malformed cursors before selecting", async () => {
    const { db, select } = makeDb();
    await expect(
      new PayrollFilingsService(db, {} as never, {} as never).list(
        "org-1",
        "invalid",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });
});
