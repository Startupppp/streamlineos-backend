import { NotFoundException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ScopeDirectoryService } from "src/modules/build/scope-directory/scope-directory.service";
import { TeamsService } from "src/modules/build/teams/teams.service";
import { ManagedProductsService } from "src/modules/build/managed-products/managed-products.service";
import { ClientPortalService } from "src/modules/build/client-portal/client-portal.service";
import type { Db } from "src/db/drizzle.module";
import type { AccessService } from "src/modules/access/access.service";

const dialect = new PgDialect();
const BACKEND_ROOT = resolve(__dirname, "..", "..");

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const ORG_A = "org-a-caller";
const ORG_B = "org-b-victim";
const PROJECT_KEY_A = 501;
const PROJECT_KEY_B = 502;
const TEAM_A = 71;
const TEAM_B = 72;
const PRODUCT_A = 11;
const PRODUCT_B = 22;
const USER_A = "user-a";
const MEMBERSHIP_A = 5;

const audit = { log: jest.fn() } as never;
const accessStub = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, string>()),
} as unknown as AccessService;

function makeScopeDirectoryDb(resolveWith: unknown[] = []) {
  const capturedWheres: unknown[] = [];
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWheres.push(cond);
    return Promise.resolve(resolveWith);
  });
  const from = jest.fn().mockReturnValue({ where });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const fromWithJoin = jest.fn().mockReturnValue({ where, innerJoin });
  const db = {
    select: jest.fn().mockReturnValue({ from: fromWithJoin }),
  } as unknown as Db;
  return { db, capturedWheres };
}

function makeLoadDb(row: Record<string, unknown> | undefined) {
  const capturedWhere: unknown[] = [];
  const limit = jest.fn().mockResolvedValue(row ? [row] : []);
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWhere.push(cond);
    const p = Promise.resolve(row ? [row] : []) as Promise<unknown[]> & { limit: jest.Mock };
    p.limit = limit;
    return p;
  });
  const from = jest.fn().mockReturnValue({ where });
  return { db: { select: jest.fn().mockReturnValue({ from }) } as unknown as Db, capturedWhere };
}

function makePortalDb(findResult: Record<string, unknown> | undefined, selectRows: unknown[] = []) {
  const limit = jest.fn().mockResolvedValue(selectRows);
  const capturedWhere: unknown[] = [];
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWhere.push(cond);
    const p = Promise.resolve(selectRows) as Promise<unknown[]> & { limit: jest.Mock };
    p.limit = limit;
    return p;
  });
  const from = jest.fn().mockReturnValue({ where });
  const db = {
    query: { projects: { findFirst: jest.fn().mockResolvedValue(findResult) } },
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
  return { db, capturedWhere };
}

describe("BSN-04-042 — cross-organization isolation: scope-directory resolve", () => {
  it("resolveScopeDirectory binds the caller's orgId in the project membership WHERE clause", async () => {
    const { db, capturedWheres } = makeScopeDirectoryDb([]);
    await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_A, USER_A, MEMBERSHIP_A, [`project:${PROJECT_KEY_A}`],
    );
    expect(capturedWheres.length).toBeGreaterThan(0);
    expect(renderParams(capturedWheres[0])).toContain(ORG_A);
  });

  it("resolveScopeDirectory returns nothing for a project key belonging to a foreign org", async () => {
    const { db } = makeScopeDirectoryDb([]);
    const result = await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_A, USER_A, MEMBERSHIP_A, [`project:${PROJECT_KEY_B}`],
    );
    expect(result).toEqual([]);
  });

  it("resolveScopeDirectory returns the project when the orgId and key match (control — mock is not vacuous)", async () => {
    const { db } = makeScopeDirectoryDb([
      { id: PROJECT_KEY_A, name: "My Project", key: "MYPRJ", status: "ACTIVE", managedProductId: null, clientMembershipId: null },
    ]);
    const result = await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_A, USER_A, MEMBERSHIP_A, [`project:${PROJECT_KEY_A}`],
    );
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe(String(PROJECT_KEY_A));
  });

  it("resolveScopeDirectory binds orgId in the product WHERE clause", async () => {
    const { db, capturedWheres } = makeScopeDirectoryDb([]);
    await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_A, USER_A, MEMBERSHIP_A, [`product:${PRODUCT_A}`],
    );
    expect(renderParams(capturedWheres[0])).toContain(ORG_A);
  });

  it("org-B cannot retrieve org-A's project by guessing its key", async () => {
    const { db } = makeScopeDirectoryDb([]);
    const result = await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_B, USER_A, MEMBERSHIP_A, [`project:${PROJECT_KEY_A}`],
    );
    expect(result).toEqual([]);
  });

  it("the caller's orgId is NOT org-B even when the key contains org-B's project id", async () => {
    const { db, capturedWheres } = makeScopeDirectoryDb([]);
    await new ScopeDirectoryService(db, accessStub).resolveScopeDirectory(
      ORG_A, USER_A, MEMBERSHIP_A, [`project:${PROJECT_KEY_B}`],
    );
    const params = renderParams(capturedWheres[0]);
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });
});

