import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";
import { AuthContextFactory } from "../../../common/auth/auth-context.factory";
import { JwtKeyringService } from "../../../common/auth/jwt-keyring.service";
import { personalTokenPrincipal } from "../../../common/auth/principal";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { MfaGuard } from "../../../common/auth/mfa.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleDisabledException } from "../../../common/http/api-exceptions";
import type { JwtKeyringService } from "../../../common/auth/jwt-keyring.service";
import type { MembershipStateService } from "../../../common/auth/membership-state.service";
import type { IMfaPolicy } from "../../../common/auth/mfa-policy.token";
import type { AuthContext } from "../../../common/auth/auth-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ModuleAvailabilityResult } from "../../../common/rbac/module-availability";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../access.service";
import { AccessVersionCache } from "../access-version-cache";
import type { EntitlementsService } from "../entitlements.service";
import type { MfaPolicyService } from "../mfa-policy.service";
import { PermissionGuard } from "../permission.guard";
import { RequirePermission } from "../require-permission.decorator";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";

const ORG = "org-composition";
const USER = "user-composition";
const TOKEN = "Bearer composed.jwt.token";
const KEY = "hr:employees:view";
const OTHER_KEY = "hr:leaves:view";
const MEMBERSHIP_ID = 5;

class ProbeController {
  @RequirePermission(KEY)
  @RequireModule("hr")
  read(): void {}

  @AllowNoOrg()
  account(): void {}
}

interface StackOptions {
  active?: boolean;
  role?: string;
  accountActive?: boolean;
  mfa?: { enforced: boolean; satisfied: boolean };
  available?: ModuleAvailabilityResult;
  moduleLookupRejects?: boolean;
  orgIdInToken?: string;
  keyring?: JwtKeyringService;
}

async function keyringWithGeneratedKey(): Promise<JwtKeyringService> {
  const pair = generateKeyPairSync("ed25519");
  const previous = process.env.AUTH_SIGNING_KEYS;
  process.env.AUTH_SIGNING_KEYS = JSON.stringify([
    {
      kid: "composition-key",
      privateKey: await exportJWK(pair.privateKey),
      publicKey: await exportJWK(pair.publicKey),
    },
  ]);
  const keyring = new JwtKeyringService();
  try {
    await keyring.onModuleInit();
  } finally {
    if (previous === undefined) delete process.env.AUTH_SIGNING_KEYS;
    else process.env.AUTH_SIGNING_KEYS = previous;
  }
  return keyring;
}

