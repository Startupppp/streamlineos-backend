import { KbArticleMigrationService } from "./kb-article-migration.service";

function stubPrivate(
  service: KbArticleMigrationService,
  name: string,
  value: unknown,
): jest.Mock {
  const stub = jest.fn().mockResolvedValue(value);
  Object.defineProperty(service, name, { value: stub, configurable: true });
  return stub;
}

jest.mock("../../../common/tenant/with-tenant", () => ({
  withTenant: jest.fn(
    async (
      _db: unknown,
      _context: unknown,
      callback: (tx: unknown) => Promise<unknown>,
    ) => callback({ tenantTx: true }),
  ),
}));
jest.mock("../../../common/tenant/tenant-context", () => ({
  runWithTenantContext: jest.fn(
    (_context: unknown, callback: () => Promise<unknown>) => callback(),
  ),
}));

function tenantMocks(): {
  withTenant: jest.Mock;
  runWithTenantContext: jest.Mock;
} {
  return {
    withTenant: jest.requireMock("../../../common/tenant/with-tenant").withTenant,
    runWithTenantContext: jest.requireMock("../../../common/tenant/tenant-context").runWithTenantContext,
  };
}

describe("KbArticleMigrationService tenant boundary", () => {
  beforeEach(() => {
    const { withTenant, runWithTenantContext } = tenantMocks();
    withTenant.mockClear();
    runWithTenantContext.mockClear();
  });

  it("runs preview inside an INTERNAL tenant transaction", async () => {
    const service = new KbArticleMigrationService({} as never);
    const previewOn = stubPrivate(service, "previewOn", {
      total: 0,
      byStatus: {},
      alreadyMigrated: 0,
      willMigrate: 0,
      sample: [],
    });

    await service.preview("org-1");

    const { withTenant, runWithTenantContext } = tenantMocks();
    expect(withTenant).toHaveBeenCalledWith(
      {},
      { orgId: "org-1", audience: "INTERNAL" },
      expect.any(Function),
    );
    expect(runWithTenantContext).toHaveBeenCalledWith(
      { orgId: "org-1", audience: "INTERNAL", tx: { tenantTx: true } },
      expect.any(Function),
    );
    expect(previewOn).toHaveBeenCalledWith({ tenantTx: true }, "org-1");
  });

  it("keeps conversion reads and writes on the same tenant transaction", async () => {
    const service = new KbArticleMigrationService({} as never);
    const runOn = stubPrivate(service, "runOn", {
      migrated: 0,
      skipped: 0,
      total: 0,
      failed: 0,
      dryRun: true,
    });
    const user = { orgId: "org-2", userId: "operator-2" } as never;

    await service.run(user, { dryRun: true });

    const { runWithTenantContext } = tenantMocks();
    expect(runOn).toHaveBeenCalledWith({ tenantTx: true }, user, { dryRun: true });
    expect(runWithTenantContext).toHaveBeenCalledWith(
      { orgId: "org-2", audience: "INTERNAL", tx: { tenantTx: true } },
      expect.any(Function),
    );
  });
});
