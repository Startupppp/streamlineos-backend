process.env.APP_URL ??= "http://localhost:1000";

import { NotFoundException } from "@nestjs/common";
import * as applyScopeModule from "../../access/apply-scope";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { HrEmploymentsService } from "./hr-employments.service";
import { HrPeopleService } from "./hr-people.service";
import { ScopedRead } from "../../access/scoped-read";

function detailDb() {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { db: { select: jest.fn().mockReturnValue(chain) }, chain };
}

function listDb() {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return { db: { select: jest.fn().mockReturnValue(chain) }, chain };
}

describe("legacy HR employee read scope", () => {
  afterEach(() => jest.restoreAllMocks());

  it("applies own scope before loading one HR person", async () => {
    const { db } = detailDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrPeopleService(db as never, undefined as never);

    await expect(
      service.getOne(ScopedRead.of("org-1", "actor-1", "own"), 17),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("applies team scope before loading one HR employment", async () => {
    const { db } = detailDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrEmploymentsService(db as never, undefined as never);

    await expect(
      service.getOne(ScopedRead.of("org-1", "actor-1", "team"), 29),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("scopes the people list and excludes private person fields", async () => {
    const { db } = listDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrEmployeeRecordListsService(db as never);

    await service.listPeopleCursor(
      ScopedRead.of("org-1", "actor-1", "own"),
      { limit: 20 },
    );

    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    const selected = db.select.mock.calls[0]?.[0];
    expect(selected).not.toHaveProperty("personalEmail");
    expect(selected).not.toHaveProperty("dateOfBirth");
    expect(selected).not.toHaveProperty("address");
    expect(selected).not.toHaveProperty("emergencyContact");
  });

  it("denies the people list before touching the database when scope=none", async () => {
    const { db } = listDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listPeopleCursor(
      ScopedRead.of("org-1", "actor-1", "none"),
      { limit: 20 },
    );

    expect(scopeSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });
  });

  it("scopes the employment cursor path without an exact-count query", async () => {
    const { db } = listDb();
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new HrEmployeeRecordListsService(db as never);

    const result = await service.listEmploymentsCursor(
      ScopedRead.of("org-1", "actor-1", "own"),
      { limit: 20 },
    );

    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(result.pageInfo).toEqual({
      limit: 20,
      hasMore: false,
      nextCursor: null,
    });
  });
});
