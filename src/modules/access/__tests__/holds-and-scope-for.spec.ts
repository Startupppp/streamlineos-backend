import { AccessService } from "../access.service";
import type { DataScope } from "../access.types";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EntitlementsService } from "../entitlements.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  humanSessionPrincipal,
  personalTokenPrincipal,
} from "../../../common/auth/principal";
import { makeMfaPolicyStub } from "../../../../test/helpers/mfa-policy-stub";

const ORG = "org-1";
const USER = "user-1";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  const merged = {
    userId: USER,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null as string[] | null,
    ...overrides,
  };
  const principal =
    overrides.principal ??
    (merged.tokenScopes === null
      ? humanSessionPrincipal(1, merged.isOrgOwner)
      : personalTokenPrincipal(1, merged.isOrgOwner, "pat-1", merged.tokenScopes));
  return { ...merged, principal };
}

function buildService(resolved: Map<string, DataScope>): {
  service: AccessService;
  resolveSpy: jest.SpyInstance;
} {
  const db = {
    query: {
      accessVersions: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    execute: jest.fn(),
    transaction: jest.fn(),
  } as unknown as Db;

  const cache = {
    cached: jest.fn(),
    invalidate: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
  } as unknown as CacheService;

  const entitlements = {
    isModuleEnabled: jest.fn(),
    isCoreModule: jest.fn().mockReturnValue(false),
  } as unknown as EntitlementsService;

  const service = new AccessService(db, cache, entitlements, makeMfaPolicyStub());
  const resolveSpy = jest
    .spyOn(service, "resolveUserPermissions")
    .mockResolvedValue(resolved);
  return { service, resolveSpy };
}

describe("AccessService.holds — whether a person holds a permission key", () => {
  it("returns true for a key the person holds at a real scope", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "team"]]),
    );
    expect(await service.holds(makeUser(), "crm:leads:view")).toBe(true);
  });

  it("returns false for a key absent from the resolved map", async () => {
    const { service } = buildService(new Map<string, DataScope>());
    expect(await service.holds(makeUser(), "crm:leads:view")).toBe(false);
  });

  it("returns false when the key is present at scope none", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "none"]]),
    );
    expect(await service.holds(makeUser(), "crm:leads:view")).toBe(false);
  });

  it("returns true for an org owner even when the map is empty, without calling resolveUserPermissions", async () => {
    const { service, resolveSpy } = buildService(new Map<string, DataScope>());
    const owner = makeUser({ isOrgOwner: true });

    expect(await service.holds(owner, "hr:employees:view")).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("returns false for a personal token on a non-delegable key even when the map holds it", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["settings:rbac:manage", "all"]]),
    );
    const user = makeUser({ tokenScopes: ["settings:rbac:manage"] });

    expect(await service.holds(user, "settings:rbac:manage")).toBe(false);
  });

  it("returns false for a personal token when the key is absent from tokenScopes even when the map holds it", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "all"]]),
    );
    const user = makeUser({ tokenScopes: ["hr:employees:view"] });

    expect(await service.holds(user, "crm:leads:view")).toBe(false);
  });

  it("returns true for a personal token when the key is delegable and present in both tokenScopes and the map", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "own"]]),
    );
    const user = makeUser({ tokenScopes: ["crm:leads:view"] });

    expect(await service.holds(user, "crm:leads:view")).toBe(true);
  });
});

describe("AccessService.scopeFor — data scope for a permission key", () => {
  it("returns the granted scope for a key the person holds", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "team"]]),
    );
    expect(await service.scopeFor(makeUser(), "crm:leads:view")).toBe("team");
  });

  it("returns none for a key absent from the resolved map", async () => {
    const { service } = buildService(new Map<string, DataScope>());
    expect(await service.scopeFor(makeUser(), "crm:leads:view")).toBe("none");
  });

  it("returns none when the key is present at scope none", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "none"]]),
    );
    expect(await service.scopeFor(makeUser(), "crm:leads:view")).toBe("none");
  });

  it("returns all for an org owner regardless of what the map holds", async () => {
    const { service } = buildService(new Map<string, DataScope>());
    const owner = makeUser({ isOrgOwner: true });

    expect(await service.scopeFor(owner, "hr:employees:view")).toBe("all");
  });

  it("returns none for a personal token on a non-delegable key", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["ownership:org:transfer", "all"]]),
    );
    const user = makeUser({ tokenScopes: ["ownership:org:transfer"] });

    expect(await service.scopeFor(user, "ownership:org:transfer")).toBe("none");
  });

  it("returns the granted scope for a personal token when the key is delegable and present in tokenScopes", async () => {
    const { service } = buildService(
      new Map<string, DataScope>([["crm:leads:view", "own"]]),
    );
    const user = makeUser({ tokenScopes: ["crm:leads:view"] });

    expect(await service.scopeFor(user, "crm:leads:view")).toBe("own");
  });
});
