process.env.APP_URL ??= "http://localhost:1000";

import {
  decodeEmploymentListCursor,
  decodePeopleListCursor,
} from "./hr-core-list-cursors";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";

function cursorQueryDb(records: Array<{ id: number }>) {
  const query = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(records),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return {
    db: { select: jest.fn().mockReturnValue(query) },
    query,
  };
}

function legacyPeoplePageDb() {
  const dataQuery = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    offset: jest.fn().mockResolvedValue([{ id: 44 }]),
  };
  dataQuery.from.mockReturnValue(dataQuery);
  dataQuery.where.mockReturnValue(dataQuery);
  dataQuery.orderBy.mockReturnValue(dataQuery);
  dataQuery.limit.mockReturnValue(dataQuery);

  const totalQuery = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue([{ total: 21 }]),
  };
  totalQuery.from.mockReturnValue(totalQuery);

  return {
    db: {
      select: jest
        .fn()
        .mockReturnValueOnce(dataQuery)
        .mockReturnValueOnce(totalQuery),
    },
    dataQuery,
  };
}

describe("HrEmployeeRecordListsService cursor contracts", () => {
  it("returns a bounded people cursor page without an exact-count query", async () => {
    const { db, query } = cursorQueryDb([{ id: 11 }, { id: 12 }, { id: 13 }]);
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listPeopleCursor(
      "org-1",
      "actor-1",
      { limit: 2 },
      "all",
    );

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(result.data).toHaveLength(2);
    expect(result.pageInfo).toMatchObject({ limit: 2, hasMore: true });
    expect(
      decodePeopleListCursor(result.pageInfo.nextCursor ?? ""),
    ).toEqual({ personId: 12 });
  });

  it("returns a bounded employment cursor page with a descriptive boundary", async () => {
    const { db, query } = cursorQueryDb([{ id: 31 }, { id: 32 }]);
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listEmploymentsCursor(
      "org-1",
      "actor-1",
      { limit: 1 },
      "own",
    );

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(result.data).toHaveLength(1);
    expect(
      decodeEmploymentListCursor(result.pageInfo.nextCursor ?? ""),
    ).toEqual({ employmentId: 31 });
  });

  it("defensively caps direct service calls at one hundred records", async () => {
    const { db, query } = cursorQueryDb([]);
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listPeopleCursor(
      "org-1",
      "actor-1",
      { limit: 500 },
      "none",
    );

    expect(query.limit).toHaveBeenCalledWith(101);
    expect(result.pageInfo.limit).toBe(100);
  });

  it("preserves the explicit page compatibility response", async () => {
    const { db, dataQuery } = legacyPeoplePageDb();
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listPeoplePage(
      "org-1",
      "actor-1",
      { page: 2, limit: 20 },
      "all",
    );

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(dataQuery.offset).toHaveBeenCalledWith(20);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    });
  });
});
