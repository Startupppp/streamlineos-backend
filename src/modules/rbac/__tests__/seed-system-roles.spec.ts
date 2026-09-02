import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
  MODULE_ADMIN_MODULES,
  seedSystemRolesForOrg,
} from "../seed-system-roles";
import { ACCESS_MANAGED_MODULES, ALL_PERMISSION_NAMES } from "../permissions";

const ORG_ID = "org-seed-test";
const ORG_WIDE_SYSTEM_ROLES = 2;
const EXPECTED_SYSTEM_ROLE_COUNT =
  ORG_WIDE_SYSTEM_ROLES +
  MODULE_ADMIN_MODULES.length +
  ACCESS_MANAGED_MODULES.length * 2;

function makeInsertChain(returningValue: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
  chain.onConflictDoUpdate = jest.fn().mockReturnValue(chain);
  chain.returning = jest.fn().mockResolvedValue(returningValue);
  return chain;
}

function makeSelectChain(resolveValue: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(resolveValue);
  return chain;
}

function buildDb(rolesInsertReturning: unknown[]) {
  const txInsert = jest.fn().mockImplementation(() => makeInsertChain(rolesInsertReturning));
  const txMock = { insert: txInsert };
  const db = {
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
    ),
  };
  return { db, txInsert };
}

describe("seedSystemRolesForOrg", () => {
  it("creates all expected system roles for a fresh org", async () => {
    const { db } = buildDb([{ id: 42 }]);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(EXPECTED_SYSTEM_ROLE_COUNT);
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const { db, txInsert } = buildDb([]);

    const result = await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(result.created).toBe(0);
    expect(txInsert).toHaveBeenCalledTimes(EXPECTED_SYSTEM_ROLE_COUNT);
  });

  it("does not insert grants when the role already exists", async () => {
    const txInsert = jest.fn().mockImplementation(() => makeInsertChain([]));
    const txMock = { insert: txInsert };
    const db = {
      select: jest.fn().mockReturnValue(makeSelectChain([{ name: "hr:employees:view" }])),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock),
      ),
    };

    await seedSystemRolesForOrg(db as never, ORG_ID);

    expect(txInsert).toHaveBeenCalledTimes(EXPECTED_SYSTEM_ROLE_COUNT);
  });
});

/**
 * The rung a Build administrator actually gets.
 *
 * Repository connections are Build's own settings page but their keys live in
 * the `integrations` namespace, so `moduleScopedPermissions("build")` cannot
 * find them. The page was gated on `settings:manage` — organisation
 * administration — which meant the module's own administrator could not open
 * it and anyone who could open it could also rewrite the organisation.
 * `RoleGrantReconcilerService` reads these same builders at boot, so an
 * organisation seeded before this entry converges on it without a migration.
 */
describe("module admin rungs reach the keys their own screens need", () => {
  const CATALOG = new Set(ALL_PERMISSION_NAMES);

  it("gives BUILD_MODULE_ADMIN both repository-connection keys", () => {
    const keys = buildModuleAdminPermissionKeys("build", CATALOG);

    expect(keys).toContain("integrations:git:view");
    expect(keys).toContain("integrations:git:manage");
  });

  it("does not hand them organisation administration to get there", () => {
    expect(buildModuleAdminPermissionKeys("build", CATALOG)).not.toContain(
      "settings:manage",
    );
  });

  it("keeps the pair narrow — no other integrations key rides along", () => {
    const borrowed = buildModuleAdminPermissionKeys("build", CATALOG).filter(
      (key) => key.startsWith("integrations:") && !key.startsWith("integrations:git:"),
    );

    expect(borrowed).toEqual([]);
  });

  it("leaves the write key off the member rung", () => {
    const memberKeys = buildModuleMemberPermissionKeys("build", CATALOG);

    expect(memberKeys).not.toContain("integrations:git:manage");
  });

  it("grants nothing the catalogue does not define", () => {
    const undefinedKeys = buildModuleAdminPermissionKeys("build", CATALOG).filter(
      (key) => !CATALOG.has(key),
    );

    expect(undefinedKeys).toEqual([]);
  });
});
