import type { Db } from "../../../db/drizzle.module";
import { BadRequestException, ConflictException, GoneException, NotFoundException } from "@nestjs/common";
import { ModulesService } from "./modules.service";
import { SprintsService } from "./sprints.service";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function owner(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

describe("ModulesService — cross-tenant isolation", () => {
  it("listModules refuses a project the requesting org does not own (cross-tenant isolation — 404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ModulesService(db, stubService<AccessService>({}));

    await expect(svc.listModules(owner(ATTACKER_ORG), 1)).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listModules returns modules for the owning org (control — same-tenant access works)", async () => {
    const fakeModule = { id: 1, orgId: OWNER_ORG, name: "Alpha", status: "IN_PROGRESS" };
    let call = 0;
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeModule]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new ModulesService(db, stubService<AccessService>({}));

    const result = await svc.listModules(owner(OWNER_ORG), 1);
    expect(result.data).toHaveLength(1);
    expect(result.pagination).toEqual({ limit: 100, hasMore: false, nextCursor: null });
  });

  it("rejects a malformed cursor instead of silently changing the result window", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn(),
    } as unknown as Db;
    const svc = new ModulesService(db, stubService<AccessService>({}));

    await expect(svc.listModules(owner(OWNER_ORG), 1, { cursor: "not-a-cursor" })).rejects.toThrow(BadRequestException);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("ModulesService — createModule", () => {
  it("a DB 23505 on INSERT becomes ConflictException so a race-condition duplicate never surfaces as a 500", async () => {
    const uniqueViolation = new Error("duplicate key value violates unique constraint");
    Object.assign(uniqueViolation, { code: "23505" });

    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(uniqueViolation),
        }),
      }),
    } as unknown as Db;

    const svc = new ModulesService(db, stubService<AccessService>({}));

    await expect(
      svc.createModule(owner(OWNER_ORG), 1, { name: "Sprint Alpha", status: "in-progress" }),
    ).rejects.toThrow(ConflictException);
  });

  it("propagates non-23505 DB errors unchanged so they reach AllExceptionsFilter as 500 (control)", async () => {
    const otherError = new Error("connection refused");

    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(otherError),
        }),
      }),
    } as unknown as Db;

    const svc = new ModulesService(db, stubService<AccessService>({}));

    await expect(
      svc.createModule(owner(OWNER_ORG), 1, { name: "Sprint Alpha", status: "in-progress" }),
    ).rejects.toThrow(otherError);
    await expect(
      svc.createModule(owner(OWNER_ORG), 1, { name: "Sprint Alpha", status: "in-progress" }),
    ).rejects.not.toThrow(ConflictException);
  });
});

describe("SprintsService — the freeze is the isolation, for every tenant", () => {
  it.each([ATTACKER_ORG, OWNER_ORG])(
    "listSprints refuses %s with GoneException and issues no project lookup, so a projectId cannot be probed through this route",
    async (org) => {
      const where = jest.fn();
      const projectFindFirst = jest.fn();
      const db = {
        query: { projects: { findFirst: projectFindFirst } },
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      } as unknown as Db;

      await expect(new SprintsService(db, null).listSprints(org, 1)).rejects.toThrow(GoneException);

      expect(where).not.toHaveBeenCalled();
      expect(projectFindFirst).not.toHaveBeenCalled();
    },
  );

  it.each([ATTACKER_ORG, OWNER_ORG])(
    "getSprint refuses %s with GoneException without reading build.sprints, so a sprint id is no existence oracle for either tenant",
    async (org) => {
      const sprintsFindFirst = jest.fn();
      const db = { query: { sprints: { findFirst: sprintsFindFirst } } } as unknown as Db;

      await expect(new SprintsService(db, null).getSprint(org, 1, 9999)).rejects.toThrow(GoneException);

      expect(sprintsFindFirst).not.toHaveBeenCalled();
    },
  );
});
