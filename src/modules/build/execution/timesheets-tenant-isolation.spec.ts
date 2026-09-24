import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { TimesheetsService } from "./timesheets.service";

describe("TimesheetsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { scopeFor: jest.fn().mockResolvedValue("all"), holds: jest.fn().mockResolvedValue(true) } as never;
  const cache = { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn() } as never;
  const periodService = {} as never;

  function makeDb(entryRow: unknown | null) {
    // The list now answers inside the shared offset envelope, so it also runs a count beside
    // the page — the mock has to satisfy `select().from().where()` or the read throws.
    const countRows = [{ total: entryRow ? 1 : 0 }];
    return {
      query: {
        timesheets: {
          findFirst: jest.fn().mockResolvedValue(entryRow),
          findMany: jest.fn().mockResolvedValue(entryRow ? [entryRow] : []),
        },
      },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(countRows),
        }),
      }),
    } as unknown as Db;
  }

  it("throws NotFoundException for updateEntry when entry belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new TimesheetsService(db, cache, access, periodService);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 1 } } as never;
    await expect(svc.updateEntry(u, 99, { hours: 2 } as never)).rejects.toThrow(NotFoundException);
  });

  it("returns entries scoped to the owning org (same-tenant control)", async () => {
    const entry = { id: 1, orgId: OWNER_ORG, userMembershipId: 1, hours: 2 };
    const db = makeDb(entry);
    const svc = new TimesheetsService(db, cache, access, periodService);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true, principal: { kind: "human-session", membershipId: 1 } } as never;
    const result = await svc.listTimeEntries(u, { page: 1, limit: 20 } as never);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("listTimeEntries WHERE clause guards against voided entries", async () => {
    const db = makeDb(null);
    const svc = new TimesheetsService(db, cache, access, periodService);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true, principal: { kind: "human-session", membershipId: 1 } } as never;
    await svc.listTimeEntries(u, { page: 1, limit: 20 } as never);
    const options = (db.query.timesheets.findMany as jest.Mock).mock.calls[0]?.[0];
    expect(new PgDialect().sqlToQuery(options.where).sql.toLowerCase()).toContain("voided_at");
  });

  it("approveEntry returns NotFoundException for a voided entry in the same org", async () => {
    const db = makeDb(null);
    const svc = new TimesheetsService(db, cache, access, periodService);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 2 } } as never;
    await expect(svc.approveEntry(u, 99)).rejects.toThrow(NotFoundException);
  });

  it("listTimeEntries ignores userId filter when scope is own — prevents widening", async () => {
    const db = makeDb(null);
    const ownAccess = { scopeFor: jest.fn().mockResolvedValue("own"), holds: jest.fn().mockResolvedValue(false) } as never;
    const svc = new TimesheetsService(db, cache, ownAccess, periodService);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5 } } as never;
    await svc.listTimeEntries(u, { page: 1, limit: 20, userId: "other-user" } as never);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
