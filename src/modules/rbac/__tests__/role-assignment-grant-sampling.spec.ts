import { ForbiddenException } from "@nestjs/common";
import { assertMayAssignRole } from "../assert-role-assignment";
import { RoleMemberService } from "../role-member.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";
import {
  isDelegablePermission,
  RESERVED_PROPAGATION_KEYS,
  ROLE_RANK,
} from "../../../common/rbac/grantability";
import { PERMISSIONS } from "../permissions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";

/**
 * `assertMayAssignRole` decides whether an actor may hand a role to somebody by
 * reading that role's grants and checking every one against what the actor may
 * itself confer. It read them under a bare `.limit(500)` with no `ORDER BY`, so
 * on a role holding more than 500 grants the decision was taken on whatever
 * slice the planner happened to return — a different answer was reachable from
 * two identical calls, and any grant outside the slice was never checked.
 *
 * A role with a handful of grants cannot tell a sampled read from a complete
 * one. Every case below therefore builds a role whose grant count crosses the
 * window, and plants the one key the actor may not confer BEYOND it.
 */

const SAFE_KEYS = PERMISSIONS.map((p) => p.name).filter(
  (name) => isDelegablePermission(name) && !RESERVED_PROPAGATION_KEYS.has(name),
);

const TARGET_ROLE = { id: 77, rank: ROLE_RANK.FUNCTIONAL, moduleKey: null };

function actor(): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

interface ReadProbe {
  limit: number | null;
  ordered: boolean;
  rowsReturned: number | null;
}

/**
 * Returns the first `n` rows in insertion order — the friendliest planner an
 * unordered `LIMIT` could have. If a defect still bites under this double it
 * bites under every real plan.
 */
function makeDb(grantKeys: readonly string[], probe: ReadProbe): Db {
  const take = (n: number): Promise<{ permissionKey: string }[]> => {
    probe.limit = n;
    const rows = grantKeys.slice(0, n).map((permissionKey) => ({ permissionKey }));
    probe.rowsReturned = rows.length;
    return Promise.resolve(rows);
  };

  const grantsWhere = {
    orderBy: jest.fn().mockImplementation(() => {
      probe.ordered = true;
      return { limit: jest.fn().mockImplementation(take) };
    }),
    limit: jest.fn().mockImplementation(take),
  };

  const rankRows = [{ rank: ROLE_RANK.ORG_ADMIN, moduleKey: null }];
  const rankWhere = {
    orderBy: jest.fn().mockImplementation(() => ({
      limit: jest.fn().mockResolvedValue(rankRows),
    })),
    limit: jest.fn().mockResolvedValue(rankRows),
  };

  return {
    query: {
      roles: {
        findFirst: jest.fn().mockResolvedValue({
          id: TARGET_ROLE.id,
          orgId: "org-1",
          isSystem: false,
          rank: TARGET_ROLE.rank,
          moduleKey: TARGET_ROLE.moduleKey,
          slug: "CUSTOM_ROLE",
        }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 5, status: "ACTIVE" }),
      },
      principalGroups: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(grantsWhere),
        innerJoin: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue(rankWhere),
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeAccess(held: readonly string[]): AccessService {
  return {
    resolveUserPermissions: jest
      .fn()
      .mockResolvedValue(new Map(held.map((key) => [key, "all"]))),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
  } as unknown as AccessService;
}

function probe(): ReadProbe {
  return { limit: null, ordered: false, rowsReturned: null };
}

beforeEach(() => jest.clearAllMocks());

describe("assertMayAssignRole — the authorization read is complete, not a sample", () => {
  it("has enough catalogued keys to cross the 500-row window (otherwise every case below is vacuous)", () => {
    expect(SAFE_KEYS.length).toBeGreaterThan(600);
  });

  it("refuses a role whose ONLY unheld grant sits past the 500th row", async () => {
    const grantKeys = SAFE_KEYS.slice(0, 600);
    const planted = grantKeys[550];
    expect(planted).toBeDefined();
    const held = grantKeys.filter((key) => key !== planted);
    expect(held).toHaveLength(599);

    const p = probe();
    await expect(
      assertMayAssignRole(makeDb(grantKeys, p), makeAccess(held), actor(), TARGET_ROLE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(p.rowsReturned).toBe(600);
  });

  it("still ALLOWS a 600-grant role the actor may confer in full — the refusal is not a size limit", async () => {
    const grantKeys = SAFE_KEYS.slice(0, 600);
    const p = probe();
    await expect(
      assertMayAssignRole(makeDb(grantKeys, p), makeAccess(grantKeys), actor(), TARGET_ROLE),
    ).resolves.toBeUndefined();
  });

  it("orders the read, so two identical calls cannot disagree", async () => {
    const grantKeys = SAFE_KEYS.slice(0, 600);
    const p = probe();
    await assertMayAssignRole(
      makeDb(grantKeys, p),
      makeAccess(grantKeys),
      actor(),
      TARGET_ROLE,
    );
    expect(p.ordered).toBe(true);
  });

  it("reads past 500 rows — the window may not decide the answer", async () => {
    const grantKeys = SAFE_KEYS.slice(0, 600);
    const p = probe();
    await assertMayAssignRole(
      makeDb(grantKeys, p),
      makeAccess(grantKeys),
      actor(),
      TARGET_ROLE,
    );
    expect(p.limit).toBeGreaterThan(600);
  });

  it("refuses outright rather than deciding on a slice when a role exceeds the evaluable ceiling", async () => {
    const grantKeys = Array.from(
      { length: 6000 },
      (_unused, i) => `hr:synthetic-${String(i).padStart(5, "0")}:view`,
    );
    const p = probe();
    await expect(
      assertMayAssignRole(makeDb(grantKeys, p), makeAccess(grantKeys), actor(), TARGET_ROLE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("RoleMemberService.addRoleMember — the caller inherits the complete read", () => {
  function service(grantKeys: readonly string[], held: readonly string[], p: ReadProbe) {
    return new RoleMemberService(
      makeDb(grantKeys, p),
      { invalidateMany: jest.fn(), invalidate: jest.fn() } as unknown as CacheService,
      {} as unknown as NotificationDispatchService,
      makeAccess(held),
    );
  }

  it("refuses to hand over a role whose unheld grant sits past the 500th row", async () => {
    const grantKeys = SAFE_KEYS.slice(0, 600);
    const planted = grantKeys[550];
    const held = grantKeys.filter((key) => key !== planted);

    await expect(
      service(grantKeys, held, probe()).addRoleMember(actor(), TARGET_ROLE.id, {
        principalType: "user",
        principalId: "other-member",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
