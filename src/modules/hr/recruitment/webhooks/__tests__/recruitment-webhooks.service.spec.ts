import type { Db } from "../../../../../db/drizzle.module";
import { RecruitmentWebhooksService } from "../recruitment-webhooks.service";
import type { RecruitmentEvent } from "../../recruitment-webhook-events";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";
const EVENT: RecruitmentEvent = "candidate.applied";
const PAYLOAD = { candidateId: 1 };

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return typeof value === "string" || typeof value === "number" ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (seen.has(value as object)) return [];
  seen.add(value as object);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface MockDb {
  db: Db;
  capturedWheres: unknown[];
  values: jest.Mock;
}

function makeDb(subscriptions: Array<{ id: number }> = []): MockDb {
  const capturedWheres: unknown[] = [];

  const limit = jest.fn().mockResolvedValue(subscriptions);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((w: unknown) => {
    capturedWheres.push(w);
    return { orderBy };
  });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });

  const returning = jest.fn().mockResolvedValue(subscriptions.map((s) => ({ id: s.id })));
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });

  return { db: { select, insert } as unknown as Db, capturedWheres, values };
}

describe("RecruitmentWebhooksService — cross-tenant isolation", () => {
  it("queries only the caller org's subscriptions and does not bind another org's id (cross-tenant isolation)", async () => {
    const { db, capturedWheres } = makeDb([]);
    const service = new RecruitmentWebhooksService(db);

    await (service as any).run(ATTACKER_ORG, EVENT, PAYLOAD);

    expect(capturedWheres.length).toBeGreaterThan(0);
    expect(sqlValues(capturedWheres[0])).toContain(ATTACKER_ORG);
    expect(sqlValues(capturedWheres[0])).not.toContain(OWNER_ORG);
  });

  it("inserts deliveries tagged with the caller org's id for matching subscriptions (same-tenant positive control)", async () => {
    const sub = { id: 5 };
    const { db, values } = makeDb([sub]);
    const service = new RecruitmentWebhooksService(db);

    await (service as any).run(OWNER_ORG, EVENT, PAYLOAD);

    expect(values).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ orgId: OWNER_ORG, subscriptionId: sub.id, event: EVENT }),
      ]),
    );
  });
});
