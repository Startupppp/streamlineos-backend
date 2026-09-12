import { NotFoundException } from "@nestjs/common";
import { and, eq, gte, max } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { customerLifecycleSignals, customerLifecycles } from "../../../db/schema/crm/lifecycle";
import { riskScore, SIGNAL_WINDOW_DAYS } from "../lifecycle-risk";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Recomputes the score from the signals still inside the decay window.
 *
 * The window is applied in the query, not in the reducer: a customer with
 * three years of evidence would otherwise load three years of rows to
 * multiply almost all of them by zero.
 */
export async function rescore(db: Db, organizationId: string, customerLifecycleId: string) {
  const [lifecycle] = await db
    .select({
      renewalOn: customerLifecycles.renewalOn,
      status: customerLifecycles.status,
    })
    .from(customerLifecycles)
    .where(
      and(
        eq(customerLifecycles.organizationId, organizationId),
        eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
      ),
    )
    .limit(1);

  if (!lifecycle) throw new NotFoundException("Lifecycle not found");

  const now = new Date();
  const since = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * MS_PER_DAY);

  const signals = await db
    .select({
      impact: customerLifecycleSignals.impact,
      observedAt: customerLifecycleSignals.observedAt,
    })
    .from(customerLifecycleSignals)
    .where(
      and(
        eq(customerLifecycleSignals.organizationId, organizationId),
        eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
        gte(customerLifecycleSignals.observedAt, since),
      ),
    );

  const score = riskScore({
    signals,
    renewalOn: lifecycle.renewalOn,
    status: lifecycle.status,
    asOf: now,
  });

  /**
   * Over every signal, not only the windowed ones. `last_signal_at` says how
   * fresh the evidence is; deriving it from the decay window would report a
   * contract whose last signal was four months ago as having none at all,
   * which reads as "nothing has happened" rather than "nothing recently".
   */
  const [newest] = await db
    .select({ observedAt: max(customerLifecycleSignals.observedAt) })
    .from(customerLifecycleSignals)
    .where(
      and(
        eq(customerLifecycleSignals.organizationId, organizationId),
        eq(customerLifecycleSignals.customerLifecycleId, customerLifecycleId),
      ),
    );
  const lastSignalAt = newest?.observedAt ?? null;

  await db
    .update(customerLifecycles)
    .set({ riskScore: score, riskComputedAt: now, lastSignalAt, updatedAt: now })
    .where(
      and(
        eq(customerLifecycles.organizationId, organizationId),
        eq(customerLifecycles.customerLifecycleId, customerLifecycleId),
      ),
    );

  return { riskScore: score };
}
