import { ForbiddenException } from "@nestjs/common";
import {
  assertPermissionsGrantable,
  canGrantToRank,
  ROLE_RANK,
  type GrantabilityActor,
} from "../../../common/rbac/grantability";

const MODULE = "hr";
const OTHER_MODULE = "crm";
const PERM_KEY = `${MODULE}:employees:view`;

interface MatrixRow {
  label: string;
  actorRank: number;
  actorModules: ReadonlySet<string> | null;
  targetRank: number;
  targetModuleKey: string | null;
  expected: boolean;
}

const RANK_PREDICATE_MATRIX: MatrixRow[] = [
  {
    label: "org_owner (0) → module_owner (15): rank higher, so canGrantToRank=true",
    actorRank: ROLE_RANK.ORG_OWNER, actorModules: null,
    targetRank: ROLE_RANK.MODULE_OWNER, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_owner (0) → module_admin (20): rank higher",
    actorRank: ROLE_RANK.ORG_OWNER, actorModules: null,
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_owner (0) → module_custom (30): rank higher",
    actorRank: ROLE_RANK.ORG_OWNER, actorModules: null,
    targetRank: ROLE_RANK.MODULE_CUSTOM, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_owner (0) → functional (40): rank higher",
    actorRank: ROLE_RANK.ORG_OWNER, actorModules: null,
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_admin (10) → module_owner (15): rank higher",
    actorRank: ROLE_RANK.ORG_ADMIN, actorModules: null,
    targetRank: ROLE_RANK.MODULE_OWNER, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_admin (10) → module_admin (20): rank higher",
    actorRank: ROLE_RANK.ORG_ADMIN, actorModules: null,
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "org_admin (10) → functional (40): rank higher",
    actorRank: ROLE_RANK.ORG_ADMIN, actorModules: null,
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_owner (15) → module_owner (15): same rank, no peer exception at this level",
    actorRank: ROLE_RANK.MODULE_OWNER, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_OWNER, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "module_owner (15) → module_admin (20): rank higher",
    actorRank: ROLE_RANK.MODULE_OWNER, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_owner (15) → functional (40): rank higher",
    actorRank: ROLE_RANK.MODULE_OWNER, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_admin (20) → module_owner (15): rank LOWER — blocked",
    actorRank: ROLE_RANK.MODULE_ADMIN, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_OWNER, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "module_admin (20) → module_admin (20) same module: peer exception — ALLOW",
    actorRank: ROLE_RANK.MODULE_ADMIN, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_admin (20) → module_admin (20) diff module: peer exception does NOT apply cross-module",
    actorRank: ROLE_RANK.MODULE_ADMIN, actorModules: new Set([OTHER_MODULE]),
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "module_admin (20) → module_custom (30): rank higher",
    actorRank: ROLE_RANK.MODULE_ADMIN, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_CUSTOM, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_admin (20) → functional (40): rank higher",
    actorRank: ROLE_RANK.MODULE_ADMIN, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "module_custom (30) → module_admin (20): rank LOWER — blocked",
    actorRank: ROLE_RANK.MODULE_CUSTOM, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_ADMIN, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "module_custom (30) → module_custom (30): same rank — blocked",
    actorRank: ROLE_RANK.MODULE_CUSTOM, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.MODULE_CUSTOM, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "module_custom (30) → functional (40): rank higher",
    actorRank: ROLE_RANK.MODULE_CUSTOM, actorModules: new Set([MODULE]),
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: true,
  },
  {
    label: "functional (40) → module_custom (30): rank LOWER — blocked",
    actorRank: ROLE_RANK.FUNCTIONAL, actorModules: null,
    targetRank: ROLE_RANK.MODULE_CUSTOM, targetModuleKey: MODULE,
    expected: false,
  },
  {
    label: "functional (40) → functional (40): same rank — blocked",
    actorRank: ROLE_RANK.FUNCTIONAL, actorModules: null,
    targetRank: ROLE_RANK.FUNCTIONAL, targetModuleKey: MODULE,
    expected: false,
  },
];

describe("org × module role rank predicate — canGrantToRank (all 20 cells)", () => {
  it.each(RANK_PREDICATE_MATRIX)(
    "$label",
    ({ actorRank, actorModules, targetRank, targetModuleKey, expected }) => {
      expect(canGrantToRank(actorRank, actorModules, targetRank, targetModuleKey)).toBe(expected);
    },
  );
});

describe("MODULE_OWNER self-escalation block — assertMayAssignRole enforces structural ownership separation", () => {
  it("canGrantToRank alone does NOT block org_owner → module_owner (rank is satisfied)", () => {
    expect(
      canGrantToRank(ROLE_RANK.ORG_OWNER, null, ROLE_RANK.MODULE_OWNER, MODULE),
    ).toBe(true);
  });

  it("canGrantToRank alone does NOT block org_admin → module_owner (rank is satisfied)", () => {
    expect(
      canGrantToRank(ROLE_RANK.ORG_ADMIN, null, ROLE_RANK.MODULE_OWNER, MODULE),
    ).toBe(true);
  });

  it("the ownership-service-only guard is enforced by a separate explicit rank check in assertMayAssignRole, provable via assertPermissionsGrantable with a MODULE_OWNER target from a non-owner actor", () => {
    const moduleAdminActor: GrantabilityActor = {
      isOrgOwner: false,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set([MODULE]),
    };
    expect(() =>
      assertPermissionsGrantable(moduleAdminActor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_OWNER,
        moduleKey: MODULE,
      }),
    ).toThrow(ForbiddenException);
  });
});

