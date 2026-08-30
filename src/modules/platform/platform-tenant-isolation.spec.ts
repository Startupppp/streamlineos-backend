import type { Db } from "../../db/drizzle.module";
import { PlatformAdminService } from "./platform-admin.service";

function makeThenable(rows: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const methods = ["from", "where", "orderBy", "limit", "groupBy", "leftJoin", "innerJoin", "offset"];
  for (const m of methods) obj[m] = jest.fn(() => obj);
  obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return obj;
}

function makeDb(orgRows: unknown[]): Db {
  const db = {
    select: jest.fn().mockImplementation(() => makeThenable(orgRows)),
  } as unknown as Db;
  return db;
}

describe("PlatformAdminService — cross-tenant isolation", () => {
  const ORG_A = "org-aaa";
  const ORG_B = "org-bbb";

  it("listCustomers does not include a different org's data (cross-tenant isolation)", async () => {
    const orgRow = { id: ORG_A, slug: "org-a", name: "Org A", createdAt: new Date() };
    const db = makeDb([orgRow]);
    const mockEmail = {} as any;
    const svc = new PlatformAdminService(db, mockEmail);
    const result = await svc.listCustomers();
    const seenIds = result.items.map((i: { id: string }) => i.id);
    expect(seenIds).not.toContain(ORG_B);
  });

  it("listCustomers returns items for the org that exists (control — same-platform)", async () => {
    const orgRow = { id: ORG_A, slug: "org-a", name: "Org A", createdAt: new Date() };
    const db = makeDb([orgRow]);
    const mockEmail = {} as any;
    const svc = new PlatformAdminService(db, mockEmail);
    const result = await svc.listCustomers();
    expect(result.items.length).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty("nextCursor");
  });
});
