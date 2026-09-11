import { roles, rolePermissionGrants } from "../../../db/schema";
import { seedDefaultRoles } from "../lib/role-template-seeding";
import type { RoleTemplateSeedingDeps } from "../lib/role-template-seeding";

jest.mock("../seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));

type InsertedRow = { table: unknown; values: unknown };

function createDeps(existingSlugs: string[]) {
  const inserted: InsertedRow[] = [];

  const dbMock = {
    query: { roles: { findFirst: jest.fn() } },
    insert: jest.fn((table: unknown) => {
      // Annotated because `values` returns `chain`, so without a declared type
      // the initializer refers to itself and TS falls back to `any` (TS7022).
      const chain: {
        values: (values: unknown) => typeof chain;
        returning: () => Promise<Array<{ id: number }>>;
      } = {
        values: jest.fn((values: unknown) => {
          inserted.push({ table, values });
          return chain;
        }),
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      };
      return chain;
    }),
  };

  const slugOrder = [
    "ENGINEERING",
    "SALES_REP",
    "CUSTOMER_SUPPORT",
    "DIGITAL_MARKETING",
    "HR_ADMIN",
    "ACCOUNTANT",
  ];
  let callCount = 0;
  dbMock.query.roles.findFirst.mockImplementation(() => {
    const slug = slugOrder[callCount] ?? "";
    callCount++;
    return Promise.resolve(existingSlugs.includes(slug) ? { id: 1 } : undefined);
  });

  return {
    deps: { db: dbMock } as unknown as RoleTemplateSeedingDeps,
    roleRows: () =>
      inserted
        .filter((row) => row.table === roles)
        .map((row) => row.values as { slug: string; isSystem: boolean }),
    grantRows: () =>
      inserted
        .filter((row) => row.table === rolePermissionGrants)
        .flatMap((row) => row.values as { permissionKey: string }[]),
  };
}

/**
 * These used to stub the service's private `seedFromTemplate`, so they proved
 * only which templates were chosen and nothing at all about what was written.
 * The seeding now lives in lib/role-template-seeding.ts where that private has
 * no seam to reach through, so the transaction is faked instead and the rows
 * the template actually produces are asserted.
 */
describe("seedDefaultRoles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates the starter roles that are missing and skips existing ones", async () => {
    const { deps, roleRows } = createDeps(["ENGINEERING", "HR_ADMIN"]);

    const result = await seedDefaultRoles(deps, "org-1");

    expect(result.skipped).toEqual(["ENGINEERING", "HR_ADMIN"]);
    expect(result.created).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
    expect(roleRows().map((row) => row.slug)).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
  });

  it("never writes a starter role as a system role", async () => {
    const { deps, roleRows } = createDeps([]);

    await seedDefaultRoles(deps, "org-1");

    expect(roleRows()).toHaveLength(6);
    expect(roleRows().every((row) => row.isSystem === false)).toBe(true);
  });

  it("grants only permission keys the catalog still defines", async () => {
    const { deps, grantRows } = createDeps([]);
    const { PERMISSIONS } = jest.requireActual<{
      PERMISSIONS: readonly { name: string }[];
    }>("../permissions");
    const catalogued = new Set(PERMISSIONS.map((permission) => permission.name));

    await seedDefaultRoles(deps, "org-1");

    const granted = grantRows();
    expect(granted.length).toBeGreaterThan(0);
    expect(
      granted.filter((row) => !catalogued.has(row.permissionKey)),
    ).toEqual([]);
  });

  it("is a no-op when every starter role already exists", async () => {
    const { deps, roleRows } = createDeps([
      "ENGINEERING",
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "HR_ADMIN",
      "ACCOUNTANT",
    ]);

    const result = await seedDefaultRoles(deps, "org-1");

    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(6);
    expect(roleRows()).toEqual([]);
  });
});
