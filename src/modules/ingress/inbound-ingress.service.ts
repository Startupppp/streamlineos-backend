import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { inboundEvents, organizations } from "../../db/schema";
import { startRun } from "../../common/workflow/workflow-store";
import {
  deduplicationKey,
  validateInboundEvent,
  type InboundCommunicationEvent,
} from "./inbound-event";

export const INBOUND_WORKFLOW = "crm.inbound-communication";

export type AcceptOutcome =
  | { readonly status: "accepted"; readonly inboundEventId: string; readonly workflowRunId: string | null }
  | { readonly status: "duplicate"; readonly inboundEventId: string };

/**
 * The single entry point every inbound communication arrives through.
 *
 * Its whole job is to decide, cheaply and exactly once, whether this delivery is
 * new — and then hand off to a durable workflow. Everything expensive happens
 * past that hand-off, under retries, where a malformed event would fail five
 * times before dead-lettering rather than being rejected here for nothing.
 */
@Injectable()
export class InboundIngressService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async accept(event: InboundCommunicationEvent): Promise<AcceptOutcome> {
    const problems = validateInboundEvent(event);
    if (problems.length > 0)
      throw new BadRequestException({
        code: "INVALID_INBOUND_EVENT",
        message: "The event is not a valid inbound communication.",
        details: problems,
      });

    /**
     * An event for an organisation that does not exist creates nothing.
     *
     * Checked before the receipt is written, so a mistyped or forged tenant id
     * leaves no row behind to be reconciled later.
     */
    const [organisation] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, event.organizationId))
      .limit(1);

    if (!organisation) throw new NotFoundException("Unknown organisation");

    const [receipt] = await this.db
      .insert(inboundEvents)
      .values({
        organizationId: event.organizationId,
        channel: event.channel,
        provider: event.provider,
        providerMessageId: event.providerMessageId,
        providerThreadId: event.providerThreadId ?? null,
        payload: event as unknown as Record<string, unknown>,
        occurredAt: new Date(event.occurredAt),
      })
      .onConflictDoNothing()
      .returning({ inboundEventId: inboundEvents.inboundEventId });

    // A conflict means this delivery has been seen. Which answer it gets depends
    // on whether the first one is still running.
    if (!receipt) return this.resolveDuplicate(event);

    const workflowRunId = await startRun(this.db, {
      organizationId: event.organizationId,
      workflowName: INBOUND_WORKFLOW,
      input: { inboundEventId: receipt.inboundEventId },
      // The receipt is the triggering event, so a redelivered start resumes the
      // run it already began rather than starting a second.
      causationEventId: receipt.inboundEventId,
      correlationId: deduplicationKey(event),
    });

    if (workflowRunId)
      await this.db
        .update(inboundEvents)
        .set({ workflowRunId })
        .where(eq(inboundEvents.inboundEventId, receipt.inboundEventId));

    return { status: "accepted", inboundEventId: receipt.inboundEventId, workflowRunId };
  }

  /**
   * A second delivery of a message already seen.
   *
   * While the first is in flight this is a conflict, not a success: two runs
   * resolving the same unknown sender concurrently is exactly how a duplicate
   * party gets created, and the caller's own retry is the right place to wait.
   * Once the first has finished, the second is simply the same answer again.
   */
  private async resolveDuplicate(event: InboundCommunicationEvent): Promise<AcceptOutcome> {
    const [existing] = await this.db
      .select({
        inboundEventId: inboundEvents.inboundEventId,
        status: inboundEvents.status,
      })
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.organizationId, event.organizationId),
          eq(inboundEvents.provider, event.provider),
          eq(inboundEvents.providerMessageId, event.providerMessageId),
        ),
      )
      .limit(1);

    if (!existing) throw new ConflictException("This delivery is already being processed");

    if (existing.status === "RECEIVED")
      throw new ConflictException({
        code: "DELIVERY_IN_FLIGHT",
        message: "This delivery is already being processed.",
      });

    return { status: "duplicate", inboundEventId: existing.inboundEventId };
  }
}
