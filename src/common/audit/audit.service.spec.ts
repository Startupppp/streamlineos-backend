import { AuditService } from "./audit.service";

const runOutsideTenantContext = jest.fn(
  async <T>(callback: () => Promise<T>): Promise<T> => callback(),
);
const registerAfterCommit = jest.fn();
const getTenantContext = jest.fn();
const withTenant = jest.fn();

jest.mock("../tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContext(...args),
  registerAfterCommit: (...args: unknown[]) => registerAfterCommit(...args),
  runOutsideTenantContext: (...args: unknown[]) =>
    runOutsideTenantContext(...(args as [() => Promise<unknown>])),
  withTenant: (...args: unknown[]) => withTenant(...args),
}));

function makeDb() {
  const values = jest.fn().mockResolvedValue(undefined);
  return {
    db: { insert: jest.fn().mockReturnValue({ values }) },
    values,
  };
}

describe("AuditService dispatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTenantContext.mockReturnValue(undefined);
    registerAfterCommit.mockReturnValue(false);
    withTenant.mockImplementation(
      async (
        db: unknown,
        _context: unknown,
        callback: (tx: unknown) => Promise<unknown>,
      ) => callback(db),
    );
  });

  it("dispatches best-effort logs in a fresh tenant context after commit", async () => {
    const { db } = makeDb();
    const service = new AuditService(db as never);
    let hook: (() => Promise<void>) | undefined;
    registerAfterCommit.mockImplementation((candidate) => {
      hook = candidate as () => Promise<void>;
      return true;
    });

    service.log({
      action: "noncritical.event",
      userId: "user-1",
      orgId: "org-1",
    });

    expect(runOutsideTenantContext).not.toHaveBeenCalled();
    expect(hook).toBeDefined();
    await hook?.();
    expect(runOutsideTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenant).toHaveBeenCalledWith(
      db,
      { orgId: "org-1", audience: "INTERNAL" },
      expect.any(Function),
    );
  });

  it("dispatches immediately when there is no transaction hook", async () => {
    const { db } = makeDb();
    const service = new AuditService(db as never);

    service.log({ action: "background.event", userId: "user-1" });
    await Promise.resolve();

    expect(registerAfterCommit).toHaveBeenCalledTimes(1);
    expect(runOutsideTenantContext).toHaveBeenCalledTimes(1);
  });

  it("keeps critical writes awaited in the active transaction", async () => {
    const { db, values } = makeDb();
    getTenantContext.mockReturnValue({ orgId: "org-1" });
    const service = new AuditService(db as never);

    await service.logCritical({
      action: "critical.event",
      userId: "user-1",
      orgId: "org-1",
    });

    expect(runOutsideTenantContext).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ action: "critical.event", orgId: "org-1" }),
    );
  });
});
