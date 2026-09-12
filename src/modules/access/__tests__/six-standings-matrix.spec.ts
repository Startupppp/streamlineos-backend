import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { PLATFORM_ONLY_PERMISSION_KEYS, isDelegablePermission } from "../../../common/rbac/grantability";
import type { Db } from "../../../db/drizzle.module";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { moduleScopedPermissions } from "../../rbac/permissions";

const ORG_A = "org-standing-a";
const ORG_B = "org-standing-b";
const USER = "u-standing";

const HR_VIEW = "hr:employees:view";
const HR_MANAGE = "hr:employees:manage";

type StandingRow = {
  isOwner?: boolean;
  status?: string;
  role?: string;
  id?: number | null;
};

type QueueEntry = unknown[] | undefined;

function buildResolver(standing: StandingRow, queue: QueueEntry[]): AccessPermissionResolver {
  let cursor = 0;
  const makeChain = () => {
    const link: Record<string, unknown> = {};
    link["from"] = () => link;
    link["innerJoin"] = () => link;
    link["leftJoin"] = () => link;
    link["where"] = () => link;
    link["orderBy"] = () => link;
    link["limit"] = () => Promise.resolve(queue[cursor++] ?? []);
    return link;
  };

  const db = {
    query: {},
    select: () => makeChain(),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({
      isOwner: standing.isOwner ?? false,
      status: standing.status ?? "ACTIVE",
      id: standing.id ?? 42,
      role: standing.role ?? ORG_MEMBER_ROLES.MEMBER,
    }),
  );
}

function emptyMemberQueue(): QueueEntry[] {
  return [
    [],
    [],
    [],
    [],
    [],
  ];
}

const ORG_OWNER_STANDING: StandingRow = { isOwner: true, status: "ACTIVE", id: 1, role: "OWNER" };
const ORG_ADMIN_STANDING: StandingRow = { isOwner: false, status: "ACTIVE", id: 2, role: ORG_MEMBER_ROLES.ORG_ADMIN };
const MODULE_OWNER_STANDING: StandingRow = { isOwner: false, status: "ACTIVE", id: 3, role: ORG_MEMBER_ROLES.MEMBER };
const MEMBER_STANDING: StandingRow = { isOwner: false, status: "ACTIVE", id: 4, role: ORG_MEMBER_ROLES.MEMBER };
const SUSPENDED_STANDING: StandingRow = { isOwner: false, status: "SUSPENDED", id: 5, role: ORG_MEMBER_ROLES.MEMBER };
const NO_MEMBERSHIP_STANDING: StandingRow = { isOwner: false, status: "INACTIVE", id: null, role: ORG_MEMBER_ROLES.MEMBER };

const universalKeys = new Set(EMPLOYEE_SELF_SERVICE_GRANTS.map((g) => g.permissionKey));

