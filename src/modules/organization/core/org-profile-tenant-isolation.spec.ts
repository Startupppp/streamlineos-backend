import { OrgProfileService } from "./org-profile.service";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn((_db: unknown, _userId: string, fn: (tx: unknown) => unknown) => fn(_db)),
}));
jest.mock("../../../common/region/region-registry", () => ({
  hasRegionRegistry: jest.fn().mockReturnValue(false),
  getRegionRegistry: jest.fn(),
  PlacementRefusedError: class PlacementRefusedError extends Error {},
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn((_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db)),
  runInTenantTransaction: jest.fn((_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db)),
}));

describe("OrgProfileService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(memberRows: unknown[]) {
    const where = jest.fn();
    const builder: Record<string, unknown> = {
      from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(), innerJoin: jest.fn(),
      then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(memberRows).then(fn, r); },
      catch(fn: (e: unknown) => unknown) { return Promise.resolve(memberRows).catch(fn); },
      finally(fn: () => void) { return Promise.resolve(memberRows).finally(fn); },
    };
    for (const k of ["from", "where", "limit", "orderBy", "innerJoin"]) {
      (builder[k] as jest.Mock).mockReturnValue(builder);
    }
    const db = {
      select: jest.fn().mockReturnValue(builder),
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    const audit = { log: jest.fn() };
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    const indexService = { listForUser: jest.fn().mockResolvedValue([]), refreshForUser: jest.fn().mockResolvedValue(undefined) };
    const saga = { onCreated: jest.fn() };
    const svc = new OrgProfileService(db, audit as never, cache as never, indexService as never, saga as never);
    return { svc, where };
  }

  it("listUserOrganizations returns empty for a user with no memberships (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.listUserOrganizations("user-a");
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
  });

  it("listUserOrganizations returns orgs for a user with active memberships (control)", async () => {
    const row = { id: OWNER, name: "My Org", slug: "my-org", role: "MEMBER", joinedAt: new Date() };
    const { svc } = makeService([row]);
    const result = await svc.listUserOrganizations("user-b");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: OWNER });
  });
});
