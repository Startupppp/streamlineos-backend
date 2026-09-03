/**
 * The regression net for the P0 in `resolveProviderEventId`.
 *
 * `POST /webhooks/payments/:providerKey/:environment/:orgId` is `@Public()`
 * (payment-webhooks-public.controller.ts). Its signature is an HMAC over the raw
 * body ONLY (adapters/razorpay.adapter.ts `verifyWebhookSignature`), so the
 * `x-payment-event-id` / `x-razorpay-event-id` header is unsigned, caller-chosen
 * input. At journal head that header WON the idempotency key outright:
 *
 *     id: supplied || normalized.providerEventId || sha256(rawBody)
 *
 * and the mismatch guard above it only arms when the body ALSO carries an id.
 * Razorpay's envelope has no top-level `id`, so "header present, body id absent"
 * is not an exotic branch — it is the ordinary branch for the shipped provider.
 *
 * Replaying ONE captured, correctly-signed body N times with N different headers
 * therefore: passes the signature every time; inserts N distinct rows through the
 * real arbiter `uq_payment_webhook_events_provider_env_event`
 * (provider_id, environment, provider_event_id); re-runs
 * providerBridge.recordProviderPayment N times; and posts N journal entries,
 * because finance-posting.service.ts dedupes on
 * (org_id, source_type, source_id, source_event) and source_id IS that varied id
 * (provider-bridge.service.ts). One real payment, N debits of BANK_CLEARING.
 *
 * Two halves, and the first runs everywhere:
 *
 *   HERMETIC — pins the precedence itself. The header may cross-check the signed
 *   envelope; it may never BE the key. No database.
 *
 *   CATALOG — executes the production insert against the real unique index and
 *   counts rows, because the amplification is a property of Postgres index
 *   inference, not of the resolver. Guarded by BILLING_DB_TESTS=1 in the house
 *   `.db.spec.ts` style; everything runs inside a transaction that is rolled back.
 *
 *     BILLING_DB_TESTS=1 DATABASE_URL=postgresql://… \
 *       npx jest --runInBand --testPathPattern="payment-webhook-event-id-precedence"
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { organizations, paymentProviders, paymentWebhookEvents } from "../../../db/schema";
import { resolveProviderEventId } from "./payment-webhook-receiver.service";

/** The exact precedence that shipped at journal head, kept so the net proves it bites. */
function headResolveProviderEventId(
  header: string | undefined,
  normalized: { providerEventId?: string },
  rawBody: string,
): { ok: true; id: string } | { ok: false } {
  const supplied = header?.trim();
  if (supplied && normalized.providerEventId && supplied !== normalized.providerEventId) {
    return { ok: false };
  }
  return {
    ok: true,
    id: supplied || normalized.providerEventId || createHash("sha256").update(rawBody).digest("hex"),
  };
}

/** One captured, correctly-signed Razorpay-shaped body. No top-level `id`, as Razorpay sends. */
const SIGNED_BODY = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: {
      entity: { id: "pay_replay_001", amount: 49900, currency: "INR", status: "captured" },
    },
  },
});

const BODY_DIGEST = createHash("sha256").update(SIGNED_BODY).digest("hex");

