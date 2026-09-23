import type { Db } from "../../../../../db/drizzle.module";
import { RecruitmentWebhookEmitter } from "../webhook-emitter.service";
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

interface MockEmitterDb {
  db: Db;
  capturedWhere: { current: unknown };
  insertValues: jest.Mock;
}

function makeEmitterDb(subscriptionIds: number[] = []): MockEmitterDb {
  const capturedWhere = { current: undefined as unknown };

  const where = jest.fn().mockImplementation((w: unknown) => {
    capturedWhere.current = w;
    return Promise.resolve(subscriptionIds.map((id) => ({ id })));
  });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });

  const returning = jest.fn().mockResolvedValue(subscriptionIds.map((id) => ({ id })));
  const insertValues = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values: insertValues });

  return { db: { select, insert } as unknown as Db, capturedWhere, insertValues };
}

describe("RecruitmentWebhookEmitter — cross-tenant isolation (src/modules/hr/recruitment/webhooks/webhook-emitter.service.ts)", () => {
  it("confines subscription queries to the caller org so deliveries are never enqueued for another org's subscribers (cross-tenant DENY)", async () => {
    const { db, capturedWhere } = makeEmitterDb([]);
    const emitter = new RecruitmentWebhookEmitter(db);

    const result = await emitter.emit(ATTACKER_ORG, EVENT, PAYLOAD);

    expect(result.enqueued).toBe(0);
    expect(capturedWhere.current).toBeDefined();
    expect(sqlValues(capturedWhere.current)).toContain(ATTACKER_ORG);
    expect(sqlValues(capturedWhere.current)).not.toContain(OWNER_ORG);
  });

  it("enqueues deliveries tagged with the caller org's id when matching subscriptions exist (same-tenant positive control)", async () => {
    const { db, insertValues } = makeEmitterDb([7, 8]);
    const emitter = new RecruitmentWebhookEmitter(db);

    const result = await emitter.emit(OWNER_ORG, EVENT, PAYLOAD);

    expect(result.enqueued).toBe(2);
    expect(insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ orgId: OWNER_ORG, subscriptionId: 7 }),
        expect.objectContaining({ orgId: OWNER_ORG, subscriptionId: 8 }),
      ]),
    );
  });
});
