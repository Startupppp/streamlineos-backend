import { AccessSnapshotResolver } from "../access-snapshot.resolver";
import type { AccessSnapshot, DataScope } from "../access.types";
import type { EntitlementsService } from "../entitlements.service";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-test";
const USER = "user-test";

const NON_OWNER_CTX: CurrentUserContext = {
  userId: USER,
  orgId: ORG,
  role: "MEMBER",
  permissions: [],
  isOrgOwner: false,
  sessionId: "sess",
  tokenScopes: null,
};

const OWNER_CTX: CurrentUserContext = {
  userId: USER,
  orgId: ORG,
  role: "OWNER",
  permissions: [],
  isOrgOwner: true,
  sessionId: "sess",
  tokenScopes: null,
};

function makeResolver(
  resolveUserPermissions: (orgId: string, userId: string) => Promise<Map<string, DataScope>>,
): AccessSnapshotResolver {
  const entitlements = {
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
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
