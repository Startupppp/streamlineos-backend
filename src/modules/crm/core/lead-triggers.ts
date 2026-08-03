import { eq, and, isNull } from "drizzle-orm";
import { tasks, crmSlaBreachLog } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export async function checkAndRecordSlaBreach(
  db: Db,
  orgId: string,
  leadId: number,
  policyId: number | null,
): Promise<{ recorded: boolean }> {
  const existing = await db
    .select({ id: crmSlaBreachLog.id })
    .from(crmSlaBreachLog)
    .where(
      and(
        eq(crmSlaBreachLog.leadId, leadId),
        policyId !== null
          ? eq(crmSlaBreachLog.policyId, policyId)
          : isNull(crmSlaBreachLog.policyId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return { recorded: false };

  await db.insert(crmSlaBreachLog).values({
    orgId,
    leadId,
    policyId: policyId ?? undefined,
    taskCreated: true,
    notified: false,
  });

  const dueDate = new Date(Date.now() + 24 * 60 * 60_000);

  await db.insert(tasks).values({
    orgId,
    title: `SLA breach follow-up for lead #${leadId}`,
    notes: `Lead #${leadId} breached SLA policy${policyId ? ` #${policyId}` : ""}`,
    entityType: "LEAD",
    entityId: leadId,
    type: "CUSTOM",
    status: "pending",
    dueDate,
  });

  return { recorded: true };
}
