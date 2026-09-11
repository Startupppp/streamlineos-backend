/**
 * `crm_outbound_class_stops`: the live stops a tenant can see, a person
 * releasing one, and the stop a cancellation leaves behind.
 *
 * This is the table the send-time guardrail in `outbound.service.ts` reads, so
 * everything here either shows or changes what that guardrail will find.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { crmOutboundClassStops, crmOutboundMessages } from "../../../db/schema";
import type { HoldDeps } from "../autonomy-hold.types";

export async function liveOutboundClassStops(db: Db, organizationId: string) {
  return db
    .select({
      outboundClassStopId: crmOutboundClassStops.outboundClassStopId,
      partyId: crmOutboundClassStops.partyId,
      outboundClass: crmOutboundClassStops.outboundClass,
      outboundMessageId: crmOutboundClassStops.outboundMessageId,
      reason: crmOutboundClassStops.reason,
      stoppedByUserId: crmOutboundClassStops.stoppedByUserId,
      stoppedAt: crmOutboundClassStops.stoppedAt,
    })
    .from(crmOutboundClassStops)
    .where(
      and(
        eq(crmOutboundClassStops.organizationId, organizationId),
        isNull(crmOutboundClassStops.releasedAt),
      ),
    );
}

export async function releaseOutboundClassStop(
  db: Db,
  organizationId: string,
  userId: string,
  outboundClassStopId: string,
) {
  const released = await db
    .update(crmOutboundClassStops)
    .set({ releasedAt: new Date(), releasedByUserId: userId })
    .where(
      and(
        eq(crmOutboundClassStops.organizationId, organizationId),
        eq(crmOutboundClassStops.outboundClassStopId, outboundClassStopId),
        isNull(crmOutboundClassStops.releasedAt),
      ),
    )
    .returning({ id: crmOutboundClassStops.outboundClassStopId });

  if (released.length === 0) {
    const [existing] = await db
      .select({ releasedAt: crmOutboundClassStops.releasedAt })
      .from(crmOutboundClassStops)
      .where(
        and(
          eq(crmOutboundClassStops.organizationId, organizationId),
          eq(crmOutboundClassStops.outboundClassStopId, outboundClassStopId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Stop not found");
    throw new ConflictException("That stop was already released.");
  }

  return { released: true };
}

/**
 * Stopping a message stops its class for that party, not just that message.
 *
 * Ticket 07's US8, and until now only half-built: `outbound.service.ts` reads
 * `crm_outbound_class_stops` at send time as a guardrail, and nothing anywhere
 * inserted a row — so the table was always empty and the check always passed.
 * A person who stopped a nudge got the next nudge anyway, which is the reading
 * of "stop" nobody means.
 *
 * The stop is per class rather than per party: someone who does not want
 * chasing may still want the renewal conversation, and one cancellation is not
 * consent to go silent everywhere. It is also open-ended — `releasedAt` is
 * cleared only by a person, per the column's own contract — because a stop
 * that quietly expires is a stop the customer did not agree to.
 *
 * Quote holds carry no `outboundMessageId` and no class, so there is nothing
 * to stop and this does nothing for them.
 *
 * Never throws outward. The cancellation is the thing the caller asked for and
 * it has already committed; failing here must not turn a successful stop into
 * a 500 that invites the person to press the button again. The send-time
 * guardrail is a read of this table, so a lost row costs one message, and the
 * failure is loud in the log.
 */
export async function stopClassForParty(
  deps: Pick<HoldDeps, "db" | "logger">,
  organizationId: string,
  userId: string,
  outboundMessageId: string | null,
  reason?: string,
): Promise<void> {
  if (!outboundMessageId) return;

  try {
    const [message] = await deps.db
      .select({
        partyId: crmOutboundMessages.partyId,
        outboundClass: crmOutboundMessages.outboundClass,
      })
      .from(crmOutboundMessages)
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, outboundMessageId),
        ),
      )
      .limit(1);

    if (!message) return;

    /**
     * A second stop on a live one would be a duplicate row saying the same
     * thing, and the guardrail reads the first it finds either way.
     */
    const [existing] = await deps.db
      .select({ id: crmOutboundClassStops.outboundClassStopId })
      .from(crmOutboundClassStops)
      .where(
        and(
          eq(crmOutboundClassStops.organizationId, organizationId),
          eq(crmOutboundClassStops.partyId, message.partyId),
          eq(crmOutboundClassStops.outboundClass, message.outboundClass),
          isNull(crmOutboundClassStops.releasedAt),
        ),
      )
      .limit(1);

    if (existing) return;

    await deps.db.insert(crmOutboundClassStops).values({
      organizationId,
      partyId: message.partyId,
      outboundClass: message.outboundClass,
      outboundMessageId,
      reason: reason ?? "Stopped inside the hold window",
      stoppedByUserId: userId,
    });
  } catch (error) {
    deps.logger.error(
      `could not stop ${outboundMessageId}'s class for its party: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