describe("Standing 1 — org owner receives the full catalog in both orgs", () => {
  it("holds every catalog key at all scope in org A (isOrgOwner=true is the structural fact)", async () => {
    const resolver = buildResolver(ORG_OWNER_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
    expect(perms[HR_MANAGE]).toBe("all");
    expect(perms["settings:manage"]).toBe("all");
    expect(perms["crm:leads:view"]).toBe("all");
  });

  it("does NOT hold platform-only keys that administer vendor-owned content", async () => {
    const resolver = buildResolver(ORG_OWNER_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    for (const key of PLATFORM_ONLY_PERMISSION_KEYS) {
      expect(perms[key]).toBeUndefined();
    }
  });

  it("the same user in org B sees the same structural grant without cross-org bleed", async () => {
    const resolverA = buildResolver(ORG_OWNER_STANDING, emptyMemberQueue());
    const resolverB = buildResolver(ORG_OWNER_STANDING, emptyMemberQueue());
    const a = (await resolverA.computeUserPermissions(ORG_A, USER, 1)).perms;
    const b = (await resolverB.computeUserPermissions(ORG_B, USER, 1)).perms;
    expect(a[HR_VIEW]).toBe("all");
    expect(b[HR_VIEW]).toBe("all");
  });
});

describe("Standing 2 — org admin receives the full catalog, not isOrgOwner=true, and cannot transfer org ownership", () => {
  it("holds every catalog key at all scope (short-circuit via ORG_ADMIN role, isOrgOwner=false)", async () => {
    const resolver = buildResolver(ORG_ADMIN_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
    expect(perms[HR_MANAGE]).toBe("all");
    expect(perms["settings:manage"]).toBe("all");
  });

  it("the short-circuit is via role, not isOwner — confirmed by isOwner=false on the membership row", async () => {
    const resolver = buildResolver(ORG_ADMIN_STANDING, emptyMemberQueue());
    const state = await resolver.getMembershipAccessState(ORG_A, USER, 1);
    expect(state.isOwnerOrAdmin).toBe(true);
    expect(state.active).toBe(true);
  });

  it("the test is not vacuous — demoting to MEMBER drops the short-circuit (isOrgOwner=false throughout)", async () => {
    const demoted: StandingRow = { isOwner: false, status: "ACTIVE", id: 2, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(demoted, emptyMemberQueue());
    const state = await resolver.getMembershipAccessState(ORG_A, USER, 1);
    expect(state.isOwnerOrAdmin).toBe(false);
  });
});

describe("Standing 3 — module owner holds the owned module's keys, not the org catalog", () => {
  function buildModuleOwnerResolver(moduleKey: string): AccessPermissionResolver {
    const queue: QueueEntry[] = [
      [],
      [],
      [{ moduleKey }],
      [],
      [],
    ];
    return buildResolver(MODULE_OWNER_STANDING, queue);
  }

  it("receives every hr: key at all scope for the hr module (isOrgOwner=false)", async () => {
    const resolver = buildModuleOwnerResolver("hr");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    const hrKeys = moduleScopedPermissions("hr").filter(isDelegablePermission);
    for (const key of hrKeys) {
      expect({ key, scope: perms[key] }).toMatchObject({ key, scope: "all" });
    }
  });

  it("does NOT hold settings:manage, which is an org-only key not granted through ownership expansion", async () => {
    const resolver = buildModuleOwnerResolver("hr");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms["settings:manage"]).toBeUndefined();
  });

  it("does NOT hold crm: keys from a different module (isOrgOwner=false)", async () => {
    const resolver = buildModuleOwnerResolver("hr");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms["crm:leads:view"]).toBeUndefined();
  });

  it("org role is MEMBER — the isOwner path is never taken, so the test is not vacuous", async () => {
    const resolver = buildModuleOwnerResolver("hr");
    const state = await resolver.getMembershipAccessState(ORG_A, USER, 1);
    expect(state.isOwnerOrAdmin).toBe(false);
  });
});

describe("Standing 4 — module admin holds their role's grants, not the full catalog", () => {
  function buildModuleAdminResolver(
    permissionKey: string,
    scope: string,
  ): AccessPermissionResolver {
    const queue: QueueEntry[] = [
      [{ roleId: 1, expiresAt: null }],
      [],
      [],
      [],
      [{ id: 1, slug: "HR_MODULE_ADMIN" }],
      [{ roleId: 1, permissionKey, scope }],
      [],
    ];
    return buildResolver(MEMBER_STANDING, queue);
  }

  it("carries the key at the granted scope (isOrgOwner=false on the member row)", async () => {
    const resolver = buildModuleAdminResolver(HR_VIEW, "all");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });

  it("does NOT carry a key absent from the role (isOrgOwner=false, not a short-circuit)", async () => {
    const resolver = buildModuleAdminResolver(HR_VIEW, "all");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_MANAGE]).toBeUndefined();
  });

  it("owns only the granted scope — a narrower scope does not widen to all", async () => {
    const resolver = buildModuleAdminResolver(HR_VIEW, "own");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("own");
  });
});

describe("Standing 4b — capability path: permission group", () => {
  function buildGroupMemberResolver(permissionKey: string): AccessPermissionResolver {
    const queue: QueueEntry[] = [
      [],
      [{ principalGroupId: 1 }],
      [],
      [],
      [{ roleId: 2 }],
      [{ id: 2, slug: "HR_MODULE_MEMBER" }],
      [{ roleId: 2, permissionKey, scope: "all" }],
      [],
    ];
    return buildResolver(MEMBER_STANDING, queue);
  }

  it("resolves a key granted through a principal group's role assignment (isOrgOwner=false)", async () => {
    const resolver = buildGroupMemberResolver(HR_VIEW);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });

  it("does NOT hold a key absent from the group's role (group path is not a full-catalog shortcut)", async () => {
    const resolver = buildGroupMemberResolver(HR_VIEW);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_MANAGE]).toBeUndefined();
  });
});

