import type { Db } from "../../db/drizzle.module";
import { EmailSuppressionService } from "./email-suppression.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("EmailSuppressionService — cross-tenant isolation", () => {
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

  it("scopes suppression check to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new EmailSuppressionService(makeDb(wheres));

    await svc.findSuppressed(["user@example.com"], ATTACKER);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns empty suppression set for the owning org with no matches (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new EmailSuppressionService(makeDb(wheres));

    const result = await svc.findSuppressed(["user@example.com"], OWNER);

    expect(result instanceof Set).toBe(true);
    expect(result.size).toBe(0);
  });
});
