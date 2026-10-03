import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { AtsSandboxService, SANDBOX_EXAMPLE_SECRET } from "./ats-sandbox.service";
import { verifySandboxSignature } from "./sandbox-events";

const ORG = "org-1";
const SECRET = "whsec_real_tenant_secret";

interface Harness {
  service: AtsSandboxService;
  values: jest.Mock;
  logCritical: jest.Mock;
}

function build(subscription: unknown, joinRows: unknown[] = []): Harness {
  const values = jest.fn(() => ({ returning: () => Promise.resolve([{ id: 99 }]) }));
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "where", "orderBy"]) {
    chain[method] = jest.fn(() => chain);
  }
  chain.limit = jest.fn(() => Promise.resolve(joinRows));

  const db = {
    ...chain,
    insert: jest.fn(() => ({ values })),
    query: { hrWebhookSubscriptions: { findFirst: jest.fn(() => Promise.resolve(subscription)) } },
  } as unknown as Db;

  const logCritical = jest.fn(() => Promise.resolve());
  return { service: new AtsSandboxService(db, { logCritical } as never), values, logCritical };
}

describe("catalogue", () => {
  /**
   * The pair is only useful if the reader can reproduce it. A published example
   * that does not verify is worse than none — the developer concludes their own
   * implementation is wrong and goes looking in the right place for the wrong
   * reason.
   */
  it("publishes a body and signature that actually verify", () => {
    for (const event of build(null).service.catalogue().events) {
      expect(
        verifySandboxSignature(SANDBOX_EXAMPLE_SECRET, event.exampleBody, event.exampleSignature),
      ).toBe(true);
    }
  });

  it("covers exactly the six recruitment events", () => {
    expect(build(null).service.catalogue().events.map((e) => e.value)).toEqual([
      "candidate.applied",
      "candidate.moved",
      "candidate.hired",
      "candidate.rejected",
      "hire.handoff",
      "referral.bonus_due",
    ]);
  });

  it("names the headers and the algorithm a receiver has to implement", () => {
    const catalogue = build(null).service.catalogue();
    expect(catalogue.signatureHeader).toBe("X-StreamlineOS-Signature");
    expect(catalogue.algorithm).toContain("HMAC-SHA256");
    expect(catalogue.algorithm).toContain("raw request body");
  });
});

describe("replay", () => {
  it("queues a delivery for a subscribed event", async () => {
    const h = build({ id: 1, events: ["candidate.hired"], isActive: true });
    const result = await h.service.replay(ORG, "user-1", 1, "candidate.hired");

    expect(result).toMatchObject({ deliveryId: 99, event: "candidate.hired", queued: true });
    expect(h.logCritical).toHaveBeenCalledTimes(1);
  });

  /**
   * Marked in the payload, not in a column the receiver cannot see. A replay
   * that is indistinguishable from a real hire is how a test fires an
   * onboarding workflow in somebody's production system.
   */
  it("marks the body as a replay so the receiver can tell", async () => {
    const h = build({ id: 1, events: [], isActive: true });
    await h.service.replay(ORG, "user-1", 1, "candidate.hired");

    const inserted = h.values.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(inserted.payload.replay).toBe(true);
  });

  /** An empty event list means "everything" on the dispatch path, and here too. */
  it("treats an empty subscription list as subscribed to all", async () => {
    const h = build({ id: 1, events: [], isActive: true });
    await expect(h.service.replay(ORG, "user-1", 1, "candidate.applied")).resolves.toBeDefined();
  });

  /**
   * Firing an unsubscribed event would tell the developer their receiver works
   * for something that will never reach it, which is worse than refusing.
   */
  it("refuses an event the subscription is not subscribed to, and says which", async () => {
    const h = build({ id: 1, events: ["candidate.applied"], isActive: true });
    await expect(h.service.replay(ORG, "user-1", 1, "candidate.hired")).rejects.toThrow(
      /not subscribed to candidate\.hired/,
    );
    expect(h.logCritical).not.toHaveBeenCalled();
  });

  it("refuses a switched-off subscription", async () => {
    const h = build({ id: 1, events: ["candidate.hired"], isActive: false });
    await expect(h.service.replay(ORG, "user-1", 1, "candidate.hired")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("404s on a subscription in another tenant", async () => {
    const h = build(null);
    await expect(h.service.replay(ORG, "user-1", 1, "candidate.hired")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("signatureFor", () => {
  const deliveryRow = {
    id: 5,
    event: "candidate.hired",
    payload: { candidateId: 1 },
    status: "delivered",
    attempts: 1,
    responseStatus: 200,
    error: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastAttemptAt: new Date("2026-01-01T00:00:05.000Z"),
    secret: SECRET,
  };

  it("returns a signature the tenant's own secret verifies", async () => {
    const h = build(null, [deliveryRow]);
    const view = await h.service.signatureFor(ORG, 1, 5);
    expect(verifySandboxSignature(SECRET, view.signedBody, view.signature)).toBe(true);
  });

  /**
   * The secret is the one thing a valid receiver already holds and an attacker
   * does not. The body and the signature disclose nothing new; the secret would
   * let anybody who can read this endpoint forge every future delivery.
   */
  it("never returns the secret, under any key", async () => {
    const h = build(null, [deliveryRow]);
    const view = await h.service.signatureFor(ORG, 1, 5);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  /**
   * The stored row has no timestamp for the attempt, so the body is the shape
   * that was sent rather than the original bytes. Said in the response instead
   * of left for a developer to discover when their hash does not match.
   */
  it("says plainly that the timestamp is reconstructed", async () => {
    const h = build(null, [deliveryRow]);
    const view = await h.service.signatureFor(ORG, 1, 5);
    expect(view.caveat).toContain("timestamp");
    expect(view.signedBody).toContain("2026-01-01T00:00:05.000Z");
  });

  it("404s when the delivery belongs to another tenant", async () => {
    const h = build(null, []);
    await expect(h.service.signatureFor(ORG, 1, 5)).rejects.toBeInstanceOf(NotFoundException);
  });
});
