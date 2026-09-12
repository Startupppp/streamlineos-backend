import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { OrgSetupResolverService, type SetupMembership } from "../org-setup-resolver.service";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

// withIdentity must invoke its callback so tx.query.* calls go through.
// A mock that resolves undefined breaks resolveCurrentSetupTarget's 2-tuple destructure.
jest.mock("../../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn().mockImplementation(
    (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
  ),
}));

// runInTenantTransaction is used for orphan cleanup. Invoke its callback.
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  ),
}));

// withMembershipMutations wraps the cleanup callback. Invoke it.
jest.mock("../../../../common/org/membership-mutations", () => ({
  withMembershipMutations: jest.fn().mockImplementation(
    (_cache: unknown, fn: (membership: unknown) => Promise<unknown>) =>
      fn({ deleteMembershipsById: jest.fn().mockResolvedValue(undefined) }),
  ),
}));

// Cleanup now requires the placement authority to prove the organization is absent.
// Absence is the default here; `org-setup-resolver-absence-authority.spec.ts` owns the
// placed / unverified branches.
jest.mock("../../../../common/region/placement-lookup", () => ({
  placedOrganizationCoordinates: jest.fn().mockResolvedValue(null),
}));

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "account-only" },
    ...overrides,
  };
}

function makeDb(options: {
  membershipRow?: { status: string; isOwner: boolean } | null;
  orgRow?: { id: string; name: string } | null;
}) {
  return {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(options.membershipRow ?? null),
      },
      organizations: {
        findFirst: jest.fn().mockResolvedValue(options.orgRow ?? null),
      },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    transaction: jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    ),
  };
}

async function buildResolver(db: unknown, creation: unknown = { createFromSetup: jest.fn() }) {
  const ref = await Test.createTestingModule({
    providers: [
      OrgSetupResolverService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateForOrg: jest.fn() } },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: OrganizationCreationService, useValue: creation },
    ],
  }).compile();
  return ref.get(OrgSetupResolverService);
}

function membership(
  overrides: Partial<SetupMembership> = {},
): SetupMembership {
  return {
    id: 1,
    orgId: "org-1",
    existingOrgId: "org-1",
    orgName: "Acme",
    orgStatus: "ACTIVE",
    orgDeletedAt: null,
    status: "ACTIVE",
    isOwner: true,
    ...overrides,
  };
}

