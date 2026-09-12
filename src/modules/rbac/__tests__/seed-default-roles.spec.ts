import { roles, rolePermissionGrants } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { RoleSeedService } from "../role-seed.service";
import { PERMISSIONS } from "../permissions";

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

type InsertedRow = { table: unknown; values: unknown[] };

function createService(existingSlugs: string[]) {
  const inserted: InsertedRow[] = [];

  const dbMock = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(existingSlugs.map((slug) => ({ slug }))),
      }),
    }),
    insert: jest.fn((table: unknown) => ({
      values: jest.fn((values: unknown) => {
        const rows = (Array.isArray(values) ? values : [values]) as { slug?: string }[];
        inserted.push({ table, values: rows });
        // Awaited bare for the grants, `.returning()`-ed for the roles.
        return Object.assign(Promise.resolve(undefined), {
          returning: jest
            .fn()
            .mockResolvedValue(rows.map((row, index) => ({ id: index + 1, slug: row.slug }))),
        });
      }),
    })),
  };

  function rowsOf<T>(table: unknown): T[] {
    return inserted.filter((row) => row.table === table).flatMap((row) => row.values as T[]);
  }

  return {
    dbMock,
    service: new RoleSeedService(dbMock as unknown as Db),
    roleRows: () => rowsOf<{ slug: string; isSystem: boolean }>(roles),
    grantRows: () => rowsOf<{ permissionKey: string }>(rolePermissionGrants),
  };
}

/**
 * Asserting only which templates were chosen proved nothing about what was
 * written, so the transaction is faked and the rows the service actually
 * inserts are asserted too.
 */
describe("RoleSeedService.seedDefaultRoles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates the starter roles that are missing and skips existing ones", async () => {
    const { service, roleRows } = createService(["ENGINEERING", "HR_ADMIN"]);

    const result = await service.seedDefaultRoles("org-1");

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
    const { service, roleRows } = createService([]);

    await service.seedDefaultRoles("org-1");

    expect(roleRows()).toHaveLength(6);
    expect(roleRows().every((row) => row.isSystem === false)).toBe(true);
  });

  it("grants only permission keys the catalog still defines", async () => {
    const { service, grantRows } = createService([]);
    const catalogued = new Set(PERMISSIONS.map((permission) => permission.name));

    await service.seedDefaultRoles("org-1");

    const granted = grantRows();
    expect(granted.length).toBeGreaterThan(0);
    expect(granted.filter((row) => !catalogued.has(row.permissionKey))).toEqual([]);
  });

  it("is a no-op when every starter role already exists", async () => {
    const { service, dbMock } = createService([
      "ENGINEERING",
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "HR_ADMIN",
      "ACCOUNTANT",
    ]);

    const result = await service.seedDefaultRoles("org-1");

    expect(result.created).toEqual([]);
    expect(result.skipped).toHaveLength(6);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
