import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveActorRankContext } from "./resolve-actor-rank";
import { ROLE_RANK } from "./grantability";
import {
  organizationMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.types";

type Row = { rank: number; moduleKey: string | null };

function makeDb(rows: Row[]): Db {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return chain as unknown as Db;
}

describe("resolveActorRankContext", () => {
  it("confers no rank when the member is suspended (DB returns no active rows)", async () => {
    const db = makeDb([]);
    const result = await resolveActorRankContext(db, "org-1", "user-suspended");
    expect(result.bestRank).toBe(ROLE_RANK.FUNCTIONAL);
    expect(result.allowedModules).toBeNull();
  });

  it("confers no rank when all assignments are expired (DB returns no unexpired rows)", async () => {
    const db = makeDb([]);
    const result = await resolveActorRankContext(db, "org-1", "user-expired");
    expect(result.bestRank).toBe(ROLE_RANK.FUNCTIONAL);
    expect(result.allowedModules).toBeNull();
  });

  it("picks the numerically lowest rank when multiple assignments exist", async () => {
    const db = makeDb([
      { rank: ROLE_RANK.FUNCTIONAL, moduleKey: null },
      { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "crm" },
    ]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");
    expect(result.bestRank).toBe(ROLE_RANK.MODULE_ADMIN);
  });

  it("sets allowedModules to null when the best-rank role is org-wide", async () => {
    const db = makeDb([{ rank: ROLE_RANK.ORG_ADMIN, moduleKey: null }]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");
    expect(result.bestRank).toBe(ROLE_RANK.ORG_ADMIN);
    expect(result.allowedModules).toBeNull();
  });

  it("collects module keys when best-rank roles are all module-scoped", async () => {
    const db = makeDb([
      { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "crm" },
      { rank: ROLE_RANK.MODULE_ADMIN, moduleKey: "build" },
    ]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");
    expect(result.bestRank).toBe(ROLE_RANK.MODULE_ADMIN);
    expect(result.allowedModules).toEqual(new Set(["crm", "build"]));
  });

  it("ignores lower-ranked module assignments when an org-wide role has a better rank", async () => {
    const db = makeDb([
      { rank: ROLE_RANK.ORG_ADMIN, moduleKey: null },
      { rank: ROLE_RANK.FUNCTIONAL, moduleKey: "crm" },
    ]);
    const result = await resolveActorRankContext(db, "org-1", "user-1");
    expect(result.bestRank).toBe(ROLE_RANK.ORG_ADMIN);
    expect(result.allowedModules).toBeNull();
  });
});

describe("resolveActorRankContext query determinism: drain has ORDER BY and uses shared page size", () => {
  it("the rank resolution drain has orderBy and uses GRANT_PAGE_SIZE in source code", async () => {
    const fs = await import("fs").then((m) => m.promises);
    const path = await import("path");

    const resolveActorRankPath = path.join(__dirname, "resolve-actor-rank.ts");
    const content = await fs.readFile(resolveActorRankPath, "utf-8");

    expect(content).toContain("drainByKeyset");
    expect(content).toContain(".orderBy(asc(roleAssignments.id))");
    expect(content).toContain(".limit(GRANT_PAGE_SIZE)");

    const orderByIndex = content.indexOf(".orderBy(asc(roleAssignments.id))");
    const limitIndex = content.indexOf(".limit(GRANT_PAGE_SIZE)");

    expect(orderByIndex).toBeGreaterThan(0);
    expect(limitIndex).toBeGreaterThan(0);
    expect(orderByIndex).toBeLessThan(limitIndex);
  });
});