describe("OrgSetupResolverService — target selection and authorization", () => {
  describe("resolveCurrentSetupTarget", () => {
    it("returns null immediately when the actor carries no orgId", async () => {
      const db = makeDb({ membershipRow: null, orgRow: null });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor({ orgId: "" }));

      expect(result).toBeNull();
    });

    it("ACTIVE owner membership on ACTIVE org — returns that org with isOwner:true", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: true },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor());

      expect(result).toEqual({ orgId: "org-1", isOwner: true });
    });

    it("ACTIVE non-owner membership — returns that org with isOwner:false", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: false },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor({ isOrgOwner: false, role: "MEMBER" }));

      expect(result).toEqual({ orgId: "org-1", isOwner: false });
    });

    it("SUSPENDED membership — throws ForbiddenException with code ORG_MEMBERSHIP_SUSPENDED", async () => {
      const db = makeDb({
        membershipRow: { status: "SUSPENDED", isOwner: false },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      const error = await resolver
        .resolveCurrentSetupTarget(actor())
        .then(() => null, (e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: "ORG_MEMBERSHIP_SUSPENDED",
      });
    });

    it("INVITED status — returns null (non-ACTIVE statuses are never selected)", async () => {
      const db = makeDb({
        membershipRow: { status: "INVITED", isOwner: false },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor());

      expect(result).toBeNull();
    });

    it("LEFT status — returns null", async () => {
      const db = makeDb({
        membershipRow: { status: "LEFT", isOwner: false },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor());

      expect(result).toBeNull();
    });

    it("deleted organization (orgRow null) — returns null even with ACTIVE membership", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: true },
        orgRow: null,
      });
      const resolver = await buildResolver(db);

      const result = await resolver.resolveCurrentSetupTarget(actor());

      expect(result).toBeNull();
    });

    it("uses withIdentity (not a tenant transaction) so the pre-tenant membership query is admitted", async () => {
      const { withIdentity } = jest.requireMock("../../../../common/tenant/with-identity") as {
        withIdentity: jest.Mock;
      };
      withIdentity.mockClear();
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: true },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const resolver = await buildResolver(db);

      await resolver.resolveCurrentSetupTarget(actor());

      expect(withIdentity).toHaveBeenCalledWith(db, "user-1", expect.any(Function));
    });
  });

  describe("resolveExistingSetupTarget", () => {
    it("returns null when membership list is empty", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      expect(resolver.resolveExistingSetupTarget(actor(), [])).toBeNull();
    });

    it("prefers the context orgId when the user holds ACTIVE membership in it", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ orgId: "org-other", existingOrgId: "org-other", isOwner: false }),
        membership({ orgId: "org-1", existingOrgId: "org-1", isOwner: true }),
      ];

      const result = resolver.resolveExistingSetupTarget(actor({ orgId: "org-1" }), memberships);

      expect(result?.orgId).toBe("org-1");
    });

    it("falls back to the first ACTIVE org when the context orgId has no ACTIVE membership", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ orgId: "org-other", existingOrgId: "org-other", isOwner: false }),
      ];

      const result = resolver.resolveExistingSetupTarget(actor({ orgId: "org-missing" }), memberships);

      expect(result?.orgId).toBe("org-other");
    });

    it("orphan index (null existingOrgId) is never selected as a target", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ existingOrgId: null, orgStatus: null, orgDeletedAt: null }),
      ];

      const result = resolver.resolveExistingSetupTarget(actor(), memberships);

      expect(result).toBeNull();
    });

    it("SUSPENDED membership throws ORG_MEMBERSHIP_SUSPENDED via the fallback path", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ status: "SUSPENDED", isOwner: false }),
      ];

      expect(() => resolver.resolveExistingSetupTarget(actor(), memberships)).toThrow(
        ForbiddenException,
      );
    });

    it("SUSPENDED membership error carries ORG_MEMBERSHIP_SUSPENDED code", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ status: "SUSPENDED", isOwner: false }),
      ];

      let caught: unknown = null;
      try {
        resolver.resolveExistingSetupTarget(actor(), memberships);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).getResponse()).toMatchObject({
        code: "ORG_MEMBERSHIP_SUSPENDED",
      });
    });

    it("deleted org (orgDeletedAt set) is never selected even with ACTIVE membership", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ orgDeletedAt: new Date("2020-01-01"), status: "ACTIVE" }),
      ];

      const result = resolver.resolveExistingSetupTarget(actor(), memberships);

      expect(result).toBeNull();
    });

    it("non-ACTIVE org status is never selected", () => {
      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );
      const memberships: SetupMembership[] = [
        membership({ orgStatus: "SUSPENDED", status: "ACTIVE" }),
      ];

      const result = resolver.resolveExistingSetupTarget(actor(), memberships);

      expect(result).toBeNull();
    });
  });

  describe("resolveOrCreateOrg", () => {
    it("zero memberships — delegates to createFromSetup with isOwner:true", async () => {
      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-new", name: "New Org", slug: "new-org" }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), { companyName: "New Org" });

      expect(result).toEqual({ orgId: "org-new", isOwner: true });
      expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
      expect(creation.createFromSetup).toHaveBeenCalledWith({ userId: "user-1", name: "New Org" });
    });

    it("ACTIVE owner on ACTIVE org — returns existing org without calling createFromSetup", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: true },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(db, creation);

      const result = await resolver.resolveOrCreateOrg(actor(), { companyName: "Acme" });

      expect(result).toEqual({ orgId: "org-1", isOwner: true });
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("ACTIVE non-owner membership — returns org with isOwner:false and does NOT call createFromSetup", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: false },
        orgRow: { id: "org-1", name: "Acme" },
      });
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(db, creation);

      const result = await resolver.resolveOrCreateOrg(
        actor({ isOrgOwner: false, role: "MEMBER" }),
        {},
      );

      expect(result).toEqual({ orgId: "org-1", isOwner: false });
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("non-owner result never causes a setup mutation (resolveOrCreateOrg returns the target, caller guards the mutation)", async () => {
      const db = makeDb({
        membershipRow: { status: "ACTIVE", isOwner: false },
        orgRow: { id: "org-owned-by-someone-else", name: "Other Org" },
      });
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(db, creation);

      const result = await resolver.resolveOrCreateOrg(
        actor({ orgId: "org-owned-by-someone-else", isOrgOwner: false, role: "MEMBER" }),
        {},
      );

      // The resolver returns the target. OrgSetupService.completeSetup checks isOwner before
      // running any setup mutations — this is the enforcement seam, not the resolver.
      expect(result.isOwner).toBe(false);
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("orphan memberships (null existingOrgId) are cleaned up before creation is called", async () => {
      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const orphanMemberships: SetupMembership[] = [
        membership({ existingOrgId: null, orgStatus: null }),
      ];
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue(orphanMemberships);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
    });

    it("never deletes a membership whose organization row resolved, even when it is not a usable target", async () => {
      const { runInTenantTransaction } = jest.requireMock(
        "../../../../common/tenant/run-in-tenant-transaction",
      ) as { runInTenantTransaction: jest.Mock };
      runInTenantTransaction.mockClear();

      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([
        membership({
          orgId: "org-resolved",
          existingOrgId: "org-resolved",
          status: "LEFT",
          orgStatus: "ACTIVE",
        }),
      ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(runInTenantTransaction).not.toHaveBeenCalled();
      expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
    });

    it("same user retrying returns the same org (createFromSetup handles saga reuse internally)", async () => {
      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-same", name: "Same", slug: "same" }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

      const first = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), { companyName: "Same" });
      const second = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), { companyName: "Same" });

      expect(first.orgId).toBe("org-same");
      expect(second.orgId).toBe("org-same");
      // Both calls go through createFromSetup; the saga inside deduplicates by request key.
      expect(creation.createFromSetup).toHaveBeenCalledTimes(2);
    });

    it("existing COMPLETED org is reused (isReusableSetupOrganization governs saga resumption)", async () => {
      const db = makeDb({ membershipRow: null, orgRow: null });
      // When the COMPLETED saga is reusable, createFromSetup returns the same org without
      // bootstrapping again. The resolver returns whatever createFromSetup returns.
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-existing", name: "Existing", slug: "existing" }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(result.orgId).toBe("org-existing");
      expect(result.isOwner).toBe(true);
      // The resolver delegates reuse logic to createFromSetup; it does not duplicate it.
      expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
    });

    it("false touchLastActivated during activate-directory-projection does NOT redirect resolver to a different org", async () => {
      // touchLastActivated returning false means the account index was not updated (the saga step
      // logs an error but does not throw). createFromSetup still returns the created org.
      // The resolver must NOT use resolvePreferredOrg or the account index to pick the result.
      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({
          id: "org-created",
          name: "Created",
          slug: "created",
        }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(result.orgId).toBe("org-created");
      expect(result.isOwner).toBe(true);
      // The resolver's return value is determined by createFromSetup, never by a stale index read.
    });
  });

  describe("listSetupMemberships — 100-row scan limit", () => {
    it("applies LIMIT 100 to the membership query", async () => {
      const limitFn = jest.fn().mockResolvedValue([]);
      const db = {
        ...makeDb({}),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({ limit: limitFn }),
              }),
            }),
          }),
        }),
      };
      const resolver = await buildResolver(db);

      await resolver.listSetupMemberships("user-1");

      expect(limitFn).toHaveBeenCalledWith(100);
    });

    it("an ACTIVE target beyond 100 rows is invisible to the scan — this is a known gap", async () => {
      // listSetupMemberships returns at most 100 rows. A user who holds more than 100 memberships
      // may have a valid ACTIVE target that is not visible, causing resolveOrCreateOrg to create a
      // new (unwanted) organization. This gap is known: owner the query to increase the limit or
      // page through all memberships before resolving requires a product decision.
      // File: org-setup-resolver.service.ts:60-63
      const rows100: SetupMembership[] = Array.from({ length: 100 }, (_, i) =>
        membership({ id: i + 1, orgId: `org-${i}`, existingOrgId: `org-${i}`, status: "LEFT" }),
      );
      const activeTarget = membership({ id: 101, orgId: "org-active", existingOrgId: "org-active", status: "ACTIVE" });

      const resolver = new OrgSetupResolverService(
        {} as never, {} as never, {} as never, {} as never,
      );

      // Simulate what happens when the scan returned exactly 100 rows and the active target was #101
      const resultWithout = resolver.resolveExistingSetupTarget(
        actor({ orgId: "" }),
        rows100,
      );
      const resultWith = resolver.resolveExistingSetupTarget(
        actor({ orgId: "" }),
        [...rows100, activeTarget],
      );

      expect(resultWithout).toBeNull();
      expect(resultWith).toEqual({ orgId: "org-active", isOwner: true });
    });
  });

  describe("identity-plane vs tenant-plane reads", () => {
    it("listSetupMemberships uses withIdentity — the @NoTenantTransaction route has no org GUC yet", async () => {
      const { withIdentity } = jest.requireMock("../../../../common/tenant/with-identity") as {
        withIdentity: jest.Mock;
      };
      withIdentity.mockClear();
      const db = {
        ...makeDb({}),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
      };
      const resolver = await buildResolver(db);

      await resolver.listSetupMemberships("user-1");

      expect(withIdentity).toHaveBeenCalledWith(db, "user-1", expect.any(Function));
    });

    it("orphan cleanup uses runInTenantTransaction with the orphan orgId as the tenant scope", async () => {
      const { runInTenantTransaction } = jest.requireMock(
        "../../../../common/tenant/run-in-tenant-transaction",
      ) as { runInTenantTransaction: jest.Mock };
      runInTenantTransaction.mockClear();

      const db = makeDb({ membershipRow: null, orgRow: null });
      const creation = {
        createFromSetup: jest.fn().mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(db, creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([
        membership({ orgId: "orphan-org-1", existingOrgId: null }),
      ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      const calls = runInTenantTransaction.mock.calls as Array<[unknown, unknown, { orgId: string }]>;
      expect(calls.some((c) => c[2]?.orgId === "orphan-org-1")).toBe(true);
    });
  });
});
