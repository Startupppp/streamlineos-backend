import { AuditService } from "./audit.service";
import { runWithObservabilityContext } from "../observability/observability-context";

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

jest.mock("../observability/error-reporter", () => ({ reportError: jest.fn() }));

function makeDb() {
  const values = jest.fn().mockResolvedValue(undefined);
  return { db: { insert: jest.fn().mockReturnValue({ values }) }, values };
}

const CALLER_IP = "203.0.113.9";

describe("audit rows carry the caller's IP without every controller taking a request object", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getTenantContext.mockReturnValue(undefined);
    registerAfterCommit.mockReturnValue(false);
    withTenant.mockImplementation(
      async (db: unknown, _c: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(db),
    );
  });

  it("stamps the edge-resolved IP on a caller that passes none, which is what left every row showing a dash", async () => {
    const { db, values } = makeDb();
    const service = new AuditService(db as never);

    await runWithObservabilityContext(
      { correlationId: "c-1", ipAddress: CALLER_IP },
      async () =>
        service.logCritical({
          action: "project.created",
          userId: "user-1",
          orgId: "org-1",
        }),
    );

    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]?.[0]).toMatchObject({ ipAddress: CALLER_IP });
  });

  it("lets an explicit caller-supplied IP win, so the payments path keeps its own actor context", async () => {
    const { db, values } = makeDb();
    const service = new AuditService(db as never);

    await runWithObservabilityContext(
      { correlationId: "c-2", ipAddress: CALLER_IP },
      async () =>
        service.logCritical({
          action: "payment.captured",
          userId: "user-1",
          orgId: "org-1",
          ipAddress: "198.51.100.4",
        }),
    );

    expect(values.mock.calls[0]?.[0]).toMatchObject({ ipAddress: "198.51.100.4" });
  });

  it("writes null rather than throwing for a background sweep that runs with no request context", async () => {
    const { db, values } = makeDb();
    const service = new AuditService(db as never);

    await service.logCritical({
      action: "retention.swept",
      orgId: "org-1",
      systemActor: "cron.retention",
    });

    expect(values.mock.calls[0]?.[0]).toMatchObject({ ipAddress: null });
  });
});
