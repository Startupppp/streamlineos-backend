/**
 * `reconcileAllOrganizations` sweeps every organisation in the database. It ran
 * awaited inside `onModuleInit`, so boot time grew with tenant count on every
 * replica — and because a slow boot is itself a kill trigger for an orchestrator
 * health check, a restart loop got worse with each pass rather than settling.
 *
 * The sweep still runs, and still runs only after `sync()` has resolved: a grant
 * whose permission key is new in this release violates the foreign key to
 * `permissions.name` until the catalog carries it. Only the waiting is gone.
 */
import {
  GRANT_RECONCILE_JOB_KEY,
  PermissionCatalogSyncService,
} from "../permission-catalog-sync.service";

const EMPTY_SYNC = {
  catalogSize: 0,
  staleKeys: [],
  deletedKeys: [],
  retainedKeys: [],
};

function makeService(
  reconcile: jest.Mock,
  withLease?: jest.Mock,
): {
  service: PermissionCatalogSyncService;
  syncSpy: jest.SpyInstance;
  withLease: jest.Mock;
} {
  const reconciler = { reconcileAllOrganizations: reconcile };
  const lease =
    withLease ??
    jest.fn(async (_key: string, _window: number, fn: () => Promise<unknown>) => ({
      ran: true,
      result: await fn(),
    }));
  const service = new PermissionCatalogSyncService(
    {} as never,
    reconciler as never,
    { withLease: lease } as never,
  );
  const syncSpy = jest.spyOn(service, "sync").mockResolvedValue(EMPTY_SYNC);
  return { service, syncSpy, withLease: lease };
}

describe("permission catalog sync — boot path", () => {
  const originalFlag = process.env.RBAC_GRANT_RECONCILE_ON_BOOT;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    else process.env.RBAC_GRANT_RECONCILE_ON_BOOT = originalFlag;
    jest.restoreAllMocks();
  });

  it("returns from onModuleInit without waiting for the all-organisations sweep to finish", async () => {
    delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    let settle = (): void => undefined;
    const reconcile = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { service } = makeService(reconcile);

    await service.onModuleInit();

    expect(reconcile).toHaveBeenCalledTimes(1);
    settle();
  });

  it("still sweeps only after the catalog sync has resolved, or the grant would violate the permissions foreign key", async () => {
    delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    const order: string[] = [];
    const reconcile = jest.fn(async () => {
      order.push("reconcile");
    });
    const { service, syncSpy } = makeService(reconcile);
    syncSpy.mockImplementation(async () => {
      order.push("sync");
      return EMPTY_SYNC;
    });

    await service.onModuleInit();

    expect(order).toEqual(["sync", "reconcile"]);
  });

  it("logs a sweep failure rather than letting a detached rejection reach the process handler", async () => {
    delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    const reconcile = jest.fn().mockRejectedValue(new Error("sweep exploded"));
    const { service } = makeService(reconcile);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("takes a cron lease so one replica sweeps rather than every replica repeating it", async () => {
    delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const { service, withLease } = makeService(reconcile);

    await service.onModuleInit();

    expect(withLease).toHaveBeenCalledTimes(1);
    expect(withLease.mock.calls[0]?.[0]).toBe(GRANT_RECONCILE_JOB_KEY);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not sweep when another replica already holds the lease", async () => {
    delete process.env.RBAC_GRANT_RECONCILE_ON_BOOT;
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const held = jest.fn().mockResolvedValue({ ran: false });
    const { service } = makeService(reconcile, held);

    await service.onModuleInit();
    await Promise.resolve();

    expect(held).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips the sweep entirely when RBAC_GRANT_RECONCILE_ON_BOOT is false", async () => {
    process.env.RBAC_GRANT_RECONCILE_ON_BOOT = "false";
    const reconcile = jest.fn();
    const { service } = makeService(reconcile);

    await service.onModuleInit();

    expect(reconcile).not.toHaveBeenCalled();
  });
});
