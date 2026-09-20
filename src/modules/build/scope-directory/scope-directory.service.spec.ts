import { managedProducts, pmWorkspaceMemberships, pmWorkspaces, projects } from "../../../db/schema";
import { resolveScopeDirectorySchema } from "./dto/scope-directory.schemas";
import {
  MEMBERSHIP_ID,
  ORG,
  PROD_ROW,
  PROJ_ROW,
  USER,
  WS_ROW,
  makeAccess,
  makeDb,
  makeResponses,
  makeSvc,
  renderParams,
} from "./__tests__/scope-directory-spec-helpers";

describe("ScopeDirectoryService.resolveScopeDirectory", () => {
  it("resolves a mix of all three types and returns parentPath + clientPortalEnabled", async () => {
    const { db } = makeDb(makeResponses([
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
    const { db } = makeDb(makeResponses([
      [pmWorkspaceMemberships, [[{ pmWorkspaceId: "ws-1" }]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, [
      "workspace:ws-1",
      "workspace:ws-cross-org",
    ]);

    expect(result.map((ref) => ref.key)).toEqual(["workspace:ws-1"]);
  });

  it("omits a soft-deleted row, because the deletedAt filter excludes it from the query result", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["product:99"]);

    expect(result).toEqual([]);
  });

  it("binds every issued query to the caller's orgId", async () => {
    const { db, calls } = makeDb(makeResponses([
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
    const { db, calls } = makeDb(makeResponses([
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
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: 7 }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(true);
  });

  it("clientPortalEnabled is false when the project has no clientMembershipId", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: null }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(false);
  });

  it("resolves parentPath for a product whose workspace was not in the requested keys", async () => {
    const { db } = makeDb(makeResponses([
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
    const { db } = makeDb(makeResponses([
      [projects, [[projNoProduct]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBe("Delivery");
  });

  it("resolves parentPath with both workspace and product ancestors when project has a managedProductId not in requested keys", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBe("Delivery > Atlas");
  });

  it("sets parentPath to null when the ancestor workspace is not in the org (deleted/cross-tenant)", async () => {
    const projNoProduct = { ...PROJ_ROW, managedProductId: null };
    const { db } = makeDb(makeResponses([
      [projects, [[projNoProduct]]],
      [pmWorkspaces, [[]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.parentPath).toBeNull();
  });

  it("resolves two projects with duplicate names by their distinct IDs", async () => {
    const proj1 = { ...PROJ_ROW, id: 20, name: "Titan", managedProductId: null };
    const proj2 = { ...PROJ_ROW, id: 21, name: "Titan", key: "TIT2", managedProductId: null };
    const { db } = makeDb(makeResponses([
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


describe("ScopeDirectoryService — archived scopes", () => {
  it("returns isArchived true for an archived workspace", async () => {
    const { db } = makeDb(makeResponses([
      [pmWorkspaces, [[{ ...WS_ROW, status: "archived" }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["workspace:ws-1"]);

    expect(ref?.isArchived).toBe(true);
  });

  it("returns isArchived true for an archived product", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[{ ...PROD_ROW, status: "archived" }]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, null, ["product:10"]);

    expect(ref?.isArchived).toBe(true);
  });

  it("returns isArchived true for an ARCHIVED project", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, status: "ARCHIVED" }]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(ORG, USER, MEMBERSHIP_ID, ["project:20"]);

    expect(ref?.isArchived).toBe(true);
  });
});
