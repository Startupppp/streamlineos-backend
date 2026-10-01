import {
  managedProductMemberships,
  managedProducts,
  projects,
} from "../../../db/schema";
import { resolveScopeDirectorySchema } from "./dto/scope-directory.schemas";
import {
  MEMBERSHIP_ID,
  actor,
  ORG,
  PROD_ROW,
  PROJ_ROW,
  makeAccess,
  makeDb,
  makeResponses,
  makeSvc,
  renderParams,
} from "./__tests__/scope-directory-spec-helpers";

describe("ScopeDirectoryService.resolveScopeDirectory", () => {
  it("resolves a mix of product and project and returns parentPath + clientPortalEnabled", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
      [projects, [[PROJ_ROW]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "product:10",
      "project:20",
    ]);

    expect(result).toEqual([
      {
        key: "product:10",
        type: "product",
        id: "10",
        name: "Atlas",
        parentKey: null,
        projectKey: "ATL",
        isArchived: false,
        parentPath: null,
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
        parentPath: "Atlas",
        clientPortalEnabled: false,
      },
    ]);
  });

  it("a workspace: scope key is not resolvable — it is silently ignored rather than resolved", async () => {
    const { db, calls } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "workspace:ws-1",
      "project:20",
    ]);

    expect(result).toEqual([
      {
        key: "project:20",
        type: "project",
        id: "20",
        name: "Launch",
        parentKey: "product:10",
        projectKey: "LAU",
        isArchived: false,
        parentPath: "Atlas",
        clientPortalEnabled: false,
      },
    ]);
    expect(calls.some((c) => c.table === managedProducts)).toBe(true);
  });

  it("omits a key whose row is in another organization, because the caller-scoped query never returns it", async () => {
    const { db } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "product:10",
      "product:999",
    ]);

    expect(result.map((ref) => ref.key)).toEqual(["product:10"]);
  });

  it("omits a soft-deleted row, because the deletedAt filter excludes it from the query result", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(null), ["product:99"]);

    expect(result).toEqual([]);
  });

  it("binds every issued query to the caller's orgId", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[]]],
      [projects, [[]]],
    ]));

    await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "product:10",
      "project:20",
    ]);

    const mainCalls = calls.filter((c) =>
      c.table === managedProducts || c.table === projects,
    );
    expect(mainCalls.length).toBeGreaterThanOrEqual(2);
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

  it("rejects a workspace: key prefix at the schema boundary", () => {
    const result = resolveScopeDirectorySchema.safeParse({ keys: ["workspace:ws-1"] });
    expect(result.success).toBe(false);
  });

  it("issues no query for a type that appears in no key", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db).resolveScopeDirectory(actor(null), ["product:10"]);

    const mainCalls = calls.filter(
      (c) => c.table === managedProducts || c.table === projects,
    );
    expect(mainCalls).toHaveLength(1);
    expect(mainCalls[0]?.table).toBe(managedProducts);
  });

  it("clientPortalEnabled is true when the project has a clientMembershipId set", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: 7 }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(true);
  });

  it("clientPortalEnabled is false when the project has no clientMembershipId", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, clientMembershipId: null }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(ref?.clientPortalEnabled).toBe(false);
  });

  it("resolves parentPath for a product as null, because a product has no ancestor", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(null), ["product:10"]);

    expect(ref?.parentPath).toBeNull();
  });

  it("resolves parentPath for a project as the product name when the product is an ancestor", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(ref?.parentPath).toBe("Atlas");
  });

  it("sets parentPath to null when the project has no managedProductId", async () => {
    const projNoProduct = { ...PROJ_ROW, managedProductId: null };
    const { db } = makeDb(makeResponses([
      [projects, [[projNoProduct]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(ref?.parentPath).toBeNull();
  });

  it("resolves two projects with duplicate names by their distinct IDs", async () => {
    const proj1 = { ...PROJ_ROW, id: 20, name: "Titan", managedProductId: null };
    const proj2 = { ...PROJ_ROW, id: 21, name: "Titan", key: "TIT2", managedProductId: null };
    const { db } = makeDb(makeResponses([
      [projects, [[proj1, proj2]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "project:20",
      "project:21",
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["20", "21"]);
    expect(result.map((r) => r.name)).toEqual(["Titan", "Titan"]);
  });
});

describe("ScopeDirectoryService — archived scopes", () => {
  it("returns isArchived true for an archived product", async () => {
    const { db } = makeDb(makeResponses([
      [managedProducts, [[{ ...PROD_ROW, status: "archived" }]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(null), ["product:10"]);

    expect(ref?.isArchived).toBe(true);
  });

  it("returns isArchived true for an ARCHIVED project", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[{ ...PROJ_ROW, status: "ARCHIVED" }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const [ref] = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(ref?.isArchived).toBe(true);
  });
});

describe("ScopeDirectoryService.searchScopeDirectory — search predicate in SQL WHERE, not post-query JS filter (BSN-02-010)", () => {
  it("search term is bound as a SQL parameter in the managedProducts WHERE, proving the filter is in SQL not applied to the query result in JS", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Atlas", 25, undefined);

    const prodCall = calls.find((c) => c.table === managedProducts);
    expect(prodCall).toBeDefined();
    const params = renderParams(prodCall?.condition);
    expect(params).toContain("Atlas");
    expect(params).toContain("Atlas%");
  });

  it("auth inArray is bound in the product WHERE — the accessible IDs reach the SQL predicate, not a JS result filter", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }, { managedProductId: 11 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "At", 25, undefined);

    const prodCall = calls.find((c) => c.table === managedProducts);
    expect(prodCall).toBeDefined();
    const params = renderParams(prodCall?.condition);
    expect(params).toContain(10);
    expect(params).toContain(11);
  });

  it("build:manage all bypasses product membership lookup in search", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).searchScopeDirectory(actor(null), "Atlas", 25, undefined);

    expect(result.data).toHaveLength(1);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
  });

  it("returns empty data and no nextCursor when membershipId is null and build:manage is not all", async () => {
    const { db } = makeDb(makeResponses());

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(null), "x", 25, undefined);

    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns product ref with correct shape from search", async () => {
    const { db } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Atlas", 25, undefined);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      key: "product:10",
      type: "product",
      id: "10",
      name: "Atlas",
      parentKey: null,
      isArchived: false,
      parentPath: null,
      clientPortalEnabled: null,
    });
  });

  it("skips the managedProducts data query when accessible product list is empty, so no phantom rows can appear", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Nope", 25, undefined);

    expect(result.data).toEqual([]);
    expect(calls.find((c) => c.table === managedProducts)).toBeUndefined();
  });

  it("search includes project results with correct parentPath derived from product ancestor", async () => {
    const { db } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Lau", 25, undefined);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      key: "project:20",
      type: "project",
      parentPath: "Atlas",
    });
  });

  it("search project results require auth: reachability predicate is embedded in the project WHERE clause when build:manage is not all", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
      [projects, [[PROJ_ROW]]],
    ]));

    await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Lau", 25, undefined);

    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("nextCursor is null when results fit on one page", async () => {
    const { db } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Atlas", 25, undefined);

    expect(result.nextCursor).toBeNull();
  });

  it("nextCursor is a non-empty string when results exceed the page limit", async () => {
    const extraProdRows = Array.from({ length: 26 }, (_, i) => ({
      id: 100 + i,
      name: `Product ${i}`,
      key: `PROD${i}`,
      status: "active" as const,
    }));
    const { db } = makeDb(makeResponses([
      [managedProductMemberships, [extraProdRows.map((r) => ({ managedProductId: r.id }))]],
      [managedProducts, [extraProdRows]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "Product", 25, undefined);

    expect(result.nextCursor).not.toBeNull();
    expect(result.data).toHaveLength(25);
  });

  it("orgId is bound in ALL membership and data queries issued by search", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
      [projects, [[PROJ_ROW]]],
    ]));

    await makeSvc(db, makeAccess(null)).searchScopeDirectory(actor(MEMBERSHIP_ID), "a", 25, undefined);

    for (const call of calls)
      expect(renderParams(call.condition)).toContain(ORG);
  });
});

