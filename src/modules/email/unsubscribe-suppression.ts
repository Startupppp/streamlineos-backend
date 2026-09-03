import { and, eq } from "drizzle-orm";
import { notificationSuppressionRules } from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import type { UnsubscribePayload, UnsubscribeScope } from "./unsubscribe-token";

/**
 * How each scope a token can carry becomes a row `NotificationRoutingService`
 * will actually read.
 *
 * The spellings are LOWERCASE on purpose: `loadSuppressionBatch`
 * (notification-routing.service.ts:236-246) matches `scope_type` against the
 * literals 'event', 'module', 'category' and 'all'. A rule written with any other
 * spelling is stored, listed in the preferences UI, and never consulted — which is
 * the quietest possible way for an opt-out to be ignored.
 *
 * `ALL_NON_MANDATORY` uses a fixed key rather than the token's, because the token
 * leaves `scopeKey` empty for it (`unsubscribe-token.ts:10-11`) and `scope_key` is
 * NOT NULL.
 */
export const UNSUBSCRIBE_SCOPE_RULES: Record<
  UnsubscribeScope,
  { scopeType: string; useTokenKey: boolean }
> = {
  TYPE: { scopeType: "event", useTokenKey: true },
  CATEGORY: { scopeType: "category", useTokenKey: true },
  ALL_NON_MANDATORY: { scopeType: "all", useTokenKey: false },
};

const ALL_SCOPE_KEY = "*";

export interface UnsubscribeRuleWritten {
  scopeType: string;
  scopeKey: string;
  /** False when an identical rule was already present — a repeat click is a no-op. */
  created: boolean;
}

/**
 * Records a one-click unsubscribe as a notification routing rule.
 *
 * WHY NOT `email_suppressions`. That table is the deliverability list.
 * `EmailOutboxService.enqueueAndTry` applies it to MANDATORY mail by design — a
 * hard-bounced address is undeliverable regardless of policy — and
 * `EmailSuppressionService.suppress` is `onConflictDoNothing` with no DELETE,
 * UPDATE or admin route anywhere in the product. Writing a preference there turns
 * "stop sending me this digest" into "stop sending me payslips, invoices, e-sign
 * requests and security alerts, permanently, with no way back". A suppression
 * rule is the same decision expressed where it belongs: `computeRouting` applies
 * it at `notification-routing-computation.ts:75-76` only when the event is not
 * mandatory, and `NotificationPreferencesService.listSuppressions` /
 * `removeSuppression` already make it visible and reversible to the person who
 * created it.
 *
 * `createdBy` is deliberately left null. It is FK'd to `users.id`, the token lives
 * for 30 days and travels in a mail archive, and a deleted user must not turn an
 * unsubscribe into a 500 on an unauthenticated endpoint. `user_id` carries the
 * subject and has no FK.
 *
 * Idempotent by lookup rather than by `ON CONFLICT`: the table has no unique over
 * (org, user, scope_type, scope_key, channel), and inventing one here would be a
 * schema change for a path that writes at most once per click.
 */
export async function writeUnsubscribeRule(
  tx: TenantTx,
  payload: UnsubscribePayload,
): Promise<UnsubscribeRuleWritten> {
  const rule = UNSUBSCRIBE_SCOPE_RULES[payload.scope];
  const scopeKey = rule.useTokenKey ? payload.scopeKey : ALL_SCOPE_KEY;
  if (rule.useTokenKey && scopeKey.length === 0)
    throw new Error(`unsubscribe token: scope ${payload.scope} carries no scopeKey`);

  const match = and(
    eq(notificationSuppressionRules.orgId, payload.orgId),
    eq(notificationSuppressionRules.userId, payload.userId),
    eq(notificationSuppressionRules.scopeType, rule.scopeType),
    eq(notificationSuppressionRules.scopeKey, scopeKey),
    eq(notificationSuppressionRules.channel, "EMAIL"),
  );

  const existing = await tx
    .select({ id: notificationSuppressionRules.id })
    .from(notificationSuppressionRules)
    .where(match)
    .limit(1);

  if (existing.length > 0) return { scopeType: rule.scopeType, scopeKey, created: false };

  await tx.insert(notificationSuppressionRules).values({
    orgId: payload.orgId,
    userId: payload.userId,
    scopeType: rule.scopeType,
    scopeKey,
    channel: "EMAIL",
    reason: "UNSUBSCRIBE",
    createdBy: null,
    metadata: {
      source: "ONE_CLICK_UNSUBSCRIBE",
      tokenScope: payload.scope,
      tokenScopeKey: payload.scopeKey,
      email: payload.email,
    },
  });

  return { scopeType: rule.scopeType, scopeKey, created: true };
}
