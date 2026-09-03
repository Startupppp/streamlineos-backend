/**
 * The four types the delivery worker and its preflight both name.
 *
 * They live here rather than in either file because both halves of `deliverJob` need
 * them: the preflight builds a `Preflight` from a `ClaimedJob`, and the send path
 * destructures it. A type declared beside runtime code drags that file into every
 * importer (root CLAUDE.md section 9), and the worker imports Nest, the provider
 * registry and the circuit breaker — none of which the preflight needs.
 */
import type { NotificationProviderRegistry } from "./providers/notification-provider-registry.service";
import type { ProviderCaps } from "./notification-provider-caps";
import type { notificationDeliveries } from "../../db/schema";

export type ClaimedJob = { id: number; deliveryId: number; orgId: string };

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;

export type Provider = NonNullable<ReturnType<NotificationProviderRegistry["get"]>>;

export type Preflight = {
  delivery: DeliveryRow;
  sandbox: boolean;
  caps: ProviderCaps;
  attempt: number;
  provider: Provider;
};