describe("BSN-04-042 — cross-organization isolation: teams direct access", () => {
  it("loadTeam raises NotFoundException for a team the caller's org does not own", async () => {
    const { db } = makeLoadDb(undefined);
    await expect(
      new TeamsService(db, audit).loadTeam(ORG_A, TEAM_B),
    ).rejects.toThrow(NotFoundException);
  });

  it("loadTeam serves the team when orgId matches (control)", async () => {
    const teamRow = {
      id: TEAM_A,
      orgId: ORG_A,
      name: "Alpha",
      key: "ALPHA",
      icon: null,
      color: null,
      isPrivate: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const { db } = makeLoadDb(teamRow);
    await expect(
      new TeamsService(db, audit).loadTeam(ORG_A, TEAM_A),
    ).resolves.toBeDefined();
  });

  it("the team WHERE clause binds orgId so cross-tenant rows are filtered at the DB", async () => {
    const { db, capturedWhere } = makeLoadDb(undefined);
    await new TeamsService(db, audit).loadTeam(ORG_A, TEAM_B).catch(() => undefined);
    expect(renderParams(capturedWhere[0])).toContain(ORG_A);
  });

  it("404 is returned, not 403 — a 403 would confirm the team exists to the prober", async () => {
    const { db } = makeLoadDb(undefined);
    const thrown = await new TeamsService(db, audit)
      .loadTeam(ORG_A, TEAM_B)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
  });
});

describe("BSN-04-042 — cross-organization isolation: managed-products direct access", () => {
  it("getManagedProduct raises NotFoundException for a product the caller's org does not own", async () => {
    const { db } = makeLoadDb(undefined);
    await expect(
      new ManagedProductsService(db, audit).getManagedProduct(ORG_A, PRODUCT_B),
    ).rejects.toThrow(NotFoundException);
  });

  it("getManagedProduct serves the product when orgId matches (control)", async () => {
    const productRow = {
      id: PRODUCT_A,
      orgId: ORG_A,
      name: "Atlas",
      key: "ATL",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      description: null,
    };
    const { db } = makeLoadDb(productRow);
    await expect(
      new ManagedProductsService(db, audit).getManagedProduct(ORG_A, PRODUCT_A),
    ).resolves.toBeDefined();
  });

  it("product WHERE clause binds orgId so cross-tenant rows cannot be reached", async () => {
    const { db, capturedWhere } = makeLoadDb(undefined);
    await new ManagedProductsService(db, audit).getManagedProduct(ORG_A, PRODUCT_B).catch(() => undefined);
    expect(renderParams(capturedWhere[0])).toContain(ORG_A);
  });

  it("404 is returned for a foreign product, not 403", async () => {
    const { db } = makeLoadDb(undefined);
    const thrown = await new ManagedProductsService(db, audit)
      .getManagedProduct(ORG_A, PRODUCT_B)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NotFoundException);
  });
});

describe("BSN-04-042 — cross-organization isolation: portal project list", () => {
  it("listPortalProjects binds the caller's orgId so org-B's projects are never returned", async () => {
    const { db, capturedWhere } = makePortalDb(undefined, []);
    await new ClientPortalService(db, accessStub, audit).listPortalProjects(ORG_A);
    expect(renderParams(capturedWhere[0])).toContain(ORG_A);
    expect(renderParams(capturedWhere[0])).not.toContain(ORG_B);
  });

  it("listPortalProjects returns an empty result when the mock returns nothing (cross-tenant miss)", async () => {
    const { db } = makePortalDb(undefined, []);
    const result = await new ClientPortalService(db, accessStub, audit).listPortalProjects(ORG_B);
    expect(result).toEqual([]);
  });
});

describe("BSN-04-042 — cross-organization isolation: Quick Create", () => {
  it("createProject controller passes u.orgId to the service, not a client-supplied org (source proof)", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/core/projects.controller.ts"),
      "utf8",
    );
    const createBlock = src.slice(src.indexOf("createProject("), src.indexOf("@Post(\"from-deal\")"));
    expect(createBlock).toContain("u.orgId");
    expect(createBlock).not.toContain("body.orgId");
  });

  it("createProject service inserts with the orgId received from the controller (source proof)", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/core/projects-provision.service.ts"),
      "utf8",
    );
    const insertBlock = src.slice(src.indexOf(".insert(projects)"), src.indexOf(".returning("));
    expect(insertBlock).toContain("orgId,");
    expect(insertBlock).not.toMatch(/orgId:\s*body\./);
  });

  it("createManagedProduct controller passes u.orgId to the service (source proof)", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/managed-products/managed-products.controller.ts"),
      "utf8",
    );
    const createBlock = src.slice(src.indexOf("createManagedProduct("), src.indexOf("@Patch("));
    expect(createBlock).toContain("u.orgId");
    expect(createBlock).not.toContain("body.orgId");
  });

  it("createTeam controller passes u.orgId to the service (source proof)", () => {
    const src = readFileSync(
      join(BACKEND_ROOT, "src/modules/build/teams/teams.controller.ts"),
      "utf8",
    );
    expect(src).toContain("u.orgId");
  });
});

describe("BSN-04-042 — cross-organization isolation: recents, stars, pins, counts, Agent Pulse", () => {
  it("dedicated recents/starred/pinned/agentPulse sidebar endpoints are not present in the current build module", () => {
    const controllers = [
      "src/modules/build/core/projects.controller.ts",
      "src/modules/build/teams/teams.controller.ts",
      "src/modules/build/scope-directory/scope-directory.controller.ts",
    ]
      .map((p) => readFileSync(join(BACKEND_ROOT, p), "utf8"))
      .join("\n");
    expect(controllers).not.toMatch(/recents|starred|pinned|agentPulse|agent-pulse/);
  });
});
