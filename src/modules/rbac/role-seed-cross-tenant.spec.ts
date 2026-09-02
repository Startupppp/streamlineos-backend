import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";
import { RoleSeedService } from "./role-seed.service";

jest.mock("../../common/rbac/is-structural-org-admin", () => ({
  isStructuralOrgAdmin: jest.fn(),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

jest.mock("./seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue({ created: 0 }),
}));

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("RoleSeedService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const VICTIM_ORG = "org-victim";

  beforeEach(() => {
    jest.resetAllMocks();
    (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(false);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts: unknown) =>
        fn({
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
    );
  });

  describe("seedDefaultRoles — tenant predicate", () => {
    function makeDb(existingSlugs: string[]) {
      const where = jest.fn().mockResolvedValue(existingSlugs.map((slug) => ({ slug })));
      const from = jest.fn().mockReturnValue({ where });
      const select = jest.fn().mockReturnValue({ from });
      return { db: { select } as unknown as Db, where };
    }

    it("SELECT for existing slugs binds to the caller's orgId, not a different org", async () => {
      const { db, where } = makeDb([]);
      const svc = new RoleSeedService(db);
      await svc.seedDefaultRoles(ATTACKER_ORG);
      expect(where).toHaveBeenCalled();
      const whereArg = where.mock.calls[0]?.[0];
      const vals = sqlValues(whereArg);
      expect(vals).toContain(ATTACKER_ORG);
      expect(vals).not.toContain(VICTIM_ORG);
    });

    it("runInTenantTransaction receives the caller's orgId, not another org's", async () => {
      const capturedOpts: Array<{ orgId: string }> = [];
      (runInTenantTransaction as jest.Mock).mockImplementation(
        (_db: unknown, fn: (tx: unknown) => Promise<unknown>, opts: { orgId: string }) => {
          capturedOpts.push(opts);
          return fn({
            insert: jest.fn().mockReturnValue({
              values: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ id: 1, slug: "ENGINEERING" }]),
              }),
            }),
          });
        },
      );
      const { db } = makeDb([]);
      const svc = new RoleSeedService(db);
      await svc.seedDefaultRoles(ATTACKER_ORG);
      expect(capturedOpts.length).toBeGreaterThan(0);
      for (const opts of capturedOpts) {
        expect(opts.orgId).toBe(ATTACKER_ORG);
        expect(opts.orgId).not.toBe(VICTIM_ORG);
      }
    });

    it("returns an empty created list when all starter roles already exist (idempotency)", async () => {
      const ALL_STARTER_SLUGS = [
        "ENGINEERING",
        "SALES_REP",
        "CUSTOMER_SUPPORT",
        "DIGITAL_MARKETING",
        "HR_ADMIN",
        "ACCOUNTANT",
      ];
      const { db } = makeDb(ALL_STARTER_SLUGS);
      const svc = new RoleSeedService(db);
      const result = await svc.seedDefaultRoles(ATTACKER_ORG);
      expect(result.created).toHaveLength(0);
      expect(result.skipped).toHaveLength(6);
    });
  });

  describe("materializeTemplate — tenant predicate", () => {
    const actorA: CurrentUserContext = {
      userId: "user-a",
      orgId: ATTACKER_ORG,
      role: "ORG_ADMIN",
      isOrgOwner: false,
      sessionId: "sess-a",
      tokenScopes: null,
      principal: humanSessionPrincipal(1, false),
    };

    it("throws ForbiddenException when the actor is not a structural org admin", async () => {
      (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(false);
      const db = {
        query: { roles: { findFirst: jest.fn().mockResolvedValue(null) } },
      } as unknown as Db;
      const svc = new RoleSeedService(db);
      await expect(svc.materializeTemplate(actorA, "engineering")).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for an unknown template id", async () => {
      (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(true);
      const db = {
        query: { roles: { findFirst: jest.fn().mockResolvedValue(null) } },
      } as unknown as Db;
      const svc = new RoleSeedService(db);
      await expect(svc.materializeTemplate(actorA, "nonexistent-template-xyz")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("findFirst WHERE uses actor.orgId and not another org (cross-tenant isolation)", async () => {
      (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(true);
      const existingRole = {
        id: 1,
        orgId: ATTACKER_ORG,
        slug: "ENGINEERING",
        name: "Engineering",
        isSystem: false,
      };
      const findFirst = jest.fn().mockResolvedValue(existingRole);
      const db = {
        query: { roles: { findFirst } },
      } as unknown as Db;
      const svc = new RoleSeedService(db);
      const result = await svc.materializeTemplate(actorA, "engineering");
      expect(result.orgId).toBe(ATTACKER_ORG);
      expect(findFirst).toHaveBeenCalled();
      const opts = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      const vals = sqlValues(opts?.where);
      expect(vals).toContain(ATTACKER_ORG);
      expect(vals).not.toContain(VICTIM_ORG);
    });

    it("INSERT binds to actor.orgId when the template does not yet exist (no cross-org write)", async () => {
      (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(true);
      const capturedOpts: Array<{ orgId: string }> = [];
      (runInTenantTransaction as jest.Mock).mockImplementation(
        (_db: unknown, fn: (tx: unknown) => Promise<unknown>, opts: { orgId: string }) => {
          capturedOpts.push(opts);
          return fn({
            insert: jest.fn().mockReturnValue({
              values: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([
                  { id: 2, orgId: ATTACKER_ORG, slug: "ENGINEERING" },
                ]),
              }),
            }),
          });
        },
      );
      const createdRole = {
        id: 2,
        orgId: ATTACKER_ORG,
        slug: "ENGINEERING",
        name: "Engineering",
        isSystem: false,
      };
      const findFirst = jest.fn().mockResolvedValue(null);
      const whereChain = { limit: jest.fn().mockResolvedValue([createdRole]) };
      const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
      const selectResult = { from: jest.fn().mockReturnValue(fromChain) };
      const db = {
        query: { roles: { findFirst } },
        select: jest.fn().mockReturnValue(selectResult),
      } as unknown as Db;
      const svc = new RoleSeedService(db);
      const result = await svc.materializeTemplate(actorA, "engineering");
      expect(capturedOpts.length).toBeGreaterThan(0);
      for (const opts of capturedOpts) {
        expect(opts.orgId).toBe(ATTACKER_ORG);
        expect(opts.orgId).not.toBe(VICTIM_ORG);
      }
      expect(result.orgId).toBe(ATTACKER_ORG);
    });

    it("returns the role for the owning org when it already exists (control — same-tenant early return)", async () => {
      (isStructuralOrgAdmin as jest.Mock).mockResolvedValue(true);
      const existingRole = {
        id: 5,
        orgId: ATTACKER_ORG,
        slug: "ENGINEERING",
        name: "Engineering",
        isSystem: false,
      };
      const findFirst = jest.fn().mockResolvedValue(existingRole);
      const db = {
        query: { roles: { findFirst } },
      } as unknown as Db;
      const svc = new RoleSeedService(db);
      const result = await svc.materializeTemplate(actorA, "engineering");
      expect(result).toBe(existingRole);
      expect(result.orgId).toBe(ATTACKER_ORG);
    });
  });
});
