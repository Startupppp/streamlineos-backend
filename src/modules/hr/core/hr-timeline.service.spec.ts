import { NotFoundException } from "@nestjs/common";
import * as applyScopeModule from "../../access/apply-scope";
import { HrTimelineService } from "./hr-timeline.service";

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
      service.getEmploymentByUserId("org-1", "actor-1", "target-1", "team"),
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
      service.getTimeline("org-1", "actor-1", 42, "own", { limit: 20 }),
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
      "org-1",
      "actor-1",
      42,
      "all",
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
});
