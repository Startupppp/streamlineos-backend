import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { userIntegrationConnections } from "../../../db/schema";

/**
 * The one definition of "this person owns this integration connection".
 *
 * `membership_id` owns access, not `user_id` — the schema says so at
 * `db/schema/common/integrations.ts:17` ("Retained solely for a stable account-label
 * projection; membershipId owns access"), because a person re-invited to an organisation
 * gets a new membership while keeping the same user id. Rows written before
 * `membership_id` existed still carry NULL there, so those fall back to `user_id`; the
 * `isNull` arm is what keeps the fallback from widening the check for rows that DO have a
 * membership.
 *
 * It lives in its own file because it is now enforced in two places that must not drift:
 * `IntegrationsService` (list / disconnect / set-primary / owned-connection) and
 * `CalendarService.createEvent`, where an unchecked caller-supplied `syncConnectionId`
 * would otherwise write another member's event into that member's personal Google or
 * Outlook calendar — `ComposioGateway.executeTool` passes `connectedAccountId` explicitly,
 * so the CONNECTION selects the target account, never the userId argument beside it.
 * Two copies of an ownership rule is one copy too many.
 */
export function connectionOwnerPredicate(
  userId: string,
  membershipId: number | null | undefined,
): SQL | undefined {
  const personallyScoped = eq(userIntegrationConnections.scope, "user");
  if (membershipId != null)
    return and(
      personallyScoped,
      or(
        eq(userIntegrationConnections.membershipId, membershipId),
        and(
          isNull(userIntegrationConnections.membershipId),
          eq(userIntegrationConnections.userId, userId),
        ),
      ),
    );
  return and(
    personallyScoped,
    eq(userIntegrationConnections.userId, userId),
  );
}
