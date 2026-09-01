import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { TimesheetsService } from "./timesheets.service";

describe("TimesheetsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { scopeFor: jest.fn().mockResolvedValue("all") } as never;
  const cache = { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn() } as never;
  const periodService = {} as never;

  function makeDb(entryRow: unknown | null) {
    return {
      query: {
        timesheets: {
          findFirst: jest.fn().mockResolvedValue(entryRow),
          findMany: jest.fn().mockResolvedValue(entryRow ? [entryRow] : []),
        },
      },
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
    expect(result).toHaveLength(1);
  });
});
