import type { Db } from "../../db/drizzle.module";
import { SignIntegrationsService } from "./sign-integrations.service";
import type { signEnvelopes } from "../../db/schema";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

type EnvelopeRow = typeof signEnvelopes.$inferSelect;

function makeEnvelope(orgId: string, senderMembershipId: number): EnvelopeRow {
  return {
    id: 1,
    orgId,
    title: "Test Envelope",
    status: "sent",
    senderMembershipId,
    sourceModule: "sign",
    sourceEntityType: null,
    sourceEntityId: null,
    templateId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    voidedAt: null,
    expiredAt: null,
    message: null,
    expiresAt: null,
    settings: null,
  } as unknown as EnvelopeRow;
}

describe("SignIntegrationsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeService(memberRow: unknown) {
    let capturedWhere: unknown;

    const findFirst = jest.fn().mockImplementation((opts: { where: unknown }) => {
      capturedWhere = opts.where;
      return Promise.resolve(memberRow);
    });

    const db = {
      query: {
        organizationMembers: { findFirst },
      },
    } as unknown as Db;

    const automation = { runAutomationsForEventDetached: jest.fn() };
    const webhooks = { dispatch: jest.fn() };
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };

    const svc = new SignIntegrationsService(
      db,
      automation as never,
      webhooks as never,
      notifications as never,
    );

    return {
      svc,
      db,
      notifications,
      getWhere: () => capturedWhere,
    };
  }

  it("DENY: resolveAndNotifySender queries organizationMembers scoped to the envelope's orgId — an attacker envelope cannot resolve a member from another org (cross-tenant isolation)", async () => {
    const { svc, notifications, getWhere } = makeService(null);
    const envelope = makeEnvelope(ATTACKER_ORG, 999);

    svc.emitEnvelopeEvent(envelope, "sent");

    await new Promise((resolve) => setTimeout(resolve, 10));

    const vals = sqlValues(getWhere());
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(OWNER_ORG);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("CONTROL: resolveAndNotifySender queries the envelope's own org and notifies when a member is found", async () => {
    const { svc, notifications, getWhere } = makeService({ user: { id: "user-sender" } });
    const envelope = makeEnvelope(OWNER_ORG, 42);

    svc.emitEnvelopeEvent(envelope, "sent");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sqlValues(getWhere())).toContain(OWNER_ORG);
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER_ORG }),
    );
  });
});