describe("Standing 4c — capability path: per-person user_permission_grants", () => {
  function buildPersonalGrantResolver(permissionKey: string, scope: string): AccessPermissionResolver {
    const queue: QueueEntry[] = [
      [],
      [],
      [],
      [{ id: "uuid-grant-1", permissionKey, scope }],
      [],
    ];
    return buildResolver(MEMBER_STANDING, queue);
  }

  it("resolves a key attached directly to the person, with no role needed (isOrgOwner=false)", async () => {
    const resolver = buildPersonalGrantResolver(HR_VIEW, "all");
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });

  it("a per-person grant survives a role change — the grant hangs off the person", async () => {
    const withRole: QueueEntry[] = [
      [{ roleId: 1, expiresAt: null }],
      [],
      [],
      [{ id: "uuid-g-1", permissionKey: HR_VIEW, scope: "all" }],
      [{ id: 1, slug: "HR_MODULE_MEMBER" }],
      [],
      [],
    ];
    const withoutRole: QueueEntry[] = [
      [],
      [],
      [],
      [{ id: "uuid-g-1", permissionKey: HR_VIEW, scope: "all" }],
      [],
    ];

    const resolverWith = buildResolver(MEMBER_STANDING, withRole);
    const resolverWithout = buildResolver(MEMBER_STANDING, withoutRole);

    const permsWith = (await resolverWith.computeUserPermissions(ORG_A, USER, 1)).perms;
    const permsWithout = (await resolverWithout.computeUserPermissions(ORG_A, USER, 1)).perms;

    expect(permsWith[HR_VIEW]).toBe("all");
    expect(permsWithout[HR_VIEW]).toBe("all");
  });
});

describe("Standing 4d — capability path: expiring user_delegations", () => {
  const NOW = new Date();
  const PAST = new Date(NOW.getTime() - 60_000);
  const FUTURE = new Date(NOW.getTime() + 3_600_000);
  const EXPIRED = new Date(NOW.getTime() - 1_000);

  function buildDelegationResolver(
    permissionKey: string,
    startsAt: Date,
    endsAt: Date,
  ): AccessPermissionResolver {
    const queue: QueueEntry[] = [
      [],
      [],
      [],
      [],
      [{ delegationId: "d-1", permissionKey, startsAt, endsAt }],
    ];
    return buildResolver(MEMBER_STANDING, queue);
  }

  it("resolves a key delivered via an active delegation (isOrgOwner=false)", async () => {
    const resolver = buildDelegationResolver(HR_VIEW, PAST, FUTURE);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });

  it("drops a not-yet-started delegation — the resolver guards startsAt in-process", async () => {
    const FUTURE_START = new Date(NOW.getTime() + 60_000);
    const queue: QueueEntry[] = [
      [],
      [],
      [],
      [],
      [{ delegationId: "d-2", permissionKey: HR_VIEW, startsAt: FUTURE_START, endsAt: FUTURE }],
    ];
    const resolver = buildResolver(MEMBER_STANDING, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBeUndefined();
  });
});

describe("Standing 5 — org/module member holds only universal grants", () => {
  it("carries the universal member grants but no module-admin permissions (isOrgOwner=false)", async () => {
    const resolver = buildResolver(MEMBER_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
      expect(perms[grant.permissionKey]).toBeDefined();
    }
    expect(perms[HR_MANAGE]).toBeUndefined();
    expect(perms["settings:manage"]).toBeUndefined();
  });

  it("the empty-queue test is not vacuous — a member in org B gets the same universal set", async () => {
    const resolverA = buildResolver(MEMBER_STANDING, emptyMemberQueue());
    const resolverB = buildResolver(MEMBER_STANDING, emptyMemberQueue());
    const permsA = (await resolverA.computeUserPermissions(ORG_A, USER, 1)).perms;
    const permsB = (await resolverB.computeUserPermissions(ORG_B, USER, 1)).perms;
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
      expect(permsA[grant.permissionKey]).toBeDefined();
      expect(permsB[grant.permissionKey]).toBeDefined();
    }
  });
});