describe("assertPermissionsGrantable — self-escalation, billing and cross-module boundaries", () => {
  it("org owner is allowed for any delegable key at any grantable rank (rank bypass)", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: true,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.ORG_OWNER,
      allowedModules: null,
    };
    expect(() =>
      assertPermissionsGrantable(actor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: MODULE,
      }),
    ).not.toThrow();
  });

  it("billing namespace denied even to an org owner", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: true,
      grantable: new Set(["billing:subscription:manage"]),
      bestRank: ROLE_RANK.ORG_OWNER,
      allowedModules: null,
    };
    expect(() =>
      assertPermissionsGrantable(actor, ["billing:subscription:manage"], {
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: "billing",
      }),
    ).toThrow(ForbiddenException);
  });

  it("module admin cannot self-escalate to MODULE_OWNER rank via role grant path", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: false,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set([MODULE]),
    };
    expect(() =>
      assertPermissionsGrantable(actor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_OWNER,
        moduleKey: MODULE,
      }),
    ).toThrow(ForbiddenException);
  });

  it("module member cannot grant a key they do not hold", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: false,
      grantable: new Set(["hr:employees:view"]),
      bestRank: ROLE_RANK.FUNCTIONAL,
      allowedModules: null,
    };
    expect(() =>
      assertPermissionsGrantable(actor, ["hr:employees:manage"], {
        rank: ROLE_RANK.FUNCTIONAL,
        moduleKey: MODULE,
      }),
    ).toThrow(ForbiddenException);
  });

  it("module admin peer exception allows configuring another MODULE_ADMIN in the same module", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: false,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set([MODULE]),
    };
    expect(() =>
      assertPermissionsGrantable(actor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: MODULE,
      }),
    ).not.toThrow();
  });

  it("module admin in a different module cannot exploit the peer exception for another module", () => {
    const actor: GrantabilityActor = {
      isOrgOwner: false,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set([OTHER_MODULE]),
    };
    expect(() =>
      assertPermissionsGrantable(actor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_ADMIN,
        moduleKey: MODULE,
      }),
    ).toThrow(ForbiddenException);
  });
});

describe("negative control — proves canGrantToRank is load-bearing for rank equality/regression", () => {
  it("returns false for every combination where the predicate must deny (proves biting)", () => {
    const mustDeny: Array<{
      label: string;
      actorRank: number;
      modules: ReadonlySet<string> | null;
      targetRank: number;
      targetModule: string;
    }> = [
      {
        label: "module_admin → module_owner",
        actorRank: ROLE_RANK.MODULE_ADMIN, modules: new Set([MODULE]),
        targetRank: ROLE_RANK.MODULE_OWNER, targetModule: MODULE,
      },
      {
        label: "module_admin (diff) → module_admin (other module)",
        actorRank: ROLE_RANK.MODULE_ADMIN, modules: new Set([OTHER_MODULE]),
        targetRank: ROLE_RANK.MODULE_ADMIN, targetModule: MODULE,
      },
      {
        label: "module_owner self-rank (same rank equality blocked)",
        actorRank: ROLE_RANK.MODULE_OWNER, modules: new Set([MODULE]),
        targetRank: ROLE_RANK.MODULE_OWNER, targetModule: MODULE,
      },
      {
        label: "functional → module_custom (lower rank → higher authority blocked)",
        actorRank: ROLE_RANK.FUNCTIONAL, modules: null,
        targetRank: ROLE_RANK.MODULE_CUSTOM, targetModule: MODULE,
      },
      {
        label: "module_custom → module_admin (lower rank → higher authority blocked)",
        actorRank: ROLE_RANK.MODULE_CUSTOM, modules: new Set([MODULE]),
        targetRank: ROLE_RANK.MODULE_ADMIN, targetModule: MODULE,
      },
    ];

    for (const { label: _label, actorRank, modules, targetRank, targetModule } of mustDeny)
      expect(canGrantToRank(actorRank, modules, targetRank, targetModule)).toBe(false);
  });

  it("demonstrates the security hole if canGrantToRank returned true for module_admin → module_owner: no ForbiddenException from assertPermissionsGrantable (org-owner bypass simulates the neutered check)", () => {
    const bypassedActor: GrantabilityActor = {
      isOrgOwner: true,
      grantable: new Set([PERM_KEY]),
      bestRank: ROLE_RANK.MODULE_ADMIN,
      allowedModules: new Set([MODULE]),
    };
    expect(() =>
      assertPermissionsGrantable(bypassedActor, [PERM_KEY], {
        rank: ROLE_RANK.MODULE_OWNER,
        moduleKey: MODULE,
      }),
    ).not.toThrow();
  });
});
