import type { Db } from "../../db/drizzle.module";
import { DirectoryIdentityService } from "./directory-identity.service";

describe("DirectoryIdentityService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(): Db {
    return {
      query: {
        organizationPeople: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        invitations: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
  }

  it("returns empty access list for an empty person input (cross-tenant isolation — scoped to org)", async () => {
    const db = makeDb();
    const svc = new DirectoryIdentityService(db);
    const result = await svc.resolvePeopleAccess(ATTACKER, []);
    expect(result).toHaveLength(0);
  });

  it("resolves access for a person in the owning org (control — same-tenant)", async () => {
    const db = makeDb();
    (db.query as any).organizationMembers.findMany.mockResolvedValue([]);
    (db.query as any).invitations.findFirst.mockResolvedValue(null);
    const svc = new DirectoryIdentityService(db);
    const personRow = {
      id: "person-1", orgId: OWNER, organizationMembershipId: null,
      userId: null, displayName: "Alice", email: "alice@owner.com",
      phone: null, avatarUrl: null, createdAt: new Date(),
    } as any;
    const result = await svc.resolvePeopleAccess(OWNER, [personRow]);
    expect(result).toHaveLength(1);
  });
});
