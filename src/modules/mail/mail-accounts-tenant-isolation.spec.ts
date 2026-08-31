import type { Db } from "../../db/drizzle.module";
import { MailAccountsService } from "./mail-accounts.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("MailAccountsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Promise.resolve([]);
          }),
        }),
      })),
    } as unknown as Db;
  }

  it("scopes account list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new MailAccountsService(makeDb(wheres));

    await svc.listAccounts(ATTACKER, "user-1");

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns mail accounts for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new MailAccountsService(makeDb(wheres));

    const result = await svc.listAccounts(OWNER, "user-1");

    expect(Array.isArray(result)).toBe(true);
  });
});
