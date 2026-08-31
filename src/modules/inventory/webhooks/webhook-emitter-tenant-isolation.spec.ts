// Service under test: src/modules/inventory/webhooks/webhook-emitter.service.ts
import type { Db } from "../../../db/drizzle.module";
import { InventoryWebhookEmitter } from "./webhook-emitter.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("InventoryWebhookEmitter — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn();
    const from = jest.fn();
    const builder = { from, innerJoin, where };
    from.mockReturnValue(builder);
    innerJoin.mockReturnValue(builder);
    where.mockReturnValue(builder);
    const select = jest.fn().mockReturnValue(builder);
    const insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) });
    const db = { select, insert } as unknown as Db;
    return { db, where };
  }

  it("emits nothing when no webhooks match the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new InventoryWebhookEmitter(db);
    await svc.emit(ATTACKER, "inventory.product.created", { id: 1 });
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("fires webhooks scoped to the owning org (control — same-tenant)", async () => {
    const webhookRow = { id: 1, url: "https://example.com/hook", secret: null };
    const { db } = makeDb([webhookRow]);
    const svc = new InventoryWebhookEmitter(db);
    await expect(svc.emit(OWNER, "inventory.product.created", { id: 1 })).resolves.toBeUndefined();
  });
});
