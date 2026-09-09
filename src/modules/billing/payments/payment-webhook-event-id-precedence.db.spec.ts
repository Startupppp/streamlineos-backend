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
 *   CATALOG — executes the production insert against the real unique index and
 *   counts rows, because the amplification is a property of Postgres index
 *   inference, not of the resolver. Everything runs inside a transaction that
 *   is rolled back.
 *
 *   DATABASE_URL=postgresql://… \
 *     pnpm test:db-specs --testNamePattern="webhook event id precedence — real arbiter"
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { paymentProviders, paymentWebhookEvents } from "../../../db/schema";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { resolveProviderEventId } from "./payment-webhook-receiver.service";
import { headResolveProviderEventId, SIGNED_BODY } from "./payment-webhook-event-id-precedence-fixtures";

const DB_URL = requireApprovedDatabaseUrl({
  spec: "payment-webhook-event-id-precedence.db.spec.ts",
  vars: ["BILLING_PROBE_DATABASE_URL", "DATABASE_URL"],
});

class Rollback extends Error {
  constructor(readonly count: number) {
    super("Rollback webhook probe fixtures");
  }
}

describe("webhook event id precedence — real arbiter", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  const orgId = `webhook-probe-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client);
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
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const userId = `${orgId}-owner`;
        await tx.execute(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@test.invalid`})`);
        await tx.execute(sql`
          INSERT INTO organizations (id, name, slug, owner_membership_id)
          VALUES (${orgId}, ${"Webhook probe"}, ${orgId}, 0)`);
        const memberships = await tx.execute(sql`
          INSERT INTO organization_members (org_id, user_id, role, status, is_owner)
          VALUES (${orgId}, ${userId}, 'OWNER', 'ACTIVE', true) RETURNING id`);
        const membership = memberships[0];
        if (!membership) throw new Error("Webhook probe owner membership was not created");
        await tx.execute(sql`UPDATE organizations SET owner_membership_id = ${Number(membership.id)} WHERE id = ${orgId}`);
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
        throw new Rollback(rows.length);
      })
      .then(() => -1)
      .catch((error: unknown) => {
        if (error instanceof Rollback) return error.count;
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
      SELECT count(*)::int AS n FROM payment_providers WHERE org_id = ${orgId}`;
    expect(row?.n).toBe(0);
    const [tenant] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM organizations WHERE id = ${orgId}`;
    expect(tenant?.n).toBe(0);
  });
});
