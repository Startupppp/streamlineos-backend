jest.mock("../../mail/providers/gmail-mail.provider", () => ({ GmailMailProvider: class {} }));
jest.mock("../../mail/providers/outlook-mail.provider", () => ({ OutlookMailProvider: class {} }));
jest.mock("../inbound-ingress.service", () => ({ InboundIngressService: class {} }));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import type { Db } from "../../../db/drizzle.types";
import { CrmMailboxService } from "./crm-mailbox.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("CrmMailboxService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
                limit: jest.fn().mockResolvedValue([]),
              })),
              limit: jest.fn().mockResolvedValue([]),
            });
          }),
        }),
      })),
    } as unknown as Db;
  }

  it("scopes mailbox list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmMailboxService(makeDb(wheres), {} as never, {} as never, {} as never);

    await svc.list(ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns mailboxes for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmMailboxService(makeDb(wheres), {} as never, {} as never, {} as never);

    const result = await svc.list(OWNER);

    expect(Array.isArray(result)).toBe(true);
  });
});
