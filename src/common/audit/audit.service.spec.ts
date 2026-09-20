import { AuditService } from "./audit.service";

const runOutsideTenantContext = jest.fn(
  async <T>(callback: () => Promise<T>): Promise<T> => callback(),
);
const registerAfterCommit = jest.fn();
const getTenantContext = jest.fn();
const withTenant = jest.fn();
const reportError = jest.fn();
const getObservabilityContext = jest.fn();

jest.mock("../tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContext(...args),
  registerAfterCommit: (...args: unknown[]) => registerAfterCommit(...args),
  runOutsideTenantContext: (...args: unknown[]) =>
    runOutsideTenantContext(...(args as [() => Promise<unknown>])),
  withTenant: (...args: unknown[]) => withTenant(...args),
}));

jest.mock("../observability/error-reporter", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

jest.mock("../observability/observability-context", () => ({
  getObservabilityContext: (...args: unknown[]) => getObservabilityContext(...args),
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
    reportError.mockReturnValue(undefined);
    getObservabilityContext.mockReturnValue(undefined);
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

  it("routes audit write failures through reportError so they surface as a grouped incident", async () => {
    const writeError = new Error("insert violates FK constraint");
    const values = jest.fn().mockRejectedValue(writeError);
    const db = { insert: jest.fn().mockReturnValue({ values }) };
    const service = new AuditService(db as never);

    runOutsideTenantContext.mockImplementationOnce(
      <T>(callback: () => Promise<T>) => callback(),
    );

    service.log({ action: "ai.invoke", userId: "user-1", orgId: "org-1" });
    await new Promise<void>((resolve) => process.nextTick(resolve));

    expect(reportError).toHaveBeenCalledWith(writeError, { action: "ai.invoke" });
  });

  it("stamps the Express-resolved client IP from the ambient request context", async () => {
    const { db, values } = makeDb();
    getTenantContext.mockReturnValue({ orgId: "org-1" });
    getObservabilityContext.mockReturnValue({
      correlationId: "corr-1",
      clientIp: "203.0.113.50",
      userAgent: "Mozilla/5.0",
    });
    const service = new AuditService(db as never);

    await service.logCritical({
      action: "org.created",
      userId: "user-1",
      orgId: "org-1",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.created",
        ipAddress: "203.0.113.50",
        metadata: expect.objectContaining({
          requestId: "corr-1",
          userAgent: "Mozilla/5.0",
        }),
      }),
    );
  });

  it("does not overwrite an explicit ipAddress the caller already resolved", async () => {
    const { db, values } = makeDb();
    getTenantContext.mockReturnValue({ orgId: "org-1" });
    getObservabilityContext.mockReturnValue({
      correlationId: "corr-1",
      clientIp: "203.0.113.50",
    });
    const service = new AuditService(db as never);

    await service.logCritical({
      action: "platform.grant",
      userId: "user-1",
      orgId: "org-1",
      ipAddress: "198.51.100.9",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "198.51.100.9" }),
    );
  });

  it("snapshots ambient IP before after-commit dispatch so a cleared ALS still writes it", async () => {
    const { db, values } = makeDb();
    getObservabilityContext.mockReturnValue({
      correlationId: "corr-deferred",
      clientIp: "198.51.100.20",
    });
    let hook: (() => Promise<void>) | undefined;
    registerAfterCommit.mockImplementation((candidate) => {
      hook = candidate as () => Promise<void>;
      return true;
    });
    const service = new AuditService(db as never);

    service.log({
      action: "project.created",
      userId: "user-1",
      orgId: "org-1",
    });

    getObservabilityContext.mockReturnValue(undefined);
    await hook?.();

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "198.51.100.20" }),
    );
  });
});
