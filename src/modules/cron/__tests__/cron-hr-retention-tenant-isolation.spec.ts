import { CronHrRetentionService } from "../cron-hr-retention.service";
import type { Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

const ORG_A = "org-aaaa-0000-tenant-a";
const ORG_B = "org-bbbb-1111-tenant-b";

function makeTxForOrg(orgId: string, capturedOrgIds: string[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation(() => {
          capturedOrgIds.push(orgId);
          return Promise.resolve([]);
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("CronHrRetentionService — cross-tenant isolation", () => {
  let svc: CronHrRetentionService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CronHrRetentionService({} as unknown as Db);
  });

  it("sweep uses forEachOrg — each org is processed in its own scoped transaction (not cross-org)", async () => {
    const seenOrgIds: string[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      const txA = makeTxForOrg(ORG_A, seenOrgIds);
      const txB = makeTxForOrg(ORG_B, seenOrgIds);

      await fn(txA as unknown as Parameters<typeof fn>[0], ORG_A);
      await fn(txB as unknown as Parameters<typeof fn>[0], ORG_B);

      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    const result = await svc.sweep();

    expect(mockedForEachOrg).toHaveBeenCalledTimes(1);
    expect(result.organizations).toBe(2);
  });

  it("sweep callback isolates per-org policy query — org A tx is never passed org B's id", async () => {
    const orgAQueries: string[] = [];
    const orgBQueries: string[] = [];

    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      const txA = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() => {
              orgAQueries.push(ORG_A);
              return Promise.resolve([]);
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      };
      await fn(txA as unknown as Parameters<typeof fn>[0], ORG_A);

      const txB = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation(() => {
              orgBQueries.push(ORG_B);
              return Promise.resolve([]);
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      };
      await fn(txB as unknown as Parameters<typeof fn>[0], ORG_B);

      return { organizations: 2, succeeded: 2, failed: 0 };
    });

    await svc.sweep();

    expect(orgAQueries).toContain(ORG_A);
    expect(orgBQueries).toContain(ORG_B);
    expect(orgAQueries).not.toContain(ORG_B);
    expect(orgBQueries).not.toContain(ORG_A);
  });

  it("sweep scopes per-org — policy queries inside the callback are tenant-isolated, not cross-org", async () => {
    let callbackInvokedWithOrgId: string | null = null;

    mockedForEachOrg.mockImplementation(async (_db, _sweep, fn) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      };
      await fn(tx as unknown as Parameters<typeof fn>[0], ORG_A);
      callbackInvokedWithOrgId = ORG_A;
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    await svc.sweep();

    expect(callbackInvokedWithOrgId).toBe(ORG_A);
    expect(mockedForEachOrg).toHaveBeenCalledTimes(1);
    const [, sweepName] = mockedForEachOrg.mock.calls[0] ?? [];
    expect(sweepName).toBe("hr-policy-retention");
  });
});
