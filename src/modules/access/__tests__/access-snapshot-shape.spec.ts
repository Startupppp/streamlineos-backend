import { AccessSnapshotResolver } from "../access-snapshot.resolver";
import type { DataScope } from "../access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  ...overrides,
});

const makeResolver = (resolved: Map<string, DataScope>) =>
  new AccessSnapshotResolver(
    {
      getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
      isCoreModule: () => false,
      buildModuleAvailabilityResolver: () => ({
        isCoreModule: () => false,
        getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
        getUserDeniedModules: async (): Promise<Set<string>> => new Set<string>(),
        getPlanLockedModules: async (): Promise<readonly string[]> => [],
      }),
    } as never,
    { resolve: async () => ({ enforced: false, satisfied: true }) } as never,
    async () => 7,
    async () => resolved,
    async () => new Set<string>(),
    async () => false,
    () => ({
      isCoreModule: () => false,
      getModuleMap: async (): Promise<Record<string, boolean>> => ({}),
      getUserDeniedModules: async (): Promise<Set<string>> => new Set<string>(),
      getPlanLockedModules: async (): Promise<readonly string[]> => [],
    }),
  );

describe("the access snapshot", () => {
  it("carries one representation of what a person may do", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["crm:contacts:view", "team"],
        ["hr:employees:view", "own"],
      ]),
    );

    const snapshot = await resolver.computeAccessSnapshot("org-1", "user-1", makeUser());

    expect(snapshot.scopes).toEqual({
      "crm:contacts:view": "team",
      "hr:employees:view": "own",
    });
    expect(snapshot).not.toHaveProperty("permissions");
  });

  it("omits a permission the person holds at no scope", async () => {
    const resolver = makeResolver(
      new Map<string, DataScope>([
        ["crm:contacts:view", "all"],
        ["crm:contacts:delete", "none"],
      ]),
    );

    const snapshot = await resolver.computeAccessSnapshot("org-1", "user-1", makeUser());

    expect(snapshot.scopes).toEqual({ "crm:contacts:view": "all" });
  });

  it("gives an org owner the whole catalogue as scopes", async () => {
    const resolver = makeResolver(new Map<string, DataScope>());

    const snapshot = await resolver.computeAccessSnapshot(
      "org-1",
      "user-1",
      makeUser({ isOrgOwner: true }),
    );

    expect(Object.keys(snapshot.scopes).length).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty("permissions");
  });
});
