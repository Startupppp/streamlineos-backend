import { type Db } from "../../../db/drizzle.module";
import { OrgSetupQueryService } from "./org-setup-query.service";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeUserCtx(orgId: string): CurrentUserContext {
  return {
    userId: "user-x",
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-x",
    tokenScopes: null,
    principal: { kind: "account-only" },
  };
}

function makeResolver(target: { orgId: string; isOwner: boolean } | null) {
  return {
    resolveCurrentSetupTarget: jest.fn().mockResolvedValue(target),
    listSetupMemberships: jest.fn().mockResolvedValue([]),
    resolveExistingSetupTarget: jest.fn().mockReturnValue(null),
  } as unknown as OrgSetupResolverService;
}

function makeService(resolver: OrgSetupResolverService) {
  return new OrgSetupQueryService(
    {} as unknown as Db,
    {} as unknown as OnboardingSessionService,
    resolver,
  );
}

describe("OrgSetupQueryService — cross-tenant isolation", () => {
  it("getSetupStatus returns null orgId when the caller has no verified membership in any org (cross-tenant isolation)", async () => {
    const resolver = makeResolver(null);
    const svc = makeService(resolver);
    const u = makeUserCtx(ATTACKER_ORG);

    const result = await svc.getSetupStatus(u);

    expect(result.orgId).toBeNull();
    expect(result.ready).toBe(false);
    expect(resolver.resolveCurrentSetupTarget).toHaveBeenCalledWith(u);
    expect(resolver.listSetupMemberships).toHaveBeenCalledWith("user-x");
  });

  it("getSetupStatus does not access any tenant data when the resolver confirms no setup target (no DB access)", async () => {
    const resolver = makeResolver(null);
    const db = { query: undefined, transaction: jest.fn(), select: jest.fn() } as unknown as Db;
    const svc = new OrgSetupQueryService(
      db,
      {} as unknown as OnboardingSessionService,
      resolver,
    );
    const u = makeUserCtx(ATTACKER_ORG);

    const result = await svc.getSetupStatus(u);

    expect(result.orgId).toBeNull();
    expect((db as unknown as { transaction: jest.Mock }).transaction).not.toHaveBeenCalled();
    expect((db as unknown as { select: jest.Mock }).select).not.toHaveBeenCalled();
  });

  it("getSetupStatus resolves the target from the resolver, not from the client-supplied orgId in the context (resolver controls scope)", async () => {
    const resolver = {
      resolveCurrentSetupTarget: jest.fn().mockResolvedValue(null),
      listSetupMemberships: jest.fn().mockResolvedValue([]),
      resolveExistingSetupTarget: jest.fn().mockReturnValue(null),
    } as unknown as OrgSetupResolverService;
    const svc = makeService(resolver);

    const attackerCtx = makeUserCtx(ATTACKER_ORG);
    const ownerCtx = makeUserCtx(OWNER_ORG);

    const [attackerResult, ownerResult] = await Promise.all([
      svc.getSetupStatus(attackerCtx),
      svc.getSetupStatus(ownerCtx),
    ]);

    expect(attackerResult.orgId).toBeNull();
    expect(ownerResult.orgId).toBeNull();
    expect(resolver.resolveCurrentSetupTarget).toHaveBeenCalledTimes(2);
  });
});
