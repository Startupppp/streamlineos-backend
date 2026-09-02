import { RoleSeedService } from "../role-seed.service";

jest.mock("../seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
      fn({
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
            onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
  ),
}));

function createService(existingSlugs: string[]) {
  const service = Object.create(RoleSeedService.prototype) as RoleSeedService;

  const dbMock = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(existingSlugs.map((slug) => ({ slug }))),
      }),
    }),
  };

  Reflect.set(service, "db", dbMock);
  return service;
}

describe("RoleSeedService.seedDefaultRoles", () => {
  it("creates the starter roles that are missing and skips existing ones", async () => {
    const service = createService(["ENGINEERING", "HR_ADMIN"]);

    const result = await service.seedDefaultRoles("org-1");

    expect(result.skipped).toEqual(["ENGINEERING", "HR_ADMIN"]);
    expect(result.created).toEqual([
      "SALES_REP",
      "CUSTOMER_SUPPORT",
      "DIGITAL_MARKETING",
      "ACCOUNTANT",
    ]);
  });

  it("is a no-op when every starter role already exists", async () => {
    const service = createService([
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
  });
});
