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
    db: {
      select: jest.fn().mockReturnValue(query),
      execute: jest.fn().mockResolvedValue(records),
    },
    query,
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
      decodePeopleListCursor(result.pageInfo.nextCursor ?? "", {
        orgId: "org-1",
        actorUserId: "actor-1",
        scope: "all",
        search: null,
      }),
    ).toMatchObject({ personId: 12 });
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
      decodeEmploymentListCursor(result.pageInfo.nextCursor ?? "", {
        orgId: "org-1",
        actorUserId: "actor-1",
        scope: "own",
      }),
    ).toMatchObject({ employmentId: 31 });
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

  it("rejects a people cursor after its search scope changes", async () => {
    const { db } = cursorQueryDb([{ id: 11 }, { id: 12 }]);
    const service = new HrEmployeeRecordListsService(db as never);
    const firstPage = await service.listPeopleCursor(
      "org-1",
      "actor-1",
      { limit: 1, search: "Ada" },
      "all",
    );

    await expect(
      service.listPeopleCursor(
        "org-1",
        "actor-1",
        {
          cursor: firstPage.pageInfo.nextCursor ?? undefined,
          limit: 1,
          search: "Grace",
        },
        "all",
      ),
    ).rejects.toMatchObject({ response: { code: "INVALID_PEOPLE_CURSOR" } });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
