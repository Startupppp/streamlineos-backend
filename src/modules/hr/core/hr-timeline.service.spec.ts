import { BadRequestException, NotFoundException } from "@nestjs/common";
import { encodeCursor } from "../../../common/pagination/cursor";
import * as applyScopeModule from "../../access/apply-scope";
import { HrTimelineService } from "./hr-timeline.service";
import { ScopedRead } from "../../access/scoped-read";

function emptySelectDb() {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);

  return {
    db: { select: jest.fn().mockReturnValue(chain) },
    chain,
  };
}

describe("HrTimelineService employee scope", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns not found without creating records when employment is absent", async () => {
    const { db } = emptySelectDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrTimelineService(db as never);

    await expect(
      service.getEmploymentByUserId(ScopedRead.of("org-1", "actor-1", "team"), "target-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("stops before loading timeline data when the employment is outside scope", async () => {
    const { db } = emptySelectDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrTimelineService(db as never);

    await expect(
      service.getTimeline(ScopedRead.of("org-1", "actor-1", "own"), 42, { limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("merges bounded source windows into a stable opaque cursor", async () => {
    const chainFor = (rows: unknown[]) => {
      const chain = {
        from: jest.fn(),
        innerJoin: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn().mockResolvedValue(rows),
      };
      chain.from.mockReturnValue(chain);
      chain.innerJoin.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      return chain;
    };
    const at = new Date("2026-08-14T08:00:00.000Z");
    const visibility = chainFor([{ id: 42 }]);
    const history = chainFor([
      {
        id: 3,
        fromStatus: "ACTIVE",
        toStatus: "NOTICE",
        reason: null,
        notes: null,
        effectiveDate: "2026-08-14",
        createdBy: "actor-1",
        createdAt: at,
      },
      {
        id: 2,
        fromStatus: "PROBATION",
        toStatus: "ACTIVE",
        reason: null,
        notes: null,
        effectiveDate: "2026-08-13",
        createdBy: "actor-1",
        createdAt: new Date("2026-08-13T08:00:00.000Z"),
      },
    ]);
    const changes = chainFor([
      {
        id: 7,
        changeType: "compensation",
        status: "applied",
        effectiveFrom: "2026-08-14",
        effectiveTo: "infinity",
        appliedAt: at,
        createdAt: at,
      },
    ]);
    const audit = chainFor([
      {
        id: 9,
        action: "updated",
        entityType: "hr_employments",
        actorId: "actor-1",
        createdAt: at,
      },
    ]);
    const chains = [visibility, history, changes, audit];
    const db = { select: jest.fn(() => chains.shift()) };
    const service = new HrTimelineService(db as never);

    const result = await service.getTimeline(
      ScopedRead.of("org-1", "actor-1", "all"),
      42,
      { limit: 2 },
    );

    expect(result.data.map((entry) => entry.id)).toEqual([
      "history-3",
      "change-7",
    ]);
    expect(result.data[1]?.data).not.toHaveProperty("oldValue");
    expect(result.data[1]?.data).not.toHaveProperty("newValue");
    expect(result.pageInfo).toMatchObject({ limit: 2, hasMore: true });
    expect(result.pageInfo.nextCursor).toEqual(expect.any(String));
    expect(history.limit).toHaveBeenCalledWith(3);
    expect(changes.limit).toHaveBeenCalledWith(3);
    expect(audit.limit).toHaveBeenCalledWith(3);
  });

  it("rejects a timeline cursor reused for another employment before querying", async () => {
    const chainFor = (rows: unknown[]) => {
      const chain = {
        from: jest.fn(),
        innerJoin: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn().mockResolvedValue(rows),
      };
      chain.from.mockReturnValue(chain);
      chain.innerJoin.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      return chain;
    };
    const visibility = chainFor([{ id: 42 }]);
    const history = chainFor([
      {
        id: 3,
        fromStatus: "ACTIVE",
        toStatus: "NOTICE",
        reason: null,
        notes: null,
        effectiveDate: "2026-08-14",
        createdByMembershipId: 7,
        createdAt: new Date("2026-08-14T08:00:00.000Z"),
      },
      {
        id: 2,
        fromStatus: "PROBATION",
        toStatus: "ACTIVE",
        reason: null,
        notes: null,
        effectiveDate: "2026-08-13",
        createdByMembershipId: 7,
        createdAt: new Date("2026-08-13T08:00:00.000Z"),
      },
    ]);
    const changes = chainFor([]);
    const audit = chainFor([]);
    const chains = [visibility, history, changes, audit];
    const db = { select: jest.fn(() => chains.shift()) };
    const service = new HrTimelineService(db as never);

    const firstPage = await service.getTimeline(
      ScopedRead.of("org-1", "actor-1", "all"),
      42,
      { limit: 1 },
    );

    await expect(
      service.getTimeline(ScopedRead.of("org-1", "actor-1", "all"), 99, {
        limit: 1,
        cursor: firstPage.pageInfo.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it("cursor-pages employment history with a stable tie-breaker and filter binding", async () => {
    const chainFor = (rows: unknown[]) => {
      const chain = {
        from: jest.fn(),
        innerJoin: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn().mockResolvedValue(rows),
      };
      chain.from.mockReturnValue(chain);
      chain.innerJoin.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      return chain;
    };
    const visibility = chainFor([{ id: 42 }]);
    const history = chainFor([
      { id: 3, effectiveFrom: "2026-08-14", changeType: "manager" },
      { id: 2, effectiveFrom: "2026-08-14", changeType: "manager" },
    ]);
    const chains = [visibility, history];
    const db = { select: jest.fn(() => chains.shift()) };
    const service = new HrTimelineService(db as never);

    const firstPage = await service.getHistory(
      ScopedRead.of("org-1", "actor-1", "all"),
      42,
      "manager",
      { limit: 1 },
    );

    expect(history.orderBy.mock.calls[0]).toHaveLength(2);
    expect(history.limit).toHaveBeenCalledWith(2);
    expect(firstPage.data.map((row) => row.id)).toEqual([3]);
    expect(firstPage.pagination).toMatchObject({ limit: 1, hasMore: true });
    await expect(
      service.getHistory(
        ScopedRead.of("org-1", "actor-1", "all"),
        42,
        "department",
        { limit: 1, cursor: firstPage.pagination.nextCursor ?? undefined },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("rejects impossible history cursor dates before querying", async () => {
    const select = jest.fn();
    const service = new HrTimelineService({ select } as never);
    const cursor = encodeCursor({
      sortValue: "2026-02-31",
      id: JSON.stringify([1, "org-1", "actor-1", 42, "all", "manager"]),
    });

    await expect(
      service.getHistory(ScopedRead.of("org-1", "actor-1", "all"), 42, "manager", {
        limit: 20,
        cursor,
      }),
    ).rejects.toMatchObject({
      response: { code: "INVALID_EMPLOYMENT_HISTORY_CURSOR" },
    });
    expect(select).not.toHaveBeenCalled();
  });
});
