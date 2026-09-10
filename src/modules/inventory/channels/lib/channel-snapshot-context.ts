import { and, eq } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import {
  invChannels,
  invChannelStockPublications,
  invProductVariants,
} from "../../../../db/schema";
import type { ChannelDeliveryRejection } from "../channel-adapter";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The vocabulary the snapshot path shares, and the one read that builds it.
 *
 * Split out of `channel-snapshot.service.ts` so the receiver, the drain worker
 * and the difference writer can each be read on their own without one of them
 * owning the types the other two need.
 */

/** How long a claimed delivery stays claimed if the drain dies mid-flight. */
export const DELIVERY_LEASE_MS = 120_000;

/** Deliveries drained per organisation per sweep. */
export const DRAIN_BATCH_SIZE = 25;

export type ReceiveOutcome =
  | { readonly accepted: true; readonly duplicate: boolean; readonly deliveryId: number }
  | { readonly accepted: false; readonly reason: ChannelDeliveryRejection | "unknown-channel" };

export interface SnapshotSweepResult {
  claimed: number;
  refetched: number;
  differencesRecorded: number;
  retried: number;
  dead: number;
}

export interface DrainableDelivery {
  readonly orgId: string;
  readonly id: number;
  readonly channelId: number;
  readonly attemptCount: number;
}

export interface ChannelContext {
  readonly orgId: string;
  readonly channelId: number;
  readonly channelType: string;
  readonly storeUrl: string | null;
  readonly warehouseIds: number[];
  readonly skuToVariant: Map<string, number>;
}

/** Everything about a channel the refetch needs, read once inside a tenant tx. */
export async function loadChannelContext(
  tx: Tx,
  orgId: string,
  channelId: number,
): Promise<ChannelContext | null> {
  const channel = await tx.query.invChannels.findFirst({
    where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
  });
  if (!channel) return null;

  // What we publish to this channel is what we ask it about. A channel we have
  // never published to has nothing to reconcile, and asking a marketplace for
  // its whole catalogue to compare against nothing is how a sweep becomes an
  // outage.
  const published = await tx
    .select({ sku: invProductVariants.sku, productVariantId: invChannelStockPublications.productVariantId })
    .from(invChannelStockPublications)
    .innerJoin(
      invProductVariants,
      and(
        eq(invProductVariants.id, invChannelStockPublications.productVariantId),
        eq(invProductVariants.orgId, invChannelStockPublications.orgId),
      ),
    )
    .where(
      and(
        eq(invChannelStockPublications.orgId, orgId),
        eq(invChannelStockPublications.channelId, channelId),
      ),
    );

  const settings = (channel.settings ?? {}) as Record<string, unknown>;
  const storeUrl = typeof settings.storeUrl === "string" ? settings.storeUrl : null;

  return {
    orgId,
    channelId,
    channelType: channel.channelType,
    storeUrl,
    warehouseIds: (channel.warehouseIds ?? []) as number[],
    skuToVariant: new Map(published.map((p) => [p.sku, p.productVariantId])),
  };
}
