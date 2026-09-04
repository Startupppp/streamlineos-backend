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

/**
 * The tally `processQueue` accumulates and `deliverJob`/`resolveDeliveryPreflight` increment.
 *
 * It lives here rather than beside the worker because BOTH halves mutate it: the worker owns the
 * loop, the preflight records a job it refused. Declaring it in the worker made the preflight
 * import back from the worker for the type alone, and `madge` counts a type-only edge, so
 * `check:cycles` went red on `notification-delivery-worker.service.ts > notification-delivery-preflight.ts`.
 * The cycle was erased at runtime (`import type` compiles away) but the gate was right to flag it:
 * a split that leaves the two halves naming each other has not actually separated them.
 */
export interface QueueRunResult {
  processed: number;
  sent: number;
  failed: number;
  dead: number;
}

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
