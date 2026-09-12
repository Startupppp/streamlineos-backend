import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import type { AppConfig } from "../../../../config/env.validation";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { invChannels, invChannelWebhookDeliveries } from "../../../../db/schema";
import { verifyChannelDelivery } from "../channel-adapter";
import type { ReceiveOutcome } from "./channel-snapshot-context";

/**
 * The inbound half: verify one delivery, record it, acknowledge, and stop.
 *
 * Free functions over a deps bag rather than a second `@Injectable`, following
 * `so-ship.ts` — the DI graph and the controller are unchanged, and nothing
 * here owns a transaction the service did not open.
 */
export interface DeliveryDeps {
  readonly db: Db;
  readonly config: AppConfig;
  readonly logger: Logger;
}

/**
 * The signing secret for a channel type.
 *
 * Deployment configuration, never a tenant column: a store's shared secret is
 * a provider credential, and root CLAUDE.md §5 keeps provider credentials out
 * of our database. A per-store secret — which WooCommerce genuinely has —
 * belongs on the Composio connected account, alongside the token that would
 * let us call back.
 */
function secretFor(config: AppConfig, channelType: string): string | null {
  if (channelType === "SHOPIFY") return config.INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY ?? null;
  if (channelType === "WOOCOMMERCE") return config.INV_CHANNEL_WEBHOOK_SECRET_WOOCOMMERCE ?? null;
  return config.INV_CHANNEL_WEBHOOK_SECRET_DEFAULT ?? null;
}

/**
 * Verify one inbound delivery, record it, and acknowledge.
 *
 * The tenant is resolved through `app.resolve_inv_channel_org_id`, a
 * `SECURITY DEFINER` function that returns the org id and nothing else. It has
 * to be: the route is `@Public()`, so no tenant GUC is set, and `inv_channels`
 * is behind RLS — the handler literally cannot read the row that would tell it
 * which tenant to open a transaction for. Widening the channel policy instead
 * would expose `settings` to every id-only query forever.
 *
 * Order matters. The tenant lookup happens first because verification needs
 * the channel's type to know which header scheme to read; the *signature* is
 * still what authorises anything, and an unverified delivery is recorded
 * nowhere. A caller who guesses a channel id and cannot sign gets nothing but
 * a rejection.
 */
export async function receiveDelivery(
  deps: DeliveryDeps,input: {
  readonly channelId: number;
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): Promise<ReceiveOutcome> {
  const orgRows = await deps.db.execute<{ org_id: string | null }>(
    sql`SELECT app.resolve_inv_channel_org_id(${input.channelId}) AS org_id`,
  );
  const orgId = orgRows[0]?.org_id ? String(orgRows[0].org_id) : null;
  if (!orgId) return { accepted: false, reason: "unknown-channel" };

  return runInTenantTransaction(
    deps.db,
    async (tx) => {
      const channel = await tx.query.invChannels.findFirst({
        where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, input.channelId)),
        columns: { id: true, channelType: true, status: true },
      });
      if (!channel) return { accepted: false as const, reason: "unknown-channel" as const };

      const verified = verifyChannelDelivery({
        channelType: channel.channelType,
        secret: secretFor(deps.config, channel.channelType),
        rawBody: input.rawBody,
        headers: input.headers,
      });
      if (!verified.valid) {
        deps.logger.warn(
          `channel ${input.channelId} delivery rejected: ${verified.reason}`,
        );
        return { accepted: false as const, reason: verified.reason };
      }

      // The body itself is never stored. A marketplace payload carries a
      // customer's name and address, and this row answers "have we handled
      // delivery X", not "what did the customer order".
      const payloadDigest = createHash("sha256").update(input.rawBody, "utf8").digest("hex");

      const inserted = await tx
        .insert(invChannelWebhookDeliveries)
        .values({
          orgId,
          channelId: input.channelId,
          providerDeliveryId: verified.deliveryId,
          topic: verified.topic,
          externalRef: externalRefOf(input.rawBody),
          status: "PENDING",
          payloadDigest,
          deliveryMetadata: safeMetadata(input.headers),
        })
        .onConflictDoNothing({
          target: [
            invChannelWebhookDeliveries.orgId,
            invChannelWebhookDeliveries.channelId,
            invChannelWebhookDeliveries.providerDeliveryId,
          ],
        })
        .returning({ id: invChannelWebhookDeliveries.id });

      if (inserted.length > 0) {
        return { accepted: true as const, duplicate: false, deliveryId: inserted[0]!.id };
      }

      // The duplicate branch. Deliberately not an error: a marketplace
      // retrying a delivery it already sent has done nothing wrong, and 4xx
      // would make it retry harder. It gets the same acknowledgement, and
      // nothing is enqueued.
      const existing = await tx
        .select({ id: invChannelWebhookDeliveries.id })
        .from(invChannelWebhookDeliveries)
        .where(
          and(
            eq(invChannelWebhookDeliveries.orgId, orgId),
            eq(invChannelWebhookDeliveries.channelId, input.channelId),
            eq(invChannelWebhookDeliveries.providerDeliveryId, verified.deliveryId),
          ),
        )
        .limit(1);
      return { accepted: true as const, duplicate: true, deliveryId: existing[0]?.id ?? 0 };
    },
    { orgId },
  );
}

/** Only headers that are safe to keep, so a signature never lands in a row. */
function safeMetadata(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const keep = ["x-shopify-topic", "x-shopify-shop-domain", "x-wc-webhook-topic", "x-wc-webhook-source", "x-marketplace-topic", "user-agent"];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = headers[key];
    if (value) out[key] = value.slice(0, 200);
  }
  return out;
}

/**
 * The SKU a delivery names, when it names one.
 *
 * Best-effort and never load-bearing: it is a hint for the operator reading
 * the delivery list, and the refetch asks the channel about every SKU we
 * publish regardless. Parsing failure is not an error, because a body we
 * cannot read is still a delivery we must record — the alternative is
 * dropping the notification because its shape surprised us.
 */
function externalRefOf(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed !== null && typeof parsed === "object") {
      const sku = (parsed as Record<string, unknown>).sku;
      if (typeof sku === "string" && sku.length > 0) return sku.slice(0, 200);
    }
  } catch {
    return null;
  }
  return null;
}
