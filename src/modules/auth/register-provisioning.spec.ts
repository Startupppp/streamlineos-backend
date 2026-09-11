/**
 * What a stranger gets, and when they are let in.
 *
 * Phase 3 ticket 13. Two things have to hold at once: the claim must not return
 * until the workspace is usable, and a workspace that never became usable must
 * not be reachable. The interesting assertions here are therefore about
 * *ordering* and about what survives a failure, not about which functions were
 * reached.
 */
const events: string[] = [];

/**
 * Every tenant-transaction seam runs its body against the shared `tx` and
 * records where that transaction began and committed, so a case can say which
 * writes one transaction carried. A body that throws records no commit: that is
 * a rollback, and whatever the body wrote goes with it.
 */
async function mockTransaction(body: (handle: unknown) => Promise<unknown>) {
  events.push("tx:begin");
  const result = await body(tx);
  events.push("tx:commit");
  return result;
}

jest.mock("../../common/tenant", () => ({
  withNewOrgInRegion: jest.fn(
    async (_db: unknown, _placement: unknown, body: (tx: unknown) => Promise<unknown>) =>
      mockTransaction(body),
  ),
  runWithTenantContext: jest.fn(
    async (_context: unknown, body: () => Promise<unknown>) => body(),
  ),
  // `register` places the organisation and then opens a normal tenant
  // transaction to mint the membership id. The double named only the
  // create-time seam, so the call after it died on "withTenant is not a
  // function" — inside the try, which is why the failure case saw that message
  // instead of the one it throws.
  withTenant: jest.fn(
    async (_db: unknown, _context: unknown, body: (tx: unknown) => Promise<unknown>) =>
      mockTransaction(body),
  ),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, body: (tx: unknown) => Promise<unknown>) =>
      mockTransaction(body),
  ),
  runInTenantTransaction: jest.fn(
    async (_db: unknown, body: (tx: unknown) => Promise<unknown>) => mockTransaction(body),
  ),
}));

jest.mock("../../common/region/region-registry", () => ({
  regionForNewOrg: jest.fn().mockReturnValue("eu"),
  // `withNewOrgInRegion` asks whether a registry is configured before it binds a
  // connection. A factory naming only `regionForNewOrg` leaves that undefined,
  // and the provisioning path then dies on "hasRegionRegistry is not a function"
  // rather than on anything this file is about.
  hasRegionRegistry: jest.fn().mockReturnValue(false),
  DEFAULT_REGION: "primary",
}));

jest.mock("../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: jest.fn().mockResolvedValue({ region: "eu" }),
  regionPlacementCoordinates: jest.fn((choice: { region: string }) => ({
    region: choice.region,
    cellId: `${choice.region}-1`,
  })),
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

jest.mock("../onboarding-activation/seed-demo-dataset", () => ({
  seedDemoDataset: jest.fn(async () => {
    events.push("demo");
    return { seeded: true };
  }),
}));

import { AuthService } from "./auth.service";
import { seedSystemRolesForOrg } from "../rbac/seed-system-roles";
import { seedDemoDataset } from "../onboarding-activation/seed-demo-dataset";
import { regionForNewOrg } from "../../common/region/region-registry";
import { chooseRegionForNewOrg } from "../../common/region/cell-admission";

/**
 * What `.values()` returns has to be both awaitable and chainable.
 *
 * Provisioning calls `.values(...).onConflictDoNothing()`, so a double whose
 * `values` resolves straight to a promise dies on "onConflictDoNothing is not a
 * function" — before reaching anything these cases assert. This returns a
 * thenable that also carries the builder method, so both spellings work.
 */
function valuesResult(record?: (rows: unknown) => void) {
  return (rows: unknown) => {
    record?.(rows);
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
  execute: jest.fn().mockResolvedValue([{ id: 7 }]),
  insert: jest.fn(() => ({ values: jest.fn(valuesResult()) })),
};

interface UserRow {
  id: string;
  isActive: boolean;
  lastActiveOrgId: string | null;
}

function buildService(options: {
  existingUser?: UserRow | null;
  ladder?: { id: number }[];
} = {}) {
  const inserted: { table: string; rows: unknown[] }[] = [];
  const updates: Record<string, unknown>[] = [];

  const db = {
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(options.existingUser ?? null) },
    },
    execute: jest.fn().mockResolvedValue([{ id: 7 }]),
    // `placeOrganization` opens its own transaction to set `app.user_id`; the
    // double runs the body against the same `tx` every other seam here uses.
    transaction: jest.fn(async (body: (handle: unknown) => Promise<unknown>) => body(tx)),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation(
        valuesResult((rows) => {
          inserted.push({ table: "any", rows: Array.isArray(rows) ? rows : [rows] });
        }),
      ),
    })),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        updates.push(patch);
        if (patch["isActive"] === true) events.push("activate");
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(options.ladder ?? []),
        }),
      }),
    }),
  };

  tx.insert.mockImplementation(() => ({
    values: jest.fn(
      valuesResult((rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        inserted.push({ table: "tenant", rows: list });
        if (list.some((row) => typeof row === "object" && row !== null && "emailVerified" in row))
          events.push("owner");
      }),
    ),
  }));

  const service = new AuthService(
    db as never,
    {} as never,
    {
      del: jest.fn().mockResolvedValue(undefined),
      // main's membership-status bust runs on activation.
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidateForOrg: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    } as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as never,
    { resolvePreferredOrg: jest.fn().mockResolvedValue(null) } as never,
  );

  return { service, db, inserted, updates };
}