describe("webhook event id precedence — hermetic", () => {
  it("an unsigned header never becomes the key when the signed envelope carries no id", () => {
    // The vulnerable branch, and the ordinary Razorpay branch.
    const resolved = resolveProviderEventId("attacker-chosen-1", {}, SIGNED_BODY);
    expect(resolved).toEqual({ ok: true, id: BODY_DIGEST });
    expect(resolved).not.toEqual({ ok: true, id: "attacker-chosen-1" });
  });

  it("N different headers over ONE signed body collapse to ONE key", () => {
    const keys = new Set(
      Array.from({ length: 25 }, (_, i) => resolveProviderEventId(`forged-${i}`, {}, SIGNED_BODY)).map(
        (r) => (r.ok ? r.id : "rejected"),
      ),
    );
    expect(keys).toEqual(new Set([BODY_DIGEST]));
  });

  it("the head form is what produced N keys — this is the defect, stated", () => {
    const keys = new Set(
      Array.from({ length: 25 }, (_, i) => headResolveProviderEventId(`forged-${i}`, {}, SIGNED_BODY)).map(
        (r) => (r.ok ? r.id : "rejected"),
      ),
    );
    expect(keys.size).toBe(25);
  });

  it("a signed envelope id still wins over the body digest", () => {
    expect(resolveProviderEventId(undefined, { providerEventId: "evt_signed" }, SIGNED_BODY)).toEqual({
      ok: true,
      id: "evt_signed",
    });
  });

  it("an agreeing header changes nothing", () => {
    expect(resolveProviderEventId("evt_signed", { providerEventId: "evt_signed" }, SIGNED_BODY)).toEqual({
      ok: true,
      id: "evt_signed",
    });
  });

  it("a disagreeing header is still a 400, not a silently ignored one", () => {
    expect(resolveProviderEventId("header-id", { providerEventId: "body-id" }, "{}")).toEqual({ ok: false });
  });

  it("an empty signed id falls through to the digest rather than collapsing every event onto ''", () => {
    expect(resolveProviderEventId(undefined, { providerEventId: "   " }, SIGNED_BODY)).toEqual({
      ok: true,
      id: BODY_DIGEST,
    });
  });

  it("the digest is stable across calls, so a genuine provider retry still dedupes", () => {
    expect(resolveProviderEventId(undefined, {}, SIGNED_BODY)).toEqual(
      resolveProviderEventId("some-header", {}, SIGNED_BODY),
    );
  });
});

const ENABLED = process.env.BILLING_DB_TESTS === "1";
const DB_URL = process.env.BILLING_PROBE_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

class Rollback extends Error {}

describeDb("webhook event id precedence — real arbiter", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let orgId: string;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client);
    const [row] = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (!row) throw new Error("BILLING_DB_TESTS needs a database with at least one organizations row");
    orgId = row.id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the live arbiter really is (provider_id, environment, provider_event_id)", async () => {
    const [row] = await client<Array<{ def: string }>>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE tablename = 'payment_webhook_events'
         AND indexname = 'uq_payment_webhook_events_provider_env_event'`;
    expect(row?.def).toContain("(provider_id, environment, provider_event_id)");
  });

  /**
   * Runs the production insert `deliveries` times under `resolve`, returns how many
   * rows the arbiter actually admitted, then rolls the whole thing back.
   */
  async function admittedRows(
    resolve: typeof resolveProviderEventId,
    deliveries: number,
  ): Promise<number> {
    return db
      .transaction(async (tx) => {
        const [provider] = await tx
          .insert(paymentProviders)
          .values({
            orgId,
            providerKey: `p0probe-${randomUUID().slice(0, 8)}`,
            displayName: "P0 probe",
            environment: "test",
          })
          .returning({ id: paymentProviders.id });

        for (let i = 0; i < deliveries; i++) {
          // One signed body, N unsigned headers — the replay.
          const eventId = resolve(`forged-${i}`, {}, SIGNED_BODY);
          if (!eventId.ok) continue;
          await tx
            .insert(paymentWebhookEvents)
            .values({
              orgId,
              providerId: provider.id,
              environment: "test",
              providerEventId: eventId.id,
              eventType: "payment.captured",
              signatureValid: true,
              processingStatus: "processed",
              idempotencyKey: eventId.id,
              payloadRedacted: {},
              processedAt: new Date(),
            })
            .onConflictDoNothing({
              target: [
                paymentWebhookEvents.providerId,
                paymentWebhookEvents.environment,
                paymentWebhookEvents.providerEventId,
              ],
            })
            .returning();
        }

        const rows = await tx
          .select({ id: paymentWebhookEvents.id })
          .from(paymentWebhookEvents)
          .where(
            and(
              eq(paymentWebhookEvents.orgId, orgId),
              eq(paymentWebhookEvents.providerId, provider.id),
            ),
          );
        throw Object.assign(new Rollback(), { count: rows.length });
      })
      .then(() => -1)
      .catch((error: unknown) => {
        if (error instanceof Rollback) return (error as Rollback & { count: number }).count;
        throw error;
      });
  }

  it("the head form admits one ledger row per forged header — the amplification", async () => {
    expect(await admittedRows(headResolveProviderEventId, 12)).toBe(12);
  }, 30_000);

  it("the shipped form admits exactly one, however many headers are forged", async () => {
    expect(await admittedRows(resolveProviderEventId, 12)).toBe(1);
  }, 30_000);

  it("leaves nothing behind", async () => {
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM payment_providers WHERE provider_key LIKE 'p0probe-%'`;
    expect(row?.n).toBe(0);
  });
});
