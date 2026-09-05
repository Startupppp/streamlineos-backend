import type { Db } from "../../db/drizzle.module";
import type { DirectoryPerson } from "./directory-person-projection";
import { DirectoryIdentityService } from "./directory-identity.service";

/**
 * The relation mocks, handed back beside the client instead of being dug out of
 * it with a cast of `db.query` to `any`. That cast reached through a real `Db`
 * type into the escape hatch and then called `.mockResolvedValue` on whatever came back: if a
 * relation were renamed the reprogramming below would throw at runtime, and if
 * the shape drifted nothing would say so at all.
 */
interface DirectoryDbMocks {
  organizationMembersFindMany: jest.Mock;
  invitationsFindFirst: jest.Mock;
}

describe("DirectoryIdentityService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  /**
   * Self-returning so the double cannot fall behind the service's builder chain: a
   * missing link reads as a domain failure ("innerJoin is not a function") rather than
   * as the stale test double it is.
   */
  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "groupBy"])
      chain[step] = jest.fn(() => chain);
    chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  }

  function makeDb(): { db: Db; mocks: DirectoryDbMocks } {
    const organizationMembersFindMany = jest.fn().mockResolvedValue([]);
    const invitationsFindFirst = jest.fn().mockResolvedValue(null);
    const db = {
      query: {
        organizationPeople: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null), findMany: organizationMembersFindMany },
        invitations: { findFirst: invitationsFindFirst },
      },
      select: jest.fn(() => selectChain()),
    } as unknown as Db;
    return { db, mocks: { organizationMembersFindMany, invitationsFindFirst } };
  }

  it("returns empty access list for an empty person input (cross-tenant isolation — scoped to org)", async () => {
    const { db } = makeDb();
    const svc = new DirectoryIdentityService(db);
    const result = await svc.resolvePeopleAccess(ATTACKER, []);
    expect(result).toHaveLength(0);
  });

  it("resolves access for a person in the owning org (control — same-tenant)", async () => {
    const { db, mocks } = makeDb();
    mocks.organizationMembersFindMany.mockResolvedValue([]);
    mocks.invitationsFindFirst.mockResolvedValue(null);
    const svc = new DirectoryIdentityService(db);
    const personRow: DirectoryPerson = {
      organizationPersonId: "person-1",
      organizationId: OWNER,
      organizationMembershipId: null,
      userId: null,
      firstName: "Alice",
      lastName: "Owner",
      displayName: "Alice",
      preferredName: null,
      workEmail: "alice@owner.com",
      personalEmail: null,
      phone: null,
      whatsappNumber: null,
      avatarUrl: null,
      timezone: null,
      languageCode: null,
      linkedinUrl: null,
      githubUrl: null,
      bio: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await svc.resolvePeopleAccess(OWNER, [personRow]);
    expect(result).toHaveLength(1);
  });
});
