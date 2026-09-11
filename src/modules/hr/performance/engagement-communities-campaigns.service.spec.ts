import { decodeTimestampCursor, encodeTimestampCursor } from "./cursor-pagination";
import { EngagementCommunitiesCampaignsService } from "./engagement-communities-campaigns.service";

function primitiveValues(value: unknown, seen = new WeakSet<object>()): unknown[] {
  if (value instanceof Date) return [value];
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => primitiveValues(entry, seen));
}

function community(id: number, createdAt: Date) {
  return {
    id,
    orgId: "org-1",
    name: `Community ${id}`,
    description: null,
    createdBy: "user-1",
    createdAt,
  };
}

describe("EngagementCommunitiesCampaignsService cursor pagination", () => {
  it("hydrates members only for sliced page IDs and returns the page boundary cursor", async () => {
    const boundary = {
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      recordId: 50,
    };
    const rows = Array.from({ length: 4 }, (_, index) =>
      community(49 - index, new Date(`2026-06-${String(4 - index).padStart(2, "0")}T00:00:00.000Z`)),
    );
    const pageLimit = jest.fn().mockResolvedValue(rows);
    const pageOrderBy = jest.fn(() => ({ limit: pageLimit }));
    const pageWhere = jest.fn((_predicate: unknown) => ({ orderBy: pageOrderBy }));
    const memberLimit = jest.fn().mockResolvedValue([
      { communityId: rows[0].id, userId: "user-1", role: "moderator" },
    ]);
    const memberWhere = jest.fn((_predicate: unknown) => ({ limit: memberLimit }));
    const select = jest
      .fn()
      .mockReturnValueOnce({ from: () => ({ where: pageWhere }) })
      .mockReturnValueOnce({ from: () => ({ where: memberWhere }) });
    const service = new EngagementCommunitiesCampaignsService({ select } as never);

    const result = await service.listCommunities("org-1", {
      cursor: encodeTimestampCursor(boundary),
      limit: 3,
    });

    expect(pageLimit).toHaveBeenCalledWith(4);
    expect(pageOrderBy.mock.calls[0]).toHaveLength(2);
    expect(primitiveValues(pageWhere.mock.calls[0][0])).toEqual(
      expect.arrayContaining(["org-1", boundary.createdAt, boundary.recordId]),
    );
    const hydratedIds = primitiveValues(memberWhere.mock.calls[0][0]);
    expect(hydratedIds).toEqual(expect.arrayContaining(rows.slice(0, 3).map((row) => row.id)));
    expect(hydratedIds).not.toContain(rows[3].id);
    expect(memberLimit).toHaveBeenCalledWith(500);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].members).toEqual([{ userId: "user-1", role: "moderator" }]);
    expect(decodeTimestampCursor(result.nextCursor!)).toEqual({
      createdAt: rows[2].createdAt,
      recordId: rows[2].id,
    });
  });

  it("skips member hydration for an empty page", async () => {
    const select = jest.fn(() => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: jest.fn().mockResolvedValue([]) }) }),
      }),
    }));
    const service = new EngagementCommunitiesCampaignsService({ select } as never);

    await expect(service.listCommunities("org-1", { limit: 30 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
