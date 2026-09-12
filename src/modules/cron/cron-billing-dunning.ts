import { and, eq, inArray } from "drizzle-orm";
import { dunningAttempts } from "../../db/schema";
import { appUrl } from "../email/app-url";
import { logger } from "../../common/logger/logger.service";
import { type TenantTx } from "../../db/drizzle.types";
import {
  SUSPENSION_DAY,
  findOrgOwner,
  type PastDueDeps,
  type PastDueEntry,
} from "./cron-billing-past-due";

const DUNNING_SCHEDULE_DAYS = [7, 3, 1] as const;

interface PlannedAttempt {
  subscriptionId: number;
  pastDueAt: Date;
  milestone: string;
  day: number;
  daysRemaining: number;
}

const attemptKey = (subscriptionId: number, pastDueAt: Date, milestone: string): string =>
  `${subscriptionId}|${pastDueAt.getTime()}|${milestone}`;

export async function remindPastDue(
  deps: PastDueDeps,
  tx: TenantTx,
  orgId: string,
  entries: readonly PastDueEntry[],
  now: Date,
): Promise<{ notified: number; skipped: number }> {
  if (entries.length === 0) return { notified: 0, skipped: 0 };

  const periodStarts = [...new Set(entries.map((entry) => entry.pastDueAt.getTime()))].map(
    (time) => new Date(time),
  );
  const existing = await tx
    .select({
      subscriptionId: dunningAttempts.subscriptionId,
      periodStart: dunningAttempts.periodStart,
      milestone: dunningAttempts.milestone,
    })
    .from(dunningAttempts)
    .where(
      and(
        eq(dunningAttempts.orgId, orgId),
        inArray(
          dunningAttempts.subscriptionId,
          entries.map((entry) => entry.subscription.id),
        ),
        inArray(dunningAttempts.periodStart, periodStarts),
      ),
    )
    .limit(entries.length * DUNNING_SCHEDULE_DAYS.length);

  const recorded = new Set(
    existing.map((row) => attemptKey(row.subscriptionId, row.periodStart, row.milestone)),
  );

  const planned = planAttempts(entries, recorded);
  if (planned.length === 0) return { notified: 0, skipped: entries.length };

  const attemptRows = planned.map((attempt) => ({
    orgId,
    subscriptionId: attempt.subscriptionId,
    periodStart: attempt.pastDueAt,
    milestone: attempt.milestone,
  }));

  const inserted = await tx
    .insert(dunningAttempts)
    .values(attemptRows)
    .onConflictDoNothing()
    .returning({
      id: dunningAttempts.id,
      subscriptionId: dunningAttempts.subscriptionId,
      milestone: dunningAttempts.milestone,
    });

  const claimedIds = new Map(
    inserted.map((row) => [`${row.subscriptionId}|${row.milestone}`, row.id]),
  );
  const sending = planned.filter((attempt) =>
    claimedIds.has(`${attempt.subscriptionId}|${attempt.milestone}`),
  );

  const skipped = entries.length - sending.length;
  if (sending.length === 0) return { notified: 0, skipped };

  await notifyOwner(deps, orgId, sending);

  await tx
    .update(dunningAttempts)
    .set({ status: "SENT", attemptedAt: now, updatedAt: now })
    .where(
      and(eq(dunningAttempts.orgId, orgId), inArray(dunningAttempts.id, [...claimedIds.values()])),
    );

  return { notified: sending.length, skipped };
}

function planAttempts(
  entries: readonly PastDueEntry[],
  recorded: ReadonlySet<string>,
): PlannedAttempt[] {
  const planned: PlannedAttempt[] = [];
  for (const entry of entries) {
    for (const day of DUNNING_SCHEDULE_DAYS) {
      if (entry.daysSincePastDue < day) continue;
      const milestone = `D+${day}`;
      if (recorded.has(attemptKey(entry.subscription.id, entry.pastDueAt, milestone))) continue;
      planned.push({
        subscriptionId: entry.subscription.id,
        pastDueAt: entry.pastDueAt,
        milestone,
        day,
        daysRemaining: SUSPENSION_DAY - entry.daysSincePastDue,
      });
      break;
    }
  }
  return planned;
}

async function notifyOwner(
  deps: PastDueDeps,
  orgId: string,
  sending: readonly PlannedAttempt[],
): Promise<void> {
  const owner = await findOrgOwner(deps.db, orgId);
  if (!owner) return;

  for (const attempt of sending) {
    await deps.dispatch
      .emit({
        orgId,
        eventKey: "billing.payment.failed",
        targetUserIds: [owner.userId],
        title: `Payment overdue — action required (day ${attempt.day})`,
        message: `Your subscription payment remains outstanding. Please update your payment method within ${attempt.daysRemaining} day(s) to avoid suspension.`,
        link: `${appUrl()}/settings/billing`,
        priority: "HIGH",
      })
      .catch((err: unknown) =>
        logger.warn("[billing-cron] dunning notification failed", {
          orgId,
          day: attempt.day,
          err,
        }),
      );
  }
}