describe("Standing 6 — suspended or nonmember receives nothing", () => {
  it("suspended member: empty result, no universal grants, no role grants (isOrgOwner=false)", async () => {
    const resolver = buildResolver(SUSPENDED_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms).toEqual({});
    for (const key of universalKeys) {
      expect(perms[key]).toBeUndefined();
    }
  });

  it("nonmember (null membershipId, inactive): empty result (isOrgOwner=false)", async () => {
    const resolver = buildResolver(NO_MEMBERSHIP_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms).toEqual({});
  });

  it("getMembershipAccessState: suspended is inactive, not isOwnerOrAdmin", async () => {
    const resolver = buildResolver(SUSPENDED_STANDING, emptyMemberQueue());
    const state = await resolver.getMembershipAccessState(ORG_A, USER, 1);
    expect(state.active).toBe(false);
    expect(state.isOwnerOrAdmin).toBe(false);
  });
});

describe("AB-05 eight transitions", () => {
  it("T1 newly created owner: isOwner flag alone confers the full catalog immediately", async () => {
    const newOwner: StandingRow = { isOwner: true, status: "ACTIVE", id: 10, role: "OWNER" };
    const resolver = buildResolver(newOwner, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
    expect(perms["settings:manage"]).toBe("all");
  });

  it("T2 owner transfer: former owner losing isOwner drops the structural grant", async () => {
    const formerOwner: StandingRow = { isOwner: false, status: "ACTIVE", id: 10, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(formerOwner, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms["settings:manage"]).toBeUndefined();
    expect(perms[HR_MANAGE]).toBeUndefined();
  });

  it("T2 owner transfer: new owner gaining isOwner=true gets the full catalog", async () => {
    const newOwner: StandingRow = { isOwner: true, status: "ACTIVE", id: 11, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(newOwner, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms["settings:manage"]).toBe("all");
  });

  it("T3 admin demotion: role change from ORG_ADMIN to MEMBER drops the admin catalog (isOrgOwner=false)", async () => {
    const demoted: StandingRow = { isOwner: false, status: "ACTIVE", id: 2, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(demoted, emptyMemberQueue());
    const state = await resolver.getMembershipAccessState(ORG_A, USER, 1);
    expect(state.isOwnerOrAdmin).toBe(false);
    const { perms } = await buildResolver(demoted, emptyMemberQueue()).computeUserPermissions(ORG_A, USER, 1);
    expect(perms["settings:manage"]).toBeUndefined();
  });

  it("T4 module-owner transfer: former module owner losing ownership row gets no module keys", async () => {
    const formerModuleOwner: StandingRow = { isOwner: false, status: "ACTIVE", id: 3, role: ORG_MEMBER_ROLES.MEMBER };
    const queue: QueueEntry[] = [[], [], [], [], []];
    const resolver = buildResolver(formerModuleOwner, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBeUndefined();
    expect(perms[HR_MANAGE]).toBeUndefined();
  });

  it("T4 module-owner transfer: new module owner gaining ownership row gets the module's keys", async () => {
    const newModuleOwner: StandingRow = { isOwner: false, status: "ACTIVE", id: 12, role: ORG_MEMBER_ROLES.MEMBER };
    const queue: QueueEntry[] = [[], [], [{ moduleKey: "hr" }], [], []];
    const resolver = buildResolver(newModuleOwner, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });

  it("T5 module-admin removal: losing role assignment drops the module grants", async () => {
    const demoted: StandingRow = { isOwner: false, status: "ACTIVE", id: 4, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(demoted, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_MANAGE]).toBeUndefined();
  });

  it("T6 ordinary member: only universal grants, no module permissions (isOrgOwner=false)", async () => {
    const resolver = buildResolver(MEMBER_STANDING, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
      expect(perms[grant.permissionKey]).toBeDefined();
    }
    expect(perms[HR_MANAGE]).toBeUndefined();
  });

  it("T7 invited-but-not-accepted: inactive membership resolves to empty (isOrgOwner=false)", async () => {
    const invited: StandingRow = { isOwner: false, status: "INACTIVE", id: null, role: ORG_MEMBER_ROLES.MEMBER };
    const resolver = buildResolver(invited, emptyMemberQueue());
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms).toEqual({});
  });

  it("T8 removed-then-rejoined: after removal (inactive) gets nothing; after rejoin (active) gets universal grants", async () => {
    const removed: StandingRow = { isOwner: false, status: "INACTIVE", id: null };
    const rejoined: StandingRow = { isOwner: false, status: "ACTIVE", id: 20, role: ORG_MEMBER_ROLES.MEMBER };

    const removedResolver = buildResolver(removed, emptyMemberQueue());
    const rejoinedResolver = buildResolver(rejoined, emptyMemberQueue());

    const removedPerms = (await removedResolver.computeUserPermissions(ORG_A, USER, 1)).perms;
    const rejoinedPerms = (await rejoinedResolver.computeUserPermissions(ORG_A, USER, 1)).perms;

    expect(removedPerms).toEqual({});
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
      expect(rejoinedPerms[grant.permissionKey]).toBeDefined();
    }
  });
});

describe("billing: namespace cannot be delegated by anyone below org owner/admin", () => {
  it("a billing: key seated by a personal grant is dropped as org-only (membership role=MEMBER, isOwner=false)", async () => {
    const queue: QueueEntry[] = [
      [],
      [],
      [],
      [{ id: "uuid-b-1", permissionKey: "billing:invoices:view", scope: "all" }],
      [],
    ];
    const resolver = buildResolver(MEMBER_STANDING, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms["billing:invoices:view"]).toBeUndefined();
  });

  it("reads the denied set dynamically so new billing keys added by LANE-C are also barred", async () => {
    const billingKeys = [
      "billing:invoices:view",
      "billing:subscription:manage",
      "billing:promotions:view",
      "billing:promotions:manage",
    ];
    const queue: QueueEntry[] = [
      [],
      [],
      [],
      billingKeys.map((permissionKey, idx) => ({
        id: `uuid-billing-${idx}`,
        permissionKey,
        scope: "all",
      })),
      [],
    ];
    const resolver = buildResolver(MEMBER_STANDING, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    for (const key of billingKeys) {
      expect(perms[key]).toBeUndefined();
    }
  });
});

describe("none grant in the union is not a deny-override — it does not strip a broader grant", () => {
  it("a role grant of all and a personal grant of none resolves to all, not none", async () => {
    const queue: QueueEntry[] = [
      [{ roleId: 1, expiresAt: null }],
      [],
      [],
      [{ id: "uuid-pg-1", permissionKey: HR_VIEW, scope: "none" }],
      [{ id: 1, slug: "HR_MODULE_MEMBER" }],
      [{ roleId: 1, permissionKey: HR_VIEW, scope: "all" }],
      [],
    ];
    const resolver = buildResolver(MEMBER_STANDING, queue);
    const { perms } = await resolver.computeUserPermissions(ORG_A, USER, 1);
    expect(perms[HR_VIEW]).toBe("all");
  });
});

describe("two-org isolation: standing in org A does not bleed to org B", () => {
  it("a module owner in org A holds no keys when the same user has no ownership in org B", async () => {
    const modOwnerQueue: QueueEntry[] = [[], [], [{ moduleKey: "hr" }], [], []];
    const plainMemberQueue: QueueEntry[] = [[], [], [], [], []];

    const orgA = buildResolver(MODULE_OWNER_STANDING, modOwnerQueue);
    const orgB = buildResolver(MEMBER_STANDING, plainMemberQueue);

    const permsA = (await orgA.computeUserPermissions(ORG_A, USER, 1)).perms;
    const permsB = (await orgB.computeUserPermissions(ORG_B, USER, 1)).perms;

    expect(permsA[HR_VIEW]).toBe("all");
    expect(permsB[HR_VIEW]).toBeUndefined();
  });

  it("an org admin in org A does not automatically become an org admin in org B", async () => {
    const orgAAdmin = buildResolver(ORG_ADMIN_STANDING, emptyMemberQueue());
    const orgBMember = buildResolver(MEMBER_STANDING, emptyMemberQueue());

    const stateA = await orgAAdmin.getMembershipAccessState(ORG_A, USER, 1);
    const stateB = await orgBMember.getMembershipAccessState(ORG_B, USER, 1);

    expect(stateA.isOwnerOrAdmin).toBe(true);
    expect(stateB.isOwnerOrAdmin).toBe(false);
  });
});
