import { BadRequestException } from "@nestjs/common";
import { encodeCursor } from "../../../common/pagination/cursor";
import { HrEffectiveChangesService } from "./hr-effective-changes.service";

function change(id: number, effectiveFrom = "2026-08-01") {
  return { id, effectiveFrom, status: "draft", changeType: "department" };
}

function listDb(rows: ReturnType<typeof change>[]) {
  const query = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return { db: { select: jest.fn().mockReturnValue(query) }, query };
}

describe("HrEffectiveChangesService.list cursor pagination", () => {
  it("uses a duplicate-safe sentinel and rejects tenant or filter changes", async () => {
    const { db, query } = listDb([change(3), change(2), change(1)]);
    const service = new HrEffectiveChangesService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const firstPage = await service.list("org-1", {
      limit: 2,
      changeType: "department",
      status: "draft",
    });

    expect(query.orderBy.mock.calls[0]).toHaveLength(2);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(firstPage.data.map((row) => row.id)).toEqual([3, 2]);
    expect(firstPage.pagination).toMatchObject({ limit: 2, hasMore: true });

    await expect(
      service.list("org-2", {
        limit: 2,
        changeType: "department",
        status: "draft",
        cursor: firstPage.pagination.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.list("org-1", {
        limit: 2,
        changeType: "manager",
        status: "draft",
        cursor: firstPage.pagination.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cursors before querying", async () => {
    const select = jest.fn();
    const service = new HrEffectiveChangesService(
      { select } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.list("org-1", { limit: 20, cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects impossible cursor dates before they reach the SQL keyset", async () => {
    const select = jest.fn();
    const service = new HrEffectiveChangesService(
      { select } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const cursor = encodeCursor({
      sortValue: "2026-99-99",
      id: JSON.stringify([1, "org-1", null, null, null]),
    });

    await expect(
      service.list("org-1", { limit: 20, cursor }),
    ).rejects.toMatchObject({
      response: { code: "INVALID_EFFECTIVE_CHANGE_CURSOR" },
    });
    expect(select).not.toHaveBeenCalled();
  });
});
