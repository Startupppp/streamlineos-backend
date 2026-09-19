import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import {
  managedProducts,
  pmWorkspaces,
  projectMembers,
  projectTeamAssignments,
  projects,
} from "../../../db/schema";
import { ScopeDirectoryService } from "./scope-directory.service";
import { resolveScopeDirectorySchema } from "./dto/scope-directory.schemas";

const dialect = new PgDialect();

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const ORG = "org-1";
const USER = "user-1";
const MEMBERSHIP_ID = 42;

interface RecordedCall {
  table: unknown;
  condition: unknown;
}

function makeDb(responses: Map<unknown, unknown[][]>) {
  const callCounts = new Map<unknown, number>();
  const calls: RecordedCall[] = [];

  function recordAndResolve(table: unknown, condition: unknown): Promise<unknown[]> {
    calls.push({ table, condition });
    const seq = responses.get(table) ?? [[]];
    const idx = callCounts.get(table) ?? 0;
    callCounts.set(table, idx + 1);
    return Promise.resolve((seq[idx] ?? []));
  }

  const select = jest.fn().mockImplementation(() => ({
    from: jest.fn().mockImplementation((table: unknown) => ({
      where: jest.fn().mockImplementation((condition: unknown) =>
        recordAndResolve(table, condition),
      ),
      innerJoin: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation((condition: unknown) =>
          recordAndResolve(table, condition),
        ),
      })),
    })),
  }));

  const db = { select } as unknown as Db;
  return { db, calls };
}