function makeDb(): Db {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"])
    chain[method] = () => chain;
  chain["limit"] = () => Promise.resolve([]);
  chain["then"] = (resolve: (value: unknown) => unknown) => resolve([]);
  const db: Record<string, unknown> = {
    query: {
      accessVersions: { findFirst: async () => ({ permissionsVersion: 1 }) },
    },
    select: () => chain,
    execute: async () => undefined,
  };
  db["transaction"] = (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db as unknown as Db;
}

function makeCache(): CacheService {
  const local = new Map<string, unknown>();
  return {
    cached: async (_key: string, fill: () => Promise<unknown>) => fill(),
    cachedForOrg: async (_o: string, _k: string, fill: () => Promise<unknown>) => fill(),
    cachedForOrgWith: async (o: string, k: string, fill: () => Promise<unknown>) => {
      const composed = `${o}:${k}`;
      if (local.has(composed)) return local.get(composed);
      const value = await fill();
      local.set(composed, value);
      return value;
    },
    get: async () => null,
    set: async () => undefined,
    invalidate: async () => undefined,
    invalidateForOrg: async () => undefined,
    invalidateNamespace: async () => undefined,
  } as unknown as CacheService;
}

function buildStack(options: StackOptions = {}) {
  const {
    active = true,
    role = ORG_MEMBER_ROLES.ORG_ADMIN,
    accountActive = true,
    mfa = { enforced: false, satisfied: true },
    available = { available: true } as ModuleAvailabilityResult,
    moduleLookupRejects = false,
    orgIdInToken = ORG,
    keyring: keyringOverride,
  } = options;

  const resolve = jest.fn(async () => ({
    active,
    isOwner: false,
    role,
    membershipId: active ? MEMBERSHIP_ID : null,
  }));
  const membership = {
    resolve,
    isAccountActive: jest.fn(async () => accountActive),
  } as unknown as MembershipStateService;

  const mfaResolve = jest.fn(async () => mfa);
  const mfaPolicy = { resolve: mfaResolve } as unknown as IMfaPolicy;

  const moduleAvailability = jest.fn(
    (): Promise<ModuleAvailabilityResult> =>
      moduleLookupRejects
        ? Promise.reject(new Error("entitlement store unreachable"))
        : Promise.resolve(available),
  );

  const factory = new AuthContextFactory(
    { moduleAvailability },
    membership,
    mfaPolicy,
  );

  const keyring =
    keyringOverride ??
    ({
      verifyToken: jest.fn(async () => ({
        sub: USER,
        orgId: orgIdInToken,
        sessionId: "session-composition",
      })),
    } as unknown as JwtKeyringService);

  const db = makeDb();
  const cache = makeCache();
  const entitlements = {
    isModuleEnabled: async () => true,
    isCoreModule: () => false,
    getModuleMap: async () => ({}),
    getEffectiveModuleMap: async () => ({}),
    getPlanLockedModules: async () => [],
    buildModuleAvailabilityResolver: () => ({
      isCoreModule: () => false,
      getModuleMap: async () => ({}),
      getUserDeniedModules: async () => new Set<string>(),
      getPlanLockedModules: async () => [],
    }),
  } as unknown as EntitlementsService;

  const access = new AccessService(
    db,
    cache,
    entitlements,
    { resolve: mfaResolve } as unknown as MfaPolicyService,
    new AccessVersionCache(db, cache),
    membership,
  );

  const reflector = new Reflector();
  return {
    resolve,
    mfaResolve,
    moduleAvailability,
    access,
    factory,
    jwtGuard: new JwtAuthGuard(reflector, db, null, membership, keyring, factory),
    mfaGuard: new MfaGuard(reflector, mfaPolicy),
    moduleGuard: new ModuleGuard(reflector),
    permissionGuard: new PermissionGuard(reflector, access),
  };
}

function requireActor(req: { user?: CurrentUserContext }): CurrentUserContext {
  const actor = req.user;
  if (!actor) throw new Error("the guard attached no actor");
  return actor;
}

function contextFor(
  methodName: "read" | "account",
  authorization: string = TOKEN,
): { context: ExecutionContext; req: { user?: CurrentUserContext; authContext?: AuthContext } } {
  const req: { user?: CurrentUserContext; authContext?: AuthContext; headers: Record<string, string>; path: string; method: string } = {
    headers: { authorization },
    path: "/probe",
    method: "GET",
  };
  const handler = ProbeController.prototype[methodName];
  return {
    req,
    context: {
      getType: () => "http",
      getHandler: () => handler,
      getClass: () => ProbeController,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext,
  };
}

describe("the guard chain and access resolution share one request-owned answer", () => {
  it("performs exactly one authoritative membership resolution across authentication and permission resolution", async () => {
    const stack = buildStack();
    const { context, req } = contextFor("read");

    await expect(stack.jwtGuard.canActivate(context)).resolves.toBe(true);
    await expect(stack.permissionGuard.canActivate(context)).resolves.toBe(true);

    expect(stack.resolve).toHaveBeenCalledTimes(1);
    expect(stack.resolve).toHaveBeenCalledWith(USER, ORG);
    expect(req.authContext).toBeDefined();
  });

  it("and that count is not vacuous — the same resolution without the context costs a second read", async () => {
    const shared = buildStack();
    const withContext = contextFor("read");
    await shared.jwtGuard.canActivate(withContext.context);
    await shared.access.resolveUserPermissions(
      ORG,
      USER,
      withContext.req.authContext,
    );
    expect(shared.resolve).toHaveBeenCalledTimes(1);

    const unshared = buildStack();
    const withoutContext = contextFor("read");
    await unshared.jwtGuard.canActivate(withoutContext.context);
    await unshared.access.resolveUserPermissions(ORG, USER);

    expect(unshared.resolve).toHaveBeenCalledTimes(2);
  });

  it("performs exactly one MFA-policy resolution across MfaGuard and the access snapshot", async () => {
    const stack = buildStack();
    const { context, req } = contextFor("read");

    await stack.jwtGuard.canActivate(context);
    await expect(stack.mfaGuard.canActivate(context)).resolves.toBe(true);
    await stack.access.getAccessSnapshot(ORG, USER, requireActor(req), req.authContext);

    expect(stack.mfaResolve).toHaveBeenCalledTimes(1);
  });

  it("performs exactly one module-availability lookup across ModuleGuard and authorize", async () => {
    const stack = buildStack();
    const { context } = contextFor("read");

    await stack.jwtGuard.canActivate(context);
    await expect(stack.moduleGuard.canActivate(context)).resolves.toBe(true);
    await expect(stack.permissionGuard.canActivate(context)).resolves.toBe(true);

    expect(stack.moduleAvailability).toHaveBeenCalledTimes(1);
    expect(stack.moduleAvailability).toHaveBeenCalledWith(expect.any(Object), "hr");
  });

  it("never lets one context answer for another actor or another tenant", async () => {
    const stack = buildStack();
    const { context, req } = contextFor("read");

    await stack.jwtGuard.canActivate(context);
    await stack.permissionGuard.canActivate(context);
    expect(stack.resolve).toHaveBeenCalledTimes(1);

    await stack.access.resolveUserPermissions(ORG, "someone-else", req.authContext);
    await stack.access.resolveUserPermissions("another-org", USER, req.authContext);

    expect(stack.resolve).toHaveBeenCalledTimes(3);
    expect(stack.resolve).toHaveBeenCalledWith("someone-else", ORG);
    expect(stack.resolve).toHaveBeenCalledWith(USER, "another-org");
  });
});

describe("the shared context never turns a denial into an allow", () => {
  it("denies a suspended membership at authentication", async () => {
    const stack = buildStack({ active: false });
    const { context } = contextFor("read");

    await expect(stack.jwtGuard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("denies a deactivated or deleted account at authentication", async () => {
    const stack = buildStack({ accountActive: false });
    const { context } = contextFor("read");

    await expect(stack.jwtGuard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("denies when the organization enforces MFA and the actor has not satisfied it", async () => {
    const stack = buildStack({ mfa: { enforced: true, satisfied: false } });
    const { context } = contextFor("read");

    await stack.jwtGuard.canActivate(context);

    await expect(stack.mfaGuard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("reports the module, not a permission failure, when the module is unavailable", async () => {
    const stack = buildStack({
      available: { available: false, reason: "org-disabled" },
    });
    const { context } = contextFor("read");

    await stack.jwtGuard.canActivate(context);

    await expect(stack.moduleGuard.canActivate(context)).rejects.toBeInstanceOf(
      ModuleDisabledException,
    );
    await expect(
      stack.permissionGuard.canActivate(context),
    ).rejects.toBeInstanceOf(ModuleDisabledException);
  });

  it("denies rather than allows when the availability lookup itself fails", async () => {
    const stack = buildStack({ moduleLookupRejects: true });
    const { context } = contextFor("read");

    await stack.jwtGuard.canActivate(context);

    await expect(stack.moduleGuard.canActivate(context)).rejects.toThrow();
    await expect(
      stack.permissionGuard.canActivate(context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("resolves no permissions for a background caller whose account is no longer live", async () => {
    const stack = buildStack({ active: false });

    await expect(
      stack.access.resolveUserPermissions(ORG, USER),
    ).resolves.toEqual(new Map());
    expect(stack.resolve).toHaveBeenCalledWith(USER, ORG);
  });
});

describe("account-only requests keep their existing semantics", () => {
  it("admits an @AllowNoOrg() request with no organization and reads no membership", async () => {
    const stack = buildStack({ orgIdInToken: "" });
    const { context, req } = contextFor("account");

    await expect(stack.jwtGuard.canActivate(context)).resolves.toBe(true);
    expect(req.user?.orgId).toBe("");
    expect(await req.authContext?.membership()).toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
    expect(stack.resolve).not.toHaveBeenCalled();
  });

  it("lets MfaGuard through for an account-only request", async () => {
    const stack = buildStack({
      orgIdInToken: "",
      mfa: { enforced: true, satisfied: false },
    });
    const { context } = contextFor("account");

    await stack.jwtGuard.canActivate(context);

    await expect(stack.mfaGuard.canActivate(context)).resolves.toBe(true);
    expect(stack.mfaResolve).not.toHaveBeenCalled();
  });
});

describe("a malformed principal never reaches the permission gate", () => {
  it("rejects a token whose subject is an empty string, and admits the same token shape with a real subject", async () => {
    const keyring = await keyringWithGeneratedKey();
    expect(keyring.isReady()).toBe(true);

    const emptySubjectToken = await keyring.signToken({
      sub: "",
      orgId: ORG,
      sessionId: "session-composition",
    });
    expect(await keyring.verifyToken(emptySubjectToken)).toBeNull();

    const denied = contextFor("read", `Bearer ${emptySubjectToken}`);
    await expect(
      buildStack({ keyring }).jwtGuard.canActivate(denied.context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(denied.req.user).toBeUndefined();
    expect(denied.req.authContext).toBeUndefined();

    const realSubjectToken = await keyring.signToken({
      sub: USER,
      orgId: ORG,
      sessionId: "session-composition",
    });
    expect((await keyring.verifyToken(realSubjectToken))?.sub).toBe(USER);

    const admitted = contextFor("read", `Bearer ${realSubjectToken}`);
    await expect(
      buildStack({ keyring }).jwtGuard.canActivate(admitted.context),
    ).resolves.toBe(true);
    expect(admitted.req.user?.userId).toBe(USER);
  });

  it("rejects a request carrying no organization on a route that is not @AllowNoOrg, and still admits the @AllowNoOrg route", async () => {
    const gated = buildStack({ orgIdInToken: "" });
    const gatedRequest = contextFor("read");

    await expect(
      gated.jwtGuard.canActivate(gatedRequest.context),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gatedRequest.req.user).toBeUndefined();
    expect(gatedRequest.req.authContext).toBeUndefined();
    expect(gated.resolve).not.toHaveBeenCalled();

    const accountOnly = buildStack({ orgIdInToken: "" });
    await expect(
      accountOnly.jwtGuard.canActivate(contextFor("account").context),
    ).resolves.toBe(true);
  });

  it("denies a token-attenuated principal whose ceiling excludes the route key, even though the same person holds that key", async () => {
    const stack = buildStack();
    const session = contextFor("read");

    await stack.jwtGuard.canActivate(session.context);
    const holder = requireActor(session.req);
    expect(holder.principal.kind).toBe("human-session");
    await expect(
      stack.permissionGuard.canActivate(session.context),
    ).resolves.toBe(true);
    expect(
      (await stack.access.resolveUserPermissions(ORG, USER, session.req.authContext)).get(KEY),
    ).toBe("all");

    const attenuatedActor: CurrentUserContext = {
      ...holder,
      tokenScopes: [OTHER_KEY],
      principal: personalTokenPrincipal(MEMBERSHIP_ID, false, "pat-1", [OTHER_KEY]),
    };
    const attenuated = contextFor("read");
    attenuated.req.user = attenuatedActor;
    attenuated.req.authContext = stack.factory.create(attenuatedActor);

    await expect(
      stack.permissionGuard.canActivate(attenuated.context),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const widenedActor: CurrentUserContext = {
      ...holder,
      tokenScopes: [OTHER_KEY, KEY],
      principal: personalTokenPrincipal(MEMBERSHIP_ID, false, "pat-1", [
        OTHER_KEY,
        KEY,
      ]),
    };
    const widened = contextFor("read");
    widened.req.user = widenedActor;
    widened.req.authContext = stack.factory.create(widenedActor);

    await expect(
      stack.permissionGuard.canActivate(widened.context),
    ).resolves.toBe(true);
  });
});