describe("ScopeDirectoryService — projects without a managed product (BE-134)", () => {
  it("produces a ref for a project whose managedProductId is null with parentPath null, confirming the project is not dropped", async () => {
    const projNoProduct = { ...PROJ_ROW, managedProductId: null };
    const { db } = makeDb(makeResponses([
      [projects, [[projNoProduct]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), ["project:20"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: "project:20",
      type: "project",
      id: "20",
      name: "Launch",
      parentPath: null,
      parentKey: null,
      clientPortalEnabled: false,
    });
  });

  it("excludes null managedProductId from the product ancestor fetch so no null reaches the SQL inArray, while the real missing product id is fetched and used in parentPath", async () => {
    const projNullProduct = { ...PROJ_ROW, id: 20, managedProductId: null };
    const projRealProduct = { ...PROJ_ROW, id: 21, key: "P2", managedProductId: 99 };
    const missingProductRow = { id: 99, name: "Orion", key: "ORI", status: "active" };
    const { db, calls } = makeDb(makeResponses([
      [projects, [[projNullProduct, projRealProduct]]],
      [managedProducts, [[missingProductRow]]],
    ]));

    const result = await makeSvc(db).resolveScopeDirectory(actor(MEMBERSHIP_ID), [
      "project:20",
      "project:21",
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.parentPath).toBeNull();
    expect(result[1]?.parentPath).toBe("Orion");
    const productCalls = calls.filter((c) => c.table === managedProducts);
    expect(productCalls).toHaveLength(1);
    const params = renderParams(productCalls[0]?.condition);
    expect(params).toContain(99);
    expect(params).not.toContain(null);
  });
});
