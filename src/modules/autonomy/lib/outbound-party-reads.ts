import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties, crmPipelineStages, deals, partyContacts, users } from "../../../db/schema";
import type { DealState } from "../outbound-eligibility";

/*
  The reads compose time and send time both make: who a message goes to, and
  the deal it is about. Both are read fresh on every call rather than carried
  on the draft, because either can change while a message waits.
*/

/** One day in milliseconds, for the day-sized windows the outbound reads use. */
export const DAY_MS = 86_400_000;

/**
 * The address, resolved at send time rather than copied from the draft.
 *
 * A contact who changed their mail during the hold window must not receive it
 * at the old one. The party's primary contact first, the party's own address
 * as the fallback, and null when there is neither — which the guardrails
 * cannot express, so the workflow treats it as a send failure rather than a
 * block.
 *
 * Keyed on the party rather than on `crm_outbound_messages.contact_id`,
 * deliberately. That column holds the LEGACY integer contact id, which exists
 * for the consent tables that are still keyed on it; `party_contacts` is the
 * party-native record and is where an address change actually lands.
 */
export async function resolveOutboundRecipient(
  db: Db,
  organizationId: string,
  partyId: string,
): Promise<string | null> {
  const [contact] = await db
    .select({ email: partyContacts.email })
    .from(partyContacts)
    .where(
      and(
        eq(partyContacts.organizationId, organizationId),
        eq(partyContacts.partyId, partyId),
        isNull(partyContacts.deletedAt),
        isNotNull(partyContacts.email),
      ),
    )
    .orderBy(desc(partyContacts.isPrimary))
    .limit(1);

  if (contact?.email?.trim()) return contact.email.trim();

  /*
   * Filtered on `deletedAt`, same as the `partyContacts` read above — a
   * soft-deleted party's own address must never be resolved into a send. A
   * missing address here becomes the "no reachable address" failure the
   * caller treats as a hard failure, which is a shorter path to the same
   * outcome `evaluateGuardrails`'s `party-deleted` reason exists to guarantee.
   */
  const [party] = await db
    .select({ email: businessParties.email })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, partyId),
        isNull(businessParties.deletedAt),
      ),
    )
    .limit(1);

  return party?.email?.trim() || null;
}

/** The deal a message is about, and whether its own pipeline says it has closed. */
export async function loadOutboundDeal(db: Db, organizationId: string, dealId: string) {
  const numeric = Number(dealId);
  if (!Number.isInteger(numeric)) return null;

  const [row] = await db
    .select({
      name: deals.name,
      stage: deals.stage,
      stageType: crmPipelineStages.stageType,
      nextStep: deals.nextStep,
      notes: deals.notes,
      followUpDate: deals.followUpDate,
      senderName: users.name,
    })
    .from(deals)
    .leftJoin(
      crmPipelineStages,
      and(
        eq(crmPipelineStages.orgId, deals.orgId),
        eq(crmPipelineStages.pipelineId, deals.pipelineId),
        eq(crmPipelineStages.key, deals.stage),
      ),
    )
    .leftJoin(users, eq(users.id, deals.assignedToId))
    .where(
      and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)),
    )
    .limit(1);

  if (!row) return null;
  return { ...row, senderName: row.senderName ?? "", state: toDealState(row.stageType) };
}

/**
 * The tenant's own terminal stages, never the literal strings WON and LOST.
 *
 * A tenant whose closing stage is called `CLOSED_WON` would otherwise read as
 * open forever, and the loop would keep chasing a deal that closed last month.
 * A stage with no row — a deal on no pipeline — reads as open, because the
 * guardrail's job is to stop a send on a CLOSED deal and "unknown" is not that.
 */
function toDealState(stageType: string | null | undefined): DealState {
  if (stageType === "won") return "won";
  if (stageType === "lost") return "lost";
  return "open";
}
