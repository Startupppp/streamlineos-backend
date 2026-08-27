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

jest.mock("../../common/tenant", () => ({
  withNewOrgInRegion: jest.fn(
    async (_db: unknown, _placement: unknown, body: (tx: unknown) => Promise<unknown>) =>
      body(tx),
  ),
  runWithTenantContext: jest.fn(
    async (_context: unknown, body: () => Promise<unknown>) => body(),
  ),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, body: (tx: unknown) => Promise<unknown>) =>
      body(tx),
  ),
  runInTenantTransaction: jest.fn(
    async (_db: unknown, body: (tx: unknown) => Promise<unknown>) => body(tx),
  ),
}));

jest.mock("../../common/region/region-registry", () => ({
  regionForNewOrg: jest.fn().mockReturnValue("eu"),
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

const tx = {
  execute: jest.fn().mockResolvedValue([{ id: 7 }]),
  insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
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
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation(async (rows: unknown) => {
        inserted.push({ table: "any", rows: Array.isArray(rows) ? rows : [rows] });
      }),
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
    values: jest.fn().mockImplementation(async (rows: unknown) => {
      inserted.push({ table: "tenant", rows: Array.isArray(rows) ? rows : [rows] });
    }),
  }));

  const service = new AuthService(
    db as never,
    {} as never,
    { del: jest.fn().mockResolvedValue(undefined) } as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, db, inserted, updates };
}

const SIGNUP = {
  email: "Founder@Example.com",
  firstName: "Ada",
  lastName: "Byron",
  companyName: "Analytical Engines",
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

describe("a stranger signing up", () => {
  it("is not let in until the workspace has roles, modules and something in it", async () => {
    const { service } = buildService();

    await service.register(SIGNUP);

    expect(events).toEqual(["roles", "modules", "demo", "activate"]);
  });

  it("creates the owner closed, so no sign-in path exists mid-provisioning", async () => {
    const { service, inserted } = buildService();

    await service.register(SIGNUP);

    const userRow = inserted
      .flatMap((statement) => statement.rows)
      .find(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && "emailVerified" in row,
      );

    expect(userRow?.["isActive"]).toBe(false);
  });

  it("gets a workspace with a demo dataset in it", async () => {
    const { service } = buildService();

    await service.register(SIGNUP);

    expect(seedDemoDataset).toHaveBeenCalledTimes(1);
  });
});

describe("when provisioning fails", () => {
  it("leaves an owner who cannot sign in, rather than one who lands nowhere", async () => {
    (seedSystemRolesForOrg as jest.Mock).mockRejectedValue(new Error("neon went away"));
    const { service, updates } = buildService();

    await expect(service.register(SIGNUP)).rejects.toThrow("neon went away");

    expect(updates.some((patch) => patch["isActive"] === true)).toBe(false);
    expect(events).not.toContain("activate");
  });
});

describe("retrying a claim", () => {
  it("finishes the provisioning that did not finish, without a second organisation", async () => {
    const { service, inserted } = buildService({
      existingUser: { id: "user-1", isActive: false, lastActiveOrgId: "org-1" },
      ladder: [],
    });

    await service.register(SIGNUP);

    expect(events).toEqual(["roles", "modules", "demo", "activate"]);
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