const SIGNUP = {
  email: "Founder@Example.com",
  firstName: "Ada",
  lastName: "Byron",
  companyName: "Analytical Engines",
  country: "DE",
};

beforeEach(() => {
  events.length = 0;
  jest.clearAllMocks();
  (seedSystemRolesForOrg as jest.Mock).mockImplementation(async () => {
    events.push("roles");
    return { created: 41 };
  });
  (seedDemoDataset as jest.Mock).mockImplementation(async () => {
    events.push("demo");
    return { seeded: true };
  });
});

/**
 * A new signup writes the owner, the roles, the modules and the demo dataset in
 * one transaction (main's register). No sign-in path exists mid-provisioning
 * because none of it is visible until all of it commits; the owner does not need
 * creating closed and opening afterwards. The retry cases below cover owners the
 * earlier two-step flow left closed.
 */
describe("a stranger signing up", () => {
  it("is let in by the same commit that gives the workspace roles, modules and something in it", async () => {
    const { service } = buildService();

    await service.register(SIGNUP);

    expect(events).toEqual(["tx:begin", "owner", "roles", "modules", "demo", "tx:commit"]);
  });

  it("writes the owner through that transaction's handle, never on its own connection", async () => {
    const { service, inserted } = buildService();

    await service.register(SIGNUP);

    const userWrites = inserted.filter((statement) =>
      statement.rows.some(
        (row) => typeof row === "object" && row !== null && "emailVerified" in row,
      ),
    );

    expect(userWrites.map((statement) => statement.table)).toEqual(["tenant"]);
  });

  it("gets a workspace with a demo dataset in it", async () => {
    const { service } = buildService();

    await service.register(SIGNUP);

    expect(seedDemoDataset).toHaveBeenCalledTimes(1);
  });

  it("places the workspace from the signup country", async () => {
    const { service } = buildService();

    await service.register(SIGNUP);

    expect(regionForNewOrg).toHaveBeenCalledWith("DE");
    expect(chooseRegionForNewOrg).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: expect.any(String), region: "eu" },
    );
  });
});

describe("when provisioning fails", () => {
  it("rolls the owner back with it, rather than leaving one who lands nowhere", async () => {
    (seedSystemRolesForOrg as jest.Mock).mockRejectedValue(new Error("neon went away"));
    const { service, updates } = buildService();

    await expect(service.register(SIGNUP)).rejects.toThrow("neon went away");

    // The transaction that wrote the owner never commits. (A compensation check
    // may open another afterwards; that one commits nothing either.)
    expect(events.slice(0, 2)).toEqual(["tx:begin", "owner"]);
    expect(events).not.toContain("tx:commit");
    expect(updates.some((patch) => patch["isActive"] === true)).toBe(false);
  });
});

describe("retrying a claim", () => {
  it("finishes the provisioning that did not finish, without a second organisation", async () => {
    const { service, inserted } = buildService({
      existingUser: { id: "user-1", isActive: false, lastActiveOrgId: "org-1" },
      ladder: [],
    });

    await service.register(SIGNUP);

    // The account opens only after the provisioning transaction has committed.
    expect(events).toEqual(["tx:begin", "roles", "modules", "demo", "tx:commit", "activate"]);
    const organisationsWritten = inserted
      .flatMap((statement) => statement.rows)
      .filter(
        (row) => typeof row === "object" && row !== null && "ownerMembershipId" in row,
      );
    expect(organisationsWritten).toHaveLength(0);
  });

  it("does nothing at all for somebody who already has a workspace", async () => {
    const { service, updates } = buildService({
      existingUser: { id: "user-1", isActive: true, lastActiveOrgId: "org-1" },
    });

    await service.register(SIGNUP);

    expect(events).toEqual([]);
    expect(updates).toEqual([]);
  });

  /**
   * The reason the resume is not simply "inactive means unfinished".
   *
   * `/auth/register` is public, so anyone knowing an address could otherwise
   * reactivate an account an administrator had deliberately closed.
   */
  it("will not reactivate an account somebody deliberately deactivated", async () => {
    const { service, updates } = buildService({
      existingUser: { id: "user-1", isActive: false, lastActiveOrgId: "org-1" },
      ladder: [{ id: 3 }],
    });

    await service.register(SIGNUP);

    expect(events).toEqual([]);
    expect(updates.some((patch) => patch["isActive"] === true)).toBe(false);
  });
});
