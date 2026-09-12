import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import {
  OrgSetupResolverService,
  type SetupMembership,
} from "../org-setup-resolver.service";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

jest.mock("../../../../common/tenant/with-identity", () => ({
  withIdentity: jest
    .fn()
    .mockImplementation(
      (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn(_db),
    ),
}));

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest
    .fn()
    .mockImplementation(
      (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) =>
        fn(_db),
    ),
}));

const deleteMembershipsById = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../../common/org/membership-mutations", () => ({
  withMembershipMutations: jest
    .fn()
    .mockImplementation(
      (_cache: unknown, fn: (membership: unknown) => Promise<unknown>) =>
        fn({ deleteMembershipsById }),
    ),
}));

jest.mock("../../../../common/region/placement-lookup", () => ({
  placedOrganizationCoordinates: jest.fn(),
}));

function placementLookup(): jest.Mock {
  const mocked = jest.requireMock("../../../../common/region/placement-lookup") as {
    placedOrganizationCoordinates: jest.Mock;
  };
  return mocked.placedOrganizationCoordinates;
}

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

function membership(overrides: Partial<SetupMembership> = {}): SetupMembership {
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
  };
}

async function buildResolver(
  db: unknown,
  creation: unknown = {
    createFromSetup: jest
      .fn()
      .mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
  },
) {
  const ref = await Test.createTestingModule({
    providers: [
      OrgSetupResolverService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: CacheService,
        useValue: { invalidate: jest.fn(), invalidateForOrg: jest.fn() },
      },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: OrganizationCreationService, useValue: creation },
    ],
  }).compile();
  return ref.get(OrgSetupResolverService);
}

