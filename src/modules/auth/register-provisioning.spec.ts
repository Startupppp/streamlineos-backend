const events: string[] = [];

async function mockTransaction(body: (handle: unknown) => Promise<unknown>) {
  events.push("tx:begin");
  const result = await body(tx);
  events.push("tx:commit");
  return result;
}

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, body: (tx: unknown) => Promise<unknown>) =>
      mockTransaction(body),
  ),
  runInTenantTransaction: jest.fn(
    async (_db: unknown, body: (tx: unknown) => Promise<unknown>) => mockTransaction(body),
  ),
}));

jest.mock("../../common/org/membership-mutations", () => ({
  withMembershipMutations: jest.fn(
    async (_cache: unknown, body: (mutations: unknown) => Promise<unknown>) =>
      body({
        allocateMembershipId: jest.fn().mockResolvedValue(42),
        createOwnerMembership: jest.fn(async () => {
          events.push("owner");
        }),
        record: jest.fn(),
      }),
  ),
}));

jest.mock("../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn(async () => {
    events.push("roles");
    return { created: 41 };
  }),
}));

jest.mock("../../common/org/provision-org-modules", () => ({
  DEFAULT_SKIP_MODULES: ["hr", "crm", "build"],
  provisionOrgModules: jest.fn(async () => {
    events.push("modules");
  }),
}));

jest.mock("../billing/core/trial-subscription", () => ({
  insertTrialSubscription: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/org/provision-employee-self-service", () => ({
  provisionEmployeeSelfService: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../common/rbac/access-mutation-commit", () => ({
  commitAccessChange: jest.fn().mockResolvedValue(undefined),
}));

import { bootstrapCellOrganization } from "../organization/core/bootstrap-cell-organization";
import { seedSystemRolesForOrg } from "../rbac/seed-system-roles";

function valuesResult() {
  return (_rows: unknown) => {
    const settled = Promise.resolve(undefined);
    return {
      onConflictDoNothing: () => settled,
      onConflictDoUpdate: () => settled,
      returning: () => Promise.resolve([]),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        settled.then(onFulfilled, onRejected),
    };
  };
}

const tx = {
  execute: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  select: jest.fn(),
};

const mockDb = {
  execute: jest.fn().mockResolvedValue([]),
  insert: jest.fn(),
  transaction: jest.fn(async (body: (handle: unknown) => Promise<unknown>) => body(tx)),
};

const mockCache = {
  invalidate: jest.fn().mockResolvedValue(undefined),
  invalidateForOrg: jest.fn().mockResolvedValue(undefined),
};

const PROVISION_INPUT = {
  orgId: "org-new-1",
  userId: "user-founder",
  region: "eu",
  name: "Analytical Engines",
  slug: "analytical-engines",
};

beforeEach(() => {
  events.length = 0;
  jest.clearAllMocks();

  tx.execute.mockResolvedValue(undefined);
  tx.insert.mockImplementation(() => ({ values: jest.fn(valuesResult()) }));
  tx.update.mockImplementation(() => ({
    set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  }));
  tx.select.mockImplementation(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
  }));

  mockDb.execute.mockResolvedValue([]);
  mockDb.insert.mockImplementation(() => ({ values: jest.fn(valuesResult()) }));

  (seedSystemRolesForOrg as jest.Mock).mockImplementation(async () => {
    events.push("roles");
    return { created: 41 };
  });
});

describe("provisioning a new workspace", () => {
  it("seeds roles and modules inside the same transaction as the org", async () => {
    await bootstrapCellOrganization(mockDb as never, mockCache as never, PROVISION_INPUT);

    expect(events).toEqual(["tx:begin", "owner", "roles", "modules", "tx:commit"]);
  });
});

describe("when provisioning fails", () => {
  it("rolls the workspace back with it, rather than leaving a half-provisioned org", async () => {
    (seedSystemRolesForOrg as jest.Mock).mockRejectedValue(new Error("neon went away"));

    await expect(
      bootstrapCellOrganization(mockDb as never, mockCache as never, PROVISION_INPUT),
    ).rejects.toThrow("neon went away");

    expect(events.slice(0, 2)).toEqual(["tx:begin", "owner"]);
    expect(events).not.toContain("tx:commit");
  });
});

describe("re-provisioning the same workspace", () => {
  function orgAlreadyExists() {
    tx.select.mockImplementation(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([{ id: PROVISION_INPUT.orgId }]),
        })),
      })),
    }));
  }

  it("returns without seeding a second time when the organization row is already there", async () => {
    orgAlreadyExists();

    await bootstrapCellOrganization(mockDb as never, mockCache as never, PROVISION_INPUT);

    expect(events).toEqual(["tx:begin", "tx:commit"]);
    expect(seedSystemRolesForOrg).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("takes the per-organization advisory lock before it reads, so two claims cannot both pass", async () => {
    orgAlreadyExists();

    await bootstrapCellOrganization(mockDb as never, mockCache as never, PROVISION_INPUT);

    expect(tx.execute).toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalled();
    const lockedAt = tx.execute.mock.invocationCallOrder[0];
    const readAt = tx.select.mock.invocationCallOrder[0];
    expect(lockedAt).toBeLessThan(readAt as number);

    const locked = tx.execute.mock.calls[0]?.[0];
    expect(JSON.stringify(locked)).toContain("pg_advisory_xact_lock");
  });
});
