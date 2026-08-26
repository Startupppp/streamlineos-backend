import { ForbiddenException } from "@nestjs/common";
import {
  assertPermissionsGrantable,
  canGrantToRank,
  ROLE_RANK,
  type GrantabilityActor,
} from "../../../common/rbac/grantability";

const GRANTABLE_VIA_PERMISSIONS = [
  ROLE_RANK.MODULE_ADMIN,
  ROLE_RANK.MODULE_CUSTOM,
  ROLE_RANK.FUNCTIONAL,
] as const;

const ALL_MANAGED_RANKS: readonly number[] = [
  ROLE_RANK.MODULE_ADMIN,
  ROLE_RANK.MODULE_CUSTOM,
  ROLE_RANK.FUNCTIONAL,
];

const MODULE = "hr";

interface ActorScenario {
  label: string;
  bestRank: number;
  allowedModules: ReadonlySet<string> | null;
  bypassesRankCheck: boolean;
}

const SCENARIOS: ActorScenario[] = [
  {
    label: "org owner",
    bestRank: ROLE_RANK.ORG_OWNER,
    allowedModules: null,
    bypassesRankCheck: true,
  },
  {
    label: "org admin",
    bestRank: ROLE_RANK.ORG_ADMIN,
    allowedModules: null,
    bypassesRankCheck: true,
  },
  {
    label: "module owner (same module)",
    bestRank: ROLE_RANK.MODULE_OWNER,
    allowedModules: new Set([MODULE]),
    bypassesRankCheck: false,
  },
  {
    label: "module admin (same module)",
    bestRank: ROLE_RANK.MODULE_ADMIN,
    allowedModules: new Set([MODULE]),
    bypassesRankCheck: false,
  },
  {
    label: "module admin (different module)",
    bestRank: ROLE_RANK.MODULE_ADMIN,
    allowedModules: new Set(["crm"]),
    bypassesRankCheck: false,
  },
  {
    label: "functional member",
    bestRank: ROLE_RANK.FUNCTIONAL,
    allowedModules: null,
    bypassesRankCheck: false,
  },
];

function grantableRanksFromPredicate(scenario: ActorScenario): number[] {
  if (scenario.bypassesRankCheck) return [...GRANTABLE_VIA_PERMISSIONS];
  return GRANTABLE_VIA_PERMISSIONS.filter(rank =>
    canGrantToRank(scenario.bestRank, scenario.allowedModules, rank, MODULE),
  );
}

function buildGrantabilityActor(
  scenario: ActorScenario,
  grantable: ReadonlySet<string>,
): GrantabilityActor {
  return {
    isOrgOwner: scenario.bestRank === ROLE_RANK.ORG_OWNER,
    grantable,
    bestRank: scenario.bestRank,
    allowedModules: scenario.allowedModules,
  };
}

const DUMMY_PERM_KEY = `${MODULE}:employees:view`;
const ORG_ADMIN_KEY = "settings:manage";

describe("standing-grantability agreement — canGrantToRank is the shared predicate", () => {
  for (const scenario of SCENARIOS) {
    describe(`actor: ${scenario.label}`, () => {
      const expectedGrantable = grantableRanksFromPredicate(scenario);
      const nonGrantable = ALL_MANAGED_RANKS.filter(r => !expectedGrantable.includes(r));

      it("describeGrantable matches canGrantToRank for every manageable rank", () => {
        for (const rank of ALL_MANAGED_RANKS) {
          const readSideOffers = expectedGrantable.includes(rank);
          const predicateSays = scenario.bypassesRankCheck
            ? true
            : canGrantToRank(scenario.bestRank, scenario.allowedModules, rank, MODULE);
          expect(readSideOffers).toBe(predicateSays);
        }
      });

      for (const rank of expectedGrantable) {
        it(`write path accepts rank ${rank} that describeGrantable offers`, () => {
          const grantable = scenario.bypassesRankCheck
            ? new Set([DUMMY_PERM_KEY, ORG_ADMIN_KEY])
            : new Set([DUMMY_PERM_KEY]);
          const actor = buildGrantabilityActor(scenario, grantable);
          expect(() =>
            assertPermissionsGrantable(actor, [DUMMY_PERM_KEY], { rank, moduleKey: MODULE }),
          ).not.toThrow();
        });
      }

      for (const rank of nonGrantable) {
        it(`write path refuses rank ${rank} that describeGrantable omits`, () => {
          const grantable = scenario.bypassesRankCheck
            ? new Set([DUMMY_PERM_KEY, ORG_ADMIN_KEY])
            : new Set([DUMMY_PERM_KEY]);
          const actor = buildGrantabilityActor(scenario, grantable);
          expect(() =>
            assertPermissionsGrantable(actor, [DUMMY_PERM_KEY], { rank, moduleKey: MODULE }),
          ).toThrow(ForbiddenException);
        });
      }
    });
  }

  describe("peer-MODULE_ADMIN exception", () => {
    it("a module admin may configure a MODULE_ADMIN role in the SAME module", () => {
      expect(
        canGrantToRank(
          ROLE_RANK.MODULE_ADMIN,
          new Set([MODULE]),
          ROLE_RANK.MODULE_ADMIN,
          MODULE,
        ),
      ).toBe(true);
    });

    it("a module admin may NOT configure a MODULE_ADMIN role in a DIFFERENT module", () => {
      expect(
        canGrantToRank(
          ROLE_RANK.MODULE_ADMIN,
          new Set(["crm"]),
          ROLE_RANK.MODULE_ADMIN,
          MODULE,
        ),
      ).toBe(false);
    });

    it("a module admin may NOT configure a MODULE_OWNER role even in the same module", () => {
      expect(
        canGrantToRank(
          ROLE_RANK.MODULE_ADMIN,
          new Set([MODULE]),
          ROLE_RANK.MODULE_OWNER,
          MODULE,
        ),
      ).toBe(false);
    });
  });

  describe("scope ceiling is the write path's ceiling for the same actor", () => {
    it("an org owner bypasses both rank and scope checks", () => {
      const actor: GrantabilityActor = {
        isOrgOwner: true,
        grantable: new Set([DUMMY_PERM_KEY]),
        bestRank: ROLE_RANK.ORG_OWNER,
        allowedModules: null,
      };
      expect(() =>
        assertPermissionsGrantable(actor, [DUMMY_PERM_KEY], {
          rank: ROLE_RANK.MODULE_ADMIN,
          moduleKey: MODULE,
        }),
      ).not.toThrow();
    });

    it("a module admin is refused MODULE_OWNER", () => {
      const actor: GrantabilityActor = {
        isOrgOwner: false,
        grantable: new Set([DUMMY_PERM_KEY]),
        bestRank: ROLE_RANK.MODULE_ADMIN,
        allowedModules: new Set([MODULE]),
      };
      expect(() =>
        assertPermissionsGrantable(actor, [DUMMY_PERM_KEY], {
          rank: ROLE_RANK.MODULE_OWNER,
          moduleKey: MODULE,
        }),
      ).toThrow(ForbiddenException);
    });
  });
});
