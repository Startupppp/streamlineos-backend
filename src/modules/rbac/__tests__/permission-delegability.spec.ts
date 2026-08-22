import {
  assertPermissionsGrantable,
  isDelegablePermission,
  ROLE_RANK,
} from "../../../common/rbac/grantability";
import { permissions } from "../../../db/schema";
import { PermissionCatalogSyncService } from "../permission-catalog-sync.service";
import { RbacService } from "../rbac.service";
import { PERMISSIONS } from "../permissions";

const CATALOG_KEYS = PERMISSIONS.map((p) => p.name);
const NON_DELEGABLE_KEYS = CATALOG_KEYS.filter(
  (key) => !isDelegablePermission(key),
);
const BILLING_KEYS = CATALOG_KEYS.filter((key) => key.startsWith("billing:"));

function grantPermittedForOrgOwner(key: string): boolean {
  try {
    assertPermissionsGrantable(
      { isOrgOwner: true, grantable: new Set<string>() },
      [key],
    );
    return true;
  } catch {
    return false;
  }
}

interface CatalogRow {
  name: string;
  isDelegable: boolean;
}

interface CapturedInsert {
  rows: CatalogRow[];
}

function isCatalogRow(value: unknown): value is CatalogRow {
  if (typeof value !== "object" || value === null) return false;
  const row: Record<string, unknown> = { ...value };
  return typeof row.name === "string" && typeof row.isDelegable === "boolean";
}

function makeSyncService(captured: CapturedInsert): PermissionCatalogSyncService {
  const svc = Object.create(
    PermissionCatalogSyncService.prototype,
  ) as PermissionCatalogSyncService;

  const db = {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        if (table === permissions && Array.isArray(rows))
          captured.rows = rows.filter(isCatalogRow);
        return {
          onConflictDoUpdate: () => Promise.resolve(undefined),
          onConflictDoNothing: () => Promise.resolve(undefined),
        };
      },
    }),
    select: () => ({ from: () => Promise.resolve([]) }),
  };

  Reflect.set(svc, "db", db);
  return svc;
}

function makeRbacService(
  resolved: ReadonlyMap<string, string>,
  allowedModules: Set<string> | null,
): RbacService {
  const svc = Object.create(RbacService.prototype) as RbacService;

  Reflect.set(svc, "access", {
    resolveUserPermissions: () => Promise.resolve(resolved),
  });
  Reflect.set(svc, "db", {});
  Reflect.set(svc, "rolesService", {});
  Reflect.set(svc, "resolveActorRankContext", () =>
    Promise.resolve({ bestRank: ROLE_RANK.FUNCTIONAL, allowedModules }),
  );

  return svc;
}

describe("permission delegability", () => {
  it("has non-delegable keys in the catalog, so the rule is not vacuous", () => {
    expect(NON_DELEGABLE_KEYS.length).toBeGreaterThan(0);
    expect(BILLING_KEYS.length).toBeGreaterThan(0);
  });

  it("agrees with the grant guard on every key in the catalog", () => {
    const disagreeing = CATALOG_KEYS.filter(
      (key) => isDelegablePermission(key) !== grantPermittedForOrgOwner(key),
    );
    expect(disagreeing).toEqual([]);
  });

  it("marks the whole billing namespace non-delegable", () => {
    for (const key of BILLING_KEYS) expect(isDelegablePermission(key)).toBe(false);
  });

  it("leaves the organisation's own customer invoicing delegable", () => {
    expect(isDelegablePermission("accounting:invoices:manage")).toBe(true);
  });
});

describe("permission catalog sync — is_delegable", () => {
  it("writes the delegability of every catalog key rather than defaulting to true", async () => {
    const captured: CapturedInsert = { rows: [] };
    await makeSyncService(captured).sync();

    expect(captured.rows).toHaveLength(PERMISSIONS.length);
    const wrong = captured.rows.filter(
      (row) => row.isDelegable !== isDelegablePermission(row.name),
    );
    expect(wrong).toEqual([]);
  });

  it("writes false for a non-delegable key", async () => {
    const captured: CapturedInsert = { rows: [] };
    await makeSyncService(captured).sync();

    const billingRow = captured.rows.find((row) => row.name === BILLING_KEYS[0]);
    expect(billingRow?.isDelegable).toBe(false);
  });
});

describe("getDiscoveryGrantable — never advertises a key the guard refuses", () => {
  it("excludes non-delegable keys from an org owner's grantable set", async () => {
    const svc = makeRbacService(new Map(), null);

    const result = await svc.getDiscoveryGrantable({
      orgId: "org-1",
      userId: "user-owner",
      isOrgOwner: true,
    } as never);

    for (const key of NON_DELEGABLE_KEYS)
      expect(result.grantableKeys).not.toContain(key);
    expect(result.grantableKeys.length).toBeGreaterThan(0);
  });

  it("excludes non-delegable keys from a holder who resolves them", async () => {
    const hrKey = "hr:employees:view";
    const held = new Map(
      [...BILLING_KEYS, hrKey].map((key) => [key, "all"] as const),
    );
    const svc = makeRbacService(held, null);

    const result = await svc.getDiscoveryGrantable({
      orgId: "org-1",
      userId: "user-admin",
      isOrgOwner: false,
    } as never);

    for (const key of BILLING_KEYS)
      expect(result.grantableKeys).not.toContain(key);
    expect(result.grantableKeys).toContain(hrKey);
  });

  it("advertises only keys the guard would actually permit", async () => {
    const svc = makeRbacService(new Map(), null);

    const result = await svc.getDiscoveryGrantable({
      orgId: "org-1",
      userId: "user-owner",
      isOrgOwner: true,
    } as never);

    const refused = result.grantableKeys.filter(
      (key) => !grantPermittedForOrgOwner(key),
    );
    expect(refused).toEqual([]);
  });
});
