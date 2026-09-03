import type { Db } from "../../../db/drizzle.module";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import type { signEnvelopes } from "../../../db/schema";

const ORG_ID = "org-owner";
const OTHER_ORG = "org-attacker";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type EnvelopeRow = typeof signEnvelopes.$inferSelect;

function makeExpiring(count: number): EnvelopeRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    orgId: ORG_ID,
    title: `Envelope ${index + 1}`,
    status: "sent",
    senderMembershipId: null,
    sourceModule: "sign",
    sourceEntityType: null,
    sourceEntityId: null,
    expiresAt: new Date(0),
  })) as unknown as EnvelopeRow[];
}

function makeHarness(expiring: EnvelopeRow[]) {
  const updateTargets: unknown[] = [];
  const updateWheres: unknown[] = [];

  const updateBuilder = () => {
    const builder = {
      set: jest.fn(),
      where: jest.fn((clause: unknown) => {
        updateWheres.push(clause);
        return Promise.resolve(undefined);
      }),
    };
    builder.set.mockReturnValue(builder);
    return builder;
  };

  const update = jest.fn((table: unknown) => {
    updateTargets.push(table);
    return updateBuilder();
  });

  const db = {
    update,
    query: {
      signEnvelopes: { findMany: jest.fn().mockResolvedValue(expiring), findFirst: jest.fn() },
    },
  } as unknown as Db;

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const integrations = { emitEnvelopeEvent: jest.fn() };
  const shared = { sendReminder: jest.fn(), generateSigningToken: jest.fn(), hash: jest.fn(), buildSigningUrl: jest.fn() };
  const recipients = { listForEnvelope: jest.fn().mockResolvedValue([]) };

  const svc = new SignEnvelopeSweepsService(
    db,
    audit as never,
    shared as never,
    shared as never,
    recipients as never,
    integrations as never,
  );

  return { svc, audit, integrations, update, updateWheres, updateTargets };
}

describe("SignEnvelopeSweepsService.runExpirationSweep — bulk writes, not one round trip per envelope", () => {
  it("issues a bounded number of statements for 12 expiring envelopes: two UPDATEs and one batched audit insert, not two UPDATEs and one INSERT each", async () => {
    const expiring = makeExpiring(12);
    const { svc, audit, update } = makeHarness(expiring);

    const expiredCount = await svc.runExpirationSweep(ORG_ID);

    expect(expiredCount).toBe(12);
    expect(update).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[0]).toHaveLength(12);
  });

  it("keeps both batched UPDATEs tenant-correlated and confined to the envelopes the candidate query returned", async () => {
    const expiring = makeExpiring(3);
    const { svc, updateWheres } = makeHarness(expiring);

    await svc.runExpirationSweep(ORG_ID);

    expect(updateWheres).toHaveLength(2);
    for (const clause of updateWheres) {
      const values = sqlValues(clause);
      expect(values).toContain(ORG_ID);
      expect(values).not.toContain(OTHER_ORG);
      expect(values).toEqual(expect.arrayContaining([1, 2, 3]));
    }
  });

  it("writes the audit rows on the same handle as the status flip, which is the request transaction, so a flipped envelope cannot lose its envelope_expired row", async () => {
    const { svc, audit } = makeHarness(makeExpiring(4));

    await svc.runExpirationSweep(ORG_ID);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]?.[1]).toBeUndefined();
    expect(audit.record.mock.calls[0]?.[0]).toEqual(
      Array.from({ length: 4 }, (_unused, index) => ({
        orgId: ORG_ID,
        envelopeId: index + 1,
        actorType: "system",
        eventType: "envelope_expired",
        eventMessage: "Envelope expired automatically",
      })),
    );
  });

  it("touches nothing when no envelope has expired", async () => {
    const { svc, audit, update, integrations } = makeHarness([]);

    await expect(svc.runExpirationSweep(ORG_ID)).resolves.toBe(0);

    expect(update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(integrations.emitEnvelopeEvent).not.toHaveBeenCalled();
  });
});