describe("OrgSetupResolverService — organization absence is proved by placement, not by a join miss", () => {
  beforeEach(() => {
    deleteMembershipsById.mockClear();
    placementLookup().mockReset();
  });

  describe("verifyOrganizationAbsence", () => {
    it("no placement row — absent", async () => {
      placementLookup().mockResolvedValue(null);
      const resolver = await buildResolver(makeDb({}));

      await expect(resolver.verifyOrganizationAbsence("org-x")).resolves.toEqual({
        status: "absent",
      });
    });

    it("placement row in another cell — placed, carrying the region and cell it was found in", async () => {
      placementLookup().mockResolvedValue({ region: "eu", cellId: "cell-eu-1" });
      const resolver = await buildResolver(makeDb({}));

      await expect(resolver.verifyOrganizationAbsence("org-x")).resolves.toEqual({
        status: "placed",
        region: "eu",
        cellId: "cell-eu-1",
      });
    });

    it("a failing placement lookup is unverified, never absent", async () => {
      placementLookup().mockRejectedValue(new Error("control plane unreachable"));
      const resolver = await buildResolver(makeDb({}));

      await expect(resolver.verifyOrganizationAbsence("org-x")).resolves.toEqual({
        status: "unverified",
        reason: "control plane unreachable",
      });
    });
  });

  describe("resolveOrCreateOrg cleanup", () => {
    it("genuine orphan (no placement anywhere) — deletes exactly that org's membership ids", async () => {
      placementLookup().mockResolvedValue(null);
      const creation = {
        createFromSetup: jest
          .fn()
          .mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(makeDb({}), creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([
        membership({ id: 7, orgId: "org-gone", existingOrgId: null, orgStatus: null }),
        membership({ id: 8, orgId: "org-gone", existingOrgId: null, orgStatus: null }),
      ]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(deleteMembershipsById).toHaveBeenCalledTimes(1);
      expect(deleteMembershipsById).toHaveBeenCalledWith(expect.anything(), {
        orgId: "org-gone",
        userId: "user-1",
        membershipIds: [7, 8],
      });
      expect(result).toEqual({ orgId: "org-new", isOwner: true });
    });

    it("wrong-cell / RLS-hidden row (placement exists) — NOTHING is deleted", async () => {
      placementLookup().mockResolvedValue({ region: "eu", cellId: "cell-eu-1" });
      const resolver = await buildResolver(makeDb({}));
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([
          membership({ id: 9, orgId: "org-elsewhere", existingOrgId: null, orgStatus: null }),
        ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(deleteMembershipsById).not.toHaveBeenCalled();
    });

    it("an unverifiable placement lookup — NOTHING is deleted", async () => {
      placementLookup().mockRejectedValue(new Error("control plane unreachable"));
      const resolver = await buildResolver(makeDb({}));
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([
          membership({ id: 10, orgId: "org-unknown", existingOrgId: null, orgStatus: null }),
        ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(deleteMembershipsById).not.toHaveBeenCalled();
    });

    it("mixed batch — only the provably absent org loses rows; the placed org keeps its own", async () => {
      placementLookup().mockImplementation((_db: unknown, orgId: string) =>
        Promise.resolve(
          orgId === "org-placed" ? { region: "primary", cellId: "cell-1" } : null,
        ),
      );
      const resolver = await buildResolver(makeDb({}));
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([
        membership({ id: 11, orgId: "org-placed", existingOrgId: null, orgStatus: null }),
        membership({ id: 12, orgId: "org-absent", existingOrgId: null, orgStatus: null }),
      ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(deleteMembershipsById).toHaveBeenCalledTimes(1);
      expect(deleteMembershipsById).toHaveBeenCalledWith(expect.anything(), {
        orgId: "org-absent",
        userId: "user-1",
        membershipIds: [12],
      });
    });

    it("zero memberships — no placement lookup, no deletion, one creation", async () => {
      const creation = {
        createFromSetup: jest
          .fn()
          .mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(makeDb({}), creation);
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(placementLookup()).not.toHaveBeenCalled();
      expect(deleteMembershipsById).not.toHaveBeenCalled();
      expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ orgId: "org-new", isOwner: true });
    });

    it("invited-only membership on a resolvable org — never deleted, and a new org is created", async () => {
      const creation = {
        createFromSetup: jest
          .fn()
          .mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(makeDb({}), creation);
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([
          membership({ id: 13, orgId: "org-invited", existingOrgId: "org-invited", status: "INVITED" }),
        ]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(placementLookup()).not.toHaveBeenCalled();
      expect(deleteMembershipsById).not.toHaveBeenCalled();
      expect(result).toEqual({ orgId: "org-new", isOwner: true });
    });

    it("SUSPENDED membership — throws before any cleanup and creates nothing", async () => {
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(makeDb({}), creation);
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([membership({ id: 14, status: "SUSPENDED", isOwner: false })]);

      await expect(
        resolver.resolveOrCreateOrg(actor({ orgId: "" }), {}),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(deleteMembershipsById).not.toHaveBeenCalled();
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("LEFT membership on a live org — never deleted", async () => {
      const resolver = await buildResolver(makeDb({}));
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([membership({ id: 15, status: "LEFT" })]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(deleteMembershipsById).not.toHaveBeenCalled();
    });

    it("soft-deleted organization — the membership row survives; deletion is not cleanup", async () => {
      const resolver = await buildResolver(makeDb({}));
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([
        membership({ id: 16, status: "ACTIVE", orgDeletedAt: new Date("2020-01-01") }),
      ]);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(placementLookup()).not.toHaveBeenCalled();
      expect(deleteMembershipsById).not.toHaveBeenCalled();
    });

    it("current ACTIVE owner — returns that org, and never reaches the cleanup path", async () => {
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(
        makeDb({
          membershipRow: { status: "ACTIVE", isOwner: true },
          orgRow: { id: "org-1", name: "Acme" },
        }),
        creation,
      );

      const result = await resolver.resolveOrCreateOrg(actor(), {});

      expect(result).toEqual({ orgId: "org-1", isOwner: true });
      expect(placementLookup()).not.toHaveBeenCalled();
      expect(deleteMembershipsById).not.toHaveBeenCalled();
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("current ACTIVE non-owner — returns isOwner:false and creates nothing", async () => {
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(
        makeDb({
          membershipRow: { status: "ACTIVE", isOwner: false },
          orgRow: { id: "org-1", name: "Acme" },
        }),
        creation,
      );

      const result = await resolver.resolveOrCreateOrg(
        actor({ isOrgOwner: false, role: "MEMBER" }),
        {},
      );

      expect(result).toEqual({ orgId: "org-1", isOwner: false });
      expect(deleteMembershipsById).not.toHaveBeenCalled();
      expect(creation.createFromSetup).not.toHaveBeenCalled();
    });

    it("an already-completed organization is reused — no second organization is created without explicit intent", async () => {
      const creation = { createFromSetup: jest.fn() };
      const resolver = await buildResolver(makeDb({}), creation);
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([
          membership({ id: 17, orgId: "org-done", existingOrgId: "org-done", isOwner: true }),
        ]);

      const result = await resolver.resolveOrCreateOrg(
        actor({ orgId: "" }),
        { companyName: "A Different Name Entirely" },
      );

      expect(result).toEqual({ orgId: "org-done", isOwner: true });
      expect(creation.createFromSetup).not.toHaveBeenCalled();
      expect(deleteMembershipsById).not.toHaveBeenCalled();
    });

    it("more than 100 memberships — unresolved rows inside the scan are still only deleted on placement proof", async () => {
      placementLookup().mockImplementation((_db: unknown, orgId: string) =>
        Promise.resolve(orgId === "org-unresolved-2" ? null : { region: "eu", cellId: "cell-eu" }),
      );
      const rows: SetupMembership[] = Array.from({ length: 100 }, (_, i) =>
        membership({
          id: i + 1,
          orgId: `org-unresolved-${i}`,
          existingOrgId: null,
          orgStatus: null,
          status: "LEFT",
        }),
      );
      const resolver = await buildResolver(makeDb({}));
      jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue(rows);

      await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(placementLookup()).toHaveBeenCalledTimes(100);
      expect(deleteMembershipsById).toHaveBeenCalledTimes(1);
      expect(deleteMembershipsById).toHaveBeenCalledWith(expect.anything(), {
        orgId: "org-unresolved-2",
        userId: "user-1",
        membershipIds: [3],
      });
    });

    it("a delete that fails does not abort setup — creation still runs", async () => {
      placementLookup().mockResolvedValue(null);
      deleteMembershipsById.mockRejectedValueOnce(new Error("deadlock detected"));
      const creation = {
        createFromSetup: jest
          .fn()
          .mockResolvedValue({ id: "org-new", name: "New", slug: "new" }),
      };
      const resolver = await buildResolver(makeDb({}), creation);
      jest
        .spyOn(resolver, "listSetupMemberships")
        .mockResolvedValue([
          membership({ id: 18, orgId: "org-gone", existingOrgId: null, orgStatus: null }),
        ]);

      const result = await resolver.resolveOrCreateOrg(actor({ orgId: "" }), {});

      expect(result).toEqual({ orgId: "org-new", isOwner: true });
    });
  });
});
