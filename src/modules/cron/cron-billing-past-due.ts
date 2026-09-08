import { and, eq } from "drizzle-orm";
import { organizationMembers, subscriptions, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

export const SUSPENSION_DAY = 14;

export type PastDueSubscription = Pick<
  typeof subscriptions.$inferSelect,
  "id" | "orgId" | "plan" | "metadata" | "updatedAt"
>;

export interface PastDueEntry {
  subscription: PastDueSubscription;
  pastDueAt: Date;
  daysSincePastDue: number;
}

export interface PastDueTriage {
  toSuspend: PastDueEntry[];
  toRemind: PastDueEntry[];
  alreadySuspended: number;
}

export interface PastDueDeps {
  readonly db: Db;
  readonly dispatch: NotificationDispatchService;
}

/**
 * Which past-due subscriptions get a reminder and which get suspended.
 *
 * The date each subscription fell past due is read from its own metadata and
 * falls back to `updatedAt`, so a row that never recorded the transition is
 * still measured from something rather than skipped.
 */
export function triagePastDue(
  pastDueSubs: readonly PastDueSubscription[],
  now: Date,
): PastDueTriage {
  const toSuspend: PastDueEntry[] = [];
  const toRemind: PastDueEntry[] = [];
  let alreadySuspended = 0;

  for (const subscription of pastDueSubs) {
    const metadata = subscription.metadata ?? {};
    if (metadata["suspendedForNonPayment"] === true) {
      alreadySuspended++;
      continue;
    }

    const recordedPastDueAt = metadata["pastDueAt"];
    const pastDueAt =
      typeof recordedPastDueAt === "string" ? new Date(recordedPastDueAt) : subscription.updatedAt;
    const daysSincePastDue = Math.floor((now.getTime() - pastDueAt.getTime()) / 86_400_000);
    const entry: PastDueEntry = { subscription, pastDueAt, daysSincePastDue };

    if (daysSincePastDue >= SUSPENSION_DAY) toSuspend.push(entry);
    else toRemind.push(entry);
  }

  return { toSuspend, toRemind, alreadySuspended };
}

export async function findOrgOwner(
  db: Db,
  orgId: string,
): Promise<{ userId: string; email: string } | null> {
  const [owner] = await db
    .select({ userId: organizationMembers.userId, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.isOwner, true),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  return owner ?? null;
}