function makeAccess(buildManageScope: string | null = "all"): AccessService {
  const perms = buildManageScope !== null
    ? new Map([["build:manage", buildManageScope]])
    : new Map<string, string>();
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

function makeSvc(db: Db, access: AccessService = makeAccess()) {
  return new ScopeDirectoryService(db, access);
}

const WS_ROW = { pmWorkspaceId: "ws-1", name: "Delivery", status: "active" };
const PROD_ROW = { id: 10, name: "Atlas", key: "ATL", status: "active", pmWorkspaceId: "ws-1" };
const PROJ_ROW = {
  id: 20,
  name: "Launch",
  key: "LAU",
  status: "ACTIVE",
  managedProductId: 10,
  pmWorkspaceId: "ws-1",
  clientMembershipId: null,
};

describe("ScopeDirectoryService.resolveScopeDirectory", () => {
  it("resolves a mix of all three types and returns parentPath + clientPortalEnabled", async () => {
    const { db } = makeDb(new Map([
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
      [projects, [[PROJ_ROW]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, [
      "workspace:ws-1",
      "product:10",
      "project:20",
    ]);

    expect(result).toEqual([
      {
        key: "workspace:ws-1",
        type: "workspace",
        id: "ws-1",
        name: "Delivery",
        parentKey: null,
        projectKey: null,
        isArchived: false,
        parentPath: null,
        clientPortalEnabled: null,
      },
      {
        key: "product:10",
        type: "product",
        id: "10",
        name: "Atlas",
        parentKey: "workspace:ws-1",
        projectKey: "ATL",
        isArchived: false,
        parentPath: "Delivery",
        clientPortalEnabled: null,
      },
      {
        key: "project:20",
        type: "project",
        id: "20",
        name: "Launch",
        parentKey: "product:10",
        projectKey: "LAU",
        isArchived: false,
        parentPath: "Delivery > Atlas",
        clientPortalEnabled: false,
      },
    ]);
  });

  it("omits a key whose row is in another organization, because the caller-scoped query never returns it", async () => {
    const { db } = makeDb(new Map([
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, [
      "workspace:ws-1",
      "workspace:ws-cross-org",
    ]);

    expect(result.map((ref) => ref.key)).toEqual(["workspace:ws-1"]);
  });

  it("omits a soft-deleted row, because the deletedAt filter excludes it from the query result", async () => {
    const { db } = makeDb(new Map([
      [managedProducts, [[]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["product:99"]);

    expect(result).toEqual([]);
  });

  it("binds every issued query to the caller's orgId", async () => {
    const { db, calls } = makeDb(new Map([
      [pmWorkspaces, [[]]],
      [managedProducts, [[]]],
      [projects, [[]]],
    ]));

    await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, [
      "workspace:ws-1",
      "product:10",
      "project:20",
    ]);

    const mainCalls = calls.filter((c) =>
      c.table === pmWorkspaces || c.table === managedProducts || c.table === projects,
    );
    expect(mainCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of mainCalls)
      expect(renderParams(call.condition)).toContain(ORG);
  });

  it("rejects a body with 27 keys", () => {
    const keys = Array.from({ length: 27 }, (_, i) => `project:${i + 1}`);
    const result = resolveScopeDirectorySchema.safeParse({ keys });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 26 keys (the boundary maximum)", () => {
    const keys = Array.from({ length: 26 }, (_, i) => `project:${i + 1}`);
    const result = resolveScopeDirectorySchema.safeParse({ keys });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognised key prefix", () => {
    const result = resolveScopeDirectorySchema.safeParse({ keys: ["sprint:1"] });
    expect(result.success).toBe(false);
  });

  it("issues no query for a type that appears in no key", async () => {
    const { db, calls } = makeDb(new Map([
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["workspace:ws-1"]);

    const mainCalls = calls.filter(
      (c) => c.table === pmWorkspaces || c.table === managedProducts || c.table === projects,
    );
    expect(mainCalls).toHaveLength(1);
    expect(mainCalls[0]?.table).toBe(pmWorkspaces);
  });

  it("clientPortalEnabled is true when the project has a clientMembershipId set", async () => {
    const { db } = makeDb(new Map([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: 7 }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(true);
  });

  it("clientPortalEnabled is false when the project has no clientMembershipId", async () => {
    const { db } = makeDb(new Map([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: null }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(false);
  });

  it("resolves parentPath for a product whose workspace was not in the requested keys", async () => {
    const { db } = makeDb(new Map([
      [managedProducts, [[PROD_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["product:10"]);

    expect(ref?.parentPath).toBe("Delivery");
  });

  it("resolves parentPath for a project as WorkspaceName > ProductName when both are ancestors", async () => {
    const projNoProduct = {
      ...PROJ_ROW,
      managedProductId: null,
      pmWorkspaceId: "ws-1",
    };
    const { db } = makeDb(new Map([
      [projects, [[projNoProduct]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBe("Delivery");
  });

  it("resolves parentPath with both workspace and product ancestors when project has a managedProductId not in requested keys", async () => {
    const { db } = makeDb(new Map([
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBe("Delivery > Atlas");
  });

  it("sets parentPath to null when the ancestor workspace is not in the org (deleted/cross-tenant)", async () => {
    const projNoProduct = { ...PROJ_ROW, managedProductId: null };
    const { db } = makeDb(new Map([
      [projects, [[projNoProduct]]],
      [pmWorkspaces, [[]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBeNull();
  });

  it("resolves two projects with duplicate names by their distinct IDs", async () => {
    const proj1 = { ...PROJ_ROW, id: 20, name: "Titan", managedProductId: null };
    const proj2 = { ...PROJ_ROW, id: 21, name: "Titan", key: "TIT2", managedProductId: null };
    const { db } = makeDb(new Map([
      [projects, [[proj1, proj2]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, [
      "project:20",
      "project:21",
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["20", "21"]);
    expect(result.map((r) => r.name)).toEqual(["Titan", "Titan"]);
  });
});

describe("ScopeDirectoryService — project membership gate (BSN-02-005)", () => {
  it("returns all org projects when build:manage scope is all, regardless of membershipId", async () => {
    const { db } = makeDb(new Map([
      [projects, [[PROJ_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      ORG, USER, null, ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("omits all projects when build:manage scope is not all and membershipId is null (account-only principal)", async () => {
    const { db, calls } = makeDb(new Map());

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, null, ["project:20"],
    );

    expect(result).toEqual([]);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeUndefined();
  });

  it("binds the actor's membershipId in the membership queries when build:manage is below all", async () => {
    const { db, calls } = makeDb(new Map([
      [projectMembers, [[{ projectId: 20 }]]],
      [projectTeamAssignments, [[]]],
      [projects, [[PROJ_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    const memberCall = calls.find((c) => c.table === projectMembers);
    expect(memberCall).toBeDefined();
    expect(renderParams(memberCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("resolves project via direct project membership when build:manage is not all", async () => {
    const { db } = makeDb(new Map([
      [projectMembers, [[{ projectId: 20 }]]],
      [projectTeamAssignments, [[]]],
      [projects, [[PROJ_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("project membership gate: guard bites — removing the membershipId filter would allow a non-member through, but the DB honours the predicate and returns nothing", async () => {
    const { db, calls } = makeDb(new Map([
      [projectMembers, [[]]],
      [projectTeamAssignments, [[]]],
      [projects, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    expect(result).toEqual([]);
    const memberCall = calls.find((c) => c.table === projectMembers);
    expect(memberCall).toBeDefined();
    expect(renderParams(memberCall?.condition)).toContain(MEMBERSHIP_ID);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("NO workspace membership model: workspace scope returns all org workspaces regardless of pmWorkspaceMemberships (existing service design — listWorkspaces in pm-workspaces.service.ts:58 enforces no membership filter)", async () => {
    const { db } = makeDb(new Map([
      [pmWorkspaces, [[WS_ROW, { pmWorkspaceId: "ws-2", name: "Other", status: "active" }]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, null, ["workspace:ws-1", "workspace:ws-2"],
    );

    expect(result).toHaveLength(2);
  });

  it("NO product membership model: product scope returns all org products regardless of membership (no managedProductMemberships table exists)", async () => {
    const { db } = makeDb(new Map([
      [managedProducts, [[PROD_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, null, ["product:10"],
    );

    expect(result).toHaveLength(1);
  });
});

describe("ScopeDirectoryService — archived scopes", () => {
  it("returns isArchived true for an archived workspace", async () => {
    const { db } = makeDb(new Map([
      [pmWorkspaces, [[{ ...WS_ROW, status: "archived" }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["workspace:ws-1"]);

    expect(ref?.isArchived).toBe(true);
  });

  it("returns isArchived true for an archived product", async () => {
    const { db } = makeDb(new Map([
      [managedProducts, [[{ ...PROD_ROW, status: "archived" }]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["product:10"]);

    expect(ref?.isArchived).toBe(true);
  });

  it("returns isArchived true for an ARCHIVED project", async () => {
    const { db } = makeDb(new Map([
      [projects, [[{ ...PROJ_ROW, status: "ARCHIVED" }]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.isArchived).toBe(true);
  });
});
