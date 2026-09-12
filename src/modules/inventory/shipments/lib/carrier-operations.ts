import { and, desc, eq, sql } from "drizzle-orm";
import { invCarrierOperations, invCarrierWebhookDeliveries } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type {
  CarrierDeliveriesQuery,
  CarrierOperationsQuery,
} from "../dto/carrier-transport.schemas";

/**
 * INV-26 — writing and reading the carrier's failures.
 *
 * This is the whole of "failure states visible". A booking the courier
 * rejected, a label that never came back, a tracking poll that timed out: each
 * one is a row here, with the courier's own error code and message where it
 * sent one, and each is reachable from a paginated read an operator's screen
 * calls. None of them changes the shipment, which is why the row is the only
 * place the failure exists.
 *
 * Free functions with a deps bag rather than a second `@Injectable`, the shape
 * `carrier-events.ts` next door already uses: the DI graph is unchanged and the
 * recording is callable from the webhook receiver, which has no user and no
 * ambient request.
 */

/** What an operation is called, kept in one place so a reader can enumerate it. */
export type CarrierOperationKind = "book" | "label" | "track";
export type CarrierOperationOutcome = "accepted" | "rejected" | "unavailable";

export interface RecordCarrierOperationInput {
  readonly orgId: string;
  readonly carrierId: number;
  readonly shipmentId: number;
  readonly transport: string;
  readonly operation: CarrierOperationKind;
  readonly outcome: CarrierOperationOutcome;
  readonly attempts: number;
  readonly carrierReference?: string | null;
  readonly trackingNumber?: string | null;
  readonly labelUrl?: string | null;
  readonly labelFormat?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly requestedBy?: string | null;
}

const OPERATION_COLUMNS = {
  id: invCarrierOperations.id,
  carrierId: invCarrierOperations.carrierId,
  shipmentId: invCarrierOperations.shipmentId,
  transport: invCarrierOperations.transport,
  operation: invCarrierOperations.operation,
  outcome: invCarrierOperations.outcome,
  attempts: invCarrierOperations.attempts,
  carrierReference: invCarrierOperations.carrierReference,
  trackingNumber: invCarrierOperations.trackingNumber,
  labelUrl: invCarrierOperations.labelUrl,
  labelFormat: invCarrierOperations.labelFormat,
  errorCode: invCarrierOperations.errorCode,
  errorMessage: invCarrierOperations.errorMessage,
  createdAt: invCarrierOperations.createdAt,
} as const;

const DELIVERY_COLUMNS = {
  id: invCarrierWebhookDeliveries.id,
  carrierId: invCarrierWebhookDeliveries.carrierId,
  eventKey: invCarrierWebhookDeliveries.eventKey,
  status: invCarrierWebhookDeliveries.status,
  reason: invCarrierWebhookDeliveries.reason,
  trackingNumber: invCarrierWebhookDeliveries.trackingNumber,
  shipmentId: invCarrierWebhookDeliveries.shipmentId,
  receivedAt: invCarrierWebhookDeliveries.receivedAt,
} as const;

/**
 * The courier's error, trimmed to what a column can hold.
 *
 * A courier that answers with a megabyte of HTML on a bad day must not be able
 * to fill this table one row at a time; and an operator reading the queue needs
 * the first sentence, not the stack.
 */
const MESSAGE_LIMIT = 500;

export function truncateCarrierMessage(message: string): string {
  return message.length <= MESSAGE_LIMIT ? message : `${message.slice(0, MESSAGE_LIMIT - 1)}…`;
}

export async function recordCarrierOperation(
  db: Db,
  input: RecordCarrierOperationInput,
): Promise<{ id: number }> {
  const [row] = await db
    .insert(invCarrierOperations)
    .values({
      orgId: input.orgId,
      carrierId: input.carrierId,
      shipmentId: input.shipmentId,
      transport: input.transport,
      operation: input.operation,
      outcome: input.outcome,
      attempts: input.attempts,
      carrierReference: input.carrierReference ?? null,
      trackingNumber: input.trackingNumber ?? null,
      labelUrl: input.labelUrl ?? null,
      labelFormat: input.labelFormat ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? truncateCarrierMessage(input.errorMessage) : null,
      requestedBy: input.requestedBy ?? null,
    })
    .returning({ id: invCarrierOperations.id });
  // The insert always returns a row; the fallback exists because the type does
  // not say so, and `0` is an id no read will ever match.
  return { id: row?.id ?? 0 };
}

/**
 * The most recent consignment this shipment has on the courier's books.
 *
 * Read rather than stored on the shipment, because a shipment can be booked
 * more than once — a first attempt the courier rejected, then a corrected one —
 * and the latest accepted booking is the one a label belongs to.
 */
export async function latestAcceptedBooking(
  db: Db,
  orgId: string,
  shipmentId: number,
): Promise<{ carrierReference: string | null; trackingNumber: string | null } | null> {
  const [row] = await db
    .select({
      carrierReference: invCarrierOperations.carrierReference,
      trackingNumber: invCarrierOperations.trackingNumber,
    })
    .from(invCarrierOperations)
    .where(
      and(
        eq(invCarrierOperations.orgId, orgId),
        eq(invCarrierOperations.shipmentId, shipmentId),
        eq(invCarrierOperations.operation, "book"),
        eq(invCarrierOperations.outcome, "accepted"),
      ),
    )
    .orderBy(desc(invCarrierOperations.createdAt), desc(invCarrierOperations.id))
    .limit(1);
  return row ?? null;
}

export async function listCarrierOperations(
  db: Db,
  orgId: string,
  query: CarrierOperationsQuery,
) {
  const { page, limit } = query;
  const offset = (page - 1) * limit;
  const conditions = [eq(invCarrierOperations.orgId, orgId)];
  if (query.shipmentId) conditions.push(eq(invCarrierOperations.shipmentId, query.shipmentId));
  if (query.operation) conditions.push(eq(invCarrierOperations.operation, query.operation));
  if (query.outcome) conditions.push(eq(invCarrierOperations.outcome, query.outcome));
  const where = and(...conditions);

  const [items, [countRow]] = await Promise.all([
    db
      .select(OPERATION_COLUMNS)
      .from(invCarrierOperations)
      .where(where)
      .orderBy(desc(invCarrierOperations.createdAt), desc(invCarrierOperations.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(invCarrierOperations)
      .where(where),
  ]);
  const total = countRow?.total ?? 0;
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}

export async function listCarrierDeliveries(
  db: Db,
  orgId: string,
  query: CarrierDeliveriesQuery,
) {
  const { page, limit } = query;
  const offset = (page - 1) * limit;
  const conditions = [eq(invCarrierWebhookDeliveries.orgId, orgId)];
  if (query.status) conditions.push(eq(invCarrierWebhookDeliveries.status, query.status));
  const where = and(...conditions);

  const [items, [countRow]] = await Promise.all([
    db
      .select(DELIVERY_COLUMNS)
      .from(invCarrierWebhookDeliveries)
      .where(where)
      .orderBy(desc(invCarrierWebhookDeliveries.receivedAt), desc(invCarrierWebhookDeliveries.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(invCarrierWebhookDeliveries)
      .where(where),
  ]);
  const total = countRow?.total ?? 0;
  return { items, total, page, totalPages: Math.ceil(total / limit) };
}
