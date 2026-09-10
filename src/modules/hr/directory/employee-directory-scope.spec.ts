process.env.APP_URL ??= "http://localhost:1000";

import { NotFoundException } from "@nestjs/common";
import type { Redis } from "@upstash/redis";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import * as applyScopeModule from "../../access/apply-scope";
import { CelebrationsService } from "./celebrations.service";
import { EmployeeSkillsService } from "./employee-skills.service";
import { EmployeesService } from "./employees.service";
import { OrgStructureService } from "./org-structure.service";
import { ScopedRead } from "../../access/scoped-read";

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
    cachedVersionedForOrg: jest.fn(
      async (
        _orgId: string,
        _namespace: string,
        _subKey: string,
        loader: () => Promise<unknown>,
      ) => loader(),
    ),
  };
}

describe("employee directory scope", () => {
  afterEach(() => jest.restoreAllMocks());

  it("hides an out-of-scope target before loading employee subresources", async () => {
    const chain = limitedSelect([]);
    const db = { select: jest.fn().mockReturnValue(chain) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = new EmployeesService(db as never, undefined as never, undefined as never);

    await expect(
      service.assertEmployeeVisible(ScopedRead.of("org-1", "actor-1", "team"), "target-1"),
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

    await service.getAnniversaryFeed(ScopedRead.of("org-1", "actor-1", "own"));

    // The feed lives in the `hr:celebrations` namespace so the onboarding and
    // termination bumps can reach it; the sub-key still carries the scope
    // discriminator (actor-qualified for own/team), which is what keeps one
    // caller's scoped feed out of another's.
    expect(cache.cached).not.toHaveBeenCalled();
    expect(cache.cachedVersionedForOrg).toHaveBeenCalledWith(
      "org-1",
      "hr:celebrations",
      expect.stringContaining("own:actor-1"),
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
        ScopedRead.of("org-1", "actor-1", "own"),
        "foreign-1,foreign-2",
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
        ScopedRead.of("org-1", "actor-1", "team"),
        { skill: "TypeScript", limit: 20 },
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
      service.getSkillsMatrix(ScopedRead.of("org-1", "actor-1", "team"), { limit: 20 }),
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

  it("denies before touching the database when scope is none, and threads orgId/actorUserId into the scope predicate otherwise", async () => {
    const visible: Array<Record<string, unknown>> = [
      { id: "actor-1", name: "Actor One", email: "one@example.com", role: "MEMBER" },
    ];
    const members = limitedSelect([]);
    members.limit.mockImplementation(() => Promise.resolve(visible));
    const cache = new CacheService(new InMemoryRedis() as unknown as Redis);
    const db = {
      select: jest.fn().mockReturnValue(members),
      query: { orgUnits: { findMany: jest.fn().mockResolvedValue([]) } },
    };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const employment = { getFactsBatch: jest.fn().mockResolvedValue(new Map()) };
    const service = new OrgStructureService(db as never, cache, employment as never, undefined as never);

    // scope="none" denies unconditionally — it never reaches the database, so a
    // mocked db that would happily return rows regardless of the predicate is
    // never even consulted. This is the stronger property: no viewer without
    // standing gets anyone's directory, not even by accident of a mock.
    await expect(service.getDirectory(ScopedRead.of("org-1", "actor-1", "none"))).resolves.toEqual([]);
    await expect(service.getDirectory(ScopedRead.of("org-1", "actor-2", "none"))).resolves.toEqual([]);
    await expect(service.getDirectory(ScopedRead.of("org-2", "actor-1", "none"))).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(scopeSpy).not.toHaveBeenCalled();

    // A scope that isn't "none" does reach the predicate, carrying the caller's
    // own orgId/actorUserId, not anyone else's.
    const result = await service.getDirectory(ScopedRead.of("org-1", "actor-1", "team"));
    expect(result).toHaveLength(1);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
  });
});
