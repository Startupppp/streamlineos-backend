process.env.APP_URL ??= "http://localhost:1000";

import { NotFoundException } from "@nestjs/common";
import * as applyScopeModule from "../../access/apply-scope";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { EmployeesService } from "./employees.service";
import { OrgStructureService } from "./org-structure.service";

function limitedSelect(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

function executingCache() {
  return {
    cached: jest.fn(
      async (_key: string, loader: () => Promise<unknown>) => loader(),
    ),
  };
}

describe("employee directory scope", () => {
  afterEach(() => jest.restoreAllMocks());

  it("hides an out-of-scope target before loading employee subresources", async () => {
    const chain = limitedSelect([]);
    const db = { select: jest.fn().mockReturnValue(chain) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new EmployeesService(db as never, undefined as never);

    await expect(
      service.assertEmployeeVisible("org-1", "actor-1", "target-1", "team"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("scopes anniversary data and isolates its cache by actor and scope", async () => {
    const chain = limitedSelect([]);
    const cache = executingCache();
    const db = { select: jest.fn().mockReturnValue(chain) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new CelebrationsService(db as never, cache as never);

    await service.getAnniversaryFeed("org-1", "actor-1", "own");

    expect(cache.cached).toHaveBeenCalledWith(
      expect.stringContaining("org-1:actor-1:own"),
      expect.any(Function),
      expect.any(Number),
    );
    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });

  it("intersects requested availability users with the caller's scope", async () => {
    const chain = limitedSelect([]);
    const db = { select: jest.fn().mockReturnValue(chain) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new CelebrationsService(db as never, undefined as never);

    await expect(
      service.getAvailability(
        "org-1",
        "actor-1",
        "foreign-1,foreign-2",
        "own",
      ),
    ).resolves.toEqual([]);
    expect(scopeSpy).toHaveBeenCalledWith(
      "own",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("limits expert discovery to active members inside the caller's scope", async () => {
    const scopedExpertQuery = limitedSelect([]);
    const db = { select: jest.fn().mockReturnValue(scopedExpertQuery) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new EmployeeSkillsService(db as never);

    await expect(
      service.findExpert(
        "org-1",
        "actor-1",
        { skill: "TypeScript", limit: 20 },
        "team",
      ),
    ).resolves.toEqual([]);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("bounds the skills matrix before loading skills for a page", async () => {
    const memberPageQuery = limitedSelect([]);
    const db = { select: jest.fn().mockReturnValue(memberPageQuery) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new EmployeeSkillsService(db as never);

    await expect(
      service.getSkillsMatrix("org-1", "actor-1", "team", { limit: 20 }),
    ).resolves.toEqual({
      employees: [],
      skills: [],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    });

    expect(memberPageQuery.limit).toHaveBeenCalledWith(21);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("scopes directory rows and isolates their cache by actor and scope", async () => {
    const members = limitedSelect([]);
    const cache = executingCache();
    const db = {
      select: jest.fn().mockReturnValue(members),
      query: { orgUnits: { findMany: jest.fn().mockResolvedValue([]) } },
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new OrgStructureService(db as never, cache as never);

    await service.getDirectory("org-1", "actor-1", "none");

    expect(cache.cached).toHaveBeenCalledWith(
      "hr:directory:org-1:actor-1:none",
      expect.any(Function),
      expect.any(Number),
    );
    expect(scopeSpy).toHaveBeenCalledWith(
      "none",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });
});
