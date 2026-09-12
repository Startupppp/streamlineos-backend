/**
 * The notification a hold sends while it waits.
 *
 * Moved out of `AutonomyHoldService.holdQuoteSend`'s file as a unit: it reads
 * the deal's owner, falls back to the organisation's administrators, and never
 * lets a failed notification stop the hold from existing.
 */
import { and, eq } from "drizzle-orm";
import { getOrgAdminUserIds } from "../../../common/tenant/org-admin-recipients";
import { deals, quotes } from "../../../db/schema";
import type { HoldDeps } from "../autonomy-hold.types";

/**
 * Tell the people who could stop it, while there is still time.
 *
 * A hold nobody hears about is a delay, not a safeguard. The notification goes
 * to whoever owns the deal — the person most likely to know the send is wrong
 * and the one whose customer it is — and to the organisation's administrators
 * when nobody owns it, because the hold sends either way.
 */
export async function notifyHoldPending(
  deps: HoldDeps,
  organizationId: string,
  holdId: string,
  quoteId: number,
  windowSeconds: number,
): Promise<void> {
  const [row] = await deps.db
    .select({ assignedToId: deals.assignedToId, quoteSubject: quotes.subject })
    .from(quotes)
    .leftJoin(deals, and(eq(deals.orgId, quotes.orgId), eq(deals.id, quotes.dealId)))
    .where(and(eq(quotes.orgId, organizationId), eq(quotes.id, quoteId)))
    .limit(1);

  /**
   * Nobody owns the deal, so the org's administrators are told instead.
   *
   * Returning here was silent, and the hold sent sixty seconds later anyway —
   * which is the failure this notification exists to prevent, arriving
   * precisely on the quotes least likely to have been checked by a person. An
   * unassigned deal is not a reason to send a customer a quote unannounced.
   */
  const recipients = row?.assignedToId
    ? [row.assignedToId]
    : await getOrgAdminUserIds(deps.db, organizationId);

  if (recipients.length === 0) {
    deps.logger.warn(
      `hold ${holdId} has no assignee and the organisation has no active admin to tell; it will send unannounced`,
    );
    return;
  }

  for (const userId of recipients) {
    try {
      await deps.notifications.create({
        orgId: organizationId,
        userId,
        type: "WARNING",
        // High, because the whole value is that it is read before the window ends.
        priority: "HIGH",
        category: "SYSTEM",
        sourceModule: "crm",
        eventKey: "crm.autonomy.quote-holding",
        entityType: "autonomy_hold",
        entityId: holdId,
        title: "A quote is about to send",
        message: `"${row?.quoteSubject ?? "A quote"}" sends in ${windowSeconds} seconds unless you stop it.`,
        link: `/crm/autonomy?holdId=${holdId}`,
      });
    } catch (error) {
      // A failed notification must not stop the hold from existing. The feed
      // still shows it, and swallowing this silently is what §4 forbids.
      deps.logger.error(
        `could not notify ${userId} about hold ${holdId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
