import { AccessSnapshotResolver } from "../access-snapshot.resolver";
import type { AccessSnapshot, DataScope } from "../access.types";
import type { EntitlementsService } from "../entitlements.service";
import { isCoreModuleKey } from "../entitlements.service";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CATALOG_MODULES } from "../access-policy";
import { moduleAvailabilityResolver } from "../../../common/rbac/module-availability";

const ORG = "org-test";
const USER = "user-test";

const NON_OWNER_CTX: CurrentUserContext = {
  userId: USER,
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess",
  tokenScopes: null,
};

const OWNER_CTX: CurrentUserContext = {
  userId: USER,
  orgId: ORG,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "sess",
  tokenScopes: null,
};

function makeResolver(
  resolveUserPermissions: (orgId: string, userId: string) => Promise<Map<string, DataScope>>,
): AccessSnapshotResolver {
  const entitlements = {
    getModuleMap: jest.fn().mockResolvedValue({}),
    isCoreModule: jest.fn((key: string) => isCoreModuleKey(key)),
    buildModuleAvailabilityResolver: jest.fn().mockReturnValue({
      isCoreModule: isCoreModuleKey,
      getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
      getUserDeniedModules: async (): Promise<Set<string>> => new Set<string>(),
      getPlanLockedModules: async (): Promise<readonly string[]> => [],
    }),
  } as unknown as EntitlementsService;

  return new AccessSnapshotResolver(
    entitlements,
    makeMfaPolicyStub(),
    jest.fn().mockResolvedValue(1),
    resolveUserPermissions,
    jest.fn().mockResolvedValue(new Set<string>()),
    jest.fn().mockResolvedValue(false),
  );
}

describe("AccessSnapshotResolver.computeAccessSnapshot — wire shape", () => {
  it("snapshot has no permissions field", async () => {
    const resolver = makeResolver(jest.fn().mockResolvedValue(new Map()));
    const snap: AccessSnapshot = await resolver.computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);
    expect(Object.keys(snap)).not.toContain("permissions");
  });
});

describe("AccessSnapshotResolver.computeAccessSnapshot — non-owner scopes", () => {
  it("a team-scoped key appears in scopes with scope team", async () => {
    const userPerms = new Map<string, DataScope>([["hr:employees:view", "team"]]);
    const resolver = makeResolver(jest.fn().mockResolvedValue(userPerms));
    const snap = await resolver.computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);
    expect(snap.scopes["hr:employees:view"]).toBe("team");
  });

  it("an absent key is not present in scopes", async () => {
    const resolver = makeResolver(jest.fn().mockResolvedValue(new Map()));
    const snap = await resolver.computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);
    expect("hr:employees:view" in snap.scopes).toBe(false);
  });

  it("a none-scoped key is excluded from scopes", async () => {
    const userPerms = new Map<string, DataScope>([["hr:employees:view", "none"]]);
    const resolver = makeResolver(jest.fn().mockResolvedValue(userPerms));
    const snap = await resolver.computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);
    expect("hr:employees:view" in snap.scopes).toBe(false);
  });
});

describe("AccessSnapshotResolver.computeAccessSnapshot — org owner", () => {
  it("org owner receives all catalog keys in scopes without calling resolveUserPermissions", async () => {
    const resolveUserPermissions = jest.fn();
    const resolver = makeResolver(resolveUserPermissions);
    const snap = await resolver.computeAccessSnapshot(ORG, USER, OWNER_CTX);
    expect(Object.keys(snap.scopes).length).toBeGreaterThan(0);
    expect(snap.scopes["hr:employees:view"]).toBeDefined();
    expect(snap.isOrgOwner).toBe(true);
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });
});

describe("AccessSnapshotResolver — module flags", () => {
  const makeFlagResolver = (
    rawMap: Record<string, boolean>,
    denied: Set<string>,
  ) =>
    new AccessSnapshotResolver(
      {
        getModuleMap: jest.fn().mockResolvedValue(rawMap),
        isCoreModule: jest.fn((key: string) => isCoreModuleKey(key)),
        buildModuleAvailabilityResolver: jest.fn().mockImplementation(
          (
            getMap: (orgId: string) => Promise<Record<string, boolean>>,
            getDenied?: (orgId: string, userId: string) => Promise<Set<string>>,
          ) =>
            moduleAvailabilityResolver(
              {
                isCoreModule: isCoreModuleKey,
                getModuleMap: getMap,
                getPlanLockedModules: async (): Promise<readonly string[]> => [],
              },
              getDenied ? { getUserDeniedModules: getDenied } : undefined,
            ),
        ),
      } as unknown as EntitlementsService,
      makeMfaPolicyStub(),
      jest.fn().mockResolvedValue(1),
      jest.fn().mockResolvedValue(new Map<string, DataScope>()),
      jest.fn().mockResolvedValue(denied),
      jest.fn().mockResolvedValue(false),
    );

  it("leaves every core namespace available whatever the module map says", async () => {
    const ungated = CATALOG_MODULES.filter((key) => isCoreModuleKey(key));
    expect(ungated.length).toBeGreaterThan(0);

    const snap = await makeFlagResolver({}, new Set()).computeAccessSnapshot(
      ORG,
      USER,
      NON_OWNER_CTX,
    );

    for (const moduleKey of ungated) expect(snap.modules[moduleKey]).toBe(true);
  });

  it("follows the raw module map for a plan-gated module", async () => {
    const snap = await makeFlagResolver(
      { hr: true, payroll: false },
      new Set(),
    ).computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);

    expect(snap.modules["hr"]).toBe(true);
    expect(snap.modules["payroll"]).toBe(false);
  });

  it("lets a per-user deny remove an enabled plan-gated module", async () => {
    const snap = await makeFlagResolver(
      { hr: true },
      new Set(["hr"]),
    ).computeAccessSnapshot(ORG, USER, NON_OWNER_CTX);

    expect(snap.modules["hr"]).toBe(false);
  });

  it("keeps an enabled plan-gated module for an owner, who carries no denies", async () => {
    const snap = await makeFlagResolver(
      { hr: true },
      new Set(["hr"]),
    ).computeAccessSnapshot(ORG, USER, OWNER_CTX);

    expect(snap.modules["hr"]).toBe(true);
  });
});
