/**
 * users, accounts and sessions are GLOBAL identity tables — there is no per-row org_id
 * column the way tenant tables have. The isolation invariant here is cross-USER: user A
 * cannot see user B's memberships, because every query filters by userId.
 *
 * The test simulates the RLS row-level outcome: when the DB returns empty (because no
 * matching row exists for the queried userId), the service returns null and does not
 * return data belonging to another user.
 */

import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import type { Db } from "../../db/drizzle.module";

function buildDb(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue(rows);
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue(chain),
  };
  const db = {
    transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
      ),
  } as unknown as Db;
  return { db, chain };
}

describe("AuthMembershipResolverService — cross-user isolation", () => {
  const USER_A = "user-a";
  const USER_B = "user-b";
  const ORG_B = "org-b";

  const userBMembership = {
    orgId: ORG_B,
    isOwner: true,
    role: "OWNER",
    status: "ACTIVE",
    maxConcurrentSessions: null,
    orgOnboardingCompletedAt: null,
  };

  it("returns null when the queried userId has no active memberships (cross-user isolation: user A cannot see user B orgs)", async () => {
    const { db } = buildDb([]);
    const svc = new AuthMembershipResolverService(db, {} as never);

    const result = await svc.resolveActiveMembership(USER_A, null);

    expect(result).toBeNull();
  });

  it("returns the membership for the owning user (control — same-user access works)", async () => {
    const { db } = buildDb([userBMembership]);
    const svc = new AuthMembershipResolverService(db, {} as never);

    const result = await svc.resolveActiveMembership(USER_B, null);

    expect(result).toMatchObject({ orgId: ORG_B, role: "OWNER" });
  });

  it("returns null for a suspended preferred org so recovery context is clear (cross-org state isolation)", async () => {
    const { db } = buildDb([{ ...userBMembership, status: "SUSPENDED" }]);
    const svc = new AuthMembershipResolverService(db, {} as never);

    const result = await svc.resolveActiveMembership(USER_B, ORG_B, {
      honorSuspendedPreference: true,
    });

    expect(result).toBeNull();
  });
});
