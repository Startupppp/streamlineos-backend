/**
 * Holds already placed: what is still waiting, and stopping it — one by hand,
 * or every hold of a kind when a kill switch goes off.
 *
 * Every cancellation here is a conditional update on `status = 'held'`, and
 * each one moves its decision to `reversed` in the same request transaction,
 * so the feed never claims something will happen that was stopped.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, quotes } from "../../../db/schema";
import type { HoldDeps } from "../autonomy-hold.types";
import { secondsRemaining } from "../hold-window";
import { stopClassForParty } from "./hold-class-stops";

export async function liveHoldsFor(db: Db, organizationId: string) {
  const rows = await db
    .select({
      autonomyHoldId: autonomyHolds.autonomyHoldId,
      autonomousDecisionId: autonomyHolds.autonomousDecisionId,
      quoteId: autonomyHolds.quoteId,
      holdUntil: autonomyHolds.holdUntil,
      createdAt: autonomyHolds.createdAt,
      quoteSubject: quotes.subject,
      summary: autonomousDecisions.summary,
    })
    .from(autonomyHolds)
    .leftJoin(quotes, and(eq(quotes.orgId, autonomyHolds.organizationId), eq(quotes.id, autonomyHolds.quoteId)))
    .leftJoin(
      autonomousDecisions,
      and(
        eq(autonomousDecisions.organizationId, autonomyHolds.organizationId),
        eq(autonomousDecisions.autonomousDecisionId, autonomyHolds.autonomousDecisionId),
      ),
    )
    .where(
      and(eq(autonomyHolds.organizationId, organizationId), eq(autonomyHolds.status, "held")),
    )
    .orderBy(autonomyHolds.holdUntil)
    .limit(100);

  return rows.map((row) => ({
    ...row,
    secondsRemaining: secondsRemaining(row.holdUntil),
  }));
}

export async function cancelOneHold(
  deps: Pick<HoldDeps, "db" | "logger">,
  organizationId: string,
  userId: string,
  holdId: string,
  reason?: string,
) {
  const cancelled = await deps.db
    .update(autonomyHolds)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledByUserId: userId,
      cancelReason: reason ?? null,
    })
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, holdId),
        eq(autonomyHolds.status, "held"),
      ),
    )
    .returning({
      id: autonomyHolds.autonomyHoldId,
      decisionId: autonomyHolds.autonomousDecisionId,
      outboundMessageId: autonomyHolds.outboundMessageId,
    });

  if (cancelled.length === 0) {
    const [existing] = await deps.db
      .select({ status: autonomyHolds.status })
      .from(autonomyHolds)
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
        ),
      )
      .limit(1);

    if (!existing) throw new NotFoundException("Hold not found");
    throw new ConflictException(
      existing.status === "sent"
        ? "That already sent — the window had closed."
        : `That is already ${existing.status}.`,
    );
  }

  // The cancellation is itself audited: the decision stops claiming it will
  // happen, and the feed shows who stopped it.
  await deps.db
    .update(autonomousDecisions)
    .set({
      outcome: "reversed",
      reversedAt: new Date(),
      reversedByUserId: userId,
      reversedReason: reason ?? "Cancelled inside the hold window",
    })
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        eq(autonomousDecisions.autonomousDecisionId, cancelled[0]!.decisionId),
      ),
    );

  await stopClassForParty(
    deps,
    organizationId,
    userId,
    cancelled[0]!.outboundMessageId,
    reason,
  );

  return { cancelled: true };
}

export async function cancelHoldsInFlight(
  db: Db,
  organizationId: string,
  userId: string,
  kind: string,
): Promise<number> {
  const cancelled = await db
    .update(autonomyHolds)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledByUserId: userId,
      cancelReason: "Autonomous sending was switched off",
    })
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.status, "held"),
        kind === "*" ? sql`true` : eq(autonomyHolds.kind, kind as "quote.sent"),
      ),
    )
    .returning({ decisionId: autonomyHolds.autonomousDecisionId });

  for (const row of cancelled) {
    await db
      .update(autonomousDecisions)
      .set({
        outcome: "reversed",
        reversedAt: new Date(),
        reversedByUserId: userId,
        reversedReason: "Autonomous sending was switched off",
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, row.decisionId),
        ),
      );
  }

  return cancelled.length;
}
