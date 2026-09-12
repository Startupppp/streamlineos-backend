import { and, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  autonomySwitches,
  crmColdOutboundSettings,
  crmOutboundMessages,
  crmSendingDomains,
} from "../../../db/schema";
import type { ColdTrackFacts } from "../cold-outbound-gate";
import { resolveSwitch, switchesFor, type SwitchRow } from "../kill-switch";
import { decisionKindFor, type OutboundClass } from "../outbound-classes";
import { DAY_MS } from "./outbound-party-reads";

/*
  Whether the kill switch allows a class — asked at compose time and again at
  the claim — and the cold track's own facts, read at the claim, with the one
  write the cold gate can ask for: the track pausing itself.
*/

/**
 * The cold track's own facts, read at send time for the same reason.
 *
 * A domain's warm-up day advances while a message waits, and its bounce rate
 * is the number that decides whether the track pauses itself — reading either
 * at compose time would gate on yesterday.
 */
export async function readColdTrackFacts(db: Db, organizationId: string): Promise<ColdTrackFacts> {
  const now = new Date();

  const [settings] = await db
    .select({
      enabled: crmColdOutboundSettings.enabled,
      pausedAt: crmColdOutboundSettings.pausedAt,
    })
    .from(crmColdOutboundSettings)
    .where(eq(crmColdOutboundSettings.organizationId, organizationId))
    .limit(1);

  const domains = await db
    .select({
      domain: crmSendingDomains.domain,
      purpose: crmSendingDomains.purpose,
      verifiedAt: crmSendingDomains.verifiedAt,
      warmupStartedAt: crmSendingDomains.warmupStartedAt,
    })
    .from(crmSendingDomains)
    .where(eq(crmSendingDomains.organizationId, organizationId));

  const cold = domains.find((row) => row.purpose === "cold") ?? null;
  const transactional = domains.find((row) => row.purpose === "transactional") ?? null;

  const dayStart = new Date(now.getTime() - DAY_MS);
  const [today] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmOutboundMessages)
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.track, "cold"),
        eq(crmOutboundMessages.status, "sent"),
        gte(crmOutboundMessages.sentAt, dayStart),
      ),
    );

  return {
    now,
    // The absence of a row and `enabled = false` mean the same thing, which is
    // the property `crm_cold_outbound_settings` was designed around: a tenant
    // that has never heard of this feature must be indistinguishable from one
    // that turned it off.
    enabled: settings?.enabled ?? false,
    pausedAt: settings?.pausedAt ?? null,
    domain: cold
      ? {
          domain: cold.domain,
          purpose: "cold",
          verifiedAt: cold.verifiedAt,
          warmupStartedAt: cold.warmupStartedAt,
        }
      : null,
    transactionalDomain: transactional?.domain ?? null,
    sentToday: today?.count ?? 0,
    /**
     * Zero, and stated rather than faked.
     *
     * Bounce and complaint counts come from the provider's webhooks, which are
     * reconciled against `recipient_email` in `email_webhook` — a seam this
     * module does not own and no cold campaign has yet produced a row in.
     * `COLD_MIN_VOLUME_FOR_RATES` is what makes zeroes safe here: below fifty
     * sends the gate refuses to read the rates as evidence at all, so a
     * hard-coded zero cannot let a burning domain through — it can only fail
     * to catch one, and only above fifty cold sends, which nothing can reach
     * until the cold track has an entry point.
     */
    recentSends: 0,
    recentBounces: 0,
    recentComplaints: 0,
  };
}

/** Whether the kill switch for this class allows anything at all. */
export async function outboundSwitchAllows(
  db: Db,
  organizationId: string,
  outboundClass: OutboundClass,
): Promise<boolean> {
  const rows = await db
    .select({
      organizationId: autonomySwitches.organizationId,
      kind: autonomySwitches.kind,
      enabled: autonomySwitches.enabled,
      reason: autonomySwitches.reason,
    })
    .from(autonomySwitches)
    // Scoped like every sibling call site. `switchesFor` discards the rest in
    // JS and RLS discards them in production, so this is not a leak — but an
    // unscoped read drags every tenant's switches back on every send.
    .where(
      or(
        isNull(autonomySwitches.organizationId),
        eq(autonomySwitches.organizationId, organizationId),
      ),
    );

  return resolveSwitch(
    organizationId,
    decisionKindFor(outboundClass),
    switchesFor(organizationId, rows as SwitchRow[]),
  ).allowed;
}

/**
 * The track stops itself, and only a person starts it again.
 *
 * Written from `pauseTrack`, which `evaluateColdGate` returns for exactly two
 * reasons — a bounce rate and a complaint rate. A pause that expired on its
 * own would resume sending into whatever caused it.
 */
export async function pauseColdOutboundTrack(
  db: Db,
  organizationId: string,
  reason: string,
): Promise<void> {
  await db
    .insert(crmColdOutboundSettings)
    .values({ organizationId, enabled: false, pausedAt: new Date(), pauseReason: reason })
    .onConflictDoUpdate({
      target: crmColdOutboundSettings.organizationId,
      set: { pausedAt: new Date(), pauseReason: reason },
      // Only if it is not already paused: re-stamping would move the moment
      // the track stopped, and that timestamp is what an operator reads to
      // find out what was in flight when it did.
      setWhere: isNull(crmColdOutboundSettings.pausedAt),
    });
}
